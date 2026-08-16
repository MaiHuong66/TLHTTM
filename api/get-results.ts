import type { VercelRequest, VercelResponse } from "@vercel/node";
import { verifyAuthHeader } from "./_lib/auth.js";
import { getCurrentResultsSheet } from "./_lib/kv.js";
import { DEFAULT_RESULTS_SHEET, getAllResults } from "./_lib/sheets.js";
import { friendlyErrorMessage, methodNotAllowed, sendError } from "./_lib/http.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    methodNotAllowed(res, ["GET"]);
    return;
  }

  if (!verifyAuthHeader(req.headers.authorization)) {
    sendError(res, 401, "Bạn cần đăng nhập với vai trò giảng viên.");
    return;
  }

  try {
    const sheetName = (await getCurrentResultsSheet()) ?? DEFAULT_RESULTS_SHEET;
    const results = await getAllResults(sheetName);
    res.status(200).json({ results });
  } catch (err) {
    sendError(res, 500, friendlyErrorMessage(err));
  }
}
