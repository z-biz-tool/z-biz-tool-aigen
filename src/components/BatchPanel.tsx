/**
 * 批量生成面板（02 §7，任务 T-Batch）。
 *
 * 一次提交多行提示词，逐条执行；整体进度 + 单条重试/取消。
 * 启动前必须确认「将发起 N 次请求」（04 §8.2 成本控制）。
 */

import { useMemo, useState } from "react";
import {
  Alert,
  Button,
  Card,
  Input,
  Modal,
  Progress,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
  message,
} from "antd";
import {
  ClearOutlined,
  DownloadOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  StopOutlined,
} from "@ant-design/icons";
import { EXPORT_FILTERS, exportResult, stamp } from "../_shared/export";
import { useAIGenStore, useModelOptions, type GenKind } from "../stores/aiStore";
import { useBatchStore, type BatchItem } from "../stores/batchStore";

const { TextArea } = Input;
const { Text, Paragraph } = Typography;

const KINDS: { value: GenKind; label: string; cmd: string }[] = [
  { value: "text", label: "文本写作", cmd: "generate_text" },
  { value: "image", label: "图片生成", cmd: "generate_image" },
];

const STATUS_TAG: Record<string, { color: string; label: string }> = {
  queued: { color: "default", label: "排队中" },
  running: { color: "processing", label: "生成中" },
  succeeded: { color: "success", label: "成功" },
  failed: { color: "error", label: "失败" },
  cancelled: { color: "warning", label: "已取消" },
};

export default function BatchPanel() {
  const [kind, setKind] = useState<GenKind>("text");
  const [model, setModel] = useState<string | undefined>(undefined);
  const [raw, setRaw] = useState("");
  const items = useBatchStore((s) => s.items);
  const running = useBatchStore((s) => s.running);
  const start = useBatchStore((s) => s.start);
  const retry = useBatchStore((s) => s.retry);
  const cancel = useBatchStore((s) => s.cancel);
  const cancelAll = useBatchStore((s) => s.cancelAll);
  const clear = useBatchStore((s) => s.clear);
  const { options: providerModels } = useModelOptions(kind);
  const openConfig = useAIGenStore((s) => s.openConfig);

  const prompts = useMemo(
    () =>
      raw
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean),
    [raw]
  );
  const succeeded = items.filter((i) => i.status === "succeeded").length;
  const failed = items.filter((i) => i.status === "failed").length;
  const done = items.filter((i) => i.status !== "queued" && i.status !== "running").length;

  const confirmAndStart = () => {
    if (!prompts.length) {
      message.warning("请至少输入一行提示词");
      return;
    }
    const spec = KINDS.find((k) => k.value === kind)!;
    // 04 §8.2：批量执行前给出请求数确认
    Modal.confirm({
      title: `将发起 ${prompts.length} 次请求`,
      content: (
        <Space direction="vertical" size={4}>
          <Text>类型：{spec.label}</Text>
          <Text>模型：{model ?? (providerModels?.length ? providerModels[0].value : "服务商默认")}</Text>
          <Text type="secondary" style={{ fontSize: 12 }}>
            上游并发受全局闸门限制（同时最多 2 条），超出的会在服务端排队
          </Text>
        </Space>
      ),
      okText: "开始批量",
      cancelText: "取消",
      onOk: () => {
        const args =
          kind === "image"
            ? { count: 1, size: "1024x1024", model }
            : { model, opts: { temperature: 0.7, maxTokens: 1024 } };
        start(kind, spec.cmd, prompts, args);
      },
    });
  };

  return (
    <div style={{ maxWidth: 980, margin: "0 auto" }}>
      <Card
        title="批量生成"
        extra={
          <Space>
            {items.length > 0 && (
              <>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  成功 {succeeded} / 失败 {failed} / 共 {items.length}
                </Text>
                <Button size="small" icon={<ClearOutlined />} onClick={clear} disabled={running}>
                  清空
                </Button>
              </>
            )}
          </Space>
        }
      >
        <Space direction="vertical" style={{ width: "100%" }} size="middle">
          <Space wrap size="middle">
            <Select
              value={kind}
              onChange={(v) => setKind(v)}
              options={KINDS.map((k) => ({ value: k.value, label: k.label }))}
              style={{ width: 140 }}
              size="large"
            />
            <Select
              allowClear
              placeholder="模型（默认取服务商第一个）"
              value={model}
              onChange={setModel}
              style={{ minWidth: 260 }}
              size="large"
              options={providerModels ?? []}
            />
            <Button
              type="primary"
              size="large"
              icon={<PlayCircleOutlined />}
              onClick={confirmAndStart}
              disabled={running}
              loading={running}
            >
              开始批量
            </Button>
            {running && (
              <Button danger size="large" icon={<StopOutlined />} onClick={cancelAll}>
                全部取消
              </Button>
            )}
          </Space>

          <div>
            <Text strong>提示词清单（每行一条）</Text>
            <TextArea
              rows={8}
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              placeholder={"写一段关于秋天的短文\n介绍 Tauri 的桌面端优势\n一只橘猫在窗台晒太阳"}
              style={{ marginTop: 8 }}
            />
            <Text type="secondary" style={{ fontSize: 12 }}>
              已识别 {prompts.length} 条提示词
            </Text>
          </div>

          {prompts.length > 20 && (
            <Alert
              type="warning"
              showIcon
              message={`本次将发起 ${prompts.length} 次上游请求，注意额度消耗`}
            />
          )}
        </Space>
      </Card>

      {items.length > 0 && (
        <Card title="执行队列" style={{ marginTop: 16 }}>
          <Progress
            percent={Math.round((done / items.length) * 100)}
            status={running ? "active" : failed ? "exception" : "success"}
            style={{ marginBottom: 16 }}
          />
          <Table<BatchItem>
            size="small"
            rowKey="key"
            dataSource={items}
            pagination={{ pageSize: 10, size: "small" }}
            columns={[
              {
                title: "提示词",
                dataIndex: "prompt",
                render: (p: string) => (
                  <Paragraph ellipsis={{ rows: 2, tooltip: p }} style={{ marginBottom: 0 }}>
                    {p}
                  </Paragraph>
                ),
              },
              {
                title: "状态",
                dataIndex: "status",
                width: 96,
                render: (s: string, row) => (
                  <Tooltip title={row.error ? `${row.error.code}：${row.error.message}` : undefined}>
                    <Tag color={STATUS_TAG[s]?.color}>{STATUS_TAG[s]?.label ?? s}</Tag>
                  </Tooltip>
                ),
              },
              {
                title: "结果",
                dataIndex: "result",
                render: (r: string | null, row) =>
                  row.status === "succeeded" ? (
                    <Paragraph
                      ellipsis={{ rows: 2, tooltip: r ?? undefined }}
                      style={{ marginBottom: 0, fontSize: 12 }}
                    >
                      {r}
                    </Paragraph>
                  ) : (
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {row.error?.message ?? "—"}
                    </Text>
                  ),
              },
              {
                title: "耗时",
                dataIndex: "durationMs",
                width: 80,
                render: (d: number | null) => (d ? `${(d / 1000).toFixed(1)}s` : "—"),
              },
              {
                title: "操作",
                key: "ops",
                width: 120,
                render: (_, row) => (
                  <Space size={4}>
                    {(row.status === "running" || row.status === "queued") && (
                      <Button size="small" danger icon={<StopOutlined />} onClick={() => cancel(row.key)} />
                    )}
                    {row.status === "failed" && (
                      <Tooltip title="重试这一条">
                        <Button size="small" icon={<ReloadOutlined />} onClick={() => retry(row.key)} />
                      </Tooltip>
                    )}
                    {row.status === "succeeded" && row.kind === "text" && row.result && (
                      <Tooltip title="导出这一条">
                        <Button
                          size="small"
                          icon={<DownloadOutlined />}
                          onClick={() =>
                            void exportResult({
                              defaultName: `aigen-batch-${stamp()}.md`,
                              filters: EXPORT_FILTERS.text,
                              text: row.result ?? "",
                            })
                          }
                        />
                      </Tooltip>
                    )}
                  </Space>
                ),
              },
            ]}
          />
        </Card>
      )}

      {items.length === 0 && !providerModels?.length && (
        <Alert
          style={{ marginTop: 16 }}
          type="info"
          showIcon
          message="还没配置服务商"
          description={
            <Button size="small" type="link" onClick={openConfig}>
              去「服务商与密钥」添加
            </Button>
          }
        />
      )}
    </div>
  );
}
