/**
 * 统一生成入口的前端客户端（03 §11.1）。
 *
 * 后端 `submit_generation` 立即返回 requestId，之后靠 `aigen://state/{id}` 事件推进；
 * 这里把"提交 + 订阅 + 收敛到终态"收成一次 await，供 generationStore 与 batchStore 共用，
 * 避免两处各写一遍事件协议。
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface GenerationProgress {
  stage: string;
  percent: number | null;
}

/** 与 Rust `GenerationState` 对齐 */
export interface GenerationState {
  requestId: string;
  kind: string;
  status:
    | "preparing"
    | "submitting"
    | "streaming"
    | "polling"
    | "succeeded"
    | "failed"
    | "cancelled"
    | string;
  model: string | null;
  partial: string;
  progress: GenerationProgress | null;
  resultRefs: string[];
  preview: string[];
  textResult: string | null;
  recordId: string | null;
  usage: { prompt_tokens: number; completion_tokens: number } | null;
  error: { code: string; message: string; retryable: boolean } | null;
  createdAt: string;
  updatedAt: string;
}

export interface JobArgs {
  prompt: string;
  model?: string | null;
  providerId?: string | null;
  /** count / size / duration / resolution / slides / outline / taskId / system / temperature / maxTokens / stream */
  params?: Record<string, unknown>;
}

const TERMINAL = ["succeeded", "failed", "cancelled"];
export const isTerminal = (s: string) => TERMINAL.includes(s);

interface SubmitAck {
  requestId: string;
}

/** 提交并跟踪到终态。事件为主，`get_generation` 对账为辅（事件丢失/订阅失败也能收敛）。 */
export async function runJob(
  args: JobArgs & { kind: string },
  onState?: (s: GenerationState) => void,
  onRequestId?: (requestId: string) => void
): Promise<GenerationState> {
  const ack = await invoke<SubmitAck>("submit_generation", {
    req: {
      kind: args.kind,
      prompt: args.prompt,
      providerId: args.providerId ?? null,
      model: args.model ?? null,
      params: args.params ?? {},
    },
  });
  const requestId = ack.requestId;
  onRequestId?.(requestId);
  let last: GenerationState | null = null;
  const wakeups: Array<() => void> = [];

  let unlisten: UnlistenFn | null = null;
  try {
    unlisten = await listen<GenerationState>(`aigen://state/${requestId}`, (e) => {
      last = e.payload;
      onState?.(e.payload);
      wakeups.splice(0).forEach((w) => w());
    });
  } catch (e) {
    // 事件通道不可用：下面靠对账轮询
    console.warn("订阅任务状态失败，改用轮询对账", e);
  }

  const wait = (ms: number) =>
    new Promise<void>((resolve) => {
      const t = setTimeout(resolve, ms);
      wakeups.push(() => {
        clearTimeout(t);
        resolve();
      });
    });

  try {
    // 上限与后端视频轮询预算同级，避免前端无限等
    for (let i = 0; i < 1600 && !(last && isTerminal(last.status)); i++) {
      if (!last) {
        last = await invoke<GenerationState>("get_generation", { requestId }).catch(() => null);
        if (last) onState?.(last);
      }
      await wait(200);
    }
  } finally {
    unlisten?.();
    wakeups.splice(0).forEach((w) => w());
  }

  if (!last) {
    throw {
      code: "PARSE",
      message: `任务 ${requestId} 状态不可读`,
      retryable: false,
    };
  }
  return last;
}

/** 取消一个在途任务（Rust 侧会把 cancelled 状态推回来） */
export async function cancelJob(requestId: string): Promise<boolean> {
  return invoke<boolean>("cancel_generation", { requestId });
}
