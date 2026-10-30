/**
 * 深链接语义解析测试。
 *
 * 协议**编解码**的字节级保证在 `z-biz-tool-shared/tests/deeplink.test.ts`
 * （与 Rust `cap-hub` 逐字节比对）。本测试只管**语义**：
 * 一条深链进来，应该切到哪个页面、提示词落到哪、文件怎么处理。
 */
import { describe, expect, it } from "vitest";
import {
  isImagePath,
  resolveDeepLink,
  resolvePromptKind,
  type HandoffItem,
} from "./deepLink";

const link = (action: string, params: Record<string, string> = {}): HandoffItem => ({
  product: "aigen",
  action,
  params,
});

describe("resolveDeepLink", () => {
  it("缺省动作 open 落到图片页（aigen 的首页）", () => {
    const out = resolveDeepLink(link("open"));
    expect(out.problem).toBeNull();
    expect(out.mode).toBe("image");
  });

  it("action 直接点名生成类型时切到对应页", () => {
    expect(resolveDeepLink(link("video")).mode).toBe("video");
    expect(resolveDeepLink(link("ppt")).mode).toBe("ppt");
    expect(resolveDeepLink(link("text")).mode).toBe("text");
  });

  it("mode 参数优先于 action（mode 描述「在哪做」）", () => {
    const out = resolveDeepLink(link("image", { mode: "ppt" }));
    expect(out.mode).toBe("ppt");
  });

  it("prompt 原样带出（前后空白被裁掉）", () => {
    const out = resolveDeepLink(link("text", { prompt: "  写一首诗  " }));
    expect(out.prompt).toBe("写一首诗");
  });

  it("file 参数原样带出", () => {
    const out = resolveDeepLink(link("image", { file: "/tmp/a.png" }));
    expect(out.file).toBe("/tmp/a.png");
  });

  it("from 只用于回执，不参与路由", () => {
    const out = resolveDeepLink(link("open", { from: "box" }));
    expect(out.from).toBe("box");
    expect(out.mode).toBe("image");
  });

  it("发给别人的深链由共享层拦下（不在本仓语义层的职责范围）", () => {
    // 「这条深链发给别的产品」是**家族级**判断 —— 同一台机器上装了 14 个 app，
    // 谁都可能收到别人的深链。2026-10-31 起这个判断搬到了共享层
    // （`startDeepLinkReceiver` 里统一做），本仓的 translate 只管应用内部语义。
    // 对应测试在 `z-biz-tool-shared/tests/deeplinkReceiver.test.ts`。
    //
    // 这里只保证一件事：本仓语义层拿到别人的深链时**不会误当成自己的**。
    // 也就是说它不该凭空造出一个 mode。
    const out = resolveDeepLink({ product: "note", action: "open", params: {} });
    expect(out.mode).toBe("image"); // 按 action 解释，与发给谁无关
    expect(out.problem).toBeNull(); // 本仓不负责这个判断
  });

  it("不认识的页面要报错", () => {
    const out = resolveDeepLink(link("open", { mode: "hologram" }));
    expect(out.problem).toContain("hologram");
  });

  it("不认识的��作要报错", () => {
    const out = resolveDeepLink(link("teleport"));
    expect(out.problem).toContain("teleport");
  });
});

describe("resolvePromptKind", () => {
  it("action 点名类型时，提示词落到那个类型", () => {
    expect(resolvePromptKind(link("video", { prompt: "x" }))).toBe("video");
    expect(resolvePromptKind(link("ppt", { prompt: "x" }))).toBe("ppt");
  });

  it("mode 指向的类型也可以", () => {
    expect(resolvePromptKind(link("open", { mode: "text" }))).toBe("text");
  });

  it("都没指明时落到图片（与首页一致）", () => {
    expect(resolvePromptKind(link("open"))).toBe("image");
  });
});

describe("isImagePath", () => {
  it("常见图片扩展名都认", () => {
    for (const p of ["/a/b.png", "/a/b.JPG", "/a/b.jpeg", "/a/b.webp", "/a/b.gif"]) {
      expect(isImagePath(p), p).toBe(true);
    }
  });

  it("非图片与无扩展名都不认", () => {
    for (const p of ["/a/b.md", "/a/b.pdf", "/a/b", "/a/b.tar.gz"]) {
      expect(isImagePath(p), p).toBe(false);
    }
  });
});
