# 插件清单与实现状态

> 共 **84 个前端插件 + 8 个后端插件**（核心 66 · 可选 18）。
> 详细职责、文件定位与修改指引见 **[`docs/PLUGINS.md`](PLUGINS.md)**；视觉拆解见 [`docs/DEMO-MAPPING.md`](DEMO-MAPPING.md)。

---

## 数量总览

| 层 | 目录 | 数量 | 内容 |
|---|---|---|---|
| L0 内核 | `plugins/kernel/` | 5 | event-bus / plugin-loader / dependency-resolver / lifecycle / service-container |
| L1 基础服务 | `plugins/foundation/` | 15 | storage / config / logger / i18n / theme-tokens / slots / 各种宿主 / shortcuts / notification / error-reporter / **backend-client** |
| L2 业务服务 | `plugins/domain/` | 14 | session / message / model-registry / model-service / view-router / channel-registry / plugin-manager / search / export / **chat-store / document-service / chat-permissions / chat-queue / tool-registry** |
| L3 视觉框架 | `plugins/shell/` | 9 | app-shell / bg-provider / bg-aurora / bg-solid / bg-image / titlebar / rail / left-list-panel / right-main-panel |
| L4 视觉内容 | `plugins/views/` | 31 | 三视图 + 顶栏/侧栏部件 + 全局搜索 + 设置项（V1~V24 全覆盖） |
| L5 业务功能 | `plugins/features/` | 8 | chat-flow / channel-base / **model-adapter-backend / chat-tools / context-builder** / character-editor / **chat-notify** / official-service |
| L6 可选扩展 | `plugins/extras/` | 2 | markdown-enhancer / **lang-zh-cn（语言包示例）** |
| 后端 | `server/plugins/` | 8 | settings / sessions / models / hub / instance / **plugin-registry（外部插件目录）** / http（+ `server/index.mjs` 引导） |
| **合计** | | **92** | 前端 84 + 后端 8 |

---

## 状态说明

| 状态 | 含义 |
|---|---|
| ✅ | 已实现并默认启用，端到端测试覆盖 |
| 🟡 | 已实现但属于可选（精简后当前没有默认禁用项） |
| ➖ | 已移出内置，后续以独立扩展插件回归 |
| ⏳ | 明确未实现（App 的「设置 → 未实现清单」里登记了原因） |

---

## 关键插件速查

| 插件 | 层 | 状态 | 一句话 |
|---|---|---|---|
| `backend-client` | L1 | ✅ | WebUI ↔ 本地后端的唯一通道（REST / SSE / 健康检查） |
| `model-adapter-backend` | L5 | ✅ | 把后端提供商注册为前端模型（真实流式对话；OpenAI/DeepSeek/Claude/Gemini/Ollama 由后端适配器转换） |
| `session-service` | L2 | ✅ | 会话 + 后端持久化 + 离线降级 + 迁移 |
| `message-service` | L2 | ✅ | 消息与全部 `message:*` 事件 |
| `chat-store` | L2 | ✅ | 渠道消息元数据 / seq / 工作记忆 / Nova 渠道识别 |
| `document-service` | L2 | ✅ | 资料原文入库与按 token 分段读取 |
| `chat-permissions` | L2 | ✅ | 渠道权限表、跨渠道校验、敏感确认、审计 |
| `chat-queue` | L2 | ✅ | 角色级 FIFO 串行队列 |
| `tool-registry` | L2 | ✅ | 通用 function-calling 工具注册表 |
| `chat-tools` | L5 | ✅ | read_messages / chat_send / send_document / read_document |
| `context-builder` | L5 | ✅ | 工作记忆 + 渠道记忆合并、去重、token 预算截断 |
| `settings-item-plugins` | L4 | ✅ | **插件自检、错误/冲突标红、详情、启停** |
| `settings-item-model` | L4 | ✅ | 内置模型开关 + 自定义提供商 / 模型 / 参数管理 |
| `settings-item-data` | L4 | ✅ | 数据目录切换（默认 `user_data/`）、导出、同步、清空 |
| `settings-item-unimplemented` | L4 | ✅ | 未实现功能清单 |
| `bg-image` | L3 | ✅ | 用户上传的自定义背景图（本机压缩保存） |
| `settings-item-code-runner` | L4 | ✅ | JavaScript Web Worker 沙箱（无 DOM / 无网络 / 5s 超时） |
| `chat-flow` | L5 | ✅ | 队列 → 存 → 上下文 → 工具循环 → 回显（含人设 / 推理等级 / 温度 / 文本工具协议兼容） |
| `chat-notify` | L5 | ✅ | 后台或非当前会话收到角色消息时，逐条生成带角色头像 / 名称 / 预览的通知 |
| `character-editor` | L5 | ✅ | 新建 / 编辑会话角色（人格、模型、头像） |
| `permissions` | L1 | ✅ | 插件权限声明、预设与活代理拦截 |
| `global-search` | L4 | ✅ | 全局搜索浮层（会话 / 消息 / 渠道 / 插件 / 设置） |
| `lang-zh-cn` | L6 | ✅ | 简体中文语言包（i18n 实例插件；复制目录改翻译表即可新增语种） |
| `service-container` | L0 | ✅ | 可选中服务工厂（主题/背景/气泡/模型） |

---

## 已移出内置的扩展（后续回归）

| 扩展 | 原插件 | 回归时的参考实现 |
|---|---|---|
| QQ / 微信气泡 | `bubble-qq` / `bubble-wechat` | `plugins/views/bubble-default`（注册到 `bubble-styles`） |
| 音乐播放器 | `music-player` | 挂 `rail:middle` 插槽，用 HTMLAudio |
| 番茄钟 | `pomodoro` | 挂 `rail:middle` + `notification` |
| RSS 阅读器 | `rss-reader` | 后端 `GET /api/rss` 已保留 |
| TTS 朗读 | `tts-reader` | 会话头部插槽 + `speechSynthesis` |
| 翻译 | `translator` | 后端 `POST /api/translate` 已保留 |
| Telegram 渠道 | `channel-telegram` | `channel-base.defineChannel()` + Telegram Bot API（后端需重加适配器） |

> 重新添加扩展的流程：新建 `plugins/.../index.mjs` → `npm run sync-plugins` → 在 `scripts/smoke.mjs` 补端到端断言。

---

## 未实现清单（App 内也有）

| 功能 | 原因 |
|---|---|
| 登录 / 注册 / 官方模型 | 官方服务端由独立官网项目提供，本仓库是纯客户端；模型页已提供内置模型空状态 |
| 多设备云同步 | 需要云端存储与冲突合并 |
| 微信 / Discord / 邮箱 / Telegram 渠道 | 协议与权限问题（添加渠道菜单标注原因） |
| 插件市场 / 在线安装 | 需要服务端索引与签名校验 |
| 代码运行器 | 缺少安全沙箱 |
| 插件权限沙箱 | 插件与内核同进程运行，无法真正隔离；隐私页改为如实说明 |
| 语音输入 | 已接入浏览器 Web Speech API（Chrome / Edge），其他环境仍提示插件扩展 |
| 背景图片上传 | 已支持上传 / 压缩 / 本机持久化 / 切换；裁剪与多图管理未实现 |
| API Key 加密 | 目前只存本机 `user_data/config.json`，未加密 |
| 桌面 .exe 打包 | 方案已写（`docs/DESKTOP.md`），暂缓实施 |


