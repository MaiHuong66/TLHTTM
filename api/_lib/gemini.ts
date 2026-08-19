import { GoogleGenAI, Type } from "@google/genai";
import type { ContentListUnion, Part } from "@google/genai";
import type { AnswerKey, ChatMessage, Lecture, Question } from "../../shared/types.js";

const MODEL = "gemini-2.5-flash";
// Nhiều lô nhỏ thay vì ít lô lớn: mỗi lô nhẹ hơn, ít rủi ro vượt giới hạn 60s/lần gọi hàm
// khi tài liệu nguồn nặng (PDF nhiều trang/ảnh).
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
    },
    required: ["question", "optionA", "optionB", "optionC", "optionD", "correctAnswer"],
  },
};

export interface RawQuestion {
  question: string;
  optionA: string;
  optionB: string;
  optionC: string;
  optionD: string;
  correctAnswer: AnswerKey;
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
  focusHint: string
): Promise<RawQuestion[]> {
  const ai = getClient();
  const parts = buildDocumentParts(doc);

  const chapterInstruction =
    numChapters > 1
      ? `CHỈ dựa vào nội dung của chương/phần thứ ${chapter} trong tổng số ${numChapters} chương/phần của tài ` +
        `liệu (phần này thường được đánh dấu là "Chương ${chapter}", "Phần ${chapter}" hoặc tương đương trong ` +
        `văn bản). TUYỆT ĐỐI KHÔNG dùng nội dung của các chương/phần khác. `
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
            `bám sát nội dung tài liệu, độ khó đa dạng, không được trùng lặp ý với nhau. Trả lời bằng tiếng Việt.`,
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
