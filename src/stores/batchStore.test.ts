import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useBatchStore } from "./batchStore";
import type { GenerationState } from "../_shared/jobClient";

const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>;
const mockListen = listen as unknown as ReturnType<typeof vi.fn>;

type Handler = (e: { payload: GenerationState }) => void;
let handlers: Array<{ event: string; fn: Handler }> = [];
let seq = 0;

function jobState(id: string, over: Partial<GenerationState> = {}): GenerationState {
  return {
    requestId: id,
    kind: "text",
    status: "succeeded",
    model: "gpt-4o",
    partial: "",
    progress: null,
    resultRefs: [],
    preview: [],
    textResult: null,
    recordId: `rec-${id}`,
    usage: null,
    error: null,
    createdAt: "2026-09-22T10:00:00Z",
    updatedAt: "2026-09-22T10:00:05Z",
    ...over,
  };
}

const emit = (id: string, st: GenerationState) =>
  handlers
    .filter((h) => h.event === `aigen://state/${id}`)
    .forEach((h) => h.fn({ payload: st }));

/** 每条 prompt 分配一个 requestId，事件由测试自己发出去 */
function stubJobs(handler?: (req: Record<string, unknown>, id: string) => void) {
  mockInvoke.mockImplementation((cmd: string, args: { req?: { prompt?: string } }) => {
    if (cmd === "submit_generation") {
      const id = `job-${++seq}`;
      handler?.(args.req as Record<string, unknown>, id);
      return Promise.resolve({ requestId: id });
    }
    if (cmd === "cancel_generation") return Promise.resolve(true);
    if (cmd === "get_generation")
      return Promise.reject({ code: "INVALID_PARAM", message: "未就绪", retryable: false });
    return Promise.reject({ code: "UNKNOWN", message: `ns ${cmd}`, retryable: false });
  });
}

/** 等某条进入期望状态（事件是 setTimeout 发来的，需要轮询） */
const untilStatus = async (
  pred: (i: import("./batchStore").BatchItem) => boolean,
  ms = 1500
) => {
  const start = Date.now();
  while (!useBatchStore.getState().items.some(pred) && Date.now() - start < ms)
    await new Promise((r) => setTimeout(r, 10));
};

/** 等 store 把 N 条都提交出去 */
const untilSubmitted = async (n: number, ms = 1500) => {
  const start = Date.now();
  while (
    mockInvoke.mock.calls.filter((c) => c[0] === "submit_generation").length < n &&
    Date.now() - start < ms
  )
    await new Promise((r) => setTimeout(r, 10));
};

const requests = () =>
  mockInvoke.mock.calls.filter((c) => c[0] === "submit_generation").map((c) => c[1].req);

beforeEach(() => {
  seq = 0;
  handlers = [];
  useBatchStore.setState({ items: [], running: false });
  mockListen.mockImplementation(async (event: string, fn: Handler) => {
    handlers.push({ event, fn });
    return () => {};
  });
});

describe("batchStore.start（02 §7）", () => {
  it("逐条提交独立任务，共享参数各自带 prompt", async () => {
    stubJobs();
    useBatchStore.getState().start("text", ["a", "b", "c"], { model: "gpt-4o", temperature: 0.4 });
    await untilSubmitted(3);

    const reqs = requests();
    expect(reqs.length).toBe(3);
    expect(reqs.map((r) => r.prompt)).toEqual(["a", "b", "c"]);
    expect(reqs[0]).toMatchObject({ kind: "text", model: "gpt-4o", params: { temperature: 0.4 } });
    // 三条各自独立 requestId
    expect(new Set(handlers.map((h) => h.event)).size).toBe(3);
  });

  it("整批并发不自己限流：一次性全部提交，排队交给后端闸门", async () => {
    stubJobs();
    useBatchStore.getState().start("text", Array.from({ length: 6 }, (_, i) => `p${i}`));
    await untilSubmitted(6);
    expect(requests().length).toBe(6);
    expect(useBatchStore.getState().items.every((i) => i.status === "running")).toBe(true);
  });

  it("单条失败不影响其余条目", async () => {
    stubJobs((req, id) => {
      if (req.prompt === "bad") {
        setTimeout(() =>
          emit(id, jobState(id, { status: "failed", error: { code: "TIMEOUT", message: "超时", retryable: true } }))
        );
      } else {
        setTimeout(() => emit(id, jobState(id, { textResult: `ok:${req.prompt}` })));
      }
    });
    useBatchStore.getState().start("text", ["ok1", "bad", "ok2"]);
    const untilDone = async () => {
      const start = Date.now();
      while (
        useBatchStore.getState().items.some((i) => i.status === "running" || i.status === "queued") &&
        Date.now() - start < 2000
      )
        await new Promise((r) => setTimeout(r, 10));
    };
    await untilDone();

    const items = useBatchStore.getState().items;
    expect(items.map((i) => i.status)).toEqual(["succeeded", "failed", "succeeded"]);
    expect(items[1].error?.code).toBe("TIMEOUT");
    expect(items[0].result).toBe("ok:ok1");
    expect(useBatchStore.getState().succeeded()).toBe(2);
    expect(useBatchStore.getState().running).toBe(false);
    expect(items[0].durationMs).not.toBeNull();
  });

  it("重试只重跑那一条，并沿用它的参数", async () => {
    stubJobs((req, id) =>
      setTimeout(() =>
        emit(
          id,
          req.prompt === "bad"
            ? jobState(id, { status: "failed", error: { code: "RATE_LIMIT", message: "限流", retryable: true } })
            : jobState(id, { textResult: "好" })
        )
      )
    );
    useBatchStore.getState().start("text", ["ok", "bad"], { model: "m1" });
    await untilStatus((i) => i.status === "failed");
    const failedKey = useBatchStore.getState().items.find((i) => i.status === "failed")!.key;
    const before = requests().length;

    mockInvoke.mockClear();
    stubJobs((_req, id) => setTimeout(() => emit(id, jobState(id, { textResult: "重试后成功" }))));
    useBatchStore.getState().retry(failedKey);
    await untilSubmitted(1);

    expect(requests().length).toBe(1);
    expect(requests()[0]).toMatchObject({ prompt: "bad", model: "m1" });
    await untilStatus((i) => i.key === failedKey && i.status === "succeeded");
    expect(useBatchStore.getState().items.find((i) => i.key === failedKey)?.result).toBe("重试后成功");
    // 另一条没被重跑
    expect(requests().length).toBe(1);
    expect(before).toBe(2);
  });

  it("取消单条：只发它自己的 requestId，别条不受影响", async () => {
    stubJobs();
    useBatchStore.getState().start("text", ["a", "b"]);
    await untilSubmitted(2);
    const target = useBatchStore.getState().items[0];
    const targetEvent = handlers[0].event;

    useBatchStore.getState().cancel(target.key);
    expect(useBatchStore.getState().items[0].status).toBe("cancelled");
    const cancelCall = mockInvoke.mock.calls.find((c) => c[0] === "cancel_generation");
    expect(cancelCall?.[1].requestId).toBe(targetEvent.replace("aigen://state/", ""));
    expect(handlers[1].event).not.toBe(targetEvent);
    expect(useBatchStore.getState().items[1].status).toBe("running");
  });

  it("cancelAll 取消全部在途并解锁整批", async () => {
    stubJobs();
    useBatchStore.getState().start("text", ["a", "b", "c"]);
    await untilSubmitted(3);
    useBatchStore.getState().cancelAll();

    const s = useBatchStore.getState();
    expect(s.running).toBe(false);
    expect(s.items.every((i) => i.status === "cancelled")).toBe(true);
    expect(s.finished()).toBe(3);
    expect(mockInvoke.mock.calls.filter((c) => c[0] === "cancel_generation").length).toBe(3);
  });

  it("迟到的终态不会覆盖用户刚点掉的清空/取消", async () => {
    let lateId = "";
    stubJobs((_req, id) => {
      lateId = id;
    });
    useBatchStore.getState().start("text", ["x"]);
    await untilSubmitted(1);
    useBatchStore.getState().cancel(useBatchStore.getState().items[0].key);
    useBatchStore.getState().clear();

    emit(lateId, jobState(lateId, { textResult: "迟到的结果" }));
    await new Promise((r) => setTimeout(r, 30));
    expect(useBatchStore.getState().items).toEqual([]);
  });

  it("图片结果落到 preview 拼接，便于展示/导出", async () => {
    stubJobs((_req, id) =>
      setTimeout(() =>
        emit(id, jobState(id, { kind: "image", preview: ["https://cdn/a.png", "https://cdn/b.png"] }))
      )
    );
    useBatchStore.getState().start("image", ["猫"], { count: 2 });
    await untilSubmitted(1);
    const start = Date.now();
    while (useBatchStore.getState().items[0]?.status === "running" && Date.now() - start < 2000)
      await new Promise((r) => setTimeout(r, 10));

    const item = useBatchStore.getState().items[0];
    expect(item.status).toBe("succeeded");
    expect(item.result).toBe("https://cdn/a.png\nhttps://cdn/b.png");
    expect(item.params).toEqual({ count: 2 });
  });
});
