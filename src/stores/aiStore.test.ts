import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import {
  isReadyFor,
  providerFor,
  useAIGenStore,
  type PublicProvider,
} from "./aiStore";

const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>;

const p = (over: Partial<PublicProvider> & { id: string }): PublicProvider => ({
  name: over.name ?? over.id,
  base_url: over.base_url ?? "https://a.example.com/v1",
  capabilities: over.capabilities ?? [],
  models: over.models ?? [],
  has_key: over.has_key ?? true,
  key_masked: over.key_masked ?? "sk-****1234",
  ...over,
});

const OA = p({ id: "oa", name: "OpenAI", capabilities: ["text", "image"], models: ["gpt-4o"] });
const MM = p({ id: "mm", name: "MiniMax", base_url: "https://mm.example.com/v1", capabilities: ["text", "video"] });
const NOKEY = p({ id: "nokey", has_key: false, key_masked: null, capabilities: ["image"] });

beforeEach(() => {
  useAIGenStore.setState({
    providers: [OA, MM],
    active: { text: "mm", image: "oa" },
    configLoaded: false,
    configError: null,
    history: [],
    historyTotal: 0,
    historyStored: 0,
    historyDropped: 0,
  });
});

describe("providerFor：按能力路由（03 §3 / 修 B4）", () => {
  it("优先用该类型的默认服务商", () => {
    expect(providerFor({ providers: [OA, MM], active: { text: "mm" } }, "text")?.id).toBe("mm");
  });

  it("只有一个候选时自动选中，不必先设默认", () => {
    expect(providerFor({ providers: [OA], active: {} }, "image")?.id).toBe("oa");
  });

  it("多个候选且没设默认 → 返回 null（前端不猜，后端会要求用户选）", () => {
    expect(providerFor({ providers: [OA, MM], active: {} }, "text")).toBeNull();
  });

  it("没有支持该能力的服务商 → null", () => {
    expect(providerFor({ providers: [OA], active: { video: "oa" } }, "video")).toBeNull();
  });

  it("active 指向不支持该能力的服务商时不采信", () => {
    expect(providerFor({ providers: [OA, MM], active: { image: "mm" } }, "image")?.id).toBe("oa");
  });

  it("空 capabilities 视作全能力（迁移来的旧配置）", () => {
    const legacy = p({ id: "legacy", capabilities: [] });
    for (const kind of ["text", "image", "video", "ppt"] as const) {
      expect(providerFor({ providers: [legacy], active: {} }, kind)?.id).toBe("legacy");
    }
  });

  it("isReadyFor 要求密钥已配置", () => {
    expect(isReadyFor({ providers: [NOKEY], active: { image: "nokey" } }, "image")).toBe(false);
    expect(isReadyFor({ providers: [OA], active: { image: "oa" } }, "image")).toBe(true);
  });
});

describe("配置 IPC：密钥单向、不回读（04 §2.2）", () => {
  it("loadConfig 读取服务商视图并落到 store", async () => {
    mockInvoke.mockResolvedValue({ providers: [OA, MM], active: { text: "mm" } });
    await useAIGenStore.getState().loadConfig();

    expect(mockInvoke).toHaveBeenCalledWith("load_api_config");
    const s = useAIGenStore.getState();
    expect(s.providers.map((x) => x.id)).toEqual(["oa", "mm"]);
    expect(s.active.text).toBe("mm");
    expect(s.configLoaded).toBe(true);
    // store 里不存在任何完整密钥字段
    expect(JSON.stringify(s.providers)).not.toContain("sk-TEST");
  });

  it("loadConfig 失败不抛，只记错误并保留未配置态", async () => {
    mockInvoke.mockRejectedValue({ code: "STORAGE", message: "读取配置文件失败", retryable: false });
    await useAIGenStore.getState().loadConfig();

    const s = useAIGenStore.getState();
    expect(s.configError).toBe("读取配置文件失败");
    expect(s.providers).toEqual([]);
  });

  it("saveProvider 用 camelCase 入参，空密钥转成 null 表示不修改", async () => {
    mockInvoke.mockResolvedValue({ providers: [OA], active: {} });
    await useAIGenStore.getState().saveProvider({
      providerId: "oa",
      baseUrl: "  https://api.openai.com/v1  ",
      apiKey: "   ",
      capabilities: ["text"],
    });

    const [cmd, args] = mockInvoke.mock.calls[0];
    expect(cmd).toBe("save_api_config");
    expect(args).toMatchObject({
      providerId: "oa",
      baseUrl: "https://api.openai.com/v1",
      apiKey: null,
      capabilities: ["text"],
    });
  });

  it("saveProvider 会把用户输入的密钥原样交给后端（仅此一次方向）", async () => {
    mockInvoke.mockResolvedValue({ providers: [OA], active: {} });
    await useAIGenStore
      .getState()
      .saveProvider({ baseUrl: "https://api.openai.com/v1", apiKey: "sk-TEST-secret-9f3a" });
    expect(mockInvoke.mock.calls[0][1].apiKey).toBe("sk-TEST-secret-9f3a");
  });

  it("setActive / removeProvider / testProvider 走对应命令", async () => {
    mockInvoke.mockResolvedValue({ providers: [OA], active: { text: "oa" } });
    await useAIGenStore.getState().setActive("text", "oa");
    expect(mockInvoke).toHaveBeenLastCalledWith("set_active_provider", { kind: "text", providerId: "oa" });

    await useAIGenStore.getState().removeProvider("oa");
    expect(mockInvoke).toHaveBeenLastCalledWith("delete_provider", { providerId: "oa" });

    mockInvoke.mockResolvedValue(["gpt-4o"]);
    await expect(useAIGenStore.getState().testProvider("oa")).resolves.toEqual(["gpt-4o"]);
    expect(mockInvoke).toHaveBeenLastCalledWith("test_provider", { providerId: "oa" });
  });

  it("历史分页参数按后端契约传 snake→camel，并落 total/stored/dropped", async () => {
    mockInvoke.mockResolvedValue({ items: [], total: 7, stored: 9, dropped_lines: 2 });
    await useAIGenStore.getState().loadHistory({ kind: "text", keyword: "猫", page: 1, size: 5 });

    expect(mockInvoke).toHaveBeenCalledWith("list_history", {
      kind: "text",
      keyword: "猫",
      page: 1,
      size: 5,
    });
    const s = useAIGenStore.getState();
    expect([s.historyTotal, s.historyStored, s.historyDropped]).toEqual([7, 9, 2]);
  });

  it("wipeHistory 清空本地列表；removeHistory 之后重读", async () => {
    useAIGenStore.setState({ history: [{} as never], historyTotal: 1 });
    mockInvoke.mockResolvedValue(undefined);
    await useAIGenStore.getState().wipeHistory();
    expect(useAIGenStore.getState().history).toEqual([]);
    expect(mockInvoke).toHaveBeenCalledWith("clear_history");

    mockInvoke.mockResolvedValue(true);
    await useAIGenStore.getState().removeHistory("abc");
    // 删除后会自动重读列表，所以最后一跳是 list_history
    expect(mockInvoke).toHaveBeenCalledWith("delete_history", { id: "abc" });
    expect(mockInvoke).toHaveBeenLastCalledWith("list_history", {
      kind: null,
      keyword: null,
      page: 0,
      size: 50,
    });
  });
});
