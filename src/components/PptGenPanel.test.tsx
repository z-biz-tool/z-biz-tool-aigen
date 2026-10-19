// PptGenPanel 的参数组装与空输入保护。
// 跑法：npm test（vitest）
//
// 为什么测它：
//   PPT 面板是**四类生成里唯一带结构化输入**的（主题 + 模板 + 页数 + 大纲）。
//   它的失败形态是静默的：面板上用户填了大纲、选了模板、设了页数，
//   提交时少传一个字段 ⇒ 后端照收，生成出一份**不按用户输入**的 PPT，
//   界面上看不出任何异常。ImageGenPanel / TextGenPanel 已有同款测试，
//   PptGenPanel 此前**一条没有**。
//
// 这里测的是**面板这一侧**：读到的值有没有真的进 `submit_generation` 的 req。
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
import PptGenPanel from "./PptGenPanel";
import { useAIGenStore } from "../stores/aiStore";
import { EMPTY_TASK, useGenerationStore } from "../stores/generationStore";
import { DEFAULT_CRAFT, useUiStore } from "../stores/uiStore";
import type { GenerationState } from "../_shared/jobClient";

const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>;
const mockListen = listen as unknown as ReturnType<typeof vi.fn>;
const mockWarning = message.warning as unknown as ReturnType<typeof vi.fn>;

const jobState = (over: Partial<GenerationState> = {}): GenerationState => ({
  requestId: "job-1",
  kind: "ppt",
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

/** 提交出去的 req（前端组装的那一份） */
const submittedReqs = () =>
  mockInvoke.mock.calls.filter((c) => c[0] === "submit_generation").map((c) => c[1].req);

/** React 受控 input 需要绕过 value tracker 才能触发 onChange */
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
        capabilities: ["ppt"],
        models: ["gpt-4o-mini"],
        has_key: true,
        key_masked: "sk-****1",
      },
    ],
    active: { ppt: "oa" },
    configLoaded: true,
    configOpen: false,
  });
  mockListen.mockImplementation(
    async (_event: string, fn: (e: { payload: GenerationState }) => void) => {
      void fn;
      return () => {};
    }
  );
  mockInvoke.mockImplementation((cmd: string) => {
    if (cmd === "submit_generation") return Promise.resolve({ requestId: "job-1" });
    if (cmd === "get_generation")
      return Promise.resolve(jobState({ status: "submitting", resultRefs: [] }));
    return Promise.resolve({});
  });
});

afterEach(() => cleanup());

describe("PptGenPanel：空输入保护", () => {
  it("主题为空 ⇒ 提示且**不调用后端**", () => {
    render(<PptGenPanel />);
    fireEvent.click(screen.getByRole("button", { name: /生成PPT/ }));
    expect(mockWarning).toHaveBeenCalledWith("请输入PPT主题");
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("主题只有空白字符时同样不提交", () => {
    render(<PptGenPanel />);
    set(screen.getByPlaceholderText("例如：2024年度产品发布会"), "   ");
    fireEvent.click(screen.getByRole("button", { name: /生成PPT/ }));
    expect(mockInvoke).not.toHaveBeenCalled();
  });
});

describe("PptGenPanel：参数必须真的进 req", () => {
  it("主题、模板、页数、大纲都进 req", async () => {
    useUiStore.setState({
      forms: {
        ...structuredClone(DEFAULT_CRAFT.forms),
        ppt: {
          template: "tech",
          slides: 20,
          outline: [{ id: 1, title: "封面", content: "第一页要点" }],
        },
      },
    });
    render(<PptGenPanel />);
    set(screen.getByPlaceholderText("例如：2024年度产品发布会"), "2024 年度发布会");
    fireEvent.click(screen.getByRole("button", { name: /生成PPT/ }));

    await waitFor(() => expect(submittedReqs().length).toBe(1));
    const req = submittedReqs()[0];
    expect(req.kind).toBe("ppt");
    expect(req.prompt).toBe("2024 年度发布会");
    expect(req.params).toMatchObject({ template: "tech", slides: 20 });
    expect(req.params.outline).toEqual([{ id: 1, title: "封面", content: "第一页要点" }]);
  });

  it("新增章节并填写内容后，req 里的 outline 是**最新**的那份", async () => {
    render(<PptGenPanel />);
    set(screen.getByPlaceholderText("例如：2024年度产品发布会"), "发布会");
    fireEvent.click(screen.getByRole("button", { name: /添加章节/ }));

    const titles = screen.getAllByPlaceholderText("页面标题");
    expect(titles.length).toBe(2);
    set(titles[1], "第二页");
    const bodies = screen.getAllByPlaceholderText("页面内容要点（每行一个要点）");
    set(bodies[1], "要点一\n要点二");

    fireEvent.click(screen.getByRole("button", { name: /生成PPT/ }));
    await waitFor(() => expect(submittedReqs().length).toBe(1));
    const outline = submittedReqs()[0].params.outline;
    expect(outline.length).toBe(2);
    expect(outline[1].title).toBe("第二页");
    expect(outline[1].content).toBe("要点一\n要点二");
  });

  it("删掉章节后 req 里也没有那一项", async () => {
    const { container } = render(<PptGenPanel />);
    set(screen.getByPlaceholderText("例如：2024年度产品发布会"), "发布会");
    fireEvent.click(screen.getByRole("button", { name: /添加章节/ }));
    const titles = screen.getAllByPlaceholderText("页面标题");
    set(titles[1], "第二页");

    // 删除按钮是 icon-only（无文字）。每一项都有一个（多于一项时才渲染），
    // 所以按图标定位比按 button class 稳。
    const icons = container.querySelectorAll(".anticon-delete");
    expect(icons.length).toBe(2);
    fireEvent.click(icons[1].closest("button")!);

    fireEvent.click(screen.getByRole("button", { name: /生成PPT/ }));
    await waitFor(() => expect(submittedReqs().length).toBe(1));
    const outline = submittedReqs()[0].params.outline;
    expect(outline.length).toBe(1);
    expect(outline[0].title).toBe("");
  });
});

describe("PptGenPanel：状态呈现", () => {
  it("生成中主按钮变成「取消生成」", () => {
    useGenerationStore.setState({
      tasks: {
        image: EMPTY_TASK,
        video: EMPTY_TASK,
        ppt: { ...EMPTY_TASK, status: "submitting", requestId: "job-1" },
        text: EMPTY_TASK,
      },
    });
    render(<PptGenPanel />);
    // 生成中时：主按钮换成「取消生成」，且**不再有**「生成PPT」按钮。
    // （结果区里还有一个同名取消按钮，所以这里用 getAllByRole。）
    expect(screen.getAllByRole("button", { name: /取消生成/ }).length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByRole("button", { name: /生成PPT/ })).toBeNull();
  });

  it("成功后如实展示产物路径，并说明 .pptx 与 .html 两个文件", () => {
    useGenerationStore.setState({
      tasks: {
        image: EMPTY_TASK,
        video: EMPTY_TASK,
        ppt: {
          ...EMPTY_TASK,
          status: "succeeded",
          result: "/Users/me/results/job-1.pptx",
          refs: ["/Users/me/results/job-1.pptx", "/Users/me/results/job-1.html"],
        },
        text: EMPTY_TASK,
      },
    });
    render(<PptGenPanel />);
    expect(screen.getByText("/Users/me/results/job-1.pptx")).toBeTruthy();
    expect(screen.getByText(/同时产出 2 个文件/)).toBeTruthy();
  });
});
