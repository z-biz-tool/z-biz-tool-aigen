import { useEffect, useRef, useState } from "react";
import { ConfigProvider, Space, Menu, Tag, Button, Tooltip, Modal, Typography, message } from "antd";
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
  KeyOutlined,
} from "@ant-design/icons";
import zhCN from "antd/locale/zh_CN";
import { AppShell, ThemeProvider } from "./_shared";
import { hotkeyLabel, installHotkeys, modeHotkeyLabel, type HotkeyMatch } from "./_shared/hotkeys";
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
import { MODE_ORDER, useUiStore, type ModeId } from "./stores/uiStore";
import type { GenKind } from "./stores/generationStore";

const { Text } = Typography;

export default function App() {
  // 模式来自持久化草稿：关掉应用回到上次那一页
  const mode = useUiStore((s) => s.mode);
  const setMode = useUiStore((s) => s.setMode);
  const resetKind = useUiStore((s) => s.resetKind);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);

  const loadConfig = useAIGenStore((s) => s.loadConfig);
  const loadHistory = useAIGenStore((s) => s.loadHistory);
  const providers = useAIGenStore((s) => s.providers);
  const active = useAIGenStore((s) => s.active);
  const configLoaded = useAIGenStore((s) => s.configLoaded);
  const openConfig = useAIGenStore((s) => s.openConfig);
  const prompts = useGenerationStore((s) => s.prompts);
  const tasks = useGenerationStore((s) => s.tasks);
  const resetTask = useGenerationStore((s) => s.reset);
  const askAssistant = useAssistantStore((s) => s.ask);

  // 助手求助对象：批量面板本身是文本队列，按文本求助
  const assistantKind: GenKind = mode === "batch" ? "text" : mode;

  useEffect(() => {
    loadConfig();
    loadHistory();
  }, [loadConfig, loadHistory]);

  /**
   * 快捷键：一个 window 监听 + 保存最新回调的 ref（fleet 同款）。
   * 面板自己注册 generate/cancel/export，这里只兜底全局动作。
   */
  const hotkeyRef = useRef<{
    switchMode: (index: number) => void;
    openProvider: () => void;
    toggleHelp: () => void;
    newDraft: () => void;
    note: (m: HotkeyMatch) => void;
  }>({
    switchMode: () => {},
    openProvider: () => {},
    toggleHelp: () => {},
    newDraft: () => {},
    note: () => {},
  });

  useEffect(() => {
    hotkeyRef.current = {
      switchMode: (index) => {
        const next = MODE_ORDER[index];
        if (next) setMode(next);
      },
      openProvider: () => openConfig(),
      toggleHelp: () => setHelpOpen((v) => !v),
      newDraft: () => {
        resetKind(mode);
        if (mode !== "batch") resetTask(mode);
        setHistoryOpen(false);
        message.success("已开新一轮：当前模式的提示词与参数已清空");
      },
      note: (m) => {
        if (m.action === "generate") message.info("这一页没有可执行的「生成」");
        else if (m.action === "export") message.info("还没有可导出的产物");
        else if (m.action === "cancel") message.info("当前没有在途的生成任务");
      },
    };
  });

  useEffect(
    () =>
      installHotkeys((m) => {
        if (m.action === "mode") hotkeyRef.current.switchMode(m.index ?? 0);
        else if (m.action === "provider") hotkeyRef.current.openProvider();
        else if (m.action === "help") hotkeyRef.current.toggleHelp();
        else if (m.action === "newDraft") hotkeyRef.current.newDraft();
        else hotkeyRef.current.note(m);
      }),
    []
  );

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
      onClick={(e) => setMode(e.key as ModeId)}
      items={menuItems.map((m, i) => ({
        ...m,
        label: (
          <span style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
            <span>{m.label}</span>
            <Text type="secondary" style={{ fontSize: 11 }}>
              {modeHotkeyLabel(i)}
            </Text>
          </span>
        ),
      }))}
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
      <Tooltip title={`快捷键一览（${hotkeyLabel("help")}）`}>
        <Button type="text" icon={<KeyOutlined />} onClick={() => setHelpOpen(true)} />
      </Tooltip>
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
      <Tooltip title={`服务商与密钥（${hotkeyLabel("provider")}）`}>
        <Button type="text" icon={<SettingOutlined />} onClick={openConfig} />
      </Tooltip>
    </Space>
  );

  const shortcutRows: Array<[string, string]> = [
    [hotkeyLabel("generate"), "生成（在输入框里也生效）"],
    [hotkeyLabel("cancel"), "取消在途的生成，状态记为「已取消」"],
    [hotkeyLabel("export"), "导出当前产物到本地文件"],
    [hotkeyLabel("newDraft"), "清空当前模式草稿，开新一轮"],
    [hotkeyLabel("provider"), "服务商与密钥"],
    ...MODE_ORDER.map((m, i): [string, string] => [
      modeHotkeyLabel(i),
      `切换到${menuItems.find((x) => x.key === m)?.label ?? m}`,
    ]),
    ["Esc", "关闭抽屉与弹窗"],
  ];

  return (
    <ThemeProvider>
      <ConfigProvider locale={zhCN}>
        <AppShell
          title="AI 内容工厂"
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

          <Modal
            open={helpOpen}
            title="快捷键"
            footer={null}
            onCancel={() => setHelpOpen(false)}
            width={460}
          >
            <Space direction="vertical" size={6} style={{ width: "100%" }}>
              {shortcutRows.map(([keys, desc]) => (
                <div key={keys} style={{ display: "flex", gap: 12 }}>
                  <Text code style={{ minWidth: 92 }}>
                    {keys}
                  </Text>
                  <Text type="secondary">{desc}</Text>
                </div>
              ))}
              <Text type="secondary" style={{ fontSize: 12 }}>
                键位为 ⌘（macOS）或 Ctrl（Windows/Linux）组合；Esc 关闭抽屉与弹窗。
              </Text>
            </Space>
          </Modal>

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
