import { useState, useEffect } from "react";
import { ConfigProvider, Space, Menu, Tag, Button, Tooltip } from "antd";
import {
  PictureOutlined,
  VideoCameraOutlined,
  FilePptOutlined,
  EditOutlined,
  SettingOutlined,
  RobotOutlined,
  HistoryOutlined,
  ThunderboltOutlined,
  BulbOutlined,
} from "@ant-design/icons";
import zhCN from "antd/locale/zh_CN";
import { AppShell, ThemeProvider } from "./_shared";
import { providerFor, useAIGenStore } from "./stores/aiStore";
import ImageGenPanel from "./components/ImageGenPanel";
import VideoGenPanel from "./components/VideoGenPanel";
import PptGenPanel from "./components/PptGenPanel";
import TextGenPanel from "./components/TextGenPanel";
import BatchPanel from "./components/BatchPanel";
import HistoryDrawer from "./components/HistoryDrawer";
import ProviderSettings from "./components/ProviderSettings";
import AssistantDrawer from "./components/AssistantDrawer";
import { useAssistantStore } from "./stores/assistantStore";
import { useGenerationStore } from "./stores/generationStore";
import type { GenKind } from "./stores/generationStore";

type Mode = "image" | "video" | "ppt" | "text" | "batch";

export default function App() {
  const [mode, setMode] = useState<Mode>("image");
  const [historyOpen, setHistoryOpen] = useState(false);

  const loadConfig = useAIGenStore((s) => s.loadConfig);
  const loadHistory = useAIGenStore((s) => s.loadHistory);
  const providers = useAIGenStore((s) => s.providers);
  const active = useAIGenStore((s) => s.active);
  const configLoaded = useAIGenStore((s) => s.configLoaded);
  const openConfig = useAIGenStore((s) => s.openConfig);
  const prompts = useGenerationStore((s) => s.prompts);
  const tasks = useGenerationStore((s) => s.tasks);
  const askAssistant = useAssistantStore((s) => s.ask);

  // 助手求助对象：批量面板本身是文本队列，按文本求助
  const assistantKind: GenKind = mode === "batch" ? "text" : mode;

  useEffect(() => {
    loadConfig();
    loadHistory();
  }, [loadConfig, loadHistory]);

  // 表头提示当前类生成的服务商与密钥状态（批量面板不对应单一服务商）
  const current = mode === "batch" ? null : providerFor({ providers, active }, mode);
  const ready = Boolean(current?.has_key);
  const headerHint = () =>
    current ? `${current.name} ${current.key_masked ?? "未填密钥"}` : "未配置服务商";

  const menuItems = [
    { key: "image", icon: <PictureOutlined />, label: "图片生成" },
    { key: "video", icon: <VideoCameraOutlined />, label: "视频制造" },
    { key: "ppt", icon: <FilePptOutlined />, label: "PPT生成" },
    { key: "text", icon: <EditOutlined />, label: "文本写作" },
    { key: "batch", icon: <ThunderboltOutlined />, label: "批量生成" },
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
    <Space>
      {!configLoaded || mode === "batch" ? null : ready ? (
        <Tooltip title={`${current?.base_url ?? ""}`}>
          <Tag color="green">{headerHint()}</Tag>
        </Tooltip>
      ) : (
        <Tag color="orange">{current ? "未填密钥" : "未配置服务商"}</Tag>
      )}
      <Tooltip title="生成历史">
        <Button type="text" icon={<HistoryOutlined />} onClick={() => setHistoryOpen(true)} />
      </Tooltip>
      <Tooltip title="生成助手：只给建议，不会替你生成">
        <Button
          type="text"
          icon={<BulbOutlined />}
          onClick={() =>
            void askAssistant(
              assistantKind,
              prompts[assistantKind],
              undefined,
              tasks[assistantKind].error?.code ?? null
            )
          }
        />
      </Tooltip>
      <Tooltip title="服务商与密钥">
        <Button type="text" icon={<SettingOutlined />} onClick={openConfig} />
      </Tooltip>
    </Space>
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
            {mode === "batch" && <BatchPanel />}
          </div>

          <ProviderSettings />
          <AssistantDrawer />

          <HistoryDrawer
            open={historyOpen}
            onClose={() => setHistoryOpen(false)}
            onBackfill={(kind) => {
              setMode(kind);
              setHistoryOpen(false);
            }}
          />
        </AppShell>
      </ConfigProvider>
    </ThemeProvider>
  );
}
