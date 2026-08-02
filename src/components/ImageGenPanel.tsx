import { useState } from "react";
import {
  Card,
  Input,
  Button,
  Row,
  Col,
  Space,
  InputNumber,
  Typography,
  message,
  Empty,
  Spin,
  Divider,
  Tag,
} from "antd";
import {
  ThunderboltOutlined,
  DownloadOutlined,
  CopyOutlined,
  SettingOutlined,
} from "@ant-design/icons";
import { useAiStore } from "../stores/aiStore";

const { TextArea } = Input;
const { Text, Paragraph } = Typography;

export default function ImageGenPanel() {
  const [prompt, setPrompt] = useState("");
  const [count, setCount] = useState(1);
  const [results, setResults] = useState<string[]>([]);
  const [showConfig, setShowConfig] = useState(false);
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");

  const { generateImage, imageLoading, baseUrl: storedBaseUrl, apiKey: storedApiKey, saveConfig } =
    useAiStore();

  const handleGenerate = async () => {
    if (!prompt.trim()) {
      message.warning("请输入提示词");
      return;
    }
    try {
      const urls = await generateImage(prompt, count);
      setResults(urls);
      message.success(`成功生成 ${urls.length} 张图片`);
    } catch (e: any) {
      message.error(`生成失败: ${e}`);
    }
  };

  const handleDownload = async (url: string) => {
    try {
      // 通过浏览器打开图片URL（支持下载）
      const a = document.createElement("a");
      a.href = url;
      a.download = `image-${Date.now()}.png`;
      a.target = "_blank";
      a.click();
    } catch {
      message.error("下载失败");
    }
  };

  const handleCopyUrl = (url: string) => {
    navigator.clipboard.writeText(url);
    message.success("已复制图片URL");
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

  return (
    <div>
      <Card title="AI图片生成" extra={
        <Button icon={<SettingOutlined />} onClick={openConfig}>API配置</Button>
      }>
        <Space direction="vertical" style={{ width: "100%" }} size="middle">
          <div>
            <Text strong>提示词</Text>
            <TextArea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="描述你想要生成的图片，例如：一只可爱的橘猫坐在窗台上，阳光温暖，水彩画风格"
              rows={4}
              style={{ marginTop: 8 }}
            />
          </div>

          <Space>
            <Text>生成数量：</Text>
            <InputNumber min={1} max={10} value={count} onChange={(v) => setCount(v || 1)} />
            <Button
              type="primary"
              icon={<ThunderboltOutlined />}
              loading={imageLoading}
              onClick={handleGenerate}
              size="large"
            >
              生成图片
            </Button>
          </Space>
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

      <Card title="生成结果" style={{ marginTop: 16 }}>
        {imageLoading && results.length === 0 ? (
          <div style={{ textAlign: "center", padding: "60px" }}>
            <Spin size="large" tip="正在生成图片..." />
          </div>
        ) : results.length === 0 ? (
          <Empty description="还没有生成图片，输入提示词开始创作" />
        ) : (
          <Row gutter={[16, 16]}>
            {results.map((url, idx) => (
              <Col key={idx} xs={24} sm={12} md={8} lg={6}>
                <Card
                  size="small"
                  cover={<img src={url} alt={`生成图片 ${idx + 1}`} style={{ width: "100%", objectFit: "cover", borderRadius: 4 }} />}
                  actions={[
                    <DownloadOutlined key="download" onClick={() => handleDownload(url)} />,
                    <CopyOutlined key="copy" onClick={() => handleCopyUrl(url)} />,
                  ]}
                >
                  <Tag color="blue">#{idx + 1}</Tag>
                </Card>
              </Col>
            ))}
          </Row>
        )}
      </Card>

      <Divider />
      <Paragraph type="secondary" style={{ fontSize: 12 }}>
        支持OpenAI兼容格式的图片生成API，通过Base URL和API Key配置连接。
        图片尺寸默认1024x1024。
      </Paragraph>
    </div>
  );
}
