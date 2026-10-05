import { google } from "googleapis";
import type { sheets_v4 } from "googleapis";
import type { ResultRow } from "../../shared/types.js";
import { normalizeStudentKey } from "./identity.js";

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

// Google Sheets giới hạn số lượt đọc/ghi mỗi phút (~60 lượt/phút cho 1 tài khoản dịch vụ), nên tránh gọi
// thừa: sheet đã xác nhận tồn tại thì ghi nhớ lại trong instance này, không kiểm tra lại mỗi lần.
const knownSheets = new Set<string>();

async function ensureResultsSheetExists(sheetName: string): Promise<void> {
  if (knownSheets.has(sheetName)) return;

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

  knownSheets.add(sheetName);
}

function isRetryableSheetsError(err: unknown): boolean {
  const e = err as { code?: number | string; status?: number; response?: { status?: number }; message?: string };
  const status = Number(e?.response?.status ?? e?.status ?? e?.code);
  if (status === 429 || status >= 500) return true;
  if (typeof e?.code === "string" && /^E[A-Z]+$/.test(e.code)) return true; // ECONNRESET, ETIMEDOUT...
  // Lỗi thoáng qua quan sát được ngay sau khi tạo sheet mới / sheet bị xóa tay rồi tạo lại.
  return /Unable to parse range/i.test(e?.message ?? "");
}

/** Thử lại có chờ tăng dần khi Google Sheets báo vượt hạn mức hoặc lỗi thoáng qua — quan trọng lúc nhiều
 * sinh viên nộp bài gần như cùng lúc (vd cùng hết giờ). Mỗi lần thử lại sẽ kiểm tra lại sự tồn tại của sheet. */
async function withSheetsRetry<T>(sheetName: string, fn: () => Promise<T>): Promise<T> {
  const maxAttempts = 4;
  for (let attempt = 1; ; attempt++) {
    try {
      await ensureResultsSheetExists(sheetName);
      return await fn();
    } catch (err) {
      knownSheets.delete(sheetName);
      if (attempt >= maxAttempts || !isRetryableSheetsError(err)) throw err;
      const delay = 800 * 2 ** (attempt - 1) + Math.floor(Math.random() * 400);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

/** Tạo 1 sheet kết quả mới (dùng khi giảng viên upload tài liệu mới), giữ nguyên các sheet cũ làm lưu trữ. */
export async function createResultsSheet(sheetName: string): Promise<void> {
  await ensureResultsSheetExists(sheetName);
}

export async function hasStudentSubmitted(
  sheetName: string,
  hoTen: string,
  lop: string
): Promise<boolean> {
  return withSheetsRetry(sheetName, async () => {
    const res = await getClient().spreadsheets.values.get({
      spreadsheetId: getSheetId(),
      range: `'${sheetName}'!B2:C`,
    });

    const rows = res.data.values ?? [];
    const target = normalizeStudentKey(hoTen, lop);
    return rows.some((row) => normalizeStudentKey(row[0] ?? "", row[1] ?? "") === target);
  });
}

/** Họ tên/Lớp/nhận xét do người dùng nhập hoặc AI sinh ra; ghi bằng USER_ENTERED nên chữ bắt đầu bằng
 * = + - @ có thể bị Google Sheets hiểu là công thức — thêm dấu ' phía trước để luôn là văn bản thuần. */
function asPlainText(value: string): string {
  return /^[=+\-@]/.test(value) ? `'${value}` : value;
}

export async function appendResult(sheetName: string, row: Omit<ResultRow, "stt">): Promise<void> {
  return withSheetsRetry(sheetName, async () => {
    // STT là công thức theo số dòng nên không cần đọc sheet để đếm trước khi ghi (bớt 1 lượt đọc mỗi
    // lần nộp bài, và không bị trùng STT khi nhiều sinh viên nộp cùng lúc).
    await getClient().spreadsheets.values.append({
      spreadsheetId: getSheetId(),
      range: `'${sheetName}'!A:F`,
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: {
        values: [
          [
            "=ROW()-1",
            asPlainText(row.hoTen),
            asPlainText(row.lop),
            row.diem,
            asPlainText(row.danhGia),
            row.thoiGianNop,
          ],
        ],
      },
    });
  });
}

export async function getAllResults(sheetName: string): Promise<ResultRow[]> {
  return withSheetsRetry(sheetName, async () => {
    const res = await getClient().spreadsheets.values.get({
      spreadsheetId: getSheetId(),
      range: `'${sheetName}'!A2:F`,
    });

    const rows = res.data.values ?? [];
    return rows
      .filter((r) => r[1])
      .map((r, i) => ({
        stt: Number(r[0]) || i + 1,
        hoTen: r[1] ?? "",
        lop: r[2] ?? "",
        diem: r[3] ?? "",
        danhGia: r[4] ?? "",
        thoiGianNop: r[5] ?? "",
      }));
  });
}

/** Tên sheet mặc định dùng cho dữ liệu tạo trước khi có tính năng tách sheet theo từng lần upload. */
export const DEFAULT_RESULTS_SHEET = LEGACY_RESULTS_SHEET;
