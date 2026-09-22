/**
 * 模板管理（T-Prompt）：查看/新建/编辑/收藏/删除提示词模板。
 *
 * 内置模板不可删；编辑内置模板会派生成一份用户模板（Rust 侧保证）。
 */

import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  Button,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
  message,
} from "antd";
import { DeleteOutlined, EditOutlined, PlusOutlined, StarFilled, StarOutlined } from "@ant-design/icons";
import { useTemplateStore, type PromptTemplate, type TemplateKind } from "../stores/templateStore";

const { Text, Paragraph } = Typography;
const { TextArea } = Input;

const KINDS: { value: TemplateKind; label: string }[] = [
  { value: "text", label: "文本" },
  { value: "image", label: "图片" },
  { value: "video", label: "视频" },
  { value: "ppt", label: "PPT" },
];

/** 仅用于实时提示；权威抽取在 Rust `extract_variables` */
function previewVars(body: string): string[] {
  const out: string[] = [];
  const re = /\{([0-9A-Za-z_\u4e00-\u9fa5-]+)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

interface Draft {
  id?: string;
  name: string;
  kind: TemplateKind;
  body: string;
  favorite: boolean;
  builtin: boolean;
}

const blank = (kind: TemplateKind): Draft => ({
  name: "",
  kind,
  body: "",
  favorite: false,
  builtin: false,
});

export default function TemplateManager({
  open,
  onClose,
  kind,
}: {
  open: boolean;
  onClose: () => void;
  kind: TemplateKind;
}) {
  const items = useTemplateStore((s) => s.items);
  const corrupted = useTemplateStore((s) => s.corrupted);
  const load = useTemplateStore((s) => s.load);
  const save = useTemplateStore((s) => s.save);
  const remove = useTemplateStore((s) => s.remove);
  const setFavorite = useTemplateStore((s) => s.setFavorite);
  const [keyword, setKeyword] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) void load(kind, keyword || undefined);
    // 关键词变化由搜索按钮/回车显式触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, kind]);

  const filtered = useMemo(
    () =>
      keyword
        ? items.filter((t) => (t.name + t.body).toLowerCase().includes(keyword.toLowerCase()))
        : items,
    [items, keyword]
  );

  const handleSave = async () => {
    if (!draft) return;
    if (!draft.name.trim()) {
      message.warning("请填写模板名");
      return;
    }
    if (!draft.body.trim()) {
      message.warning("模板正文不能为空");
      return;
    }
    setSaving(true);
    try {
      const saved = await save({
        id: draft.id,
        name: draft.name,
        kind: draft.kind,
        body: draft.body,
        favorite: draft.favorite,
      });
      message.success(draft.builtin ? "已另存为我的模板" : `已保存：${saved.name}`);
      setDraft(null);
    } catch (e) {
      const err = e as { code?: string; message?: string };
      message.error(`${err.code ?? "ERROR"}：${err.message ?? String(e)}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title="提示词模板库"
      open={open}
      onCancel={() => {
        setDraft(null);
        onClose();
      }}
      footer={null}
      width={760}
    >
      <Space direction="vertical" style={{ width: "100%" }} size="middle">
        {corrupted > 0 && (
          <Alert type="warning" showIcon message="模板文件曾损坏，已回落到内置模板并备份为 templates.json.bak" />
        )}
        <Space style={{ width: "100%" }}>
          <Input.Search
            placeholder="搜索模板名或正文"
            allowClear
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            onSearch={() => void load(kind, keyword || undefined)}
            style={{ width: 260 }}
          />
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setDraft(blank(kind))}>
            新建模板
          </Button>
        </Space>

        <Table<PromptTemplate>
          size="small"
          rowKey="id"
          dataSource={filtered}
          pagination={{ pageSize: 6, size: "small" }}
          columns={[
            {
              title: "名称",
              dataIndex: "name",
              render: (_, t) => (
                <Space size={4} wrap>
                  <Text strong>{t.name}</Text>
                  {t.builtin && <Tag>内置</Tag>}
                  {t.variables.map((v) => (
                    <Tag key={v} color="geekblue">{`{${v}}`}</Tag>
                  ))}
                </Space>
              ),
            },
            {
              title: "正文",
              dataIndex: "body",
              render: (b: string) => (
                <Paragraph ellipsis={{ rows: 2, tooltip: b }} style={{ marginBottom: 0, fontSize: 12 }}>
                  {b}
                </Paragraph>
              ),
            },
            {
              title: "操作",
              key: "ops",
              width: 150,
              render: (_, t) => (
                <Space size={4}>
                  <Button
                    size="small"
                    icon={t.favorite ? <StarFilled /> : <StarOutlined />}
                    onClick={() => void setFavorite(t.id, !t.favorite).catch((e) => message.error(String(e)))}
                  />
                  <Button
                    size="small"
                    icon={<EditOutlined />}
                    onClick={() =>
                      setDraft({
                        id: t.id,
                        name: t.name,
                        kind: t.kind,
                        body: t.body,
                        favorite: t.favorite,
                        builtin: t.builtin,
                      })
                    }
                  />
                  {!t.builtin && (
                    <Popconfirm
                      title="删除这个模板？"
                      okText="删除"
                      okButtonProps={{ danger: true }}
                      cancelText="取消"
                      onConfirm={() =>
                        void remove(t.id).catch((e) => message.error(String((e as { message?: string })?.message ?? e)))
                      }
                    >
                      <Button size="small" danger icon={<DeleteOutlined />} />
                    </Popconfirm>
                  )}
                </Space>
              ),
            },
          ]}
        />

        {draft && (
          <div
            style={{
              border: "1px solid rgba(0,0,0,0.06)",
              borderRadius: 8,
              padding: 16,
            }}
          >
            <Space direction="vertical" style={{ width: "100%" }}>
              {draft.builtin && (
                <Alert type="info" showIcon message="内置模板不可直接修改，保存会另存为你自己的模板" />
              )}
              <Space.Compact block>
                <Input
                  placeholder="模板名"
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  style={{ width: 240 }}
                />
                <Select
                  value={draft.kind}
                  onChange={(v) => setDraft({ ...draft, kind: v })}
                  options={KINDS}
                  style={{ width: 100 }}
                />
                <Space style={{ paddingLeft: 12 }}>
                  <Switch
                    checked={draft.favorite}
                    onChange={(v) => setDraft({ ...draft, favorite: v })}
                    checkedChildren="收藏"
                    unCheckedChildren="收藏"
                  />
                </Space>
              </Space.Compact>
              <TextArea
                rows={5}
                placeholder="模板正文，用 {变量名} 打插槽，例如：请写一篇关于{主题}的文章，字数{字数}"
                value={draft.body}
                onChange={(e) => setDraft({ ...draft, body: e.target.value })}
              />
              <Text type="secondary" style={{ fontSize: 12 }}>
                识别到的变量：
                {previewVars(draft.body).length
                  ? previewVars(draft.body).map((v) => `{${v}}`).join(" ")
                  : "无"}
              </Text>
              <Space>
                <Button type="primary" loading={saving} onClick={() => void handleSave()}>
                  保存
                </Button>
                <Button onClick={() => setDraft(null)}>取消</Button>
              </Space>
            </Space>
          </div>
        )}
      </Space>
    </Modal>
  );
}
