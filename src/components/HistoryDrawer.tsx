import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  Button,
  Drawer,
  Empty,
  Input,
  List,
  Popconfirm,
  Select,
  Space,
  Tag,
  Tooltip,
  Typography,
  message,
} from "antd";
import {
  DeleteOutlined,
  DownloadOutlined,
  RedoOutlined,
  ReloadOutlined,
  StarFilled,
  StarOutlined,
} from "@ant-design/icons";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { EXPORT_FILTERS, exportResult, stamp } from "../_shared/export";
import { useAIGenStore, type GenerationRecord } from "../stores/aiStore";
import { useGenerationStore, type GenKind } from "../stores/generationStore";

const { Text, Paragraph } = Typography;

const KIND_LABEL: Record<string, string> = {
  image: "图片",
  text: "文本",
  video: "视频",
  ppt: "PPT",
};

const KIND_COLOR: Record<string, string> = {
  image: "purple",
  text: "blue",
  video: "cyan",
  ppt: "orange",
};

const PAGE_SIZE = 20;

/** 导出建议文件名与过滤器：PPT 是 HTML 产物，文本走 .md，其余按结果扩展名 */
function exportName(item: GenerationRecord): string {
  const base = `aigen-${item.id.slice(0, 8)}-${stamp()}`;
  if (item.kind === "text") return `${base}.md`;
  if (item.kind === "ppt") return `${base}.html`;
  if (item.kind === "video") return `${base}.mp4`;
  const ref = item.result_refs[0] ?? "";
  const ext = ref.includes(".") ? ref.slice(ref.lastIndexOf(".") + 1) : "png";
  return `${base}.${ext}`;
}

function exportFilters(item: GenerationRecord) {
  if (item.kind === "text") return EXPORT_FILTERS.text;
  if (item.kind === "ppt") return EXPORT_FILTERS.html;
  if (item.kind === "video") return EXPORT_FILTERS.video;
  return EXPORT_FILTERS.image;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

/** asset 协议 URL 转换；拿不到就退回路径展示（不让抽屉把整个界面带崩） */
function toAssetUrl(abs: string): string | null {
  try {
    return convertFileSrc(abs);
  } catch {
    return null;
  }
}

/**
 * 结果引用：历史里只存相对路径（B6），图片经 asset 协议读本地文件。
 * 拿不到图（非 Tauri 环境 / 文件被清理）就退回显示路径。
 */
/** 只有落盘引用才是本地路径；`task:` 句柄与远程 URL 原样展示 */function isLocalRef(ref: string): boolean {
  return !/^(task:|https?:|data:)/i.test(ref);
}

function ResultRef({
  refs,
  dataDir,
  thumbnail,
}: {
  refs: string[];
  dataDir: string;
  thumbnail: boolean;
}) {
  const [failed, setFailed] = useState(false);
  const first = refs[0];
  if (!first) return null;
  const local = isLocalRef(first);
  const abs = local && dataDir ? `${dataDir.replace(/\/$/, "")}/${first}` : first;
  const label = refs.length > 1 ? `${refs.length} 个结果文件` : first;
  const assetUrl = thumbnail && local && dataDir && !failed ? toAssetUrl(abs) : null;
  if (!assetUrl) {
    return (
      <Text type="secondary" style={{ fontSize: 12 }} copyable={{ text: abs }}>
        {label} · {abs}
      </Text>
    );
  }
  return (
    <Space align="start" size={8}>
      <img
        src={assetUrl}
        alt=""
        onError={() => setFailed(true)}
        style={{ width: 72, height: 72, objectFit: "cover", borderRadius: 6 }}
      />
      <Text type="secondary" style={{ fontSize: 12 }} copyable={{ text: abs }}>
        {label}
      </Text>
    </Space>
  );
}

interface HistoryDrawerProps {
  open: boolean;
  onClose: () => void;
  /** 回填后切到对应面板 */
  onBackfill: (kind: GenKind) => void;
}

export default function HistoryDrawer({ open, onClose, onBackfill }: HistoryDrawerProps) {
  const history = useAIGenStore((s) => s.history);
  const historyTotal = useAIGenStore((s) => s.historyTotal);
  const historyStored = useAIGenStore((s) => s.historyStored);
  const dropped = useAIGenStore((s) => s.historyDropped);
  const loadHistory = useAIGenStore((s) => s.loadHistory);
  const removeHistory = useAIGenStore((s) => s.removeHistory);
  const wipeHistory = useAIGenStore((s) => s.wipeHistory);
  const backfill = useGenerationStore((s) => s.backfill);

  const [kind, setKind] = useState<GenKind | "all">("all");
  const [keyword, setKeyword] = useState("");
  const [page, setPage] = useState(0);
  const [dataDir, setDataDir] = useState("");

  // 04 §8.3：累计用量（上游有回 usage 才有数字）
  const totalTokens = useMemo(
    () =>
      history.reduce(
        (sum, r) =>
          sum + (r.usage ? r.usage.prompt_tokens + r.usage.completion_tokens : 0),
        0
      ),
    [history]
  );

  const refresh = useCallback(
    (targetPage = page) => {
      void loadHistory({
        kind: kind === "all" ? undefined : kind,
        keyword: keyword || undefined,
        page: targetPage,
        size: PAGE_SIZE,
      });
    },
    [kind, keyword, page, loadHistory]
  );

  useEffect(() => {
    if (open) {
      setPage(0);
      void loadHistory({
        kind: kind === "all" ? undefined : kind,
        keyword: keyword || undefined,
        page: 0,
        size: PAGE_SIZE,
      });
    }
    // 打开时重读即可，筛选变化由按钮/回车显式触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (open && !dataDir) {
      invoke<string>("data_dir_path").then(setDataDir).catch(() => setDataDir(""));
    }
  }, [open, dataDir]);

  const handleDelete = async (id: string) => {
    try {
      await removeHistory(id);
      message.success("已删除该条历史及其本地结果文件");
      refresh();
    } catch (e) {
      message.error(`删除失败：${String(e)}`);
    }
  };

  const handleWipe = async () => {
    try {
      await wipeHistory();
      message.success("历史与本地结果已清空");
      setPage(0);
    } catch (e) {
      message.error(`清空失败：${String(e)}`);
    }
  };

  const handleFavorite = async (record: GenerationRecord) => {
    try {
      await invoke("set_history_favorite", { id: record.id, favorite: !record.favorite });
      refresh();
    } catch (e) {
      message.error(`操作失败：${String(e)}`);
    }
  };

  return (
    <Drawer
      title="生成历史"
      placement="right"
      width={520}
      open={open}
      onClose={onClose}
      extra={
        <Tooltip title="重新读取本地历史">
          <Button icon={<ReloadOutlined />} onClick={() => refresh()} />
        </Tooltip>
      }
    >
      <Space direction="vertical" style={{ width: "100%" }} size="middle">
        {dropped > 0 && (
          <Alert
            type="warning"
            showIcon
            message={`历史文件有 ${dropped} 行损坏已跳过，原文备份为 history.jsonl.bak`}
          />
        )}
        <Space wrap style={{ width: "100%" }}>
          <Select
            value={kind}
            onChange={(v) => setKind(v)}
            style={{ width: 120 }}
            options={[
              { value: "all", label: "全部类型" },
              { value: "image", label: "图片" },
              { value: "text", label: "文本" },
              { value: "video", label: "视频" },
              { value: "ppt", label: "PPT" },
            ]}
          />
          <Input.Search
            placeholder="搜索提示词或正文"
            allowClear
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            onSearch={() => refresh(0)}
            style={{ width: 220 }}
          />
        </Space>

        {history.length === 0 ? (
          <Empty description="还没有生成记录" />
        ) : (
          <List
            dataSource={history}
            renderItem={(item) => (
              <List.Item
                key={item.id}
                actions={[
                  <Tooltip title="导出到本地目录" key="export">
                    <Button
                      icon={<DownloadOutlined />}
                      size="small"
                      disabled={item.status === "polling" && item.kind === "video"}
                      onClick={() =>
                        void exportResult({
                          recordId: item.id,
                          defaultName: exportName(item),
                          filters: exportFilters(item),
                        })
                      }
                    />
                  </Tooltip>,
                  <Tooltip title="把提示词回填到面板，改改再生成" key="again">
                    <Button
                      icon={<RedoOutlined />}
                      size="small"
                      onClick={() => {
                        backfill(item.kind, item.prompt);
                        onBackfill(item.kind);
                      }}
                    />
                  </Tooltip>,
                  <Tooltip key="fav" title={item.favorite ? "取消收藏" : "收藏"}>
                    <Button
                      icon={item.favorite ? <StarFilled /> : <StarOutlined />}
                      size="small"
                      onClick={() => void handleFavorite(item)}
                    />
                  </Tooltip>,
                  // 破坏性操作：必须二次确认（04 §6）
                  <Popconfirm
                    key="del"
                    title="删除这条历史？"
                    description="其本地结果文件会一并删除"
                    okText="删除"
                    okButtonProps={{ danger: true }}
                    cancelText="取消"
                    onConfirm={() => void handleDelete(item.id)}
                  >
                    <Button icon={<DeleteOutlined />} size="small" danger />
                  </Popconfirm>,
                ]}
              >
                <List.Item.Meta
                  title={
                    <Space size={4} wrap>
                      <Tag color={KIND_COLOR[item.kind]}>{KIND_LABEL[item.kind] ?? item.kind}</Tag>
                      {item.model && <Tag>{item.model}</Tag>}
                      {item.status !== "succeeded" && <Tag color="gold">{item.status}</Tag>}
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        {formatTime(item.created_at)}
                      </Text>
                    </Space>
                  }
                  description={
                    <Space direction="vertical" size={2} style={{ width: "100%" }}>
                      <Paragraph
                        ellipsis={{ rows: 2, tooltip: item.prompt }}
                        style={{ marginBottom: 0 }}
                      >
                        {item.prompt}
                      </Paragraph>
                      {item.text_result && (
                        <Paragraph
                          type="secondary"
                          ellipsis={{ rows: 2 }}
                          style={{ marginBottom: 0, fontSize: 12 }}
                        >
                          {item.text_result}
                        </Paragraph>
                      )}
                      {item.usage && (
                        <Text type="secondary" style={{ fontSize: 12 }}>
                          tokens：{item.usage.prompt_tokens} + {item.usage.completion_tokens}
                        </Text>
                      )}
                      {item.result_refs.length > 0 && (
                        <ResultRef
                          refs={item.result_refs}
                          dataDir={dataDir}
                          thumbnail={item.kind === "image"}
                        />
                      )}
                    </Space>
                  }
                />
              </List.Item>
            )}
          />
        )}

        <Space style={{ width: "100%", justifyContent: "space-between" }}>
          <Text type="secondary" style={{ fontSize: 12 }}>
            命中 {historyTotal} / 本地 {historyStored} 条
            {totalTokens > 0 ? ` · 累计 ${totalTokens} tokens` : ""}
            {dataDir ? ` · 存于 ${dataDir}` : ""}
          </Text>
          <Popconfirm
            title="清空全部历史？"
            description="所有本地结果文件都会一并删除，无法恢复"
            okText="清空"
            okButtonProps={{ danger: true }}
            cancelText="取消"
            onConfirm={() => void handleWipe()}
          >
            <Button danger size="small" icon={<DeleteOutlined />}>
              清空全部
            </Button>
          </Popconfirm>
        </Space>
      </Space>
    </Drawer>
  );
}
