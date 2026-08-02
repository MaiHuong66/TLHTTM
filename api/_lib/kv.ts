import { Redis } from "@upstash/redis";
import type { Lecture, Question } from "../../shared/types.js";

const LECTURE_KEY = "tlhttm:lecture";
const QUESTIONS_KEY = "tlhttm:questions";

let redisClient: Redis | null = null;

function getClient(): Redis {
  if (redisClient) return redisClient;

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    throw new Error(
      "Thiếu biến môi trường UPSTASH_REDIS_REST_URL hoặc UPSTASH_REDIS_REST_TOKEN."
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
