import type { VercelRequest, VercelResponse } from "@vercel/node";
import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import { verifyAuthHeader } from "./_lib/auth.js";
import { sendError } from "./_lib/http.js";

// Endpoint chẩn đoán (chỉ giảng viên): liệt kê model mà API key hiện tại thấy được và thử gọi nhanh
// từng model ứng viên, để biết model nào dùng được. Không trả về API key.
export const config = { maxDuration: 60 };

const CANDIDATES = [
  "gemini-3.8-flash",
  "gemini-3-flash",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-flash-latest",
  "gemini-flash-lite-latest",
];

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!verifyAuthHeader(req.headers.authorization)) {
    sendError(res, 401, "Bạn cần đăng nhập với vai trò giảng viên.");
    return;
  }
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    sendError(res, 500, "Thiếu GEMINI_API_KEY.");
    return;
  }
  const ai = new GoogleGenAI({ apiKey });

  if (req.query.bench) {
    const model = typeof req.query.model === "string" ? req.query.model : "gemini-3.8-flash";
    const prompt =
      "Viết một bài giảng khoảng 500 từ về mạng máy tính (mô hình OSI, TCP/IP, HTTP), chia thành 4 mục có tiêu đề, có ví dụ.";
    const run = async (label: string, config?: Record<string, unknown>) => {
      const t0 = Date.now();
      try {
        const r = await ai.models.generateContent({ model, contents: prompt, config });
        return { label, ms: Date.now() - t0, chars: (r.text ?? "").length, usage: r.usageMetadata };
      } catch (err) {
        return { label, ms: Date.now() - t0, error: err instanceof Error ? err.message.slice(0, 1200) : String(err) };
      }
    };
    const results = await Promise.all([
      run("default"),
      run("minimal", { thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL } }),
      run("low", { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } }),
    ]);
    res.status(200).json({ model, results });
    return;
  }

  let listed: string[] | string = [];
  try {
    const names: string[] = [];
    const pager = await ai.models.list({ config: { pageSize: 100 } });
    for await (const m of pager) {
      if (m.name && /flash|pro/i.test(m.name)) names.push(m.name.replace(/^models\//, ""));
    }
    listed = names;
  } catch (err) {
    listed = `list lỗi: ${err instanceof Error ? err.message.slice(0, 300) : String(err)}`;
  }

  const fromQuery = typeof req.query.models === "string" ? req.query.models.split(",").filter(Boolean) : [];
  const tried = await Promise.all(
    (fromQuery.length ? fromQuery : CANDIDATES).map(async (model) => {
      try {
        const r = await ai.models.generateContent({ model, contents: "Trả lời đúng 1 từ: ok" });
        return { model, ok: true, text: (r.text ?? "").slice(0, 40) };
      } catch (err) {
        return { model, ok: false, error: err instanceof Error ? err.message.slice(0, 300) : String(err) };
      }
    })
  );

  res.status(200).json({ configuredModel: process.env.GEMINI_MODEL ?? null, listed, tried });
}
