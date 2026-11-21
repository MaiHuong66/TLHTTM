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

const LEVEL_GUIDE =
  `"Nhận biết": nhớ lại, nhận ra đúng khái niệm, định nghĩa, sự kiện, thuật ngữ có trong tài liệu. ` +
  `"Thông hiểu": giải thích, phân biệt, so sánh, diễn giải ý nghĩa, nhận ra ví dụ đúng của một khái niệm. ` +
  `"Vận dụng": áp dụng kiến thức vào một tình huống cụ thể, quen thuộc để giải quyết vấn đề hoặc chọn cách làm đúng. ` +
  `"Vận dụng cao": xử lý tình huống mới, phức tạp, cần phân tích, đánh giá hoặc kết hợp nhiều bước suy luận.`;

/** Số mỗi lô câu hỏi — đủ nhỏ để 1 lần gọi AI luôn xong trong giới hạn 60s của Vercel. */
export const QUESTIONS_PER_BATCH = 8;

/** Một đơn vị nội dung kiến thức riêng biệt trong tài liệu; mỗi đơn vị được hỏi đúng 1 câu. */
export interface ContentPoint {
  topic: string;
  level: Difficulty;
}

/** Chia đều `total` câu cho 4 mức độ, phần dư dồn cho các mức thấp trước (vd 30 → 8, 8, 7, 7). */
export function levelTargets(total: number): Map<Difficulty, number> {
  const base = Math.floor(total / COGNITIVE_LEVELS.length);
  const remainder = total % COGNITIVE_LEVELS.length;
  return new Map(COGNITIVE_LEVELS.map((level, i) => [level, base + (i < remainder ? 1 : 0)]));
}

function normalizeText(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/** Bỏ nội dung trùng, rồi đảm bảo số nội dung mỗi mức đúng chỉ tiêu: nội dung thừa ở 1 mức được chuyển sang
 * mức còn thiếu. Giữ nguyên thứ tự xuất hiện trong tài liệu. */
export function balanceContentPoints(points: ContentPoint[], total: number): ContentPoint[] {
  const targets = levelTargets(total);
  const seen = new Set<string>();
  const unique = points.filter((p) => {
    const key = normalizeText(p.topic);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const counts = new Map<Difficulty, number>(COGNITIVE_LEVELS.map((l) => [l, 0]));
  const assigned: (ContentPoint | null)[] = unique.map((p) => {
    const level = COGNITIVE_LEVELS.includes(p.level) ? p.level : null;
    if (level && counts.get(level)! < targets.get(level)!) {
      counts.set(level, counts.get(level)! + 1);
      return { topic: p.topic, level };
    }
    return null;
  });

  unique.forEach((p, i) => {
    if (assigned[i]) return;
    const missing = COGNITIVE_LEVELS.find((l) => counts.get(l)! < targets.get(l)!);
    if (!missing) return;
    counts.set(missing, counts.get(missing)! + 1);
    assigned[i] = { topic: p.topic, level: missing };
  });

  return assigned.filter((p): p is ContentPoint => p !== null).slice(0, total);
}

const contentPlanSchema = {
  type: Type.ARRAY,
  items: {
    type: Type.OBJECT,
    properties: {
      topic: {
        type: Type.STRING,
        description: "Mô tả cụ thể 1 đơn vị nội dung kiến thức (1-2 câu), đủ rõ để biết chính xác sẽ hỏi điều gì",
      },
      level: { type: Type.STRING, enum: COGNITIVE_LEVELS },
    },
    required: ["topic", "level"],
  },
};

/** Bước 1: liệt kê đúng `total` đơn vị nội dung KHÁC NHAU trong tài liệu và gán mức độ cho từng đơn vị — để mỗi
 * câu hỏi sau đó kiểm tra 1 nội dung riêng, không có 2 câu cùng hỏi 1 nội dung theo 2 cách. */
export async function planContentPoints(doc: DocumentInput, total: number): Promise<ContentPoint[]> {
  const targets = levelTargets(total);
  const quota = COGNITIVE_LEVELS.map((l) => `${targets.get(l)} "${l}"`).join(", ");

  const instruction =
    `Bạn là chuyên gia ra đề kiểm tra trắc nghiệm. Đọc toàn bộ tài liệu bên dưới và lập danh sách ĐÚNG ${total} ` +
    `đơn vị nội dung kiến thức để ra ${total} câu hỏi, mỗi đơn vị sẽ được hỏi đúng 1 câu.\n` +
    `Yêu cầu:\n` +
    `- Mỗi đơn vị là MỘT ý kiến thức cụ thể, riêng biệt (một khái niệm, định nghĩa, đặc điểm, nguyên tắc, quy trình, ` +
    `ứng dụng...). Hai đơn vị bất kỳ KHÔNG được trùng nhau, không bao hàm nhau, không phải 2 cách diễn đạt/2 cách ` +
    `hỏi khác nhau của cùng một ý.\n` +
    `- Trải đều khắp các phần của tài liệu, không dồn vào một phần.\n` +
    `- Chỉ lấy nội dung có trong tài liệu.\n` +
    `- Gán mức độ cho từng đơn vị, phân bổ đúng: ${quota}. Mức độ phải phù hợp với nội dung. ${LEVEL_GUIDE}\n` +
    `- Liệt kê theo thứ tự xuất hiện trong tài liệu. Viết bằng tiếng Việt.`;

  const result = await llm({ instruction, doc, schema: contentPlanSchema, maxOutputTokens: 6000 });
  const parsed = result.json as ContentPoint[] | undefined;
  if (!Array.isArray(parsed)) {
    throw new Error("AI trả về danh sách nội dung không hợp lệ.");
  }

  const points = balanceContentPoints(
    parsed.filter((p) => p && typeof p.topic === "string"),
    total
  );
  if (points.length === 0) {
    throw new Error("Không tìm được nội dung nào trong tài liệu để ra câu hỏi.");
  }
  return points;
}

/** Bổ sung khi danh sách nội dung còn thiếu so với `total`: xin thêm các nội dung KHÁC những nội dung đã có, đúng
 * số còn thiếu ở từng mức độ. */
export async function planMoreContentPoints(
  doc: DocumentInput,
  existing: ContentPoint[],
  total: number
): Promise<ContentPoint[]> {
  const targets = levelTargets(total);
  const missing = COGNITIVE_LEVELS.map((l) => ({
    level: l,
    count: Math.max(0, targets.get(l)! - existing.filter((p) => p.level === l).length),
  })).filter((m) => m.count > 0);
  const need = missing.reduce((sum, m) => sum + m.count, 0);
  if (need === 0) return existing;

  const instruction =
    `Bạn là chuyên gia ra đề kiểm tra trắc nghiệm. Từ tài liệu bên dưới đã chọn được các đơn vị nội dung kiến thức ` +
    `sau, mỗi đơn vị sẽ được hỏi đúng 1 câu:\n${existing.map((p, i) => `${i + 1}. ${p.topic}`).join("\n")}\n\n` +
    `Hãy bổ sung ĐÚNG ${need} đơn vị nội dung MỚI, gồm: ${missing.map((m) => `${m.count} "${m.level}"`).join(", ")}. ` +
    `Mỗi đơn vị mới là một ý kiến thức cụ thể có trong tài liệu, KHÔNG trùng, không bao hàm và không phải cách diễn ` +
    `đạt khác của bất kỳ đơn vị nào ở trên hay của nhau. Có thể khai thác ví dụ, chi tiết, ứng dụng, lưu ý chưa được ` +
    `chọn. ${LEVEL_GUIDE} Viết bằng tiếng Việt.`;

  const result = await llm({ instruction, doc, schema: contentPlanSchema, maxOutputTokens: 3000 });
  const extra = Array.isArray(result.json) ? (result.json as ContentPoint[]) : [];
  return balanceContentPoints(
    [...existing, ...extra.filter((p) => p && typeof p.topic === "string")],
    total
  );
}

const questionBatchSchema = {
  type: Type.ARRAY,
  items: {
    type: Type.OBJECT,
    properties: {
      contentNumber: { type: Type.INTEGER, description: "Số thứ tự của nội dung được giao mà câu hỏi này kiểm tra" },
      question: { type: Type.STRING },
      optionA: { type: Type.STRING },
      optionB: { type: Type.STRING },
      optionC: { type: Type.STRING },
      optionD: { type: Type.STRING },
      correctAnswer: { type: Type.STRING, enum: ["A", "B", "C", "D"] },
    },
    required: ["contentNumber", "question", "optionA", "optionB", "optionC", "optionD", "correctAnswer"],
  },
};

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

/** Bước 2: soạn đúng 1 câu cho mỗi nội dung được giao (`pointIndexes` là vị trí trong `plan`). Trả về câu hỏi
 * theo vị trí nội dung; nội dung nào AI không trả về câu hợp lệ sẽ không có trong kết quả. */
export async function generateQuestionsForPoints(
  doc: DocumentInput,
  plan: ContentPoint[],
  pointIndexes: number[],
  onReject: (reason: string, item: unknown) => void = () => undefined
): Promise<Record<number, RawQuestion>> {
  const assigned = pointIndexes
    .map((idx, i) => `${i + 1}. [${plan[idx].level}] ${plan[idx].topic}`)
    .join("\n");
  const others = plan
    .map((p, idx) => ({ p, idx }))
    .filter(({ idx }) => !pointIndexes.includes(idx))
    .map(({ p }) => `- ${p.topic}`)
    .join("\n");

  const instruction =
    `Bạn là chuyên gia ra đề kiểm tra trắc nghiệm. Dựa HOÀN TOÀN vào tài liệu bên dưới, soạn ĐÚNG 1 câu hỏi ` +
    `trắc nghiệm cho MỖI nội dung trong danh sách được giao (tổng ${pointIndexes.length} câu), ghi contentNumber là ` +
    `số thứ tự của nội dung đó.\n\n` +
    `NỘI DUNG ĐƯỢC GIAO (kèm mức độ bắt buộc):\n${assigned}\n\n` +
    `Yêu cầu cho từng câu:\n` +
    `- Chỉ kiểm tra đúng nội dung được giao cho câu đó, đúng mức độ ghi trong ngoặc vuông. ${LEVEL_GUIDE}\n` +
    `- Câu "Vận dụng" và "Vận dụng cao" BẮT BUỘC đặt trong một tình huống cụ thể (một người, một tổ chức, một sự ` +
    `việc...) để sinh viên phải áp dụng hoặc phân tích kiến thức; không được chỉ hỏi lại định nghĩa hay đặc điểm.\n` +
    `- Không hỏi lại nội dung của câu khác, kể cả bằng cách diễn đạt khác.\n` +
    `- Có đúng 4 phương án, chỉ 1 phương án đúng; các phương án sai phải hợp lý, dễ gây nhầm với người chưa nắm ` +
    `bài, cùng dạng và độ dài tương đương phương án đúng. Phương án đúng KHÔNG được là phương án dài nhất/chi tiết ` +
    `nhất một cách dễ nhận ra, và không chép nguyên văn câu trong tài liệu trong khi các phương án sai lại diễn đạt khác.\n` +
    `- Thứ tự các phương án sẽ bị XÁO TRỘN khi thi, nên TUYỆT ĐỐI KHÔNG dùng phương án kiểu "Tất cả các đáp án ` +
    `trên", "Cả A và B", "Không có đáp án nào đúng", và không nhắc tới chữ cái A, B, C, D trong câu hỏi hay phương án.\n` +
    `- Câu hỏi rõ ràng, không mơ hồ, viết bằng tiếng Việt.` +
    (others
      ? `\n\nCÁC NỘI DUNG SAU ĐÃ/SẼ ĐƯỢC HỎI Ở CÂU KHÁC — không được hỏi về chúng:\n${others}`
      : "");

  const result = await llm({ instruction, doc, schema: questionBatchSchema, maxOutputTokens: 8000 });
  const parsed = result.json as (Omit<RawQuestion, "difficulty"> & { contentNumber: number })[] | undefined;
  if (!Array.isArray(parsed)) {
    throw new Error("AI trả về câu hỏi không hợp lệ.");
  }

  const byPoint: Record<number, RawQuestion> = {};
  for (const q of parsed) {
    const pointIdx = pointIndexes[Number(q?.contentNumber) - 1];
    const options = [q?.optionA, q?.optionB, q?.optionC, q?.optionD];
    const reason =
      pointIdx === undefined
        ? "contentNumber không thuộc danh sách được giao"
        : byPoint[pointIdx]
          ? "trùng contentNumber"
          : typeof q.question !== "string" || !q.question.trim()
            ? "thiếu câu hỏi"
            : options.some((o) => typeof o !== "string" || !o.trim())
              ? "thiếu phương án"
              : new Set(options.map((o) => normalizeText(o))).size !== 4
                ? "có 2 phương án giống nhau"
                : !ANSWER_KEYS.includes(q.correctAnswer)
                  ? "đáp án đúng không phải A/B/C/D"
                  : null;
    if (reason || pointIdx === undefined) {
      onReject(reason ?? "không hợp lệ", q);
      continue;
    }
    byPoint[pointIdx] = {
      question: q.question.trim(),
      optionA: q.optionA.trim(),
      optionB: q.optionB.trim(),
      optionC: q.optionC.trim(),
      optionD: q.optionD.trim(),
      correctAnswer: q.correctAnswer,
      difficulty: plan[pointIdx].level,
    };
  }
  return byPoint;
}

/** Ghép câu hỏi theo thứ tự nội dung, bỏ câu trùng chữ và gán ID. */
export function finalizeQuestions(items: RawQuestion[]): Question[] {
  const seen = new Set<string>();
  const questions: Question[] = [];

  for (const raw of items) {
    const key = normalizeText(raw.question);
    if (seen.has(key)) continue;
    seen.add(key);
    questions.push({
      id: `q${questions.length + 1}`,
      question: raw.question,
      options: { A: raw.optionA, B: raw.optionB, C: raw.optionC, D: raw.optionD },
      correctAnswer: raw.correctAnswer,
      chapter: 1,
      difficulty: raw.difficulty,
    });
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
