/**
 * AI 生成应用态：服务商配置与历史。
 *
 * - 密钥**不再**出现在前端：store 只保存 `has_key` / `key_masked`（T-A2/A3/A4）
 * - 不写 localStorage：配置唯一来源是 Rust 侧加密存储（04 §2）
 * - 多服务商：按能力路由与模型白校验由 Rust `AppConfig::resolve` 兜底（T-Provider / 修 B4）
 * - 历史由 Rust `list_history` 提供（JSONL 落盘，T-C1）
 */

import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { toGenError } from '../_shared/genError';

export type GenKind = 'image' | 'video' | 'ppt' | 'text';

export interface GenerationRecord {
  id: string;
  kind: GenKind;
  prompt: string;
  model: string | null;
  params: Record<string, unknown>;
  /** 结果文件引用（相对数据目录），不再是内联 base64 */
  result_refs: string[];
  text_result: string | null;
  status: 'succeeded' | 'polling' | 'failed' | string;
  /** ISO8601 */
  created_at: string;
  usage: { prompt_tokens: number; completion_tokens: number } | null;
  favorite: boolean;
}

/** 与 Rust `PublicProvider` 对齐（snake_case 序列化） */
export interface PublicProvider {
  id: string;
  name: string;
  base_url: string;
  capabilities: string[];
  models: string[];
  has_key: boolean;
  key_masked: string | null;
}

/** 与 Rust `ProvidersView` 对齐 */
interface ProvidersView {
  providers: PublicProvider[];
  active: Partial<Record<GenKind, string>>;
}

export interface ProviderInput {
  /** 省略表示新建，id 由后端从名称派生 */
  providerId?: string;
  name?: string;
  baseUrl: string;
  /** 省略或空串 = 保留该服务商既有密钥 */
  apiKey?: string;
  capabilities?: GenKind[];
  models?: string[];
}

interface HistoryPage {
  items: GenerationRecord[];
  total: number;
  /** 本地已存历史总条数（不受筛选影响） */
  stored: number;
  dropped_lines: number;
}

interface AIGenStore {
  providers: PublicProvider[];
  active: Partial<Record<GenKind, string>>;
  configLoaded: boolean;
  configError: string | null;

  /** 配置弹窗开关：错误降级面板也通过它引导用户补全密钥 */
  configOpen: boolean;

  history: GenerationRecord[];
  historyTotal: number;
  historyStored: number;
  /** 载入时被跳过的损坏行数 */
  historyDropped: number;

  loadConfig: () => Promise<void>;
  saveProvider: (input: ProviderInput) => Promise<void>;
  removeProvider: (id: string) => Promise<void>;
  setActive: (kind: GenKind, providerId: string) => Promise<void>;
  /** 连通性校验：返回上游模型清单（02 §9） */
  testProvider: (id: string) => Promise<string[]>;
  loadHistory: (opts?: { kind?: string; keyword?: string; page?: number; size?: number }) => Promise<void>;
  removeHistory: (id: string) => Promise<void>;
  wipeHistory: () => Promise<void>;
  openConfig: () => void;
  closeConfig: () => void;
}

function applyView(view: ProvidersView): Pick<AIGenStore, 'providers' | 'active' | 'configLoaded'> {
  return { providers: view.providers, active: view.active ?? {}, configLoaded: true };
}

/** 某类生成当前会路由到哪个服务商（显式 active > 唯一候选） */
export function providerFor(
  state: Pick<AIGenStore, 'providers' | 'active'>,
  kind: GenKind
): PublicProvider | null {
  const supports = (p: PublicProvider) =>
    p.capabilities.length === 0 || p.capabilities.includes(kind);
  const activeId = state.active[kind];
  const byActive = activeId ? state.providers.find((p) => p.id === activeId && supports(p)) : null;
  if (byActive) return byActive;
  const candidates = state.providers.filter(supports);
  return candidates.length === 1 ? candidates[0] : null;
}

/** 是否存在可用于该类生成、且已填密钥的服务商 */
export function isReadyFor(
  state: Pick<AIGenStore, 'providers' | 'active'>,
  kind: GenKind
): boolean {
  const p = providerFor(state, kind);
  return Boolean(p?.has_key);
}

/**
 * 面板模型下拉的数据源（B4）：
 * 服务商声明了模型清单就用它，否则返回 null 让面板沿用自己的备用清单。
 */
export function useModelOptions(kind: GenKind): {
  options: { value: string; label: string }[] | null;
  providerName: string | null;
} {
  const providers = useAIGenStore((s) => s.providers);
  const active = useAIGenStore((s) => s.active);
  const provider = providerFor({ providers, active }, kind);
  if (!provider || provider.models.length === 0) {
    return { options: null, providerName: provider?.name ?? null };
  }
  return {
    options: provider.models.map((m) => ({ value: m, label: m })),
    providerName: provider.name,
  };
}

export const useAIGenStore = create<AIGenStore>((set) => ({
  providers: [],
  active: {},
  configLoaded: false,
  configError: null,
  configOpen: false,
  history: [],
  historyTotal: 0,
  historyStored: 0,
  historyDropped: 0,

  loadConfig: async () => {
    try {
      const view = await invoke<ProvidersView>('load_api_config');
      set({ ...applyView(view), configError: null });
    } catch (e) {
      // 配置读取失败不阻塞界面：面板会在生成时以 NO_CONFIG 错误引导用户。
      // 但必须清掉旧视图——否则界面还显示"某服务商 sk-****"，而后端其实没配置成功。
      const err = toGenError(e);
      set({
        configLoaded: true,
        configError: err.message,
        providers: [],
        active: {},
      });
    }
  },

  saveProvider: async (input) => {
    const key = input.apiKey?.trim();
    const view = await invoke<ProvidersView>('save_api_config', {
      providerId: input.providerId ?? null,
      name: input.name ?? null,
      baseUrl: input.baseUrl.trim(),
      apiKey: key ? key : null,
      capabilities: input.capabilities ?? null,
      models: input.models ?? null,
    });
    set(applyView(view));
  },

  removeProvider: async (id) => {
    const view = await invoke<ProvidersView>('delete_provider', { providerId: id });
    set(applyView(view));
  },

  setActive: async (kind, providerId) => {
    const view = await invoke<ProvidersView>('set_active_provider', { kind, providerId });
    set(applyView(view));
  },

  testProvider: async (id) => invoke<string[]>('test_provider', { providerId: id }),

  loadHistory: async (opts) => {
    try {
      const page = await invoke<HistoryPage>('list_history', {
        kind: opts?.kind ?? null,
        keyword: opts?.keyword ?? null,
        page: opts?.page ?? 0,
        size: opts?.size ?? 50,
      });
      set({
        history: page.items,
        historyTotal: page.total,
        historyStored: page.stored,
        historyDropped: page.dropped_lines,
      });
    } catch {
      set({ history: [], historyTotal: 0, historyStored: 0 });
    }
  },

  /** 破坏性操作：调用方必须先经确认对话框（04 §6） */
  removeHistory: async (id) => {
    await invoke('delete_history', { id });
    await useAIGenStore.getState().loadHistory();
  },

  wipeHistory: async () => {
    await invoke('clear_history');
    set({ history: [], historyTotal: 0 });
  },

  openConfig: () => set({ configOpen: true }),
  closeConfig: () => set({ configOpen: false }),
}));
