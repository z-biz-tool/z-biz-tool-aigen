import { useState } from "react";
import { Card, Input, Button, Space, Select, Typography, message, Tag } from "antd";
import { EditOutlined, CopyOutlined, FileTextOutlined } from "@ant-design/icons";
import { useGeneration, EmptyState, LoadingState, ErrorState } from "../_shared";

const { TextArea } = Input;
const { Text, Paragraph } = Typography;

const writeTypes = [
  { value: "article", label: "文章写作" },
  { value: "copywriting", label: "营销文案" },
  { value: "summary", label: "内容摘要" },
  { value: "translate", label: "翻译润色" },
  { value: "custom", label: "自由写作" },
];

const promptTemplates: Record<string, string> = {
  article: "请写一篇关于以下主题的文章，要求结构清晰、内容丰富，字数约 800 字：\n\n",
  copywriting: "请为以下产品/服务撰写营销文案，要求吸引眼球、突出卖点：\n\n",
  summary: "请将以下内容总结为简洁的摘要，保留核心要点：\n\n",
  translate: "请将以下内容翻译为英文并润色：\n\n",
  custom: "",
};

const models = [
  { value: "gpt-4o-mini", label: "GPT-4o Mini (经济)" },
  { value: "gpt-4o", label: "GPT-4o (智能)" },
  { value: "abab6.5s-chat", label: "MiniMax abab6.5s" },
  { value: "abab6.5-chat", label: "MiniMax abab6.5" },
];

export default function TextGenPanel() {
  const [writeType, setWriteType] = useState("article");
  const [input, setInput] = useState("");
  const [model, setModel] = useState("gpt-4o-mini");
  const { loading, result, error, generate } = useGeneration<string>();

  const handleGenerate = () => {
    const fullPrompt = (promptTemplates[writeType] || "") + input;
    if (!fullPrompt.trim()) {
      message.warning("请输入内容");
      return;
    }
    void generate("generate_text", { prompt: fullPrompt, model });
  };

  const handleCopy = () => {
    if (result) {
      navigator.clipboard.writeText(result);
      message.success("已复制到剪贴板");
    }
  };

  const renderResult = () => {
    if (loading) return <LoadingState tip="AI 正在创作中..." />;
    if (error) return <ErrorState message={error} onRetry={handleGenerate} />;
    if (!result)
      return (
        <EmptyState
          title="开始你的 AI 写作之旅"
          description="选择写作类型并输入内容后点击生成"
        />
      );
    return (
      <Paragraph
        style={{
          whiteSpace: "pre-wrap",
          lineHeight: 1.8,
          fontSize: 15,
          padding: 20,
          background: "#fafafa",
          borderRadius: 8,
        }}
      >
        {result}
      </Paragraph>
    );
  };

  return (
    <div style={{ maxWidth: 900, margin: "0 auto" }}>
      <Card
        title={
          <Space>
            <EditOutlined style={{ color: "#667eea" }} />
            <span>AI 文本写作</span>
          </Space>
        }
        style={{ borderRadius: 16, boxShadow: "0 4px 12px rgba(0,0,0,0.06)" }}
      >
        <Space direction="vertical" style={{ width: "100%" }} size="large">
          <div>
            <Text strong style={{ display: "block", marginBottom: 8, color: "#1f2937" }}>
              📝 写作类型
            </Text>
            <div style={{ marginTop: 8 }}>
              <Select
                value={writeType}
                onChange={setWriteType}
                style={{ width: "100%" }}
                options={writeTypes}
                size="large"
              />
            </div>
          </div>
          <div>
            <Text strong style={{ display: "block", marginBottom: 8, color: "#1f2937" }}>
              🤖 AI 模型
            </Text>
            <div style={{ marginTop: 8 }}>
              <Select
                value={model}
                onChange={setModel}
                style={{ width: "100%" }}
                options={models}
                size="large"
              />
            </div>
          </div>
          <div>
            <Text strong style={{ display: "block", marginBottom: 8, color: "#1f2937" }}>
              ✍️ 输入内容
            </Text>
            <TextArea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="输入你的写作需求...（如主题、要点或原文）"
              rows={6}
              style={{
                marginTop: 8,
                borderRadius: 8,
                border: "1px solid #e5e7eb",
                resize: "vertical",
              }}
            />
            <div style={{ marginTop: 8, fontSize: 12, color: "#9ca3af" }}>
              💡 提示：根据选择的写作类型，AI 会自动应用相应的模板
            </div>
          </div>
          <Button
            type="primary"
            icon={<EditOutlined />}
            loading={loading}
            onClick={handleGenerate}
            size="large"
            style={{
              background: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
              border: "none",
              height: 44,
              borderRadius: 8,
              fontSize: 16,
            }}
          >
            生成文本
          </Button>
        </Space>
      </Card>

      <Card
        title={<span>📄 生成结果</span>}
        style={{ marginTop: 24, borderRadius: 16, boxShadow: "0 4px 12px rgba(0,0,0,0.06)" }}
        extra={
          result && !loading ? (
            <Space>
              <Tag color="blue" icon={<FileTextOutlined />}>AI 生成</Tag>
              <Button icon={<CopyOutlined />} onClick={handleCopy}>
                复制全文
              </Button>
            </Space>
          ) : undefined
        }
      >
        {renderResult()}
      </Card>
    </div>
  );
}
