import { useEffect, useState } from "react";
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
  Tag,
} from "antd";
import { ThunderboltOutlined, DownloadOutlined, CopyOutlined, PictureOutlined, CloseCircleOutlined, AppstoreOutlined, FileImageOutlined, CloseOutlined } from "@ant-design/icons";
import { EmptyState, LoadingState, ErrorState } from "../_shared";
import { exportResult, EXPORT_FILTERS, stamp } from "../_shared/export";
import { useTask, usePrompt } from "../stores/generationStore";
import { useAIGenStore, useModelOptions } from "../stores/aiStore";
import { isBodyVariable, useTemplateStore } from "../stores/templateStore";
import TemplateManager from "./TemplateManager";
import { referenceErrorText, useReferenceStore } from "../stores/referenceStore";

const { TextArea } = Input;
const { Text } = Typography;

// 渐变色定义
const brandGradient = "linear-gradient(135deg, #667eea 0%, #764ba2 100%)";
const cardBgGradient = "linear-gradient(135deg, rgba(102,126,234,0.04) 0%, rgba(118,75,162,0.04) 100%)";

const models = [
  { value: "dall-e-3", label: "DALL-E 3 (最新)" },
  { value: "dall-e-2", label: "DALL-E 2" },
  { value: "stable-diffusion-xl", label: "Stable Diffusion XL" },
  { value: "sd-turbo", label: "SD Turbo (快速)" },
];

const sizes = [
  { value: "1024x1024", label: "1024 x 1024（正方形）" },
  { value: "1792x1024", label: "1792 x 1024（横图）" },
  { value: "1024x1792", label: "1024 x 1792（竖图）" },
  { value: "512x512", label: "512 x 512（小图）" },
];

export default function ImageGenPanel() {
  const [prompt, setPrompt] = usePrompt("image");
  const [count, setCount] = useState(1);
  const [model, setModel] = useState("dall-e-3");
  const [size, setSize] = useState("1024x1024");
  const [negative, setNegative] = useState("");
  const [managing, setManaging] = useState(false);
  const refImage = useReferenceStore((s) => s.image);
  const refLabel = useReferenceStore((s) => s.label);
  const refBusy = useReferenceStore((s) => s.busy);
  const pickRef = useReferenceStore((s) => s.pick);
  const clearRef = useReferenceStore((s) => s.clear);
  const { loading, result, error, submit, cancel } = useTask("image");
  const openConfig = useAIGenStore((s) => s.openConfig);
  const { options: providerModels, providerName } = useModelOptions("image");
  const modelOptions = providerModels ?? models;
  const images = (result as string[] | null) ?? [];

  // 02 §1.2：图片风格预设走模板库（内置 3 条 + 用户自建），变量插槽单独填
  const templates = useTemplateStore((s) => s.items);
  const loadTemplates = useTemplateStore((s) => s.load);
  const selectedId = useTemplateStore((s) => s.selected.image);
  const selectTemplate = useTemplateStore((s) => s.select);
  const varValues = useTemplateStore((s) => s.values);
  const setVarValue = useTemplateStore((s) => s.setValue);
  const renderSelected = useTemplateStore((s) => s.renderSelected);

  useEffect(() => {
    void loadTemplates("image");
  }, [loadTemplates]);

  const template = templates.find((t) => t.id === selectedId);
  const bodyVar = template?.variables.find(isBodyVariable);
  const extraVars = (template?.variables ?? []).filter((v) => v !== bodyVar);

  useEffect(() => {
    if (providerModels && !providerModels.some((m) => m.value === model)) {
      setModel(providerModels[0].value);
    }
  }, [providerModels, model]);

  const handleGenerate = async () => {
    let full = prompt;
    if (template) {
      try {
        const rendered = await renderSelected("image", prompt);
        if (rendered && rendered.missing.length) {
          message.warning(`还有变量没填：${rendered.missing.join("、")}`);
          return;
        }
        if (rendered) full = rendered.text;
      } catch (e) {
        const err = e as { code?: string; message?: string };
        message.error(`${err.code ?? "ERROR"}：${err.message ?? String(e)}`);
        return;
      }
    }
    if (!full.trim()) {
      message.warning("请输入提示词");
      return;
    }
    void submit("image", {
      prompt: full,
      model,
      params: {
        count,
        size,
        negativePrompt: negative.trim() || null,
        referenceImage: refImage?.dataUrl ?? null,
      },
    });
  };

  // H2：不再依赖 `<a download>` 在 webview 里的不确定行为，改走 dialog + Rust 落盘
  const handleExport = (url: string, idx: number) =>
    void exportResult({
      defaultName: `aigen-image-${stamp()}-${idx + 1}.png`,
      filters: EXPORT_FILTERS.image,
      text: url,
    });

  const handleCopyUrl = (url: string) => {
    navigator.clipboard.writeText(url);
    message.success("已复制图片 URL");
  };

  const renderResult = () => {
    if (loading) return <LoadingState tip="AI 正在绘制中..." onCancel={cancel} />;
    if (error) return <ErrorState error={error} onRetry={handleGenerate} onOpenConfig={openConfig} />;
    if (!images.length)
      return (
        <EmptyState
          title="准备创作你的第一张 AI 图片"
          description="在上方输入描述，AI 将为你生成精美图像"
        />
      );
    return (
      <Row gutter={[20, 20]}>
        {images.map((url, idx) => (
          <Col key={idx} xs={24} sm={12} md={8} lg={6}>
            <Card
              hoverable
              style={{ borderRadius: 12, overflow: "hidden" }}
              cover={
                <img
                  src={url}
                  alt={`生成图片 ${idx + 1}`}
                  style={{ width: "100%", height: 200, objectFit: "cover" }}
                />
              }
              actions={[
                <Button key="download" type="primary" icon={<DownloadOutlined />} onClick={() => void handleExport(url, idx)} />,
                <Button key="copy" icon={<CopyOutlined />} onClick={() => handleCopyUrl(url)} />,
              ]}
            >
              <Card.Meta
                description={
                  <Space direction="vertical" style={{ width: "100%" }} size={4}>
                    <Tag color="purple" icon={<PictureOutlined />}>
                      {modelOptions.find((m) => m.value === model)?.label ?? model}
                    </Tag>
                    <Tag color="blue">{sizes.find(s => s.value === size)?.label.split("（")[0]}</Tag>
                  </Space>
                }
              />
            </Card>
          </Col>
        ))}
      </Row>
    );
  };

  return (
    <div style={{ maxWidth: 900, margin: "0 auto" }}>
      <Card
        title={
          <Space>
            <PictureOutlined style={{ color: "#667eea", fontSize: 18 }} />
            <span style={{ fontWeight: 600, background: brandGradient, WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>AI 图片生成</span>
          </Space>
        }
        style={{ 
          borderRadius: 20, 
          boxShadow: "0 8px 24px rgba(102,126,234,0.15)",
          background: cardBgGradient
        }}
      >
        <Space direction="vertical" style={{ width: "100%" }} size="large">
          <div style={{ padding: '4px' }}>
            <Text strong style={{ display: "block", marginBottom: 10, color: "#1a1a2e", fontWeight: 600 }}>
              🎨 提示词
            </Text>
            <TextArea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="描述你想要生成的图片，例如：一只可爱的橘猫坐在窗台上，阳光温暖，水彩画风格"
              rows={5}
              style={{
                marginTop: 8,
                borderRadius: 12,
                border: "1px solid rgba(102,126,234,0.2)",
                resize: "vertical",
                transition: "all 0.2s cubic-bezier(0.4, 0, 0.2, 1)",
                background: '#ffffff'
              }}
              onFocus={(e) => {
                e.currentTarget.style.boxShadow = '0 2px 8px rgba(102,126,234,0.15)';
                e.currentTarget.style.border = "1px solid rgba(102,126,234,0.4)";
              }}
              onBlur={(e) => {
                e.currentTarget.style.boxShadow = 'none';
                e.currentTarget.style.border = "1px solid rgba(102,126,234,0.2)";
              }}
            />
            <div style={{ marginTop: 10, fontSize: 13, color: "#666666", background: "rgba(102,126,234,0.04)", padding: '8px 12px', borderRadius: 8 }}>
              💡 提示：越详细的描述，生成的图片越精美
            </div>
          </div>
          <div>
            <Space style={{ width: "100%", justifyContent: "space-between" }}>
              <Text style={{ fontWeight: 500, color: "#4b5563" }}>风格预设（模板库）：</Text>
              <Button size="small" type="link" icon={<AppstoreOutlined />} onClick={() => setManaging(true)}>
                管理模板库
              </Button>
            </Space>
            <Space wrap style={{ marginTop: 6 }}>
              <Select
                allowClear
                placeholder="不用预设"
                value={selectedId}
                onChange={(v) => selectTemplate("image", v)}
                style={{ width: 220 }}
                size="large"
                options={templates.map((t) => ({
                  value: t.id,
                  label: `${t.favorite ? "★ " : ""}${t.name}${t.builtin ? "" : "（我的）"}`,
                }))}
              />
              {extraVars.map((v) => (
                <Input
                  key={v}
                  size="large"
                  addonBefore={`{${v}}`}
                  style={{ width: 220 }}
                  value={varValues[template?.id ?? ""]?.[v] ?? ""}
                  onChange={(e) => template && setVarValue(template.id, v, e.target.value)}
                />
              ))}
            </Space>
          </div>

          <Space wrap style={{ padding: '4px' }}>
            <div>
              <Text style={{ marginRight: 10, fontWeight: 500, color: "#4b5563" }}>
                模型{providerName ? `（${providerName}）` : ""}：
              </Text>
              <Select
                value={model}
                onChange={setModel}
                options={modelOptions}
                style={{ width: 200, borderRadius: 10 }}
                size="large"
                dropdownStyle={{ borderRadius: 10 }}
              />
            </div>
            <div>
              <Text style={{ marginRight: 10, fontWeight: 500, color: "#4b5563" }}>尺寸：</Text>
              <Select
                value={size}
                onChange={setSize}
                options={sizes}
                style={{ width: 200, borderRadius: 10 }}
                size="large"
                dropdownStyle={{ borderRadius: 10 }}
              />
            </div>
            <div>
              <Text style={{ marginRight: 10, fontWeight: 500, color: "#4b5563" }}>数量：</Text>
              <InputNumber
                min={1}
                max={10}
                value={count}
                onChange={(v) => setCount(v || 1)}
                style={{ width: 100, borderRadius: 10 }}
                size="large"
              />
            </div>
            <div style={{ width: "100%", marginTop: 4 }}>
              <Text style={{ marginRight: 10, fontWeight: 500, color: "#4b5563" }}>参考图：</Text>
              {refImage ? (
                <Tag
                  color="blue"
                  closable
                  onClose={clearRef}
                  closeIcon={<CloseOutlined />}
                  style={{ height: 40, lineHeight: "38px" }}
                >
                  <FileImageOutlined /> {refLabel}
                </Tag>
              ) : (
                <Button
                  size="large"
                  icon={<FileImageOutlined />}
                  loading={refBusy}
                  onClick={() =>
                    void pickRef().catch((e) => message.error(referenceErrorText(e)))
                  }
                >
                  选本地图片（PNG/JPEG/WEBP/GIF，≤8MB）
                </Button>
              )}
            </div>
            <div style={{ width: "100%", marginTop: 4 }}>
              <Text style={{ marginRight: 10, fontWeight: 500, color: "#4b5563" }}>负面提示词：</Text>
              <Input
                value={negative}
                onChange={(e) => setNegative(e.target.value)}
                placeholder="只想在支持的服务商上生效，例如：模糊、水印、多余的手指（留空则不下发）"
                maxLength={1000}
                allowClear
                style={{ width: 520 }}
                size="large"
              />
            </div>
            {loading ? (
              <Button
                danger
                size="large"
                icon={<CloseCircleOutlined />}
                onClick={cancel}
                style={{ minWidth: 160, height: 44, borderRadius: 12, fontWeight: 600 }}
              >
                取消生成
              </Button>
            ) : (
              <Button
                type="primary"
                size="large"
                icon={<ThunderboltOutlined />}
                onClick={() => void handleGenerate()}
                style={{
                  background: brandGradient,
                  border: "none",
                  minWidth: 160,
                  height: 44,
                  borderRadius: 12,
                  fontWeight: 600,
                  boxShadow: "0 4px 12px rgba(102,126,234,0.3)",
                  transition: "all 0.2s cubic-bezier(0.4, 0, 0.2, 1)"
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLElement).style.transform = "scale(1.05)";
                  (e.currentTarget as HTMLElement).style.boxShadow = "0 8px 24px rgba(102,126,234,0.4)";
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLElement).style.transform = "scale(1)";
                  (e.currentTarget as HTMLElement).style.boxShadow = "0 4px 12px rgba(102,126,234,0.3)";
                }}
              >
                生成图片
              </Button>
            )}
          </Space>
        </Space>
      </Card>

      <Card
        title={
          <Space>
            <span style={{ fontSize: 16 }}>🖼️</span>
            <span style={{ fontWeight: 600, color: "#1a1a2e" }}>生成结果</span>
          </Space>
        }
        style={{ 
          marginTop: 24, 
          borderRadius: 20, 
          boxShadow: "0 8px 24px rgba(102,126,234,0.15)",
          background: cardBgGradient
        }}
      >
        {renderResult()}
      </Card>

      <TemplateManager open={managing} onClose={() => setManaging(false)} kind="image" />
    </div>
  );
}
