import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getLecture } from "./_lib/kv.js";
import { friendlyErrorMessage, methodNotAllowed, sendError } from "./_lib/http.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    methodNotAllowed(res, ["GET"]);
    return;
  }

  try {
    const lecture = await getLecture();
    res.status(200).json({ lecture });
  } catch (err) {
    sendError(res, 500, friendlyErrorMessage(err));
  }
}
