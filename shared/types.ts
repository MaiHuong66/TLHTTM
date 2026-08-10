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

export interface Question {
  id: string;
  question: string;
  options: Record<AnswerKey, string>;
  correctAnswer: AnswerKey;
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
