// _shared/export.ts 的导出流程：保存对话框 → 后端写出 → 覆盖确认。
// 跑法：npm test（vitest）
//
// 为什么测它：
//   导出是本仓**唯一**「用户数据出本机」的路径，而它的失败形态是**静默的**：
//   · 覆盖确认的分支写错 ⇒ 不弹确认框就覆盖了用户已有文件（数据丢失，无报错），
//     或者弹了确认框但用户点了「取消」仍然覆盖；
//   · 用户点了「覆盖」却没真的带 allowOverwrite ⇒ 后端按「不允许覆盖」处理，
//     界面却提示「已导出」⇒ 说了假话。
//   这两条都不会抛错，只会让人事后才发现文件不对。
//
// 覆盖与被覆盖的判定在 Rust 侧（src-tauri/src/export.rs），
// 这里测的是**前端这一侧的决策与传参**。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn() }));
vi.mock("antd", () => ({
  Modal: { confirm: vi.fn() },
  message: { success: vi.fn(), error: vi.fn() },
}));

import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { Modal, message } from "antd";
import { EXPORT_FILTERS, exportResult, stamp } from "./export";

const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>;
const mockSave = save as unknown as ReturnType<typeof vi.fn>;
const mockConfirm = Modal.confirm as unknown as ReturnType<typeof vi.fn>;
const mockSuccess = message.success as unknown as ReturnType<typeof vi.fn>;
const mockError = message.error as unknown as ReturnType<typeof vi.fn>;

/** 后端返回的导出结果 */
const OUT = { path: "/tmp/out.png", bytes: 2048, source: "record" };

/** 让 Modal.confirm 立刻按「用户点了哪个按钮」走 */
function answerConfirm(answer: "ok" | "cancel") {
  mockConfirm.mockImplementation((cfg: { onOk?: () => void; onCancel?: () => void }) => {
    if (answer === "ok") cfg.onOk?.();
    else cfg.onCancel?.();
  });
}

beforeEach(() => {
  mockInvoke.mockReset();
  mockSave.mockReset();
  mockConfirm.mockReset();
  mockSuccess.mockReset();
  mockError.mockReset();
  mockSave.mockResolvedValue("/tmp/out.png");
  mockInvoke.mockResolvedValue(OUT);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("exportResult：保存对话框", () => {
  it("用户取消 ⇒ 返回 false，且**不碰后端**", async () => {
    mockSave.mockResolvedValue(null);
    const ok = await exportResult({ defaultName: "a.png" });
    expect(ok).toBe(false);
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(mockError).not.toHaveBeenCalled();
  });

  it("对话框打开失败 ⇒ 提示后返回 false，且不碰后端", async () => {
    mockSave.mockRejectedValue(new Error("no such dir"));
    const ok = await exportResult({ defaultName: "a.png" });
    expect(ok).toBe(false);
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(mockError).toHaveBeenCalledTimes(1);
    expect(String(mockError.mock.calls[0][0])).toContain("打开保存对话框失败");
  });
});

describe("exportResult：正常导出", () => {
  it("成功 ⇒ 返回 true，并按约定传参（allowOverwrite 首轮必须是 false）", async () => {
    const ok = await exportResult({ defaultName: "a.png" });
    expect(ok).toBe(true);
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    const [cmd, args] = mockInvoke.mock.calls[0];
    expect(cmd).toBe("save_export");
    expect(args).toEqual({
      targetPath: "/tmp/out.png",
      recordId: null,
      refIndex: null,
      text: null,
      allowOverwrite: false,
    });
  });

  it("recordId / refIndex / text 按请求透传（不被 null 兜底吃掉）", async () => {
    await exportResult({ defaultName: "a.png", recordId: "rec-1", refIndex: 2, text: "hello" });
    const [, args] = mockInvoke.mock.calls[0];
    expect(args).toMatchObject({ recordId: "rec-1", refIndex: 2, text: "hello" });
  });

  it("成功提示里带出文件大小（人类可读）", async () => {
    mockInvoke.mockResolvedValue({ ...OUT, bytes: 1024 });
    await exportResult({ defaultName: "a.png" });
    expect(String(mockSuccess.mock.calls[0][0])).toContain("1.0 KB");
  });
});

describe("exportResult：目标已存在时的覆盖确认", () => {
  const CONFLICT = { code: "CONFLICT", message: "目标文件已存在", retryable: false };

  it("用户点「取消」⇒ 不覆盖：只调用后端一次，且第二次（带 true）根本没发生", async () => {
    mockInvoke.mockRejectedValueOnce(CONFLICT);
    answerConfirm("cancel");
    const ok = await exportResult({ defaultName: "a.png" });
    expect(ok).toBe(false);
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockInvoke.mock.calls[0][1]).toMatchObject({ allowOverwrite: false });
    expect(mockConfirm).toHaveBeenCalledTimes(1);
  });

  it("用户点「覆盖」⇒ 第二次调用必须带 allowOverwrite=true", async () => {
    mockInvoke.mockRejectedValueOnce(CONFLICT);
    answerConfirm("ok");
    const ok = await exportResult({ defaultName: "a.png" });
    expect(ok).toBe(true);
    expect(mockInvoke).toHaveBeenCalledTimes(2);
    expect(mockInvoke.mock.calls[0][1]).toMatchObject({ allowOverwrite: false });
    expect(mockInvoke.mock.calls[1][1]).toMatchObject({ allowOverwrite: true });
  });

  it("确认框里必须写清目标路径（用户要知道自己要覆盖什么）", async () => {
    mockInvoke.mockRejectedValueOnce(CONFLICT);
    answerConfirm("cancel");
    await exportResult({ defaultName: "a.png" });
    const cfg = mockConfirm.mock.calls[0][0] as { title: string; content: string };
    expect(cfg.title).toContain("已存在");
    expect(cfg.content).toContain("/tmp/out.png");
  });

  it("用户确认覆盖后**仍然失败** ⇒ 返回 false，不得报成功", async () => {
    mockInvoke.mockRejectedValueOnce(CONFLICT).mockRejectedValueOnce({
      code: "IO",
      message: "磁盘写满",
      retryable: false,
    });
    answerConfirm("ok");
    const ok = await exportResult({ defaultName: "a.png" });
    expect(ok).toBe(false);
    expect(mockSuccess).not.toHaveBeenCalled();
    expect(mockError).toHaveBeenCalledTimes(1);
    expect(String(mockError.mock.calls[0][0])).toContain("IO");
  });
});

describe("exportResult：非覆盖类错误", () => {
  it("普通错误 ⇒ 返回 false，不弹确认框", async () => {
    mockInvoke.mockRejectedValue({ code: "NO_REFERENCE", message: "记录不存在", retryable: false });
    const ok = await exportResult({ defaultName: "a.png" });
    expect(ok).toBe(false);
    expect(mockConfirm).not.toHaveBeenCalled();
    expect(String(mockError.mock.calls[0][0])).toContain("NO_REFERENCE");
  });

  it("错误消息里的密钥形态被洗掉（前端半边脱敏）", async () => {
    mockInvoke.mockRejectedValue({
      code: "AUTH",
      message: "鉴权失败，sk-ABCDEFG123456 无效",
      retryable: false,
    });
    await exportResult({ defaultName: "a.png" });
    expect(String(mockError.mock.calls[0][0])).not.toContain("ABCDEFG123456");
  });
});

describe("导出相关的常量与工具", () => {
  it("EXPORT_FILTERS 覆盖图片/文本/HTML/视频四类", () => {
    expect(Object.keys(EXPORT_FILTERS).sort()).toEqual(["html", "image", "text", "video"]);
    expect(EXPORT_FILTERS.image[0].extensions).toContain("png");
  });

  it("stamp 产出零填充的年月日时分秒", () => {
    const s = stamp(new Date(2026, 0, 2, 3, 4, 5));
    expect(s).toBe("20260102-030405");
  });
});
