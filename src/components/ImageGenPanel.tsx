import { useState } from "react";
import {
  Card,
  Input,
  Button,
  Row,
  Col,
  Space,
  Select,
  InputNumber,
  Typography,
  message,
} from "antd";
import { ThunderboltOutlined, DownloadOutlined, CopyOutlined } from "@ant-design/icons";
import { useGeneration, EmptyState, LoadingState, ErrorState } from "../_shared";

const { TextArea } = Input;
const { Text } = Typography;

const models = [
  { value: "dall-e-3", label: "DALL-E 3" },
  { value: "dall-e-2", label: "DALL-E 2" },
  { value: "stable-diffusion-xl", label: "Stable Diffusion XL" },
  { value: "sd-turbo", label: "SD Turbo" },
];

const sizes = [
  { value: "1024x1024", label: "1024 x 1024（正方形）" },
  { value: "1792x1024", label: "1792 x 1024（横图）" },
  { value: "1024x1792", label: "1024 x 1792（竖图）" },
  { value: "512x512", label: "512 x 512（小图）" },
];

export default function ImageGenPanel() {
  const [prompt, setPrompt] = useState("");
  const [count, setCount] = useState(1);
  const [model, setModel] = useState("dall-e-3");
  const [size, setSize] = useState("1024x1024");
  const { loading, result, error, generate } = useGeneration<string[]>();

  const handleGenerate = () => {
    if (!prompt.trim()) {
      message.warning("请输入提示词");
      return;
    }
    void generate("generate_image", { prompt, count, model, size });
  };

  const handleDownload = (url: string) => {
    const a = document.createElement("a");
    a.href = url;
    a.download = `image-${Date.now()}.png`;
    a.target = "_blank";
    a.click();
  };

  const handleCopyUrl = (url: string) => {
    navigator.clipboard.writeText(url);
    message.success("已复制图片URL");
  };

  const renderResult = () => {
    if (loading) return <LoadingState tip="AI创作中..." />;
    if (error) return <ErrorState message={error} onRetry={handleGenerate} />;
    if (!result || result.length === 0)
      return <EmptyState title="输入提示词开始生成" description="填写提示词与参数后点击生成" />;
    return (
      <Row gutter={[16, 16]}>
        {result.map((url, idx) => (
          <Col key={idx} xs={24} sm={12} md={8} lg={6}>
            <Card
              size="small"
              cover={
                <img
                  src={url}
                  alt={`生成图片 ${idx + 1}`}
                  style={{ width: "100%", objectFit: "cover", borderRadius: 4 }}
                />
              }
              actions={[
                <DownloadOutlined key="download" onClick={() => handleDownload(url)} />,
                <CopyOutlined key="copy" onClick={() => handleCopyUrl(url)} />,
              ]}
            />
          </Col>
        ))}
      </Row>
    );
  };

  return (
    <div>
      <Card title="AI图片生成">
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
          <Space wrap>
            <div>
              <Text style={{ marginRight: 8 }}>模型：</Text>
              <Select value={model} onChange={setModel} options={models} style={{ width: 180 }} />
            </div>
            <div>
              <Text style={{ marginRight: 8 }}>尺寸：</Text>
              <Select value={size} onChange={setSize} options={sizes} style={{ width: 200 }} />
            </div>
            <div>
              <Text style={{ marginRight: 8 }}>数量：</Text>
              <InputNumber min={1} max={10} value={count} onChange={(v) => setCount(v || 1)} />
            </div>
            <Button
              type="primary"
              icon={<ThunderboltOutlined />}
              loading={loading}
              onClick={handleGenerate}
              size="large"
            >
              生成图片
            </Button>
          </Space>
        </Space>
      </Card>

      <Card title="生成结果" style={{ marginTop: 16 }}>
        {renderResult()}
      </Card>
    </div>
  );
}
