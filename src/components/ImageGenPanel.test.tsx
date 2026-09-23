import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import ImageGenPanel from "./ImageGenPanel";
import { useAIGenStore } from "../stores/aiStore";
import { EMPTY_TASK, useGenerationStore } from "../stores/generationStore";
import { useTemplateStore, type PromptTemplate } from "../stores/templateStore";
import { useReferenceStore } from "../stores/referenceStore";
import type { GenerationState } from "../_shared/jobClient";

const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>;
const mockListen = listen as unknown as ReturnType<typeof vi.fn>;
const mockOpen = open as unknown as ReturnType<typeof vi.fn>;

const template: PromptTemplate = {
  id: "builtin-image-photo",
  name: "image-photo",
  kind: "image",
  body: "{主体}，柔和自然光，浅景深，胶片质感，{色调}色调",
  variables: ["主体", "色调"],
  builtin: true,
  favorite: false,
  updated_at: "2026-09-22T10:00:00Z",
};

const jobState = (over: Partial<GenerationState> = {}): GenerationState => ({
  requestId: "job-1",
  kind: "image",
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

let handlers: Array<{ event: string; fn: (e: { payload: GenerationState }) => void }> = [];
const submittedReqs = () =>
  mockInvoke.mock.calls.filter((c) => c[0] === "submit_generation").map((c) => c[1].req);

async function finish(next: Partial<GenerationState>) {
  await waitFor(() => expect(handlers.length).toBeGreaterThan(0));
  await act(async () => {
    handlers.forEach((h) => h.fn({ payload: jobState({ ...next, requestId: "job-1" }) }));
    await Promise.resolve();
  });
}

function set(el: HTMLElement, v: string) {
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, v);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

beforeEach(() => {
  handlers = [];
  useGenerationStore.setState({
    tasks: { image: EMPTY_TASK, video: EMPTY_TASK, ppt: EMPTY_TASK, text: EMPTY_TASK },
    prompts: { image: "", video: "", ppt: "", text: "" },
  });
  useTemplateStore.setState({ items: [], corrupted: 0, loaded: false, error: null, selected: {}, values: {} });
  useAIGenStore.setState({
    providers: [
      {
        id: "oa",
        name: "OpenAI",
        base_url: "https://a/v1",
        capabilities: ["image"],
        models: ["dall-e-3"],
        has_key: true,
        key_masked: "sk-****1",
      },
    ],
    active: { image: "oa" },
    configLoaded: true,
    configOpen: false,
  });
  mockListen.mockImplementation(async (event: string, fn: (e: { payload: GenerationState }) => void) => {
    handlers.push({ event, fn });
    return () => {};
  });
  mockInvoke.mockImplementation((cmd: string, args: { id?: string; values?: Record<string, string> }) => {
    if (cmd === "submit_generation") return Promise.resolve({ requestId: "job-1" });
    if (cmd === "prepare_reference_image")
      return Promise.resolve({
        dataUrl: "data:image/png;base64,AAECAg==",
        bytes: 1024,
        ext: "png",
        source: "path",
      });
    if (cmd === "list_templates")
      return Promise.resolve({ items: [template], corrupted: 0 });
    if (cmd === "render_template") {
      let text = template.body;
      const missing: string[] = [];
      for (const v of template.variables) {
        const val = args.values?.[v];
        if (!val) missing.push(v);
        else text = text.split(`{${v}}`).join(val);
      }
      return Promise.resolve({ template_id: template.id, kind: "image", text, missing });
    }
    if (cmd === "get_generation")
      return Promise.reject({ code: "INVALID_PARAM", message: "未就绪", retryable: false });
    return Promise.resolve({});
  });
});

afterEach(() => cleanup());

describe("ImageGenPanel 的风格预设与负面提示词（02 §1.2）", () => {
  it("参考图走 Rust 受控入口，并作为参数下发", async () => {
    useReferenceStore.getState().clear();
    mockOpen.mockResolvedValue("/Users/me/Pictures/猫.png");
    render(<ImageGenPanel />);
    fireEvent.click(screen.getByRole("button", { name: /选本地图片/ }));
    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith(
        "prepare_reference_image",
        expect.objectContaining({ path: "/Users/me/Pictures/猫.png" })
      )
    );
    expect(screen.getByText(/png · 1 KB/)).toBeTruthy();

    set(document.querySelector("textarea")!, "照这个风格画");
    fireEvent.click(screen.getByRole("button", { name: /生成图片/ }));
    await waitFor(() => expect(submittedReqs().length).toBe(1));
    expect(submittedReqs()[0].params.referenceImage).toBe("data:image/png;base64,AAECAg==");
    useReferenceStore.getState().clear();
  });

  it("用户取消选择就不该调用后端", async () => {
    mockOpen.mockResolvedValue(false);
    render(<ImageGenPanel />);
    fireEvent.click(screen.getByRole("button", { name: /选本地图片/ }));
    await new Promise((r) => setTimeout(r, 50));
    expect(
      mockInvoke.mock.calls.some((c) => c[0] === "prepare_reference_image")
    ).toBe(false);
  });

  it("负面提示词只在填了时进请求", async () => {
    render(<ImageGenPanel />);
    set(document.querySelector("textarea")!, "一只橘猫");
    fireEvent.click(screen.getByRole("button", { name: /生成图片/ }));
    await finish({ preview: ["data:image/png;base64,AA"] });
    expect(submittedReqs()[0].params).toMatchObject({ count: 1, negativePrompt: null });

    const negInput = Array.from(document.querySelectorAll("input")).find((i) =>
      i.placeholder.includes("模糊、水印")
    )!;
    expect(negInput).toBeTruthy();
    set(negInput, "模糊、水印");
    fireEvent.click(screen.getByRole("button", { name: /生成图片/ }));
    await finish({ preview: ["data:image/png;base64,AA"] });
    expect(submittedReqs()[1].params.negativePrompt).toBe("模糊、水印");
  });

  it("选风格预设后走模板渲染，变量自动接上主输入框", async () => {
    render(<ImageGenPanel />);
    await waitFor(() => expect(useTemplateStore.getState().items.length).toBe(1));
    // 选中模板
    const tplSelect = Array.from(document.querySelectorAll(".ant-select")).find((el) =>
      el.textContent?.includes("不用预设")
    );
    expect(tplSelect).toBeTruthy();
    tplSelect!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    await waitFor(() =>
      expect(document.querySelector(".ant-select-item-option")).toBeTruthy()
    );
    (document.querySelector(".ant-select-item-option") as HTMLElement).click();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(useTemplateStore.getState().selected.image).toBe(template.id);

    // 非正文变量 {色调} 应出现独立输入框
    const toneInput = Array.from(document.querySelectorAll("input")).find((i) =>
      i.closest(".ant-input-group-wrapper")?.textContent?.includes("色调")
    );
    expect(toneInput).toBeTruthy();

    set(document.querySelector("textarea")!, "一只橘猫");
    // 先不填 {色调}：必须拦住，不发请求
    fireEvent.click(screen.getByRole("button", { name: /生成图片/ }));
    await waitFor(() =>
      expect(document.body.textContent).toContain("还有变量没填：色调")
    );
    expect(submittedReqs().length).toBe(0);

    set(toneInput!, "暖");
    fireEvent.click(screen.getByRole("button", { name: /生成图片/ }));
    await waitFor(() => expect(submittedReqs().length).toBe(1));
    expect(submittedReqs()[0].prompt).toBe("一只橘猫，柔和自然光，浅景深，胶片质感，暖色调");
  });

  it("错误终态仍按 code 走同一套降级界面", async () => {
    render(<ImageGenPanel />);
    set(document.querySelector("textarea")!, "橘猫");
    fireEvent.click(screen.getByRole("button", { name: /生成图片/ }));
    await finish({
      status: "failed",
      error: { code: "CONTENT_POLICY", message: "内容策略拒绝", retryable: false },
    });
    await waitFor(() => expect(document.body.textContent).toContain("内容策略拒绝"));
    expect(document.body.textContent).toContain("提示词被上游内容安全策略拒绝");
    expect(screen.getByText("CONTENT_POLICY")).toBeTruthy();
    // 不可重试的错误不该给出重试入口
    expect(screen.queryByRole("button", { name: /重试/ })).toBeNull();
  });
});
