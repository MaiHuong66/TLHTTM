import type { VercelRequest, VercelResponse } from "@vercel/node";
import { checkCredentials, encodeToken } from "./_lib/auth.js";
import { methodNotAllowed, sendError } from "./_lib/http.js";

export default function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    methodNotAllowed(res, ["POST"]);
    return;
  }

  const { username, password } = (req.body ?? {}) as { username?: string; password?: string };

  if (typeof username !== "string" || typeof password !== "string") {
    sendError(res, 400, "Vui lòng nhập tên đăng nhập và mật khẩu.");
    return;
  }

  if (!checkCredentials(username, password)) {
    sendError(res, 401, "Sai tên đăng nhập hoặc mật khẩu.");
    return;
  }

  res.status(200).json({ token: encodeToken(username, password) });
}
