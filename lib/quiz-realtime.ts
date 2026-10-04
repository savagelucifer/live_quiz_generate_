import Redis from "ioredis";

type VercelWebSocket = any;
type Player = { id: string; username: string; score: number };
type Question = { question_text: string; options: string[]; correct_answer: string; explanation: string };
type Room = {
  hostClientId: string; players: Player[]; status: "lobby" | "playing" | "ended";
  questions: Question[]; currentQuestionIndex: number; answersThisRound: number;
  answeredPlayerIds: string[]; timeLimit: number; questionStartedAt: number;
};

const ROOM_PREFIX = "livequiz:room:";
const STREAM = "livequiz:events";
const redis = process.env.REDIS_URL
  ? new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: null, retryStrategy: n => Math.min(n * 200, 5000) })
  : null;
const conns = new Map<VercelWebSocket, { clientId: string; roomId: string }>();
const instanceId = crypto.randomUUID();
let reader: Redis | null = null;
let reading = false;
let lastId = "0-0";

const roomKey = (id: string) => `${ROOM_PREFIX}${id}`;
const send = (ws: VercelWebSocket, event: string, data: unknown) => {
  if (ws.readyState === 1) ws.send(JSON.stringify({ event, data }));
};
const broadcast = (roomId: string, event: string, data: unknown) => {
  for (const [ws, c] of conns) if (c.roomId === roomId) send(ws, event, data);
};
async function publish(roomId: string, event: string, data: unknown) {
  broadcast(roomId, event, data);
  if (redis) await redis.xadd(STREAM, "MAXLEN", "~", 500, "*", "roomId", roomId, "event", event, "data", JSON.stringify(data), "origin", instanceId);
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
        lastId = id; const f: Record<string,string> = {};
        for (let i=0;i<fields.length;i+=2) f[fields[i]]=fields[i+1];
        if (f.origin === instanceId || !f.roomId || !f.event) continue;
        try { broadcast(f.roomId, f.event, JSON.parse(f.data)); } catch {}
      }
    } catch (e) { if (reading) { console.error("[quiz realtime] Redis reader", e); await new Promise(r => setTimeout(r,1000)); } }
  }
}
async function getRoom(id: string): Promise<Room|null> {
  if (!redis) return null;
  const raw = await redis.get(roomKey(id)); if (!raw) return null;
  try { return JSON.parse(raw) as Room; } catch { return null; }
}
async function saveRoom(id: string, room: Room) {
  if (redis) await redis.set(roomKey(id), JSON.stringify(room), "EX", 21600);
}
const publicQuestion = (q: Question) => ({ question_text:q.question_text, options:q.options });

async function createRoom(ws: VercelWebSocket, roomId: string, clientId: string, hostName: string) {
  if (!redis) return send(ws,"room_error","Redis is not configured on the server.");
  const id=roomId.trim().toUpperCase();
  if (await getRoom(id)) return send(ws,"room_error","That room already exists.");
  const room:Room={hostClientId:clientId,players:[{id:clientId,username:hostName.trim().slice(0,40),score:0}],status:"lobby",questions:[],currentQuestionIndex:0,answersThisRound:0,answeredPlayerIds:[],timeLimit:15,questionStartedAt:0};
  await saveRoom(id,room); conns.set(ws,{clientId,roomId:id}); await publish(id,"player_joined",room.players);
}
async function joinRoom(ws: VercelWebSocket, roomId:string, clientId:string, username:string) {
  const id=roomId.trim().toUpperCase(); const room=await getRoom(id);
  if(!room) return send(ws,"room_error","Room not found.");
  if(room.status!=="lobby") return send(ws,"room_error","This quiz has already started.");
  if(!room.players.some(p=>p.id===clientId)){room.players.push({id:clientId,username:username.trim().slice(0,40),score:0});await saveRoom(id,room);}
  conns.set(ws,{clientId,roomId:id}); await publish(id,"player_joined",room.players);
}
async function syncRoom(ws:VercelWebSocket,roomId:string,clientId:string){
  const id=roomId.trim().toUpperCase(); const room=await getRoom(id);
  if(!room) return send(ws,"room_error","Room not found.");
  conns.set(ws,{clientId,roomId:id}); send(ws,"player_joined",room.players);
  if(room.status==="ended") return send(ws,"quiz_ended",room.players);
  if(room.status!=="playing") return;
  const q=room.questions[room.currentQuestionIndex]; if(!q)return;
  send(ws,"quiz_started",null); send(ws,"receive_question",{questionIndex:room.currentQuestionIndex,question:publicQuestion(q),timeLimit:room.timeLimit,startedAt:room.questionStartedAt});
}
async function startQuiz(ws:VercelWebSocket,roomId:string,questions:Question[],timeLimit:number){
  const id=roomId.trim().toUpperCase(); const c=conns.get(ws); const room=await getRoom(id);
  if(!room||!c||room.hostClientId!==c.clientId)return;
  room.status="playing";room.questions=questions;room.timeLimit=Math.max(5,Math.min(120,Number(timeLimit)||15));room.currentQuestionIndex=0;room.answersThisRound=0;room.answeredPlayerIds=[];
  await saveRoom(id,room);await publish(id,"quiz_started",null);setTimeout(()=>void sendQuestion(id,0),1500);
}
async function sendQuestion(id:string,index:number){
  const room=await getRoom(id);if(!room)return;
  if(index>=room.questions.length){room.status="ended";await saveRoom(id,room);return publish(id,"quiz_ended",room.players);}
  room.currentQuestionIndex=index;room.answersThisRound=0;room.answeredPlayerIds=[];room.questionStartedAt=Date.now();await saveRoom(id,room);
  const q=room.questions[index];await publish(id,"receive_question",{questionIndex:index,question:publicQuestion(q),timeLimit:room.timeLimit,startedAt:room.questionStartedAt});
  setTimeout(async()=>{const latest=await getRoom(id);if(!latest||latest.status!=="playing"||latest.currentQuestionIndex!==index||latest.answersThisRound>=latest.players.length)return;await publish(id,"round_results",{correct_answer:q.correct_answer,explanation:q.explanation,players:latest.players});setTimeout(()=>void sendQuestion(id,index+1),5000);},(room.timeLimit+1)*1000);
}
async function submitAnswer(ws:VercelWebSocket,roomId:string,answer:string,timeTaken:number){
  const id=roomId.trim().toUpperCase();const c=conns.get(ws);const room=await getRoom(id);
  if(!room||!c||room.status!=="playing"||room.answeredPlayerIds.includes(c.clientId))return;
  const q=room.questions[room.currentQuestionIndex];const p=room.players.find(x=>x.id===c.clientId);if(!q||!p)return;
  if(q.correct_answer===answer){const t=Math.max(0,Math.min(room.timeLimit,Number(timeTaken)||room.timeLimit));p.score+=Math.round(500+500*Math.max(0,(room.timeLimit-t)/room.timeLimit));}
  room.answeredPlayerIds.push(c.clientId);room.answersThisRound=room.answeredPlayerIds.length;await saveRoom(id,room);
  if(room.answersThisRound>=room.players.length){await publish(id,"round_results",{correct_answer:q.correct_answer,explanation:q.explanation,players:room.players});setTimeout(()=>void sendQuestion(id,room.currentQuestionIndex+1),5000);}
}
export function register(ws:VercelWebSocket){conns.set(ws,{clientId:"",roomId:""});void startReader();}
export async function unregister(ws:VercelWebSocket){conns.delete(ws);if(conns.size===0){reading=false;if(reader){void reader.quit().catch(()=>{});reader=null;}}}
export async function handleMessage(ws:VercelWebSocket,raw:string){
  let m:any;try{m=JSON.parse(raw);}catch{return;}
  switch(m.type){case "create_room":return createRoom(ws,m.roomId,m.clientId,m.hostName);case "join_room":return joinRoom(ws,m.roomId,m.clientId,m.username);case "sync_room":return syncRoom(ws,m.roomId,m.clientId);case "quiz_started":return startQuiz(ws,m.roomId,m.questions,m.timeLimit);case "submit_answer":return submitAnswer(ws,m.roomId,m.answer,m.timeTaken);}
}
