import type { VercelRequest, VercelResponse } from "@vercel/node";
import crypto from "node:crypto";
import { verifyAuthHeader } from "./_lib/auth.js";
import { saveUploadJob } from "./_lib/kv.js";
import type { UploadJob } from "./_lib/kv.js";
import { QUESTIONS_PER_BATCH, uploadFilesToAi } from "./_lib/gemini.js";
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
const DEFAULT_QUESTIONS = 30;
const MAX_QUESTIONS = 100;
const MAX_TIME_LIMIT_MINUTES = 600;

interface UploadBody {
  pastedText?: string;
  files?: UploadFilePayload[];
  totalQuestions?: number;
  allowRetake?: boolean;
  timeLimitMinutes?: number;
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

  const totalQuestions = parsePositiveInt(body.totalQuestions, DEFAULT_QUESTIONS, MAX_QUESTIONS);
  const allowRetake = body.allowRetake === true;
  // 0 = không giới hạn; giá trị không hợp lệ cũng coi là không giới hạn.
  const rawLimit = typeof body.timeLimitMinutes === "number" ? Math.floor(body.timeLimitMinutes) : 0;
  const timeLimitMinutes = rawLimit >= 1 ? Math.min(rawLimit, MAX_TIME_LIMIT_MINUTES) : 0;

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
    uploadedFiles = await uploadFilesToAi(inlineFiles);
  } catch (err) {
    console.error("upload-document: uploadFilesToAi failed:", err);
    sendError(res, 502, `Lỗi khi tải file lên AI: ${friendlyErrorMessage(err)}`);
    return;
  }

  // Bước "plan" lập danh sách `totalQuestions` nội dung riêng biệt; sau đó mỗi bước "q:*" soạn câu hỏi cho 1 lô
  // nội dung (theo vị trí trong danh sách) — mỗi bước là 1 lần gọi AI, luôn an toàn với trần 60s.
  const questionSteps: string[] = [];
  for (let start = 0; start < totalQuestions; start += QUESTIONS_PER_BATCH) {
    const end = Math.min(start + QUESTIONS_PER_BATCH, totalQuestions);
    questionSteps.push(`q:${Array.from({ length: end - start }, (_, i) => start + i).join(",")}`);
  }

  const jobId = crypto.randomUUID();
  const job: UploadJob = {
    status: "processing",
    pastedText,
    extractedTexts,
    uploadedFiles,
    totalQuestions,
    allowRetake,
    timeLimitMinutes,
    steps: ["lecture", "plan", ...questionSteps],
    totalSteps: 2 + questionSteps.length,
    questionsByPoint: {},
    retriedPoints: [],
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
