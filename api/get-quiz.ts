import type { VercelRequest, VercelResponse } from "@vercel/node";
import crypto from "node:crypto";
import {
  attemptTtlSeconds,
  claimAttemptForStudent,
  deleteAttemptIdForStudent,
  getAttempt,
  getAttemptIdForStudent,
  getCurrentResultsSheet,
  getExamConfig,
  getQuestions,
  saveAttempt,
} from "./_lib/kv.js";
import type { QuizAttempt } from "./_lib/kv.js";
import { DEFAULT_RESULTS_SHEET, hasStudentSubmitted } from "./_lib/sheets.js";
import { normalizeStudentKey } from "./_lib/identity.js";
import { displayedOptions, randomOptionOrder } from "./_lib/optionOrder.js";
import { friendlyErrorMessage, methodNotAllowed, sendError } from "./_lib/http.js";
import type { AnswerKey, Difficulty, Question, QuizQuestion, StartQuizResponse } from "../shared/types.js";

export const config = { maxDuration: 30 };

const DEFAULT_QUESTIONS_PER_CHAPTER = 60;
const DIFFICULTY_ORDER: Difficulty[] = ["Cơ bản", "Trung bình", "Nâng cao"];

interface StartBody {
  hoTen?: string;
  lop?: string;
}

function questionIdNumber(id: string): number {
  return Number(id.replace(/[^0-9]/g, "")) || 0;
}

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

/**
 * Đề theo ma trận: mỗi ô (chủ đề con × mức độ) bốc ngẫu nhiên đúng 1 trong các câu dự phòng của ô — tỉ lệ mức độ luôn
 * cố định, mỗi lượt khác nhau — và không bao giờ bốc 2 câu nằm trong 1 cặp trùng ý (`conflicts`).
 *
 * Cách tìm: (1) loại trước các câu không thể dùng — câu trùng ý với MỌI câu còn lại của một ô khác (bốc nó thì ô kia
 * không còn câu nào); lặp tới khi không loại thêm được. (2) Thử-quay-lui ngẫu nhiên, mỗi bước bốc ô còn ít lựa chọn
 * nhất và chỉ nhận câu mà mọi ô chưa bốc vẫn còn câu hợp lệ. Nếu thật sự không có tổ hợp đủ mọi ô thì bỏ ô không bốc
 * được, vì đề không được có câu trùng nội dung.
 */
export function drawFromMatrix(
  questions: Question[],
  matrixCells: string[],
  conflicts: [string, string][]
): Question[] {
  const conflictsOf = new Map<string, Set<string>>();
  for (const [a, b] of conflicts) {
    conflictsOf.set(a, (conflictsOf.get(a) ?? new Set()).add(b));
    conflictsOf.set(b, (conflictsOf.get(b) ?? new Set()).add(a));
  }
  const clash = (a: Question, b: Question) => conflictsOf.get(a.id)?.has(b.id) ?? false;

  const pools = new Map<string, Question[]>();
  for (const cell of matrixCells) {
    const pool = questions.filter((q) => q.cell === cell);
    if (pool.length > 0) pools.set(cell, pool);
  }

  // (1) Loại câu không thể dùng.
  for (let changed = true; changed; ) {
    changed = false;
    for (const [cell, pool] of pools) {
      const usable = pool.filter((q) =>
        [...pools].every(([other, otherPool]) => other === cell || otherPool.some((o) => !clash(q, o)))
      );
      if (usable.length > 0 && usable.length < pool.length) {
        pools.set(cell, usable);
        changed = true;
      }
    }
  }

  // (2) Thử-quay-lui có kiểm tra trước.
  const chosen = new Map<string, Question>();
  const options = (cell: string) =>
    pools.get(cell)!.filter((q) => [...chosen.values()].every((c) => !clash(q, c)));
  let budget = 50000;
  const search = (): boolean => {
    const remaining = [...pools.keys()].filter((c) => !chosen.has(c));
    if (remaining.length === 0) return true;
    // Ô ít lựa chọn nhất trước (hòa thì ngẫu nhiên).
    const cell = shuffle(remaining).sort((a, b) => options(a).length - options(b).length)[0];
    for (const q of shuffle(options(cell))) {
      if (--budget < 0) return false;
      chosen.set(cell, q);
      const stillPossible = remaining.every((c) => c === cell || options(c).length > 0);
      if (stillPossible && search()) return true;
      chosen.delete(cell);
    }
    return false;
  };
  if (search()) return [...chosen.values()];

  // Không có tổ hợp đủ mọi ô: chọn tham lam, bỏ ô không còn câu nào hợp lệ.
  chosen.clear();
  for (const cell of shuffle([...pools.keys()])) {
    const q = shuffle(options(cell))[0];
    if (q) chosen.set(cell, q);
  }
  return [...chosen.values()];
}

function selectQuestions(
  questions: Question[],
  numChapters: number,
  questionsPerChapter: number,
  fixedExam: boolean,
  useAllQuestions: boolean,
  matrixCells: string[] | undefined,
  conflicts: [string, string][] | undefined
): Question[] {
  if (matrixCells && matrixCells.length > 0) {
    return shuffle(drawFromMatrix(questions, matrixCells, conflicts ?? []));
  }

  if (useAllQuestions) {
    // Đề gồm đúng các câu đã tạo: lượt nào cũng đủ tất cả các câu, chỉ khác thứ tự.
    return shuffle(questions);
  }

  if (fixedExam) {
    // Đề cố định: dùng TOÀN BỘ ngân hàng câu hỏi, cùng 1 thứ tự ổn định cho mọi lượt làm bài.
    return [...questions].sort((a, b) => {
      if (a.chapter !== b.chapter) return a.chapter - b.chapter;
      return questionIdNumber(a.id) - questionIdNumber(b.id);
    });
  }

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
  // Xáo trộn chung các chương: mỗi sinh viên nhận 1 thứ tự câu hỏi khác nhau.
  return shuffle(selected);
}

/** Câu hỏi gửi cho sinh viên: không kèm đáp án đúng/mức độ, phương án theo thứ tự đã đảo của lượt làm. */
function toQuizQuestions(selected: Question[], optionOrders?: Record<string, AnswerKey[]>): QuizQuestion[] {
  return selected.map((q) => ({
    id: q.id,
    question: q.question,
    options: displayedOptions(q, optionOrders?.[q.id]),
    chapter: q.chapter,
  }));
}

function remainingSecondsOf(attempt: QuizAttempt): number {
  if (attempt.timeLimitSeconds <= 0) return 0;
  const remainingMs = attempt.timeLimitSeconds * 1000 - (Date.now() - attempt.startedAt);
  return Math.max(0, Math.ceil(remainingMs / 1000));
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    methodNotAllowed(res, ["POST"]);
    return;
  }

  const body = (req.body ?? {}) as StartBody;
  const hoTen = typeof body.hoTen === "string" ? body.hoTen.trim() : "";
  const lop = typeof body.lop === "string" ? body.lop.trim() : "";
  if (!hoTen || !lop) {
    sendError(res, 400, "Vui lòng nhập đầy đủ họ tên và lớp.");
    return;
  }

  try {
    const questions = await getQuestions();
    if (!questions || questions.length === 0) {
      sendError(res, 404, "Chưa có ngân hàng câu hỏi nào được tạo.");
      return;
    }
    const bankById = new Map(questions.map((q) => [q.id, q]));

    const examConfig = await getExamConfig();
    const sheetName = (await getCurrentResultsSheet()) ?? DEFAULT_RESULTS_SHEET;
    const timeLimitSeconds = Math.max(0, Math.floor((examConfig?.timeLimitMinutes ?? 0) * 60));
    const allowRetake = examConfig?.allowRetake === true;
    const studentKey = normalizeStudentKey(hoTen, lop);

    const resume = (attempt: QuizAttempt): StartQuizResponse => ({
      attemptId: attempt.attemptId,
      questions: toQuizQuestions(
        attempt.questionIds.map((id) => bankById.get(id)).filter((q): q is Question => !!q),
        attempt.optionOrders
      ),
      timeLimitSeconds: attempt.timeLimitSeconds,
      remainingSeconds: remainingSecondsOf(attempt),
      resumed: true,
    });

    if (!allowRetake) {
      const existingId = await getAttemptIdForStudent(sheetName, studentKey);
      const existing = existingId ? await getAttempt(existingId) : null;

      if (existing && !existing.submitted) {
        // Đề chỉ cho làm 1 lần: mở lại trong thời gian còn lại thì tiếp tục đúng lượt đang làm dở
        // (cùng bộ câu hỏi, cùng đồng hồ) — không cấp thêm thời gian hay random lại đề.
        if (existing.timeLimitSeconds <= 0 || remainingSecondsOf(existing) > 0) {
          res.status(200).json(resume(existing));
          return;
        }
        sendError(res, 409, "Bạn đã bắt đầu làm bài này và đã hết thời gian làm bài. Mỗi sinh viên chỉ được làm 1 lần.");
        return;
      }

      if (await hasStudentSubmitted(sheetName, hoTen, lop)) {
        sendError(res, 409, "Bạn đã làm bài test này rồi. Mỗi sinh viên chỉ được làm 1 lần.");
        return;
      }

      // Lượt cũ đã nộp nhưng kết quả không còn trong sheet (giảng viên đã xóa để cho làm lại).
      if (existingId) await deleteAttemptIdForStudent(sheetName, studentKey);
    }

    const selected = selectQuestions(
      questions,
      examConfig?.numChapters ?? 1,
      examConfig?.questionsPerChapterInExam ?? DEFAULT_QUESTIONS_PER_CHAPTER,
      examConfig?.fixedExam === true,
      examConfig?.useAllQuestions === true,
      examConfig?.matrixCells,
      examConfig?.conflicts
    );

    const optionOrders: Record<string, AnswerKey[]> | undefined = examConfig?.shuffleOptions
      ? Object.fromEntries(selected.map((q) => [q.id, randomOptionOrder()]))
      : undefined;

    const attempt: QuizAttempt = {
      attemptId: crypto.randomUUID(),
      hoTen,
      lop,
      sheetName,
      startedAt: Date.now(),
      timeLimitSeconds,
      questionIds: selected.map((q) => q.id),
      optionOrders,
      submitted: false,
    };

    // Lưu lượt trước khi "giành" chỉ mục sinh viên, để lượt thắng luôn đọc được ngay cả khi lượt khác vừa tranh.
    await saveAttempt(attempt);

    if (!allowRetake) {
      // Hai yêu cầu bắt đầu gần như cùng lúc (bấm đúp, mở 2 tab): chỉ 1 lượt được giữ, lượt còn lại tiếp tục lượt đó.
      const winnerId = await claimAttemptForStudent(
        sheetName,
        studentKey,
        attempt.attemptId,
        attemptTtlSeconds(timeLimitSeconds)
      );
      if (winnerId !== attempt.attemptId) {
        const winner = await getAttempt(winnerId);
        if (winner && !winner.submitted) {
          res.status(200).json(resume(winner));
          return;
        }
      }
    }

    const response: StartQuizResponse = {
      attemptId: attempt.attemptId,
      questions: toQuizQuestions(selected, optionOrders),
      timeLimitSeconds,
      remainingSeconds: timeLimitSeconds,
      resumed: false,
    };
    res.status(200).json(response);
  } catch (err) {
    sendError(res, 500, friendlyErrorMessage(err));
  }
}
