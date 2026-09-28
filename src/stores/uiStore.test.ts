import { beforeEach, describe, expect, it, vi } from "vitest";
import { CAPS, DRAFT_VERSION, capStr, createSafeStorage, isQuotaError } from "../_shared/safeStorage";
import { DEFAULT_CRAFT, MODE_ORDER, normalizeCraft, useUiStore } from "./uiStore";

const KEY = "aigen.craft.v1";

const base = (over: Record<string, unknown>) => ({ version: DRAFT_VERSION, ...over });

describe("normalizeCraft", () => {
  it("空/脏载荷一律回到默认，绝不抛", () => {
    for (const raw of [null, undefined, "x", 42, [], {}]) {
      expect(normalizeCraft(raw).mode).toBe("image");
      expect(normalizeCraft(raw).forms.text.temperature).toBe(0.7);
    }
  });

  it("版本不符就整体作废（旧 payload 不能带进新版本）", () => {
    expect(normalizeCraft({ version: 0, mode: "ppt" }).mode).toBe("image");
    expect(normalizeCraft({ mode: "ppt" }).mode).toBe("image");
  });

  it("认识的值原样回来，不认识的值被铸回默认", () => {
    const got = normalizeCraft(
      base({ mode: "batch", forms: { text: { model: "m1", temperature: 1.4, maxTokens: null } } })
    );
    expect(got.mode).toBe("batch");
    expect(got.forms.text).toEqual({ model: "m1", system: "", temperature: 1.4, maxTokens: null });
    expect(normalizeCraft(base({ mode: "nope" })).mode).toBe("image");
    expect(normalizeCraft(base({ mode: 3 })).mode).toBe("image");
  });

  it("数字越界被夹住，非数字回默认", () => {
    const got = normalizeCraft(base({ forms: { image: { count: 99 }, ppt: { slides: -3 } } }));
    expect(got.forms.image.count).toBe(4);
    expect(got.forms.ppt.slides).toBe(1);
    expect(normalizeCraft(base({ forms: { image: { count: "abc" } } })).forms.image.count).toBe(1);
    expect(
      normalizeCraft(base({ forms: { text: { temperature: "NaN" } } })).forms.text.temperature
    ).toBe(0.7);
  });

  it("超长草稿被截断，大纲条数有上限", () => {
    const got = normalizeCraft(
      base({
        prompts: { text: "字".repeat(50000) },
        forms: {
          text: { system: "s".repeat(9000) },
          batch: { raw: "r".repeat(9000), kind: "gpt" },
          ppt: {
            outline: Array.from({ length: 200 }, (_, i) => ({
              id: i,
              title: "t".repeat(500),
              content: "c".repeat(5000),
            })),
          },
        },
      })
    );
    expect(Array.from(got.prompts.text).length).toBe(CAPS.prompt);
    expect(Array.from(got.forms.text.system).length).toBe(CAPS.system);
    expect(Array.from(got.forms.batch.raw).length).toBe(CAPS.prompt);
    expect(got.forms.batch.kind).toBe("text");
    expect(got.forms.ppt.outline).toHaveLength(CAPS.outlineItems);
    expect(got.forms.ppt.outline[0].content).toHaveLength(CAPS.outlineContent);
  });

  it("emoji 提示词不被截成半个代理对", () => {
    const withEmoji = "🐑".repeat(CAPS.prompt + 10);
    expect(Array.from(normalizeCraft(base({ prompts: { image: withEmoji } })).prompts.image).length).toBe(
      CAPS.prompt
    );
    expect(normalizeCraft(base({ prompts: { image: "🐑🐑" } })).prompts.image).toBe("🐑🐑");
  });

  it("空白标识字段回默认值并顺手去空格，outline 空数组回一行空白页", () => {
    const got = normalizeCraft(
      base({ forms: { image: { model: "   ", size: "" }, text: { model: "  gpt-4o  " } , ppt: { outline: [] } } })
    );
    expect(got.forms.image.model).toBe(DEFAULT_CRAFT.forms.image.model);
    expect(got.forms.text.model).toBe("gpt-4o");
    expect(got.forms.ppt.outline).toEqual([{ id: 1, title: "", content: "" }]);
    // 用户写的正文不 trim，末尾空格是内容
    expect(normalizeCraft(base({ prompts: { image: " 一只猫 " } })).prompts.image).toBe(" 一只猫 ");
  });

  it("五个模式都有对应的 ⌘ 序号位", () => {
    expect(MODE_ORDER).toEqual(["image", "video", "ppt", "text", "batch"]);
  });
});

describe("草稿持久化", () => {
  beforeEach(() => {
    localStorage.clear();
    useUiStore.setState({ ...DEFAULT_CRAFT, forms: structuredClone(DEFAULT_CRAFT.forms) });
  });

  it("模式与表单写穿到 localStorage，重读回来同一个形状", () => {
    const s = useUiStore.getState();
    s.setMode("ppt");
    s.setForm("ppt", "slides", 18);
    s.setPromptDraft("ppt", "第三幕：雨夜");
    const raw = localStorage.getItem(KEY);
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw as string) as { state: unknown };
    expect(normalizeCraft(parsed.state).mode).toBe("ppt");
    expect(normalizeCraft(parsed.state).forms.ppt.slides).toBe(18);
    expect(normalizeCraft(parsed.state).prompts.ppt).toBe("第三幕：雨夜");
  });

  it("落盘载荷不含任何密钥形状字段", () => {
    useUiStore.getState().setMode("text");
    const raw = localStorage.getItem(KEY) ?? "";
    for (const banned of ["api_key", "apiKey", "sk-", "Bearer", "provider", "base_url"]) {
      expect(raw.toLowerCase()).not.toContain(banned.toLowerCase());
    }
  });

  it("5 万字提示词不会把配额打爆：截断后仍然可解析", () => {
    useUiStore.getState().setPromptDraft("text", "写".repeat(50000));
    const raw = localStorage.getItem(KEY) ?? "";
    expect(raw.length).toBeLessThan(20000);
    expect(normalizeCraft(JSON.parse(raw).state).prompts.text).toHaveLength(CAPS.prompt);
  });

  it("⌘⇧N 的 resetKind 只擦当前模式，其它模式草稿不动", () => {
    const s = useUiStore.getState();
    s.setPromptDraft("text", "留下");
    s.setPromptDraft("image", "擦掉");
    s.setForm("image", "count", 3);
    s.resetKind("image");
    const after = useUiStore.getState();
    expect(after.prompts.image).toBe("");
    expect(after.prompts.text).toBe("留下");
    expect(after.forms.image.count).toBe(1);
    s.resetKind("batch");
    expect(useUiStore.getState().forms.batch.kind).toBe("text");
  });

  it("同版本的脏载荷经 rehydrate 被重铸，不会带伤启动", () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        state: {
          version: DRAFT_VERSION,
          mode: "乱来的模式",
          forms: { image: { count: "abc", model: "   " }, ppt: { outline: "不是数组" } },
          prompts: { text: "x".repeat(99999) },
        },
        version: DRAFT_VERSION,
      })
    );
    useUiStore.persist.rehydrate();
    const s = useUiStore.getState();
    expect(s.mode).toBe("image");
    expect(s.forms.image.count).toBe(1);
    expect(s.forms.image.model).toBe(DEFAULT_CRAFT.forms.image.model);
    expect(s.forms.ppt.outline).toHaveLength(1);
    expect(Array.from(s.prompts.text).length).toBeLessThanOrEqual(CAPS.prompt);
    // 持久化只覆盖数据，不能把动作函数冲掉
    expect(typeof s.setMode).toBe("function");
  });
});

describe("safeStorage 配额兜底", () => {
  it("识别三种浏览器口味的配额错误", () => {
    expect(isQuotaError(new Error("QuotaExceededError"))).toBe(true);
    expect(isQuotaError({ name: "NS_ERROR_DOM_QUOTA_REACHED", message: "" })).toBe(true);
    const e = new Error("exceeded");
    e.name = "QuotaExceededError";
    expect(isQuotaError(e)).toBe(true);
    expect(isQuotaError(new Error("boom"))).toBe(false);
  });

  it("写失败先降级到更小的快照，全失败就删键而不是崩", () => {
    const storage = createSafeStorage(() => ["SMALL", "SMALLEST"]);
    const attempts: string[] = [];
    const spy = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation((_key: string, value: string) => {
        attempts.push(value);
        if (value.length > 2) throw new Error("QuotaExceededError");
      });
    storage.setItem("k", "BIG PAYLOAD");
    expect(attempts).toEqual(["BIG PAYLOAD", "SMALL", "SMALLEST"]);
    spy.mockRestore();

    const alwaysFails = createSafeStorage(() => ["x"]);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    const removed = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {});
    expect(() => alwaysFails.setItem("k", "y")).not.toThrow();
    expect(removed).toHaveBeenCalledWith("k");
  });

  it("storage 不可用（隐私模式）时读写都静默退回", () => {
    const storage = createSafeStorage();
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    expect(storage.getItem("k")).toBeNull();
    expect(() => storage.setItem("k", "v")).not.toThrow();
    expect(() => storage.removeItem("k")).not.toThrow();
  });

  it("capStr 对非字符串一律给空串", () => {
    expect(capStr(null, 10)).toBe("");
    expect(capStr(42, 10)).toBe("");
    expect(capStr({ a: 1 }, 10)).toBe("");
    expect(capStr("abc", 2)).toBe("ab");
  });
});
