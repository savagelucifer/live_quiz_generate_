import { GoogleGenAI } from "@google/genai";
import { NextResponse } from "next/server";

// Models to try in order of preference (updated to latest available)
const MODELS = [
  "gemini-3.8-flash",
  "gemini-3.5-flash-lite",
];

async function tryGenerateWithRetry(
  ai: GoogleGenAI,
  prompt: string,
  maxRetries: number = 3
) {
  for (const model of MODELS) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`[Quiz AI] Trying model "${model}", attempt ${attempt}/${maxRetries}...`);

        const response = await ai.models.generateContent({
          model,
          contents: prompt,
          config: {
            responseMimeType: "application/json",
          },
        });

        const jsonText = response.text || "{}";
        const data = JSON.parse(jsonText);

        // Validate the response has the expected structure
        if (data.questions && Array.isArray(data.questions) && data.questions.length > 0) {
          console.log(`[Quiz AI] ✅ Successfully generated ${data.questions.length} questions with "${model}"`);
          return data;
        }

        console.warn(`[Quiz AI] Model "${model}" returned invalid structure, retrying...`);
      } catch (error: unknown) {
        const err = error as { status?: number; message?: string };
        console.error(`[Quiz AI] Model "${model}" attempt ${attempt} failed:`, err.message || error);

        // If it's a 503 (overloaded), wait before retrying
        if (err.status === 503 && attempt < maxRetries) {
          const delay = 1000 * attempt; // 1s, 2s, 3s backoff
          console.log(`[Quiz AI] Server overloaded, waiting ${delay}ms before retry...`);
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }

        // If it's a 429 (rate limit), wait longer
        if (err.status === 429 && attempt < maxRetries) {
          const delay = 3000 * attempt;
          console.log(`[Quiz AI] Rate limited, waiting ${delay}ms before retry...`);
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }

        // For other errors, break to try next model
        if (err.status !== 503 && err.status !== 429) {
          break;
        }
      }
    }
    console.log(`[Quiz AI] All retries exhausted for "${model}", trying next model...`);
  }

  // All models failed
  return null;
}

export async function POST(req: Request) {
  try {
    const { topic, difficulty = "Medium", numQuestions = 5 } = await req.json();

    const apiKey = process.env.GEMINI_API_KEY;

    // Fallback if no API key is provided
    if (!apiKey || apiKey === "dummy" || apiKey.includes("your_actual_api_key_here")) {
      console.warn("[Quiz AI] No valid GEMINI_API_KEY found, using fallback questions.");
      return NextResponse.json(getFallbackQuestions(topic, numQuestions));
    }

    const ai = new GoogleGenAI({ apiKey });

    const prompt = `Generate a ${numQuestions}-question multiple choice trivia quiz about "${topic}". The difficulty level should be "${difficulty}".

IMPORTANT RULES:
- Questions must be factually accurate and specifically about "${topic}"
- Each question must be unique and different
- Each question must have exactly 4 options
- The correct_answer must exactly match one of the options
- CRITICAL: Randomize which option is correct. Do NOT always make the first option the correct answer. Spread correct answers across all positions (A, B, C, D) roughly equally.
- Provide a brief, educational explanation for each answer

Output valid JSON only with the following structure:
{
  "questions": [
    {
      "question_text": "Question here",
      "options": ["Option A", "Option B", "Option C", "Option D"],
      "correct_answer": "Option B",
      "explanation": "Explanation here"
    }
  ]
}`;

    const data = await tryGenerateWithRetry(ai, prompt);

    if (data) {
      // Shuffle option order so the correct answer isn't always first
      data.questions = shuffleOptions(data.questions);
      return NextResponse.json(data);
    }

    // All models failed, return fallback
    console.error("[Quiz AI] ❌ All AI models failed. Returning fallback questions.");
    return NextResponse.json(getFallbackQuestions(topic, numQuestions));
  } catch (error) {
    console.error("[Quiz AI] Unexpected error:", error);
    return NextResponse.json(getFallbackQuestions("General Knowledge", 5));
  }
}

// Fisher-Yates shuffle for an array
function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Shuffle the options in each question so the correct answer isn't always in the same position
function shuffleOptions(questions: { question_text: string; options: string[]; correct_answer: string; explanation: string }[]) {
  return questions.map(q => ({
    ...q,
    options: shuffle(q.options),
  }));
}

function getFallbackQuestions(topic: string, num: number) {
  const baseQuestions = {
    questions: [
      {
        question_text: `Which of the following is a key aspect of ${topic}?`,
        options: ["The flux capacitor", "Quantum entanglement", "The primary directive", "All of the above"],
        correct_answer: "The primary directive",
        explanation: `In the study of ${topic}, the primary directive is often cited as the most crucial element.`
      },
      {
        question_text: `When was the concept of ${topic} first introduced?`,
        options: ["1920", "1975", "2001", "2024"],
        correct_answer: "1975",
        explanation: "1975 marks the historical consensus for its introduction."
      },
      {
        question_text: `Who is considered the father of ${topic}?`,
        options: ["Albert Einstein", "Marie Curie", "John Doe", "Ada Lovelace"],
        correct_answer: "John Doe",
        explanation: "John Doe's early papers laid the groundwork."
      },
      {
        question_text: `What is the most common application of ${topic}?`,
        options: ["Space exploration", "Web development", "Culinary arts", "Deep sea diving"],
        correct_answer: "Web development",
        explanation: "It is widely used in building modern web applications."
      },
      {
        question_text: `Which color is traditionally associated with ${topic}?`,
        options: ["Red", "Blue", "Green", "Purple"],
        correct_answer: "Purple",
        explanation: "Purple represents the creativity and mystery behind it."
      }
    ]
  };

  return {
    questions: baseQuestions.questions.slice(0, num)
  };
}
