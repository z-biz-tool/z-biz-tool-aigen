/**
 * 提示词模板库前端态（T-Prompt / 02 §1、03 §4）。
 *
 * 模板正文与变量都存在 Rust 侧 `templates.json`，这里只是视图与操作入口。
 */

import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { toGenError } from '../_shared/genError';

export type TemplateKind = 'text' | 'image' | 'video' | 'ppt';

export interface PromptTemplate {
  id: string;
  name: string;
  kind: TemplateKind;
  body: string;
  /** 从正文抽取出的 {变量名} 清单 */
  variables: string[];
  builtin: boolean;
  favorite: boolean;
  updated_at: string;
}

interface Rendered {
  template_id: string;
  kind: TemplateKind;
  text: string;
  missing: string[];
}

interface TemplatePage {
  items: PromptTemplate[];
  corrupted: number;
}

interface TemplateStore {
  items: PromptTemplate[];
  corrupted: number;
  loaded: boolean;
  error: string | null;
  /** 当前面板选用的模板（按 kind 分隔） */
  selected: Partial<Record<TemplateKind, string>>;
  /** 变量填值：templateId -> { 变量名 -> 值 } */
  values: Record<string, Record<string, string>>;

  load: (kind?: TemplateKind, keyword?: string) => Promise<void>;
  select: (kind: TemplateKind, id: string | undefined) => void;
  setValue: (templateId: string, name: string, value: string) => void;
  save: (input: {
    id?: string;
    name: string;
    kind: TemplateKind;
    body: string;
    favorite?: boolean;
  }) => Promise<PromptTemplate>;
  remove: (id: string) => Promise<void>;
  setFavorite: (id: string, favorite: boolean) => Promise<void>;
  render: (id: string, values: Record<string, string>) => Promise<Rendered>;
  /** 用当前选中模板 + 已填变量渲染；bodyText 填入"正文/主体"类插槽。没选模板返回 null */
  renderSelected: (
    kind: TemplateKind,
    bodyText: string
  ) => Promise<{ text: string; missing: string[]; templateId: string } | null>;
}

export const useTemplateStore = create<TemplateStore>((set, get) => ({
  items: [],
  corrupted: 0,
  loaded: false,
  error: null,
  selected: {},
  values: {},

  load: async (kind, keyword) => {
    try {
      const page = await invoke<TemplatePage>('list_templates', {
        kind: kind ?? null,
        keyword: keyword ?? null,
      });
      set({ items: page.items, corrupted: page.corrupted, loaded: true, error: null });
    } catch (e) {
      set({ loaded: true, error: toGenError(e).message });
    }
  },

  select: (kind, id) =>
    set((s) => ({ selected: { ...s.selected, [kind]: id } })),

  setValue: (templateId, name, value) =>
    set((s) => ({
      values: {
        ...s.values,
        [templateId]: { ...(s.values[templateId] ?? {}), [name]: value },
      },
    })),

  save: async (input) => {
    const saved = await invoke<PromptTemplate>('save_template', {
      id: input.id ?? null,
      name: input.name,
      kind: input.kind,
      body: input.body,
      favorite: input.favorite ?? null,
    });
    // 编辑内置模板会派生成新用户模板，需要重取列表才能看到
    await get().load();
    return saved;
  },

  remove: async (id) => {
    await invoke('delete_template', { id });
    set((s) => {
      const nextSelected = { ...s.selected };
      for (const k of Object.keys(nextSelected) as TemplateKind[]) {
        if (nextSelected[k] === id) delete nextSelected[k];
      }
      return { selected: nextSelected };
    });
    await get().load();
  },

  setFavorite: async (id, favorite) => {
    await invoke('set_template_favorite', { id, favorite });
    await get().load();
  },

  render: async (id, values) =>
    invoke<Rendered>('render_template', { id, values }),

  renderSelected: async (kind, bodyText) => {
    const { items, selected, values } = get();
    const id = selected[kind];
    const tpl = id ? items.find((t) => t.id === id) : undefined;
    if (!tpl) return null;
    const bodyVar = tpl.variables.find(isBodyVariable);
    const filled: Record<string, string> = { ...(values[tpl.id] ?? {}) };
    if (bodyVar) filled[bodyVar] = bodyText;
    const r = await invoke<Rendered>('render_template', { id: tpl.id, values: filled });
    return { text: r.text, missing: r.missing, templateId: tpl.id };
  },
}));

/** 主输入框绑定的变量名：命中它的模板可以直接用面板的大文本框 */
export const BODY_VARIABLES = ['正文', '内容', '主体', '产品'];

export function isBodyVariable(name: string): boolean {
  return BODY_VARIABLES.includes(name);
}
