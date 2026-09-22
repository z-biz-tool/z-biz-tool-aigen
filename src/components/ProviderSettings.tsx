/**
 * 服务商与密钥配置（T-Provider / 03 §3，并补 02 §9 的连通性校验）。
 *
 * 密钥单向写入：表单里永远不回显既有 key，留空即不修改（04 §2.2）。
 */

import { useState } from "react";
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Empty,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Tag,
  Typography,
  message,
} from "antd";
import {
  ApiOutlined,
  DeleteOutlined,
  EditOutlined,
  PlusOutlined,
} from "@ant-design/icons";
import {
  providerFor,
  useAIGenStore,
  type GenKind,
  type PublicProvider,
} from "../stores/aiStore";

const { Text } = Typography;
const { TextArea } = Input;

const KINDS: { kind: GenKind; label: string }[] = [
  { kind: "text", label: "文本" },
  { kind: "image", label: "图片" },
  { kind: "video", label: "视频" },
  { kind: "ppt", label: "PPT" },
];

const KIND_LABEL: Record<GenKind, string> = {
  text: "文本",
  image: "图片",
  video: "视频",
  ppt: "PPT",
};

interface Draft {
  providerId?: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  capabilities: GenKind[];
  models: string;
}

const emptyDraft = (): Draft => ({
  name: "",
  baseUrl: "",
  apiKey: "",
  capabilities: ["text", "image"],
  models: "",
});

const toDraft = (p: PublicProvider): Draft => ({
  providerId: p.id,
  name: p.name,
  baseUrl: p.base_url,
  apiKey: "",
  capabilities: (p.capabilities.length ? p.capabilities : ["text", "image", "video", "ppt"]) as GenKind[],
  models: p.models.join("\n"),
});

export default function ProviderSettings() {
  const providers = useAIGenStore((s) => s.providers);
  const active = useAIGenStore((s) => s.active);
  const configOpen = useAIGenStore((s) => s.configOpen);
  const closeConfig = useAIGenStore((s) => s.closeConfig);
  const saveProvider = useAIGenStore((s) => s.saveProvider);
  const removeProvider = useAIGenStore((s) => s.removeProvider);
  const setActive = useAIGenStore((s) => s.setActive);
  const testProvider = useAIGenStore((s) => s.testProvider);

  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [discovered, setDiscovered] = useState<Record<string, string[]>>({});

  const handleSave = async () => {
    if (!draft) return;
    if (!draft.baseUrl.trim()) {
      message.warning("Base URL 不能为空");
      return;
    }
    setSaving(true);
    try {
      await saveProvider({
        providerId: draft.providerId,
        name: draft.name.trim() || undefined,
        baseUrl: draft.baseUrl,
        apiKey: draft.apiKey.trim() || undefined,
        capabilities: draft.capabilities,
        models: draft.models
          .split("\n")
          .map((m) => m.trim())
          .filter(Boolean),
      });
      message.success("已保存到本地加密存储");
      setDraft(null);
    } catch (e) {
      message.error(String((e as { message?: string })?.message ?? e));
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async (p: PublicProvider) => {
    setTesting(p.id);
    try {
      const models = await testProvider(p.id);
      setDiscovered((d) => ({ ...d, [p.id]: models }));
      message.success(`连通正常，上游返回 ${models.length} 个模型`);
    } catch (e) {
      const err = e as { code?: string; message?: string };
      message.error(`${err.code ?? "ERROR"}：${err.message ?? String(e)}`);
    } finally {
      setTesting(null);
    }
  };

  const importModels = async (p: PublicProvider, models: string[]) => {
    try {
      await saveProvider({
        providerId: p.id,
        name: p.name,
        baseUrl: p.base_url,
        capabilities: (p.capabilities.length ? p.capabilities : ["text", "image", "video", "ppt"]) as GenKind[],
        models,
      });
      message.success(`已把 ${models.length} 个模型写入白名单`);
      setDiscovered((d) => ({ ...d, [p.id]: [] }));
    } catch (e) {
      const err = e as { message?: string };
      message.error(err.message ?? String(e));
    }
  };

  return (
    <Modal
      title="服务商与密钥"
      open={configOpen}
      onCancel={() => {
        setDraft(null);
        closeConfig();
      }}
      footer={null}
      width={720}
    >
      <Space direction="vertical" style={{ width: "100%" }} size="middle">
        {providers.length === 0 && !draft && (
          <Alert
            type="warning"
            showIcon
            message="还没有配置服务商"
            description="填写 Base URL 与 API 密钥后即可生成；密钥只写入本地加密存储，不会回显。"
          />
        )}

        {providers.map((p) => (
          <Card
            key={p.id}
            size="small"
            title={
              <Space size={4} wrap>
                <Text strong>{p.name}</Text>
                {p.has_key ? <Tag color="green">{p.key_masked}</Tag> : <Tag color="orange">未填密钥</Tag>}
                {p.capabilities.length === 0 && <Tag>全部能力</Tag>}
              </Space>
            }
            extra={
              <Space size={4}>
                <Button size="small" icon={<EditOutlined />} onClick={() => setDraft(toDraft(p))}>
                  编辑
                </Button>
                <Button
                  size="small"
                  icon={<ApiOutlined />}
                  loading={testing === p.id}
                  disabled={!p.has_key}
                  onClick={() => void handleTest(p)}
                >
                  测试连通
                </Button>
                <Popconfirm
                  title="删除该服务商？"
                  description="它的密钥会从本地加密存储中移除"
                  okText="删除"
                  okButtonProps={{ danger: true }}
                  cancelText="取消"
                  onConfirm={() => void removeProvider(p.id).catch((e) => message.error(String(e)))}
                >
                  <Button size="small" danger icon={<DeleteOutlined />} />
                </Popconfirm>
              </Space>
            }
          >
            <Space direction="vertical" size={4} style={{ width: "100%" }}>
              <Text type="secondary" style={{ fontSize: 12 }} copyable={{ text: p.base_url }}>
                {p.base_url}
              </Text>
              <Space size={4} wrap>
                {(p.capabilities.length ? p.capabilities : KINDS.map((k) => k.kind)).map((c) => (
                  <Tag key={c}>{KIND_LABEL[c as GenKind] ?? c}</Tag>
                ))}
                {p.models.length > 0 && <Tag color="blue">{p.models.length} 个模型</Tag>}
              </Space>
              {discovered[p.id]?.length ? (
                <Space>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    发现 {discovered[p.id].length} 个模型
                  </Text>
                  <Button size="small" onClick={() => void importModels(p, discovered[p.id])}>
                    导入为模型白名单
                  </Button>
                </Space>
              ) : null}
            </Space>
          </Card>
        ))}

        <div>
          <Text strong>各类生成的默认服务商</Text>
          <Space direction="vertical" style={{ width: "100%", marginTop: 8 }}>
            {KINDS.map(({ kind, label }) => {
              const options = providers
                .filter((p) => p.capabilities.length === 0 || p.capabilities.includes(kind))
                .map((p) => ({ value: p.id, label: p.name }));
              const resolved = providerFor({ providers, active }, kind);
              return (
                <Space key={kind} style={{ width: "100%", justifyContent: "space-between" }}>
                  <Text>{label}</Text>
                  <Select
                    style={{ width: 260 }}
                    placeholder={options.length ? "选择服务商" : "暂无支持该能力的服务商"}
                    value={resolved?.id}
                    options={options}
                    disabled={!options.length}
                    onChange={(v) => void setActive(kind, v).catch((e) => message.error(String(e)))}
                  />
                </Space>
              );
            })}
          </Space>
        </div>

        {draft ? (
          <Card
            size="small"
            title={draft.providerId ? `编辑：${draft.name || draft.providerId}` : "新增服务商"}
          >
            <Space direction="vertical" style={{ width: "100%" }}>
              <Input
                placeholder="名称，例如 OpenAI / MiniMax"
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
              <Input
                placeholder="Base URL，例如 https://api.openai.com/v1"
                value={draft.baseUrl}
                onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })}
              />
              <Input.Password
                placeholder={draft.providerId ? "留空则保持原密钥不变" : "API 密钥"}
                value={draft.apiKey}
                autoComplete="off"
                onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })}
              />
              <Checkbox.Group
                options={KINDS.map((k) => ({ label: k.label, value: k.kind }))}
                value={draft.capabilities}
                onChange={(v) => setDraft({ ...draft, capabilities: v as GenKind[] })}
              />
              <TextArea
                rows={3}
                placeholder="模型清单（每行一个，可留空）。填写后会拒绝不属于该服务商的模型。"
                value={draft.models}
                onChange={(e) => setDraft({ ...draft, models: e.target.value })}
              />
              <Space>
                <Button type="primary" loading={saving} onClick={() => void handleSave()}>
                  保存
                </Button>
                <Button onClick={() => setDraft(null)}>取消</Button>
              </Space>
            </Space>
          </Card>
        ) : (
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setDraft(emptyDraft())}>
            添加服务商
          </Button>
        )}

        {!providers.length && !draft && <Empty description="暂无服务商" />}
      </Space>
    </Modal>
  );
}
