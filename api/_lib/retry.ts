const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const UNAVAILABLE_STATUS = new Set([500, 502, 503, 504]);
const TRANSIENT_MESSAGE =
  /overloaded|high demand|UNAVAILABLE|fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|network/i;

function statusOf(err: unknown): number {
  const e = err as { status?: number; code?: number | string };
  return Number(e?.status ?? e?.code);
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err ?? "");
}

/** Lỗi tạm thời đáng thử lại ngay: Gemini quá tải (503), lỗi máy chủ, mạng chập chờn, hoặc vượt hạn mức theo phút (429). */
export function isTransientGeminiError(err: unknown): boolean {
  return RETRYABLE_STATUS.has(statusOf(err)) || TRANSIENT_MESSAGE.test(messageOf(err));
}

/** Gemini đang không phục vụ được (quá tải/lỗi máy chủ/mạng) — khác với hết hạn mức (429) hay lỗi dữ liệu:
 * job chưa hỏng, chỉ cần gọi lại đúng bước đó sau ít lâu. */
export function isServiceUnavailableError(err: unknown): boolean {
  return UNAVAILABLE_STATUS.has(statusOf(err)) || TRANSIENT_MESSAGE.test(messageOf(err));
}

const DEFAULT_DELAYS_MS = [2000, 5000];

/** Gọi `fn`, nếu gặp lỗi tạm thời thì chờ rồi thử lại (mặc định 2 lần: sau 2s và 5s). Các lỗi này thường
 * trả về rất nhanh nên chi phí thử lại nhỏ so với giới hạn thời gian của 1 lần gọi hàm. */
export async function withRetry<T>(fn: () => Promise<T>, delaysMs: number[] = DEFAULT_DELAYS_MS): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= delaysMs.length || !isTransientGeminiError(err)) throw err;
      await new Promise((resolve) => setTimeout(resolve, delaysMs[attempt] + Math.floor(Math.random() * 500)));
    }
  }
}
