import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getExamConfig } from "./_lib/kv.js";
import { friendlyErrorMessage, methodNotAllowed, sendError } from "./_lib/http.js";
import type { ExamInfo } from "../shared/types.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    methodNotAllowed(res, ["GET"]);
    return;
  }

  try {
    const examConfig = await getExamConfig();
    const info: ExamInfo = {
      fixedExam: examConfig?.fixedExam ?? false,
      allowRetake: examConfig?.allowRetake ?? false,
    };
    res.status(200).json(info);
  } catch (err) {
    sendError(res, 500, friendlyErrorMessage(err));
  }
}
