import { describe, expect, it } from "vitest";
import { newRequestId, scrubSecrets, toGenError } from "./genError";

describe("toGenError：后端错误契约", () => {
  it("结构化错误原样取用（与 src-tauri/src/error.rs 对齐）", () => {
    const e = toGenError({ code: "RATE_LIMIT", message: "触发上游限流（429）", retryable: true });
    expect(e).toEqual({ code: "RATE_LIMIT", message: "触发上游限流（429）", retryable: true });
  });

  it("非结构化输入退化为 UNKNOWN 且可读", () => {
    expect(toGenError("boom")).toMatchObject({ code: "UNKNOWN", message: "boom", retryable: false });
    expect(toGenError(undefined).message).toBeTruthy();
    expect(toGenError(null).code).toBe("UNKNOWN");
  });

  it("缺失字段有兜底，不把 undefined 显示给用户", () => {
    const e = toGenError({ code: "TIMEOUT" });
    expect(e.code).toBe("TIMEOUT");
    expect(e.message).toBe("生成失败");
    expect(e.retryable).toBe(false);
  });

  it("retryable 只认真值", () => {
    expect(toGenError({ code: "X", message: "m", retryable: "truthy-string" }).retryable).toBe(true);
    expect(toGenError({ code: "X", message: "m", retryable: 0 }).retryable).toBe(false);
  });
});

describe("密钥不回显（04 §2.4 的前端半边）", () => {
  it("洗掉 sk- 与 Bearer 形态", () => {
    const out = scrubSecrets("auth failed sk-TEST-abcdef123456 via Bearer xyz789ABC");
    expect(out).not.toContain("abcdef123456");
    expect(out).not.toContain("xyz789ABC");
    expect(out).toContain("sk-****");
    expect(out).toContain("Bearer ***");
  });

  it("后端已脱敏的错误串再洗一层也不出错", () => {
    const e = toGenError({ code: "AUTH", message: "鉴权失败（401），密钥 sk-****9f3a 无效", retryable: false });
    expect(e.message).toContain("sk-****9f3a");
  });

  it("超长响应被截断，不把上游 body 整段带给用户", () => {
    const out = scrubSecrets("x".repeat(5000));
    expect(out.length).toBeLessThanOrEqual(281);
  });

  it("非字符串错误也能序列化出可读消息", () => {
    expect(toGenError({ nope: true }).message).toContain("nope");
  });
});

describe("newRequestId", () => {
  it("同进程内不重复", () => {
    const ids = new Set(Array.from({ length: 500 }, () => newRequestId()));
    expect(ids.size).toBe(500);
  });

  it("没有 crypto.randomUUID 时退化为可解析的字符串 id", () => {
    const desc = Object.getOwnPropertyDescriptor(globalThis, "crypto");
    Object.defineProperty(globalThis, "crypto", {
      value: {},
      configurable: true,
      writable: true,
    });
    try {
      const a = newRequestId();
      const b = newRequestId();
      expect(a.startsWith("req-")).toBe(true);
      expect(a).not.toBe(b);
    } finally {
      if (desc) Object.defineProperty(globalThis, "crypto", desc);
    }
    // 恢复后回到 uuid 路径
    expect(newRequestId()).toMatch(/^[0-9a-f-]{36}$/);
  });
});
