import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getQuestions } from "./_lib/kv.js";
import { friendlyErrorMessage, methodNotAllowed, sendError } from "./_lib/http.js";
import type { QuizQuestion } from "../shared/types.js";

const QUIZ_LENGTH = 15;

function shuffle<T>(arr: T[]): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    methodNotAllowed(res, ["GET"]);
    return;
  }

  try {
    const questions = await getQuestions();
    if (!questions || questions.length === 0) {
      sendError(res, 404, "Chưa có ngân hàng câu hỏi nào được tạo.");
      return;
    }

    const selected = shuffle(questions).slice(0, Math.min(QUIZ_LENGTH, questions.length));
    const quiz: QuizQuestion[] = selected.map(({ id, question, options }) => ({ id, question, options }));

    res.status(200).json({ questions: quiz });
  } catch (err) {
    sendError(res, 500, friendlyErrorMessage(err));
  }
}
