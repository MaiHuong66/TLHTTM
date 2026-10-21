import Anthropic, { toFile } from "@anthropic-ai/sdk";
import type { BetaContentBlockParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { withRetry } from "./retry.js";

// Mặc định dùng model nhanh và rẻ nhất; đổi bằng biến môi trường CLAUDE_MODEL (vd claude-sonnet-5-5).
const MODEL = process.env.CLAUDE_MODEL?.trim() || "claude-haiku-5-5";
const BETAS = ["files-api-2025-04-14"];

let client: Anthropic | null = null;

function getClient(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "Thiếu biến môi trường ANTHROPIC_API_KEY. Vui lòng cấu hình trong Vercel Environment Variables."
    );
  }
  if (!client) {
    // maxRetries: 0 vì việc thử lại do withRetry quản lý (có tính tới trần 60s); timeout 50s để lỗi trả về
    // trước khi Vercel ngắt hàm — client sẽ tự gọi lại đúng bước đó.
    client = new Anthropic({ apiKey, maxRetries: 0, timeout: 50_000 });
  }
  return client;
}

export interface ClaudeFileRef {
  name: string;
  mimeType: string;
  /** file_id của Claude Files API. */
  uri: string;
}

export type ClaudePart = { text: string } | { file: ClaudeFileRef } | { cacheBreakpoint: true };

export interface ClaudeMessage {
  role: "user" | "assistant";
  parts: ClaudePart[];
}

export interface ClaudeRequest {
  system?: string;
  messages: ClaudeMessage[];
  /** JSON Schema (type viết thường) của kết quả; nếu có, Claude bị buộc trả về đúng cấu trúc này qua tool. */
  schema?: Record<string, unknown>;
  maxTokens: number;
}

export interface ClaudeResult {
  text: string;
  json: unknown;
  truncated: boolean;
}

/** Tải file lên Claude Files API đúng 1 lần để các bước sau chỉ tham chiếu bằng file_id (không gửi lại base64). */
export async function claudeUploadFiles(
  files: { name: string; mimeType: string; base64: string }[]
): Promise<ClaudeFileRef[]> {
  if (files.length === 0) return [];
  const ai = getClient();
  return Promise.all(
    files.map(async (f) => {
      const buffer = Buffer.from(f.base64, "base64");
      const uploaded = await withRetry(async () =>
        ai.beta.files.upload({
          file: await toFile(buffer, f.name, { type: f.mimeType }),
          // Chỉ cần dùng trong lúc xử lý job (TTL job 15 phút) — để file tự hết hạn sau 1 giờ.
          expires_in_seconds: 3600,
          betas: BETAS,
        })
      );
      return { name: f.name, mimeType: f.mimeType, uri: uploaded.id };
    })
  );
}

function toBlocks(parts: ClaudePart[]): BetaContentBlockParam[] {
  const blocks: BetaContentBlockParam[] = [];
  for (const part of parts) {
    if ("cacheBreakpoint" in part) {
      // Đánh dấu cache ở khối liền trước: nội dung tài liệu giống hệt giữa các bước nên các lần gọi sau
      // đọc lại với giá rẻ hơn nhiều.
      const last = blocks[blocks.length - 1] as { cache_control?: { type: "ephemeral" } } | undefined;
      if (last) last.cache_control = { type: "ephemeral" };
    } else if ("text" in part) {
      if (part.text) blocks.push({ type: "text", text: part.text });
    } else if (part.file.mimeType === "application/pdf") {
      blocks.push({ type: "document", source: { type: "file", file_id: part.file.uri }, title: part.file.name });
    } else {
      blocks.push({ type: "image", source: { type: "file", file_id: part.file.uri } });
    }
  }
  return blocks;
}

/** Chuyển schema kiểu Gemini (type viết hoa: OBJECT/STRING/ARRAY...) sang JSON Schema chuẩn (viết thường). */
export function toJsonSchema(schema: unknown): Record<string, unknown> {
  const convert = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(convert);
    if (node && typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node)) {
        out[k] = k === "type" && typeof v === "string" ? v.toLowerCase() : convert(v);
      }
      return out;
    }
    return node;
  };
  return convert(schema) as Record<string, unknown>;
}

export async function claudeGenerate(req: ClaudeRequest): Promise<ClaudeResult> {
  const ai = getClient();

  // Input của tool phải là object: nếu schema gốc là mảng thì bọc lại rồi bóc ra khi nhận kết quả.
  const wrapped = req.schema?.type === "array";
  const inputSchema = req.schema
    ? wrapped
      ? { type: "object", properties: { items: req.schema }, required: ["items"] }
      : req.schema
    : undefined;

  const response = await withRetry(() =>
    ai.beta.messages.create({
      model: MODEL,
      max_tokens: req.maxTokens,
      system: req.system,
      messages: req.messages.map((m) => ({ role: m.role, content: toBlocks(m.parts) })),
      betas: BETAS,
      ...(inputSchema
        ? {
            tools: [
              {
                name: "submit_result",
                description: "Trả về kết quả cuối cùng đúng cấu trúc yêu cầu.",
                input_schema: inputSchema as { type: "object" },
              },
            ],
            tool_choice: { type: "tool" as const, name: "submit_result" },
          }
        : {}),
    })
  );

  const truncated = response.stop_reason === "max_tokens";
  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { text: string }).text)
    .join("")
    .trim();

  let json: unknown = undefined;
  const toolBlock = response.content.find((b) => b.type === "tool_use") as { input?: unknown } | undefined;
  if (toolBlock) {
    const input = toolBlock.input as Record<string, unknown> | undefined;
    json = wrapped ? input?.items : input;
  }

  return { text, json, truncated };
}
