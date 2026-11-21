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

/** 4 mức độ nhận thức hiện dùng; 3 mức "Cơ bản/Trung bình/Nâng cao" chỉ còn ở dữ liệu tạo trước đây. */
export type Difficulty = "Nhận biết" | "Thông hiểu" | "Vận dụng" | "Vận dụng cao" | "Cơ bản" | "Trung bình" | "Nâng cao";

export interface Question {
  id: string;
  question: string;
  options: Record<AnswerKey, string>;
  correctAnswer: AnswerKey;
  /** Số thứ tự chương/phần trong tài liệu (1-based). Bằng 1 nếu tài liệu không chia chương. */
  chapter: number;
  difficulty: Difficulty;
}

/** Câu hỏi gửi cho sinh viên khi làm bài — không có đáp án đúng và mức độ. */
export type QuizQuestion = Omit<Question, "correctAnswer" | "difficulty">;

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
  /** Số câu hỏi của đề (mỗi câu 1 nội dung riêng, chia đều 4 mức độ). Mọi lượt làm dùng đủ các câu này,
   * chỉ đảo thứ tự câu và thứ tự đáp án. */
  totalQuestions: number;
  /** true: sinh viên được làm bài nhiều lần (không chặn nộp lần 2 trở đi theo Họ tên + Lớp). */
  allowRetake: boolean;
  /** Giới hạn thời gian làm bài (phút), tính từ lúc sinh viên bấm bắt đầu. 0 = không giới hạn. */
  timeLimitMinutes: number;
}

export interface StartUploadResponse {
  jobId: string;
  totalSteps: number;
}

export interface ExamInfo {
  fixedExam: boolean;
  allowRetake: boolean;
  timeLimitMinutes: number;
}

export interface StartQuizResponse {
  attemptId: string;
  questions: QuizQuestion[];
  /** Tổng thời gian cho phép (giây). 0 = không giới hạn. */
  timeLimitSeconds: number;
  /** Thời gian còn lại (giây) tại thời điểm server trả về. Bằng timeLimitSeconds với lượt làm mới. */
  remainingSeconds: number;
  /** true nếu đây là lượt làm bài đã bắt đầu trước đó và được tiếp tục (không random lại đề). */
  resumed: boolean;
}

export interface UploadStepResponse {
  status: "processing" | "done" | "failed";
  completedSteps: number;
  totalSteps: number;
  error?: string;
  result?: { title: string; sectionsCount: number; questionCount: number };
}
