# 视觉 Demo → 插件拆解对照（更新版）

> 原始文件：`deepseek_html_20260910_f355e0.html`（未改动）。
> 本文说明 demo 的每一块被拆到了哪个插件里，以及"内容真实化"之后的变化。

## 1. 页面骨架

| demo | 拆到插件 | 实现 |
|---|---|---|
| `.bg-aurora` + 8 个 blob + drift 动画 | `bg-aurora` (S3) | 注册到 selectable `bg`，挂进 `#bgLayer` |
| 纯白底 | `bg-solid` (S4) + `theme-tokens` (F5) | selectable + `html[data-theme]` |
| `.app` / `.app-main` 骨架 | `app-shell` (S1) | 运行时生成，提供结构插槽 |
| `.body` 三列 grid | `app-shell` + `left-list-panel` (S7) | 宽度变量 `--list-w` |
| `.glass` 玻璃拟态 | `app-shell` | 左右面板复用 |
| `.resizer` 拖拽调宽 | `left-list-panel` | 写回 `view-router.setWidth()` |
| 紧凑模式 / 圆角衰减 | `left-list-panel` | ResizeObserver |

## 2. 顶层栏与侧栏

| demo | 拆到插件 | 备注 |
|---|---|---|
| `.tb-brand` | `brand-widget` (V1) | 使用 `public/assets/logo.png` |
| `.tb-divider` + `.tb-user` + 签名输入 | `user-widget` (V2) | 签名存 `config['ui.signature']` |
| `.tb-winbtns` | `win-buttons` (V3) | **web 环境按 demo 规则隐藏**，Electron 可对接宿主 |
| rail 容器与三段插槽 | `rail` (S6) | 上/中/下 |
| 会话、渠道导航按钮 | `rail-nav-buttons` (V4) | 从 `view-router.list()` 动态生成 |
| rail 中部用户插件位 | `rail-plugin-slot` (V5) | 供扩展插件挂载（音乐/番茄钟/RSS 等暂未内置） |

## 3. 会话视图

| demo | 拆到插件 | 内容真实化后的变化 |
|---|---|---|
| `#chatMain` / `#chatEmpty` | `chat-view` (V6) | 空状态保留；不再有种子会话 |
| `#convList` + `.conv-item` | `session-list` (V7) | 数据来自后端；**新增 + 按钮、离线模式提示条、同步重试** |
| `.search-popover` | `session-list` | 紧凑模式下展开 |
| `.chat-header` + 更多菜单 | `chat-header` (V8) | 导出走真实 export-service |
| `#msgScroll` / `.msg-row` | `message-list` (V9) | rAF 合帧；右键复制/删除 |
| `.bubble` 全套样式 | `bubble-default` (V10) | selectable；QQ/微信气泡为可替换实现 |
| `.composer` / `.h-resizer` | `composer` (V11) | Enter 发送、高度拖拽 |

demo 的示例会话（诺亚、代码搭档…）**已全部移除**，改为空列表 + 真实的新建会话流程。

## 4. 渠道视图

| demo | 拆到插件 | 内容真实化后的变化 |
|---|---|---|
| 渠道列表骨架、搜索、添加按钮 | `channel-view` (V12) + `channel-list` (V13) | 种子渠道（微信/TG/Discord）**已移除** |
| 「添加渠道」菜单 | `channel-list` | 当前没有内置渠道类型；微信/Discord/邮箱以"未实现 + 原因"禁用展示 |
| 分组折叠 / 拖拽 / 右键菜单 | `channel-list` | 拖拽改调 `channel-registry.moveChannel()` |
| 右侧详情 | `channel-detail-host` (V14) | 只展示真实字段与连接开关；渠道扩展由插件注册 |

## 5. 设置视图

demo 的 11 个设置页全部保留，并补充了"未实现清单"：

| demo 页面 | 插件 | 内容真实化后的变化 |
|---|---|---|
| 账号 | `official-service`（独立插件，暂不可用） | 插件归属账号页与官方内置模型入口；官方服务端未制作时标记"暂不可用"，禁用插件后页面与相关入口一起隐藏，重新启用恢复 |
| 模型 | `settings-item-model` | 自定义提供商管理：Base URL / Key / 测试连接 / 拉取模型 / 默认模型 / 温度；内置模型区域由 `official-service` 服务决定是否展示 |
| 插件 | `settings-item-plugins` | 列表来自 cordis fiber 状态；安装/市场明确标注"未实现" |
| 外观 | `settings-item-theme` | 主题/背景/强调色全部来自 selectable 服务 |
| （外观内气泡区） | `settings-item-bubble` | 跨插件区块组合示例 |
| 通知 | `settings-item-notifications` | 右下角通知中心（系统 / 角色消息 / 其他）+ 浏览器或桌面宿主系统通知 |
| 快捷键 | `settings-item-shortcuts` | 从 `shortcuts.list()` 实时读取 |
| 网络 / 数据 / 隐私 / 通用 / 关于 | 对应 `settings-item-*` | 数据页显示后端来源与同步状态 |
| （新增） | `settings-item-unimplemented` | 未实现功能集中列表 |

## 6. 逻辑层（demo 没有，按文档补齐，现已真实化）

| 能力 | 插件 | 说明 |
|---|---|---|
| 发送 → 存 → 调模型 → 流式回显 | `chat-flow` + `message-service` + `model-service` | 通过后端 `/api/chat` SSE |
| 模型接入 | `model-adapter-backend` + `server/plugins/models.mjs` | 真实 OpenAI 兼容 / Anthropic / Ollama |
| 会话持久化 | `session-service` + `server/plugins/sessions.mjs` | `user_data/sessions.json`，离线自动降级 |
| 搜索 / 导出 | `search-service` / `export-service` | 真实 |
| 实时事件 | `backend-client` + `server/plugins/hub.mjs` | SSE（扩展插件可用） |
| 扩展能力 | 已移出内置：气泡扩展 / 音乐播放器 / 番茄钟 / RSS / TTS / 翻译 / Telegram 渠道 | 后续以独立扩展插件回归 |

## 7. 视觉一致性说明

* demo 的 CSS 变量、玻璃参数、动画 keyframes、滚动条、hover 态按原值保留；
* 每个插件的 CSS 独立成 `style.mjs`，对应 demo 的样式段落；
* 与原 demo 的有意差异：
  1. 设置页 `top` 改为标题栏高度，不遮窗口按钮；
  2. `alert / confirm` 换成统一的 toast / modal 服务；
  3. 新增深色主题覆盖；
  4. web 环境隐藏窗口三按钮（与 demo 的 `body[data-env=web]` 规则一致）。

