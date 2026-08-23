import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getExamConfig, getQuestions } from "./_lib/kv.js";
import { friendlyErrorMessage, methodNotAllowed, sendError } from "./_lib/http.js";
import type { Difficulty, Question, QuizQuestion } from "../shared/types.js";

const DEFAULT_QUESTIONS_PER_CHAPTER = 60;
const DIFFICULTY_ORDER: Difficulty[] = ["Cơ bản", "Trung bình", "Nâng cao"];

function shuffle<T>(arr: T[]): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/** Chọn `total` câu từ `pool`, chia đều theo 3 mức độ khó (bù thiếu hụt nếu 1 mức không đủ câu),
 * rồi xáo trộn ngẫu nhiên — đề vẫn có đủ cả 3 mức nhưng thứ tự câu không theo dễ-khó. */
function pickBalancedByDifficulty(pool: Question[], total: number): Question[] {
  const byDifficulty = new Map<Difficulty, Question[]>(DIFFICULTY_ORDER.map((d) => [d, []]));
  for (const q of pool) {
    const difficulty = DIFFICULTY_ORDER.includes(q.difficulty) ? q.difficulty : "Cơ bản";
    byDifficulty.get(difficulty)!.push(q);
  }

  const base = Math.floor(total / DIFFICULTY_ORDER.length);
  const remainder = total % DIFFICULTY_ORDER.length;

  const picked: Question[] = [];
  DIFFICULTY_ORDER.forEach((d, i) => {
    const target = base + (i < remainder ? 1 : 0);
    picked.push(...shuffle(byDifficulty.get(d) ?? []).slice(0, target));
  });

  const stillNeeded = total - picked.length;
  if (stillNeeded > 0) {
    const pickedIds = new Set(picked.map((q) => q.id));
    const remainingPool = shuffle(pool.filter((q) => !pickedIds.has(q.id)));
    picked.push(...remainingPool.slice(0, stillNeeded));
  }

  return shuffle(picked);
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
      selected.push(...pickBalancedByDifficulty(pool, questionsPerChapter));
    }

    const quiz: QuizQuestion[] = selected.map(({ id, question, options, chapter, difficulty }) => ({
      id,
      question,
      options,
      chapter,
      difficulty,
    }));

    res.status(200).json({ questions: quiz });
  } catch (err) {
    sendError(res, 500, friendlyErrorMessage(err));
  }
}
