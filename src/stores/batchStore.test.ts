import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { useBatchStore } from "./batchStore";

const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>;
const flush = async (n = 4) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

beforeEach(() => {
  useBatchStore.setState({ items: [], running: false });
});

describe("batchStore.start（02 §7 / T-Batch）", () => {
  it("逐条下发，各自带独立 requestId", async () => {
    mockInvoke.mockResolvedValue("ok");
    useBatchStore.getState().start("text", "generate_text", ["a", "b", "c"], { model: "gpt-4o" });
    await flush();

    const calls = mockInvoke.mock.calls.filter((c) => c[0] === "generate_text");
    expect(calls.length).toBe(3);
    const ids = new Set(calls.map((c) => c[1].requestId));
    expect(ids.size).toBe(3);
    expect(calls[0][1]).toMatchObject({ model: "gpt-4o" });
    expect(calls.map((c) => c[1].prompt)).toEqual(["a", "b", "c"]);
    expect(useBatchStore.getState().running).toBe(false);
  });

  it("整批共用公共参数，单条提示词各自覆盖 prompt", async () => {
    mockInvoke.mockResolvedValue(["data:image/png;base64,AA"]);
    useBatchStore.getState().start("image", "generate_image", ["猫", "狗"], {
      count: 1,
      size: "1024x1024",
    });
    await flush();
    const items = useBatchStore.getState().items;
    expect(items.map((i) => i.status)).toEqual(["succeeded", "succeeded"]);
    // 数组结果序列化后可导出/预览
    expect(JSON.parse(items[0].result ?? "[]")).toEqual(["data:image/png;base64,AA"]);
  });

  it("单条失败不影响其余条目，错误按契约保留", async () => {
    mockInvoke.mockImplementation(async (_cmd: string, args: { prompt: string }) => {
      if (args.prompt === "bad") {
        throw { code: "UPSTREAM_5XX", message: "上游不可用", retryable: true };
      }
      return "good";
    });
    useBatchStore.getState().start("text", "generate_text", ["ok1", "bad", "ok2"], {});
    await flush();

    const items = useBatchStore.getState().items;
    expect(items.map((i) => i.status)).toEqual(["succeeded", "failed", "succeeded"]);
    expect(items[1].error?.code).toBe("UPSTREAM_5XX");
    expect(items[1].error?.retryable).toBe(true);
    expect(useBatchStore.getState().succeeded()).toBe(2);
  });

  it("耗时被记录，便于判断是否真的跑完", async () => {
    mockInvoke.mockImplementation(
      () => new Promise((r) => setTimeout(() => r("x"), 10))
    );
    useBatchStore.getState().start("text", "generate_text", ["一条"], {});
    await new Promise((r) => setTimeout(r, 60));
    expect(useBatchStore.getState().items[0].durationMs).toBeGreaterThan(0);
  });
});

describe("重试与取消", () => {
  const seed = async () => {
    mockInvoke.mockImplementation(async (_cmd: string, args: { prompt: string }) => {
      if (args.prompt === "bad") throw { code: "TIMEOUT", message: "超时", retryable: true };
      return "good";
    });
    useBatchStore.getState().start("text", "generate_text", ["ok", "bad"], {});
    await flush();
  };

  it("retry 只重跑那一条，并可转成功", async () => {
    await seed();
    const failed = useBatchStore.getState().items.find((i) => i.status === "failed")!;
    expect(failed.prompt).toBe("bad");

    mockInvoke.mockResolvedValue("重试后的结果");
    const before = mockInvoke.mock.calls.length;
    useBatchStore.getState().retry(failed.key);
    await flush();

    expect(mockInvoke.mock.calls.length - before).toBe(1);
    const after = useBatchStore.getState().items.find((i) => i.key === failed.key)!;
    expect(after.status).toBe("succeeded");
    expect(after.result).toBe("重试后的结果");
    // 另一条不受影响
    expect(useBatchStore.getState().items.find((i) => i.prompt === "ok")?.result).toBe("good");
  });

  it("retry 沿用整批的公共参数", async () => {
    useBatchStore.getState().start("text", "generate_text", ["p1"], { model: "abab6.5s-chat" });
    await flush();
    mockInvoke.mockClear();
    useBatchStore.getState().retry(useBatchStore.getState().items[0].key);
    await flush();
    expect(mockInvoke.mock.calls[0][1]).toMatchObject({ model: "abab6.5s-chat", prompt: "p1" });
  });

  it("cancel 用该条自己的 requestId", async () => {
    let pending!: (v: string) => void;
    mockInvoke.mockImplementation(() => new Promise((r) => (pending = r)));
    useBatchStore.getState().start("text", "generate_text", ["第一条", "第二条"], {});
    await flush();

    const first = useBatchStore.getState().items[0];
    const idOfFirst = mockInvoke.mock.calls
      .filter((c) => c[0] === "generate_text")
      .map((c) => c[1].requestId)[0];
    useBatchStore.getState().cancel(first.key);

    const after = useBatchStore.getState().items[0];
    expect(after.status).toBe("cancelled");
    expect(after.requestId).toBeNull();
    const cancelCall = mockInvoke.mock.calls.find((c) => c[0] === "cancel_generation");
    expect(cancelCall?.[1]).toEqual({ requestId: idOfFirst });

    pending("late");
    await flush();
    expect(useBatchStore.getState().items[0].status).toBe("cancelled");
  });

  it("cancelAll 取消全部在途条目并解锁界面", async () => {
    mockInvoke.mockImplementation(() => new Promise(() => {}));
    useBatchStore.getState().start("text", "generate_text", ["a", "b", "c"], {});
    await flush();
    expect(useBatchStore.getState().running).toBe(true);

    useBatchStore.getState().cancelAll();
    const s = useBatchStore.getState();
    expect(s.running).toBe(false);
    expect(s.items.every((i) => i.status === "cancelled")).toBe(true);
    expect(s.finished()).toBe(3);
    expect(mockInvoke.mock.calls.filter((c) => c[0] === "cancel_generation").length).toBe(3);
  });
});
