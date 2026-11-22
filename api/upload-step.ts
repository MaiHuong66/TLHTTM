import type { VercelRequest, VercelResponse } from "@vercel/node";
import { verifyAuthHeader } from "./_lib/auth.js";
import {
  deleteUploadJob,
  getUploadJob,
  saveUploadJob,
  setCurrentResultsSheet,
  setExamConfig,
  setLecture,
  setQuestions,
} from "./_lib/kv.js";
import {
  findOverlaps,
  finalizeQuestions,
  generateCellQuestions,
  generateLecture,
  mergeCellQuestions,
  planMatrix,
  verifyAnswers,
} from "./_lib/gemini.js";
import type { DocumentInput } from "./_lib/gemini.js";
import {
  MAX_OVERLAP_ROUNDS,
  MIN_OVERLAP_ROUNDS,
  VERIFY_BATCH,
  applyAnswerChecks,
  applyOverlaps,
  auditItems,
  avoidListFor,
  keyQuestions,
  scheduleRefills,
} from "./_lib/bankAudit.js";
import { isServiceUnavailableError, rateLimitRetrySeconds } from "./_lib/retry.js";
import { buildResultsSheetName, createResultsSheet } from "./_lib/sheets.js";
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
    } else if (nextStep === "plan") {
      job.matrix = await planMatrix(doc, job.levelCounts);
    } else if (nextStep.startsWith("q:")) {
      // Step key dạng "q:{vị trí ô},{vị trí ô},..." (vị trí trong job.matrix.cells).
      const cells = job.matrix?.cells ?? [];
      const cellIds = nextStep
        .slice(2)
        .split(",")
        .map(Number)
        .filter((i) => Number.isInteger(i) && i >= 0 && i < cells.length)
        .map((i) => cells[i].id);

      if (job.matrix && cellIds.length > 0) {
        const generated = await generateCellQuestions(
          doc,
          job.matrix,
          cellIds,
          job.variantsPerCell,
          (reason, item) =>
            console.warn(`upload-step: job ${jobId} bỏ 1 câu (${reason}):`, JSON.stringify(item).slice(0, 500)),
          Object.fromEntries(cellIds.map((id) => [id, avoidListFor(job, id)]))
        );
        for (const id of cellIds) {
          job.questionsByCell[id] = mergeCellQuestions(
            job.questionsByCell[id] ?? [],
            keyQuestions(job, id, generated[id] ?? []),
            job.variantsPerCell
          );
        }
        // Ô còn thiếu câu dự phòng (AI trả về thiếu/không hợp lệ): cho soạn lại trước bước kiểm định.
        scheduleRefills(job, cellIds);
      }
    } else if (nextStep === "verify") {
      // Tự giải lại đáp án cho 1 lô câu chưa kiểm; loại câu sai/mơ hồ rồi cho soạn lại ô bị thiếu.
      const pending = auditItems(job)
        .filter((item) => !job.questionsByCell[item.cell]?.find((q) => q.key === item.key)?.verified)
        .slice(0, VERIFY_BATCH);
      if (pending.length > 0) {
        const results = await verifyAnswers(doc, pending);
        const touched = applyAnswerChecks(job, pending, results, (msg) => console.warn(`upload-step: job ${jobId} ${msg}`));
        scheduleRefills(job, touched);
      }
      const unverifiedLeft = auditItems(job).some(
        (item) => !job.questionsByCell[item.cell]?.find((q) => q.key === item.key)?.verified
      );
      if (unverifiedLeft && !job.steps.slice(1).includes("verify")) {
        job.steps.splice(1, 0, "verify");
        job.totalSteps++;
      }
    } else if (nextStep === "overlap") {
      // Rà trùng ý trên toàn ngân hàng: loại câu trùng với câu ở ô khác, soạn lại ô bị thiếu (kèm ý phải tránh) rồi
      // kiểm định lại; tới vòng cuối thì chỉ loại bớt câu dự phòng và ghi lại cặp trùng còn lại để lúc bốc đề tránh.
      job.overlapRounds++;
      const allowRefill = job.overlapRounds < MAX_OVERLAP_ROUNDS;
      const pairs = await findOverlaps(auditItems(job));
      const touched = applyOverlaps(job, pairs, allowRefill, (msg) => console.warn(`upload-step: job ${jobId} ${msg}`));
      if (allowRefill) scheduleRefills(job, touched);
      // Kết quả rà trùng của AI có lúc bỏ sót, nên luôn rà ít nhất 2 vòng kể cả khi vòng đầu không phải soạn lại gì.
      if (job.overlapRounds < MIN_OVERLAP_ROUNDS && !job.steps.slice(1).includes("overlap")) {
        job.steps.push("overlap");
        job.totalSteps++;
      }
    }
  } catch (err) {
    console.error(
      `upload-step: step "${nextStep}" failed for job ${jobId}: ${err instanceof Error ? err.message : String(err)}`,
      err
    );

    // Gemini quá tải/lỗi máy chủ/mạng (đã tự thử lại trong gemini.ts mà vẫn lỗi): job chưa hỏng gì — kết quả
    // chỉ được lưu sau khi bước thành công — nên trả 503 để trình duyệt gọi lại ĐÚNG bước này sau ít lâu,
    // thay vì đánh dấu thất bại cả lượt upload (có thể đã chạy được nhiều phút).
    const waitSec = rateLimitRetrySeconds(err);
    if (waitSec !== null) {
      // Vượt hạn mức theo phút (gói miễn phí/hạn mức thấp): cũng chưa hỏng job, chỉ cần chờ rồi gọi lại bước này.
      res.status(429).json({
        error: `Gemini đang giới hạn tần suất, sẽ tự thử lại sau ${waitSec} giây.`,
        retryAfterSec: waitSec,
      });
      return;
    }
    if (isServiceUnavailableError(err)) {
      sendError(res, 503, "Gemini đang quá tải, hệ thống sẽ tự thử lại bước này.");
      return;
    }

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
  let conflicts: [string, string][] = [];
  try {
    if (!job.matrix) throw new Error("Thiếu ma trận đề sau khi xử lý xong các bước.");
    const finalized = finalizeQuestions(job.matrix, job.questionsByCell);
    questions = finalized.questions;
    conflicts = (job.conflicts ?? [])
      .map(([a, b]) => [finalized.idByKey[a], finalized.idByKey[b]] as [string, string])
      .filter(([a, b]) => a && b);
  } catch (err) {
    console.error(`upload-step: finalizeQuestions failed for job ${jobId}:`, err);
    sendError(res, 500, friendlyErrorMessage(err));
    return;
  }

  // Ô không soạn được câu nào kể cả sau khi thử lại sẽ không có trong đề (đề ít câu hơn tương ứng).
  const matrixCells = job.matrix!.cells.map((c) => c.id).filter((id) => questions.some((q) => q.cell === id));

  try {
    await setLecture({ ...job.lecture, updatedAt: new Date().toISOString() });
    await setQuestions(questions);
    await setExamConfig({
      numChapters: 1,
      questionsPerChapterInExam: matrixCells.length,
      fixedExam: false,
      allowRetake: job.allowRetake,
      timeLimitMinutes: job.timeLimitMinutes ?? 0,
      shuffleOptions: true,
      matrixCells,
      conflicts,
    });
  } catch (err) {
    console.error(`upload-step: failed to save final data for job ${jobId}:`, err);
    sendError(res, 500, `Lỗi khi lưu dữ liệu: ${friendlyErrorMessage(err)}`);
    return;
  }

  // Tạo 1 sheet Google Sheets mới để lưu kết quả cho bài giảng mới này, tách biệt với các sheet kết quả
  // cũ (được giữ nguyên làm lưu trữ, không bị xóa). Nếu bước này lỗi, không làm hỏng toàn bộ upload —
  // chỉ log lại, app vẫn dùng sheet kết quả trước đó (hoặc sheet mặc định "Results" nếu chưa từng có).
  try {
    const newSheetName = buildResultsSheetName(job.lecture.title);
    await createResultsSheet(newSheetName);
    await setCurrentResultsSheet(newSheetName);
  } catch (err) {
    console.error(`upload-step: failed to create new results sheet for job ${jobId}:`, err);
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
      examQuestionCount: matrixCells.length,
      topicCount: job.matrix.topics.length,
    },
  };
  res.status(200).json(response);
}
