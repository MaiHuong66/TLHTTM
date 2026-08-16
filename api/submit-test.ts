import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getCurrentResultsSheet, getQuestions } from "./_lib/kv.js";
import { DEFAULT_RESULTS_SHEET, appendResult, hasStudentSubmitted } from "./_lib/sheets.js";
import { generateAssessment } from "./_lib/gemini.js";
import { friendlyErrorMessage, methodNotAllowed, sendError } from "./_lib/http.js";
import type { AnswerKey, QuizReviewItem, SubmitTestResponse } from "../shared/types.js";

export const config = { maxDuration: 30 };

interface SubmitBody {
  hoTen?: string;
  lop?: string;
  questionIds?: string[];
  answers?: Record<string, AnswerKey>;
}

function formatVietnamTime(date: Date): string {
  return date.toLocaleString("vi-VN", {
    timeZone: "Asia/Ho_Chi_Minh",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    methodNotAllowed(res, ["POST"]);
    return;
  }

  const body = (req.body ?? {}) as SubmitBody;
  const hoTen = body.hoTen?.trim();
  const lop = body.lop?.trim();
  const questionIds = body.questionIds;
  const answers = body.answers ?? {};

  if (!hoTen || !lop) {
    sendError(res, 400, "Vui lòng nhập đầy đủ họ tên và lớp.");
    return;
  }
  if (!Array.isArray(questionIds) || questionIds.length === 0) {
    sendError(res, 400, "Thiếu danh sách câu hỏi của bài test.");
    return;
  }

  try {
    const sheetName = (await getCurrentResultsSheet()) ?? DEFAULT_RESULTS_SHEET;

    const alreadySubmitted = await hasStudentSubmitted(sheetName, hoTen, lop);
    if (alreadySubmitted) {
      sendError(res, 409, "Bạn đã làm bài test này rồi. Mỗi sinh viên chỉ được làm 1 lần.");
      return;
    }

    const bank = await getQuestions();
    if (!bank || bank.length === 0) {
      sendError(res, 404, "Chưa có ngân hàng câu hỏi nào được tạo.");
      return;
    }
    const bankById = new Map(bank.map((q) => [q.id, q]));

    let score = 0;
    const review: QuizReviewItem[] = [];

    for (const id of questionIds) {
      const question = bankById.get(id);
      if (!question) continue;
      const chosen = answers[id] ?? null;
      const isCorrect = chosen === question.correctAnswer;
      if (isCorrect) score++;
      review.push({
        id: question.id,
        question: question.question,
        options: question.options,
        correctAnswer: question.correctAnswer,
        chosen,
        isCorrect,
      });
    }

    const total = review.length;
    const danhGia = await generateAssessment(score, total);
    const diem = `${score}/${total}`;
    const thoiGianNop = formatVietnamTime(new Date());

    await appendResult(sheetName, { hoTen, lop, diem, danhGia, thoiGianNop });

    const response: SubmitTestResponse = { score, total, danhGia, review };
    res.status(200).json(response);
  } catch (err) {
    sendError(res, 500, friendlyErrorMessage(err));
  }
}
