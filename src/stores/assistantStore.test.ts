import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { useAssistantStore } from "./assistantStore";
import { useGenerationStore } from "./generationStore";
import { useAIGenStore } from "./aiStore";

const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>;
const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

const reply = {
  suggestions: [{ kind: "diagnose", title: "还没配好服务商", detail: "去配置" }],
  rewritten: "一只橘猫在窗台，逆光，胶片质感",
  heuristic_only: false,
  usage: { prompt_tokens: 30, completion_tokens: 40 },
};

beforeEach(() => {
  useAssistantStore.setState({
    open: false,
    loading: false,
    kind: null,
    reply: null,
    error: null,
    requestId: null,
  });
});

describe("助手只提建议（02 §8 验收：采纳前 0 副作用）", () => {
  it("ask 只调用 assist_generation，不碰生成/配置/写盘命令", async () => {
    mockInvoke.mockResolvedValue(reply);
    await useAssistantStore.getState().ask("image", "猫", "dall-e-3", "RATE_LIMIT");

    const commands = mockInvoke.mock.calls.map((c) => c[0]);
    expect(commands).toEqual(["assist_generation"]);
    expect(commands).not.toContain("generate_image");
    expect(commands).not.toContain("save_api_config");
    expect(commands).not.toContain("save_export");
  });

  it("入参带 requestId/kind/prompt/lastError，供后端路由与诊断", async () => {
    mockInvoke.mockResolvedValue(reply);
    await useAssistantStore.getState().ask("text", "写一段随笔", undefined, "TIMEOUT");
    const [, args] = mockInvoke.mock.calls[0];
    expect(args).toMatchObject({ kind: "text", prompt: "写一段随笔", lastError: "TIMEOUT" });
    expect(typeof args.requestId).toBe("string");
  });

  it("建议返回后不会自动改提示词草稿——必须由用户点「填入」", async () => {
    const before = useGenerationStore.getState().prompts.image;
    mockInvoke.mockResolvedValue(reply);
    await useAssistantStore.getState().ask("image", "猫");

    expect(useAssistantStore.getState().reply?.rewritten).toBe(reply.rewritten);
    expect(useGenerationStore.getState().prompts.image).toBe(before);
  });

  it("取消后不再写回迟到的建议", async () => {
    let resolve!: (v: unknown) => void;
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "cancel_generation") return Promise.resolve(true);
      return new Promise((r) => (resolve = r));
    });

    const p = useAssistantStore.getState().ask("text", "写点东西");
    await flush();
    useAssistantStore.getState().cancel();

    expect(useAssistantStore.getState().loading).toBe(false);
    expect(useAssistantStore.getState().reply).toBeNull();
    const cancelCall = mockInvoke.mock.calls.find((c) => c[0] === "cancel_generation");
    expect(cancelCall?.[1].requestId).toBeTruthy();

    resolve(reply);
    await p;
    expect(useAssistantStore.getState().reply).toBeNull();
  });

  it("失败按错误契约暴露，不静默吞掉", async () => {
    mockInvoke.mockRejectedValue({ code: "NO_CONFIG", message: "还没配置", retryable: false });
    await useAssistantStore.getState().ask("text", "x");
    expect(useAssistantStore.getState().error).toMatchObject({ code: "NO_CONFIG" });
    expect(useAssistantStore.getState().loading).toBe(false);
  });

  it("取消后 CANCELLED 不当错误显示", async () => {
    mockInvoke.mockRejectedValue({ code: "CANCELLED", message: "已取消生成", retryable: false });
    await useAssistantStore.getState().ask("text", "x");
    expect(useAssistantStore.getState().error).toBeNull();
  });

  it("助手不修改服务商配置状态", async () => {
    const before = useAIGenStore.getState().providers;
    mockInvoke.mockResolvedValue(reply);
    await useAssistantStore.getState().ask("text", "x");
    expect(useAIGenStore.getState().providers).toBe(before);
  });
});
