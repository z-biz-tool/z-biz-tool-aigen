# z-biz-tool-aigen

AI内容制造工厂 - 合并 creator-graph + kb-cos + create-ppt-web 的一体化桌面应用

## 功能模块

- **图片生成**: AI图片生成，支持批量生成、结果网格展示、下载
- **视频制造**: 数字人播报 + 智能混剪（UI框架，功能开发中）
- **PPT生成**: 主题输入 + 模板选择 + 大纲编辑（UI框架，功能开发中）
- **文本写作**: AI文本生成，支持多种写作类型

## 技术栈

- Tauri 2.0 (Rust后端)
- Vite + React 19
- Ant Design 6
- Zustand 状态管理
- reqwest (AI API调用)

## 开发

```bash
npm install
npm run tauri dev
```

## 构建

```bash
npm run tauri build
```

## API配置

应用内置API配置管理，支持OpenAI兼容格式的图片生成和文本生成API。
配置保存在 `~/.z-biz-tool-aigen/config.json`。
