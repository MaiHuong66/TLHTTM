function expectedUsername(): string {
  return process.env.TEACHER_USERNAME || "giangvien";
}

function expectedPassword(): string {
  return process.env.TEACHER_PASSWORD || "giangvien";
}

export function checkCredentials(username: string, password: string): boolean {
  return username === expectedUsername() && password === expectedPassword();
}

export function encodeToken(username: string, password: string): string {
  return Buffer.from(`${username}:${password}`, "utf8").toString("base64");
}

export function verifyAuthHeader(header: string | undefined | string[]): boolean {
  if (!header || Array.isArray(header) || !header.startsWith("Bearer ")) return false;
  const token = header.slice("Bearer ".length);
  try {
    const decoded = Buffer.from(token, "base64").toString("utf8");
    const idx = decoded.indexOf(":");
    if (idx === -1) return false;
    const username = decoded.slice(0, idx);
    const password = decoded.slice(idx + 1);
    return checkCredentials(username, password);
  } catch {
    return false;
  }
}
