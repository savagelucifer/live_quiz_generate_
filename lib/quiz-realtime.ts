import Redis from "ioredis";

type VercelWebSocket = any;
type Player = { id: string; username: string; score: number };
type Question = { question_text: string; options: string[]; correct_answer: string; explanation: string };
type PlayerProgress = { questionIndex: number; answered: boolean; finished: boolean; questionStartedAt: number };
type Room = { hostClientId: string; players: Player[]; status: "lobby" | "playing" | "ended"; questions: Question[]; timeLimit: number; progress: Record<string, PlayerProgress> };

const ROOM_PREFIX = "livequiz:room:";
const STREAM = "livequiz:events";
const redisOptions = { maxRetriesPerRequest: null, retryStrategy: (n: number) => Math.min(n * 200, 5000) };
const redis = process.env.REDIS_HOST && process.env.REDIS_PASSWORD
  ? new Redis({ ...redisOptions, host: process.env.REDIS_HOST, port: Number(process.env.REDIS_PORT) || 6379, username: process.env.REDIS_USERNAME || "default", password: process.env.REDIS_PASSWORD })
  : process.env.REDIS_URL ? new Redis(process.env.REDIS_URL, redisOptions) : null;

const conns = new Map<VercelWebSocket, { clientId: string; roomId: string }>();
const instanceId = crypto.randomUUID();
let reader: Redis | null = null;
let reading = false;
let lastId = "0-0";

const roomKey = (id: string) => `${ROOM_PREFIX}${id}`;
const send = (ws: VercelWebSocket, event: string, data: unknown) => { if (ws.readyState === 1) ws.send(JSON.stringify({ event, data })); };
const broadcast = (roomId: string, event: string, data: unknown, targetClientId?: string) => {
  for (const [ws, c] of conns) if (c.roomId === roomId && (!targetClientId || c.clientId === targetClientId)) send(ws, event, data);
};

async function publish(roomId: string, event: string, data: unknown, targetClientId?: string) {
  broadcast(roomId, event, data, targetClientId);
  if (redis) await redis.xadd(STREAM, "MAXLEN", "~", 500, "*", "roomId", roomId, "event", event, "data", JSON.stringify(data), "targetClientId", targetClientId || "", "origin", instanceId);
}

async function startReader() {
  if (!redis || reading) return;
  reading = true; reader = redis.duplicate();
  try { const tail = await redis.xrevrange(STREAM, "+", "-", "COUNT", 1); lastId = tail[0]?.[0] ?? "0-0"; } catch {}
  void readLoop();
}

async function readLoop() {
  if (!reader) return;
  while (reading) {
    try {
      const result = await reader.xread("BLOCK", 5000, "STREAMS", STREAM, lastId) as any;
      if (!result) continue;
      for (const [, entries] of result) for (const [id, fields] of entries) {
        lastId = id; const f: Record<string, string> = {};
        for (let i = 0; i < fields.length; i += 2) f[fields[i]] = fields[i + 1];
        if (f.origin === instanceId || !f.roomId || !f.event) continue;
        try { broadcast(f.roomId, f.event, JSON.parse(f.data), f.targetClientId || undefined); } catch {}
      }
    } catch (e) {
      if (reading) { console.error("[quiz realtime] Redis reader", e); await new Promise(r => setTimeout(r, 1000)); }
    }
  }
}

async function getRoom(id: string): Promise<Room | null> {
  if (!redis) return null;
  const raw = await redis.get(roomKey(id)); if (!raw) return null;
  try { return JSON.parse(raw) as Room; } catch { return null; }
}
async function saveRoom(id: string, room: Room) { if (redis) await redis.set(roomKey(id), JSON.stringify(room), "EX", 21600); }
const publicQuestion = (q: Question) => ({ question_text: q.question_text, options: q.options });

async function createRoom(ws: VercelWebSocket, roomId: string, clientId: string, hostName: string) {
  if (!redis) return send(ws, "room_error", "Redis is not configured on the server.");
  const id = roomId.trim().toUpperCase();
  if (await getRoom(id)) return send(ws, "room_error", "That room already exists.");
  const cleanClientId = String(clientId || "").trim();
  if (!cleanClientId) return send(ws, "room_error", "Your browser could not create a player ID. Please refresh and try again.");
  const room: Room = {
    hostClientId: cleanClientId,
    players: [{ id: cleanClientId, username: hostName.trim().slice(0, 40), score: 0 }],
    status: "lobby", questions: [], timeLimit: 15, progress: {},
  };
  await saveRoom(id, room); conns.set(ws, { clientId: cleanClientId, roomId: id }); await publish(id, "player_joined", room.players);
}

async function joinRoom(ws: VercelWebSocket, roomId: string, clientId: string, username: string) {
  const id = roomId.trim().toUpperCase(); const room = await getRoom(id);
  if (!room) return send(ws, "room_error", "Room not found.");
  if (room.status !== "lobby") return send(ws, "room_error", "This quiz has already started.");
  const cleanClientId = String(clientId || "").trim();
  if (!cleanClientId) return send(ws, "room_error", "Your browser could not create a player ID. Please refresh and try again.");
  if (!room.players.some(p => p.id === cleanClientId)) {
    room.players.push({ id: cleanClientId, username: username.trim().slice(0, 40), score: 0 });
    await saveRoom(id, room);
  }
  conns.set(ws, { clientId: cleanClientId, roomId: id }); await publish(id, "player_joined", room.players);
}

async function sendQuestionToPlayer(roomId: string, clientId: string) {
  const room = await getRoom(roomId); if (!room || room.status !== "playing") return;
  const progress = room.progress[clientId];
  if (!progress || progress.finished) return send(wsForClient(roomId, clientId), "quiz_ended", room.players);
  if (progress.questionIndex >= room.questions.length) {
    progress.finished = true; await saveRoom(roomId, room); await publish(roomId, "quiz_ended", room.players, clientId); return;
  }
  progress.answered = false; progress.questionStartedAt = Date.now(); await saveRoom(roomId, room);
  const q = room.questions[progress.questionIndex];
  await publish(roomId, "receive_question", { questionIndex: progress.questionIndex, question: publicQuestion(q), timeLimit: room.timeLimit, startedAt: progress.questionStartedAt }, clientId);
  setTimeout(() => void handleTimeout(roomId, clientId, progress.questionIndex), (room.timeLimit + 1) * 1000);
}

function wsForClient(roomId: string, clientId: string): VercelWebSocket {
  for (const [ws, c] of conns) if (c.roomId === roomId && c.clientId === clientId) return ws;
  return { readyState: 0 };
}

async function handleTimeout(roomId: string, clientId: string, questionIndex: number) {
  const room = await getRoom(roomId); if (!room || room.status !== "playing") return;
  const progress = room.progress[clientId];
  if (!progress || progress.finished || progress.questionIndex !== questionIndex || progress.answered) return;
  const q = room.questions[questionIndex]; if (!q) return;
  progress.answered = true; await saveRoom(roomId, room);
  await publish(roomId, "player_scores", room.players);
  await publish(roomId, "round_results", { correct_answer: q.correct_answer, explanation: q.explanation, players: room.players, timedOut: true }, clientId);
}

async function syncRoom(ws: VercelWebSocket, roomId: string, clientId: string) {
  const id = roomId.trim().toUpperCase(); const room = await getRoom(id);
  if (!room) return send(ws, "room_error", "Room not found.");
  conns.set(ws, { clientId, roomId: id }); send(ws, "player_joined", room.players);
  if (room.status === "ended") return send(ws, "quiz_ended", room.players);
  if (room.status === "playing") await sendQuestionToPlayer(id, clientId);
}

async function startQuiz(ws: VercelWebSocket, roomId: string, questions: Question[], timeLimit: number) {
  const id = roomId.trim().toUpperCase(); const c = conns.get(ws); const room = await getRoom(id);
  if (!room || !c || room.hostClientId !== c.clientId) return;
  room.status = "playing"; room.questions = questions; room.timeLimit = Math.max(5, Math.min(120, Number(timeLimit) || 15));
  room.progress = Object.fromEntries(room.players.map(p => [p.id, { questionIndex: 0, answered: false, finished: false, questionStartedAt: 0 }]));
  await saveRoom(id, room); await publish(id, "quiz_started", null);
  setTimeout(() => void startQuestionsForConnectedPlayers(id), 1500);
}

async function startQuestionsForConnectedPlayers(roomId: string) {
  const room = await getRoom(roomId); if (!room || room.status !== "playing") return;
  for (const [, c] of conns) if (c.roomId === roomId) void sendQuestionToPlayer(roomId, c.clientId);
}

async function submitAnswer(ws: VercelWebSocket, roomId: string, answer: string, timeTaken: number) {
  const id = roomId.trim().toUpperCase(); const c = conns.get(ws); const room = await getRoom(id);
  if (!room || !c || room.status !== "playing") return;
  const progress = room.progress[c.clientId]; if (!progress || progress.finished || progress.answered) return;
  const q = room.questions[progress.questionIndex]; const player = room.players.find(p => p.id === c.clientId); if (!q || !player) return;
  const elapsed = (Date.now() - progress.questionStartedAt) / 1000;
  if (elapsed > room.timeLimit + 0.5) return handleTimeout(id, c.clientId, progress.questionIndex);
  const measuredTime = Math.max(0, Math.min(room.timeLimit, Number.isFinite(Number(timeTaken)) ? Number(timeTaken) : elapsed));
  if (q.correct_answer === answer) player.score += Math.round(500 + 500 * Math.max(0, (room.timeLimit - measuredTime) / room.timeLimit));
  progress.answered = true; await saveRoom(id, room);
  await publish(id, "player_scores", room.players);
  await publish(id, "round_results", { correct_answer: q.correct_answer, explanation: q.explanation, players: room.players, timedOut: false }, c.clientId);
}

async function nextQuestion(ws: VercelWebSocket, roomId: string) {
  const id = roomId.trim().toUpperCase(); const c = conns.get(ws); const room = await getRoom(id);
  if (!room || !c || room.status !== "playing") return;
  const progress = room.progress[c.clientId]; if (!progress || !progress.answered || progress.finished) return;
  progress.questionIndex += 1;
  if (progress.questionIndex >= room.questions.length) {
    progress.finished = true; await saveRoom(id, room); await publish(id, "player_scores", room.players); await publish(id, "quiz_ended", room.players, c.clientId);
    if (room.players.every(p => room.progress[p.id]?.finished)) { room.status = "ended"; await saveRoom(id, room); }
    return;
  }
  await saveRoom(id, room); await sendQuestionToPlayer(id, c.clientId);
}

export function register(ws: VercelWebSocket) { conns.set(ws, { clientId: "", roomId: "" }); void startReader(); }
export async function unregister(ws: VercelWebSocket) { conns.delete(ws); if (conns.size === 0) { reading = false; if (reader) { void reader.quit().catch(() => {}); reader = null; } } }

export async function handleMessage(ws: VercelWebSocket, raw: string) {
  let m: any; try { m = JSON.parse(raw); } catch { return; }
  switch (m.type) {
    case "create_room": return createRoom(ws, m.roomId, m.clientId, m.hostName);
    case "join_room": return joinRoom(ws, m.roomId, m.clientId, m.username);
    case "sync_room": return syncRoom(ws, m.roomId, m.clientId);
    case "quiz_started": return startQuiz(ws, m.roomId, m.questions, m.timeLimit);
    case "submit_answer": return submitAnswer(ws, m.roomId, m.answer, m.timeTaken);
    case "next_question": return nextQuestion(ws, m.roomId);
  }
}
