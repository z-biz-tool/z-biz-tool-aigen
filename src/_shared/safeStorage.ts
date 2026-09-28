/**
 * localStorage 安全落盘（doc/优化方案/03 §9 交互态持久化的底座）。
 *
 * 三条硬约束：
 * - 读永远不抛：脏 JSON / 隐私模式禁用 storage 时退回 null，让应用照常启动
 * - 写永远不抛：配额满（QuotaExceededError）退化为「只留模式」的最小快照
 * - 体积上限：草稿字段先截断再落盘，5 万字的提示词不该吃掉整个配额
 */

import type { StateStorage } from "zustand/middleware";

/** 草稿结构版本；改形状就 +1，migrate 里按版本重规范化 */
export const DRAFT_VERSION = 1;

/** 单字段截断上限（字符） */
export const CAPS = {
  prompt: 6000,
  system: 1500,
  negative: 400,
  short: 64,
  outlineTitle: 120,
  outlineContent: 600,
  outlineItems: 24,
} as const;

export function capStr(v: unknown, max: number): string {
  if (typeof v !== "string") return "";
  // 按码点截：直接 slice 会把 emoji 代理对劈成半个字符
  return Array.from(v).slice(0, max).join("");
}

export function capNum(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Safari 抛 QUOTA_EXCEEDED_ERR，Firefox 抛 NS_ERROR_DOM_QUOTA_REACHED */
export function isQuotaError(e: unknown): boolean {
  const name = (e as { name?: string } | null)?.name ?? "";
  return /quota|storage/i.test(`${name} ${e instanceof Error ? e.message : String(e ?? "")}`);
}

/**
 * 带配额兜底的 StateStorage。写失败时先按 fallbacks 依次降级，
 * 全失败就删除键位——界面照常工作，只是下次启动回到默认模式。
 */
export function createSafeStorage(getFallbacks?: () => string[]): StateStorage {
  return {
    getItem(name) {
      try {
        return localStorage.getItem(name);
      } catch {
        return null;
      }
    },
    setItem(name, value) {
      try {
        localStorage.setItem(name, value);
        return;
      } catch (e) {
        if (!isQuotaError(e)) return;
      }
      for (const smaller of getFallbacks?.() ?? []) {
        try {
          localStorage.setItem(name, smaller);
          return;
        } catch {
          // 继续降级
        }
      }
      try {
        localStorage.removeItem(name);
      } catch {
        // 存储不可用：放弃持久化，不影响本次会话
      }
    },
    removeItem(name) {
      try {
        localStorage.removeItem(name);
      } catch {
        // 同上
      }
    },
  };
}
