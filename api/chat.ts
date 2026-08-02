import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getLecture } from "./_lib/kv.js";
import { chatAboutLecture } from "./_lib/gemini.js";
import { friendlyErrorMessage, methodNotAllowed, sendError } from "./_lib/http.js";
import type { ChatMessage } from "../shared/types.js";

export const config = { maxDuration: 30 };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    methodNotAllowed(res, ["POST"]);
    return;
  }

  const { history } = (req.body ?? {}) as { history?: ChatMessage[] };

  if (!Array.isArray(history) || history.length === 0) {
    sendError(res, 400, "Thiếu nội dung hội thoại.");
    return;
  }
  if (history[history.length - 1]?.role !== "user") {
    sendError(res, 400, "Tin nhắn cuối cùng phải là của người dùng.");
    return;
  }

  try {
    const lecture = await getLecture();
    if (!lecture) {
      sendError(res, 404, "Chưa có bài giảng nào được tạo, chatbot chưa thể trả lời.");
      return;
    }

    const reply = await chatAboutLecture(lecture, history);
    res.status(200).json({ reply });
  } catch (err) {
    sendError(res, 500, friendlyErrorMessage(err));
  }
}
