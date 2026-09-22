/**
 * 生成助手前端态（T-Agent / 02 §8、04 §6）。
 *
 * 边界：这个 store 只会调用 `assist_generation`。它不写文件、不改配置、
 * 不发起生成；「填入提示词」只改草稿，且必须由用户点击。
 */

import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { newRequestId, toGenError, type GenErrorPayload } from "../_shared/genError";
import type { GenKind } from "./aiStore";

export interface Suggestion {
  kind: "rewrite" | "param" | "diagnose" | string;
  title: string;
  detail: string;
}

export interface AssistantReply {
  suggestions: Suggestion[];
  rewritten: string | null;
  heuristic_only: boolean;
  usage: { prompt_tokens: number; completion_tokens: number } | null;
}

interface AssistantStore {
  open: boolean;
  loading: boolean;
  kind: GenKind | null;
  reply: AssistantReply | null;
  error: GenErrorPayload | null;
  requestId: string | null;
  ask: (kind: GenKind, prompt: string, model?: string, lastError?: string | null) => Promise<void>;
  show: () => void;
  hide: () => void;
  cancel: () => void;
}

const EMPTY: AssistantReply | null = null;

export const useAssistantStore = create<AssistantStore>((set, get) => ({
  open: false,
  loading: false,
  kind: null,
  reply: EMPTY,
  error: null,
  requestId: null,

  ask: async (kind, prompt, model, lastError) => {
    const requestId = newRequestId();
    set({ open: true, loading: true, kind, reply: null, error: null, requestId });
    try {
      const reply = await invoke<AssistantReply>("assist_generation", {
        requestId,
        kind,
        prompt,
        model: model ?? null,
        lastError: lastError ?? null,
      });
      // 期间被取消或用户又问了一次：不写回
      if (get().requestId !== requestId) return;
      set({ reply, loading: false, requestId: null });
    } catch (e) {
      if (get().requestId !== requestId) return;
      const payload = toGenError(e);
      set({
        loading: false,
        requestId: null,
        error: payload.code === "CANCELLED" ? null : payload,
      });
    }
  },

  show: () => set({ open: true }),
  hide: () => set({ open: false }),

  cancel: () => {
    const { requestId, kind } = get();
    if (!requestId) {
      set({ loading: false });
      return;
    }
    set({ loading: false, requestId: null, reply: null, kind });
    void invoke("cancel_generation", { requestId }).catch(() => undefined);
  },
}));

export const SUGGESTION_GROUP: Record<string, { label: string; color: string }> = {
  diagnose: { label: "诊断", color: "red" },
  rewrite: { label: "提示词", color: "blue" },
  param: { label: "参数", color: "purple" },
};
