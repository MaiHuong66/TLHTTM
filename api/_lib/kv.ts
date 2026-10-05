import { Redis } from "@upstash/redis";
import type { Lecture, Question } from "../../shared/types.js";
import type { RawQuestion, UploadedFileRef } from "./gemini.js";

const LECTURE_KEY = "tlhttm:lecture";
const QUESTIONS_KEY = "tlhttm:questions";
const EXAM_CONFIG_KEY = "tlhttm:exam-config";
const JOB_KEY_PREFIX = "tlhttm:upload-job:";
const JOB_TTL_SECONDS = 15 * 60;
const CURRENT_RESULTS_SHEET_KEY = "tlhttm:current-results-sheet";

let redisClient: Redis | null = null;

function getClient(): Redis {
  if (redisClient) return redisClient;

  // Vercel Marketplace (Upstash for Redis) đặt tên theo chuẩn Vercel KV cũ (KV_REST_API_*);
  // Upstash tài khoản trực tiếp dùng UPSTASH_REDIS_REST_*. Hỗ trợ cả hai.
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    throw new Error(
      "Thiếu biến môi trường KV_REST_API_URL/KV_REST_API_TOKEN (hoặc UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN)."
    );
  }

  redisClient = new Redis({ url, token });
  return redisClient;
}

export async function getLecture(): Promise<Lecture | null> {
  const redis = getClient();
  const data = await redis.get<Lecture>(LECTURE_KEY);
  return data ?? null;
}

export async function setLecture(lecture: Lecture): Promise<void> {
  const redis = getClient();
  await redis.set(LECTURE_KEY, lecture);
}

export async function getQuestions(): Promise<Question[] | null> {
  const redis = getClient();
  const data = await redis.get<Question[]>(QUESTIONS_KEY);
  return data ?? null;
}

export async function setQuestions(questions: Question[]): Promise<void> {
  const redis = getClient();
  await redis.set(QUESTIONS_KEY, questions);
}

export interface ExamConfig {
  numChapters: number;
  questionsPerChapterInExam: number;
  fixedExam: boolean;
  allowRetake: boolean;
  /** 0 hoặc undefined (dữ liệu cũ) = không giới hạn thời gian. */
  timeLimitMinutes?: number;
}

export async function getExamConfig(): Promise<ExamConfig | null> {
  const redis = getClient();
  const data = await redis.get<ExamConfig>(EXAM_CONFIG_KEY);
  return data ?? null;
}

export async function setExamConfig(config: ExamConfig): Promise<void> {
  const redis = getClient();
  await redis.set(EXAM_CONFIG_KEY, config);
}

/** Tên sheet Google Sheets đang được dùng để lưu kết quả của bài giảng hiện tại. */
export async function getCurrentResultsSheet(): Promise<string | null> {
  const redis = getClient();
  const name = await redis.get<string>(CURRENT_RESULTS_SHEET_KEY);
  return name ?? null;
}

export async function setCurrentResultsSheet(sheetName: string): Promise<void> {
  const redis = getClient();
  await redis.set(CURRENT_RESULTS_SHEET_KEY, sheetName);
}

export interface UploadJob {
  status: "processing" | "done" | "failed";
  pastedText: string;
  extractedTexts: { name: string; text: string }[];
  uploadedFiles: UploadedFileRef[];
  numChapters: number;
  questionsPerChapterInExam: number;
  fixedExam: boolean;
  allowRetake: boolean;
  timeLimitMinutes: number;
  /** Bước còn lại: "lecture" | "extract:{chương}" | "q:{chương}:{số thứ tự lô trong chương}". */
  steps: string[];
  /** Số câu cần sinh cho mỗi bước "q:*" (khớp key với `steps`). */
  stepBatchSizes: Record<string, number>;
  totalSteps: number;
  lecture?: Omit<Lecture, "updatedAt">;
  /** Nội dung text đã tách riêng cho từng chương (key = số chương), dùng cho các lô câu hỏi thay vì
   * đọc lại toàn bộ tài liệu gốc mỗi lần. */
  chapterTexts: Record<number, string>;
  /** Kết quả từng lô câu hỏi đã sinh, key khớp với bước trong `steps`/`stepBatchSizes`. */
  questionBatches: Record<string, RawQuestion[]>;
  error?: string;
}

export async function saveUploadJob(jobId: string, job: UploadJob): Promise<void> {
  const redis = getClient();
  await redis.set(`${JOB_KEY_PREFIX}${jobId}`, job, { ex: JOB_TTL_SECONDS });
}

export async function getUploadJob(jobId: string): Promise<UploadJob | null> {
  const redis = getClient();
  const data = await redis.get<UploadJob>(`${JOB_KEY_PREFIX}${jobId}`);
  return data ?? null;
}

export async function deleteUploadJob(jobId: string): Promise<void> {
  const redis = getClient();
  await redis.del(`${JOB_KEY_PREFIX}${jobId}`);
}

/** Một lượt làm bài của sinh viên, tạo ở server khi sinh viên bấm bắt đầu. Server là nguồn tin cậy cho
 * thời điểm bắt đầu và danh sách câu hỏi (client không thể tự đổi giờ hay tự chọn câu để chấm). */
export interface QuizAttempt {
  attemptId: string;
  hoTen: string;
  lop: string;
  sheetName: string;
  startedAt: number;
  timeLimitSeconds: number;
  questionIds: string[];
  submitted: boolean;
}

const ATTEMPT_KEY_PREFIX = "tlhttm:attempt:";
const ATTEMPT_STUDENT_KEY_PREFIX = "tlhttm:attempt-student:";
const ATTEMPT_LOCK_KEY_PREFIX = "tlhttm:attempt-lock:";
const SUBMIT_LOCK_SECONDS = 120;

export function attemptTtlSeconds(timeLimitSeconds: number): number {
  return timeLimitSeconds > 0 ? timeLimitSeconds + 24 * 3600 : 7 * 24 * 3600;
}

export async function saveAttempt(attempt: QuizAttempt): Promise<void> {
  const redis = getClient();
  await redis.set(`${ATTEMPT_KEY_PREFIX}${attempt.attemptId}`, attempt, {
    ex: attemptTtlSeconds(attempt.timeLimitSeconds),
  });
}

export async function getAttempt(attemptId: string): Promise<QuizAttempt | null> {
  const redis = getClient();
  const data = await redis.get<QuizAttempt>(`${ATTEMPT_KEY_PREFIX}${attemptId}`);
  return data ?? null;
}

/** Chỉ mục "sinh viên -> lượt làm bài gần nhất" (theo từng sheet kết quả), dùng để cho tiếp tục lượt làm
 * dở và chặn bắt đầu lại để lấy thêm thời gian khi đề chỉ cho làm 1 lần. */
export async function getAttemptIdForStudent(sheetName: string, studentKey: string): Promise<string | null> {
  const redis = getClient();
  const id = await redis.get<string>(`${ATTEMPT_STUDENT_KEY_PREFIX}${sheetName}|${studentKey}`);
  return id ?? null;
}

/** Giành chỉ mục "sinh viên -> lượt làm bài" bằng SET NX; trả về id lượt đang giữ chỉ mục (của mình nếu thắng). */
export async function claimAttemptForStudent(
  sheetName: string,
  studentKey: string,
  attemptId: string,
  ttlSeconds: number
): Promise<string> {
  const redis = getClient();
  const key = `${ATTEMPT_STUDENT_KEY_PREFIX}${sheetName}|${studentKey}`;
  const res = await redis.set(key, attemptId, { nx: true, ex: ttlSeconds });
  if (res === "OK") return attemptId;
  return (await redis.get<string>(key)) ?? attemptId;
}

export async function deleteAttemptIdForStudent(sheetName: string, studentKey: string): Promise<void> {
  const redis = getClient();
  await redis.del(`${ATTEMPT_STUDENT_KEY_PREFIX}${sheetName}|${studentKey}`);
}

/** Khóa ngắn hạn chống nộp bài trùng cùng lúc cho 1 lượt (vd vừa tự động nộp khi hết giờ vừa bấm nộp tay). */
export async function acquireSubmitLock(attemptId: string): Promise<boolean> {
  const redis = getClient();
  const res = await redis.set(`${ATTEMPT_LOCK_KEY_PREFIX}${attemptId}`, "1", { nx: true, ex: SUBMIT_LOCK_SECONDS });
  return res === "OK";
}

export async function releaseSubmitLock(attemptId: string): Promise<void> {
  const redis = getClient();
  await redis.del(`${ATTEMPT_LOCK_KEY_PREFIX}${attemptId}`);
}
