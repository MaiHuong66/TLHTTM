import { GoogleGenAI, Type } from "@google/genai";
import type { ContentListUnion, Part } from "@google/genai";
import type { AnswerKey, ChatMessage, Lecture, Question } from "../../shared/types.js";

const MODEL = "gemini-2.5-flash";
const QUESTION_BATCH_COUNT = 4;
const QUESTIONS_PER_BATCH = 25;

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

export interface DocumentInput {
  pastedText: string;
  extractedTexts: { name: string; text: string }[];
  inlineFiles: { name: string; mimeType: string; base64: string }[];
}

function buildDocumentParts(doc: DocumentInput): Part[] {
  const parts: Part[] = [];

  if (doc.pastedText.trim()) {
    parts.push({ text: `--- Nội dung do giảng viên dán trực tiếp ---\n${doc.pastedText.trim()}` });
  }

  for (const f of doc.extractedTexts) {
    parts.push({ text: `--- Nội dung trích xuất từ file "${f.name}" ---\n${f.text}` });
  }

  for (const f of doc.inlineFiles) {
    parts.push({ text: `--- File đính kèm: "${f.name}" ---` });
    parts.push({ inlineData: { mimeType: f.mimeType, data: f.base64 } });
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
              "một bài giảng đầy đủ, khoa học, dễ hiểu cho sinh viên. Bài giảng phải bao gồm nhiều phần (sections), " +
              "mỗi phần có nội dung chi tiết, ví dụ minh họa cụ thể, và lưu ý nếu có. Cuối bài giảng phải có phần " +
              "tóm tắt giúp sinh viên dễ dàng nắm bài. Chỉ dùng thông tin có trong tài liệu, không bịa thêm kiến thức " +
              "ngoài tài liệu. Trả lời bằng tiếng Việt.",
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

interface RawQuestion {
  question: string;
  optionA: string;
  optionB: string;
  optionC: string;
  optionD: string;
  correctAnswer: AnswerKey;
}

async function generateQuestionBatch(
  doc: DocumentInput,
  batchIndex: number,
  focusHint: string
): Promise<RawQuestion[]> {
  const ai = getClient();
  const parts = buildDocumentParts(doc);

  const contents: ContentListUnion = [
    {
      role: "user",
      parts: [
        {
          text:
            `Bạn là một chuyên gia ra đề thi trắc nghiệm. Dựa HOÀN TOÀN trên tài liệu bên dưới, hãy soạn đúng ` +
            `${QUESTIONS_PER_BATCH} câu hỏi trắc nghiệm (đây là lô số ${batchIndex + 1}, hãy ${focusHint}). ` +
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

export async function generateQuestionBank(doc: DocumentInput): Promise<Question[]> {
  const focusHints = [
    "tập trung vào các khái niệm và định nghĩa cốt lõi",
    "tập trung vào ví dụ minh họa và ứng dụng thực tế",
    "tập trung vào so sánh, phân tích và các trường hợp đặc biệt",
    "tập trung vào tổng hợp và các nội dung còn lại chưa khai thác",
  ];

  const batches = await Promise.all(
    Array.from({ length: QUESTION_BATCH_COUNT }, (_, i) => generateQuestionBatch(doc, i, focusHints[i]))
  );

  const seen = new Set<string>();
  const questions: Question[] = [];
  let counter = 1;

  for (const batch of batches) {
    for (const raw of batch) {
      const key = raw.question.trim().toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      questions.push({
        id: `q${counter++}`,
        question: raw.question,
        options: { A: raw.optionA, B: raw.optionB, C: raw.optionC, D: raw.optionD },
        correctAnswer: raw.correctAnswer,
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
