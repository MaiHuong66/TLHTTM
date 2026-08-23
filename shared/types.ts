export interface LectureSection {
  heading: string;
  content: string;
  examples: string[];
  notes: string[];
}

export interface Lecture {
  title: string;
  sections: LectureSection[];
  summary: string;
  updatedAt: string;
}

export type AnswerKey = "A" | "B" | "C" | "D";

export type Difficulty = "Cơ bản" | "Trung bình" | "Nâng cao";

export interface Question {
  id: string;
  question: string;
  options: Record<AnswerKey, string>;
  correctAnswer: AnswerKey;
  /** Số thứ tự chương/phần trong tài liệu (1-based). Bằng 1 nếu tài liệu không chia chương. */
  chapter: number;
  difficulty: Difficulty;
}

export type QuizQuestion = Omit<Question, "correctAnswer">;

export interface QuizReviewItem {
  id: string;
  question: string;
  options: Record<AnswerKey, string>;
  correctAnswer: AnswerKey;
  chosen: AnswerKey | null;
  isCorrect: boolean;
}

export interface SubmitTestResponse {
  score: number;
  total: number;
  danhGia: string;
  review: QuizReviewItem[];
}

export interface ResultRow {
  stt: number;
  hoTen: string;
  lop: string;
  diem: string;
  danhGia: string;
  thoiGianNop: string;
}

export interface ChatMessage {
  role: "user" | "model";
  text: string;
}

export interface UploadFilePayload {
  name: string;
  mimeType: string;
  base64: string;
}

export interface ApiErrorBody {
  error: string;
}

export interface UploadConfig {
  /** Số chương/phần trong tài liệu. 1 nghĩa là không chia chương (mặc định cũ). */
  numChapters: number;
  /** Tổng số câu hỏi trong ngân hàng (chia đều cho các chương). */
  totalBankQuestions: number;
  /** Số câu hỏi lấy từ MỖI chương khi random đề thi. Với numChapters=1, đây là tổng số câu của đề. */
  questionsPerChapterInExam: number;
}

export interface StartUploadResponse {
  jobId: string;
  totalSteps: number;
}

export interface UploadStepResponse {
  status: "processing" | "done" | "failed";
  completedSteps: number;
  totalSteps: number;
  error?: string;
  result?: { title: string; sectionsCount: number; questionCount: number };
}
