import type {
  AnswerKey,
  ApiErrorBody,
  ChatMessage,
  Lecture,
  QuizQuestion,
  ResultRow,
  StartUploadResponse,
  SubmitTestResponse,
  UploadFilePayload,
  UploadStepResponse,
} from "../../shared/types";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, options);
  } catch {
    throw new ApiError(0, "Không thể kết nối máy chủ. Vui lòng kiểm tra kết nối mạng và thử lại.");
  }

  const data = await res.json().catch(() => null);

  if (!res.ok) {
    const message = (data as ApiErrorBody | null)?.error || `Đã xảy ra lỗi (mã ${res.status}).`;
    throw new ApiError(res.status, message);
  }
  if (data === null) {
    throw new ApiError(res.status, "Phản hồi từ máy chủ không hợp lệ. Vui lòng thử lại.");
  }
  return data as T;
}

function authHeaders(token: string): HeadersInit {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

export function teacherLogin(username: string, password: string): Promise<{ token: string }> {
  return request("/api/teacher-login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
}

export function startUpload(
  token: string,
  pastedText: string,
  files: UploadFilePayload[]
): Promise<StartUploadResponse> {
  return request("/api/upload-document", {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ pastedText, files }),
  });
}

export function processUploadStep(token: string, jobId: string): Promise<UploadStepResponse> {
  return request("/api/upload-step", {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ jobId }),
  });
}

export function fetchLecture(): Promise<{ lecture: Lecture | null }> {
  return request("/api/get-lecture");
}

export function fetchQuiz(): Promise<{ questions: QuizQuestion[] }> {
  return request("/api/get-quiz");
}

export function submitTest(
  hoTen: string,
  lop: string,
  questionIds: string[],
  answers: Record<string, AnswerKey>
): Promise<SubmitTestResponse> {
  return request("/api/submit-test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hoTen, lop, questionIds, answers }),
  });
}

export function sendChatMessage(history: ChatMessage[]): Promise<{ reply: string }> {
  return request("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ history }),
  });
}

export function fetchResults(token: string): Promise<{ results: ResultRow[] }> {
  return request("/api/get-results", {
    headers: authHeaders(token),
  });
}
