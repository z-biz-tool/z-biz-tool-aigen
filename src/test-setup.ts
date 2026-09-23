// vitest 全局环境垫片：antd v6 在 jsdom 里需要这几个浏览器 API。
// 只补环境，不改被测行为。
import { vi } from "vitest";

if (!window.matchMedia) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

class RO {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (!(globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver) {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = RO;
}
if (!(globalThis as unknown as { IntersectionObserver?: unknown }).IntersectionObserver) {
  (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = RO;
}

// jsdom 没有这些，antd 的复制/剪贴板路径会用到
if (!navigator.clipboard) {
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    configurable: true,
  });
}
