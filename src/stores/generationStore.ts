/**
 * 统一生成状态机（doc/优化方案/03 §5、§9，任务 T-C5/C6）。
 *
 * 取代此前"每个面板各持一份 useGeneration 本地态"的双通道：
 * - 结果按 kind 存在 store 里，切换面板不再丢（C6）
 * - 生成中状态全局可见，任意时刻可按 kind 取消（C3 的前端半边）
 * - 提示词一并上移，历史可回填后直接发起迭代（02 §5）
 */

import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { newRequestId, toGenError, type GenErrorPayload } from "../_shared/genError";

export type GenKind = "image" | "video" | "ppt" | "text";

/** 03 §5 状态机 */
export type TaskStatus =
  | "idle"
  | "submitting"
  | "streaming"
  | "polling"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface TaskProgress {
  percent: number;
  stage: string;
}

export interface TaskState {
  status: TaskStatus;
  requestId: string | null;
  result: unknown | null;
  /** 流式累积片段（03 §11.3 GenerationState.partial） */
  partial: string;
  /** 异步任务进度（03 §11.2 aigen://progress） */
  progress: TaskProgress | null;
  error: GenErrorPayload | null;
  startedAt: number | null;
  finishedAt: number | null;
}

const EMPTY_TASK: TaskState = {
  status: "idle",
  requestId: null,
  result: null,
  partial: "",
  progress: null,
  error: null,
  startedAt: null,
  finishedAt: null,
};

const EMPTY_PROMPTS: Record<GenKind, string> = {
  image: "",
  video: "",
  ppt: "",
  text: "",
};

/** 与 Rust `StreamEvent` 对齐 */
interface StreamEvent {
  delta: string;
  done: boolean;
  usage?: { prompt_tokens: number; completion_tokens: number } | null;
}

interface GenerationStore {
  tasks: Record<GenKind, TaskState>;
  prompts: Record<GenKind, string>;
  /** stream=true 订阅 `aigen://stream/{id}` 增量；progress=true 订阅 `aigen://progress/{id}` */
  submit: (
    kind: GenKind,
    cmd: string,
    args: Record<string, unknown>,
    opts?: { stream?: boolean; progress?: boolean }
  ) => Promise<void>;
  /**
   * 轮询视频任务（T-B2）。与 submit 的关键差别：
   * **保留**已有的 `task:` 结果，否则等待期间界面会退回空状态、任务号消失。
   */
  pollVideo: (taskId: string) => Promise<void>;
  cancel: (kind: GenKind) => void;
  reset: (kind: GenKind) => void;
  setPrompt: (kind: GenKind, value: string) => void;
  /** 历史抽屉「用这条再来一次」 */
  backfill: (kind: GenKind, prompt: string) => void;
}

export const useGenerationStore = create<GenerationStore>((set, get) => ({
  tasks: { image: EMPTY_TASK, video: EMPTY_TASK, ppt: EMPTY_TASK, text: EMPTY_TASK },
  prompts: EMPTY_PROMPTS,

  submit: async (kind, cmd, args, opts) => {
    const requestId = newRequestId();
    const stream = Boolean(opts?.stream);
    const wantProgress = Boolean(opts?.progress);
    set((s) => ({
      tasks: {
        ...s.tasks,
        [kind]: { ...EMPTY_TASK, status: "submitting", requestId, startedAt: Date.now() },
      },
    }));

    const stillCurrent = () => get().tasks[kind].requestId === requestId;
    const finish = (patch: Partial<TaskState>) => {
      set((s) => ({
        tasks: {
          ...s.tasks,
          [kind]: { ...s.tasks[kind], ...patch, requestId: null, finishedAt: Date.now() },
        },
      }));
    };

    // 先挂监听再 invoke：否则首块增量/首个进度可能落在订阅就绪之前
    let unlisten: UnlistenFn | null = null;
    let unlistenProgress: UnlistenFn | null = null;
    if (stream) {
      try {
        unlisten = await listen<StreamEvent>(`aigen://stream/${requestId}`, (e) => {
          if (!stillCurrent()) return;
          const { delta, done } = e.payload;
          set((s) => {
            const t = s.tasks[kind];
            return {
              tasks: {
                ...s.tasks,
                [kind]: {
                  ...t,
                  status: done ? t.status : "streaming",
                  partial: t.partial + (delta ?? ""),
                },
              },
            };
          });
        });
      } catch (e) {
        // 事件通道不可用时不阻断生成：退化为等整段返回
        console.warn("订阅流式事件失败，回退整段返回", e);
      }
    }
    if (wantProgress) {
      try {
        unlistenProgress = await listen<TaskProgress>(`aigen://progress/${requestId}`, (e) => {
          if (!stillCurrent()) return;
          set((s) => ({
            tasks: {
              ...s.tasks,
              [kind]: { ...s.tasks[kind], status: "polling", progress: e.payload },
            },
          }));
        });
      } catch (e) {
        console.warn("订阅进度事件失败，仅影响进度显示", e);
      }
    }

    try {
      const result = await invoke<unknown>(cmd, { ...args, requestId });
      // 期间被取消或被新任务取代：不回写界面
      if (stillCurrent()) finish({ status: "succeeded", result, partial: "" });
    } catch (e) {
      const payload = toGenError(e);
      if (!stillCurrent()) return;
      // 03 §7：取消静默回 Idle，不作为错误展示
      if (payload.code === "CANCELLED") {
        set((s) => ({
          tasks: { ...s.tasks, [kind]: { ...EMPTY_TASK, status: "cancelled", finishedAt: Date.now() } },
        }));
        return;
      }
      finish({ status: "failed", error: payload, partial: "" });
    } finally {
      unlisten?.();
      unlistenProgress?.();
    }
  },

  pollVideo: async (taskId) => {
    const requestId = newRequestId();
    // 只改状态，保留 result 里的 task: 句柄，等待期仍然显示任务号 + 进度
    set((s) => ({
      tasks: {
        ...s.tasks,
        video: {
          ...s.tasks.video,
          status: "polling" as TaskStatus,
          requestId,
          progress: null,
          error: null,
        },
      },
    }));

    const stillCurrent = () => get().tasks.video.requestId === requestId;
    let unlisten: UnlistenFn | null = null;
    try {
      unlisten = await listen<TaskProgress>(`aigen://progress/${requestId}`, (e) => {
        if (!stillCurrent()) return;
        set((s) => ({
          tasks: { ...s.tasks, video: { ...s.tasks.video, status: "polling", progress: e.payload } },
        }));
      });
    } catch (e) {
      console.warn("订阅进度事件失败，仅影响进度显示", e);
    }

    try {
      const url = await invoke<unknown>("poll_video", { requestId, taskId });
      if (!stillCurrent()) return;
      set((s) => ({
        tasks: {
          ...s.tasks,
          video: {
            ...s.tasks.video,
            status: "succeeded",
            result: url,
            requestId: null,
            progress: { percent: 100, stage: "已完成" },
            finishedAt: Date.now(),
          },
        },
      }));
    } catch (e) {
      const payload = toGenError(e);
      if (!stillCurrent()) return;
      if (payload.code === "CANCELLED") {
        set((s) => ({
          tasks: {
            ...s.tasks,
            video: { ...EMPTY_TASK, status: "cancelled", result: s.tasks.video.result, finishedAt: Date.now() },
          },
        }));
        return;
      }
      set((s) => ({
        tasks: {
          ...s.tasks,
          video: {
            ...s.tasks.video,
            status: "failed",
            error: payload,
            result: null,
            requestId: null,
            finishedAt: Date.now(),
          },
        },
      }));
    } finally {
      unlisten?.();
    }
  },

  cancel: (kind) => {    const { requestId, status } = get().tasks[kind];
    if (!requestId || !(status === "submitting" || status === "streaming" || status === "polling")) return;
    // 乐观复位：不等后端确认，否则不结算的请求会让界面永久卡在生成中
    set((s) => ({
      tasks: { ...s.tasks, [kind]: { ...EMPTY_TASK, status: "cancelled", finishedAt: Date.now() } },
    }));
    void invoke("cancel_generation", { requestId }).catch(() => undefined);
  },

  reset: (kind) => set((s) => ({ tasks: { ...s.tasks, [kind]: EMPTY_TASK } })),

  setPrompt: (kind, value) =>
    set((s) => ({ prompts: { ...s.prompts, [kind]: value } })),

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
  const pollVideo = useGenerationStore((s) => s.pollVideo);
  const cancel = useGenerationStore((s) => s.cancel);
  const reset = useGenerationStore((s) => s.reset);
  return {
    task,
    submit,
    pollVideo,
    loading:
      task.status === "submitting" ||
      task.status === "streaming" ||
      task.status === "polling",
    result: task.result,
    partial: task.partial,
    progress: task.progress,
    error: task.error,
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
