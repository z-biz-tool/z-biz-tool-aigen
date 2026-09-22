/**
 * 生成助手抽屉（T-Agent）。
 *
 * 界面层同样守 04 §6：这里只有"看建议"和两个显式动作——
 * 填入草稿、另存为我的模板；不会自动发起生成，也不会改任何配置。
 */

import {
  Alert,
  Button,
  Divider,
  Drawer,
  List,
  Space,
  Spin,
  Tag,
  Typography,
  message,
} from "antd";
import { BulbOutlined, CheckOutlined, SaveOutlined } from "@ant-design/icons";
import { SUGGESTION_GROUP, useAssistantStore } from "../stores/assistantStore";
import { useGenerationStore } from "../stores/generationStore";
import { useTemplateStore } from "../stores/templateStore";
import { useAIGenStore } from "../stores/aiStore";

const { Text, Paragraph } = Typography;

export default function AssistantDrawer() {
  const open = useAssistantStore((s) => s.open);
  const loading = useAssistantStore((s) => s.loading);
  const reply = useAssistantStore((s) => s.reply);
  const error = useAssistantStore((s) => s.error);
  const kind = useAssistantStore((s) => s.kind);
  const hide = useAssistantStore((s) => s.hide);
  const cancel = useAssistantStore((s) => s.cancel);
  const setPrompt = useGenerationStore((s) => s.setPrompt);
  const saveTemplate = useTemplateStore((s) => s.save);
  const openConfig = useAIGenStore((s) => s.openConfig);

  const applyDraft = () => {
    if (!kind || !reply?.rewritten) return;
    // 唯一副作用：改本地草稿。不落盘、不发起生成
    setPrompt(kind, reply.rewritten);
    message.success("已填入提示词草稿（未发起生成）");
  };

  const saveAsTemplate = async () => {
    if (!kind || !reply?.rewritten) return;
    try {
      await saveTemplate({
        name: `助手建议·${kind}`,
        kind,
        body: reply.rewritten,
      });
      message.success("已存为你的模板，可在模板库管理");
    } catch (e) {
      const err = e as { message?: string };
      message.error(err.message ?? String(e));
    }
  };

  return (
    <Drawer
      title={
        <Space>
          <BulbOutlined />
          生成助手
        </Space>
      }
      placement="right"
      size={480}
      open={open}
      onClose={hide}
      extra={
        loading ? (
          <Button size="small" danger onClick={cancel}>
            取消
          </Button>
        ) : undefined
      }
    >
      {loading && (
        <Space direction="vertical" align="center" style={{ width: "100%", padding: 32 }}>
          <Spin />
          <Text type="secondary" style={{ fontSize: 12 }}>
            正在向上游要建议（这一次会计入 1 次模型调用）
          </Text>
        </Space>
      )}

      {error && (
        <Alert
          type="error"
          showIcon
          message={`${error.code}：${error.message}`}
          action={
            error.code === "NO_CONFIG" ? (
              <Button size="small" onClick={openConfig}>
                去配置
              </Button>
            ) : undefined
          }
        />
      )}

      {reply && !loading && (
        <Space direction="vertical" style={{ width: "100%" }} size="middle">
          {reply.heuristic_only && (
            <Alert
              type="info"
              showIcon
              message="上游没有参与这次建议"
              description="以下建议来自本地规则（不消耗额度）；配好服务商后可以拿到更有针对性的改写。"
            />
          )}

          {reply.rewritten && (
            <div
              style={{
                border: "1px dashed rgba(0,0,0,0.15)",
                borderRadius: 8,
                padding: 12,
                background: "rgba(0,0,0,0.02)",
              }}
            >
              <Text strong>改写建议</Text>
              <Paragraph style={{ marginTop: 8, marginBottom: 8, whiteSpace: "pre-wrap" }}>
                {reply.rewritten}
              </Paragraph>
              <Space>
                <Button type="primary" size="small" icon={<CheckOutlined />} onClick={applyDraft}>
                  填入提示词
                </Button>
                <Button size="small" icon={<SaveOutlined />} onClick={() => void saveAsTemplate()}>
                  存为我的模板
                </Button>
              </Space>
            </div>
          )}

          <Divider style={{ margin: "4px 0" }} />
          <List
            size="small"
            header={<Text strong>建议清单</Text>}
            dataSource={reply.suggestions}
            locale={{ emptyText: "这次没有给出建议" }}
            renderItem={(item) => {
              const group = SUGGESTION_GROUP[item.kind] ?? { label: item.kind, color: "default" };
              return (
                <List.Item>
                  <Space direction="vertical" size={2} style={{ width: "100%" }}>
                    <Space size={4}>
                      <Tag color={group.color}>{group.label}</Tag>
                      <Text strong>{item.title}</Text>
                    </Space>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {item.detail}
                    </Text>
                  </Space>
                </List.Item>
              );
            }}
          />
          {reply.usage && (
            <Text type="secondary" style={{ fontSize: 12 }}>
              本次助手调用消耗 {reply.usage.prompt_tokens} + {reply.usage.completion_tokens} tokens
            </Text>
          )}
          <Text type="secondary" style={{ fontSize: 12 }}>
            助手只提建议：不会改配置、不会写文件、也不会替你点生成。
          </Text>
        </Space>
      )}
    </Drawer>
  );
}
