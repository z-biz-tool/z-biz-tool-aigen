import { useEffect, useMemo, useState } from "react";
import {
  Card,
  Input,
  Button,
  Space,
  Select,
  Typography,
  InputNumber,
  message,
  Tag,
  Tooltip,
} from "antd";
import {
  EditOutlined,
  CopyOutlined,
  FileTextOutlined,
  CloseCircleOutlined,
  AppstoreOutlined,
  DownloadOutlined,
} from "@ant-design/icons";
import { EmptyState, LoadingState, ErrorState } from "../_shared";
import { EXPORT_FILTERS, exportResult, stamp } from "../_shared/export";
import { useTask, usePrompt } from "../stores/generationStore";
import { useAIGenStore, useModelOptions } from "../stores/aiStore";
import {
  isBodyVariable,
  useTemplateStore,
  type PromptTemplate,
} from "../stores/templateStore";
import TemplateManager from "./TemplateManager";

const { TextArea } = Input;
const { Text, Paragraph } = Typography;

export default function TextGenPanel() {
  const [input, setInput] = usePrompt("text");
  const [model, setModel] = useState("gpt-4o-mini");
  const [system, setSystem] = useState("");
  const [temperature, setTemperature] = useState(0.7);
  const [maxTokens, setMaxTokens] = useState<number | null>(1024);
  const { loading, result, error, partial, submit, cancel } = useTask("text");
  const openConfig = useAIGenStore((s) => s.openConfig);
  // 服务商声明了模型就用它的，避免"选 OpenAI 模型打 MiniMax 端点"（B4）
  const { options: providerModels, providerName } = useModelOptions("text");
  const modelOptions = providerModels ?? [
    { value: "gpt-4o-mini", label: "GPT-4o Mini (经济)" },
    { value: "gpt-4o", label: "GPT-4o (智能)" },
  ];

  const templates = useTemplateStore((s) => s.items);
  const loadTemplates = useTemplateStore((s) => s.load);
  const selectedId = useTemplateStore((s) => s.selected.text);
  const selectTemplate = useTemplateStore((s) => s.select);
  const varValues = useTemplateStore((s) => s.values);
  const setVarValue = useTemplateStore((s) => s.setValue);
  const renderTemplate = useTemplateStore((s) => s.render);
  const [managing, setManaging] = useState(false);

  useEffect(() => {
    void loadTemplates("text");
  }, [loadTemplates]);

  useEffect(() => {
    if (providerModels && !providerModels.some((m) => m.value === model)) {
      setModel(providerModels[0].value);
    }
  }, [providerModels, model]);

  const template: PromptTemplate | undefined = useMemo(
    () => templates.find((t) => t.id === selectedId),
    [templates, selectedId]
  );
  /** 命中"正文/内容"的插槽直接吃大输入框，其余插槽单独填 */
  const bodyVar = template?.variables.find(isBodyVariable);
  const extraVars = (template?.variables ?? []).filter((v) => v !== bodyVar);
  const text = (result as string | null) ?? "";

  const handleGenerate = async () => {
    let prompt = input;
    if (template) {
      const values: Record<string, string> = { ...(varValues[template.id] ?? {}) };
      if (bodyVar) values[bodyVar] = input;
      try {
        const rendered = await renderTemplate(template.id, values);
        if (rendered.missing.length) {
          message.warning(`还有变量没填：${rendered.missing.join("、")}`);
          return;
        }
        prompt = rendered.text;
      } catch (e) {
        const err = e as { code?: string; message?: string };
        message.error(`${err.code ?? "ERROR"}：${err.message ?? String(e)}`);
        return;
      }
    }
    if (!prompt.trim()) {
      message.warning("请输入内容");
      return;
    }
    void submit("text", {
      prompt,
      model,
      params: {
        stream: true,
        system: system.trim() || null,
        temperature,
        maxTokens,
      },
    });
  };

  const handleCopy = () => {
    if (text) {
      navigator.clipboard.writeText(text);
      message.success("已复制到剪贴板");
    }
  };

  const renderResult = () => {
    if (loading && partial) {
      // 流式：边到边显示已到达的片段，未完成也可随时取消
      return (
        <div style={{ width: "100%" }}>
          <Paragraph
            style={{
              whiteSpace: "pre-wrap",
              lineHeight: 1.8,
              fontSize: 15,
              padding: 20,
              background: "#fafafa",
              borderRadius: 8,
              minHeight: 120,
            }}
          >
            {partial}
            <span style={{ opacity: 0.5 }}>▌</span>
          </Paragraph>
          <Space style={{ marginTop: 12 }}>
            <Tag color="processing">流式生成中</Tag>
            <Button danger icon={<CloseCircleOutlined />} onClick={cancel}>
              取消生成
            </Button>
          </Space>
        </div>
      );
    }
    if (loading) return <LoadingState tip="AI 正在创作中..." onCancel={cancel} />;
    if (error) return <ErrorState error={error} onRetry={() => void handleGenerate()} onOpenConfig={openConfig} />;
    if (!text)
      return (
        <EmptyState
          title="开始你的 AI 写作之旅"
          description="选个模板（可留空）并输入内容后点击生成"
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
        {text}
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
            <Space style={{ width: "100%", justifyContent: "space-between" }}>
              <Text strong>📝 提示词模板</Text>
              <Button size="small" icon={<AppstoreOutlined />} onClick={() => setManaging(true)}>
                管理模板库
              </Button>
            </Space>
            <Space style={{ width: "100%", marginTop: 8 }} wrap>
              <Select
                allowClear
                placeholder="不使用模板"
                value={selectedId}
                onChange={(v) => selectTemplate("text", v)}
                style={{ minWidth: 240 }}
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

          <div>
            <Text strong style={{ display: "block", marginBottom: 8 }}>
              🤖 AI 模型{providerName ? `（来自 ${providerName}）` : ""}
            </Text>
            <Space wrap size="middle">
              <Select
                value={model}
                onChange={setModel}
                style={{ width: 240 }}
                options={modelOptions}
                size="large"
              />
              <Tooltip title="取值 0–2，越大越发散">
                <InputNumber
                  min={0}
                  max={2}
                  step={0.1}
                  value={temperature}
                  onChange={(v) => setTemperature(v ?? 0.7)}
                  addonBefore="温度"
                  size="large"
                  style={{ width: 150 }}
                />
              </Tooltip>
              <InputNumber
                min={1}
                max={8000}
                step={128}
                value={maxTokens}
                onChange={(v) => setMaxTokens(v ?? null)}
                addonBefore="最大字数"
                size="large"
                style={{ width: 180 }}
              />
            </Space>
            {!providerModels && (
              <div style={{ marginTop: 6, fontSize: 12, color: "#9ca3af" }}>
                未从服务商拉取模型清单，生成时若模型不属于当前服务商会被拒绝
              </div>
            )}
          </div>

          <div>
            <Text strong style={{ display: "block", marginBottom: 8 }}>
              🧭 系统提示（可选）
            </Text>
            <Input
              value={system}
              onChange={(e) => setSystem(e.target.value)}
              placeholder="例如：你是一位严谨的技术写手，中文输出，不使用夸张修辞"
              size="large"
              maxLength={4000}
            />
          </div>

          <div>
            <Text strong style={{ display: "block", marginBottom: 8 }}>
              ✍️ {bodyVar ? `{${bodyVar}}` : "输入内容"}
            </Text>
            <TextArea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={
                template
                  ? `填入模板的「${bodyVar ?? "剩余"}」部分`
                  : "直接输入完整提示词..."
              }
              rows={6}
              style={{
                marginTop: 8,
                borderRadius: 8,
                border: "1px solid #e5e7eb",
                resize: "vertical",
              }}
            />
            {template && (
              <div style={{ marginTop: 8, fontSize: 12, color: "#9ca3af" }}>
                模板预览：{template.body.length > 120 ? `${template.body.slice(0, 120)}…` : template.body}
              </div>
            )}
          </div>

          {loading ? (
            <Button danger icon={<CloseCircleOutlined />} onClick={cancel} size="large" style={{ height: 44, borderRadius: 8, fontSize: 16 }}>
              取消生成
            </Button>
          ) : (
            <Button
              type="primary"
              icon={<EditOutlined />}
              onClick={() => void handleGenerate()}
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
          )}
        </Space>
      </Card>

      <Card
        title={<span>📄 生成结果</span>}
        style={{ marginTop: 24, borderRadius: 16, boxShadow: "0 4px 12px rgba(0,0,0,0.06)" }}
        extra={
          text && !loading ? (
            <Space>
              <Tag color="blue" icon={<FileTextOutlined />}>
                AI 生成
              </Tag>
              <Button icon={<CopyOutlined />} onClick={handleCopy}>
                复制全文
              </Button>
              <Button
                type="primary"
                ghost
                icon={<DownloadOutlined />}
                onClick={() =>
                  void exportResult({
                    defaultName: `aigen-${stamp()}.md`,
                    filters: EXPORT_FILTERS.text,
                    text,
                  })
                }
              >
                导出
              </Button>
            </Space>
          ) : undefined
        }
      >
        {renderResult()}
      </Card>

      <TemplateManager open={managing} onClose={() => setManaging(false)} kind="text" />
    </div>
  );
}
