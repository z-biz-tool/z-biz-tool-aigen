/**
 * 批量生成队列（02 §7，任务 T-Batch）。
 *
 * 每条都是一个独立的后台任务（`submit_generation`），因此：
 * - 并发由 Rust 全局闸门统一排队，前端不再叠第二层限流
 * - 单条可独立取消/重试，互不影响
 * - 上游并发受限时整批仍然只占 2 个额度，不会打爆额度
 */

import { create } from "zustand";
import { isTerminal, runJob, cancelJob, type GenerationState } from "../_shared/jobClient";
import { toGenError, type GenErrorPayload } from "../_shared/genError";
import type { GenKind } from "./generationStore";

export type BatchStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface BatchItem {
  key: string;
  kind: GenKind;
  prompt: string;
  /** 整批共用的参数（model/count/size/temperature…） */
  params: Record<string, unknown>;
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
  start: (kind: GenKind, prompts: string[], params?: Record<string, unknown>) => void;
  retry: (key: string) => void;
  cancel: (key: string) => void;
  cancelAll: () => void;
  clear: () => void;
  succeeded: () => number;
  finished: () => number;
}

let seq = 0;

function resultOf(st: GenerationState): string | null {
  if (st.textResult) return st.textResult;
  if (st.preview.length) return st.preview.join("\n");
  return st.resultRefs[0] ?? null;
}

export const useBatchStore = create<BatchStore>((set, get) => {
  const patch = (key: string, next: Partial<BatchItem>) =>
    set((s) => ({ items: s.items.map((i) => (i.key === key ? { ...i, ...next } : i)) }));

  const recheckRunning = () => {
    const left = get().items.some((i) => i.status === "running" || i.status === "queued");
    if (!left) set({ running: false });
  };

  const runOne = async (key: string) => {
    const item = get().items.find((i) => i.key === key);
    if (!item) return;
    const startedAt = Date.now();
    patch(key, {
      status: "running",
      requestId: null,
      error: null,
      result: null,
      startedAt,
    });

    let myId: string | null = null;
    const mine = () => myId !== null && get().items.find((i) => i.key === key)?.requestId === myId;

    try {
      const st = await runJob(
        {
          kind: item.kind,
          prompt: item.prompt,
          model: (item.params.model as string | undefined) ?? null,
          providerId: (item.params.providerId as string | undefined) ?? null,
          params: Object.fromEntries(
            Object.entries(item.params).filter(([k]) => k !== "model" && k !== "providerId")
          ),
        },
        (s) => {
          myId = s.requestId;
          if (mine()) patch(key, { requestId: s.requestId });
        },
        (id) => {
          myId = id;
          patch(key, { requestId: id });
        }
      );
      const terminal: BatchStatus =
        st.status === "succeeded" ? "succeeded" : st.status === "cancelled" ? "cancelled" : "failed";
      patch(key, {
        status: terminal,
        result: resultOf(st),
        error: st.error ? toGenError(st.error) : null,
        requestId: null,
        durationMs: Date.now() - startedAt,
      });
    } catch (e) {
      const payload = toGenError(e);
      patch(key, {
        status: payload.code === "CANCELLED" ? "cancelled" : "failed",
        error: payload.code === "CANCELLED" ? null : payload,
        requestId: null,
        durationMs: Date.now() - startedAt,
      });
    }
    recheckRunning();
  };

  return {
    items: [],
    running: false,

    start: (kind, prompts, params = {}) => {
      const items: BatchItem[] = prompts.map((prompt, i) => ({
        key: `b${++seq}-${i}`,
        kind,
        prompt,
        params,
        status: "queued",
        requestId: null,
        result: null,
        error: null,
        startedAt: null,
        durationMs: null,
      }));
      set({ items, running: true });
      // 一次性下发，排队交给后端闸门
      items.forEach((it) => void runOne(it.key));
    },

    retry: (key) => {
      void runOne(key);
    },

    cancel: (key) => {
      const item = get().items.find((i) => i.key === key);
      if (!item) return;
      patch(key, { status: "cancelled", requestId: null });
      if (item.requestId) void cancelJob(item.requestId).catch(() => undefined);
      recheckRunning();
    },

    cancelAll: () => {
      for (const it of get().items) {
        if (it.requestId) void cancelJob(it.requestId).catch(() => undefined);
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
    finished: () => get().items.filter((i) => isTerminal(i.status)).length,
  };
});
