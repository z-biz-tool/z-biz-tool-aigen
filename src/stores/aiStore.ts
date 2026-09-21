/**
 * AI 生成 store - 使用统一的 AI 中台
 */

import { create } from 'zustand';
import { useAIManager } from 'z-biz-tool-shared/ai';

export interface GenerationHistoryItem {
  id: string;
  kind: 'image' | 'text' | 'video' | 'ppt';
  prompt: string;
  result: string; // 图片 URL 或文本内容
  created_at: string;
}

interface AIGenStore {
  // API 配置
  baseUrl: string;
  apiKey: string;
  configLoaded: boolean;
  
  // 生成历史
  history: GenerationHistoryItem[];
  
  // 加载状态
  imageLoading: boolean;
  textLoading: boolean;
  videoLoading: boolean;
  pptLoading: boolean;
  
  // 操作
  loadConfig: () => Promise<void>;
  saveConfig: (baseUrl: string, apiKey: string) => Promise<void>;
  
  // AI 生成
  generateImage: (prompt: string, count?: number) => Promise<string[]>;
  generateText: (prompt: string, model?: string) => Promise<string>;
  generateVideo: (prompt: string, duration?: number) => Promise<string>;
  generatePpt: (prompt: string) => Promise<string>;
  
  // 历史记录
  loadHistory: () => Promise<void>;
  addToHistory: (item: GenerationHistoryItem) => void;
  clearHistory: () => Promise<void>;
}

export const useAIGenStore = create<AIGenStore>((set, get) => ({
  baseUrl: '',
  apiKey: '',
  configLoaded: false,
  history: [],
  imageLoading: false,
  textLoading: false,
  videoLoading: false,
  pptLoading: false,

  loadConfig: async () => {
    try {
      // 尝试从 AI 中台读取配置
      const coreConfig = useAIManager.getState().config;
      
      if (coreConfig.baseUrl && coreConfig.apiKey) {
        set({
          baseUrl: coreConfig.baseUrl,
          apiKey: coreConfig.apiKey,
          configLoaded: true
        });
        return;
      }
    } catch (e) {
      console.error('从 AI 中台读取配置失败:', e);
    }
    
    // 回退到本地存储
    try {
      if (typeof window !== 'undefined') {
        const stored = localStorage.getItem('z-aigen:api-config');
        if (stored) {
          const config = JSON.parse(stored);
          set({
            baseUrl: config.baseUrl,
            apiKey: config.apiKey,
            configLoaded: true
          });
          
          // 同步到 AI 中台
          useAIManager.getState().updateConfig({
            baseUrl: config.baseUrl,
            apiKey: config.apiKey
          });
        }
      }
    } catch (e) {
      console.error('加载本地配置失败:', e);
    }
    
    set({ configLoaded: true });
  },

  saveConfig: async (baseUrl, apiKey) => {
    try {
      // 同步到 AI 中台
      useAIManager.getState().updateConfig({
        baseUrl,
        apiKey
      });
      
      // 本地存储
      if (typeof window !== 'undefined') {
        localStorage.setItem('z-aigen:api-config', JSON.stringify({ baseUrl, apiKey }));
      }
      
      set({ baseUrl, apiKey });
    } catch (e) {
      console.error('保存配置失败:', e);
    }
  },

  generateImage: async (prompt, count = 1) => {
    set({ imageLoading: true });
    try {
      const result = await useAIManager.getState().executeAI('image', { prompt, count });
      
      if (!result.success) {
        throw new Error(result.error);
      }
      
      // 假设返回的是 JSON 格式
      try {
        const data = JSON.parse(result.content);
        return data.urls || [result.content];
      } catch {
        return [result.content];
      }
    } finally {
      set({ imageLoading: false });
      get().loadHistory();
    }
  },

  generateText: async (prompt, model) => {
    set({ textLoading: true });
    try {
      const result = await useAIManager.getState().executeAI('generate', { prompt, model });
      
      if (!result.success) {
        throw new Error(result.error);
      }
      
      return result.content;
    } finally {
      set({ textLoading: false });
      get().loadHistory();
    }
  },

  generateVideo: async (prompt, duration = 5) => {
    set({ videoLoading: true });
    try {
      const result = await useAIManager.getState().executeAI('video', { prompt, duration });
      
      if (!result.success) {
        throw new Error(result.error);
      }
      
      return result.content;
    } finally {
      set({ videoLoading: false });
      get().loadHistory();
    }
  },

  generatePpt: async (prompt) => {
    set({ pptLoading: true });
    try {
      const result = await useAIManager.getState().executeAI('ppt', { prompt });
      
      if (!result.success) {
        throw new Error(result.error);
      }
      
      return result.content;
    } finally {
      set({ pptLoading: false });
      get().loadHistory();
    }
  },

  loadHistory: async () => {
    try {
      if (typeof window !== 'undefined') {
        const stored = localStorage.getItem('z-aigen:history');
        if (stored) {
          set({ history: JSON.parse(stored) });
        }
      }
    } catch (e) {
      console.error('加载历史失败:', e);
    }
  },

  addToHistory: (item) => {
    set((state) => ({
      history: [item, ...state.history].slice(0, 50) // 保持最多 50 条
    }));
    
    // 保存到本地
    if (typeof window !== 'undefined') {
      localStorage.setItem('z-aigen:history', JSON.stringify(get().history));
    }
  },

  clearHistory: async () => {
    set({ history: [] });
    
    if (typeof window !== 'undefined') {
      localStorage.removeItem('z-aigen:history');
    }
  }
}));
