import { useState } from "react";
import { Card, Input, Button, Space, Select, Typography, message } from "antd";
import { EditOutlined, CopyOutlined } from "@ant-design/icons";
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
  article: "请写一篇关于以下主题的文章，要求结构清晰、内容丰富，字数约800字：\n\n",
  copywriting: "请为以下产品/服务撰写营销文案，要求吸引眼球、突出卖点：\n\n",
  summary: "请将以下内容总结为简洁的摘要，保留核心要点：\n\n",
  translate: "请将以下内容翻译为英文并润色：\n\n",
  custom: "",
};

const models = [
  { value: "gpt-4o-mini", label: "GPT-4o Mini" },
  { value: "gpt-4o", label: "GPT-4o" },
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
    if (loading) return <LoadingState tip="AI创作中..." />;
    if (error) return <ErrorState message={error} onRetry={handleGenerate} />;
    if (!result)
      return (
        <EmptyState title="输入提示词开始生成" description="选择写作类型并输入内容后点击生成" />
      );
    return <Paragraph style={{ whiteSpace: "pre-wrap", lineHeight: 1.8 }}>{result}</Paragraph>;
  };

  return (
    <div>
      <Card title="AI文本写作">
        <Space direction="vertical" style={{ width: "100%" }} size="middle">
          <div>
            <Text strong>写作类型</Text>
            <div style={{ marginTop: 8 }}>
              <Select
                value={writeType}
                onChange={setWriteType}
                style={{ width: "100%" }}
                options={writeTypes}
              />
            </div>
          </div>
          <div>
            <Text strong>AI模型</Text>
            <div style={{ marginTop: 8 }}>
              <Select
                value={model}
                onChange={setModel}
                style={{ width: "100%" }}
                options={models}
              />
            </div>
          </div>
          <div>
            <Text strong>输入内容</Text>
            <TextArea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="输入你的写作需求..."
              rows={6}
              style={{ marginTop: 8 }}
            />
          </div>
          <Button
            type="primary"
            icon={<EditOutlined />}
            loading={loading}
            onClick={handleGenerate}
            size="large"
          >
            生成文本
          </Button>
        </Space>
      </Card>

      <Card
        title="生成结果"
        style={{ marginTop: 16 }}
        extra={
          result && !loading ? (
            <Button icon={<CopyOutlined />} onClick={handleCopy}>
              复制
            </Button>
          ) : undefined
        }
      >
        {renderResult()}
      </Card>
    </div>
  );
}
