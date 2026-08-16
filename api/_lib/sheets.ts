import { google } from "googleapis";
import type { sheets_v4 } from "googleapis";
import type { ResultRow } from "../../shared/types.js";

const LEGACY_RESULTS_SHEET = "Results";
const RESULTS_HEADER = ["STT", "Họ tên", "Lớp", "Điểm", "Đánh giá", "Thời gian nộp"];

let sheetsClient: sheets_v4.Sheets | null = null;

function getSheetId(): string {
  const id = process.env.GOOGLE_SHEET_ID;
  if (!id) {
    throw new Error("Thiếu biến môi trường GOOGLE_SHEET_ID.");
  }
  return id;
}

function getClient(): sheets_v4.Sheets {
  if (sheetsClient) return sheetsClient;

  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY;
  if (!email || !privateKey) {
    throw new Error(
      "Thiếu biến môi trường GOOGLE_SERVICE_ACCOUNT_EMAIL hoặc GOOGLE_PRIVATE_KEY."
    );
  }

  const auth = new google.auth.JWT({
    email,
    key: privateKey.replace(/\\n/g, "\n"),
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  sheetsClient = google.sheets({ version: "v4", auth });
  return sheetsClient;
}

/** Tên sheet Google Sheets không được chứa các ký tự này và tối đa 100 ký tự. */
export function buildResultsSheetName(lectureTitle: string, date: Date = new Date()): string {
  const safeTitle = lectureTitle.replace(/[:\\/?*[\]]/g, "").trim();
  const stamp = date
    .toLocaleString("vi-VN", {
      timeZone: "Asia/Ho_Chi_Minh",
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
    .replace(/[:\\/?*[\]]/g, "-");
  const name = `KQ ${stamp} - ${safeTitle}`;
  return name.slice(0, 100);
}

async function ensureResultsSheetExists(sheetName: string): Promise<void> {
  const sheets = getClient();
  const spreadsheetId = getSheetId();

  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const existing = meta.data.sheets?.some((s) => s.properties?.title === sheetName);

  if (!existing) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{ addSheet: { properties: { title: sheetName } } }],
      },
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `'${sheetName}'!A1:F1`,
      valueInputOption: "RAW",
      requestBody: { values: [RESULTS_HEADER] },
    });
  }
}

/** Tạo 1 sheet kết quả mới (dùng khi giảng viên upload tài liệu mới), giữ nguyên các sheet cũ làm lưu trữ. */
export async function createResultsSheet(sheetName: string): Promise<void> {
  await ensureResultsSheetExists(sheetName);
}

function normalizeKey(hoTen: string, lop: string): string {
  return `${hoTen.trim().toLowerCase()}|${lop.trim().toLowerCase()}`;
}

export async function hasStudentSubmitted(
  sheetName: string,
  hoTen: string,
  lop: string
): Promise<boolean> {
  await ensureResultsSheetExists(sheetName);
  const sheets = getClient();
  const spreadsheetId = getSheetId();

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${sheetName}'!B2:C`,
  });

  const rows = res.data.values ?? [];
  const target = normalizeKey(hoTen, lop);
  return rows.some((row) => normalizeKey(row[0] ?? "", row[1] ?? "") === target);
}

export async function appendResult(sheetName: string, row: Omit<ResultRow, "stt">): Promise<void> {
  await ensureResultsSheetExists(sheetName);
  const sheets = getClient();
  const spreadsheetId = getSheetId();

  const existing = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${sheetName}'!A2:A`,
  });
  const nextStt = (existing.data.values?.length ?? 0) + 1;

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `'${sheetName}'!A:F`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: {
      values: [[nextStt, row.hoTen, row.lop, row.diem, row.danhGia, row.thoiGianNop]],
    },
  });
}

export async function getAllResults(sheetName: string): Promise<ResultRow[]> {
  await ensureResultsSheetExists(sheetName);
  const sheets = getClient();
  const spreadsheetId = getSheetId();

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${sheetName}'!A2:F`,
  });

  const rows = res.data.values ?? [];
  return rows
    .filter((r) => r[1])
    .map((r) => ({
      stt: Number(r[0]) || 0,
      hoTen: r[1] ?? "",
      lop: r[2] ?? "",
      diem: r[3] ?? "",
      danhGia: r[4] ?? "",
      thoiGianNop: r[5] ?? "",
    }));
}

/** Tên sheet mặc định dùng cho dữ liệu tạo trước khi có tính năng tách sheet theo từng lần upload. */
export const DEFAULT_RESULTS_SHEET = LEGACY_RESULTS_SHEET;
