import { message } from "antd";

/**
 * 复制并如实回报结果。剪贴板 API 在非安全上下文或权限被拒时会 reject，
 * 不能先弹「已复制」再写。
 */
export async function copyToClipboard(
  text: string,
  label = "已复制到剪贴板",
): Promise<boolean> {
  if (!text) {
    message.warning("没有可复制的内容");
    return false;
  }
  try {
    await navigator.clipboard.writeText(text);
    message.success(label);
    return true;
  } catch (e) {
    console.warn("[clipboard] 写入剪贴板失败:", e);
    message.error("复制失败，请手动选择文本复制");
    return false;
  }
}
