import { GoogleGenAI, ThinkingLevel, Type } from "@google/genai";
import type { ContentListUnion, Part } from "@google/genai";
import type { AnswerKey, ChatMessage, Difficulty, Lecture, Question } from "../../shared/types.js";
import { withRetry } from "./retry.js";
import { claudeGenerate, claudeUploadFiles, toJsonSchema } from "./claude.js";
import type { ClaudeMessage, ClaudePart } from "./claude.js";

// Google ngừng cấp gemini-2.5-flash cho tài khoản mới (404 NOT_FOUND). gemini-3.5-flash đã được kiểm tra chạy ổn định
// (gemini-3.8-flash hay bị 503 quá tải); có thể đổi bằng biến môi trường GEMINI_MODEL mà không cần sửa code.
const MODEL = process.env.GEMINI_MODEL?.trim() || "gemini-3.5-flash";

let client: GoogleGenAI | null = null;

/** generateContent có tự thử lại khi Gemini quá tải/lỗi tạm thời (503, 429 theo phút, lỗi mạng...). */
function generate(ai: GoogleGenAI, params: Parameters<GoogleGenAI["models"]["generateContent"]>[0]) {
  // Thinking tối thiểu: các tác vụ ở đây (đọc tài liệu, sinh JSON) không cần suy luận sâu, và giảm gần một nửa
  // thời gian chờ — quan trọng vì mỗi lần gọi phải xong trong 60s của Vercel.
  const withThinking = { ...params, config: { thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL }, ...params.config } };
  return withRetry(() => ai.models.generateContent(withThinking));
}

/** Nhà cung cấp AI: AI_PROVIDER=claude|gemini; nếu không đặt thì dùng Claude khi có ANTHROPIC_API_KEY, ngược lại Gemini. */
export function usingClaude(): boolean {
  const provider = process.env.AI_PROVIDER?.trim().toLowerCase();
  if (provider === "claude") return true;
  if (provider === "gemini") return false;
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

interface LlmCall {
  /** Câu lệnh chính (kèm tài liệu nếu có `doc`). */
  instruction?: string;
  doc?: DocumentInput;
  system?: string;
  /** Lịch sử hội thoại (dùng cho chatbot) thay cho `instruction`. */
  history?: ChatMessage[];
  /** Schema kiểu Gemini (Type.OBJECT/ARRAY...) — nếu có, trả về JSON đúng cấu trúc trong `json`. */
  schema?: unknown;
  maxOutputTokens?: number;
}

interface LlmResult {
  text: string;
  json: unknown;
  truncated: boolean;
}

function buildClaudeDocParts(doc: DocumentInput): ClaudePart[] {
  const parts: ClaudePart[] = [];
  if (doc.pastedText.trim()) {
    parts.push({ text: `--- Nội dung do giảng viên dán trực tiếp ---\n${doc.pastedText.trim()}` });
  }
  for (const f of doc.extractedTexts) {
    parts.push({ text: `--- Nội dung trích xuất từ file "${f.name}" ---\n${f.text}` });
  }
  for (const f of doc.uploadedFiles) {
    parts.push({ file: f });
  }
  // Điểm cache nằm sau tài liệu: nhiều bước liên tiếp dùng chung đúng phần này nên được đọc từ cache.
  if (parts.length > 0) parts.push({ cacheBreakpoint: true });
  return parts;
}

/** Gọi AI (Claude hoặc Gemini tùy cấu hình) và trả về kết quả theo 1 dạng chung. */
async function llm(call: LlmCall): Promise<LlmResult> {
  if (usingClaude()) {
    const messages: ClaudeMessage[] = [];
    if (call.history) {
      // Claude yêu cầu các lượt xen kẽ user/assistant và bắt đầu bằng user — gộp các lượt liên tiếp cùng vai.
      for (const m of call.history) {
        const role = m.role === "model" ? "assistant" : "user";
        const last = messages[messages.length - 1];
        if (last && last.role === role) last.parts.push({ text: `\n${m.text}` });
        else messages.push({ role, parts: [{ text: m.text }] });
      }
      while (messages.length > 0 && messages[0].role !== "user") messages.shift();
    } else {
      messages.push({
        role: "user",
        parts: [...(call.doc ? buildClaudeDocParts(call.doc) : []), { text: call.instruction ?? "" }],
      });
    }
    const result = await claudeGenerate({
      system: call.system,
      messages,
      schema: call.schema ? toJsonSchema(call.schema) : undefined,
      maxTokens: call.maxOutputTokens ?? 8192,
    });
    if (call.schema && (result.truncated || result.json === undefined)) {
      throw new Error("AI trả về kết quả bị cắt giữa chừng hoặc không đúng cấu trúc. Vui lòng thử lại.");
    }
    return result;
  }

  const ai = getClient();
  const contents: ContentListUnion = call.history
    ? call.history.map((m) => ({ role: m.role, parts: [{ text: m.text }] }))
    : [
        {
          role: "user",
          parts: [{ text: call.instruction ?? "" }, ...(call.doc ? buildDocumentParts(call.doc) : [])],
        },
      ];
  const response = await generate(ai, {
    model: MODEL,
    contents,
    config: {
      ...(call.system ? { systemInstruction: call.system } : {}),
      ...(call.schema
        ? { responseMimeType: "application/json", responseSchema: call.schema as never }
        : call.maxOutputTokens
          ? { maxOutputTokens: call.maxOutputTokens }
          : {}),
    },
  });
  return {
    text: response.text?.trim() ?? "",
    json: call.schema ? JSON.parse(extractJsonText(response.text)) : undefined,
    truncated: response.candidates?.[0]?.finishReason === "MAX_TOKENS",
  };
}

function getClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "Thiếu biến môi trường GEMINI_API_KEY. Vui lòng cấu hình trong Vercel Environment Variables."
    );
  }
  if (!client) {
    client = new GoogleGenAI({ apiKey });
  }
  return client;
}

export interface UploadedFileRef {
  name: string;
  mimeType: string;
  uri: string;
}

export interface DocumentInput {
  pastedText: string;
  extractedTexts: { name: string; text: string }[];
  uploadedFiles: UploadedFileRef[];
}

/**
 * Upload từng file lên Gemini Files API đúng 1 lần và chờ tới khi sẵn sàng (ACTIVE),
 * để 5 lệnh generateContent sau đó (1 bài giảng + 4 lô câu hỏi) chỉ cần tham chiếu nhẹ
 * (fileUri) thay vì mỗi lệnh đều gửi lại toàn bộ base64 — tránh crash do quá tải bộ nhớ
 * khi 5 request chạy song song.
 */
export async function uploadFilesToAi(
  files: { name: string; mimeType: string; base64: string }[]
): Promise<UploadedFileRef[]> {
  if (files.length === 0) return [];
  // Với Claude, `uri` lưu file_id của Claude Files API.
  if (usingClaude()) return claudeUploadFiles(files);
  const ai = getClient();

  return Promise.all(
    files.map(async (f) => {
      const buffer = Buffer.from(f.base64, "base64");
      const blob = new Blob([buffer], { type: f.mimeType });
      const uploaded = await withRetry(() =>
        ai.files.upload({
          file: blob,
          config: { mimeType: f.mimeType, displayName: f.name },
        })
      );
      return waitForFileActive(ai, uploaded, f.name);
    })
  );
}

async function waitForFileActive(
  ai: GoogleGenAI,
  file: { name?: string; uri?: string; mimeType?: string; state?: string },
  displayName: string
): Promise<UploadedFileRef> {
  let current = file;
  let attempts = 0;
  while (current.state === "PROCESSING" && attempts < 20) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    if (!current.name) break;
    current = await ai.files.get({ name: current.name });
    attempts++;
  }

  if (current.state === "FAILED") {
    throw new Error(`Gemini xử lý file "${displayName}" thất bại.`);
  }
  if (!current.uri || !current.mimeType) {
    throw new Error(`Không lấy được thông tin file "${displayName}" đã upload lên Gemini.`);
  }

  return { name: current.name ?? displayName, mimeType: current.mimeType, uri: current.uri };
}

function buildDocumentParts(doc: DocumentInput): Part[] {
  const parts: Part[] = [];

  if (doc.pastedText.trim()) {
    parts.push({ text: `--- Nội dung do giảng viên dán trực tiếp ---\n${doc.pastedText.trim()}` });
  }

  for (const f of doc.extractedTexts) {
    parts.push({ text: `--- Nội dung trích xuất từ file "${f.name}" ---\n${f.text}` });
  }

  for (const f of doc.uploadedFiles) {
    parts.push({ fileData: { fileUri: f.uri, mimeType: f.mimeType } });
  }

  return parts;
}

const lectureSchema = {
  type: Type.OBJECT,
  properties: {
    title: { type: Type.STRING, description: "Tiêu đề bài giảng" },
    sections: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          heading: { type: Type.STRING },
          content: { type: Type.STRING, description: "Nội dung chi tiết, dễ hiểu, trình bày khoa học" },
          examples: { type: Type.ARRAY, items: { type: Type.STRING }, description: "Ví dụ minh họa cụ thể" },
          notes: { type: Type.ARRAY, items: { type: Type.STRING }, description: "Lưu ý quan trọng, có thể rỗng" },
        },
        required: ["heading", "content", "examples", "notes"],
      },
    },
    summary: { type: Type.STRING, description: "Tóm tắt cuối bài giúp sinh viên nắm ý chính" },
  },
  required: ["title", "sections", "summary"],
};

export async function generateLecture(doc: DocumentInput): Promise<Omit<Lecture, "updatedAt">> {
  const result = await llm({
    doc,
    schema: lectureSchema,
    maxOutputTokens: 12000,
    instruction:
              "Bạn là một giảng viên đại học giàu kinh nghiệm. Đọc toàn bộ tài liệu bên dưới và biên soạn thành " +
              "một bài giảng khoa học, dễ hiểu cho sinh viên. Bài giảng gồm tối đa 6-8 phần (sections) bao quát " +
              "các ý chính của tài liệu, mỗi phần trình bày súc tích (khoảng 120-200 từ nội dung), kèm 1-2 ví dụ " +
              "minh họa cụ thể và lưu ý nếu có. Cuối bài giảng có phần tóm tắt ngắn gọn giúp sinh viên nắm bài. " +
              "Ưu tiên đầy đủ ý quan trọng nhưng diễn đạt cô đọng, không lan man. Chỉ dùng thông tin có trong tài " +
              "liệu, không bịa thêm kiến thức ngoài tài liệu. Trả lời bằng tiếng Việt.",
  });

  const parsed = result.json as Omit<Lecture, "updatedAt"> | undefined;
  if (!parsed || !parsed.title || !Array.isArray(parsed.sections) || parsed.sections.length === 0) {
    throw new Error("AI trả về bài giảng không hợp lệ.");
  }
  return parsed;
}

/** 4 mức độ nhận thức dùng khi ra đề, theo thứ tự từ thấp tới cao. */
export const COGNITIVE_LEVELS: Difficulty[] = ["Nhận biết", "Thông hiểu", "Vận dụng", "Vận dụng cao"];

/** Số câu mỗi mức trong 1 đề mặc định (theo thứ tự COGNITIVE_LEVELS): 8 NB, 7 TH, 10 VD, 5 VDC = 30 câu. */
export const DEFAULT_LEVEL_COUNTS = [8, 7, 10, 5];

const LEVEL_GUIDE =
  `"Nhận biết": nhớ lại, nhận ra đúng khái niệm, định nghĩa, sự kiện, thuật ngữ có trong tài liệu. ` +
  `"Thông hiểu": giải thích, phân biệt, so sánh, diễn giải ý nghĩa, nhận ra ví dụ đúng của một khái niệm. ` +
  `"Vận dụng": áp dụng kiến thức vào một tình huống cụ thể, quen thuộc để giải quyết vấn đề hoặc chọn cách làm đúng. ` +
  `"Vận dụng cao": xử lý tình huống mới, phức tạp, cần phân tích, đánh giá hoặc kết hợp nhiều bước suy luận.`;

/** Một lần gọi AI soạn tối đa ngần này câu — đủ nhỏ để luôn xong trong giới hạn 60s của Vercel. */
const MAX_QUESTIONS_PER_CALL = 9;

/** Số ô của ma trận soạn trong 1 bước, sao cho (số ô × số câu mỗi ô) không vượt MAX_QUESTIONS_PER_CALL. */
export function cellsPerBatch(variantsPerCell: number): number {
  return Math.max(1, Math.floor(MAX_QUESTIONS_PER_CALL / variantsPerCell));
}

/** 1 ô của ma trận đề = (chủ đề con × mức độ). Mỗi đề bốc đúng 1 câu từ mỗi ô. */
export interface MatrixCell {
  /** "{vị trí chủ đề}-{vị trí mức độ}", vd "3-2" = chủ đề thứ 4, mức Vận dụng. */
  id: string;
  topic: number;
  level: Difficulty;
  /** Nội dung trọng tâm cụ thể ô này hỏi (khác các ô khác cùng chủ đề). Rỗng nếu ô được hệ thống tự thêm. */
  focus: string;
}

export interface QuestionMatrix {
  topics: { name: string; description: string }[];
  cells: MatrixCell[];
}

function normalizeText(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function cellId(topic: number, levelIdx: number): string {
  return `${topic}-${levelIdx}`;
}

/** Số chủ đề con: bằng số câu của mức nhiều nhất, để mỗi mức có đủ chủ đề khác nhau (mỗi chủ đề tối đa 1 ô/mức). */
export function topicCount(levelCounts: number[]): number {
  return Math.max(1, ...levelCounts);
}

/**
 * Đưa ma trận AI đề xuất về đúng ràng buộc: mỗi chủ đề tối đa 1 ô mỗi mức, số ô mỗi mức đúng `levelCounts`, và số ô
 * giữa các chủ đề chênh nhau không quá 1 (rải đều). Giữ đề xuất của AI nhiều nhất có thể (AI biết chủ đề nào hợp
 * mức nào); ô hệ thống phải tự thêm/chuyển thì để trống trọng tâm.
 */
export function repairMatrix(
  topics: { name: string; description: string; cells: { level: string; focus: string }[] }[],
  levelCounts: number[]
): QuestionMatrix {
  const n = topics.length;
  // has[t][l] = trọng tâm của ô (t, l) nếu ô tồn tại, undefined nếu không.
  const has: (string | undefined)[][] = topics.map(() => COGNITIVE_LEVELS.map(() => undefined));
  topics.forEach((t, ti) => {
    for (const c of t.cells ?? []) {
      const li = COGNITIVE_LEVELS.indexOf(c?.level as Difficulty);
      if (li >= 0 && has[ti][li] === undefined) has[ti][li] = typeof c.focus === "string" ? c.focus.trim() : "";
    }
  });
  const load = (ti: number) => has[ti].filter((f) => f !== undefined).length;

  COGNITIVE_LEVELS.forEach((_, li) => {
    const target = Math.min(levelCounts[li] ?? 0, n);
    const owners = () => has.map((row, ti) => (row[li] !== undefined ? ti : -1)).filter((ti) => ti >= 0);
    // Thừa: bỏ ô ở chủ đề đang nhiều ô nhất.
    while (owners().length > target) {
      const victim = owners().sort((a, b) => load(b) - load(a) || b - a)[0];
      has[victim][li] = undefined;
    }
    // Thiếu: thêm vào chủ đề chưa có mức này và đang ít ô nhất.
    while (owners().length < target) {
      const candidates = has.map((_, ti) => ti).filter((ti) => has[ti][li] === undefined);
      const pick = candidates.sort((a, b) => load(a) - load(b) || a - b)[0];
      has[pick][li] = "";
    }
  });

  // Rải đều: chuyển 1 ô cùng mức từ chủ đề nhiều ô sang chủ đề ít ô hơn ít nhất 2 (không đổi số ô mỗi mức).
  for (let guard = 0; guard < 200; guard++) {
    const order = has.map((_, ti) => ti).sort((a, b) => load(b) - load(a));
    const heavy = order[0];
    const light = order[order.length - 1];
    if (load(heavy) - load(light) < 2) break;
    const li = COGNITIVE_LEVELS.findIndex((_, l) => has[heavy][l] !== undefined && has[light][l] === undefined);
    if (li < 0) break;
    has[heavy][li] = undefined;
    has[light][li] = "";
  }

  const cells: MatrixCell[] = [];
  has.forEach((row, ti) =>
    row.forEach((focus, li) => {
      if (focus !== undefined) cells.push({ id: cellId(ti, li), topic: ti, level: COGNITIVE_LEVELS[li], focus });
    })
  );
  return {
    topics: topics.map((t, i) => ({
      name: t.name?.trim() || `Chủ đề ${i + 1}`,
      description: t.description?.trim() ?? "",
    })),
    cells,
  };
}

function matrixPlanSchema(numTopics: number) {
  const slots = Array.from({ length: numTopics }, (_, i) => `chu_de_${i + 1}`);
  const topicSchema = {
    type: Type.OBJECT,
    properties: {
      name: { type: Type.STRING, description: "Tên ngắn gọn của chủ đề con" },
      description: { type: Type.STRING, description: "Phạm vi kiến thức của chủ đề con trong tài liệu (1-2 câu)" },
      cells: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            level: { type: Type.STRING, enum: COGNITIVE_LEVELS },
            focus: {
              type: Type.STRING,
              description: "Nội dung trọng tâm cụ thể sẽ hỏi ở ô này, khác các ô khác của cùng chủ đề",
            },
          },
          required: ["level", "focus"],
        },
      },
    },
    required: ["name", "description", "cells"],
  };
  // Mỗi chủ đề 1 ô bắt buộc riêng (không dùng mảng) để AI luôn trả đủ số chủ đề.
  return { type: Type.OBJECT, properties: Object.fromEntries(slots.map((s) => [s, topicSchema])), required: slots };
}

/** Bước 1: chia tài liệu thành các chủ đề con và lập ma trận đề (chủ đề con × mức độ), mỗi ô có trọng tâm riêng. */
export async function planMatrix(doc: DocumentInput, levelCounts: number[]): Promise<QuestionMatrix> {
  const numTopics = topicCount(levelCounts);
  const total = levelCounts.reduce((a, b) => a + b, 0);
  const quota = COGNITIVE_LEVELS.map((l, i) => `${levelCounts[i]} ô "${l}"`).join(", ");
  const perTopic = total / numTopics;

  const instruction =
    `Bạn là chuyên gia xây dựng ma trận đề kiểm tra trắc nghiệm. Đọc toàn bộ tài liệu bên dưới và:\n` +
    `1) Chia nội dung tài liệu thành ĐÚNG ${numTopics} chủ đề con (ghi vào chu_de_1 ... chu_de_${numTopics}): mỗi chủ đề ` +
    `là một mảng kiến thức riêng (ví dụ: phần cứng, mạng máy tính, bản quyền, an toàn thông tin...), các chủ đề không ` +
    `chồng lấn nhau và cùng nhau bao quát toàn bộ tài liệu.\n` +
    `2) Lập ma trận đề ${total} câu: mỗi ô là (chủ đề con × mức độ), mỗi đề sẽ có đúng 1 câu cho mỗi ô. Tổng trên tất cả ` +
    `chủ đề phải có đúng: ${quota}. Mỗi chủ đề có TỐI ĐA 1 ô cho mỗi mức độ và có khoảng ${Number.isInteger(perTopic) ? perTopic : `${Math.floor(perTopic)}-${Math.ceil(perTopic)}`} ô. ` +
    `Chọn mức độ phù hợp với nội dung của chủ đề (chủ đề có quy trình, quy tắc, tình huống thực tế thì hợp với ` +
    `"Vận dụng"/"Vận dụng cao"). ${LEVEL_GUIDE}\n` +
    `3) Với mỗi ô, ghi "focus" là nội dung trọng tâm CỤ THỂ sẽ hỏi. Các ô trong cùng một chủ đề phải có trọng tâm ` +
    `KHÁC NHAU, không trùng, không bao hàm nhau, để đề không hỏi lặp một nội dung.\n` +
    `Chỉ dùng nội dung có trong tài liệu. Viết bằng tiếng Việt.`;

  const result = await llm({ instruction, doc, schema: matrixPlanSchema(numTopics), maxOutputTokens: 6000 });
  const parsed = result.json as Record<string, { name: string; description: string; cells: { level: string; focus: string }[] }>;
  if (!parsed || typeof parsed !== "object") {
    throw new Error("AI trả về ma trận đề không hợp lệ.");
  }
  const topics = Array.from({ length: numTopics }, (_, i) => parsed[`chu_de_${i + 1}`] ?? { name: "", description: "", cells: [] });
  return repairMatrix(topics, levelCounts);
}

const questionSchema = {
  type: Type.OBJECT,
  properties: {
    question: { type: Type.STRING },
    optionA: { type: Type.STRING },
    optionB: { type: Type.STRING },
    optionC: { type: Type.STRING },
    optionD: { type: Type.STRING },
    correctAnswer: { type: Type.STRING, enum: ["A", "B", "C", "D"] },
  },
  required: ["question", "optionA", "optionB", "optionC", "optionD", "correctAnswer"],
};

/** Ô bắt buộc riêng cho từng câu ("o1_cau1", "o1_cau2", "o2_cau1"...) thay vì 1 mảng: với chế độ strict, AI buộc phải
 * trả đủ từng câu và đủ từng trường (với mảng, AI có lúc trả ít câu hơn số được giao). */
function slotName(cellPos: number, variant: number): string {
  return `o${cellPos + 1}_cau${variant + 1}`;
}

function questionBatchSchema(cellCount: number, variants: number) {
  const slots: string[] = [];
  for (let c = 0; c < cellCount; c++) for (let v = 0; v < variants; v++) slots.push(slotName(c, v));
  return {
    type: Type.OBJECT,
    properties: Object.fromEntries(slots.map((name) => [name, questionSchema])),
    required: slots,
  };
}

export interface RawQuestion {
  question: string;
  optionA: string;
  optionB: string;
  optionC: string;
  optionD: string;
  correctAnswer: AnswerKey;
  difficulty: Difficulty;
}

const ANSWER_KEYS: AnswerKey[] = ["A", "B", "C", "D"];

/** Bước 2: soạn `variants` câu dự phòng cho mỗi ô được giao (`cellIds`). Các câu của cùng 1 ô thay thế được cho nhau
 * (mỗi đề chỉ bốc 1), nên cùng trọng tâm và mức độ nhưng khác cách hỏi/tình huống. Câu không hợp lệ bị bỏ. */
export async function generateCellQuestions(
  doc: DocumentInput,
  matrix: QuestionMatrix,
  cellIds: string[],
  variants: number,
  onReject: (reason: string, item: unknown) => void = () => undefined
): Promise<Record<string, RawQuestion[]>> {
  const cells = cellIds
    .map((id) => matrix.cells.find((c) => c.id === id))
    .filter((c): c is MatrixCell => !!c);
  if (cells.length === 0) return {};

  const describe = (c: MatrixCell, k: number) => {
    const topic = matrix.topics[c.topic];
    const siblings = matrix.cells
      .filter((o) => o.topic === c.topic && o.id !== c.id && o.focus)
      .map((o) => `"${o.focus}"`);
    return (
      `Ô ${k} — chủ đề: ${topic.name}${topic.description ? ` (${topic.description})` : ""}; mức độ: ${c.level}; ` +
      (c.focus
        ? `trọng tâm: ${c.focus}.`
        : `trọng tâm: tự chọn 1 nội dung cụ thể của chủ đề này phù hợp mức độ.`) +
      (siblings.length ? ` Không hỏi vào các trọng tâm thuộc ô khác của chủ đề: ${siblings.join("; ")}.` : "") +
      ` Ghi vào ${Array.from({ length: variants }, (_, v) => slotName(k - 1, v)).join(", ")}.`
    );
  };

  const instruction =
    `Bạn là chuyên gia ra đề kiểm tra trắc nghiệm. Dựa HOÀN TOÀN vào tài liệu bên dưới, soạn câu hỏi cho các ô ` +
    `của ma trận đề sau, mỗi ô ${variants} câu:\n${cells.map((c, i) => describe(c, i + 1)).join("\n")}\n\n` +
    `Yêu cầu:\n` +
    `- ${variants > 1 ? `${variants} câu của cùng một ô là các câu DỰ PHÒNG thay thế cho nhau (mỗi đề chỉ bốc 1 câu ` +
      `của ô): cùng kiểm tra trọng tâm của ô và đúng mức độ, nhưng khác nhau rõ rệt về cách hỏi, tình huống hoặc ` +
      `ví dụ — không được là cùng một câu chỉ đổi vài chữ.\n- ` : ""}` +
    `Đúng mức độ của ô. ${LEVEL_GUIDE}\n` +
    `- Câu "Vận dụng" và "Vận dụng cao" BẮT BUỘC đặt trong một tình huống cụ thể (một người, một tổ chức, một sự ` +
    `việc...) để sinh viên phải áp dụng hoặc phân tích kiến thức; không được chỉ hỏi lại định nghĩa hay đặc điểm.\n` +
    `- Câu của một ô không được hỏi vào trọng tâm của ô khác.\n` +
    `- Có đúng 4 phương án, chỉ 1 phương án đúng; các phương án sai phải hợp lý, dễ gây nhầm với người chưa nắm ` +
    `bài, cùng dạng và độ dài tương đương phương án đúng. Phương án đúng KHÔNG được là phương án dài nhất/chi tiết ` +
    `nhất một cách dễ nhận ra, và không chép nguyên văn câu trong tài liệu trong khi các phương án sai lại diễn đạt khác.\n` +
    `- Vị trí phương án đúng (A, B, C, D) phân bố đa dạng.\n` +
    `- Thứ tự các phương án sẽ bị XÁO TRỘN khi thi, nên TUYỆT ĐỐI KHÔNG dùng phương án kiểu "Tất cả các đáp án ` +
    `trên", "Cả A và B", "Không có đáp án nào đúng", và không nhắc tới chữ cái A, B, C, D trong câu hỏi hay phương án ` +
    `(nếu tình huống cần đặt tên các lựa chọn thì dùng "cách 1", "cách 2" hoặc gọi tên cụ thể, không dùng "phương án A").\n` +
    `- Câu hỏi rõ ràng, không mơ hồ, viết bằng tiếng Việt.`;

  const result = await llm({
    instruction,
    doc,
    schema: questionBatchSchema(cells.length, variants),
    maxOutputTokens: 10000,
  });
  const parsed = result.json as Record<string, Omit<RawQuestion, "difficulty"> | undefined> | undefined;
  if (!parsed || typeof parsed !== "object") {
    throw new Error("AI trả về câu hỏi không hợp lệ.");
  }

  const byCell: Record<string, RawQuestion[]> = {};
  cells.forEach((cell, ci) => {
    byCell[cell.id] = [];
    for (let v = 0; v < variants; v++) {
      const q = parsed[slotName(ci, v)];
      const options = [q?.optionA, q?.optionB, q?.optionC, q?.optionD];
      const reason = !q
        ? "thiếu câu"
        : typeof q.question !== "string" || !q.question.trim()
          ? "thiếu câu hỏi"
          : options.some((o) => typeof o !== "string" || !o.trim())
            ? "thiếu phương án"
            : new Set(options.map((o) => normalizeText(o as string))).size !== 4
              ? "có 2 phương án giống nhau"
              : !ANSWER_KEYS.includes(q.correctAnswer)
                ? "đáp án đúng không phải A/B/C/D"
                : null;
      if (reason || !q) {
        onReject(reason ?? "không hợp lệ", q ?? { slot: slotName(ci, v) });
        continue;
      }
      byCell[cell.id].push({
        question: q.question.trim(),
        optionA: q.optionA.trim(),
        optionB: q.optionB.trim(),
        optionC: q.optionC.trim(),
        optionD: q.optionD.trim(),
        correctAnswer: q.correctAnswer,
        difficulty: cell.level,
      });
    }
  });
  return byCell;
}

/** Gộp thêm câu mới vào ô, bỏ câu trùng chữ, giữ tối đa `limit` câu. */
export function mergeCellQuestions(existing: RawQuestion[], added: RawQuestion[], limit: number): RawQuestion[] {
  const seen = new Set(existing.map((q) => normalizeText(q.question)));
  const merged = [...existing];
  for (const q of added) {
    if (merged.length >= limit) break;
    const key = normalizeText(q.question);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(q);
  }
  return merged;
}

/** Tạo ngân hàng câu hỏi theo thứ tự ô của ma trận; mỗi câu mang nhãn mức độ, chủ đề con và ô. */
export function finalizeQuestions(matrix: QuestionMatrix, byCell: Record<string, RawQuestion[]>): Question[] {
  const seen = new Set<string>();
  const questions: Question[] = [];

  for (const cell of matrix.cells) {
    for (const raw of byCell[cell.id] ?? []) {
      const key = normalizeText(raw.question);
      if (seen.has(key)) continue;
      seen.add(key);
      questions.push({
        id: `q${questions.length + 1}`,
        question: raw.question,
        options: { A: raw.optionA, B: raw.optionB, C: raw.optionC, D: raw.optionD },
        correctAnswer: raw.correctAnswer,
        chapter: 1,
        difficulty: cell.level,
        topic: matrix.topics[cell.topic]?.name,
        cell: cell.id,
      });
    }
  }

  if (questions.length === 0) {
    throw new Error("Không sinh được câu hỏi nào từ tài liệu.");
  }
  return questions;
}

export async function chatAboutLecture(lecture: Lecture, history: ChatMessage[]): Promise<string> {
  const lectureText = [
    `Tiêu đề: ${lecture.title}`,
    ...lecture.sections.map(
      (s) =>
        `## ${s.heading}\n${s.content}\n` +
        (s.examples.length ? `Ví dụ: ${s.examples.join(" | ")}\n` : "") +
        (s.notes.length ? `Lưu ý: ${s.notes.join(" | ")}\n` : "")
    ),
    `Tóm tắt: ${lecture.summary}`,
  ].join("\n\n");

  const result = await llm({
    history,
    maxOutputTokens: 1500,
    system:
        "Bạn là trợ lý học tập, CHỈ được trả lời dựa trên nội dung bài giảng sau đây, không được sử dụng " +
        "bất kỳ kiến thức nào bên ngoài tài liệu này. Nếu câu hỏi của sinh viên không thể trả lời được từ " +
        "nội dung bài giảng, hãy trả lời chính xác câu: \"Không tìm thấy nội dung này trong tài liệu\". " +
        "Trả lời ngắn gọn, dễ hiểu, bằng tiếng Việt.\n\n=== BÀI GIẢNG ===\n" +
        lectureText,
  });

  return result.text || "Không tìm thấy nội dung này trong tài liệu";
}

export async function generateAssessment(score: number, total: number): Promise<string> {
  const percent = Math.round((score / total) * 100);

  const result = await llm({
    maxOutputTokens: 600,
    instruction:
              `Một sinh viên vừa làm bài kiểm tra trắc nghiệm và đạt ${score}/${total} câu đúng (${percent}%). ` +
              `Hãy viết một nhận xét khách quan, công bằng (2-3 câu) về khả năng hiểu bài của sinh viên dựa trên ` +
              `kết quả này. Diễn đạt tự nhiên, đa dạng cách hành văn, tránh lối viết máy móc/khuôn mẫu lặp lại. ` +
              `Nếu điểm cao hãy khen và khuyến khích giữ vững; nếu điểm trung bình hãy chỉ ra cần ôn lại phần nào; ` +
              `nếu điểm thấp hãy nhận xét thẳng thắn nhưng vẫn mang tính xây dựng. Trả lời bằng tiếng Việt, chỉ ` +
              `trả về đoạn nhận xét, không thêm tiêu đề.`,
  });

  return result.text || `Bạn đạt ${score}/${total} câu đúng.`;
}

function extractJsonText(text: string | undefined): string {
  if (!text) {
    throw new Error("Gemini không trả về nội dung.");
  }
  const trimmed = text.trim();
  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  return fencedMatch ? fencedMatch[1].trim() : trimmed;
}
