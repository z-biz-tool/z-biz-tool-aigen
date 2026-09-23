import { beforeEach, describe, expect, it, vi } from "vitest";

// Tauri IPC 全 mock：不碰真实后端，也不碰真实上游（06 §2、R8）
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { EMPTY_TASK, useGenerationStore, type TaskState } from "./generationStore";
import type { GenerationState } from "../_shared/jobClient";

const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>;
const mockListen = listen as unknown as ReturnType<typeof vi.fn>;

type Handler = (e: { payload: GenerationState }) => void;
let handlers: Array<{ event: string; fn: Handler }> = [];

const blank: TaskState = EMPTY_TASK;

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
    recordId: "rec-1",
    usage: null,
    error: null,
    createdAt: "2026-09-22T10:00:00Z",
    updatedAt: "2026-09-22T10:00:05Z",
    ...over,
  };
}

/** 统一入口的默认应答：submit 给 id、对账故意失败（逼测试靠事件推进，形状更真实） */
function stubSubmit(requestId = "job-1") {
  mockInvoke.mockImplementation((cmd: string) => {
    if (cmd === "submit_generation") return Promise.resolve({ requestId });
    if (cmd === "cancel_generation") return Promise.resolve(true);
    if (cmd === "get_generation")
      return Promise.reject({ code: "INVALID_PARAM", message: "尚未就绪", retryable: false });
    return Promise.reject({ code: "UNKNOWN", message: `ns ${cmd}`, retryable: false });
  });
}

const emit = (id: string, st: GenerationState) => {
  handlers.filter((h) => h.event === `aigen://state/${id}`).forEach((h) => h.fn({ payload: st }));
};

const tick = async (n = 3) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};
const task = (kind: "text" | "image" | "video" | "ppt" = "text") =>
  useGenerationStore.getState().tasks[kind];

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

describe("submit → 统一入口 submit_generation", () => {
  it("请求体形状与 Rust GenerationRequest 对齐（camelCase）", async () => {
    stubSubmit();
    const p = useGenerationStore.getState().submit("image", {
      prompt: "橘猫",
      model: "dall-e-3",
      providerId: "oa",
      params: { count: 2, size: "1024x1024" },
    });
    await tick();
    const [cmd, args] = mockInvoke.mock.calls[0];
    expect(cmd).toBe("submit_generation");
    expect(args.req).toEqual({
      kind: "image",
      prompt: "橘猫",
      providerId: "oa",
      model: "dall-e-3",
      params: { count: 2, size: "1024x1024" },
    });
    emit("job-1", jobState("job-1", { kind: "image", preview: ["https://cdn/a.png"] }));
    await p;
  });

  it("成功：文本终态写入 result/model/usage/recordId", async () => {
    stubSubmit();
    const p = useGenerationStore.getState().submit("text", { prompt: "hi" });
    await tick();
    emit("job-1", jobState("job-1", { textResult: "统一入口的结果", usage: { prompt_tokens: 3, completion_tokens: 7 } }));
    await p;

    expect(task().status).toBe("succeeded");
    expect(task().result).toBe("统一入口的结果");
    expect(task().model).toBe("gpt-4o");
    expect(task().usage).toEqual({ prompt_tokens: 3, completion_tokens: 7 });
    expect(task().requestId).toBeNull();
    expect(task().finishedAt).not.toBeNull();
  });

  it("流式：中间态只更新 partial，终态才清空", async () => {
    stubSubmit();
    const p = useGenerationStore.getState().submit("text", { prompt: "hi", params: { stream: true } });
    await tick();
    emit("job-1", jobState("job-1", { status: "submitting", partial: "" }));
    emit("job-1", jobState("job-1", { status: "streaming", partial: "你好" }));
    expect(task().partial).toBe("你好");
    expect(task().status).toBe("streaming");

    emit("job-1", jobState("job-1", { status: "streaming", partial: "你好世界" }));
    expect(task().partial).toBe("你好世界");

    emit("job-1", jobState("job-1", { status: "succeeded", partial: "你好世界", textResult: "你好世界" }));
    await p;
    expect(task().status).toBe("succeeded");
    expect(task().result).toBe("你好世界");
    expect(task().partial).toBe("");
  });

  it("事件丢一条也能靠 get_generation 对账收敛", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "submit_generation") return Promise.resolve({ requestId: "job-9" });
      if (cmd === "get_generation")
        return Promise.resolve(jobState("job-9", { textResult: "对账拿到的结果" }));
      return Promise.reject({ code: "UNKNOWN", message: "ns", retryable: false });
    });
    await useGenerationStore.getState().submit("text", { prompt: "hi" });
    expect(task().status).toBe("succeeded");
    expect(task().result).toBe("对账拿到的结果");
    expect(mockInvoke).toHaveBeenCalledWith("get_generation", { requestId: "job-9" });
  });

  it("失败：错误按契约落 store，结果清空", async () => {
    stubSubmit();
    const p = useGenerationStore.getState().submit("text", { prompt: "hi" });
    await tick();
    emit(
      "job-1",
      jobState("job-1", {
        status: "failed",
        error: { code: "UPSTREAM_5XX", message: "上游服务暂时不可用（502）", retryable: true },
      })
    );
    await p;
    expect(task().status).toBe("failed");
    expect(task().error?.code).toBe("UPSTREAM_5XX");
    expect(task().error?.retryable).toBe(true);
    expect(task().result).toBeNull();
  });

  it("取消：本地乐观复位 + cancel_generation 带上刚拿到的 requestId；迟到的事件不再改写", async () => {
    stubSubmit();
    const p = useGenerationStore.getState().submit("text", { prompt: "hi" });
    await tick();
    expect(task().requestId).toBe("job-1");

    useGenerationStore.getState().cancel("text");
    expect(task().status).toBe("cancelled");
    const cancelCall = mockInvoke.mock.calls.find((c) => c[0] === "cancel_generation");
    expect(cancelCall?.[1]).toEqual({ requestId: "job-1" });

    emit("job-1", jobState("job-1", { status: "succeeded", textResult: "迟到的结果" }));
    await p;
    expect(task().status).toBe("cancelled");
    expect(task().result).toBeNull();
  });

  it("没有 requestId 时取消是 no-op，不发 IPC", () => {
    const before = mockInvoke.mock.calls.length;
    useGenerationStore.getState().cancel("text");
    expect(mockInvoke.mock.calls.length).toBe(before);
  });

  it("切换面板不影响任务：kind 之间状态互相独立", async () => {
    stubSubmit("job-img");
    const p = useGenerationStore.getState().submit("image", { prompt: "橘猫" });
    await tick();
    useGenerationStore.setState((s) => ({
      tasks: { ...s.tasks, text: { ...blank, status: "succeeded", result: "另一条" } },
    }));
    emit("job-img", jobState("job-img", { kind: "image", preview: ["u1", "u2"] }));
    await p;

    expect(task("image").result).toEqual(["u1", "u2"]);
    expect(task("text").result).toBe("另一条");
  });

  it("轮询续跑：keepResult 保住 task: 句柄，进度可见", async () => {
    useGenerationStore.setState((s) => ({
      tasks: { ...s.tasks, video: { ...blank, status: "succeeded", result: "task:vid42" } },
    }));
    stubSubmit("job-poll");
    const p = useGenerationStore
      .getState()
      .submit("video", { prompt: "", params: { taskId: "vid42" } }, { keepResult: true });
    await tick();
    expect(task("video").result).toBe("task:vid42");

    emit("job-poll", jobState("job-poll", { kind: "video", status: "polling", progress: { stage: "processing", percent: 42 } }));
    expect(task("video").progress).toEqual({ stage: "processing", percent: 42 });
    expect(task("video").result).toBe("task:vid42");

    emit(
      "job-poll",
      jobState("job-poll", { kind: "video", status: "succeeded", preview: ["https://cdn/final.mp4"] })
    );
    await p;
    expect(task("video").result).toBe("https://cdn/final.mp4");
  });

  it("事件订阅失败也不阻断：靠对账收敛", async () => {
    mockListen.mockRejectedValue(new Error("no event bus"));
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "submit_generation") return Promise.resolve({ requestId: "job-x" });
      if (cmd === "get_generation") return Promise.resolve(jobState("job-x", { textResult: "整段结果" }));
      return Promise.reject({ code: "UNKNOWN", message: "ns", retryable: false });
    });
    await useGenerationStore.getState().submit("text", { prompt: "hi" });
    expect(task().status).toBe("succeeded");
    expect(task().result).toBe("整段结果");
  });
});

describe("提示词与回填", () => {
  it("setPrompt / backfill 只动 store，不发任何 IPC", () => {
    const before = mockInvoke.mock.calls.length;
    useGenerationStore.getState().setPrompt("text", "草稿");
    expect(useGenerationStore.getState().prompts.text).toBe("草稿");
    useGenerationStore.getState().backfill("text", "来自历史");
    expect(useGenerationStore.getState().prompts.text).toBe("来自历史");
    expect(useGenerationStore.getState().tasks.text).toEqual(blank);
    expect(mockInvoke.mock.calls.length).toBe(before);
  });
});
