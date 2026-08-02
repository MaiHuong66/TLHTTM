import type { VercelResponse } from "@vercel/node";

export function sendError(res: VercelResponse, status: number, message: string): void {
  res.status(status).json({ error: message });
}

export function methodNotAllowed(res: VercelResponse, allowed: string[]): void {
  res.setHeader("Allow", allowed.join(", "));
  sendError(res, 405, "Phương thức không được hỗ trợ.");
}

export function friendlyErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    if (/GEMINI_API_KEY/i.test(err.message)) {
      return "Lỗi cấu hình: chưa thiết lập GEMINI_API_KEY trên máy chủ.";
    }
    if (/GOOGLE_SERVICE_ACCOUNT|GOOGLE_PRIVATE_KEY|GOOGLE_SHEET_ID/i.test(err.message)) {
      return "Lỗi cấu hình: chưa thiết lập thông tin Google Sheets trên máy chủ.";
    }
    if (/KV_REST_API|UPSTASH_REDIS/i.test(err.message)) {
      return "Lỗi cấu hình: chưa thiết lập thông tin lưu trữ (Upstash Redis) trên máy chủ.";
    }
    if (/quota|rate limit|429/i.test(err.message)) {
      return "Gemini API đang bị giới hạn tần suất (rate limit). Vui lòng thử lại sau ít phút.";
    }
    return err.message;
  }
  return "Đã xảy ra lỗi không xác định.";
}
