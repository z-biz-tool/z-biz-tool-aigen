import { useState } from "react";
import { Card, Input, Button, Space, Select, Typography, List, InputNumber, message } from "antd";
import { FilePptOutlined, PlusOutlined, DeleteOutlined, DownloadOutlined } from "@ant-design/icons";
import { useGeneration, EmptyState, LoadingState, ErrorState } from "../_shared";

const { TextArea } = Input;
const { Text } = Typography;

interface OutlineItem {
  id: number;
  title: string;
  content: string;
}

const templates = [
  { value: "business", label: "商务简约" },
  { value: "tech", label: "科技蓝" },
  { value: "creative", label: "创意彩色" },
  { value: "academic", label: "学术严谨" },
];

export default function PptGenPanel() {
  const [topic, setTopic] = useState("");
  const [template, setTemplate] = useState("business");
  const [slides, setSlides] = useState(10);
  const [outline, setOutline] = useState<OutlineItem[]>([{ id: 1, title: "", content: "" }]);
  const { loading, result, error, generate } = useGeneration<string>();

  const addOutlineItem = () => {
    setOutline([...outline, { id: Date.now(), title: "", content: "" }]);
  };

  const removeOutlineItem = (id: number) => {
    setOutline(outline.filter((item) => item.id !== id));
  };

  const updateOutlineItem = (id: number, field: "title" | "content", value: string) => {
    setOutline(outline.map((item) => (item.id === id ? { ...item, [field]: value } : item)));
  };

  const handleGenerate = () => {
    if (!topic.trim()) {
      message.warning("请输入PPT主题");
      return;
    }
    void generate("generate_ppt", { topic, template, slides, outline });
  };

  const renderResult = () => {
    if (loading) return <LoadingState tip="AI创作中..." />;
    if (error)
      return <ErrorState message={error} onRetry={handleGenerate} />;
    if (!result)
      return <EmptyState title="输入提示词开始生成" description="填写主题与大纲后点击生成" />;
    return (
      <div style={{ textAlign: "center", padding: 24 }}>
        <Button type="primary" icon={<DownloadOutlined />} href={result} target="_blank">
          下载PPT文件
        </Button>
      </div>
    );
  };

  return (
    <div>
      <Card title="PPT生成">
        <Space direction="vertical" style={{ width: "100%" }} size="middle">
          <div>
            <Text strong>PPT主题</Text>
            <Input
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              placeholder="例如：2024年度产品发布会"
              style={{ marginTop: 8 }}
            />
          </div>
          <Space wrap>
            <div>
              <Text style={{ marginRight: 8 }}>模板：</Text>
              <Select
                value={template}
                onChange={setTemplate}
                options={templates}
                style={{ width: 160 }}
              />
            </div>
            <div>
              <Text style={{ marginRight: 8 }}>页数：</Text>
              <InputNumber min={1} max={50} value={slides} onChange={(v) => setSlides(v || 10)} />
            </div>
            <Button
              type="primary"
              icon={<FilePptOutlined />}
              loading={loading}
              onClick={handleGenerate}
              size="large"
            >
              生成PPT
            </Button>
          </Space>
          <div>
            <Space style={{ width: "100%", justifyContent: "space-between" }}>
              <Text strong>大纲编辑</Text>
              <Button icon={<PlusOutlined />} onClick={addOutlineItem} size="small">
                添加章节
              </Button>
            </Space>
            <div style={{ marginTop: 8 }}>
              <List
                dataSource={outline}
                renderItem={(item, index) => (
                  <List.Item>
                    <div style={{ width: "100%" }}>
                      <Space direction="vertical" style={{ width: "100%" }} size="small">
                        <Space style={{ width: "100%", justifyContent: "space-between" }}>
                          <Text type="secondary">第 {index + 1} 页</Text>
                          {outline.length > 1 && (
                            <Button
                              icon={<DeleteOutlined />}
                              onClick={() => removeOutlineItem(item.id)}
                              size="small"
                              danger
                            />
                          )}
                        </Space>
                        <Input
                          value={item.title}
                          onChange={(e) => updateOutlineItem(item.id, "title", e.target.value)}
                          placeholder="页面标题"
                        />
                        <TextArea
                          value={item.content}
                          onChange={(e) => updateOutlineItem(item.id, "content", e.target.value)}
                          placeholder="页面内容要点（每行一个要点）"
                          rows={3}
                        />
                      </Space>
                    </div>
                  </List.Item>
                )}
              />
            </div>
          </div>
        </Space>
      </Card>

      <Card title="生成结果" style={{ marginTop: 16 }}>
        {renderResult()}
      </Card>
    </div>
  );
}
