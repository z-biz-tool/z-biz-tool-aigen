/**
 * zbiz:// 深链接接收（2026-10-30 接入 cap-hub）。
 *
 * ## 协议
 *
 * 家族统一语法：`zbiz://<product>/<action>?<key>=<value>&...`
 * 规范见 `z-biz-tool-lead/doc/矩阵规划/04_连接度：家族面板与统一协议.md` §2。
 * 编解码在 `cap-hub`（Rust）与 `z-biz-tool-shared/src/protocol/deeplink.ts`（TS）里，
 * 两边有 golden 样本逐字节比对 —— 本文件只做**语义**：把深链翻译成本应用的动作。
 *
 * ## aigen 支持的动作
 *
 * | action | 含义 |
 * |--------|------|
 * | `open`  | 打开（缺省 action），带参数定位到具体页面与草稿 |
 * | `image` | 直接进图片生成页 |
 * | `video` | 直接进视频制造页 |
 * | `ppt`   | 直接进 PPT 生成页 |
 * | `text`  | 直接进文本写作页 |
 *
 * ## 支持的参数
 *
 * | 参数 | 作用 |
 * |------|------|
 * | `mode`   | 目标页面：image / video / ppt / text / batch（优先于 action） |
 * | `prompt` | 提示词草稿，直接填进对应表单 |
 * | `file`   | 本地文件路径：图片类走参考图，其余走「待处理」提示 |
 * | `from`   | 发送方（box 等），只用于日志与回执，不参与路由 |
 *
 * ## 为什么「不认识的深链」要显式提示
 *
 * 静默吞掉的话，用户看到的就是「点了没反应」，无从判断是路径错了还是这应用不支持。
 * 所以未适配的深链一律给出可见提示，并带上 `from` 便于排查。
 */

import type { ModeId } from "../stores/uiStore";
import type { GenKind } from "../stores/generationStore";

/** Rust 侧 `cap_hub::Handoff` 的镜像（serde 默认字段名，不做 camelCase） */
export interface HandoffItem {
  product: string;
  action: string;
  params: Record<string, string>;
}

/** 深链事件名（cap_hub::EVENT）。payload 无意义，只当「队列里有新深链了」的信号。 */
export const ZBIZ_EVENT = "zbiz-open";

/** 取队列的命令名。家族统一，box 等兄弟仓同名。 */
export const ZBIZ_TAKE_PENDING = "zbiz_take_pending";

/** action → 目标页面 */
const ACTION_TO_MODE: Record<string, ModeId> = {
  open: "image",
  image: "image",
  video: "video",
  ppt: "ppt",
  text: "text",
  batch: "batch",
};

/** 哪些页面有单条提示词草稿（batch 是多行队列，不单列） */
const MODE_TO_KIND: Partial<Record<ModeId, GenKind>> = {
  image: "image",
  video: "video",
  ppt: "ppt",
  text: "text",
};

/** 本应用的深链结果 */
export interface DeepLinkOutcome {
  /** 要切换到的页面；null 表示这条深链不带页面意图 */
  mode: ModeId | null;
  /** 要写进提示词草稿的文本 */
  prompt: string | null;
  /** 要作为参考图的本地路径 */
  file: string | null;
  /** 发送方（from），仅用于提示与日志 */
  from: string | null;
  /** 无法适配时的原因；非 null 时前端应给出可见提示而不是静默吞掉 */
  problem: string | null;
}

/**
 * 把一条深链翻译成应用内动作。
 *
 * 纯函数 —— 不碰 store、不碰 Tauri，所以可以直接单测。
 */
export function resolveDeepLink(item: HandoffItem): DeepLinkOutcome {
  const outcome: DeepLinkOutcome = {
    mode: null,
    prompt: null,
    file: null,
    from: item.params.from ?? null,
    problem: null,
  };

  if (item.product !== "aigen") {
    outcome.problem = `这条深链发给 ${item.product}，不是本应用`;
    return outcome;
  }

  // mode 参数优先于 action：action 描述「做什么」，mode 描述「在哪做」。
  const rawMode = item.params.mode?.trim();
  const action = item.action.trim() || "open";

  let mode: ModeId | null = null;
  if (rawMode) {
    if (rawMode in ACTION_TO_MODE) {
      mode = rawMode as ModeId;
    } else {
      outcome.problem = `不认识的页面 ${rawMode}`;
      return outcome;
    }
  } else if (action in ACTION_TO_MODE) {
    mode = ACTION_TO_MODE[action];
  } else {
    outcome.problem = `不认识的动作 ${action}`;
    return outcome;
  }

  outcome.mode = mode;
  const prompt = item.params.prompt?.trim() ?? "";
  const file = item.params.file?.trim() ?? "";
  if (prompt) outcome.prompt = prompt;
  if (file) outcome.file = file;
  return outcome;
}

/**
 * 提示词该写进哪个类型的草稿。
 *
 * 与 resolveDeepLink 分开，是因为「写草稿」需要动 store，
 * 而这里保持纯函数便于单测。
 */
export function resolvePromptKind(item: HandoffItem): GenKind {
  const action = item.action.trim() || "open";
  if (action !== "open" && action in MODE_TO_KIND) {
    return action as GenKind;
  }
  const rawMode = item.params.mode?.trim();
  if (rawMode) {
    const kind = MODE_TO_KIND[rawMode as ModeId];
    if (kind) return kind;
  }
  return "image";
}

/** 图片类扩展名：这些才能作为参考图 */
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "webp", "gif", "bmp"]);

/**
 * 判断一个路径是不是能当参考图。
 *
 * 判断依据是扩展名 —— 渲染进程没有 fs 权限，读不了文件头；
 * 真正的魔数与大小校验在 Rust 的 `prepare_reference_image` 里做。
 */
export function isImagePath(path: string): boolean {
  const m = /\.([A-Za-z0-9]+)$/.exec(path.trim());
  if (!m) return false;
  return IMAGE_EXT.has(m[1].toLowerCase());
}
