import { useState, useEffect, useCallback } from "react";
import { ConfigProvider, Modal, Input, Space, Typography, message, Menu } from "antd";
import {
  PictureOutlined,
  VideoCameraOutlined,
  FilePptOutlined,
  EditOutlined,
  SettingOutlined,
  RobotOutlined,
} from "@ant-design/icons";
import zhCN from "antd/locale/zh_CN";
import { AppShell, ThemeProvider } from "./_shared";
import { useAIGenStore } from "./stores/aiStore";
import ImageGenPanel from "./components/ImageGenPanel";
import VideoGenPanel from "./components/VideoGenPanel";
import PptGenPanel from "./components/PptGenPanel";
import TextGenPanel from "./components/TextGenPanel";

const { Text } = Typography;

type Mode = "image" | "video" | "ppt" | "text";

export default function App() {
  const [mode, setMode] = useState<Mode>("image");
  const [configOpen, setConfigOpen] = useState(false);
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");

  const loadConfig = useAIGenStore((s) => s.loadConfig);
  const loadHistory = useAIGenStore((s) => s.loadHistory);
  const storedBaseUrl = useAIGenStore((s) => s.baseUrl);
  const storedApiKey = useAIGenStore((s) => s.apiKey);
  const saveConfig = useAIGenStore((s) => s.saveConfig);

  useEffect(() => {
    loadConfig();
    loadHistory();
  }, [loadConfig, loadHistory]);

  const openConfig = useCallback(() => {
    setBaseUrl(storedBaseUrl);
    setApiKey(storedApiKey);
    setConfigOpen(true);
  }, [storedBaseUrl, storedApiKey]);

  const handleSaveConfig = async () => {
    try {
      await saveConfig(baseUrl, apiKey);
      message.success("配置已保存");
      setConfigOpen(false);
    } catch (e) {
      message.error(`保存配置失败: ${e}`);
    }
  };

  const menuItems = [
    { key: "image", icon: <PictureOutlined />, label: "图片生成" },
    { key: "video", icon: <VideoCameraOutlined />, label: "视频制造" },
    { key: "ppt", icon: <FilePptOutlined />, label: "PPT生成" },
    { key: "text", icon: <EditOutlined />, label: "文本写作" },
  ];

  const sidebar = (
    <Menu
      mode="inline"
      selectedKeys={[mode]}
      onClick={(e) => setMode(e.key as Mode)}
      items={menuItems}
      style={{ borderInlineEnd: "none", height: "100%" }}
    />
  );

  const headerExtra = (
    <SettingOutlined
      onClick={openConfig}
      style={{ fontSize: 16, cursor: "pointer" }}
      title="API配置"
    />
  );

  return (
    <ThemeProvider>
      <ConfigProvider locale={zhCN}>
        <AppShell
          title="z-biz-tool-aigen"
          icon={<RobotOutlined />}
          sidebar={sidebar}
          headerExtra={headerExtra}
        >
          <div style={{ padding: 16, height: "100%" }}>
            {mode === "image" && <ImageGenPanel />}
            {mode === "video" && <VideoGenPanel />}
            {mode === "ppt" && <PptGenPanel />}
            {mode === "text" && <TextGenPanel />}
          </div>

          <Modal
            title="API配置"
            open={configOpen}
            onOk={handleSaveConfig}
            onCancel={() => setConfigOpen(false)}
            okText="保存"
            cancelText="取消"
          >
            <Space direction="vertical" style={{ width: "100%" }} size="middle">
              <div>
                <Text strong>Base URL</Text>
                <Input
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder="https://api.minimax.chat/v1"
                  style={{ marginTop: 8 }}
                />
              </div>
              <div>
                <Text strong>API Key</Text>
                <Input.Password
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="输入你的API密钥"
                  style={{ marginTop: 8 }}
                />
              </div>
            </Space>
          </Modal>
        </AppShell>
      </ConfigProvider>
    </ThemeProvider>
  );
}
