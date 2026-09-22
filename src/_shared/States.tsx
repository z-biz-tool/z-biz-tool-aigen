import { Spin, Result, Button, Space, Tag } from "antd";
import { InboxOutlined, ReloadOutlined, SettingOutlined } from "@ant-design/icons";
import type { ReactNode } from "react";
import type { GenErrorPayload } from "./genError";

interface EmptyStateProps {
  title?: string;
  description?: string;
  icon?: ReactNode;
}

export function EmptyState({
  title = "暂无数据",
  description = "请先添加内容后查看",
  icon,
}: EmptyStateProps) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        height: "100%",
        minHeight: 240,
        gap: 12,
      }}
    >
      {icon ?? <InboxOutlined style={{ fontSize: 56, color: "var(--ant-color-text-tertiary)" }} />}
      <div style={{ fontWeight: 500, fontSize: 15 }}>{title}</div>
      <div style={{ color: "var(--ant-color-text-tertiary)", fontSize: 13 }}>{description}</div>
    </div>
  );
}

interface LoadingStateProps {
  tip?: string;
  minHeight?: number;
  onCancel?: () => void;
}

export function LoadingState({ tip = "加载中...", minHeight = 240, onCancel }: LoadingStateProps) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        minHeight,
        width: "100%",
      }}
    >
      <Space direction="vertical" align="center" size={16}>
        <Spin tip={tip} size="large" />
        {onCancel && (
          <Button danger onClick={onCancel}>
            取消生成
          </Button>
        )}
      </Space>
    </div>
  );
}

/** 错误码 → 用户可理解的降级指引（doc/优化方案/03 §7）。 */
const HINTS: Record<string, string> = {
  NO_CONFIG: "请先在「API 配置」中填写 Base URL 与密钥，保存后即可生成。",
  AUTH: "密钥无效或权限不足，请检查「API 配置」中的密钥。",
  RATE_LIMIT: "上游限流，已自动重试仍未成功，请稍后再试。",
  UPSTREAM_5XX: "上游服务暂时不可用，可稍后重试或更换模型。",
  TIMEOUT: "请求超时，请检查网络，或缩短提示词后重试。",
  PARSE: "上游返回结构异常，可重试；持续失败请更换模型。",
  CONTENT_POLICY: "提示词被上游内容安全策略拒绝，请调整描述。",
  NETWORK: "无法连接上游服务，请检查 Base URL 与网络。",
  INVALID_PARAM: "本次参数不被接受，请调整后重试。",
  STORAGE: "本地配置或产物写入失败，请检查磁盘权限。",
  CONFLICT: "目标文件已存在，确认后会覆盖它。",
  EXPORT: "导出失败，请换一个保存位置。",
  UNKNOWN: "生成失败，请重试或查看运行日志。",
};

interface ErrorStateProps {
  /** 结构化错误；传字符串时按 UNKNOWN 处理 */
  error?: GenErrorPayload | string | null;
  onRetry?: () => void;
  /** NO_CONFIG 时用于唤起配置弹窗 */
  onOpenConfig?: () => void;
}

export function ErrorState({ error, onRetry, onOpenConfig }: ErrorStateProps) {
  const payload: GenErrorPayload =
    typeof error === "string" || error == null
      ? { code: "UNKNOWN", message: error || "发生未知错误", retryable: false }
      : error;

  const hint = HINTS[payload.code] ?? HINTS.UNKNOWN;
  const showRetry = payload.retryable && Boolean(onRetry);
  const showConfig = payload.code === "NO_CONFIG" && Boolean(onOpenConfig);

  return (
    <Result
      status="error"
      title="生成失败"
      subTitle={
        <Space direction="vertical" size={4} style={{ width: "100%" }}>
          <span>{payload.message}</span>
          <span style={{ color: "var(--ant-color-text-tertiary)", fontSize: 13 }}>{hint}</span>
        </Space>
      }
      extra={
        <Space>
          {showRetry && (
            <Button type="primary" icon={<ReloadOutlined />} onClick={onRetry}>
              重试
            </Button>
          )}
          {showConfig && (
            <Button type="primary" icon={<SettingOutlined />} onClick={onOpenConfig}>
              打开 API 配置
            </Button>
          )}
          <Tag>{payload.code}</Tag>
        </Space>
      }
    />
  );
}
