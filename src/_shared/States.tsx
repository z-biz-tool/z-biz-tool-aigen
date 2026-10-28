import { Spin, Result, Button, Space, Tag } from "antd";
import { InboxOutlined, ReloadOutlined, SettingOutlined } from "@ant-design/icons";
import type { ReactNode } from "react";
import { errorHint, wantsConfig, type GenErrorPayload } from "./genError";

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

/**
 * 错误码 → 用户可理解的降级指引。
 *
 * 表已挪到 `_shared/genError.ts`：那是错误契约所在的地方，
 * 而「提示文案」和「该给哪个按钮」必须放在一起看，否则很容易出现
 * 「文案说去改密钥、按钮却只在没配置时才给」这种错位。
 */

interface ErrorStateProps {
  /** 结构化错误；传字符串时按 UNKNOWN 处理 */
  error?: GenErrorPayload | string | null;
  onRetry?: () => void;
  /** 错误指向配置时（NO_CONFIG / AUTH / NETWORK）用于唤起配置弹窗 */
  onOpenConfig?: () => void;
}

export function ErrorState({ error, onRetry, onOpenConfig }: ErrorStateProps) {
  const payload: GenErrorPayload =
    typeof error === "string" || error == null
      ? { code: "UNKNOWN", message: error || "发生未知错误", retryable: false }
      : error;

  const hint = errorHint(payload.code);
  const showRetry = payload.retryable && Boolean(onRetry);
  // 按钮跟提示文案走：文案说「检查 API 配置」，就必须点得到 API 配置。
  // 以前只有 NO_CONFIG 给按钮，而 AUTH 通常不可重试 ⇒ 界面上只剩一行说明和一个
  // 错误码标签，用户无处可去。
  const showConfig = wantsConfig(payload.code) && Boolean(onOpenConfig);

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
