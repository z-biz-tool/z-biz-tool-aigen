import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 原生壳 E2E 的 dev-only 通道（06 §3「端到端」「性能」两格）。
 *
 * 只在 `vite serve` 下存在，`vite build` 完全不参与 ⇒ dist 里不会有驱动脚本；
 * 且必须 AIGEN_E2E=1 启动才供驱动，平时 `tauri dev` 行为不变。
 * 驱动结果 POST 回 /__e2e/report 落到文件，由 tools/e2e_native.py 读出来做门禁断言。
 */
function nativeE2e(): Plugin {
  const driver = path.resolve(__dirname, "e2e/driver.js");
  const report = process.env.AIGEN_E2E_REPORT || "/tmp/aigen-e2e-report.txt";
  return {
    name: "aigen-native-e2e",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/__e2e/driver.js", (_req, res) => {
        if (!process.env.AIGEN_E2E) {
          res.statusCode = 404;
          return res.end("e2e disabled");
        }
        res.setHeader("content-type", "text/javascript; charset=utf-8");
        res.end(fs.readFileSync(driver, "utf8"));
      });
      server.middlewares.use("/__e2e/report", (req, res) => {
        if (req.method !== "POST") {
          res.statusCode = 405;
          return res.end();
        }
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            fs.writeFileSync(report, String(body.text ?? ""), "utf8");
            res.statusCode = 200;
            res.end(JSON.stringify({ ok: true, final: !!body.final }));
          } catch (e) {
            res.statusCode = 400;
            res.end(String(e));
          }
        });
      });
    },
    transformIndexHtml() {
      return [{ tag: "script", attrs: { src: "/__e2e/driver.js" }, injectTo: "body-bottom" as const }];
    },
  };
}

export default defineConfig({
  plugins: [react(), nativeE2e()],
  clearScreen: false,
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  // vitest：只测状态层与纯函数（Tauri IPC 用 mock），不引真实上游（06 §2/R8）
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["./src/test-setup.ts"],
    restoreMocks: true,
  },
} as Parameters<typeof defineConfig>[0]);
