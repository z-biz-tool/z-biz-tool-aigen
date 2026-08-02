import { useState } from "react";
import { Card, Input, Button, Space, Select, Typography, message } from "antd";
import { VideoCameraOutlined } from "@ant-design/icons";
import { useGeneration, EmptyState, LoadingState, ErrorState } from "../_shared";

const { TextArea } = Input;
const { Text } = Typography;

const durations = [
  { value: "5", label: "5 秒" },
  { value: "10", label: "10 秒" },
  { value: "15", label: "15 秒" },
  { value: "30", label: "30 秒" },
];

const resolutions = [
  { value: "720p", label: "720p" },
  { value: "1080p", label: "1080p" },
  { value: "4k", label: "4K" },
];

export default function VideoGenPanel() {
  const [prompt, setPrompt] = useState("");
  const [duration, setDuration] = useState("5");
  const [resolution, setResolution] = useState("1080p");
  const { loading, result, error, generate } = useGeneration<string>();

  const handleGenerate = () => {
    if (!prompt.trim()) {
      message.warning("请输入视频脚本");
      return;
    }
    void generate("generate_video", { prompt, duration, resolution });
  };

  const renderResult = () => {
    if (loading) return <LoadingState tip="AI创作中..." />;
    if (error)
      return <ErrorState message={error} onRetry={handleGenerate} />;
    if (!result)
      return <EmptyState title="输入提示词开始生成" description="填写脚本与参数后点击生成" />;
    return (
      <div style={{ textAlign: "center" }}>
        <video src={result} controls style={{ maxWidth: "100%", borderRadius: 8 }} />
      </div>
    );
  };

  return (
    <div>
      <Card title="视频制造">
        <Space direction="vertical" style={{ width: "100%" }} size="middle">
          <div>
            <Text strong>视频脚本</Text>
            <TextArea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="输入或粘贴你的视频脚本内容..."
              rows={6}
              style={{ marginTop: 8 }}
            />
          </div>
          <Space wrap>
            <div>
              <Text style={{ marginRight: 8 }}>时长：</Text>
              <Select
                value={duration}
                onChange={setDuration}
                options={durations}
                style={{ width: 120 }}
              />
            </div>
            <div>
              <Text style={{ marginRight: 8 }}>分辨率：</Text>
              <Select
                value={resolution}
                onChange={setResolution}
                options={resolutions}
                style={{ width: 140 }}
              />
            </div>
            <Button
              type="primary"
              icon={<VideoCameraOutlined />}
              loading={loading}
              onClick={handleGenerate}
              size="large"
            >
              生成视频
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
