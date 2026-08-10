import type { VercelRequest, VercelResponse } from "@vercel/node";
import { verifyAuthHeader } from "./_lib/auth.js";
import { deleteUploadJob, getUploadJob, saveUploadJob, setLecture, setQuestions } from "./_lib/kv.js";
import { QUESTION_FOCUS_HINTS, finalizeQuestions, generateLecture, generateQuestionBatch } from "./_lib/gemini.js";
import type { DocumentInput } from "./_lib/gemini.js";
import { friendlyErrorMessage, methodNotAllowed, sendError } from "./_lib/http.js";
import type { UploadStepResponse } from "../shared/types.js";

// Mỗi lần gọi endpoint này chỉ thực hiện ĐÚNG 1 bước (1 lệnh gọi Gemini) rồi trả về ngay,
// nên luôn chạy rất nhanh so với giới hạn 60s. Client (TeacherUploadPage) gọi lặp lại endpoint
// này cho tới khi status = "done"/"failed", nhờ đó tổng thời gian xử lý không còn bị chặn bởi
// trần thời gian của 1 lần gọi hàm serverless.
export const config = { maxDuration: 60 };

interface StepBody {
  jobId?: string;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    await handleStep(req, res);
  } catch (err) {
    console.error("upload-step unhandled error:", err);
    if (!res.headersSent) {
      sendError(res, 500, `Lỗi không xác định: ${friendlyErrorMessage(err)}`);
    }
  }
}

async function handleStep(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    methodNotAllowed(res, ["POST"]);
    return;
  }

  if (!verifyAuthHeader(req.headers.authorization)) {
    sendError(res, 401, "Bạn cần đăng nhập với vai trò giảng viên.");
    return;
  }

  const { jobId } = (req.body ?? {}) as StepBody;
  if (typeof jobId !== "string" || !jobId) {
    sendError(res, 400, "Thiếu jobId.");
    return;
  }

  const job = await getUploadJob(jobId);
  if (!job) {
    sendError(res, 404, "Tiến trình xử lý không tồn tại hoặc đã hết hạn. Vui lòng thử upload lại.");
    return;
  }

  if (job.status === "failed") {
    const response: UploadStepResponse = {
      status: "failed",
      completedSteps: job.totalSteps - job.steps.length,
      totalSteps: job.totalSteps,
      error: job.error,
    };
    res.status(200).json(response);
    return;
  }

  if (job.steps.length === 0) {
    // Đã xử lý xong hết các bước ở lần gọi trước nhưng job vẫn còn (hiếm khi xảy ra) — trả về done.
    const response: UploadStepResponse = {
      status: "done",
      completedSteps: job.totalSteps,
      totalSteps: job.totalSteps,
    };
    res.status(200).json(response);
    return;
  }

  const doc: DocumentInput = {
    pastedText: job.pastedText,
    extractedTexts: job.extractedTexts,
    uploadedFiles: job.uploadedFiles,
  };

  const nextStep = job.steps[0];

  try {
    if (nextStep === "lecture") {
      job.lecture = await generateLecture(doc);
    } else {
      const index = Number(nextStep.replace("batch", ""));
      const focusHint = QUESTION_FOCUS_HINTS[index % QUESTION_FOCUS_HINTS.length];
      job.questionBatches[index] = await generateQuestionBatch(doc, index, focusHint);
    }
  } catch (err) {
    console.error(`upload-step: step "${nextStep}" failed for job ${jobId}:`, err);
    job.status = "failed";
    job.error = friendlyErrorMessage(err);
    await saveUploadJob(jobId, job);
    const response: UploadStepResponse = {
      status: "failed",
      completedSteps: job.totalSteps - job.steps.length,
      totalSteps: job.totalSteps,
      error: job.error,
    };
    res.status(200).json(response);
    return;
  }

  job.steps = job.steps.slice(1);

  if (job.steps.length > 0) {
    await saveUploadJob(jobId, job);
    const response: UploadStepResponse = {
      status: "processing",
      completedSteps: job.totalSteps - job.steps.length,
      totalSteps: job.totalSteps,
    };
    res.status(200).json(response);
    return;
  }

  // Đã xong hết các bước — chốt kết quả và lưu vào Redis.
  if (!job.lecture) {
    sendError(res, 500, "Thiếu dữ liệu bài giảng sau khi xử lý xong các bước.");
    return;
  }

  let questions;
  try {
    questions = finalizeQuestions(job.questionBatches);
  } catch (err) {
    console.error(`upload-step: finalizeQuestions failed for job ${jobId}:`, err);
    sendError(res, 500, friendlyErrorMessage(err));
    return;
  }

  try {
    await setLecture({ ...job.lecture, updatedAt: new Date().toISOString() });
    await setQuestions(questions);
  } catch (err) {
    console.error(`upload-step: failed to save final data for job ${jobId}:`, err);
    sendError(res, 500, `Lỗi khi lưu dữ liệu: ${friendlyErrorMessage(err)}`);
    return;
  }

  await deleteUploadJob(jobId);

  const response: UploadStepResponse = {
    status: "done",
    completedSteps: job.totalSteps,
    totalSteps: job.totalSteps,
    result: {
      title: job.lecture.title,
      sectionsCount: job.lecture.sections.length,
      questionCount: questions.length,
    },
  };
  res.status(200).json(response);
}
