// VideoGenPanel 的参数组装、进度呈现与空输入保护。
// 跑法：npm test（vitest）
//
// 为什么测它：
//   视频是四类生成里**唯一走轮询**的一类（T-B2：上游只回任务号，由后端在同一个
//   job 里轮询，进度以 polling 状态推回来）。这段逻辑有两处静默风险：
//   1. 时长/分辨率没进 req ⇒ 上游按默认值出片，界面不提示（用户以为选了 4K）；
//   2. 轮询中的进度不显示 ⇒ 用户以为卡死了，于是重复提交。
//   这个面板此前**一条测试都没有**。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("antd", async () => {
  const actual = await vi.importActual<typeof import("antd")>("antd");
  return {
    ...actual,
    message: { warning: vi.fn(), success: vi.fn(), error: vi.fn(), info: vi.fn() },
    Modal: { ...actual.Modal, confirm: vi.fn() },
  };
});

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { message } from "antd";
import VideoGenPanel from "./VideoGenPanel";
import { useAIGenStore } from "../stores/aiStore";
import { EMPTY_TASK, useGenerationStore } from "../stores/generationStore";
import { DEFAULT_CRAFT, useUiStore } from "../stores/uiStore";
import type { GenerationState } from "../_shared/jobClient";

const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>;
const mockListen = listen as unknown as ReturnType<typeof vi.fn>;
const mockWarning = message.warning as unknown as ReturnType<typeof vi.fn>;

const jobState = (over: Partial<GenerationState> = {}): GenerationState => ({
  requestId: "job-1",
  kind: "video",
  status: "succeeded",
  model: null,
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

const submittedReqs = () =>
  mockInvoke.mock.calls.filter((c) => c[0] === "submit_generation").map((c) => c[1].req);

function set(el: HTMLElement, v: string) {
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, v);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

beforeEach(() => {
  mockInvoke.mockReset();
  mockListen.mockReset();
  mockWarning.mockReset();
  localStorage.clear();
  useGenerationStore.setState({
    tasks: { image: EMPTY_TASK, video: EMPTY_TASK, ppt: EMPTY_TASK, text: EMPTY_TASK },
    prompts: { image: "", video: "", ppt: "", text: "" },
  });
  useUiStore.setState({
    forms: structuredClone(DEFAULT_CRAFT.forms),
    prompts: { image: "", video: "", ppt: "", text: "" },
  });
  useAIGenStore.setState({
    providers: [
      {
        id: "oa",
        name: "OpenAI",
        base_url: "https://a/v1",
        capabilities: ["video"],
        models: ["sora"],
        has_key: true,
        key_masked: "sk-****1",
      },
    ],
    active: { video: "oa" },
    configLoaded: true,
    configOpen: false,
  });
  mockListen.mockImplementation(async () => () => {});
  mockInvoke.mockImplementation((cmd: string) => {
    if (cmd === "submit_generation") return Promise.resolve({ requestId: "job-1" });
    if (cmd === "get_generation")
      return Promise.resolve(jobState({ status: "submitting", resultRefs: [] }));
    return Promise.resolve({});
  });
});

afterEach(() => cleanup());

describe("VideoGenPanel：空输入保护", () => {
  it("脚本为空 ⇒ 提示且**不调用后端**", () => {
    render(<VideoGenPanel />);
    fireEvent.click(screen.getByRole("button", { name: /生成视频/ }));
    expect(mockWarning).toHaveBeenCalledWith("请输入视频脚本");
    expect(mockInvoke).not.toHaveBeenCalled();
  });
});

describe("VideoGenPanel：参数必须真的进 req", () => {
  it("脚本、时长、分辨率都进 req", async () => {
    render(<VideoGenPanel />);
    set(screen.getByPlaceholderText("输入或粘贴你的视频脚本内容..."), "一只猫在跑");
    fireEvent.click(screen.getByRole("button", { name: /生成视频/ }));

    await waitFor(() => expect(submittedReqs().length).toBe(1));
    const req = submittedReqs()[0];
    expect(req.kind).toBe("video");
    expect(req.prompt).toBe("一只猫在跑");
    expect(req.params).toMatchObject({ duration: "5", resolution: "1080p" });
  });

  it("改了时长与分辨率后，req 里是**改后**的值", async () => {
    // 直接改 store：面板的 Select 读的就是 store 里的表单值，
    // 这样不必在 jsdom 里驱动 antd Select 的下拉交互。
    useUiStore.getState().setForm("video", "duration", "30");
    useUiStore.getState().setForm("video", "resolution", "4k");
    render(<VideoGenPanel />);
    set(screen.getByPlaceholderText("输入或粘贴你的视频脚本内容..."), "脚本");
    fireEvent.click(screen.getByRole("button", { name: /生成视频/ }));

    await waitFor(() => expect(submittedReqs().length).toBe(1));
    expect(submittedReqs()[0].params).toMatchObject({ duration: "30", resolution: "4k" });
  });
});

describe("VideoGenPanel：轮询中的进度呈现", () => {
  it("有 progress 时展示进度与「取消等待」，而不是笼统的加载态", () => {
    useGenerationStore.setState({
      tasks: {
        image: EMPTY_TASK,
        video: {
          ...EMPTY_TASK,
          status: "polling",
          requestId: "job-1",
          progress: { percent: 42, stage: "渲染中" },
        },
        ppt: EMPTY_TASK,
        text: EMPTY_TASK,
      },
    });
    render(<VideoGenPanel />);
    expect(screen.getByText(/正在等待上游出片/)).toBeTruthy();
    expect(screen.getByText(/渲染中/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /取消等待/ })).toBeTruthy();
  });

  it("轮询态下依然可以取消（按钮不消失）", () => {
    useGenerationStore.setState({
      tasks: {
        image: EMPTY_TASK,
        video: {
          ...EMPTY_TASK,
          status: "polling",
          requestId: "job-1",
          progress: { percent: 10, stage: "排队中" },
        },
        ppt: EMPTY_TASK,
        text: EMPTY_TASK,
      },
    });
    render(<VideoGenPanel />);
    expect(screen.getAllByRole("button", { name: /取消/ }).length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByRole("button", { name: /生成视频/ })).toBeNull();
  });
});
