import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  acquireSubmitLock,
  getAttempt,
  getAttemptIdForStudent,
  getExamConfig,
  getQuestions,
  releaseSubmitLock,
  saveAttempt,
} from "./_lib/kv.js";
import { appendResult } from "./_lib/sheets.js";
import { generateAssessment } from "./_lib/gemini.js";
import { normalizeStudentKey } from "./_lib/identity.js";
import { friendlyErrorMessage, methodNotAllowed, sendError } from "./_lib/http.js";
import type { AnswerKey, QuizReviewItem, SubmitTestResponse } from "../shared/types.js";

export const config = { maxDuration: 30 };

// Cho phép trễ một chút so với hạn chót để bù độ trễ mạng/tự động nộp khi hết giờ và các lần thử lại.
const SUBMIT_GRACE_MS = 60 * 1000;

interface SubmitBody {
  attemptId?: string;
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
  const attemptId = typeof body.attemptId === "string" ? body.attemptId : "";
  const answers = body.answers ?? {};

  if (!attemptId) {
    sendError(res, 400, "Thiếu mã lượt làm bài. Vui lòng tải lại trang và bắt đầu lại.");
    return;
  }

  let lockAcquired = false;
  try {
    const attempt = await getAttempt(attemptId);
    if (!attempt) {
      sendError(res, 404, "Lượt làm bài không tồn tại hoặc đã hết hạn. Vui lòng tải lại trang và bắt đầu lại.");
      return;
    }
    if (attempt.submitted) {
      sendError(res, 409, "Bài làm này đã được nộp rồi.");
      return;
    }

    // Thời gian tính theo đồng hồ của server từ lúc bắt đầu — client không thể tự kéo dài.
    if (attempt.timeLimitSeconds > 0) {
      const elapsedMs = Date.now() - attempt.startedAt;
      if (elapsedMs > attempt.timeLimitSeconds * 1000 + SUBMIT_GRACE_MS) {
        sendError(res, 403, "Đã quá thời gian làm bài nên bài làm không được ghi nhận.");
        return;
      }
    }

    const examConfig = await getExamConfig();
    if (!examConfig?.allowRetake) {
      const currentId = await getAttemptIdForStudent(attempt.sheetName, normalizeStudentKey(attempt.hoTen, attempt.lop));
      if (currentId && currentId !== attempt.attemptId) {
        sendError(res, 409, "Bạn đã mở bài làm này ở một cửa sổ khác. Vui lòng nộp bài ở cửa sổ đó.");
        return;
      }
    }

    const bank = await getQuestions();
    if (!bank || bank.length === 0) {
      sendError(res, 404, "Chưa có ngân hàng câu hỏi nào được tạo.");
      return;
    }
    const bankById = new Map(bank.map((q) => [q.id, q]));

    let score = 0;
    const review: QuizReviewItem[] = [];

    // Chấm theo danh sách câu hỏi server đã giao cho lượt này, không dựa vào danh sách client gửi lên.
    for (const id of attempt.questionIds) {
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
    if (total === 0) {
      sendError(res, 409, "Đề thi đã được giảng viên cập nhật. Vui lòng tải lại trang và làm lại bài.");
      return;
    }

    // Chống nộp trùng cùng lúc (vd vừa tự động nộp khi hết giờ vừa bấm nộp tay).
    lockAcquired = await acquireSubmitLock(attempt.attemptId);
    if (!lockAcquired) {
      sendError(res, 409, "Bài làm đang được xử lý, vui lòng đợi trong giây lát.");
      return;
    }

    const diem = `${score}/${total}`;
    // Nhận xét do AI viết chỉ là phần phụ — nếu Gemini lỗi thì vẫn phải ghi nhận điểm của sinh viên.
    const danhGia = await generateAssessment(score, total).catch(() => `Bạn đạt ${diem} câu đúng.`);
    const thoiGianNop = formatVietnamTime(new Date());

    await appendResult(attempt.sheetName, { hoTen: attempt.hoTen, lop: attempt.lop, diem, danhGia, thoiGianNop });
    await saveAttempt({ ...attempt, submitted: true });

    const response: SubmitTestResponse = { score, total, danhGia, review };
    res.status(200).json(response);
  } catch (err) {
    // Lỗi trước khi ghi nhận xong: nhả khóa để sinh viên (hoặc client tự thử lại) nộp lại được.
    if (lockAcquired) await releaseSubmitLock(attemptId).catch(() => undefined);
    sendError(res, 500, friendlyErrorMessage(err));
  }
}
