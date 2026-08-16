import { Redis } from "@upstash/redis";
import type { Lecture, Question } from "../../shared/types.js";
import type { RawQuestion, UploadedFileRef } from "./gemini.js";

const LECTURE_KEY = "tlhttm:lecture";
const QUESTIONS_KEY = "tlhttm:questions";
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
  steps: string[];
  totalSteps: number;
  lecture?: Omit<Lecture, "updatedAt">;
  questionBatches: RawQuestion[][];
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
