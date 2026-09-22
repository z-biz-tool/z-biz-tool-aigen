/**
 * 批量生成队列（doc/优化方案/02 §7、03 §8，任务 T-Batch）。
 *
 * 并发不在前端限流：上游并发由 Rust 的全局闸门（03 §8，容量 2）统一管，
 * 这里只负责逐条下发、显示每条状态、支持单条重试/取消与整体进度。
 */

import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { newRequestId, toGenError, type GenErrorPayload } from "../_shared/genError";
import type { GenKind } from "./generationStore";

export type BatchStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface BatchItem {
  key: string;
  prompt: string;
  kind: GenKind;
  cmd: string;
  status: BatchStatus;
  requestId: string | null;
  result: string | null;
  error: GenErrorPayload | null;
  startedAt: number | null;
  durationMs: number | null;
}

interface BatchStore {
  items: BatchItem[];
  running: boolean;
  /** 一次提交的整批任务；返回前不阻塞界面（每条各自 await 自己的 invoke） */
  start: (kind: GenKind, cmd: string, prompts: string[], args: Record<string, unknown>) => void;
  retry: (key: string) => void;
  cancel: (key: string) => void;
  cancelAll: () => void;
  clear: () => void;
  succeeded: () => number;
  finished: () => number;
}

let seq = 0;

const patch = (
  set: (fn: (s: BatchStore) => Partial<BatchStore>) => void,
  key: string,
  next: Partial<BatchItem>
) =>
  set((s) => ({
    items: s.items.map((it) => (it.key === key ? { ...it, ...next } : it)),
  }));

export const useBatchStore = create<BatchStore>((set, get) => {
  const runOne = async (key: string) => {
    const item = get().items.find((i) => i.key === key);
    if (!item) return;
    const requestId = newRequestId();
    patch(set, key, {
      status: "running",
      requestId,
      error: null,
      result: null,
      startedAt: Date.now(),
    });
    try {
      const res = await invoke<unknown>(item.cmd, {
        ...itemArgs(item),
        prompt: item.prompt,
        requestId,
      });
      const elapsed = Date.now() - (get().items.find((i) => i.key === key)?.startedAt ?? Date.now());
      const stillSame = get().items.find((i) => i.key === key)?.requestId === requestId;
      if (!stillSame) return;
      patch(set, key, {
        status: "succeeded",
        result: typeof res === "string" ? res : JSON.stringify(res),
        requestId: null,
        durationMs: elapsed,
      });
    } catch (e) {
      const payload = toGenError(e);
      const stillSame = get().items.find((i) => i.key === key)?.requestId === requestId;
      if (!stillSame) return;
      if (payload.code === "CANCELLED") {
        patch(set, key, { status: "cancelled", requestId: null, error: null });
        return;
      }
      patch(set, key, { status: "failed", error: payload, requestId: null });
    }
    // 整批收尾：没有 running/queued 就解锁界面
    const left = get().items.some((i) => i.status === "running" || i.status === "queued");
    if (!left) set({ running: false });
  };

  return {
    items: [],
    running: false,

    start: (kind, cmd, prompts, args) => {
      const items: BatchItem[] = prompts.map((prompt, i) => ({
        key: `b${++seq}-${i}`,
        prompt,
        kind,
        cmd,
        status: "queued" as BatchStatus,
        requestId: null,
        result: null,
        error: null,
        startedAt: null,
        durationMs: null,
      }));
      // 整批共用同一组模型/尺寸等参数，单条重试也沿用这份
      BATCH_ARGS.set(kind, args);
      set({ items, running: true });
      // 并发不限在前端：Rust 全局闸门（容量 2）负责排队，避免两处限流互相打架
      items.forEach((it) => void runOne(it.key));
    },

    retry: (key) => {
      const it = get().items.find((i) => i.key === key);
      if (!it) return;
      void runOne(key);
    },

    cancel: (key) => {
      const it = get().items.find((i) => i.key === key);
      if (!it?.requestId) return;
      // 乐观置位：后端返回 CANCELLED 时也不再改写
      patch(set, key, { status: "cancelled", requestId: null });
      void invoke("cancel_generation", { requestId: it.requestId }).catch(() => undefined);
      if (!get().items.some((i) => i.status === "running" || i.status === "queued")) {
        set({ running: false });
      }
    },

    cancelAll: () => {
      for (const it of get().items) {
        if (it.requestId) void invoke("cancel_generation", { requestId: it.requestId }).catch(() => undefined);
      }
      set((s) => ({
        running: false,
        items: s.items.map((i) =>
          i.status === "running" || i.status === "queued"
            ? { ...i, status: "cancelled" as BatchStatus, requestId: null }
            : i
        ),
      }));
    },

    clear: () => set({ items: [], running: false }),

    succeeded: () => get().items.filter((i) => i.status === "succeeded").length,
    finished: () =>
      get().items.filter((i) => i.status !== "running" && i.status !== "queued").length,
  };
});

/** 整批的公共参数（按 kind 记录，单条重试沿用） */
const BATCH_ARGS = new Map<GenKind, Record<string, unknown>>();

function itemArgs(item: BatchItem): Record<string, unknown> {
  return BATCH_ARGS.get(item.kind) ?? {};
}
