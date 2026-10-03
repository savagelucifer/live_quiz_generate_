/* eslint-disable */
const { createServer } = require("http");
const next = require("next");
const { Server } = require("socket.io");

const dev = process.env.NODE_ENV !== "production";
const hostname = "localhost";
const port = process.env.PORT || 3000;

const app = next({ dev, hostname, port });
const handler = app.getRequestHandler();

// In-memory data store for rooms
const rooms = new Map();
// rooms.get(roomId) = { host: socket.id, players: [{id, username, score}], status: 'lobby'|'playing'|'ended', questions: [], currentQuestionIndex: 0 }

app.prepare().then(() => {
  const httpServer = createServer(handler);
  const io = new Server(httpServer);

  io.on("connection", (socket) => {
    console.log("Player connected:", socket.id);

    // 1. Host creates a room
    socket.on("create_room", ({ roomId, hostName }) => {
      socket.join(roomId);
      rooms.set(roomId, {
        host: socket.id,
        players: [{ id: socket.id, username: hostName, score: 0 }],
        status: "lobby",
        questions: [],
        currentQuestionIndex: 0,
        answersThisRound: 0,
      });
      io.to(roomId).emit("player_joined", rooms.get(roomId).players);
    });

    // 2. Player joins a room
    socket.on("join_room", ({ roomId, username }) => {
      socket.join(roomId);
      const room = rooms.get(roomId);
      if (room) {
        room.players.push({ id: socket.id, username, score: 0 });
        io.to(roomId).emit("player_joined", room.players);
      }
    });

    // 3. Quiz started by host
    socket.on("quiz_started", ({ roomId, questions, timeLimit }) => {
      const room = rooms.get(roomId);
      if (room && room.host === socket.id) {
        room.status = "playing";
        room.questions = questions; // Store AI generated questions
        room.timeLimit = timeLimit || 15;
        room.currentQuestionIndex = 0;
        
        io.to(roomId).emit("quiz_started");
        
        // Push first question after a short delay
        setTimeout(() => sendQuestion(roomId, 0), 2000);
      }
    });

    const sendQuestion = (roomId, index) => {
      const room = rooms.get(roomId);
      if (!room) return;

      if (index < room.questions.length) {
        room.currentQuestionIndex = index;
        room.answersThisRound = 0;
        const q = room.questions[index];
        
        // Exclude the correct answer when sending to clients
        const clientQuestion = {
          question_text: q.question_text,
          options: q.options,
        };
        
        io.to(roomId).emit("receive_question", { questionIndex: index, question: clientQuestion, timeLimit: room.timeLimit });
      } else {
        // No more questions, trigger podium
        room.status = "ended";
        io.to(roomId).emit("quiz_ended", room.players);
      }
    };

    // 4. Player submits an answer
    socket.on("submit_answer", ({ roomId, answer, timeTaken }) => {
      const room = rooms.get(roomId);
      if (room) {
        const q = room.questions[room.currentQuestionIndex];
        const isCorrect = q.correct_answer === answer;
        
        // Calculate points based on time (e.g. max 1000 points, timeLimit seconds max)
        const timeLimit = room.timeLimit || 15;
        let points = 0;
        if (isCorrect) {
          const timeRatio = Math.max(0, (timeLimit - timeTaken) / timeLimit);
          points = Math.round(500 + (500 * timeRatio));
        }

        // Update player score
        const player = room.players.find(p => p.id === socket.id);
        if (player) {
          player.score += points;
        }

        room.answersThisRound += 1;

        // If everyone answered, emit round results immediately
        if (room.answersThisRound >= room.players.length) {
          io.to(roomId).emit("round_results", {
            correct_answer: q.correct_answer,
            explanation: q.explanation,
            players: room.players
          });

          // Send next question after a 5 second pause to review results
          setTimeout(() => sendQuestion(roomId, room.currentQuestionIndex + 1), 5000);
        }
      }
    });

    socket.on("disconnect", () => {
      console.log("Player disconnected:", socket.id);
      // Clean up rooms on disconnect for robust production apps
      for (const [roomId, room] of rooms.entries()) {
        room.players = room.players.filter(p => p.id !== socket.id);
        io.to(roomId).emit("player_joined", room.players);
      }
    });
  });

  httpServer
    .once("error", (err) => {
      console.error(err);
      process.exit(1);
    })
    .listen(port, () => {
      console.log(`> Ready on http://${hostname}:${port}`);
    });
});
