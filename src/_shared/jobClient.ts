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

/** 对账节奏。事件是主路，轮询只兜底，所以这个值只要比"能接受的卡住时长"小就行。 */
const RECONCILE_MS = 500;
/** 后端连续 RECONCILE_MS 这么久都读不到状态、期间也没有任何事件 ⇒ 判定任务已丢失 */
const MISSING_LIMIT = 3;

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
  /** 事件到达过就刷新，用来把"轮询读不到"与"任务真的没了"区分开 */
  let eventSeq = 0;

  let unlisten: UnlistenFn | null = null;
  try {
    unlisten = await listen<GenerationState>(`aigen://state/${requestId}`, (e) => {
      eventSeq += 1;
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

  /**
   * 轮询快照只在"不是倒退"时才采纳。事件是同一处按序发的，直接覆盖；
   * 轮询可能在途时被新事件超过，所以必须挡住。`updatedAt` 只到秒，
   * 故判据保守：终态一定覆盖非终态，其余要求严格更新。
   */
  const acceptPolled = (next: GenerationState) => {
    if (!last) return true;
    if (isTerminal(next.status) && !isTerminal(last.status)) return true;
    if (isTerminal(last.status)) return false;
    return next.updatedAt > last.updatedAt;
  };

  try {
    // 不设挂钟上限：图片单次请求可静默 180s、视频轮询预算 300s，
    // 排队等闸门更没有上界（一批 10 条要等前面的跑完）。误杀健康任务比多等更糟，
    // 用户要停下来随时可以 cancelJob —— 后端的每个 await 都有超时或取消。
    let misses = 0;
    let seqAtLastPoll = eventSeq;
    while (!last || !isTerminal(last.status)) {
      const s = await invoke<GenerationState>("get_generation", { requestId }).catch(() => null);
      if (s) {
        misses = 0;
        if (acceptPolled(s)) {
          last = s;
          onState?.(s);
        }
      } else {
        // 这期间来过事件说明连接是活的，不算丢任务
        misses = eventSeq === seqAtLastPoll ? misses + 1 : 0;
        if (misses >= MISSING_LIMIT) break;
      }
      seqAtLastPoll = eventSeq;
      if (last && isTerminal(last.status)) break;
      await wait(RECONCILE_MS);
    }
  } finally {
    unlisten?.();
    wakeups.splice(0).forEach((w) => w());
  }

  if (!last) {
    throw {
      code: "PARSE",
      message: `任务 ${requestId} 状态不可读（后端已不认这个任务号，可能应用重启过或已被回收）`,
      retryable: false,
    };
  }
  if (!isTerminal(last.status)) {
    // 绝不能把非终态当结果交回去：调用方会把它当成"完成"，界面从此卡在加载态
    throw {
      code: "NETWORK",
      message: `读不到任务 ${requestId} 的状态（已停止于 ${last.status}），任务可能仍在后台进行，可在历史中查看`,
      retryable: true,
    };
  }
  return last;
}

/** 取消一个在途任务（Rust 侧会把 cancelled 状态推回来） */
export async function cancelJob(requestId: string): Promise<boolean> {
  return invoke<boolean>("cancel_generation", { requestId });
}
