/**
 * 统一导出入口（02 §6，任务 T-Export）。
 *
 * 路径由 `dialog` 插件让用户挑；覆盖已有文件必须再确认一次（04 §6）。
 * 源可以是：历史记录（recordId）或面板当场展示的内容（data URL / http URL / 纯文本）。
 */

import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { Modal, message } from "antd";
import { toGenError } from "./genError";

interface Exported {
  path: string;
  bytes: number;
  source: string;
}

export interface ExportRequest {
  /** 保存对话框里的默认文件名 */
  defaultName: string;
  filters?: { name: string; extensions: string[] }[];
  recordId?: string;
  refIndex?: number;
  text?: string;
}

const IMAGE_FILTER = [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp"] }];
const TEXT_FILTER = [{ name: "文本", extensions: ["md", "txt"] }];
const HTML_FILTER = [{ name: "HTML", extensions: ["html"] }];
const VIDEO_FILTER = [{ name: "视频", extensions: ["mp4", "mov", "webm"] }];

export const EXPORT_FILTERS = {
  image: IMAGE_FILTER,
  text: TEXT_FILTER,
  html: HTML_FILTER,
  video: VIDEO_FILTER,
};

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

async function invokeExport(target: string, req: ExportRequest, overwrite: boolean) {
  return invoke<Exported>("save_export", {
    targetPath: target,
    recordId: req.recordId ?? null,
    refIndex: req.refIndex ?? null,
    text: req.text ?? null,
    allowOverwrite: overwrite,
  });
}

/** 返回 true 表示确实写出了文件（false = 用户取消或失败，失败已自带提示） */
export async function exportResult(req: ExportRequest): Promise<boolean> {
  let target: string | null;
  try {
    target = await save({
      defaultPath: req.defaultName,
      filters: req.filters ?? [{ name: "所有文件", extensions: ["*"] }],
    });
  } catch (e) {
    message.error(`打开保存对话框失败：${String(e)}`);
    return false;
  }
  if (!target) return false;

  try {
    const out = await invokeExport(target, req, false);
    message.success(`已导出 ${fmtBytes(out.bytes)} → ${out.path}`);
    return true;
  } catch (e) {
    const err = toGenError(e);
    if (err.code === "CONFLICT") {
      const ok = await new Promise<boolean>((resolve) => {
        Modal.confirm({
          title: "目标文件已存在",
          content: `${target}\n覆盖会丢失原有内容，确定吗？`,
          okText: "覆盖",
          okButtonProps: { danger: true },
          cancelText: "取消",
          onOk: () => resolve(true),
          onCancel: () => resolve(false),
        });
      });
      if (!ok) return false;
      try {
        const out = await invokeExport(target, req, true);
        message.success(`已导出 ${fmtBytes(out.bytes)} → ${out.path}`);
        return true;
      } catch (e2) {
        const err2 = toGenError(e2);
        message.error(`${err2.code}：${err2.message}`);
        return false;
      }
    }
    message.error(`${err.code}：${err.message}`);
    return false;
  }
}

/** 时间戳文件名后缀，避免同名互相覆盖 */
export function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(
    d.getMinutes()
  )}${p(d.getSeconds())}`;
}
