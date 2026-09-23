/**
 * 统一生成状态机（doc/优化方案/03 §5、§9，任务 T-C5/C6 + T-State）。
 *
 * 任务真身在 Rust 侧后台跑（`submit_generation` 立即返回），这里只是事件投影：
 * - 结果按 kind 存在 store 里，切换/卸载面板都不影响任务，也不丢结果（C6）
 * - 任意时刻可按 kind 取消（走同一个 request_id）
 * - 提示词也上移，历史与助手可以直接回填（02 §5、§8）
 */

import { create } from "zustand";
import {
  isTerminal,
  runJob,
  cancelJob,
  type GenerationProgress,
  type GenerationState,
  type JobArgs,
} from "../_shared/jobClient";
import { toGenError, type GenErrorPayload } from "../_shared/genError";

export type GenKind = "image" | "video" | "ppt" | "text";

export type TaskStatus =
  | "idle"
  | "submitting"
  | "streaming"
  | "polling"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface TaskState {
  status: TaskStatus;
  requestId: string | null;
  result: unknown | null;
  partial: string;
  progress: GenerationProgress | null;
  /** 已落盘的结果引用（相对数据目录），PPT 会是 [pptx, html] */
  refs: string[];
  error: GenErrorPayload | null;
  startedAt: number | null;
  finishedAt: number | null;
  /** 上游本次消耗（终态才有） */
  usage: GenerationState["usage"];
  /** 实际使用的模型（路由后的结果） */
  model: string | null;
}

const LOADING: TaskStatus[] = ["submitting", "streaming", "polling"];

export const EMPTY_TASK: TaskState = {
  status: "idle",
  requestId: null,
  result: null,
  partial: "",
  progress: null,
  refs: [],
  error: null,
  startedAt: null,
  finishedAt: null,
  usage: null,
  model: null,
};

const EMPTY_PROMPTS: Record<GenKind, string> = {
  image: "",
  video: "",
  ppt: "",
  text: "",
};

/** 图片用预览数组（上游 URL，可即时渲染），其余取文本或单个地址 */
function pickResult(st: GenerationState): unknown | null {
  if (st.kind === "image") return st.preview.length ? st.preview : null;
  if (st.textResult) return st.textResult;
  return st.preview[0] ?? st.resultRefs[0] ?? null;
}

function derive(prev: TaskState, st: GenerationState): TaskState {
  const terminal = isTerminal(st.status);
  const fresh = pickResult(st);
  return {
    ...prev,
    status: st.status as TaskStatus,
    requestId: terminal ? null : prev.requestId,
    // 中间态往往还没有结果，保留上一次的，避免界面上"结果闪一下没了"
    result: fresh ?? (terminal ? null : prev.result),
    // 终态后展示 result 即可，累积片段清掉，避免两处真相
    partial: terminal ? "" : st.partial,
    progress: st.progress ?? prev.progress,
    refs: st.resultRefs ?? [],
    error: st.error ? toGenError(st.error) : null,
    finishedAt: terminal ? Date.now() : null,
    usage: st.usage ?? prev.usage,
    model: st.model ?? prev.model,
  };
}

interface GenerationStore {
  tasks: Record<GenKind, TaskState>;
  prompts: Record<GenKind, string>;
  submit: (kind: GenKind, args: JobArgs) => Promise<void>;
  cancel: (kind: GenKind) => void;
  reset: (kind: GenKind) => void;
  setPrompt: (kind: GenKind, value: string) => void;
  /** 历史抽屉/助手「用这条再来一次」 */
  backfill: (kind: GenKind, prompt: string) => void;
}

export const useGenerationStore = create<GenerationStore>((set, get) => ({
  tasks: { image: EMPTY_TASK, video: EMPTY_TASK, ppt: EMPTY_TASK, text: EMPTY_TASK },
  prompts: EMPTY_PROMPTS,

  submit: async (kind, args) => {
    const started: TaskState = {
      ...EMPTY_TASK,
      status: "submitting",
      startedAt: Date.now(),
    };
    set((s) => ({ tasks: { ...s.tasks, [kind]: started } }));

    let myId: string | null = null;
    const current = () => get().tasks[kind];
    const isMine = () => myId !== null && current().requestId === myId;
    const patchId = (requestId: string) => {
      const cur = current();
      // 已落定/已被用户取消的任务不再认领 id，否则迟到的事件会把它复活
      if (cur.status === "cancelled" || cur.status === "succeeded" || cur.status === "failed") return;
      myId = requestId;
      if (cur.requestId !== requestId) {
        set((s) => ({ tasks: { ...s.tasks, [kind]: { ...s.tasks[kind], requestId } } }));
      }
    };

    try {
      const st = await runJob(
        { kind, ...args },
        (s) => {
          patchId(s.requestId);
          if (isMine()) {
            set((cur) => ({
              tasks: { ...cur.tasks, [kind]: derive(cur.tasks[kind], s) },
            }));
          }
        },
        patchId
      );
      // 只有仍是当前任务才落定：用户已取消时 requestId 被清空，不能让迟到的终态复活
      if (isMine() || current().requestId === st.requestId) {
        set((cur) => ({ tasks: { ...cur.tasks, [kind]: derive(cur.tasks[kind], st) } }));
      }
    } catch (e) {
      const payload = toGenError(e);
      if (payload.code === "CANCELLED") {
        if (isMine()) {
          set((cur) => ({
            tasks: {
              ...cur.tasks,
              [kind]: { ...EMPTY_TASK, status: "cancelled", result: cur.tasks[kind].result },
            },
          }));
        }
        return;
      }
      if (isMine() || myId === null) {
        set((cur) => ({
          tasks: {
            ...cur.tasks,
            [kind]: { ...cur.tasks[kind], status: "failed", error: payload, requestId: null },
          },
        }));
      }
    }
  },

  cancel: (kind) => {
    const { requestId, status } = get().tasks[kind];
    if (!requestId || !LOADING.includes(status)) return;
    // 乐观复位：不等后端确认，否则不结算的任务会让界面永久卡在生成中
    set((s) => ({
      tasks: {
        ...s.tasks,
        [kind]: { ...s.tasks[kind], status: "cancelled", requestId: null, result: null },
      },
    }));
    void cancelJob(requestId).catch(() => undefined);
  },

  reset: (kind) => set((s) => ({ tasks: { ...s.tasks, [kind]: EMPTY_TASK } })),

  setPrompt: (kind, value) => set((s) => ({ prompts: { ...s.prompts, [kind]: value } })),

  backfill: (kind, prompt) =>
    set((s) => ({
      prompts: { ...s.prompts, [kind]: prompt },
      tasks: { ...s.tasks, [kind]: EMPTY_TASK },
    })),
}));

/** 面板用：某个 kind 的任务态 + 便捷动作 */
export function useTask(kind: GenKind) {
  const task = useGenerationStore((s) => s.tasks[kind]);
  const submit = useGenerationStore((s) => s.submit);
  const cancel = useGenerationStore((s) => s.cancel);
  const reset = useGenerationStore((s) => s.reset);
  return {
    task,
    loading: LOADING.includes(task.status),
    result: task.result,
    partial: task.partial,
    progress: task.progress,
    refs: task.refs,
    error: task.error,
    submit,
    cancel: () => cancel(kind),
    reset: () => reset(kind),
  };
}

/** 面板用：受控的提示词文本 */
export function usePrompt(kind: GenKind) {
  const value = useGenerationStore((s) => s.prompts[kind]);
  const setPrompt = useGenerationStore((s) => s.setPrompt);
  return [value, (v: string) => setPrompt(kind, v)] as const;
}
