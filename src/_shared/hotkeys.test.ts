import { describe, expect, it, vi } from "vitest";
import {
  dispatchHotkey,
  hotkeyLabel,
  matchHotkey,
  type KeyEventLike,
} from "./hotkeys";

const k = (over: Partial<KeyEventLike>): KeyEventLike => ({
  key: "Enter",
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...over,
});

describe("matchHotkey", () => {
  it("mac 只认 ⌘，Windows 只认 Ctrl", () => {
    expect(matchHotkey(k({ metaKey: true }), true)?.action).toBe("generate");
    expect(matchHotkey(k({ ctrlKey: true }), true)).toBeNull();
    expect(matchHotkey(k({ ctrlKey: true }), false)?.action).toBe("generate");
    expect(matchHotkey(k({ metaKey: true }), false)).toBeNull();
  });

  it("修饰键齐全：生成/取消/导出/新草稿/服务商/帮助", () => {
    const mac = (o: Partial<KeyEventLike>) => matchHotkey(k(o), true);
    expect(mac({ metaKey: true, key: "." })?.action).toBe("cancel");
    expect(mac({ metaKey: true, key: "s" })?.action).toBe("export");
    expect(mac({ metaKey: true, key: "S", shiftKey: true })?.action).toBe("export");
    expect(mac({ metaKey: true, key: "n", shiftKey: true })?.action).toBe("newDraft");
    expect(mac({ metaKey: true, key: "p", shiftKey: true })?.action).toBe("provider");
    expect(mac({ metaKey: true, key: "/" })?.action).toBe("help");
  });

  it("⌘1..5 切模式，带 Shift 的数字不劫持", () => {
    expect(matchHotkey(k({ metaKey: true, key: "3" }), true)).toEqual({ action: "mode", index: 2 });
    expect(matchHotkey(k({ metaKey: true, key: "6" }), true)).toBeNull();
    expect(matchHotkey(k({ metaKey: true, key: "1", shiftKey: true }), true)).toBeNull();
  });

  it("裸键与 Alt 组合一律放行（打字与系统快捷键不属于我们）", () => {
    expect(matchHotkey(k({}), true)).toBeNull();
    expect(matchHotkey(k({ metaKey: true, altKey: true, key: "Enter" }), true)).toBeNull();
    // Esc 交回 AntD 的 Drawer/Modal
    expect(matchHotkey(k({ key: "Escape" }), true)).toBeNull();
  });

  it("Enter 在小写归一后仍命中（部分布局给出 'Enter'）", () => {
    expect(matchHotkey(k({ metaKey: true, key: "Enter" }), true)?.action).toBe("generate");
  });
});

describe("dispatchHotkey", () => {
  it("面板动作没人实现时走 fallback 提示", () => {
    const fb = vi.fn();
    expect(dispatchHotkey({ action: "generate" }, fb)).toBe(false);
    expect(fb).toHaveBeenCalled();
  });

  it("mode/provider/help 始终由 App 兜底消费", () => {
    const fb = vi.fn();
    expect(dispatchHotkey({ action: "mode", index: 4 }, fb)).toBe(true);
    expect(fb).toHaveBeenCalledWith({ action: "mode", index: 4 });
  });

  it("没有任何面板作用域时，导出动作也不会误触发 App 的 mode 兜底", () => {
    const fb = vi.fn();
    expect(dispatchHotkey({ action: "export" }, fb)).toBe(false);
    expect(fb).toHaveBeenCalled();
  });
});

describe("hotkeyLabel", () => {
  it("mac 用符号、其它用 Ctrl+", () => {
    expect(hotkeyLabel("generate", true)).toBe("⌘⏎");
    expect(hotkeyLabel("provider", true)).toBe("⌘⇧P");
    expect(hotkeyLabel("generate", false)).toBe("Ctrl+Enter");
    expect(hotkeyLabel("cancel", false)).toBe("Ctrl+.");
  });
});
