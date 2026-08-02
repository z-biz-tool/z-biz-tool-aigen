import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";

export interface ApiConfig {
  base_url: string;
  api_key: string;
}

export interface HistoryItem {
  id: string;
  kind: "image" | "text";
  prompt: string;
  result: string;
  created_at: string;
}

interface AiStore {
  // API配置
  baseUrl: string;
  apiKey: string;
  configLoaded: boolean;

  // 生成历史
  history: HistoryItem[];

  // 加载状态
  imageLoading: boolean;
  textLoading: boolean;

  // 操作
  loadConfig: () => Promise<void>;
  saveConfig: (baseUrl: string, apiKey: string) => Promise<void>;
  generateImage: (prompt: string, count?: number) => Promise<string[]>;
  generateText: (prompt: string, model?: string) => Promise<string>;
  loadHistory: () => Promise<void>;
}

export const useAiStore = create<AiStore>((set, get) => ({
  baseUrl: "",
  apiKey: "",
  configLoaded: false,
  history: [],
  imageLoading: false,
  textLoading: false,

  loadConfig: async () => {
    try {
      const config = await invoke<ApiConfig>("load_api_config");
      set({
        baseUrl: config.base_url,
        apiKey: config.api_key,
        configLoaded: true,
      });
    } catch (e) {
      console.error("加载API配置失败:", e);
      set({ configLoaded: true });
    }
  },

  saveConfig: async (baseUrl: string, apiKey: string) => {
    await invoke("save_api_config", { baseUrl, apiKey });
    set({ baseUrl, apiKey });
  },

  generateImage: async (prompt: string, count?: number) => {
    set({ imageLoading: true });
    try {
      const urls = await invoke<string[]>("generate_image", { prompt, count });
      get().loadHistory();
      return urls;
    } finally {
      set({ imageLoading: false });
    }
  },

  generateText: async (prompt: string, model?: string) => {
    set({ textLoading: true });
    try {
      const content = await invoke<string>("generate_text", { prompt, model });
      get().loadHistory();
      return content;
    } finally {
      set({ textLoading: false });
    }
  },

  loadHistory: async () => {
    try {
      const history = await invoke<HistoryItem[]>("get_history");
      set({ history });
    } catch (e) {
      console.error("加载历史记录失败:", e);
    }
  },
}));
