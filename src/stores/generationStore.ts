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
import { useUiStore } from "./uiStore";

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

/** 提示词草稿来自持久化层（⌘⇧N 之外的丢失也一并修掉） */
const restoredPrompts = (): Record<GenKind, string> => ({
  ...EMPTY_PROMPTS,
  ...useUiStore.getState().prompts,
});

/**
 * 各 kind 在途任务的���止器。
 *
 * 放在模块级而不是 store 状态里：它是**运行时句柄**，不是界面要读的数据
 * （放进 state 会让每次 set 都带上一个 AbortController，徒增订阅抖动）。
 *
 * 作用：用户点「取消」时，除了让后端停，还要让**前端的对账轮询**停下来 ——
 * 否则 `runJob` 会在后台继续每 500ms 敲一次 `get_generation`，
 * 为一个界面已经不再关心的任务持续对账。
 */
const inflight = new Map<GenKind, AbortController>();

/**
 * 停掉所有在途的对账轮询。
 *
 * 给两处用：
 * 1. 测试收尾 —— 组件测试的 `get_generation` 桩返回非终态，轮询本来**永远不会**
 *    自然结束。不停它的话，测试文件跑完、jsdom 已销毁，轮询还在跑，
 *    React 的 scheduler 在没有 `window` 的环境里被唤起 ⇒
 *    `ReferenceError: window is not defined` ⇒ 整个 vitest run 以 exit code 1 失败
 *    （**测试本身全绿，CI 照样红**）。
 * 2. 应用卸载 —— 同理，界面没了就不该再对账。
 */
export function stopAllInflight(): void {
  for (const controller of inflight.values()) controller.abort();
  inflight.clear();
}

export const useGenerationStore = create<GenerationStore>((set, get) => ({
  tasks: { image: EMPTY_TASK, video: EMPTY_TASK, ppt: EMPTY_TASK, text: EMPTY_TASK },
  prompts: restoredPrompts(),

  submit: async (kind, args) => {
    const started: TaskState = {
      ...EMPTY_TASK,
      status: "submitting",
      startedAt: Date.now(),
    };
    set((s) => ({ tasks: { ...s.tasks, [kind]: started } }));

    // 同 kind 重新提交 ⇒ 先中止上一次的在途轮询，避免两个 runJob 并行对账。
    inflight.get(kind)?.abort();
    const controller = new AbortController();
    inflight.set(kind, controller);

    let myId: string | null = null;
    const current = () => get().tasks[kind];
    /**
     * 我是否还是**这一 kind 当前在途的那一轮**。
     *
     * 判据不能用 requestId：同 kind 重新提交时，前一轮的 requestId 已被清空，
     * 而新一轮可能拿到**同一个** requestId（后端按 kind 复用编号、或测试桩固定返回值），
     * 于是前一轮迟到的 catch/终态会误判成"我仍是当前任务"，把新一轮的状态槽覆盖掉。
     *
     * 用 AbortController 的身份来判：新一轮提交时 controller 换人，
     * 前一轮 `inflight.get(kind) !== controller` ⇒ 前一轮的任何迟到事件都无权写 store。
     */
    const isCurrent = () => inflight.get(kind) === controller;
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
          // 已经不是当前在途的那一轮 ⇒ 迟到的事件一律不认领
          if (!isCurrent()) return;
          patchId(s.requestId);
          if (isMine()) {
            set((cur) => ({
              tasks: { ...cur.tasks, [kind]: derive(cur.tasks[kind], s) },
            }));
          }
        },
        (requestId) => {
          if (!isCurrent()) return;
          patchId(requestId);
        },
        controller.signal
      );
      // 只有仍是当前任务才落定：用户已取消时 requestId 被清空，不能让迟到的终态复活
      if (isCurrent() && (isMine() || current().requestId === st.requestId)) {
        set((cur) => ({ tasks: { ...cur.tasks, [kind]: derive(cur.tasks[kind], st) } }));
      }
    } catch (e) {
      const payload = toGenError(e);
      // 已被新一轮顶掉 ⇒ 本轮无权写 store（否则会覆盖新一轮的状态槽）
      if (!isCurrent()) return;
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
    } finally {
      // 只有自己这一轮才清 —— 同 kind 的新任务已经换过 controller 了。
      if (inflight.get(kind) === controller) inflight.delete(kind);
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
    // 后端停 + 前端轮询停：只停后端的话，`runJob` 还会继续对账。
    inflight.get(kind)?.abort();
    void cancelJob(requestId).catch(() => undefined);
  },

  reset: (kind) => {
    // 复位 = 界面不再关心这个任务了 ⇒ 对账轮询也该停。
    // 否则 `runJob` 会在后台继续每 500ms 敲一次后端，为一个已被丢弃的任务持续对账。
    inflight.get(kind)?.abort();
    inflight.delete(kind);
    set((s) => ({ tasks: { ...s.tasks, [kind]: EMPTY_TASK } }));
  },

  setPrompt: (kind, value) => {
    set((s) => ({ prompts: { ...s.prompts, [kind]: value } }));
    useUiStore.getState().setPromptDraft(kind, value);
  },

  backfill: (kind, prompt) => {
    set((s) => ({
      prompts: { ...s.prompts, [kind]: prompt },
      tasks: { ...s.tasks, [kind]: EMPTY_TASK },
    }));
    useUiStore.getState().setPromptDraft(kind, prompt);
  },
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
