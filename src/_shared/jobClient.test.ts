import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Tauri IPC 全 mock：不碰真实后端，也不碰真实上游（06 §2、R8）
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { runJob, type GenerationState } from "./jobClient";

const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>;
const mockListen = listen as unknown as ReturnType<typeof vi.fn>;

type Handler = (e: { payload: GenerationState }) => void;

function state(over: Partial<GenerationState> = {}): GenerationState {
  return {
    requestId: "job-1",
    kind: "text",
    status: "submitting",
    model: null,
    partial: "",
    progress: null,
    resultRefs: [],
    preview: [],
    textResult: null,
    recordId: null,
    usage: null,
    error: null,
    createdAt: "2026-09-23T10:00:00Z",
    updatedAt: "2026-09-23T10:00:00Z",
    ...over,
  };
}

/** 让 listen 只登记回调、永不推送 ⇒ 只剩对账轮询这条兜底路 */
function captureListen(spy: { handler: Handler | null; unlistened: { n: number } }) {
  mockListen.mockImplementation(async (_event: string, fn: Handler) => {
    spy.handler = fn;
    return (() => {
      spy.unlistened.n += 1;
    }) as UnlistenFn;
  });
}

/** 按脚本逐次应答 get_generation；数组用尽后重复最后一项 */
function scriptPolls(states: GenerationState[]) {
  let n = 0;
  mockInvoke.mockImplementation((cmd: string) => {
    if (cmd === "submit_generation") return Promise.resolve({ requestId: "job-1" });
    const i = Math.min(n, states.length - 1);
    n += 1;
    return Promise.resolve(states[i]);
  });
  return () => n;
}

/** 让当前这轮 setTimeout(500) 到期，并把在途 Promise 跑完 */
async function tick(times = 1) {
  for (let i = 0; i < times; i++) await vi.advanceTimersByTimeAsync(500);
}

/** 手动放行的 Promise：用来制造"轮询在途、事件先到"的乱序 */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

let spy: { handler: Handler | null; unlistened: { n: number } };

beforeEach(() => {
  vi.useFakeTimers();
  spy = { handler: null, unlistened: { n: 0 } };
  captureListen(spy);
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("runJob 的对账轮询（事件之外的第二条收敛路）", () => {
  it("事件一条都没到时，靠轮询走到终态而不是原地睡到超时", async () => {
    // 回归：旧实现是 `if (!last)` 才轮询，读到过一条非终态后就再也不查了
    // ⇒ 事件一旦丢失，任务永远停在 submitting，界面卡在加载态
    scriptPolls([
      state({ status: "submitting", updatedAt: "2026-09-23T10:00:00Z" }),
      state({ status: "streaming", partial: "从前有", updatedAt: "2026-09-23T10:00:01Z" }),
      state({ status: "streaming", partial: "一座山", updatedAt: "2026-09-23T10:00:02Z" }),
      state({ status: "succeeded", textResult: "讲完了", updatedAt: "2026-09-23T10:00:03Z" }),
    ]);
    const seen: string[] = [];
    const done = runJob({ kind: "text", prompt: "p" }, (s) => seen.push(s.status));
    await tick(6);
    const st = await done;

    expect(st.status).toBe("succeeded");
    expect(seen).toEqual(["submitting", "streaming", "streaming", "succeeded"]);
    expect(spy.unlistened.n).toBe(1); // 收敛后一定退订
  });

  it("排队/静默可以很久：状态连续 20 轮不变也不能被误判成超时", async () => {
    // 图片单次请求可静默 180s、视频轮询预算 300s、等闸门更没有上界。
    // 任何"挂钟/无进展就放弃"的实现都会在这里误杀健康任务。
    const queued = state({
      status: "submitting",
      progress: { stage: "queued", percent: 0 },
    });
    const polls = scriptPolls([
      ...Array.from({ length: 20 }, () => queued),
      state({ status: "succeeded", textResult: "ok", updatedAt: "2026-09-23T10:00:20Z" }),
    ]);
    const done = runJob({ kind: "text", prompt: "p" });
    await tick(24);
    const st = await done;

    expect(st.status).toBe("succeeded");
    expect(polls()).toBeGreaterThanOrEqual(21); // 一路都在对账，没有提前放弃
  });

  it("在途轮询回来得比事件晚时，不许把状态改回去", async () => {
    const gate = deferred<GenerationState>();
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "submit_generation") return Promise.resolve({ requestId: "job-1" });
      // 故意悬着：等终态事件先到
      return gate.promise;
    });
    const seen: string[] = [];
    const done = runJob({ kind: "text", prompt: "p" }, (s) => seen.push(s.status));
    await tick();

    spy.handler?.({ payload: state({ status: "succeeded", updatedAt: "2026-09-23T10:00:09Z" }) });
    await tick();
    // 悬空的轮询这时才回，带回的是一分钟前的旧快照
    gate.resolve(state({ status: "streaming", updatedAt: "2026-09-23T10:00:00Z" }));
    const st = await done;

    expect(st.status).toBe("succeeded");
    expect(seen).toEqual(["succeeded"]); // 旧的 streaming 没被采纳
  });

  it("后端连续不认这个任务号 ⇒ 抛明确错误，绝不把非终态当结果交回去", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "submit_generation") return Promise.resolve({ requestId: "job-gone" });
      return Promise.reject({
        code: "INVALID_PARAM",
        message: "任务 job-gone 不存在或已被回收",
        retryable: false,
      });
    });
    const seen: string[] = [];
    const errs: Array<{ code?: string; message?: string }> = [];
    // 拒绝回调必须当场挂上，否则中途那几轮 tick 里就是未处理拒绝
    const done = runJob({ kind: "text", prompt: "p" }, (s) =>
      seen.push(s.status)
    ).catch((e) => {
      errs.push(e);
    });
    await tick(8);
    await done;

    expect(errs[0]).toMatchObject({ code: "PARSE", retryable: false });
    expect(errs[0].message).toContain("job-gone");
    expect(seen).toEqual([]);
    expect(spy.unlistened.n).toBe(1);
  });

  it("事件当场给出终态 ⇒ 一次轮询都不用发，并立即退订", async () => {
    const pollCalls = scriptPolls([state({ status: "submitting" })]);
    mockListen.mockImplementation(async (_event: string, fn: Handler) => {
      // 订阅建立时任务已经跑完了（短任务的终态事件抢在 listen 之后立刻到）
      fn({ payload: state({ status: "succeeded", textResult: "hi" }) });
      return (() => {
        spy.unlistened.n += 1;
      }) as UnlistenFn;
    });
    const st = await runJob({ kind: "text", prompt: "p" });

    expect(st.status).toBe("succeeded");
    expect(pollCalls()).toBe(0);
    expect(spy.unlistened.n).toBe(1);
  });
});
