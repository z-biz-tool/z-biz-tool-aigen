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

/** 错误码 → 用户可理解的降级指引（doc/优化方案/03 §7）。 */
export const ERROR_HINTS: Record<string, string> = {
  NO_CONFIG: "请先在「API 配置」中填写 Base URL 与密钥，保存后即可生成。",
  AUTH: "密钥无效或权限不足，请检查「API 配置」中的密钥。",
  RATE_LIMIT: "上游限流，已自动重试仍未成功，请稍后再试。",
  // UPSTREAM 才是 Rust 侧真正发出的码（error.rs::ErrorCode::UPSTREAM）。
  // 这里原先只写了 UPSTREAM_5XX —— 一个从来不会出现的码，
  // 于是上游 5xx 全部落到兜底的「生成失败，请重试」，用户读不出「不是你的问题」。
  UPSTREAM: "上游服务报错（5xx），不是你配错了 —— 稍后重试，或换个模型。",
  UPSTREAM_5XX: "上游服务暂时不可用，可稍后重试或更换模型。",
  TIMEOUT: "请求超时，请检查网络，或缩短提示词后重试。",
  PARSE: "上游返回结构异常，可重试；持续失败请更换模型。",
  CONTENT_POLICY: "提示词被上游内容安全策略拒绝，请调整描述。",
  NETWORK: "连不上上游服务。先确认「API 配置」里的 Base URL 是否写对、端口对不对，再看本机网络与代理。",
  INVALID_PARAM: "本次参数不被接受，请调整后重试。",
  STORAGE: "本地配置或产物写入失败，请检查磁盘权限。",
  CONFLICT: "目标文件已存在，确认后会覆盖它。",
  EXPORT: "导出失败，请换一个保存位置。",
  UNKNOWN: "生成失败，请重试或查看运行日志。",
};

export function errorHint(code: string): string {
  return ERROR_HINTS[code] ?? ERROR_HINTS.UNKNOWN;
}

/**
 * 这些错误码的「下一步」在 API 配置里 —— 界面必须给出那个入口。
 *
 * ## 为什么不能只写进提示文案
 *
 * 改造前只有 `NO_CONFIG` 会给「打开 API 配置」按钮，而 `AUTH` 的提示写的是
 * 「请检查「API 配置」中的密钥」—— 文案指了路，界面上却没有那个按钮。
 * 更糟的是 AUTH 通常 `retryable = false`：**重试按钮也没有**，
 * 于是用户看到的只有一行说明和一个 `AUTH` 标签，无处可去。
 *
 * NETWORK 同理：提示让人查 Base URL，那就得让人点得到地址那一栏。
 */
const CONFIG_CODES = new Set(["NO_CONFIG", "AUTH", "NETWORK"]);

export function wantsConfig(code: string): boolean {
  return CONFIG_CODES.has(code);
}
