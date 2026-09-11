import { GoogleGenAI, Type } from "@google/genai";
import type { ContentListUnion, Part } from "@google/genai";
import type { AnswerKey, ChatMessage, Difficulty, Lecture, Question } from "../../shared/types.js";

const MODEL = "gemini-2.5-flash";
// Mỗi lô câu hỏi giờ chỉ đọc phần text đã trích xuất riêng cho chương đó (xem extractChapterContent),
// không phải đọc lại toàn bộ tài liệu gốc — nên có thể để lô lớn hơn mà vẫn an toàn với trần 60s.
export const MAX_QUESTIONS_PER_BATCH_CALL = 10;

let client: GoogleGenAI | null = null;

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
export async function uploadFilesToGemini(
  files: { name: string; mimeType: string; base64: string }[]
): Promise<UploadedFileRef[]> {
  if (files.length === 0) return [];
  const ai = getClient();

  return Promise.all(
    files.map(async (f) => {
      const buffer = Buffer.from(f.base64, "base64");
      const blob = new Blob([buffer], { type: f.mimeType });
      const uploaded = await ai.files.upload({
        file: blob,
        config: { mimeType: f.mimeType, displayName: f.name },
      });
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

// Trích xuất mỗi lần khoảng ngần này ký tự nguồn — đủ nhỏ để phản hồi luôn xong an toàn trong 60s,
// kể cả với chương dài. Càng nhiều ký tự nguồn thì càng cần chia làm nhiều lần trích xuất hơn.
const SOURCE_CHARS_PER_EXTRACTION_CHUNK = 12000;
const MIN_CHUNKS_PER_CHAPTER = 2;
const MAX_CHUNKS_PER_CHAPTER = 8;

/** Số lần trích xuất cần thiết cho mỗi chương — dựa trên độ dài tài liệu đã biết (text dán trực tiếp
 * hoặc trích từ DOCX/XLSX); nếu tài liệu chỉ có file PDF/ảnh (không biết trước độ dài text), dùng mặc
 * định an toàn. */
export function planExtractionChunksPerChapter(doc: DocumentInput, numChapters: number): number {
  const knownLength = doc.pastedText.length + doc.extractedTexts.reduce((sum, t) => sum + t.text.length, 0);
  if (knownLength === 0) {
    return numChapters > 1 ? 4 : 2;
  }
  const perChapterChars = knownLength / numChapters;
  const chunks = Math.ceil(perChapterChars / SOURCE_CHARS_PER_EXTRACTION_CHUNK);
  return Math.min(MAX_CHUNKS_PER_CHAPTER, Math.max(MIN_CHUNKS_PER_CHAPTER, chunks));
}

/**
 * Đọc toàn bộ tài liệu gốc và trích xuất riêng nội dung của 1 chương, CHIA THÀNH NHIỀU LẦN GỌI nhỏ
 * (mỗi lần khoảng 1/N chương) thay vì trích xuất toàn bộ chương trong 1 lần — vì trích xuất "đầy đủ"
 * một chương dài trong 1 lần dễ khiến phản hồi quá dài, vượt giới hạn 60s. Mỗi lần gọi tiếp nối ngay
 * sau đoạn đã trích xuất ở (các) lần trước (truyền vào qua `previousText`), giúp không lặp/không sót.
 * Kết quả các lần được nối lại ở nơi gọi (api/upload-step.ts) để thành nội dung đầy đủ của chương.
 */
export async function extractChapterChunk(
  doc: DocumentInput,
  chapter: number,
  numChapters: number,
  chunkIndex: number,
  totalChunks: number,
  previousText: string
): Promise<string> {
  const ai = getClient();
  const parts = buildDocumentParts(doc);

  const chapterLabel =
    numChapters > 1
      ? `chương/phần thứ ${chapter} trong tổng số ${numChapters} chương/phần (phần này thường được đánh dấu là ` +
        `"Chương ${chapter}", "Phần ${chapter}" hoặc tương đương trong văn bản)`
      : `toàn bộ tài liệu`;

  const previousTail = previousText.trim().slice(-400);

  const positionInstruction =
    chunkIndex === 0
      ? `Đây là LẦN TRÍCH XUẤT THỨ 1/${totalChunks} cho ${chapterLabel}. Hãy trích xuất và trình bày lại ĐẦY ĐỦ, ` +
        `chi tiết khoảng 1/${totalChunks} nội dung ĐẦU TIÊN của phần này, tính từ đầu.`
      : `Đây là LẦN TRÍCH XUẤT THỨ ${chunkIndex + 1}/${totalChunks} cho ${chapterLabel}. Ở (các) lần trước, bạn đã ` +
        `trích xuất tới đoạn kết thúc bằng: "...${previousTail}". Hãy tiếp tục trích xuất và trình bày lại ĐẦY ĐỦ, ` +
        `chi tiết PHẦN TIẾP THEO (không lặp lại nội dung đã trích xuất ở trên), khoảng 1/${totalChunks} nội dung ` +
        `còn lại.` +
        (chunkIndex === totalChunks - 1
          ? ` Đây là LẦN CUỐI CÙNG — phải lấy hết phần còn lại cho tới hết, không được dừng giữa chừng.`
          : "");

  const instruction =
    `Đọc toàn bộ tài liệu bên dưới. ${positionInstruction} Giữ nguyên mọi khái niệm, định nghĩa, số liệu, ví dụ ` +
    `quan trọng. ${numChapters > 1 ? "TUYỆT ĐỐI KHÔNG lẫn nội dung của các chương/phần khác vào. " : ""}` +
    `Trình bày dưới dạng văn bản thuần, dùng tiêu đề cho từng mục con nếu có để rõ ràng. Trả lời bằng tiếng Việt.`;

  const response = await ai.models.generateContent({
    model: MODEL,
    contents: [{ role: "user", parts: [{ text: instruction }, ...parts] }],
    config: { maxOutputTokens: 16384 },
  });

  const finishReason = response.candidates?.[0]?.finishReason;
  if (finishReason === "MAX_TOKENS") {
    throw new Error(
      `Một phần nội dung quá dài, không trích xuất được trong 1 lần (chương ${chapter}, lần ${chunkIndex + 1}/${totalChunks}). Vui lòng thử lại.`
    );
  }

  const text = response.text?.trim();
  if (!text) {
    throw new Error(`Không trích xuất được nội dung (chương ${chapter}, lần ${chunkIndex + 1}/${totalChunks}).`);
  }
  return text;
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
  const ai = getClient();
  const parts = buildDocumentParts(doc);

  const response = await ai.models.generateContent({
    model: MODEL,
    contents: [
      {
        role: "user",
        parts: [
          {
            text:
              "Bạn là một giảng viên đại học giàu kinh nghiệm. Đọc toàn bộ tài liệu bên dưới và biên soạn thành " +
              "một bài giảng khoa học, dễ hiểu cho sinh viên. Bài giảng gồm tối đa 6-8 phần (sections) bao quát " +
              "các ý chính của tài liệu, mỗi phần trình bày súc tích (khoảng 120-200 từ nội dung), kèm 1-2 ví dụ " +
              "minh họa cụ thể và lưu ý nếu có. Cuối bài giảng có phần tóm tắt ngắn gọn giúp sinh viên nắm bài. " +
              "Ưu tiên đầy đủ ý quan trọng nhưng diễn đạt cô đọng, không lan man. Chỉ dùng thông tin có trong tài " +
              "liệu, không bịa thêm kiến thức ngoài tài liệu. Trả lời bằng tiếng Việt.",
          },
          ...parts,
        ],
      },
    ],
    config: {
      responseMimeType: "application/json",
      responseSchema: lectureSchema,
    },
  });

  const json = extractJsonText(response.text);
  const parsed = JSON.parse(json) as Omit<Lecture, "updatedAt">;
  if (!parsed.title || !Array.isArray(parsed.sections) || parsed.sections.length === 0) {
    throw new Error("Gemini trả về bài giảng không hợp lệ.");
  }
  return parsed;
}

const questionBatchSchema = {
  type: Type.ARRAY,
  items: {
    type: Type.OBJECT,
    properties: {
      question: { type: Type.STRING },
      optionA: { type: Type.STRING },
      optionB: { type: Type.STRING },
      optionC: { type: Type.STRING },
      optionD: { type: Type.STRING },
      correctAnswer: { type: Type.STRING, enum: ["A", "B", "C", "D"] },
      difficulty: {
        type: Type.STRING,
        enum: ["Cơ bản", "Trung bình", "Nâng cao"],
        description: "Mức độ khó thực sự của câu hỏi này",
      },
    },
    required: ["question", "optionA", "optionB", "optionC", "optionD", "correctAnswer", "difficulty"],
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

export const QUESTION_FOCUS_HINTS = [
  "tập trung vào các khái niệm và định nghĩa cốt lõi",
  "tập trung vào ví dụ minh họa và ứng dụng thực tế",
  "tập trung vào so sánh, phân tích và các trường hợp đặc biệt",
  "tập trung vào tổng hợp và các nội dung còn lại chưa khai thác",
];

export interface QuestionBatchStep {
  key: string;
  chapter: number;
  count: number;
}

/** Chia tổng số câu hỏi ngân hàng thành các lô nhỏ (≤10 câu/lô) theo từng chương để mỗi lệnh
 * gọi Gemini luôn nhẹ và nhanh, kể cả khi tổng số câu hỏi hoặc số chương lớn. */
export function planQuestionBatches(numChapters: number, totalBankQuestions: number): QuestionBatchStep[] {
  const perChapterTarget = Math.max(1, Math.ceil(totalBankQuestions / numChapters));
  const steps: QuestionBatchStep[] = [];

  for (let chapter = 1; chapter <= numChapters; chapter++) {
    let remaining = perChapterTarget;
    let idx = 0;
    while (remaining > 0) {
      const count = Math.min(MAX_QUESTIONS_PER_BATCH_CALL, remaining);
      steps.push({ key: `q:${chapter}:${idx}`, chapter, count });
      remaining -= count;
      idx++;
    }
  }

  return steps;
}

export async function generateQuestionBatch(
  doc: DocumentInput,
  count: number,
  chapter: number,
  numChapters: number,
  focusHint: string,
  avoidQuestions: string[] = []
): Promise<RawQuestion[]> {
  const ai = getClient();
  const parts = buildDocumentParts(doc);

  const chapterInstruction =
    numChapters > 1
      ? `CHỈ dựa vào nội dung của chương/phần thứ ${chapter} trong tổng số ${numChapters} chương/phần của tài ` +
        `liệu (phần này thường được đánh dấu là "Chương ${chapter}", "Phần ${chapter}" hoặc tương đương trong ` +
        `văn bản). TUYỆT ĐỐI KHÔNG dùng nội dung của các chương/phần khác. `
      : "";

  const avoidInstruction =
    avoidQuestions.length > 0
      ? `\n\nDưới đây là danh sách các câu hỏi ĐÃ ĐƯỢC TẠO TRƯỚC ĐÓ (cùng chương/phần này) — TUYỆT ĐỐI KHÔNG ` +
        `được tạo câu hỏi trùng lặp hoặc chỉ diễn đạt lại (paraphrase) ý của bất kỳ câu nào trong danh sách này, ` +
        `phải khai thác khía cạnh/ý khác của tài liệu:\n` +
        avoidQuestions.map((q, i) => `${i + 1}. ${q}`).join("\n")
      : "";

  const contents: ContentListUnion = [
    {
      role: "user",
      parts: [
        {
          text:
            `Bạn là một chuyên gia ra đề thi trắc nghiệm. Dựa HOÀN TOÀN trên tài liệu bên dưới, hãy soạn đúng ` +
            `${count} câu hỏi trắc nghiệm. ${chapterInstruction}Khi ra đề, hãy ${focusHint}. ` +
            `Mỗi câu hỏi có đúng 4 đáp án A, B, C, D và chỉ 1 đáp án đúng duy nhất. Câu hỏi phải rõ ràng, ` +
            `bám sát nội dung tài liệu, không được trùng lặp ý với nhau. Đảm bảo pha trộn đa dạng cả 3 mức độ ` +
            `khó trong số ${count} câu này: "Cơ bản" (nhớ/hiểu kiến thức trực tiếp), "Trung bình" (vận dụng, ` +
            `giải thích), "Nâng cao" (phân tích, so sánh, suy luận nhiều bước) — gắn đúng nhãn độ khó thực tế cho ` +
            `từng câu, không gắn đại khái. Trả lời bằng tiếng Việt.${avoidInstruction}`,
        },
        ...parts,
      ],
    },
  ];

  const response = await ai.models.generateContent({
    model: MODEL,
    contents,
    config: {
      responseMimeType: "application/json",
      responseSchema: questionBatchSchema,
    },
  });

  const json = extractJsonText(response.text);
  const parsed = JSON.parse(json) as RawQuestion[];
  if (!Array.isArray(parsed)) {
    throw new Error("Gemini trả về ngân hàng câu hỏi không hợp lệ.");
  }
  return parsed;
}

/** Gộp các lô câu hỏi đã sinh (mỗi lô từ 1 lệnh gọi Gemini riêng), khử trùng và gán ID + chương. */
export function finalizeQuestions(batches: { chapter: number; items: RawQuestion[] }[]): Question[] {
  const seen = new Set<string>();
  const questions: Question[] = [];
  let counter = 1;

  for (const batch of batches) {
    for (const raw of batch.items) {
      const key = raw.question.trim().toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      questions.push({
        id: `q${counter++}`,
        question: raw.question,
        options: { A: raw.optionA, B: raw.optionB, C: raw.optionC, D: raw.optionD },
        correctAnswer: raw.correctAnswer,
        chapter: batch.chapter,
        difficulty: raw.difficulty,
      });
    }
  }

  if (questions.length === 0) {
    throw new Error("Không sinh được câu hỏi nào từ tài liệu.");
  }

  return questions;
}

export async function chatAboutLecture(lecture: Lecture, history: ChatMessage[]): Promise<string> {
  const ai = getClient();

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

  const contents: ContentListUnion = history.map((m) => ({
    role: m.role,
    parts: [{ text: m.text }],
  }));

  const response = await ai.models.generateContent({
    model: MODEL,
    contents,
    config: {
      systemInstruction:
        "Bạn là trợ lý học tập, CHỈ được trả lời dựa trên nội dung bài giảng sau đây, không được sử dụng " +
        "bất kỳ kiến thức nào bên ngoài tài liệu này. Nếu câu hỏi của sinh viên không thể trả lời được từ " +
        "nội dung bài giảng, hãy trả lời chính xác câu: \"Không tìm thấy nội dung này trong tài liệu\". " +
        "Trả lời ngắn gọn, dễ hiểu, bằng tiếng Việt.\n\n=== BÀI GIẢNG ===\n" +
        lectureText,
    },
  });

  return response.text?.trim() || "Không tìm thấy nội dung này trong tài liệu";
}

export async function generateAssessment(score: number, total: number): Promise<string> {
  const ai = getClient();
  const percent = Math.round((score / total) * 100);

  const response = await ai.models.generateContent({
    model: MODEL,
    contents: [
      {
        role: "user",
        parts: [
          {
            text:
              `Một sinh viên vừa làm bài kiểm tra trắc nghiệm và đạt ${score}/${total} câu đúng (${percent}%). ` +
              `Hãy viết một nhận xét khách quan, công bằng (2-3 câu) về khả năng hiểu bài của sinh viên dựa trên ` +
              `kết quả này. Diễn đạt tự nhiên, đa dạng cách hành văn, tránh lối viết máy móc/khuôn mẫu lặp lại. ` +
              `Nếu điểm cao hãy khen và khuyến khích giữ vững; nếu điểm trung bình hãy chỉ ra cần ôn lại phần nào; ` +
              `nếu điểm thấp hãy nhận xét thẳng thắn nhưng vẫn mang tính xây dựng. Trả lời bằng tiếng Việt, chỉ ` +
              `trả về đoạn nhận xét, không thêm tiêu đề.`,
          },
        ],
      },
    ],
  });

  return response.text?.trim() || `Bạn đạt ${score}/${total} câu đúng.`;
}

function extractJsonText(text: string | undefined): string {
  if (!text) {
    throw new Error("Gemini không trả về nội dung.");
  }
  const trimmed = text.trim();
  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  return fencedMatch ? fencedMatch[1].trim() : trimmed;
}
