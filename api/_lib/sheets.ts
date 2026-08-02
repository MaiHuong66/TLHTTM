import { google } from "googleapis";
import type { sheets_v4 } from "googleapis";
import type { ResultRow } from "../../shared/types.js";

const RESULTS_SHEET = "Results";
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

async function ensureResultsSheetExists(): Promise<void> {
  const sheets = getClient();
  const spreadsheetId = getSheetId();

  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const existing = meta.data.sheets?.some((s) => s.properties?.title === RESULTS_SHEET);

  if (!existing) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{ addSheet: { properties: { title: RESULTS_SHEET } } }],
      },
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${RESULTS_SHEET}!A1:F1`,
      valueInputOption: "RAW",
      requestBody: { values: [RESULTS_HEADER] },
    });
  }
}

function normalizeKey(hoTen: string, lop: string): string {
  return `${hoTen.trim().toLowerCase()}|${lop.trim().toLowerCase()}`;
}

export async function hasStudentSubmitted(hoTen: string, lop: string): Promise<boolean> {
  await ensureResultsSheetExists();
  const sheets = getClient();
  const spreadsheetId = getSheetId();

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${RESULTS_SHEET}!B2:C`,
  });

  const rows = res.data.values ?? [];
  const target = normalizeKey(hoTen, lop);
  return rows.some((row) => normalizeKey(row[0] ?? "", row[1] ?? "") === target);
}

export async function appendResult(row: Omit<ResultRow, "stt">): Promise<void> {
  await ensureResultsSheetExists();
  const sheets = getClient();
  const spreadsheetId = getSheetId();

  const existing = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${RESULTS_SHEET}!A2:A`,
  });
  const nextStt = (existing.data.values?.length ?? 0) + 1;

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${RESULTS_SHEET}!A:F`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: {
      values: [[nextStt, row.hoTen, row.lop, row.diem, row.danhGia, row.thoiGianNop]],
    },
  });
}

export async function getAllResults(): Promise<ResultRow[]> {
  await ensureResultsSheetExists();
  const sheets = getClient();
  const spreadsheetId = getSheetId();

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${RESULTS_SHEET}!A2:F`,
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
