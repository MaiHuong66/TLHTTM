import type { VercelRequest, VercelResponse } from "@vercel/node";
import { verifyAuthHeader } from "./_lib/auth.js";
import { setLecture, setQuestions } from "./_lib/kv.js";
import { generateLecture, generateQuestionBank, uploadFilesToGemini } from "./_lib/gemini.js";
import type { DocumentInput } from "./_lib/gemini.js";
import {
  DOCX_MIME_TYPES,
  INLINE_MIME_TYPES,
  XLSX_MIME_TYPES,
  extractDocxText,
  extractXlsxText,
} from "./_lib/fileParsers.js";
import { friendlyErrorMessage, methodNotAllowed, sendError } from "./_lib/http.js";
import type { UploadFilePayload } from "../shared/types.js";

export const config = { maxDuration: 60 };

const MAX_TOTAL_RAW_BYTES = 4 * 1024 * 1024;

interface UploadBody {
  pastedText?: string;
  files?: UploadFilePayload[];
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    await handleUpload(req, res);
  } catch (err) {
    console.error("upload-document unhandled error:", err);
    if (!res.headersSent) {
      sendError(res, 500, `Lỗi không xác định: ${friendlyErrorMessage(err)}`);
    }
  }
}

async function handleUpload(req: VercelRequest, res: VercelResponse) {
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

  const doc: DocumentInput = { pastedText, extractedTexts, uploadedFiles };

  // Chạy song song để tránh vượt giới hạn thời gian thực thi (60s trên gói Hobby của Vercel)
  const [lectureResult, questionsResult] = await Promise.allSettled([
    generateLecture(doc),
    generateQuestionBank(doc),
  ]);

  if (lectureResult.status === "rejected") {
    console.error("upload-document: generateLecture failed:", lectureResult.reason);
    sendError(res, 502, `Lỗi khi tạo bài giảng: ${friendlyErrorMessage(lectureResult.reason)}`);
    return;
  }
  if (questionsResult.status === "rejected") {
    console.error("upload-document: generateQuestionBank failed:", questionsResult.reason);
    sendError(res, 502, `Lỗi khi sinh ngân hàng câu hỏi: ${friendlyErrorMessage(questionsResult.reason)}`);
    return;
  }

  const lectureData = lectureResult.value;
  const questions = questionsResult.value;

  try {
    await setLecture({ ...lectureData, updatedAt: new Date().toISOString() });
    await setQuestions(questions);
  } catch (err) {
    console.error("upload-document: failed to save to storage:", err);
    sendError(res, 500, `Lỗi khi lưu dữ liệu: ${friendlyErrorMessage(err)}`);
    return;
  }

  res.status(200).json({
    title: lectureData.title,
    sectionsCount: lectureData.sections.length,
    questionCount: questions.length,
  });
}
