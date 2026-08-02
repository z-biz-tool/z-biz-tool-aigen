import { useState } from "react";
import {
  Card,
  Input,
  Button,
  Space,
  Select,
  Typography,
  Empty,
  Alert,
  Divider,
  List,
  InputNumber,
} from "antd";
import { FilePptOutlined, PlusOutlined, DeleteOutlined } from "@ant-design/icons";

const { TextArea } = Input;
const { Text, Paragraph } = Typography;

interface OutlineItem {
  id: number;
  title: string;
  content: string;
}

export default function PptGenPanel() {
  const [topic, setTopic] = useState("");
  const [outline, setOutline] = useState<OutlineItem[]>([
    { id: 1, title: "", content: "" },
  ]);

  const templates = [
    { value: "business", label: "商务简约" },
    { value: "tech", label: "科技蓝" },
    { value: "creative", label: "创意彩色" },
    { value: "academic", label: "学术严谨" },
  ];

  const addOutlineItem = () => {
    setOutline([...outline, { id: Date.now(), title: "", content: "" }]);
  };

  const removeOutlineItem = (id: number) => {
    setOutline(outline.filter((item) => item.id !== id));
  };

  const updateOutlineItem = (id: number, field: "title" | "content", value: string) => {
    setOutline(outline.map((item) => (item.id === id ? { ...item, [field]: value } : item)));
  };

  return (
    <div>
      <Card title="PPT生成">
        <Alert
          message="功能开发中"
          description="此模块为UI框架预览，PPT生成功能将在后续版本中实现。"
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
        />

        <Space direction="vertical" style={{ width: "100%" }} size="middle">
          {/* 主题输入 */}
          <div>
            <Text strong>PPT主题</Text>
            <Input
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              placeholder="例如：2024年度产品发布会"
              style={{ marginTop: 8 }}
            />
          </div>

          {/* 模板选择 */}
          <div>
            <Text strong>模板风格</Text>
            <div style={{ marginTop: 8 }}>
              <Select
                defaultValue="business"
                style={{ width: "100%" }}
                options={templates}
                placeholder="选择PPT模板"
              />
            </div>
          </div>

          {/* 幻灯片数量 */}
          <div>
            <Space>
              <Text strong>幻灯片数量：</Text>
              <InputNumber min={1} max={50} defaultValue={10} />
            </Space>
          </div>

          {/* 大纲编辑 */}
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

          <Button type="primary" icon={<FilePptOutlined />} size="large" disabled>
            生成PPT（即将上线）
          </Button>
        </Space>
      </Card>

      <Card title="生成结果" style={{ marginTop: 16 }}>
        <Empty description="PPT生成功能即将上线，敬请期待" />
      </Card>

      <Divider />
      <Paragraph type="secondary" style={{ fontSize: 12 }}>
        PPT生成模块将支持主题输入、模板选择、大纲编辑，自动生成可下载的PPT文件。
      </Paragraph>
    </div>
  );
}
