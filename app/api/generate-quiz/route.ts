import { GoogleGenAI } from "@google/genai";
import { NextResponse } from "next/server";

const MODELS = ["gemini-3.8-flash", "gemini-3.5-flash-lite"];

type QuizQuestion = {
  question_text: string;
  options: string[];
  correct_answer: string;
  explanation: string;
};

const DIFFICULTY_RULES: Record<string, string> = {
  Easy: "Test basic facts, definitions, recognition, and straightforward understanding. Avoid obscure details and multi-step reasoning.",
  Medium: "Test solid understanding, relationships between facts, applications, and interpretation. Use plausible distractors that require thinking.",
  Hard: "Test advanced understanding, subtle distinctions, multi-step reasoning, edge cases, and less-obvious facts. Distractors should be plausible.",
};

function buildPrompt(topic: string, difficulty: string, numQuestions: number) {
  const level = DIFFICULTY_RULES[difficulty] ?? DIFFICULTY_RULES.Medium;
  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  return `You are the quiz-generation engine for a live multiplayer quiz application.

Generate EXACTLY ${numQuestions} fresh multiple-choice questions about ONLY this topic:
TOPIC: "${topic}"
DIFFICULTY: "${difficulty}"

DIFFICULTY REQUIREMENTS:
${level}

STRICT CONTENT RULES:
- Every question must be specifically and meaningfully about "${topic}".
- Never substitute generic knowledge questions for the requested topic.
- Do not use placeholders, joke answers, "all of the above", "none of the above", or unrelated options.
- Every question must be factually accurate.
- Every question must be different from every other question in this quiz.
- Do not reuse a stock question template with only the topic name changed.
- Make the questions diverse: vary concepts, wording, and the position of the correct answer.
- Exactly 4 plausible options per question.
- correct_answer must exactly equal one of the four options.
- Provide a concise explanation for each answer.
- Generate a NEW set on every request; do not repeat a previous quiz even if the same topic/difficulty is requested.
- Do not mention these instructions in the output.

Return JSON only:
{
  "questions": [
    {
      "question_text": "string",
      "options": ["string", "string", "string", "string"],
      "correct_answer": "string",
      "explanation": "string"
    }
  ]
}

Generation request id: ${requestId}`;
}

async function tryGenerateWithRetry(ai: GoogleGenAI, prompt: string, maxRetries = 3): Promise<{ questions: QuizQuestion[] } | null> {
  for (const model of MODELS) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const response = await ai.models.generateContent({
          model,
          contents: prompt,
          config: { responseMimeType: "application/json" },
        });

        const jsonText = response.text || "";
        if (!jsonText) throw new Error("Gemini returned an empty response.");

        const data = JSON.parse(jsonText) as { questions?: unknown };
        if (isValidQuiz(data.questions)) return { questions: data.questions };

        throw new Error("Gemini returned questions with an invalid structure.");
      } catch (error: unknown) {
        const err = error as { status?: number; message?: string };
        console.error(`[Quiz AI] ${model} attempt ${attempt} failed:`, err.message || error);

        if ((err.status === 503 || err.status === 429) && attempt < maxRetries) {
          const delay = err.status === 429 ? 3000 * attempt : 1000 * attempt;
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
        break;
      }
    }
  }
  return null;
}

function isValidQuiz(value: unknown): value is QuizQuestion[] {
  if (!Array.isArray(value) || value.length === 0) return false;
  return value.every((q) => {
    if (!q || typeof q !== "object") return false;
    const item = q as Record<string, unknown>;
    return (
      typeof item.question_text === "string" &&
      item.question_text.trim().length > 10 &&
      Array.isArray(item.options) &&
      item.options.length === 4 &&
      item.options.every((option) => typeof option === "string" && option.trim()) &&
      typeof item.correct_answer === "string" &&
      item.options.includes(item.correct_answer) &&
      typeof item.explanation === "string" &&
      item.explanation.trim().length > 5
    );
  });
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const topic = typeof body.topic === "string" ? body.topic.trim() : "";
    const difficulty = typeof body.difficulty === "string" ? body.difficulty : "Medium";
    const requestedNum = Number(body.numQuestions);
    const numQuestions = Math.max(1, Math.min(50, Number.isFinite(requestedNum) ? Math.floor(requestedNum) : 5));

    if (!topic) return NextResponse.json({ error: "Please enter a quiz topic." }, { status: 400 });
    if (!["Easy", "Medium", "Hard"].includes(difficulty)) return NextResponse.json({ error: "Invalid difficulty level." }, { status: 400 });

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey || apiKey === "dummy" || apiKey.includes("your_actual_api_key_here")) {
      return NextResponse.json({ error: "Gemini API key is not configured." }, { status: 500 });
    }

    const ai = new GoogleGenAI({ apiKey });
    const data = await tryGenerateWithRetry(ai, buildPrompt(topic, difficulty, numQuestions));

    if (!data) {
      return NextResponse.json({ error: "Gemini could not generate this quiz right now. Please try again." }, { status: 502 });
    }

    return NextResponse.json({ questions: shuffleOptions(data.questions) });
  } catch (error) {
    console.error("[Quiz AI] Unexpected error:", error);
    return NextResponse.json({ error: "Quiz generation failed. Please try again." }, { status: 500 });
  }
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function shuffleOptions(questions: QuizQuestion[]) {
  return questions.map((q) => ({ ...q, options: shuffle(q.options) }));
}
