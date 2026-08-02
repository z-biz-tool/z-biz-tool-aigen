import { useState } from "react";
import {
  Card,
  Input,
  Button,
  Space,
  Select,
  Typography,
  message,
  Spin,
  Empty,
  Divider,
  Tag,
  List,
  InputNumber,
} from "antd";
import { EditOutlined, CopyOutlined, SettingOutlined } from "@ant-design/icons";
import { useAiStore } from "../stores/aiStore";

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

export default function TextGenPanel() {
  const [writeType, setWriteType] = useState("article");
  const [input, setInput] = useState("");
  const [result, setResult] = useState("");
  const [model, setModel] = useState("gpt-4o-mini");
  const [showConfig, setShowConfig] = useState(false);
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");

  const { generateText, textLoading, baseUrl: storedBaseUrl, apiKey: storedApiKey, saveConfig } =
    useAiStore();

  const handleGenerate = async () => {
    const fullPrompt = (promptTemplates[writeType] || "") + input;
    if (!fullPrompt.trim()) {
      message.warning("请输入内容");
      return;
    }
    try {
      const content = await generateText(fullPrompt, model);
      setResult(content);
      message.success("文本生成成功");
    } catch (e: any) {
      message.error(`生成失败: ${e}`);
    }
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(result);
    message.success("已复制到剪贴板");
  };

  const handleSaveConfig = async () => {
    try {
      await saveConfig(baseUrl, apiKey);
      message.success("配置已保存");
      setShowConfig(false);
    } catch (e: any) {
      message.error(`保存配置失败: ${e}`);
    }
  };

  const openConfig = () => {
    setBaseUrl(storedBaseUrl);
    setApiKey(storedApiKey);
    setShowConfig(true);
  };

  const models = [
    { value: "gpt-4o-mini", label: "GPT-4o Mini" },
    { value: "gpt-4o", label: "GPT-4o" },
    { value: "abab6.5s-chat", label: "MiniMax abab6.5s" },
    { value: "abab6.5-chat", label: "MiniMax abab6.5" },
  ];

  return (
    <div>
      <Card
        title="AI文本写作"
        extra={
          <Button icon={<SettingOutlined />} onClick={openConfig}>API配置</Button>
        }
      >
        <Space direction="vertical" style={{ width: "100%" }} size="middle">
          {/* 写作类型选择 */}
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

          {/* 模型选择 */}
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

          {/* 输入区域 */}
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
            loading={textLoading}
            onClick={handleGenerate}
            size="large"
          >
            生成文本
          </Button>
        </Space>
      </Card>

      {showConfig && (
        <Card title="API配置" style={{ marginTop: 16 }}>
          <Space direction="vertical" style={{ width: "100%" }} size="middle">
            <div>
              <Text strong>Base URL</Text>
              <Input
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="https://api.minimax.chat/v1"
                style={{ marginTop: 8 }}
              />
            </div>
            <div>
              <Text strong>API Key</Text>
              <Input.Password
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="输入你的API密钥"
                style={{ marginTop: 8 }}
              />
            </div>
            <Space>
              <Button type="primary" onClick={handleSaveConfig}>保存配置</Button>
              <Button onClick={() => setShowConfig(false)}>取消</Button>
            </Space>
          </Space>
        </Card>
      )}

      <Card
        title="生成结果"
        style={{ marginTop: 16 }}
        extra={
          result && (
            <Button icon={<CopyOutlined />} onClick={handleCopy}>复制</Button>
          )
        }
      >
        {textLoading && !result ? (
          <div style={{ textAlign: "center", padding: "60px" }}>
            <Spin size="large" tip="正在生成文本..." />
          </div>
        ) : result ? (
          <Paragraph style={{ whiteSpace: "pre-wrap", lineHeight: 1.8 }}>
            {result}
          </Paragraph>
        ) : (
          <Empty description="输入内容开始AI写作" />
        )}
      </Card>

      <Divider />
      <Paragraph type="secondary" style={{ fontSize: 12 }}>
        支持OpenAI兼容格式的文本生成API，可选择不同模型进行写作。
      </Paragraph>
    </div>
  );
}
