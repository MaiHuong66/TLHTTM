import type { VercelRequest, VercelResponse } from "@vercel/node";
import crypto from "node:crypto";
import { verifyAuthHeader } from "./_lib/auth.js";
import { saveUploadJob } from "./_lib/kv.js";
import type { UploadJob } from "./_lib/kv.js";
import { planQuestionBatches, uploadFilesToGemini } from "./_lib/gemini.js";
import type { DocumentInput } from "./_lib/gemini.js";
import {
  DOCX_MIME_TYPES,
  INLINE_MIME_TYPES,
  XLSX_MIME_TYPES,
  extractDocxText,
  extractXlsxText,
} from "./_lib/fileParsers.js";
import { friendlyErrorMessage, methodNotAllowed, sendError } from "./_lib/http.js";
import type { StartUploadResponse, UploadFilePayload } from "../shared/types.js";

// Endpoint này chỉ chuẩn bị dữ liệu + tạo "job" xử lý nhiều bước (xem api/upload-step.ts),
// KHÔNG tự gọi Gemini để tạo bài giảng/câu hỏi — nhờ đó luôn chạy nhanh, không sợ vượt 60s.
export const config = { maxDuration: 60 };

const MAX_TOTAL_RAW_BYTES = 4 * 1024 * 1024;
const MAX_CHAPTERS = 20;
const MAX_BANK_QUESTIONS = 500;
const MAX_EXAM_PER_CHAPTER = 100;

interface UploadBody {
  pastedText?: string;
  files?: UploadFilePayload[];
  numChapters?: number;
  totalBankQuestions?: number;
  questionsPerChapterInExam?: number;
  fixedExam?: boolean;
  allowRetake?: boolean;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    await handleStart(req, res);
  } catch (err) {
    console.error("upload-document unhandled error:", err);
    if (!res.headersSent) {
      sendError(res, 500, `Lỗi không xác định: ${friendlyErrorMessage(err)}`);
    }
  }
}

function parsePositiveInt(value: unknown, fallback: number, max: number): number {
  const n = typeof value === "number" ? Math.floor(value) : NaN;
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, max);
}

async function handleStart(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    methodNotAllowed(res, ["POST"]);
    return;
  }

  if (!verifyAuthHeader(req.headers.authorization)) {
    sendError(res, 401, "Bạn cần đăng nhập với vai trò giảng viên.");
    return;
  }

  const body = (req.body ?? {}) as UploadBody;
  const pastedText = body.pastedText?.trim() ?? "";
  const files = (body.files ?? []).filter(
    (f): f is UploadFilePayload =>
      !!f && typeof f.name === "string" && typeof f.mimeType === "string" && typeof f.base64 === "string"
  );

  if ((body.files?.length ?? 0) > files.length) {
    sendError(res, 400, "Một hoặc nhiều file gửi lên bị thiếu dữ liệu. Vui lòng thử chọn lại file.");
    return;
  }

  if (!pastedText && files.length === 0) {
    sendError(res, 400, "Vui lòng dán nội dung tài liệu hoặc chọn ít nhất 1 file để upload.");
    return;
  }

  const numChapters = parsePositiveInt(body.numChapters, 1, MAX_CHAPTERS);
  const totalBankQuestions = Math.max(
    numChapters,
    parsePositiveInt(body.totalBankQuestions, 100, MAX_BANK_QUESTIONS)
  );
  const questionsPerChapterInExam = parsePositiveInt(body.questionsPerChapterInExam, 60, MAX_EXAM_PER_CHAPTER);
  const fixedExam = body.fixedExam === true;
  const allowRetake = body.allowRetake === true;

  const totalRawBytes = files.reduce((sum, f) => sum + Math.floor((f.base64.length * 3) / 4), 0);
  if (totalRawBytes > MAX_TOTAL_RAW_BYTES) {
    sendError(
      res,
      413,
      `Tổng dung lượng file vượt quá giới hạn ${(MAX_TOTAL_RAW_BYTES / (1024 * 1024)).toFixed(0)}MB. ` +
        "Vui lòng chọn ít file hơn hoặc giảm dung lượng."
    );
    return;
  }

  const extractedTexts: DocumentInput["extractedTexts"] = [];
  const inlineFiles: { name: string; mimeType: string; base64: string }[] = [];
  const unsupported: string[] = [];

  for (const file of files) {
    try {
      if (DOCX_MIME_TYPES.has(file.mimeType)) {
        const text = await extractDocxText(file.base64);
        extractedTexts.push({ name: file.name, text });
      } else if (XLSX_MIME_TYPES.has(file.mimeType)) {
        const text = extractXlsxText(file.base64);
        extractedTexts.push({ name: file.name, text });
      } else if (INLINE_MIME_TYPES.has(file.mimeType)) {
        inlineFiles.push({ name: file.name, mimeType: file.mimeType, base64: file.base64 });
      } else {
        unsupported.push(file.name);
      }
    } catch (err) {
      console.error(`upload-document: failed to parse file "${file.name}":`, err);
      sendError(res, 422, `Không thể đọc file "${file.name}". File có thể bị hỏng hoặc không đúng định dạng.`);
      return;
    }
  }

  if (unsupported.length > 0) {
    sendError(
      res,
      400,
      `Định dạng không được hỗ trợ cho file: ${unsupported.join(", ")}. ` +
        "Chỉ hỗ trợ PDF, DOCX, XLSX, PNG, JPG."
    );
    return;
  }

  let uploadedFiles: DocumentInput["uploadedFiles"];
  try {
    uploadedFiles = await uploadFilesToGemini(inlineFiles);
  } catch (err) {
    console.error("upload-document: uploadFilesToGemini failed:", err);
    sendError(res, 502, `Lỗi khi tải file lên Gemini: ${friendlyErrorMessage(err)}`);
    return;
  }

  const questionSteps = planQuestionBatches(numChapters, totalBankQuestions);
  const stepBatchSizes: Record<string, number> = {};
  for (const s of questionSteps) stepBatchSizes[s.key] = s.count;

  const jobId = crypto.randomUUID();
  const job: UploadJob = {
    status: "processing",
    pastedText,
    extractedTexts,
    uploadedFiles,
    numChapters,
    questionsPerChapterInExam,
    fixedExam,
    allowRetake,
    steps: ["lecture", ...questionSteps.map((s) => s.key)],
    stepBatchSizes,
    totalSteps: 1 + questionSteps.length,
    questionBatches: {},
  };

  try {
    await saveUploadJob(jobId, job);
  } catch (err) {
    console.error("upload-document: failed to save job:", err);
    sendError(res, 500, `Lỗi khi khởi tạo tiến trình xử lý: ${friendlyErrorMessage(err)}`);
    return;
  }

  const response: StartUploadResponse = { jobId, totalSteps: job.totalSteps };
  res.status(200).json(response);
}
