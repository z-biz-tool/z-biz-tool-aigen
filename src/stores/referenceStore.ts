/**
 * 参考图（02 §1.2 第三项）。
 *
 * 渲染进程没有 fs 权限：这里只把"用户经原生对话框选中的路径"交给 Rust 的
 * `prepare_reference_image`，由它做大小/魔数/符号链接校验后回 data URL。
 */

import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { toGenError } from "../_shared/genError";

interface ReferenceImage {
  dataUrl: string;
  bytes: number;
  ext: string;
  source: string;
}

interface ReferenceStore {
  image: ReferenceImage | null;
  label: string;
  busy: boolean;
  /** 让用户挑一张本地图片；取消返回 false */
  pick: () => Promise<boolean>;
  /** 复用某条历史结果当参考图（路径只来自历史引用） */
  useRecord: (recordId: string, refIndex?: number) => Promise<boolean>;
  clear: () => void;
}

const fmtKb = (n: number) => (n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

export const useReferenceStore = create<ReferenceStore>((set) => ({
  image: null,
  label: "",
  busy: false,

  pick: async () => {
    const path = await open({
      multiple: false,
      directory: false,
      title: "选择参考图",
      filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp", "gif"] }],
    });
    if (!path) return false;
    set({ busy: true });
    try {
      const img = await invoke<ReferenceImage>("prepare_reference_image", {
        path,
        recordId: null,
        refIndex: null,
      });
      set({ image: img, label: `${img.ext} · ${fmtKb(img.bytes)}`, busy: false });
      return true;
    } catch (e) {
      set({ busy: false });
      throw e;
    }
  },

  useRecord: async (recordId, refIndex) => {
    set({ busy: true });
    try {
      const img = await invoke<ReferenceImage>("prepare_reference_image", {
        path: null,
        recordId,
        refIndex: refIndex ?? null,
      });
      set({ image: img, label: `历史结果 · ${fmtKb(img.bytes)}`, busy: false });
      return true;
    } catch (e) {
      set({ busy: false });
      throw e;
    }
  },

  clear: () => set({ image: null, label: "" }),
}));

export const referenceErrorText = (e: unknown) => toGenError(e).message;
