import type { VercelRequest, VercelResponse } from "@vercel/node";
import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import { verifyAuthHeader } from "./_lib/auth.js";
import { sendError } from "./_lib/http.js";
import { claudeGenerate, toJsonSchema } from "./_lib/claude.js";
import { QUESTIONS_PER_BATCH, generateQuestionsForPoints, planContentPoints } from "./_lib/gemini.js";
import { getExamConfig, getLecture, getQuestions } from "./_lib/kv.js";

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
  // ?bank=1: xem đề đang lưu (số câu, phân bổ mức độ, cấu hình) để chẩn đoán.
  if (req.query.bank) {
    const [questions, examConfig] = await Promise.all([getQuestions(), getExamConfig()]);
    const levels: Record<string, number> = {};
    for (const q of questions ?? []) levels[q.difficulty] = (levels[q.difficulty] ?? 0) + 1;
    res.status(200).json({
      count: questions?.length ?? 0,
      levels,
      examConfig,
      questions: (questions ?? []).map((q) => ({ id: q.id, difficulty: q.difficulty, question: q.question })),
    });
    return;
  }

  // ?pipeline=1: chạy thử bước lập danh sách nội dung + 1 lô câu hỏi trên bài giảng hiện có, KHÔNG lưu gì.
  if (req.query.pipeline) {
    const lecture = await getLecture();
    if (!lecture) {
      sendError(res, 404, "Chưa có bài giảng để chạy thử.");
      return;
    }
    const text = lecture.sections.map((s) => `${s.heading}\n${s.content}\n${s.examples.join("\n")}`).join("\n\n");
    const doc = { pastedText: text, extractedTexts: [], uploadedFiles: [] };
    const total = Number(req.query.total) || 30;
    const t0 = Date.now();
    try {
      const plan = await planContentPoints(doc, total);
      const planMs = Date.now() - t0;
      const from = Math.min(Number(req.query.from) || 0, Math.max(0, plan.length - 1));
      const batch = plan.slice(from, from + QUESTIONS_PER_BATCH).map((_, i) => from + i);
      const rejected: { reason: string; item: unknown }[] = [];
      const questions = await generateQuestionsForPoints(doc, plan, batch, (reason, item) => rejected.push({ reason, item }));
      res.status(200).json({ planMs, batchMs: Date.now() - t0 - planMs, batch, plan, questions, rejected });
    } catch (err) {
      res.status(200).json({ ms: Date.now() - t0, error: err instanceof Error ? err.message.slice(0, 800) : String(err) });
    }
    return;
  }

  // ?claude=1: kiểm tra nhanh Claude API (gọi văn bản và gọi có schema JSON) và đo độ trễ.
  if (req.query.claude) {
    const run = async (label: string, schema?: Record<string, unknown>) => {
      const t0 = Date.now();
      try {
        const r = await claudeGenerate({
          messages: [{ role: "user", parts: [{ text: "Trả lời đúng 1 từ: ok. Nếu có công cụ thì gọi với items là mảng 2 chuỗi." }] }],
          schema,
          maxTokens: 300,
        });
        return { label, ms: Date.now() - t0, text: r.text.slice(0, 60), json: r.json, truncated: r.truncated };
      } catch (err) {
        return { label, ms: Date.now() - t0, error: err instanceof Error ? err.message.slice(0, 600) : String(err) };
      }
    };
    const results = [
      await run("text"),
      await run("json-array", toJsonSchema({ type: "ARRAY", items: { type: "STRING" } })),
    ];
    res.status(200).json({ provider: process.env.AI_PROVIDER ?? null, results });
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
