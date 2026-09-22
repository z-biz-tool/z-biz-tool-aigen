import { useEffect, useRef, useState } from "react";
import { Card, Input, Button, Space, Select, Typography, message, Progress, Spin } from "antd";
import { VideoCameraOutlined, CloseCircleOutlined, DownloadOutlined } from "@ant-design/icons";
import { EmptyState, LoadingState, ErrorState } from "../_shared";
import { EXPORT_FILTERS, exportResult, stamp } from "../_shared/export";
import { useTask, usePrompt } from "../stores/generationStore";
import { useAIGenStore } from "../stores/aiStore";

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
  const [prompt, setPrompt] = usePrompt("video");
  const [duration, setDuration] = useState("5");
  const [resolution, setResolution] = useState("1080p");
  const { loading, result, error, progress, submit, pollVideo, cancel } = useTask("video");
  const openConfig = useAIGenStore((s) => s.openConfig);
  const src = (result as string | null) ?? "";
  const polledRef = useRef<string | null>(null);

  const handleGenerate = () => {
    if (!prompt.trim()) {
      message.warning("请输入视频脚本");
      return;
    }
    polledRef.current = null;
    void submit("video", "generate_video", { prompt, duration, resolution });
  };

  // B2 / T-B2：上游只回任务号时自动转入轮询，进度走 aigen://progress/{requestId}
  useEffect(() => {
    if (!src.startsWith("task:")) return;
    if (polledRef.current === src) return;
    polledRef.current = src;
    void pollVideo(src.slice(5));
  }, [src, pollVideo]);

  const renderResult = () => {
    if (src.startsWith("task:")) {
      return (
        <Space direction="vertical" align="center" style={{ width: "100%" }} size="middle">
          <EmptyState title="任务已提交，正在等待上游出片" description={`任务号 ${src.slice(5)}`} />
          {progress ? (
            <Progress percent={progress.percent} status="active" style={{ width: 320 }} />
          ) : (
            <Spin />
          )}
          <Text type="secondary" style={{ fontSize: 12 }}>
            {progress ? `上游状态：${progress.stage}` : "查询中…"}（最长等 5 分钟，可随时取消）
          </Text>
          <Button danger icon={<CloseCircleOutlined />} onClick={cancel}>
            取消等待
          </Button>
        </Space>
      );
    }
    if (loading) return <LoadingState tip="AI创作中..." onCancel={cancel} />;
    if (error)
      return <ErrorState error={error} onRetry={handleGenerate} onOpenConfig={openConfig} />;
    if (!src)
      return <EmptyState title="输入提示词开始生成" description="填写脚本与参数后点击生成" />;
    return (
      <div style={{ textAlign: "center" }}>
        <video src={src} controls style={{ maxWidth: "100%", borderRadius: 8 }} />
        <div style={{ marginTop: 12 }}>
          <Button
            type="primary"
            ghost
            icon={<DownloadOutlined />}
            onClick={() =>
              void exportResult({
                defaultName: `aigen-video-${stamp()}.mp4`,
                filters: EXPORT_FILTERS.video,
                text: src,
              })
            }
          >
            导出视频
          </Button>
        </div>
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
            {loading ? (
              <Button icon={<CloseCircleOutlined />} onClick={cancel} size="large" danger>
                取消生成
              </Button>
            ) : (
              <Button
                type="primary"
                icon={<VideoCameraOutlined />}
                onClick={handleGenerate}
                size="large"
              >
                生成视频
              </Button>
            )}
          </Space>
        </Space>
      </Card>

      <Card title="生成结果" style={{ marginTop: 16 }}>
        {renderResult()}
      </Card>
    </div>
  );
}
