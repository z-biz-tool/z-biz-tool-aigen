import { describe, expect, it } from "vitest";
import {
  ERROR_HINTS,
  errorHint,
  newRequestId,
  scrubSecrets,
  toGenError,
  wantsConfig,
} from "./genError";

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

/**
 * 「提示文案说去哪儿，界面就必须给那个入口」。
 *
 * 改造前 AUTH 的提示写着「请检查「API 配置」中的密钥」，而配置按钮只挂在
 * NO_CONFIG 上；AUTH 通常又不可重试 ⇒ 用户看到的只有一行说明和一个错误码标签。
 * 这种错位不报错、不崩溃，只是让人卡住，所以用测试钉住。
 */
describe("错误码 → 动作", () => {
  /** 与 src-tauri/src/error.rs 的 ErrorCode 常量一一对应。 */
  const RUST_CODES = [
    "NO_CONFIG",
    "AUTH",
    "RATE_LIMIT",
    "TIMEOUT",
    "PARSE",
    "CONTENT_POLICY",
    "CANCELLED",
    "NETWORK",
    "INVALID_PARAM",
    "UPSTREAM",
    "STORAGE",
    "CONFLICT",
  ];

  it("每个错误码都有提示，且不是只剩兜底那句", () => {
    for (const code of RUST_CODES) {
      const hint = errorHint(code);
      expect(hint, `${code} 缺提示`).toBeTruthy();
      if (code !== "CANCELLED") {
        // CANCELLED 是用户自己按的取消，落到兜底文案也说得过去
        expect(hint, `${code} 掉进了兜底文案`).not.toBe(ERROR_HINTS.UNKNOWN);
      }
    }
  });

  it("提示是一条动作，不是复述错误", () => {
    for (const [code, hint] of Object.entries(ERROR_HINTS)) {
      expect(hint.length, `${code} 的提示太敷衍`).toBeGreaterThanOrEqual(10);
    }
  });

  it("未知错误码退回兜底，不显示 undefined", () => {
    expect(errorHint("SOMETHING_NEW")).toBe(ERROR_HINTS.UNKNOWN);
    expect(errorHint("")).toBe(ERROR_HINTS.UNKNOWN);
  });

  it("配置类错误给入口：没配置 / 密钥无效 / 连不上", () => {
    for (const code of ["NO_CONFIG", "AUTH", "NETWORK"]) {
      expect(wantsConfig(code), `${code} 应该给配置入口`).toBe(true);
    }
  });

  it("不是配置问题的错误不给入口（别把人送去改不好的地方）", () => {
    for (const code of ["RATE_LIMIT", "CONTENT_POLICY", "TIMEOUT", "PARSE", "STORAGE", "UNKNOWN"]) {
      expect(wantsConfig(code), `${code} 不该给配置入口`).toBe(false);
    }
  });

  it("凡给了配置入口的码，提示里必须提到「配置」", () => {
    for (const code of RUST_CODES) {
      if (!wantsConfig(code)) continue;
      expect(errorHint(code), `${code} 的提示没提配置`).toContain("配置");
    }
  });
});
