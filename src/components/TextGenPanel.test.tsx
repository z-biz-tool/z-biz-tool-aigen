/**
 * 面板组件级测试（06 §3「单元(前端)：useGeneration、store、面板」那一行）。
 * 覆盖：错误 code → 具体降级界面（03 §7）、取消入口、服务商模型清单驱动下拉（B4 的 UI 半边）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import TextGenPanel from "./TextGenPanel";
import { useAIGenStore, type PublicProvider } from "../stores/aiStore";
import { EMPTY_TASK, useGenerationStore } from "../stores/generationStore";
import type { GenerationState } from "../_shared/jobClient";

const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>;
const mockListen = listen as unknown as ReturnType<typeof vi.fn>;

type Handler = (e: { payload: GenerationState }) => void;
let handlers: Array<{ event: string; fn: Handler }> = [];

const state = (over: Partial<GenerationState> = {}): GenerationState => ({
  requestId: "job-1",
  kind: "text",
  status: "succeeded",
  model: "gpt-4o",
  partial: "",
  progress: null,
  resultRefs: [],
  preview: [],
  textResult: null,
  recordId: null,
  usage: null,
  error: null,
  createdAt: "",
  updatedAt: "",
  ...over,
});

const provider = (over: Partial<PublicProvider> & { id: string }): PublicProvider => ({
  name: over.id,
  base_url: "https://a/v1",
  capabilities: ["text"],
  models: [],
  has_key: true,
  key_masked: "sk-****1",
  ...over,
});

/** 等监听挂上再把任务推到指定状态（否则事件会抢在订阅之前发出而丢失） */
async function settle(next: Partial<GenerationState>) {
  await waitFor(() => expect(handlers.length).toBeGreaterThan(0));
  await act(async () => {
    handlers.forEach((h) => h.fn({ payload: state({ ...next, requestId: "job-1" }) }));
    await Promise.resolve();
  });
}

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  handlers = [];
  useGenerationStore.setState({
    tasks: { image: EMPTY_TASK, video: EMPTY_TASK, ppt: EMPTY_TASK, text: EMPTY_TASK },
    prompts: { image: "", video: "", ppt: "", text: "" },
  });
  useAIGenStore.setState({
    providers: [provider({ id: "oa", capabilities: ["text"] })],
    active: { text: "oa" },
    configLoaded: true,
    configError: null,
    configOpen: false,
  });
  mockListen.mockImplementation(async (event: string, fn: Handler) => {
    handlers.push({ event, fn });
    return () => {};
  });
  mockInvoke.mockImplementation((cmd: string) => {
    if (cmd === "submit_generation") return Promise.resolve({ requestId: "job-1" });
    if (cmd === "list_templates") return Promise.resolve({ items: [], corrupted: 0 });
    if (cmd === "get_generation")
      return Promise.resolve(state({ status: "submitting", textResult: null, preview: [], resultRefs: [], recordId: null, error: null }));
    return Promise.resolve({});
  });
});

describe("TextGenPanel 的状态与降级", () => {
  it("空态有引导文案，且模型下拉来自服务商清单（B4）", async () => {
    useAIGenStore.setState({
      providers: [provider({ id: "oa", models: ["gpt-4o", "gpt-4o-mini"] })],
    });
    render(<TextGenPanel />);
    expect(screen.getByText(/开始你的 AI 写作之旅/)).toBeTruthy();
    expect(screen.getByText(/AI 模型（来自 oa）/)).toBeTruthy();
    // 默认选中服务商清单的第一项
    expect(document.body.textContent).toContain("gpt-4o");
  });

  it("服务商没声明模型时退回内置清单，并提示会被服务商拒绝", () => {
    render(<TextGenPanel />);
    expect(screen.getByText(/未从服务商拉取模型清单/)).toBeTruthy();
    expect(document.body.textContent).toContain("GPT-4o Mini (经济)");
  });

  it("提交中：主按钮变成可取消，任务态在 store 里", async () => {
    render(<TextGenPanel />);
    const box = document.querySelector("textarea")!;
    fireEvent.change(box, { target: { value: "写一段秋天" } });
    fireEvent.click(screen.getByRole("button", { name: /生成文本/ }));
    await waitFor(() =>
      expect(useGenerationStore.getState().tasks.text.status).toBe("submitting")
    );
    expect(screen.getAllByRole("button", { name: /取消生成/ }).length).toBeGreaterThan(0);
    expect(mockInvoke).toHaveBeenCalledWith("submit_generation", expect.anything());
  });

  it("NO_CONFIG：给「打开 API 配置」而不是重试按钮（03 §7）", async () => {
    render(<TextGenPanel />);
    fireEvent.change(document.querySelector("textarea")!, { target: { value: "写" } });
    fireEvent.click(screen.getByRole("button", { name: /生成文本/ }));
    await settle({
      status: "failed",
      error: { code: "NO_CONFIG", message: "尚未配置 API 密钥", retryable: false },
    });
    expect(screen.getByText("生成失败")).toBeTruthy();
    expect(screen.getByText(/请先在「API 配置」中填写/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /打开 API 配置/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /重 试|重试/ })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /打开 API 配置/ }));
    expect(useAIGenStore.getState().configOpen).toBe(true);
  });

  it("RATE_LIMIT：可重试错误必须给出重试入口", async () => {
    render(<TextGenPanel />);
    fireEvent.change(document.querySelector("textarea")!, { target: { value: "写" } });
    fireEvent.click(screen.getByRole("button", { name: /生成文本/ }));
    await settle({
      status: "failed",
      error: { code: "RATE_LIMIT", message: "触发上游限流（429）", retryable: true },
    });
    expect(screen.getByText(/上游限流，已自动重试仍未成功/)).toBeTruthy();
    const retry = screen.getByRole("button", { name: /重试/ });
    expect(retry).toBeTruthy();
    const before = mockInvoke.mock.calls.length;
    fireEvent.click(retry);
    await waitFor(() => expect(mockInvoke.mock.calls.length).toBeGreaterThan(before));
  });

  it("成功：展示结果并给出复制/导出入口，不残留流式标记", async () => {
    render(<TextGenPanel />);
    fireEvent.change(document.querySelector("textarea")!, { target: { value: "写" } });
    fireEvent.click(screen.getByRole("button", { name: /生成文本/ }));
    await settle({ status: "streaming", partial: "第一段" });
    expect(document.body.textContent).toContain("第一段");
    expect(screen.getByText(/流式生成中/)).toBeTruthy();
    await settle({ status: "succeeded", textResult: "第一段完整结果" });
    expect(screen.getByText("第一段完整结果")).toBeTruthy();
    expect(screen.queryByText(/流式生成中/)).toBeNull();
    expect(screen.getByRole("button", { name: /复制全文/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /导出/ })).toBeTruthy();
  });
});
