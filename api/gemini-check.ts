import type { VercelRequest, VercelResponse } from "@vercel/node";
import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import { verifyAuthHeader } from "./_lib/auth.js";
import { sendError } from "./_lib/http.js";
import { claudeGenerate, toJsonSchema } from "./_lib/claude.js";
import { DEFAULT_LEVEL_COUNTS, cellsPerBatch, findOverlaps, generateCellQuestions, planMatrix, verifyAnswers } from "./_lib/gemini.js";
import type { AuditItem } from "./_lib/gemini.js";
import { getExamConfig, getLecture, getQuestions, setExamConfig, setQuestions } from "./_lib/kv.js";
import { blockedCells } from "./_lib/draw.js";
import type { Question } from "../shared/types.js";

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
  // ?version=1: commit đang chạy trên Vercel (để biết bản mới đã deploy xong chưa).
  if (req.query.version) {
    res.status(200).json({ commit: process.env.VERCEL_GIT_COMMIT_SHA ?? null });
    return;
  }

  // POST ?patchBank=1 (KHÔNG gọi AI): sửa ngân hàng đang dùng theo kết quả rà soát thủ công.
  // Body: { removeIds?: string[], replaceCell?: { cell, topic, questions: {id, question, options, correctAnswer}[] },
  //         addConflicts?: [string, string][] }. Câu thay thế giữ nguyên mức độ của ô. Từ chối nếu sau khi sửa có ô
  // không còn câu nào hoặc không bốc được đề đủ mọi ô mà tránh hết cặp trùng.
  if (req.query.patchBank && req.method === "POST") {
    const body = (req.body ?? {}) as {
      removeIds?: string[];
      replaceCell?: { cell: string; topic?: string; questions: Pick<Question, "id" | "question" | "options" | "correctAnswer">[] };
      addConflicts?: [string, string][];
    };
    const [questions, examConfig] = await Promise.all([getQuestions(), getExamConfig()]);
    if (!questions || !examConfig?.matrixCells) {
      sendError(res, 404, "Đề hiện tại không theo ma trận.");
      return;
    }
    let bank = questions.filter((q) => !(body.removeIds ?? []).includes(q.id));
    if (body.replaceCell) {
      const old = bank.filter((q) => q.cell === body.replaceCell!.cell);
      if (old.length === 0) {
        sendError(res, 400, `Không có ô ${body.replaceCell.cell}.`);
        return;
      }
      const level = old[0].difficulty;
      const removedIds = old.map((q) => q.id);
      bank = bank.filter((q) => q.cell !== body.replaceCell!.cell);
      for (const q of body.replaceCell.questions) {
        if (bank.some((b) => b.id === q.id)) {
          sendError(res, 400, `Trùng id ${q.id}.`);
          return;
        }
        bank.push({
          id: q.id,
          question: q.question,
          options: q.options,
          correctAnswer: q.correctAnswer,
          chapter: 1,
          difficulty: level,
          topic: body.replaceCell.topic ?? old[0].topic,
          cell: body.replaceCell.cell,
        });
      }
      body.removeIds = [...(body.removeIds ?? []), ...removedIds];
    }
    const ids = new Set(bank.map((q) => q.id));
    const seen = new Set<string>();
    const conflicts = [...(examConfig.conflicts ?? []), ...(body.addConflicts ?? [])].filter(([a, b]) => {
      const key = [a, b].sort().join("|");
      if (!ids.has(a) || !ids.has(b) || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const emptyCells = examConfig.matrixCells.filter((c) => !bank.some((q) => q.cell === c));
    const blocked = blockedCells(bank, examConfig.matrixCells, conflicts);
    if (emptyCells.length > 0 || blocked.length > 0) {
      sendError(res, 409, `Không áp dụng: ô trống ${emptyCells.join(",") || "-"}; ô không bốc được ${blocked.join(",") || "-"}.`);
      return;
    }
    await setQuestions(bank);
    examConfig.conflicts = conflicts;
    await setExamConfig(examConfig);
    res.status(200).json({ count: bank.length, conflicts: conflicts.length, removed: body.removeIds ?? [] });
    return;
  }

  // ?removeQuestion=q75: xóa 1 câu sai khỏi ngân hàng đang dùng (KHÔNG gọi AI). Chỉ xóa khi ô của câu còn câu dự phòng
  // khác, để mỗi đề vẫn đủ số câu.
  if (typeof req.query.removeQuestion === "string") {
    const id = req.query.removeQuestion.trim();
    const [questions, examConfig] = await Promise.all([getQuestions(), getExamConfig()]);
    const target = questions?.find((q) => q.id === id);
    if (!questions || !target) {
      sendError(res, 404, `Không có câu ${id} trong ngân hàng.`);
      return;
    }
    const sameCell = questions.filter((q) => q.cell && q.cell === target.cell && q.id !== id);
    if (target.cell && sameCell.length === 0) {
      sendError(res, 409, `Câu ${id} là câu cuối cùng của ô ${target.cell}, xóa sẽ làm đề thiếu câu.`);
      return;
    }
    await setQuestions(questions.filter((q) => q.id !== id));
    if (examConfig?.conflicts) {
      examConfig.conflicts = examConfig.conflicts.filter(([a, b]) => a !== id && b !== id);
      await setExamConfig(examConfig);
    }
    res.status(200).json({ removed: id, cell: target.cell, remainingInCell: sameCell.map((q) => q.id) });
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
      questions: (questions ?? []).map((q) => ({
        id: q.id,
        difficulty: q.difficulty,
        topic: q.topic,
        cell: q.cell,
        question: q.question,
        options: q.options,
        correctAnswer: q.correctAnswer,
      })),
    });
    return;
  }

  // ?audit=overlap | ?audit=verify&from=0: chạy thử bước kiểm định trên ngân hàng đang lưu, KHÔNG sửa gì.
  if (req.query.audit) {
    const [questions, lecture] = await Promise.all([getQuestions(), getLecture()]);
    const items: AuditItem[] = (questions ?? []).map((q) => ({
      key: q.id,
      cell: q.cell ?? q.id,
      topic: q.topic ?? "",
      level: q.difficulty,
      question: q.question,
      options: q.options,
      correctAnswer: q.correctAnswer,
    }));
    const t0 = Date.now();
    try {
      if (req.query.audit === "verify") {
        const from = Number(req.query.from) || 0;
        const batch = items.slice(from, from + 20);
        const text = (lecture?.sections ?? []).map((s) => `${s.heading}\n${s.content}\n${s.examples.join("\n")}`).join("\n\n");
        const checks = await verifyAnswers({ pastedText: text, extractedTexts: [], uploadedFiles: [] }, batch);
        const flagged = batch
          .filter((q) => !checks[q.key] || checks[q.key].ambiguous || checks[q.key].answer !== q.correctAnswer)
          .map((q) => ({ id: q.key, key: q.correctAnswer, check: checks[q.key] ?? null, question: q.question }));
        res.status(200).json({ ms: Date.now() - t0, checked: batch.length, flagged });
      } else {
        const topic = typeof req.query.topic === "string" ? req.query.topic : "";
        const pairs = await findOverlaps(topic ? items.filter((i) => i.topic.includes(topic)) : items);
        let saved: number | undefined;
        if (req.query.save && !topic) {
          // Rà lại đề đang dùng: lưu thêm các cặp trùng mới vào ExamConfig.conflicts để lúc bốc đề tránh.
          const examConfig = await getExamConfig();
          if (examConfig) {
            const all = [...(examConfig.conflicts ?? []), ...pairs];
            const seen = new Set<string>();
            examConfig.conflicts = all.filter(([a, b]) => {
              const id = [a, b].sort().join("|");
              if (seen.has(id)) return false;
              seen.add(id);
              return true;
            });
            await setExamConfig(examConfig);
            saved = examConfig.conflicts.length;
          }
        }
        res.status(200).json({ ms: Date.now() - t0, pairs, saved });
      }
    } catch (err) {
      res.status(200).json({ ms: Date.now() - t0, error: err instanceof Error ? err.message.slice(0, 800) : String(err) });
    }
    return;
  }

  // ?pipeline=1: chạy thử bước lập ma trận + soạn câu cho 1 nhóm ô trên bài giảng hiện có, KHÔNG lưu gì.
  if (req.query.pipeline) {
    const lecture = await getLecture();
    if (!lecture) {
      sendError(res, 404, "Chưa có bài giảng để chạy thử.");
      return;
    }
    const text = lecture.sections.map((s) => `${s.heading}\n${s.content}\n${s.examples.join("\n")}`).join("\n\n");
    const doc = { pastedText: text, extractedTexts: [], uploadedFiles: [] };
    const variants = Number(req.query.variants) || 3;
    const t0 = Date.now();
    try {
      const matrix = await planMatrix(doc, DEFAULT_LEVEL_COUNTS);
      const planMs = Date.now() - t0;
      const from = Math.min(Number(req.query.from) || 0, Math.max(0, matrix.cells.length - 1));
      const batch = matrix.cells.slice(from, from + cellsPerBatch(variants)).map((c) => c.id);
      const rejected: { reason: string; item: unknown }[] = [];
      const questions = await generateCellQuestions(doc, matrix, batch, variants, (reason, item) =>
        rejected.push({ reason, item })
      );
      res.status(200).json({ planMs, batchMs: Date.now() - t0 - planMs, batch, matrix, questions, rejected });
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
