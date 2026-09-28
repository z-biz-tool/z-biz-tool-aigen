/**
 * 交互草稿持久化（模式 + 各模式表单 + 提示词）。
 *
 * 为什么要它：应用重开回到默认图片页、半敲的提示词和调好的参数全丢，
 * 而「单人制片厂」要的正是可以反复回到同一个设定上做一致性重试。
 *
 * 三条纪律：
 * - 白名单落盘：只存 mode/forms/prompts 三样。服务商密钥本来就不进前端 store（见 aiStore），
 *   这里再显式排除一次，任何 key 形状的字段都不给落盘的机会。
 * - normalizeCraft 是唯一入口：版本不符、字段缺失、类型跑偏一律重铸为默认值，
 *   老 payload 不可能把启动搞崩。
 * - capCraft 先截断再序列化，配额满由 safeStorage 降级兜底。
 */

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { CAPS, DRAFT_VERSION, capNum, capStr, createSafeStorage } from "../_shared/safeStorage";

export type ModeId = "image" | "video" | "ppt" | "text" | "batch";
/** 有提示词草稿的四种生成类型（batch 是文本队列，不单列） */
export type DraftKind = "image" | "video" | "ppt" | "text";

export const MODE_ORDER: ModeId[] = ["image", "video", "ppt", "text", "batch"];

export interface OutlineItem {
  id: number;
  title: string;
  content: string;
}

export interface ImageForm {
  model: string;
  size: string;
  count: number;
  negative: string;
}
export interface VideoForm {
  duration: string;
  resolution: string;
}
export interface PptForm {
  template: string;
  slides: number;
  outline: OutlineItem[];
}
export interface TextForm {
  model: string;
  system: string;
  temperature: number;
  maxTokens: number | null;
}
export interface BatchForm {
  kind: DraftKind;
  model: string;
  /** 一行一条的多行提示词，最容易敲一半就丢 */
  raw: string;
}

export interface FormMap {
  image: ImageForm;
  video: VideoForm;
  ppt: PptForm;
  text: TextForm;
  batch: BatchForm;
}

export interface Craft {
  version: number;
  mode: ModeId;
  forms: FormMap;
  prompts: Record<DraftKind, string>;
}

export const DEFAULT_CRAFT: Craft = {
  version: DRAFT_VERSION,
  mode: "image",
  forms: {
    image: { model: "dall-e-3", size: "1024x1024", count: 1, negative: "" },
    video: { duration: "5", resolution: "1080p" },
    ppt: { template: "business", slides: 10, outline: [{ id: 1, title: "", content: "" }] },
    text: { model: "gpt-4o-mini", system: "", temperature: 0.7, maxTokens: 1024 },
    batch: { kind: "text", model: "", raw: "" },
  },
  prompts: { image: "", video: "", ppt: "", text: "" },
};

const isDraftKind = (k: unknown): k is DraftKind =>
  k === "image" || k === "video" || k === "ppt" || k === "text";

function normalizeOutline(raw: unknown): OutlineItem[] {
  if (!Array.isArray(raw)) return DEFAULT_CRAFT.forms.ppt.outline;
  const items = raw
    .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
    .slice(0, CAPS.outlineItems)
    .map((x, i) => ({
      id: typeof x.id === "number" && Number.isFinite(x.id) ? x.id : i + 1,
      title: capStr(x.title, CAPS.outlineTitle),
      content: capStr(x.content, CAPS.outlineContent),
    }));
  return items.length ? items : [{ id: 1, title: "", content: "" }];
}

/** 枚举/标识类字段：空白一律视为未选，落回默认值（空格模型名会让请求必挂） */
function pickStr(v: unknown, max: number, fallback: string): string {
  return capStr(v, max).trim() || fallback;
}

/** 落盘草稿 → 内存形状。任何不认识的输入都只会被铸回默认值，不会抛。 */
export function normalizeCraft(raw: unknown): Craft {
  if (!raw || typeof raw !== "object") return structuredCloneLite(DEFAULT_CRAFT);
  const o = raw as Record<string, unknown>;
  // 版本不符（或压根没版本）就整体作废：宁可回到默认，也不带着旧形状跑
  if (o.version !== DRAFT_VERSION) return structuredCloneLite(DEFAULT_CRAFT);
  const f = (o.forms && typeof o.forms === "object" ? o.forms : {}) as Record<string, unknown>;
  const image = (f.image ?? {}) as Record<string, unknown>;
  const video = (f.video ?? {}) as Record<string, unknown>;
  const ppt = (f.ppt ?? {}) as Record<string, unknown>;
  const text = (f.text ?? {}) as Record<string, unknown>;
  const batch = (f.batch ?? {}) as Record<string, unknown>;
  const p = (o.prompts && typeof o.prompts === "object" ? o.prompts : {}) as Record<string, unknown>;
  const prompts = { ...DEFAULT_CRAFT.prompts };
  for (const key of Object.keys(prompts) as DraftKind[]) {
    if (isDraftKind(key)) prompts[key] = capStr(p[key], CAPS.prompt);
  }
  const mode = MODE_ORDER.includes(o.mode as ModeId) ? (o.mode as ModeId) : DEFAULT_CRAFT.mode;
  return {
    version: DRAFT_VERSION,
    mode,
    forms: {
      image: {
        model: pickStr(image.model, CAPS.short, DEFAULT_CRAFT.forms.image.model),
        size: pickStr(image.size, CAPS.short, DEFAULT_CRAFT.forms.image.size),
        count: capNum(image.count, 1, 4, 1),
        negative: capStr(image.negative, CAPS.negative),
      },
      video: {
        duration: pickStr(video.duration, CAPS.short, DEFAULT_CRAFT.forms.video.duration),
        resolution: pickStr(video.resolution, CAPS.short, DEFAULT_CRAFT.forms.video.resolution),
      },
      ppt: {
        template: pickStr(ppt.template, CAPS.short, DEFAULT_CRAFT.forms.ppt.template),
        slides: capNum(ppt.slides, 1, 50, 10),
        outline: normalizeOutline(ppt.outline),
      },
      text: {
        model: pickStr(text.model, CAPS.short, DEFAULT_CRAFT.forms.text.model),
        system: capStr(text.system, CAPS.system),
        temperature: capNum(text.temperature, 0, 2, 0.7),
        maxTokens:
          text.maxTokens === null || text.maxTokens === undefined
            ? null
            : capNum(text.maxTokens, 1, 32000, 1024),
      },
      batch: {
        kind: isDraftKind(batch.kind) ? batch.kind : DEFAULT_CRAFT.forms.batch.kind,
        model: capStr(batch.model, CAPS.short),
        raw: capStr(batch.raw, CAPS.prompt),
      },
    },
    prompts,
  };
}

/** 落盘前再走一遍上限，保证读回来的脏值不会二次膨胀 */
export function capCraft(c: Craft): Craft {
  return normalizeCraft(c);
}

function structuredCloneLite(c: Craft): Craft {
  return {
    version: c.version,
    mode: c.mode,
    forms: {
      image: { ...c.forms.image },
      video: { ...c.forms.video },
      ppt: { ...c.forms.ppt, outline: c.forms.ppt.outline.map((x) => ({ ...x })) },
      text: { ...c.forms.text },
      batch: { ...c.forms.batch },
    },
    prompts: { ...c.prompts },
  };
}

interface UiStore extends Craft {
  setMode: (mode: ModeId) => void;
  setForm: <K extends keyof FormMap, F extends keyof FormMap[K]>(kind: K, field: F, value: FormMap[K][F]) => void;
  setPromptDraft: (kind: DraftKind, value: string) => void;
  /** ⌘⇧N：把当前模式的草稿擦干净，开新一轮 */
  resetKind: (kind: ModeId) => void;
}

const STORAGE_KEY = "aigen.craft.v1";

/** 配额兜底用的降级序列：全量 → 去掉长文本 → 只留模式 */
function fallbackPayloads(current: Craft): string[] {
  const trimmed: Craft = {
    ...current,
    prompts: { image: "", video: "", ppt: "", text: "" },
    forms: { ...current.forms, ppt: { ...current.forms.ppt, outline: [] } },
  };
  const modeOnly: Craft = { ...DEFAULT_CRAFT, mode: current.mode };
  return [JSON.stringify({ ...capCraft(trimmed), mode: current.mode }), JSON.stringify(modeOnly)];
}

let latest: Craft = { ...DEFAULT_CRAFT };

export const useUiStore = create<UiStore>()(
  persist(
    (set) => ({
      ...structuredCloneLite(DEFAULT_CRAFT),

      setMode: (mode) => set({ mode }),

      setForm: (kind, field, value) =>
        set((s) => ({ forms: { ...s.forms, [kind]: { ...s.forms[kind], [field]: value } } })),

      setPromptDraft: (kind, value) =>
        set((s) => ({ prompts: { ...s.prompts, [kind]: capStr(value, CAPS.prompt) } })),

      resetKind: (kind) =>
        set((s) => ({
          forms: { ...s.forms, [kind]: structuredCloneLite(DEFAULT_CRAFT).forms[kind] },
          // batch 没有单条提示词草稿，只有多行队列
          ...(kind === "batch" ? {} : { prompts: { ...s.prompts, [kind]: "" } }),
        })),
    }),
    {
      name: STORAGE_KEY,
      version: DRAFT_VERSION,
      storage: createJSONStorage(() => createSafeStorage(() => fallbackPayloads(latest))),
      // 版本 bump 时先重铸
      migrate: (state) => normalizeCraft(state),
      // 版本相同也要重铸：zustand 只在版本不符时调 migrate，
      // 同版本的脏载荷（手改过 / 半截写入）由此挡住，不会带伤启动
      merge: (persisted, current) => ({ ...current, ...normalizeCraft(persisted) }),
      // 白名单：只这三样。密钥/服务商配置在 Rust 加密存储，压根不进这里
      partialize: (s) => {
        const craft = capCraft({
          version: DRAFT_VERSION,
          mode: s.mode,
          forms: s.forms,
          prompts: s.prompts,
        });
        latest = craft;
        return craft;
      },
    }
  )
);

/** 面板用：把某个表单字段从组件 state 换成持久化草稿 */
export function useFormField<K extends keyof FormMap, F extends keyof FormMap[K]>(
  kind: K,
  field: F
): [FormMap[K][F], (v: FormMap[K][F]) => void] {
  const value = useUiStore((s) => s.forms[kind][field]);
  const setForm = useUiStore((s) => s.setForm);
  return [value, (v) => setForm(kind, field, v)];
}

/** 非组件场景（快捷键）读当前草稿 */
export function craftSnapshot(): Craft {
  return useUiStore.getState();
}
