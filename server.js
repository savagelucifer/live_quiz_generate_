/* eslint-disable */
const { createServer } = require("http");
const next = require("next");
const { Server } = require("socket.io");

const dev = process.env.NODE_ENV !== "production";
const hostname = "localhost";
const port = process.env.PORT || 3000;

const app = next({ dev, hostname, port });
const handler = app.getRequestHandler();
const rooms = new Map();

app.prepare().then(() => {
  const httpServer = createServer(handler);
  const io = new Server(httpServer);

  const emitPlayerList = (roomId) => {
    const room = rooms.get(roomId);
    if (room) io.to(roomId).emit("player_joined", room.players);
  };

  const sendQuestion = (roomId, socketId) => {
    const room = rooms.get(roomId);
    if (!room || room.status !== "playing") return;
    const progress = room.progress[socketId];
    if (!progress || progress.finished) return;

    if (progress.questionIndex >= room.questions.length) {
      progress.finished = true;
      io.to(socketId).emit("quiz_ended", room.players);
      if (room.players.every((p) => room.progress[p.id]?.finished)) {
        room.status = "ended";
        io.to(roomId).emit("quiz_ended", room.players);
      }
      return;
    }

    progress.answered = false;
    progress.questionStartedAt = Date.now();
    const q = room.questions[progress.questionIndex];

    io.to(socketId).emit("receive_question", {
      questionIndex: progress.questionIndex,
      question: { question_text: q.question_text, options: q.options },
      timeLimit: room.timeLimit,
      startedAt: progress.questionStartedAt,
    });

    setTimeout(() => {
      const latest = rooms.get(roomId);
      const current = latest?.progress[socketId];
      if (!latest || latest.status !== "playing" || !current || current.finished || current.answered || current.questionIndex !== progress.questionIndex) return;

      current.answered = true;
      io.to(socketId).emit("round_results", {
        correct_answer: q.correct_answer,
        explanation: q.explanation,
        players: latest.players,
        timedOut: true,
      });
      io.to(roomId).emit("player_scores", latest.players);
    }, (room.timeLimit + 1) * 1000);
  };

  io.on("connection", (socket) => {
    console.log("Player connected:", socket.id);

    socket.on("create_room", ({ roomId, hostName }) => {
      if (rooms.has(roomId)) return socket.emit("room_error", "That room already exists.");
      socket.join(roomId);
      rooms.set(roomId, {
        host: socket.id,
        players: [{ id: socket.id, username: hostName, score: 0 }],
        status: "lobby",
        questions: [],
        timeLimit: 15,
        progress: {},
      });
      emitPlayerList(roomId);
    });

    socket.on("join_room", ({ roomId, username }) => {
      socket.join(roomId);
      const room = rooms.get(roomId);
      if (!room) return socket.emit("room_error", "Room not found.");
      if (room.status !== "lobby") return socket.emit("room_error", "This quiz has already started.");
      room.players.push({ id: socket.id, username, score: 0 });
      emitPlayerList(roomId);
    });

    socket.on("quiz_started", ({ roomId, questions, timeLimit }) => {
      const room = rooms.get(roomId);
      if (!room || room.host !== socket.id) return;

      room.status = "playing";
      room.questions = questions;
      room.timeLimit = timeLimit || 15;
      room.progress = Object.fromEntries(
        room.players.map((p) => [p.id, { questionIndex: 0, answered: false, finished: false, questionStartedAt: 0 }])
      );

      io.to(roomId).emit("quiz_started");
      setTimeout(() => {
        const latest = rooms.get(roomId);
        if (!latest || latest.status !== "playing") return;
        latest.players.forEach((p) => sendQuestion(roomId, p.id));
      }, 1500);
    });

    socket.on("submit_answer", ({ roomId, answer, timeTaken }) => {
      const room = rooms.get(roomId);
      if (!room || room.status !== "playing") return;

      const progress = room.progress[socket.id];
      if (!progress || progress.finished || progress.answered) return;

      const q = room.questions[progress.questionIndex];
      const player = room.players.find((p) => p.id === socket.id);
      if (!q || !player) return;

      const elapsed = (Date.now() - progress.questionStartedAt) / 1000;
      if (elapsed > room.timeLimit + 0.5) return;

      const measuredTime = Math.max(0, Math.min(room.timeLimit, Number(timeTaken) || elapsed));
      if (q.correct_answer === answer) {
        player.score += Math.round(500 + 500 * Math.max(0, (room.timeLimit - measuredTime) / room.timeLimit));
      }

      progress.answered = true;
      io.to(roomId).emit("player_scores", room.players);
      io.to(socket.id).emit("round_results", {
        correct_answer: q.correct_answer,
        explanation: q.explanation,
        players: room.players,
        timedOut: false,
      });
    });

    socket.on("next_question", ({ roomId }) => {
      const room = rooms.get(roomId);
      if (!room || room.status !== "playing") return;

      const progress = room.progress[socket.id];
      if (!progress || !progress.answered || progress.finished) return;

      progress.questionIndex += 1;
      sendQuestion(roomId, socket.id);
    });

    socket.on("disconnect", () => {
      for (const [roomId, room] of rooms.entries()) {
        room.players = room.players.filter((p) => p.id !== socket.id);
        delete room.progress[socket.id];

        if (room.players.length === 0) {
          rooms.delete(roomId);
        } else {
          emitPlayerList(roomId);
        }
      }
    });
  });

  httpServer.once("error", (err) => {
    console.error(err);
    process.exit(1);
  }).listen(port, () => {
    console.log(`> Ready on http://${hostname}:${port}`);
  });
});
