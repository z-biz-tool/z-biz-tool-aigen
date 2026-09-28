# z-biz-tool-aigen · AI 内容工厂

面向长内容生产的 AI 生成工作台（Tauri 2 + React 19 + Ant Design 6）：图片 / 视频 / PPTX / 长文四条生成线，
配一套模板库、批量队列、生成助手、生成历史与加密密钥管理。

> 界面标题是「AI 内容工厂」；bundle 与数据目录仍沿用 `z-biz-tool-aigen`
> （`productName` / `identifier` / `~/.z-biz-tool-aigen` 被安装脚本与既有用户数据依赖，不做更名）。

## 功能现状（以代码为准）

| 模块 | 状态 | 实际能力 |
| --- | --- | --- |
| 图片生成 | 可用 | 单次多张、尺寸选择、负面提示词、风格预设模板；参考图走 Rust 受控入口 `prepare_reference_image`（魔数嗅探，不信扩展名）；结果网格逐张导出 |
| 视频制造 | 可用（依赖上游） | 异步 job：提交后由后端在**同一个 job** 里轮询上游任务号，分阶段进度推回，等待期间可随时取消。产物是上游返回的片段地址——本地不做混剪（无 ffmpeg 依赖） |
| PPT 生成 | 可用 | 主题 + 可增删编辑的大纲；同时产出**真 `.pptx`**（`src-tauri/src/pptx.rs`，手写 OOXML zip，无第三方依赖）与 `.html` 预览；从「生成历史」导出到任意目录 |
| 文本写作 | 可用 | 流式输出（`stream.rs`，边到边渲染，未完成也能取消）、system / temperature / maxTokens、导出 `.md` |
| 批量生成 | 可用 | 多行提示词入队；全局闸门同时最多 2 条（`MAX_CONCURRENT_GENERATIONS`），等名额也可取消；单条取消 / 重试 / 整批取消 |
| 生成历史 | 可用 | JSONL 落盘（`history.rs`），坏行自愈并计数、收藏、按类型与关键词筛选分页、一键回填到对应面板 |
| 模板库 | 可用 | `{变量}` 插槽渲染（内置若干 + 用户自建 + 收藏，`templates.rs`）；命中「正文」类插槽的变量直接吃主输入框 |
| 生成助手 | 可用 | 只给提示词改写建议并说明理由，**不会替你生成**；带错误码时会针对失败原因给建议 |
| 服务商与密钥 | 可用 | 多服务商 + 按能力路由，模型白名单校验由 Rust `AppConfig::resolve` 兜底；连通性测试；密钥 **XChaCha20Poly1305 加密落盘**（`secret.rs`，0600 权限、原子写），前端只见 `has_key` / 掩码，拿不到明文 |
| 导出 | 可用 | 统一入口：dialog 选路径 + Rust `save_export` 写盘（不依赖 webview 的 `<a download>`） |

## 快捷键

| 键位（macOS / 其它） | 作用 |
| --- | --- |
| `⌘⏎` / `Ctrl+Enter` | 生成——在输入框里同样生效 |
| `⌘.` / `Ctrl+.` | 取消在途生成，状态记为「已取消」而不是「失败」 |
| `⌘S` / `Ctrl+S` | 导出当前产物 |
| `⌘⇧N` / `Ctrl+Shift+N` | 清空当前模式草稿，开新一轮 |
| `⌘⇧P` / `Ctrl+Shift+P` | 服务商与密钥 |
| `⌘1`…`⌘5` / `Ctrl+1`…`Ctrl+5` | 图片 / 视频 / PPT / 文本 / 批量 |
| `⌘/` / `Ctrl+/` | 快捷键一览 |
| `Esc` | 关闭抽屉与弹窗（交回 AntD Drawer/Modal） |

监听只有一个（`src/App.tsx` 挂载时装一次），动作从作用域栈取最新实现，因此状态变化不会摘装监听；
裸键一律放行，打字时不劫持。

## 状态与持久化

- **交互草稿**（当前模式 + 各面板参数 + 提示词 + PPT 大纲 + 批量队列文本）落在
  `localStorage` 的 `aigen.craft.v1`：带 `version` + `migrate`（旧载荷一律重铸为默认形状，不会崩启动）、
  字段截断（提示词 6000 字、大纲最多 24 页）与配额降级（写不进就退回只留模式，再不行删键，全程不抛）。
  白名单落盘，密钥结构上就进不来。
- **配置与历史**唯一来源仍是 Rust 侧加密存储：`~/.z-biz-tool-aigen/`（`config.json` 信封加密、`history.jsonl`、`results/**`）。
  资源协议 scope 限定 `$HOME/.z-biz-tool-aigen/results/**`。

## 错误契约

所有生成/导出调用返回同一形状 `{ code, message, retryable }`（`src-tauri/src/error.rs` ↔ `src/_shared/genError.ts`），
界面按 `code` 分支降级，绝不止一个「生成失败」：

`NO_CONFIG` 未填密钥 · `AUTH` 401/403 密钥无效 · `RATE_LIMIT` 429 · `TIMEOUT` 超时 ·
`NETWORK` 连不上 · `UPSTREAM` / `UPSTREAM_5XX` 上游拒绝或服务不可用 · `CONTENT_POLICY` 内容安全策略拒绝 ·
`CANCELLED` 用户取消 · `PARSE` 响应无法解析 · `INVALID_PARAM` 本地校验 · `STORAGE` 本地读写 · `CONFLICT` 目标文件已存在。

只重试**未产生计费**的失败（限流 / 超时 / 网络）；5xx 不自动重试，因为上游可能已经实际生成并计费。
`message` 经脱敏（不回显 key / Authorization / 上游原 body）并限长 280 字。

## 开发

```bash
npm install
npm run tauri dev       # 桌面开发
npm run typecheck       # tsc --noEmit
npm run test            # vitest：状态层与纯函数（Tauri IPC 全 mock，不打真实上游）
npm run build           # 产物构建
```

Rust 侧：

```bash
cd src-tauri
cargo test              # 含 job/pptx/secret/history/error 的单元与取消语义用例
cargo check --message-format=short
```

真壳端到端（需要本机上可用的上游，CI 里作为门禁）：`python3 tools/e2e_native.py`（脚本自己注入 `AIGEN_E2E=1`），
数据目录隔离到 `/tmp`，不污染 `~/.z-biz-tool-aigen`。

## API 配置

多服务商、OpenAI 兼容格式的图片 / 文本 / 视频接口。设置入口在表头「服务商与密钥」（`⌘⇧P`），
支持能力声明、模型白名单与连通性校验；密钥加密后保存在 `~/.z-biz-tool-aigen/config.json`。
