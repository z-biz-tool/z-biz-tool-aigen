import { Card, Input, Button, Space, Select, Typography, Empty, Alert, Divider, Upload } from "antd";
import { VideoCameraOutlined, UploadOutlined } from "@ant-design/icons";

const { TextArea } = Input;
const { Text, Paragraph } = Typography;

export default function VideoGenPanel() {
  const digitalHumans = [
    { value: "dh_01", label: "小薇 - 女主播风格" },
    { value: "dh_02", label: "小明 - 男主播风格" },
    { value: "dh_03", label: "Lily - 英文风格" },
    { value: "dh_04", label: "阿强 - 方言风格" },
  ];

  const mixModes = [
    { value: "random", label: "随机混剪" },
    { value: "sequence", label: "顺序混剪" },
    { value: "beat", label: "卡点混剪" },
  ];

  return (
    <div>
      <Card title="视频制造">
        <Alert
          message="功能开发中"
          description="此模块为UI框架预览，视频生成功能将在后续版本中实现。"
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
        />

        <Space direction="vertical" style={{ width: "100%" }} size="middle">
          {/* 脚本输入 */}
          <div>
            <Text strong>视频脚本</Text>
            <TextArea
              placeholder="输入或粘贴你的视频脚本内容..."
              rows={6}
              style={{ marginTop: 8 }}
            />
          </div>

          {/* 数字人选择 */}
          <div>
            <Text strong>数字人选择</Text>
            <div style={{ marginTop: 8 }}>
              <Select
                defaultValue="dh_01"
                style={{ width: "100%" }}
                options={digitalHumans}
                placeholder="选择数字人形象"
              />
            </div>
          </div>

          {/* 混剪配置 */}
          <div>
            <Text strong>混剪模式</Text>
            <div style={{ marginTop: 8 }}>
              <Select
                defaultValue="random"
                style={{ width: "100%" }}
                options={mixModes}
                placeholder="选择混剪模式"
              />
            </div>
          </div>

          {/* 素材上传 */}
          <div>
            <Text strong>素材上传（可选）</Text>
            <div style={{ marginTop: 8 }}>
              <Upload.Dragger
                multiple
                accept="video/*,image/*"
                beforeUpload={() => false}
              >
                <p className="ant-upload-drag-icon">
                  <UploadOutlined style={{ fontSize: 32, color: "#1677ff" }} />
                </p>
                <p>点击或拖拽文件到此区域上传素材</p>
                <p style={{ color: "#999", fontSize: 12 }}>支持视频和图片格式</p>
              </Upload.Dragger>
            </div>
          </div>

          <Button type="primary" icon={<VideoCameraOutlined />} size="large" disabled>
            生成视频（即将上线）
          </Button>
        </Space>
      </Card>

      <Card title="生成结果" style={{ marginTop: 16 }}>
        <Empty description="视频生成功能即将上线，敬请期待" />
      </Card>

      <Divider />
      <Paragraph type="secondary" style={{ fontSize: 12 }}>
        视频制造模块将整合数字人播报、智能混剪、多素材合成等功能。
      </Paragraph>
    </div>
  );
}
