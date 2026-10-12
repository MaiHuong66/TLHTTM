import type { VercelResponse } from "@vercel/node";

export function sendError(res: VercelResponse, status: number, message: string): void {
  res.status(status).json({ error: message });
}

export function methodNotAllowed(res: VercelResponse, allowed: string[]): void {
  res.setHeader("Allow", allowed.join(", "));
  sendError(res, 405, "Phương thức không được hỗ trợ.");
}

// Lỗi từ @google/genai có message là chuỗi JSON {"error":{"message":...}} — lấy phần lý do thật để hiển thị.
function googleReason(raw: string): string {
  try {
    const msg = (JSON.parse(raw) as { error?: { message?: string } }).error?.message;
    if (msg) return msg.slice(0, 300);
  } catch {
    // không phải JSON — dùng nguyên văn
  }
  return raw.slice(0, 300);
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
    if (/PERMISSION_DENIED|API key.*(leaked|not valid|expired|suspended)|\b403\b/i.test(err.message)) {
      return `Gemini từ chối API key (403 – key bị vô hiệu hóa/bị rò rỉ, hết thanh toán hoặc bị giới hạn). Lý do từ Google: ${googleReason(err.message)}`;
    }
    if (/overloaded|high demand|UNAVAILABLE|\b503\b/i.test(err.message)) {
      return "Gemini đang quá tải tạm thời. Vui lòng thử lại sau ít phút.";
    }
    if (/PerDay|per day/i.test(err.message)) {
      return "Đã hết hạn mức gọi Gemini trong NGÀY (gói miễn phí chỉ cho ~20 lượt/model/ngày). Hãy bật thanh toán (billing) cho project Gemini hoặc đợi sang ngày mới (hạn mức đặt lại khoảng 14:00 giờ Việt Nam).";
    }
    if (/quota|rate limit|429/i.test(err.message)) {
      return "Gemini API đang bị giới hạn tần suất (rate limit). Vui lòng thử lại sau ít phút.";
    }
    return err.message;
  }
  return "Đã xảy ra lỗi không xác định.";
}
