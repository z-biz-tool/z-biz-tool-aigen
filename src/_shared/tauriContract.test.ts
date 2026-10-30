// 跨语言命令契约：前端 invoke 的命令名与参数名，必须与 Rust 侧 #[tauri::command] 一致。
// 跑法：npm test（vitest，include: src/**/*.test.{ts,tsx}）
//
// 为什么必须有这条测试：
//   Tauri 的命令参数在**两侧各写一遍**（Rust 的 snake_case 签名 ⇒ 前端传 camelCase），
//   而 TypeScript **不知道** Rust 的签名长什么样 ⇒ 前端把 `allowOverwrite` 拼成
//   `allow_overwrite`，tsc 照样过；运行时 Rust 收到 None ⇒ `unwrap_or(false)`
//   ⇒ 「覆盖」永远不生效，**全程无任何报错**。
//   这类漂移靠人 review 是抓不到的：两边都"看起来对"。
//
// 本测试的做法：直接读 Rust 源码解析命令签名，再扫前端源码解析 invoke 调用点，
// 两边**自动比对**。不写死任何参数清单 ⇒ Rust 那边改了签名，本测试自动跟着变。
//
// ⚠️ 解析器的两个坑（第一版栽在这里，已修）：
//   1. Rust 生命周期 `'_` **不是**字符串引号。按引号处理会把该参数之后的所有内容吞进
//      "字符串"，导致整条命令的参数被解析成 1 个（`state`）—— 看起来"全部参数丢失"，
//      实际是解析器坏了。**这类"量具坏了"的现象与"数据坏了"长得一模一样。**
//   2. 前端对象字面量的**简写属性** `{ id }` 没有冒号 ⇒ 键名就是标识符本身。
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const RUST_COMMANDS = join(REPO, "src-tauri", "src", "commands.rs");
const SRC = join(REPO, "src");

/** 顶层分隔符切分：忽略括号/尖括号/字符串里的分隔符 */
function splitTop(s: string, sep = ","): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  let instr: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (instr) {
      cur += ch;
      if (ch === "\\" && i + 1 < s.length) {
        cur += s[i + 1];
        i++;
      } else if (ch === instr) {
        instr = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      // Rust 生命周期占位 `'_` / `'a` 不开字符串
      if (ch === "'" && i + 1 < s.length) {
        const nxt = s[i + 1];
        if (nxt === "_" || (nxt.match(/[A-Za-z]/) && s[i + 2] !== "'")) {
          cur += ch;
          continue;
        }
      }
      instr = ch;
      cur += ch;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{" || ch === "<") depth++;
    else if (ch === ")" || ch === "]" || ch === "}" || ch === ">") depth--;
    if (ch === sep && depth === 0) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

/** snake_case → camelCase（Tauri v2 的参数名转换规则） */
function camel(s: string): string {
  const parts = s.split("_");
  return parts[0] + parts.slice(1).map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join("");
}

interface RustParam {
  camel: string;
  injected: boolean;
  optional: boolean;
}

/** 解析 Rust 源码里所有 #[tauri::command] 的命令名与参数 */
function parseRustCommands(src: string): Map<string, RustParam[]> {
  const map = new Map<string, RustParam[]>();
  const re = /#\[tauri::command\]\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+(\w+)\s*\(([^)]*)\)/g;
  for (const m of src.matchAll(re)) {
    const name = m[1];
    const params: RustParam[] = [];
    for (const p of splitTop(m[2])) {
      const i = p.indexOf(":");
      if (i < 0) continue;
      const pn = p.slice(0, i).trim();
      const pt = p.slice(i + 1).trim();
      params.push({
        camel: camel(pn),
        injected: pt.includes("State<") || pt.includes("AppHandle"),
        optional: pt.startsWith("Option<"),
      });
    }
    map.set(name, params);
  }
  return map;
}

interface InvokeCall {
  cmd: string;
  keys: string[];
  file: string;
  line: number;
}

/** 递归列出 src 下所有非测试的 .ts/.tsx */
function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      out.push(...listSourceFiles(p));
    } else if (/\.tsx?$/.test(name) && !name.includes(".test.")) {
      out.push(p);
    }
  }
  return out;
}

/**
 * 收集「命令名常量」：`export const ZBIZ_TAKE_PENDING = "zbiz_take_pending"`。
 *
 * 为什么要认常量：前端把命令名提成常量（`ZBIZ_TAKE_PENDING`），
 * 是为了拼错时编译期就报错。若解析器只认字面量，就得让前端退回
 * `invoke("zbiz_take_pending")` 字面量写法 —— 那样拼错**编译期也发现不了**。
 * 所以这里把常量也解析出来，让「用常量」与「契约可查」同时成立。
 */
function collectCmdConstants(files: string[]): Map<string, string> {
  const map = new Map<string, string>();
  const re = /export\s+const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*["']([a-z_]+)["']/g;
  for (const f of files) {
    const txt = readFileSync(f, "utf8");
    for (const m of txt.matchAll(re)) {
      map.set(m[1], m[2]);
    }
  }
  return map;
}

/** 扫出所有 invoke("cmd", { ... }) 调用点及其顶层键 */
function parseInvokeCalls(files: string[], constants: Map<string, string>): InvokeCall[] {
  const calls: InvokeCall[] = [];
  // 命令名可以是字面量，也可以是常量名（常量表查得到就替换成字面量）
  const re =
    /invoke(?:<[^>]*>)?\(\s*(?:["']([a-z_]+)["']|([A-Za-z_$][\w$]*))\s*(?:,\s*(\{.*?\}))?\s*\)/gs;
  for (const f of files) {
    const txt = readFileSync(f, "utf8");
    for (const m of txt.matchAll(re)) {
      const cmd = m[1] ?? constants.get(m[2] ?? "");
      if (!cmd) {
        // 常量查不到 ⇒ 命令名未知。这类调用点无法校验，跳过但留下痕迹：
        // 契约测试会在下面「量具自检」里保证至少扫到足够多的调用点。
        continue;
      }
      const keys: string[] = [];
      if (m[3]) {
        const body = m[3].trim().slice(1, -1);
        for (const part of splitTop(body)) {
          const withColon = part.match(/^([A-Za-z_$][\w$]*)\s*[:,]/);
          const spread = part.match(/^\.\.\.([A-Za-z_$][\w$]*)$/);
          const shorthand = part.match(/^([A-Za-z_$][\w$]*)$/);
          const key = withColon?.[1] ?? spread?.[1] ?? shorthand?.[1];
          if (key) keys.push(key);
        }
      }
      calls.push({
        cmd,
        keys,
        file: f.replace(REPO + "/", ""),
        line: txt.slice(0, m.index).split("\n").length,
      });
    }
  }
  return calls;
}

/**
 * 已实现但前端**不调用**的命令 —— 显式声明，不沉默。
 * 加一条新命令却忘了接线，功能就是「没有」，而界面不报错。
 */
const RESERVED_NOT_WIRED = new Map<string, string>([
  [
    "list_generations",
    "任务态快照：当前前端用「事件推送 + get_generation 对账」两条路就够了，" +
      "没有全量列表的界面入口。保留为公开命令，但显式记在这里，不让它沉默。",
  ],
]);

const rustSrc = readFileSync(RUST_COMMANDS, "utf8");
const rustCommands = parseRustCommands(rustSrc);
const sourceFiles = listSourceFiles(SRC);
const cmdConstants = collectCmdConstants(sourceFiles);
const invokeCalls = parseInvokeCalls(sourceFiles, cmdConstants);

describe("Tauri 命令契约（前端 invoke ⇄ Rust #[tauri::command]）", () => {
  it("解析器本身是好的：Rust 侧解析出 20 个以上命令，每个都有参数信息", () => {
    // 这条是**量具自检**：解析器坏了的话，后面的比对会「全部通过」而毫无意义。
    expect(rustCommands.size).toBeGreaterThanOrEqual(20);
    const saveExport = rustCommands.get("save_export");
    expect(saveExport, "save_export 必须被解析出来").toBeDefined();
    // `state: State<'_, AppState>` 是 Tauri 注入的，不是前端可传的参数
    expect(saveExport!.filter((p) => !p.injected).map((p) => p.camel)).toEqual([
      "targetPath",
      "recordId",
      "refIndex",
      "text",
      "allowOverwrite",
    ]);
    expect(
      saveExport!.filter((p) => p.injected).map((p) => p.camel),
      "注入参数（State/AppHandle）必须被识别出来",
    ).toEqual(["state"]);
  });

  it("解析器本身是好的：前端至少扫出 20 个 invoke 调用点", () => {
    expect(invokeCalls.length).toBeGreaterThanOrEqual(20);
  });

  it("每个前端 invoke 的命令都真实存在于 Rust 侧", () => {
    const missing = invokeCalls.filter((c) => !rustCommands.has(c.cmd));
    expect(
      missing.map((c) => `${c.cmd}（${c.file}:${c.line}）`),
      "前端调用了 Rust 侧不存在的命令 ⇒ 运行时才炸",
    ).toEqual([]);
  });

  it("前端传的每个参数名都在 Rust 签名的可传参数里（拼错 ⇒ 静默收到 None）", () => {
    const bad: string[] = [];
    for (const c of invokeCalls) {
      const params = rustCommands.get(c.cmd);
      if (!params) continue;
      const allowed = new Set(params.filter((p) => !p.injected).map((p) => p.camel));
      for (const k of c.keys) {
        if (!allowed.has(k)) {
          bad.push(`${c.cmd} 传了 Rust 不认的参数 ${k}（${c.file}:${c.line}）`);
        }
      }
    }
    expect(bad, "参数名漂移 ⇒ Rust 收到 None ⇒ 功能静默降级").toEqual([]);
  });

  it("Rust 侧的必填参数在前端都传了（漏传 ⇒ 运行时才发现）", () => {
    const bad: string[] = [];
    for (const c of invokeCalls) {
      const params = rustCommands.get(c.cmd);
      if (!params) continue;
      const required = params.filter((p) => !p.injected && !p.optional).map((p) => p.camel);
      for (const r of required) {
        if (!c.keys.includes(r)) {
          bad.push(`${c.cmd} 漏传必填参数 ${r}（${c.file}:${c.line}）`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it("Rust 侧的命令要么被前端调用，要么在「预留未接线」清单里显式声明", () => {
    const called = new Set(invokeCalls.map((c) => c.cmd));
    const unaccounted: string[] = [];
    for (const cmd of rustCommands.keys()) {
      if (called.has(cmd)) continue;
      if (RESERVED_NOT_WIRED.has(cmd)) continue;
      unaccounted.push(cmd);
    }
    expect(
      unaccounted,
      "这些命令实现了、注册了，却没有任何前端调用点 ⇒ 功能等于没有，且没人会发现",
    ).toEqual([]);
  });

  it("「预留未接线」清单里的命令必须真的没有前端调用点（否则该从清单里删掉）", () => {
    const called = new Set(invokeCalls.map((c) => c.cmd));
    for (const cmd of RESERVED_NOT_WIRED.keys()) {
      expect(called.has(cmd), `${cmd} 已经被前端调用了 ⇒ 应从预留清单移除`).toBe(false);
      expect(rustCommands.has(cmd), `${cmd} 在 Rust 侧不存在 ⇒ 预留清单该删了`).toBe(true);
    }
  });

  it("命令名常量必须指向 Rust 侧真实存在的命令（常量改名不会静默失联）", () => {
    // 常量是为了拼错能编译期报错而提的，但常量本身也可能指向一个不存在的命令。
    // 这条把「常量 → Rust 命令」这一环也纳入契约。
    const bad: string[] = [];
    for (const [name, value] of cmdConstants) {
      if (!rustCommands.has(value)) {
        bad.push(`常量 ${name} = "${value}" 在 Rust 侧不存在`);
      }
    }
    expect(bad, "命令名常量指向不存在的 Rust 命令 ⇒ 调用会运行时才炸").toEqual([]);
  });

  it("量具自检：命令名常量至少被解析到一条（否则上面的常量检查形同虚设）", () => {
    expect(cmdConstants.size).toBeGreaterThanOrEqual(1);
    expect(cmdConstants.get("ZBIZ_TAKE_PENDING")).toBe("zbiz_take_pending");
  });
});
