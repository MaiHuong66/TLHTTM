import mammoth from "mammoth";
import * as XLSX from "xlsx";

export async function extractDocxText(base64: string): Promise<string> {
  const buffer = Buffer.from(base64, "base64");
  const result = await mammoth.extractRawText({ buffer });
  return result.value;
}

export function extractXlsxText(base64: string): string {
  const buffer = Buffer.from(base64, "base64");
  const workbook = XLSX.read(buffer, { type: "buffer" });

  return workbook.SheetNames.map((name) => {
    const sheet = workbook.Sheets[name];
    const csv = XLSX.utils.sheet_to_csv(sheet);
    return `[Sheet: ${name}]\n${csv}`;
  }).join("\n\n");
}

export const INLINE_MIME_TYPES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
]);

export const DOCX_MIME_TYPES = new Set([
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);

export const XLSX_MIME_TYPES = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
]);
