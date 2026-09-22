import { beforeEach, describe, expect, it, vi } from "vitest";

// Tauri 前端 API 全部 mock：单测不碰真实 IPC，也不碰真实上游（06 §2、R8）
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useGenerationStore, type TaskState } from "./generationStore";

const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>;
const mockListen = listen as unknown as ReturnType<typeof vi.fn>;

const blank: TaskState = {
  status: "idle",
  requestId: null,
  result: null,
  partial: "",
  progress: null,
  error: null,
  startedAt: null,
  finishedAt: null,
};

type Handler = (e: { payload: unknown }) => void;
let handlers: Array<{ event: string; fn: Handler }> = [];

beforeEach(() => {
  handlers = [];
  useGenerationStore.setState({
    tasks: { image: blank, video: blank, ppt: blank, text: blank },
    prompts: { image: "", video: "", ppt: "", text: "" },
  });
  mockListen.mockImplementation(async (event: string, fn: Handler) => {
    handlers.push({ event, fn });
    return () => {};
  });
});

const task = (kind = "text") => useGenerationStore.getState().tasks[kind as "text"];
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("generationStore.submit", () => {
  it("成功：结果落到 store，requestId 归零，且带 request_id 下发", async () => {
    mockInvoke.mockResolvedValue("模型输出");
    await useGenerationStore.getState().submit("text", "generate_text", { prompt: "hi" });

    expect(task().status).toBe("succeeded");
    expect(task().result).toBe("模型输出");
    expect(task().requestId).toBeNull();
    expect(task().finishedAt).not.toBeNull();

    const [, args] = mockInvoke.mock.calls[0];
    expect(args).toMatchObject({ prompt: "hi", requestId: expect.any(String) });
  });

  it("失败：错误按结构化契约入 store，供 ErrorState 分支降级", async () => {
    mockInvoke.mockRejectedValue({ code: "NO_CONFIG", message: "尚未配置", retryable: false });
    await useGenerationStore.getState().submit("text", "generate_text", { prompt: "hi" });

    expect(task().status).toBe("failed");
    expect(task().error).toEqual({ code: "NO_CONFIG", message: "尚未配置", retryable: false });
    expect(task().result).toBeNull();
  });

  it("取消：后端回 CANCELLED 时静默回 Idle，不当错误展示（03 §7）", async () => {
    mockInvoke.mockRejectedValue({ code: "CANCELLED", message: "已取消生成", retryable: false });
    await useGenerationStore.getState().submit("text", "generate_text", { prompt: "hi" });

    expect(task().status).toBe("cancelled");
    expect(task().error).toBeNull();
  });

  it("取消：本地乐观复位，不等后端结算，且迟到的结果被丢弃", async () => {
    let resolve!: (v: string) => void;
    // 按命令分流：否则 cancel_generation 会覆盖掉同一个 resolve 句柄
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "cancel_generation") return Promise.resolve(true);
      return new Promise<string>((r) => (resolve = r));
    });

    const running = useGenerationStore.getState().submit("text", "generate_text", { prompt: "hi" });
    await settle();
    const sentId = mockInvoke.mock.calls[0][1].requestId;

    useGenerationStore.getState().cancel("text");
    expect(task().status).toBe("cancelled");

    const cancelCall = mockInvoke.mock.calls.find((c) => c[0] === "cancel_generation");
    expect(cancelCall?.[1]).toEqual({ requestId: sentId });

    // 上游随后才返回：不得把已取消的任务复活
    resolve("迟到的结果");
    await running;
    expect(task().result).toBeNull();
    expect(task().status).toBe("cancelled");
  });

  it("空号取消不发 IPC：没有进行中任务时 cancel 是 no-op", () => {
    useGenerationStore.getState().cancel("text");
    expect(mockInvoke.mock.calls.length).toBe(0);
  });

  it("流式：增量按序累加进 partial，done 之后不再标成 streaming", async () => {
    let resolve!: (v: string) => void;
    mockInvoke.mockImplementation(() => new Promise((r) => (resolve = r)));
    const p = useGenerationStore.getState().submit(
      "text",
      "generate_text_stream",
      { prompt: "hi" },
      { stream: true }
    );
    await settle();

    const { event, fn } = handlers[0];
    expect(event).toBe(`aigen://stream/${mockInvoke.mock.calls[0][1].requestId}`);
    fn({ payload: { delta: "你好", done: false } });
    expect(task().partial).toBe("你好");
    expect(task().status).toBe("streaming");
    fn({ payload: { delta: "世界", done: false } });
    expect(task().partial).toBe("你好世界");
    fn({ payload: { delta: "", done: true, usage: { prompt_tokens: 1, completion_tokens: 2 } } });

    resolve("你好世界");
    await p;
    expect(task().status).toBe("succeeded");
    expect(task().result).toBe("你好世界");
    // 收尾后清掉中间态，最终只展示完整结果
    expect(task().partial).toBe("");
  });

  it("事件通道挂不上也不阻断生成（退化为整段返回）", async () => {
    mockListen.mockRejectedValue(new Error("no event bus"));
    mockInvoke.mockResolvedValue("整段结果");
    await useGenerationStore
      .getState()
      .submit("text", "generate_text_stream", { prompt: "hi" }, { stream: true });

    expect(task().status).toBe("succeeded");
    expect(task().result).toBe("整段结果");
  });
});

describe("generationStore.pollVideo（T-B2）", () => {
  it("轮询期间保留 task: 句柄，成功后才换成真实 URL", async () => {
    useGenerationStore.setState({
      tasks: {
        ...useGenerationStore.getState().tasks,
        video: { ...blank, status: "succeeded", result: "task:vid42" },
      },
    });
    let resolve!: (v: string) => void;
    mockInvoke.mockImplementation(() => new Promise((r) => (resolve = r)));

    const p = useGenerationStore.getState().pollVideo("vid42");
    await settle();
    expect(task("video").status).toBe("polling");
    expect(task("video").result).toBe("task:vid42");

    handlers[0].fn({ payload: { percent: 42, stage: "processing" } });
    expect(task("video").progress).toEqual({ percent: 42, stage: "processing" });
    expect(task("video").result).toBe("task:vid42");

    resolve("https://cdn/final.mp4");
    await p;
    expect(task("video").status).toBe("succeeded");
    expect(task("video").result).toBe("https://cdn/final.mp4");
    expect(task("video").progress).toEqual({ percent: 100, stage: "已完成" });
  });

  it("轮询失败退回可重试错误，不谎报成功", async () => {
    useGenerationStore.setState({
      tasks: { ...useGenerationStore.getState().tasks, video: { ...blank, result: "task:x" } },
    });
    mockInvoke.mockRejectedValue({ code: "TIMEOUT", message: "预算内未出片", retryable: true });
    await useGenerationStore.getState().pollVideo("x");

    expect(task("video").status).toBe("failed");
    expect(task("video").error?.code).toBe("TIMEOUT");
    expect(task("video").result).toBeNull();
  });
});
