import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getExamConfig, getQuestions } from "./_lib/kv.js";
import { friendlyErrorMessage, methodNotAllowed, sendError } from "./_lib/http.js";
import type { Question, QuizQuestion } from "../shared/types.js";

const DEFAULT_QUESTIONS_PER_CHAPTER = 60;

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

    const examConfig = await getExamConfig();
    const numChapters = examConfig?.numChapters ?? 1;
    const questionsPerChapter = examConfig?.questionsPerChapterInExam ?? DEFAULT_QUESTIONS_PER_CHAPTER;

    const byChapter = new Map<number, Question[]>();
    for (const q of questions) {
      const chapter = q.chapter ?? 1;
      const list = byChapter.get(chapter) ?? [];
      list.push(q);
      byChapter.set(chapter, list);
    }

    const selected: Question[] = [];
    for (let chapter = 1; chapter <= numChapters; chapter++) {
      const pool = byChapter.get(chapter) ?? [];
      selected.push(...shuffle(pool).slice(0, questionsPerChapter));
    }

    const quiz: QuizQuestion[] = shuffle(selected).map(({ id, question, options, chapter }) => ({
      id,
      question,
      options,
      chapter,
    }));

    res.status(200).json({ questions: quiz });
  } catch (err) {
    sendError(res, 500, friendlyErrorMessage(err));
  }
}
