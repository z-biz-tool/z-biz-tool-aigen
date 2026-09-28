/**
 * 全局快捷键（对齐 fleet 标准：一个 window keydown 监听 + 保存最新回调的 ref）。
 *
 * 关键点：
 * - 监听只在 App 挂载时装一次，动作从作用域栈取最新实现，改 state 不会摘装监听。
 * - 全部键位都带 ⌘/Ctrl，所以输入框里也必须生效（提示框正是敲键的地方）；
 *   非修饰键组合留给浏览器/AntD，打字时不劫持（见 matchHotkey 的 mod 前置判断）。
 * - Esc 交回 AntD：Drawer/Modal 默认 keyboard=true 自行关闭，全局层不抢。
 */

import { useEffect, useRef } from "react";

/** 面板可注册的动作；App 兜底处理 mode/provider/help/newDraft */
export type PanelAction = "generate" | "cancel" | "export";
export type HotkeyAction = PanelAction | "mode" | "provider" | "newDraft" | "help";

export interface HotkeyMatch {
  action: HotkeyAction;
  /** action === "mode" 时是 MODE_ORDER 下标 */
  index?: number;
}

export interface KeyEventLike {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  repeat?: boolean;
}

export function isMacPlatform(): boolean {
  const p = (globalThis.navigator?.platform ?? globalThis.navigator?.userAgent ?? "").toLowerCase();
  return /mac|iphone|ipad/.test(p);
}

/** 纯函数：键盘事件 → 键位语义。非修饰键组合一律返回 null（不干扰打字）。 */
export function matchHotkey(e: KeyEventLike, isMac = isMacPlatform()): HotkeyMatch | null {
  // ⌘(mac) / Ctrl(其它)；另一侧的修饰键不算命中，避免 Windows 上误触开始菜单键
  const mod = isMac ? e.metaKey : e.ctrlKey;
  if (!mod || e.altKey) return null;
  const k = e.key.toLowerCase();
  // Enter 的 e.key 在部分键盘布局是 "Enter"，小写后仍是 "enter"
  if (k === "enter") return { action: "generate" };
  if (k === "s") return { action: "export" };
  if (k === ".") return { action: "cancel" };
  if (k === "n" && e.shiftKey) return { action: "newDraft" };
  if (k === "p" && e.shiftKey) return { action: "provider" };
  if (k === "/") return { action: "help" };
  if (!e.shiftKey && /^[1-5]$/.test(k)) return { action: "mode", index: Number(k) - 1 };
  return null;
}

const MAC_SYMBOLS: Record<string, string> = {
  generate: "⌘⏎",
  export: "⌘S",
  cancel: "⌘.",
  newDraft: "⌘⇧N",
  provider: "⌘⇧P",
  help: "⌘/",
};
const OTHER_SYMBOLS: Record<string, string> = {
  generate: "Ctrl+Enter",
  export: "Ctrl+S",
  cancel: "Ctrl+.",
  newDraft: "Ctrl+Shift+N",
  provider: "Ctrl+Shift+P",
  help: "Ctrl+/",
};

/** 界面提示用（按钮 tooltip、快捷键弹窗） */
export function hotkeyLabel(action: keyof typeof MAC_SYMBOLS, isMac = isMacPlatform()): string {
  return (isMac ? MAC_SYMBOLS : OTHER_SYMBOLS)[action];
}

export function modeHotkeyLabel(index: number, isMac = isMacPlatform()): string {
  return isMac ? `⌘${index + 1}` : `Ctrl+${index + 1}`;
}

export type HotkeyScope = Partial<Record<PanelAction, () => void>>;

type ScopeEntry = { get: () => HotkeyScope };
const stack: ScopeEntry[] = [];

/**
 * 由内向外找第一个实现了该动作的面板；都没实现则交给 fallback。
 * 返回是否被消费，供监听决定是否 preventDefault（其实键位已被 matchHotkey 收窄）。
 */
export function dispatchHotkey(match: HotkeyMatch, fallback?: (m: HotkeyMatch) => void): boolean {
  if (match.action === "mode" || match.action === "provider" || match.action === "help") {
    fallback?.(match);
    return true;
  }
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    const handler = stack[i].get()[match.action as PanelAction];
    if (handler) {
      handler();
      return true;
    }
  }
  fallback?.(match);
  return false;
}

/** 面板用：注册当前可执行的生成/取消/导出，回调每轮渲染刷新，监听不重挂 */
export function useHotkeyScope(scope: HotkeyScope): void {
  const ref = useRef<HotkeyScope>(scope);
  ref.current = scope;
  useEffect(() => {
    const entry: ScopeEntry = { get: () => ref.current };
    stack.push(entry);
    return () => {
      const i = stack.indexOf(entry);
      if (i >= 0) stack.splice(i, 1);
    };
  }, []);
}

/** App 用：整个应用只装这一个监听 */
export function installHotkeys(onMatch: (m: HotkeyMatch) => void): () => void {
  const onKey = (e: KeyboardEvent) => {
    if (e.repeat) return;
    const match = matchHotkey(e);
    if (!match) return;
    e.preventDefault();
    dispatchHotkey(match, onMatch);
  };
  window.addEventListener("keydown", onKey);
  return () => window.removeEventListener("keydown", onKey);
}
