/** 生成任务的错误契约与工具（与 src-tauri/src/error.rs 对齐）。 */

export interface GenErrorPayload {
  code: string;
  message: string;
  retryable: boolean;
}

export function newRequestId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c?.randomUUID) return c.randomUUID();
  return `req-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/** 兜底脱敏：后端已保证不回显密钥，这里再挡一层非结构化错误串。 */
export function scrubSecrets(text: string): string {
  return text
    .replace(/sk-[A-Za-z0-9_-]{4,}/g, "sk-****")
    .replace(/Bearer\s+\S+/gi, "Bearer ***")
    .slice(0, 280);
}

export function toGenError(e: unknown): GenErrorPayload {
  if (e && typeof e === "object" && "code" in e) {
    const o = e as Record<string, unknown>;
    return {
      code: String(o.code ?? "UNKNOWN"),
      message: scrubSecrets(String(o.message ?? "生成失败")),
      retryable: Boolean(o.retryable),
    };
  }
  return {
    code: "UNKNOWN",
    message: scrubSecrets(typeof e === "string" ? e : JSON.stringify(e ?? "")) || "生成失败",
    retryable: false,
  };
}
