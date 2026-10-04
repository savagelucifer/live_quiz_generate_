"use client";

import { useState, useEffect, useRef } from "react";
import { createRealtimeClient, type RealtimeClient } from "@/lib/realtime-client";
import { motion, AnimatePresence } from "framer-motion";
import { Loader2, Users, Play, Trophy, Sparkles, CheckCircle2, XCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";

// Types
type Player = { id: string; username: string; score: number };
type Question = { question_text: string; options: string[] };
type RoundResult = { correct_answer: string; explanation: string; players: Player[] };

export function QuizApp() {
  const [socket, setSocket] = useState<RealtimeClient | null>(null);
  const [username, setUsername] = useState("");
  const [roomId, setRoomId] = useState("");
  const [roomState, setRoomState] = useState<"menu" | "waiting" | "playing" | "round_results" | "ended">("menu");
  const [players, setPlayers] = useState<Player[]>([]);
  const [isHost, setIsHost] = useState(false);
  const [currentQuestion, setCurrentQuestion] = useState<Question | null>(null);
  const [questionIndex, setQuestionIndex] = useState(0);
  const [selectedAnswer, setSelectedAnswer] = useState<string | null>(null);
  const [roundResult, setRoundResult] = useState<RoundResult | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [topic, setTopic] = useState("");
  const [difficulty, setDifficulty] = useState("Medium");
  const [numQuestions, setNumQuestions] = useState(5);
  const [timeLimit, setTimeLimit] = useState(15);
  const [timeRemaining, setTimeRemaining] = useState(15);
  const [roomTimeLimit, setRoomTimeLimit] = useState(15);
  
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const startTimeRef = useRef<number>(0);
  const clientIdRef = useRef<string>("");
  const roomIdRef = useRef<string>("");

  useEffect(() => {
    // Connect to Socket.IO server
    const newSocket = io();
    setSocket(newSocket);

    newSocket.on("player_joined", (updatedPlayers: Player[]) => {
      setPlayers(updatedPlayers);
    });

    newSocket.on("quiz_started", () => {
      setRoomState("playing");
    });

    newSocket.on("receive_question", ({ questionIndex, question, timeLimit: serverTimeLimit, startedAt }) => {
      setCurrentQuestion(question);
      setQuestionIndex(questionIndex);
      setRoomState("playing");
      setSelectedAnswer(null);
      setRoundResult(null);
      
      const limit = serverTimeLimit || 15;
      setRoomTimeLimit(limit);
      
      // Start timer
      const startedAtMs = Number(startedAt) || Date.now();
      const elapsedSeconds = Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000));
      setTimeRemaining(Math.max(0, limit - elapsedSeconds));
      startTimeRef.current = startedAtMs;
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = setInterval(() => {
        setTimeRemaining((prev) => {
          if (prev <= 1) {
            clearInterval(timerRef.current!);
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
    });

    newSocket.on("round_results", (result: RoundResult) => {
      setRoundResult(result);
      setRoomState("round_results");
      setPlayers(result.players);
      if (timerRef.current) clearInterval(timerRef.current);
    });

    newSocket.on("room_error", (message: string) => {
      alert(message);
      setRoomState("menu");
    });

    newSocket.on("connect", () => {
      if (roomIdRef.current) newSocket.emit("sync_room", { roomId: roomIdRef.current, clientId: clientIdRef.current });
    });

    newSocket.on("quiz_ended", (finalPlayers: Player[]) => {
      setPlayers(finalPlayers);
      setRoomState("ended");
      if (timerRef.current) clearInterval(timerRef.current);
    });

    return () => {
      newSocket.disconnect();
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  const handleCreateRoom = () => {
    if (!username.trim() || !socket) return;
    const newRoomId = Math.random().toString(36).substring(2, 8).toUpperCase();
    setRoomId(newRoomId);
    setIsHost(true);
    roomIdRef.current = newRoomId;
    socket.emit("create_room", { roomId: newRoomId, hostName: username, clientId: clientIdRef.current });
    setRoomState("waiting");
  };

  const handleJoinRoom = () => {
    if (!username.trim() || !roomId.trim() || !socket) return;
    roomIdRef.current = roomId.toUpperCase();
    socket.emit("join_room", { roomId: roomId.toUpperCase(), username, clientId: clientIdRef.current });
    setRoomState("waiting");
  };

  const generateAndStartQuiz = async () => {
    if (!socket || !isHost || !topic.trim()) return;
    setIsGenerating(true);
    
    // Call our AI API route to generate questions
    try {
      const response = await fetch("/api/generate-quiz", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic, difficulty, numQuestions }),
      });
      
      const data = await response.json();
      
      if (data.questions) {
        socket.emit("quiz_started", { roomId, questions: data.questions, timeLimit });
      }
    } catch (error) {
      console.error("Error generating quiz:", error);
    } finally {
      setIsGenerating(false);
    }
  };

  const handleAnswerSubmit = (answer: string) => {
    if (selectedAnswer || !socket || roomState !== "playing") return;
    setSelectedAnswer(answer);
    
    const timeTaken = (Date.now() - startTimeRef.current) / 1000;
    socket.emit("submit_answer", { roomId, answer, timeTaken });
  };

  return (
    <div className="min-h-screen w-full bg-zinc-950 text-slate-200 font-sans flex flex-col items-center py-12 px-4 relative overflow-hidden">
      {/* Background blobs */}
      <div className="absolute top-[-20%] left-[-10%] w-[50%] h-[50%] rounded-full bg-purple-900/20 blur-[120px] pointer-events-none" />
      <div className="absolute bottom-[-20%] right-[-10%] w-[50%] h-[50%] rounded-full bg-emerald-900/20 blur-[120px] pointer-events-none" />
      
      <div className="z-10 w-full max-w-4xl mx-auto flex flex-col items-center gap-8">
        {/* Header */}
        <motion.div 
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          className="text-center"
        >
          <h1 className="text-4xl md:text-6xl font-bold tracking-tight text-transparent bg-clip-text bg-gradient-to-r from-purple-400 to-emerald-400 drop-shadow-[0_0_15px_rgba(168,85,247,0.3)] mb-4 flex items-center justify-center gap-3">
            <Sparkles className="w-8 h-8 text-purple-400" />
            Live AI Quiz Engine
          </h1>
          <p className="text-slate-400 text-lg md:text-xl max-w-2xl mx-auto">
            Real-time multiplayer trivia generated dynamically by AI.
          </p>
        </motion.div>

        <AnimatePresence mode="wait">
          {/* Menu State */}
          {roomState === "menu" && (
            <motion.div
              key="menu"
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="w-full max-w-md w-full"
            >
              <Card className="bg-zinc-900/50 border-zinc-800 backdrop-blur-sm">
                <CardHeader>
                  <CardTitle className="text-2xl text-center text-slate-100">Join or Create</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <label className="text-sm font-medium text-slate-300">Your Name</label>
                    <Input 
                      placeholder="Enter your name..." 
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      className="bg-zinc-800/50 border-zinc-700 text-slate-100"
                    />
                  </div>
                  
                  <div className="pt-4 border-t border-zinc-800 space-y-4">
                    <div className="flex gap-2">
                      <Input 
                        placeholder="Room ID" 
                        value={roomId}
                        onChange={(e) => setRoomId(e.target.value)}
                        className="bg-zinc-800/50 border-zinc-700 text-slate-100 uppercase"
                        maxLength={6}
                      />
                      <Button onClick={handleJoinRoom} disabled={!username || !roomId} className="bg-emerald-600 hover:bg-emerald-500 text-white w-24">
                        Join
                      </Button>
                    </div>
                    
                    <div className="relative flex items-center py-2">
                      <div className="flex-grow border-t border-zinc-800"></div>
                      <span className="flex-shrink-0 mx-4 text-zinc-500 text-sm">OR</span>
                      <div className="flex-grow border-t border-zinc-800"></div>
                    </div>
                    
                    <Button 
                      onClick={handleCreateRoom} 
                      disabled={!username} 
                      className="w-full bg-purple-600 hover:bg-purple-500 text-white"
                    >
                      <Users className="w-4 h-4 mr-2" />
                      Create New Room
                    </Button>
                  </div>
                </CardContent>
              </Card>
            </motion.div>
          )}

          {/* Waiting Room State */}
          {roomState === "waiting" && (
            <motion.div
              key="waiting"
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="w-full max-w-2xl"
            >
              <Card className="bg-zinc-900/50 border-zinc-800 backdrop-blur-sm">
                <CardHeader className="text-center pb-2">
                  <CardTitle className="text-3xl text-slate-100">Room Code</CardTitle>
                  <div className="text-5xl font-mono font-bold tracking-widest text-emerald-400 mt-2 mb-4">
                    {roomId}
                  </div>
                  <CardDescription className="text-lg">
                    Waiting for players to join...
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mt-6">
                    {players.map((p) => (
                      <div key={p.id} className="flex items-center gap-3 bg-zinc-800/50 p-3 rounded-lg border border-zinc-700/50">
                        <Avatar className="h-10 w-10 border border-zinc-600">
                          <AvatarFallback className="bg-zinc-700 text-slate-200">
                            {p.username.substring(0, 2).toUpperCase()}
                          </AvatarFallback>
                        </Avatar>
                        <span className="font-medium text-slate-200 truncate">{p.username}</span>
                      </div>
                    ))}
                  </div>
                  
                  {isHost && (
                    <div className="mt-10 p-6 bg-zinc-800/30 rounded-xl border border-purple-500/20">
                      <h3 className="text-lg font-medium text-purple-300 mb-4 flex items-center gap-2">
                        <Sparkles className="w-5 h-5" /> Host Controls
                      </h3>
                      <div className="space-y-4">
                        <div className="space-y-2">
                          <label className="text-sm font-medium text-slate-300">What should the quiz be about?</label>
                          <Input 
                            placeholder="e.g. 90s Pop Culture, Advanced Quantum Physics..." 
                            value={topic}
                            onChange={(e) => setTopic(e.target.value)}
                            className="bg-zinc-900 border-zinc-700 text-slate-100"
                          />
                        </div>
                        
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                          <div className="space-y-2">
                            <label className="text-sm font-medium text-slate-300">Difficulty</label>
                            <select 
                              value={difficulty}
                              onChange={(e) => setDifficulty(e.target.value)}
                              className="flex h-10 w-full items-center justify-between rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-slate-100 placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                            >
                              <option value="Easy">Easy</option>
                              <option value="Medium">Medium</option>
                              <option value="Hard">Hard</option>
                            </select>
                          </div>
                          <div className="space-y-2">
                            <label className="text-sm font-medium text-slate-300">No. of Questions</label>
                            <Input 
                              type="number"
                              min={1}
                              max={50}
                              value={numQuestions}
                              onChange={(e) => setNumQuestions(Math.max(1, Math.min(50, parseInt(e.target.value) || 1)))}
                              className="bg-zinc-900 border-zinc-700 text-slate-100"
                            />
                          </div>
                          <div className="space-y-2">
                            <label className="text-sm font-medium text-slate-300">Time per Q (seconds)</label>
                            <Input 
                              type="number"
                              min={5}
                              max={120}
                              value={timeLimit}
                              onChange={(e) => setTimeLimit(Math.max(5, Math.min(120, parseInt(e.target.value) || 5)))}
                              className="bg-zinc-900 border-zinc-700 text-slate-100"
                            />
                          </div>
                        </div>
                        <Button 
                          onClick={generateAndStartQuiz} 
                          disabled={isGenerating || !topic || players.length < 1} 
                          className="w-full bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white shadow-lg"
                        >
                          {isGenerating ? (
                            <>
                              <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                              Generating Quiz with AI...
                            </>
                          ) : (
                            <>
                              <Play className="w-5 h-5 mr-2" />
                              Start Quiz
                            </>
                          )}
                        </Button>
                      </div>
                    </div>
                  )}
                  {!isHost && (
                    <div className="mt-10 text-center text-slate-400 p-4 animate-pulse">
                      Waiting for host to start the quiz...
                    </div>
                  )}
                </CardContent>
              </Card>
            </motion.div>
          )}

          {/* Playing / Round Results State */}
          {(roomState === "playing" || roomState === "round_results") && currentQuestion && (
            <motion.div
              key="playing"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="w-full max-w-3xl"
            >
              <div className="flex justify-between items-center mb-6">
                <div className="bg-zinc-800/80 px-4 py-2 rounded-full border border-zinc-700 text-sm font-medium">
                  Question {questionIndex + 1}
                </div>
                
                <div className="flex items-center gap-2 text-xl font-mono font-bold bg-zinc-800/80 px-4 py-2 rounded-full border border-zinc-700">
                  <span className={timeRemaining <= 5 ? "text-red-400" : "text-emerald-400"}>
                    00:{timeRemaining.toString().padStart(2, '0')}
                  </span>
                </div>
              </div>

              <Card className="bg-zinc-900/50 border-zinc-800 backdrop-blur-sm overflow-hidden">
                {/* Progress bar */}
                <div 
                  className="h-1 bg-emerald-500 transition-all duration-1000 ease-linear"
                  style={{ width: `${(timeRemaining / roomTimeLimit) * 100}%` }}
                />
                
                <CardContent className="pt-8 pb-8 px-6 md:px-10">
                  <h2 className="text-2xl md:text-3xl font-medium text-slate-100 mb-8 leading-tight">
                    {currentQuestion.question_text}
                  </h2>
                  
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {currentQuestion.options.map((option, idx) => {
                      let btnClass = "bg-zinc-800 hover:bg-zinc-700 border-zinc-700 text-slate-200";
                      let icon = null;
                      
                      if (roomState === "round_results" && roundResult) {
                        if (option === roundResult.correct_answer) {
                          btnClass = "bg-emerald-900/50 border-emerald-500 text-emerald-100";
                          icon = <CheckCircle2 className="w-5 h-5 text-emerald-400" />;
                        } else if (option === selectedAnswer) {
                          btnClass = "bg-red-900/50 border-red-500 text-red-100";
                          icon = <XCircle className="w-5 h-5 text-red-400" />;
                        } else {
                          btnClass = "bg-zinc-900/50 border-zinc-800 opacity-50";
                        }
                      } else if (selectedAnswer === option) {
                        btnClass = "bg-purple-900/50 border-purple-500 text-purple-100";
                      }
                      
                      return (
                        <button
                          key={idx}
                          onClick={() => handleAnswerSubmit(option)}
                          disabled={!!selectedAnswer || roomState === "round_results"}
                          className={`relative flex items-center justify-between p-4 rounded-xl border-2 transition-all text-left ${btnClass}`}
                        >
                          <span className="text-lg">{option}</span>
                          {icon && <span>{icon}</span>}
                        </button>
                      );
                    })}
                  </div>
                  
                  {roomState === "round_results" && roundResult && (
                    <motion.div 
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: "auto" }}
                      className="mt-8 p-4 bg-purple-900/20 border border-purple-500/30 rounded-xl"
                    >
                      <h4 className="text-purple-300 font-medium flex items-center gap-2 mb-2">
                        <Sparkles className="w-4 h-4" /> AI Explanation
                      </h4>
                      <p className="text-slate-300 text-sm md:text-base leading-relaxed">
                        {roundResult.explanation}
                      </p>
                    </motion.div>
                  )}
                </CardContent>
              </Card>

              {/* Leaderboard snippet during play */}
              <div className="mt-8">
                <h3 className="text-sm font-medium text-slate-500 uppercase tracking-wider mb-3 px-2">Current Standings</h3>
                <div className="flex flex-wrap gap-3">
                  {[...players].sort((a, b) => b.score - a.score).slice(0, 5).map((p, idx) => (
                    <div key={p.id} className="bg-zinc-900/50 border border-zinc-800 rounded-full px-4 py-2 flex items-center gap-3 text-sm">
                      <span className="text-zinc-500 font-mono">#{idx + 1}</span>
                      <span className="font-medium text-slate-300">{p.username}</span>
                      <span className="text-emerald-400 font-bold">{p.score} pts</span>
                    </div>
                  ))}
                </div>
              </div>
            </motion.div>
          )}

          {/* Ended / Podium State */}
          {roomState === "ended" && (
            <motion.div
              key="ended"
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              className="w-full max-w-2xl text-center"
            >
              <Card className="bg-zinc-900/80 border-purple-500/30 backdrop-blur-md overflow-hidden">
                <div className="h-2 bg-gradient-to-r from-purple-500 via-emerald-500 to-indigo-500" />
                <CardContent className="pt-12 pb-10">
                  <Trophy className="w-20 h-20 text-yellow-400 mx-auto mb-6 drop-shadow-[0_0_15px_rgba(250,204,21,0.5)]" />
                  <h2 className="text-4xl font-bold text-slate-100 mb-2">Quiz Complete!</h2>
                  <p className="text-slate-400 mb-10">Final Results</p>
                  
                  <div className="space-y-4 max-w-md mx-auto">
                    {[...players].sort((a, b) => b.score - a.score).map((p, idx) => (
                      <motion.div 
                        initial={{ opacity: 0, x: -20 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ delay: idx * 0.1 }}
                        key={p.id} 
                        className={`flex items-center justify-between p-4 rounded-xl border ${
                          idx === 0 
                            ? "bg-yellow-500/10 border-yellow-500/50 text-yellow-200 shadow-[0_0_15px_rgba(250,204,21,0.1)]" 
                            : idx === 1 
                              ? "bg-zinc-300/10 border-zinc-300/30 text-zinc-300"
                              : idx === 2
                                ? "bg-orange-600/10 border-orange-600/30 text-orange-300"
                                : "bg-zinc-800/50 border-zinc-700/50 text-slate-300"
                        }`}
                      >
                        <div className="flex items-center gap-4">
                          <span className="text-2xl font-bold opacity-50">#{idx + 1}</span>
                          <span className="text-xl font-medium">{p.username}</span>
                        </div>
                        <span className="text-xl font-bold">{p.score} pts</span>
                      </motion.div>
                    ))}
                  </div>
                  
                  <div className="mt-12">
                    <Button 
                      onClick={() => {
                        setRoomState("menu");
                        setRoomId("");
                        setIsHost(false);
                      }}
                      className="bg-zinc-800 hover:bg-zinc-700 text-slate-200"
                    >
                      Return to Menu
                    </Button>
                  </div>
                </CardContent>
              </Card>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
