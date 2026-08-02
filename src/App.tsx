import { useState, useEffect } from "react";
import { Tabs, ConfigProvider, theme } from "antd";
import {
  PictureOutlined,
  VideoCameraOutlined,
  FilePptOutlined,
  EditOutlined,
} from "@ant-design/icons";
import zhCN from "antd/locale/zh_CN";
import { useAiStore } from "./stores/aiStore";
import ImageGenPanel from "./components/ImageGenPanel";
import VideoGenPanel from "./components/VideoGenPanel";
import PptGenPanel from "./components/PptGenPanel";
import TextGenPanel from "./components/TextGenPanel";

export default function App() {
  const [activeTab, setActiveTab] = useState("image");
  const loadConfig = useAiStore((s) => s.loadConfig);
  const loadHistory = useAiStore((s) => s.loadHistory);

  useEffect(() => {
    loadConfig();
    loadHistory();
  }, [loadConfig, loadHistory]);

  const items = [
    {
      key: "image",
      label: (
        <span>
          <PictureOutlined /> 图片生成
        </span>
      ),
      children: <ImageGenPanel />,
    },
    {
      key: "video",
      label: (
        <span>
          <VideoCameraOutlined /> 视频制造
        </span>
      ),
      children: <VideoGenPanel />,
    },
    {
      key: "ppt",
      label: (
        <span>
          <FilePptOutlined /> PPT生成
        </span>
      ),
      children: <PptGenPanel />,
    },
    {
      key: "text",
      label: (
        <span>
          <EditOutlined /> 文本写作
        </span>
      ),
      children: <TextGenPanel />,
    },
  ];

  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        algorithm: theme.defaultAlgorithm,
        token: { colorPrimary: "#1677ff" },
      }}
    >
      <div style={{ height: "100vh", display: "flex", flexDirection: "column", padding: "16px" }}>
        <div style={{ flex: 1, overflow: "auto" }}>
          <Tabs
            activeKey={activeTab}
            onChange={setActiveTab}
            items={items}
            size="large"
            style={{ height: "100%" }}
          />
        </div>
      </div>
    </ConfigProvider>
  );
}
