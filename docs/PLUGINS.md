<!--
念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
项目全称：念风 Chat（NianFeng-Chat）
仓库：https://github.com/nianfeng233/NianFeng-Chat
-->
# 念风插件目录 · 开发定位手册

> 用途：新会话/新工作区里直接按插件定位到具体文件与职责。
> 当前共 **90 个前端内置插件 + 9 个后端插件**（另有 NapCat / 微信clawbot / QQ官方机器人渠道前端 + 图片服务等后端桥）。生成时间：聊天链路一期（工具调用 / 工作记忆 / 权限确认）之后。

---

## 0. 先看这里：运行时与加载

| 位置 | 职责 | 什么时候要改 |
|---|---|---|
| `src/main.mjs` | 启动引导、诊断元素 `#wind-diag`、`__wind_debug` | 改启动流程 / 调试对象 |
| `src/runtime/app.mjs` | 真实 cordis 之上的运行时：插件清单、状态判定、启停、依赖图、**自检 `selfCheck()`** | 改插件状态机 / 自检规则 |
| `src/runtime/compat.mjs` | 插件 ctx 兼容层：`inject/provide/emit/on/effect/registry/events/logger` | 改插件 API 约定（慎改） |
| `src/runtime/semver.mjs` | `depends` 版本判断 | 改依赖版本规则 |
| `scripts/sync-plugins.mjs` | 扫描 `plugins/**/index.mjs` 生成 `plugins/registry.mjs` | 增删插件后必须跑 `npm run sync-plugins` |
| `scripts/smoke.mjs` | 前端端到端测试（241 项，会启动真实后端） | 加插件后补测试 |
| `scripts/test-backend.mjs` | 后端 API 测试（63 项） | 改后端接口后补测试 |
| `scripts/test-clawbot.mjs` | 微信 Clawbot 后端桥测试（本地 mock iLink，26 项） | 改 Clawbot 协议后补测试 |
| `scripts/test-qqbot.mjs` | QQ 官方机器人后端桥测试（本地 mock OpenAPI / q.qq.com 绑定服务，46 项） | 改 QQ 协议、绑定路由、沙箱降级、未绑定提示、图片或被动回复后补测试 |
| `scripts/test-napcat.mjs` | NapCat 后端桥测试（本地 reverse WebSocket mock，25 项） | 改 OneBot 路由 / 连接复用 / 群聊或私聊发送后补测试 |
| `scripts/test-images.mjs` | 图片文件服务测试（保存 / 读取 / 索引无 base64 / 裁剪，8 项） | 改图片存储或 /api/images 路由后补测试 |
| `scripts/test-chat.mjs` | 后端 /api/chat SSE 集成测试（13 项） | 改模型协议后补测试 |
| `scripts/test-chat-tools.mjs` | Nova 工具链路测试（114 项，真实 Mock function calling + DeepSeek reasoning 回传；含 chat.db 持久化检查） | 改工具 / 记忆 / 权限 / 供应商协议后补测试 |
| `scripts/test-vendors.mjs` | 厂商协议测试（30 项：DeepSeek / Anthropic / Gemini / OpenAI 参数降级） | 改厂商适配后补测试 |

插件模块格式（cordis 原生）：

```js
export const name = 'xxx'                 // 唯一 id
export const version = '1.0.0'
export const inject = ['config', 'slots'] // 依赖的服务
export const provides = [{ name: 'yyy', type: 'singleton' }]
export function apply(ctx) { /* ... */ }
```

---

## L0 · 内核层（`plugins/kernel/`，5 个）

| 插件 | 路径 | 职责 | 对外服务 | 修改指引 |
|---|---|---|---|---|
| `event-bus` | `kernel/event-bus/index.mjs` | 事件历史、监听者查询、追踪开关 | `event-bus` | 改调试能力；事件本体在 cordis |
| `plugin-loader` | `kernel/plugin-loader/index.mjs` | 插件状态/依赖图/启停/自检入口 | `plugin-loader` | 插件管理器数据源 |
| `dependency-resolver` | `kernel/dependency-resolver/index.mjs` | 拓扑排序、环检测、批次、`explain()` | `dependency-resolver` | 改依赖解释 |
| `lifecycle` | `kernel/lifecycle/index.mjs` | 阶段时间线、hook、运行时长 | `lifecycle` | 改生命周期统计 |
| `service-container` | `kernel/service-container/index.mjs` | **可选中服务工厂** `createSelectable()` | `service-container` | 主题/背景/气泡/模型切换都基于它 |

---

## L1 · 基础服务层（`plugins/foundation/`，15 个）

| 插件 | 路径 | 职责 | 对外服务 | 修改指引 |
|---|---|---|---|---|
| `storage` | `foundation/storage/index.mjs` | localStorage + 内存降级、命名空间 KV | `storage` | 换存储后端改这里 |
| `config` | `foundation/config/index.mjs` | 点号路径配置、watch、默认值表 `DEFAULTS` | `config` | 新增配置项在这里加默认值 |
| `logger` | `foundation/logger/index.mjs` | **cordis LoggerService 的 exporter**，历史+控制台 | `logs` | 日志级别、日志面板 |
| `i18n` | `foundation/i18n/index.mjs` | 语言包注册 / 切换、`i18n.t()`；具体语种由语言包插件提供 | `i18n` | 新增语种复制 `extras/lang-zh-cn` 改翻译表 |
| `theme-tokens` | `foundation/theme-tokens/index.mjs` + `style.mjs` | `theme` 可选中服务（light/dark/system）、全局 CSS 变量 | `theme`、`theme-tokens` | 改主题变量/深色配色 |
| `slots` | `foundation/slots/index.mjs` | 插槽注册中心（MutationObserver 自动挂载） | `slots` | UI 扩展点机制 |
| `modal-host` | `foundation/modal-host/` | `modal.open/confirm/prompt` | `modal` | 弹窗样式与交互 |
| `context-menu-host` | `foundation/context-menu-host/` | 右键菜单 | `context-menu` | 菜单项与样式 |
| `toast-host` | `foundation/toast-host/` | 轻提示 | `toast` | 提示样式 |
| `tooltip-host` | `foundation/tooltip-host/` | `data-tip` 悬浮提示 | `tooltip` | Tooltip 行为 |
| `keyboard-shortcuts` | `foundation/keyboard-shortcuts/index.mjs` | 快捷键注册/冲突检测 | `shortcuts` | 快捷键注册入口 |
| `notification` | `foundation/notification/index.mjs` | 右下角通知中心（系统 / 角色消息 / 其他）+ 浏览器 / 桌面宿主系统通知 + 提示音 | `notification` | 通知样式与通道 |
| `error-reporter` | `foundation/error-reporter/index.mjs` | 全局错误捕获与记录 | `error-reporter` | 错误上报策略 |
| `backend-client` | `foundation/backend-client/index.mjs` | WebUI ↔ 后端 REST/SSE/健康检查 | `api` | **所有后端接口都从这里进**，改接口先改这里 |
| `permissions` | `foundation/permissions/index.mjs` | 插件权限声明、只读/标准/完全权限预设、服务访问活代理拦截 | `permissions` | 插件权限模型 |

---

## L2 · 业务服务层（`plugins/domain/`，15 个）

| 插件 | 路径 | 职责 | 对外服务 | 修改指引 |
|---|---|---|---|---|
| `session-service` | `domain/session-service/index.mjs` | 会话 CRUD、上下文组装、**后端持久化 + 离线降级 + 迁移** | `session-service` | 会话数据模型/同步策略 |
| `message-service` | `domain/message-service/index.mjs` | 消息增删改、流式追加、状态机、全部 `message:*` 事件 | `message-service` | 消息状态与事件 |
| `model-registry` | `domain/model-registry/index.mjs` | 提供商/模型注册、`model` 可选中服务、`replaceModels()` | `model-registry` | 模型列表结构改动 |
| `model-service` | `domain/model-service/index.mjs` | `stream/complete` 抽象接口、模型未配置时的明确报错 | `model-service` | 调用模型的统一入口 |
| `view-router` | `domain/view-router/index.mjs` | 当前视图、视图注册表、列表宽度记忆 | `view-router` | 新增视图/切视图逻辑 |
| `channel-registry` | `domain/channel-registry/index.mjs` | 渠道类型/实例、分组、拖拽排序、**未实现类型登记 `plannedList`** | `channel-registry` | 渠道模型改动 |
| `plugin-manager` | `domain/plugin-manager/index.mjs` | 插件启停/卸载/统计/`describe()`/`selfCheck()` | `plugin-manager` | 插件管理策略 |
| `search-service` | `domain/search-service/index.mjs` | 全局搜索（会话/消息/渠道/插件/设置） | `search-service` | 搜索源扩展 |
| `export-service` | `domain/export-service/index.mjs` | Markdown / JSON / TXT 导出 | `export-service` | 导出格式 |
| `chat-store` | `domain/chat-store/index.mjs` | 渠道记录、Nova 渠道识别、消息元数据/seq、工作记忆查询 | `chat-store` | 渠道消息模型 / 工作记忆规则 |
| `document-service` | `domain/document-service/index.mjs` | 资料原文存储与按 token 分段读取 | `document-service` | 资料库存储位置 / 分段策略 |
| `chat-permissions` | `domain/chat-permissions/index.mjs` | 渠道权限表、跨渠道校验、敏感确认、审计 | `chat-permissions` | 权限模型 / 确认交互 |
| `chat-queue` | `domain/chat-queue/index.mjs` | 角色级 FIFO 串行队列 | `chat-queue` | 并发与排队策略 |
| `user-identity` | `domain/user-identity/index.mjs` | 统一用户标识：本机配置默认值 + 联网账号插件 `registerProvider()` | `user-identity` | 身份来源与隐私 |
| `tool-registry` | `domain/tool-registry/index.mjs` | OpenAI function-calling 工具注册 / 编目 / 执行 | `tool-registry` | 新增领域工具 |
| `image-service` | `domain/image-service/index.mjs` + `bridge.mjs` + `store.mjs` | 图片文件存储（消息只存 imageId）、压缩、按需转 data URL、/api/images 路由与裁剪 | `image-service`、`imageStore` | 图片存储 / 压缩 / 上下文取图 |

---

## L3 · 视觉框架层（`plugins/shell/`，9 个）

| 插件 | 路径 | 职责 | 修改指引 |
|---|---|---|---|
| `app-shell` | `shell/app-shell/` | `.app` grid 骨架、结构插槽、`data-env` 检测（Electron/Tauri） | 改整体布局 |
| `bg-provider` | `shell/bg-provider/` | `bg` 可选中服务 + 背景图层 | 背景接口 |
| `bg-aurora` | `shell/bg-aurora/` | 绿雾背景（8 光团动画，复刻 demo） | 背景动画 |
| `bg-solid` | `shell/bg-solid/` | 纯色背景 | 新背景实现参考 |
| `bg-image` | `shell/bg-image/` | 自定义背景图（用户上传、本机压缩保存） | 图片背景 / 上传流程 |
| `titlebar` | `shell/titlebar/` | 顶栏容器、三段插槽、窗口拖拽区 | 顶栏结构 |
| `rail` | `shell/rail/` | 侧边栏容器、上中下插槽 | 侧栏结构 |
| `left-list-panel` | `shell/left-list-panel/` | 左玻璃板、拖拽调宽、紧凑模式、圆角衰减 | 左列布局 |
| `right-main-panel` | `shell/right-main-panel/` | 右玻璃板与视图切换 | 右列布局 |

---

## L4 · 视觉内容层（`plugins/views/`，31 个）

### 顶栏与侧栏

| 插件 | 路径 | 职责 | 修改指引 |
|---|---|---|---|
| `brand-widget` (V1) | `views/brand-widget/` | logo + 名称 | 品牌区 |
| `user-widget` (V2) | `views/user-widget/` | 头像 + 签名（config 持久化） | 用户区 |
| `win-buttons` (V3) | `views/win-buttons/` | 窗口三按钮（web 隐藏，Electron 走 `window.windHost.window()`） | 桌面端窗口控制 |
| `rail-nav-buttons` (V4) | `views/rail-nav-buttons/` | 视图导航（从 view-router 动态生成）+ 设置入口 | 侧栏导航 |
| `rail-plugin-slot` (V5) | `views/rail-plugin-slot/` | `rail:middle` 挂载点声明 | 用户插件图标区 |
| `global-search` (V24) | `views/global-search/` | 全局搜索浮层：侧栏入口 + `Ctrl+Shift+F`，聚合会话/消息/渠道/插件/设置结果 | 搜索入口与结果交互 |

### 会话视图

| 插件 | 路径 | 职责 | 修改指引 |
|---|---|---|---|
| `chat-view` (V6) | `views/chat-view/` | 视图入口、主骨架、未选择空状态 | 会话视图结构 |
| `session-list` (V7) | `views/session-list/` | 列表、搜索（Ctrl+K）、新建（Ctrl+N）、右键菜单、**离线模式提示条** | 会话列表交互 |
| `chat-header` (V8) | `views/chat-header/` | 标题/在线状态/更多菜单（导出、清空） | 会话头部 |
| `message-list` (V9) | `views/message-list/` | 滚动区、rAF 合帧、右键复制/删除、**提供 `bubble-styles`** | 消息渲染调度 |
| `bubble-default` (V10) | `views/bubble-default/` | 默认气泡（代码块、双勾、流式光标、译文） | 气泡样式（新气泡插件照抄这里） |
| `composer` (V11) | `views/composer/` | Enter 发送、工具条、高度拖拽、紧凑模式 | 输入区 |

### 渠道视图

| 插件 | 路径 | 职责 | 修改指引 |
|---|---|---|---|
| `channel-view` (V12) | `views/channel-view/` | 渠道视图入口 | 渠道视图结构 |
| `channel-list` (V13) | `views/channel-list/` | 分组/拖拽/右键/添加渠道（未实现类型禁用+原因） | 渠道列表交互 |
| `channel-detail-host` (V14) | `views/channel-detail-host/` | 渠道详情：真实字段 + 连接开关 + 关联会话 | 渠道详情 |

### 设置视图

| 插件 | 路径 | 职责 | 修改指引 |
|---|---|---|---|
| `settings-view` (V15) | `views/settings-view/` | 设置覆盖层、Esc 关闭 | 设置外壳 |
| `settings-container` (V16) | `views/settings-container/` | 设置页注册表、分组导航、页面调度 | 新增设置页先看这里 |
| `official-service`（独立插件，暂不可用） | `features/official-service/` | 账号页 + 官方内置模型 / 计费入口的独立归属；官方服务端未制作时标记暂不可用，禁用后相关入口全部隐藏 | 官方服务接入后在此实现登录 / 内置模型 |
| `settings-item-general` (V17) | `views/settings-item-general/` | 通用设置、语言、调试日志 | 常规开关 |
| `settings-item-model` (V18) | `views/settings-item-model/` | 自定义提供商管理；「使用念风内置模型」区域依赖 `official-service` 服务，插件禁用即隐藏 | 模型页 |
| `settings-item-theme` (V19) | `views/settings-item-theme/` | 主题/背景/强调色/界面细节 + `appearance-page.addSection()` | 外观页 |
| `settings-item-bubble` (V20) | `views/settings-item-bubble/` | 气泡切换（插入外观页） | 气泡选择 UI |
| `settings-item-plugins` (V21) | `views/settings-item-plugins/` | **插件自检、错误/冲突标红、详情、启停** | 插件管理页 |
| `settings-item-shortcuts` (V22) | `views/settings-item-shortcuts/` | 快捷键列表与冲突 | 快捷键 UI |
| `settings-item-about` (V23) | `views/settings-item-about/` | 版本/插件/服务统计 | 关于页 |
| `settings-item-notifications` | `views/settings-item-notifications/` | 通知开关与权限 | 通知设置 |
| `settings-item-network` | `views/settings-item-network/` | 网络状态与超时 | 网络设置 |
| `settings-item-data` | `views/settings-item-data/` | 导出/清理/重置 | 数据设置 |
| `settings-item-privacy` | `views/settings-item-privacy/` | 权限开关 | 隐私设置 |
| `settings-item-code-runner` | `views/settings-item-code-runner/` | JavaScript Web Worker 沙箱（无 DOM / 无网络 / 5s 超时） | 代码片段运行 |
| `settings-item-unimplemented` | `views/settings-item-unimplemented/` | **未实现清单** | 新增未实现项在这里登记 |

---

## L5 · 业务功能层（`plugins/features/`，8 个）

| 插件 | 路径 | 职责 | 修改指引 |
|---|---|---|---|
| `chat-flow` | `features/chat-flow/index.mjs` | 队列 → 存 → 上下文 → 工具循环 → 收尾；人设、推理等级、temperature、原生工具 / 文本工具协议兼容 | 聊天主链路 |
| `chat-notify` | `features/chat-notify/index.mjs` | 监听 `message:added / message:done`；后台或非当前会话时逐条生成角色消息通知 | 消息提醒策略 |
| `plugin-health-guard` | `features/plugin-health-guard/index.mjs` | 启动插件自检，发现红色错误时弹窗并引导到插件设置 | 错误门限与提示文案 |
| `channel-base` | `features/channel-base/index.mjs` | 渠道基座：连接钩子 + 入站消息落库为会话 | 新渠道插件继承它 |
| `model-adapter-backend` | `features/model-adapter-backend/index.mjs` | 把后端提供商注册为前端模型，经 `/api/chat` 流式对话 / 透传 tools | 模型来源与参数传递 |
| `character-editor` | `features/character-editor/` | 新建 / 编辑会话角色：人格、模型、头像（捏人窗口） | 角色系统 |
| `chat-tools` | `features/chat-tools/index.mjs` | `read_messages / chat_send / send_document / read_document` 工具实现 | 聊天工具语义 |
| `context-builder` | `features/context-builder/index.mjs` | 工作记忆 + 渠道记忆合并、去重、token 预算截断、untrusted 包装 | 上下文格式 |

## L6 · 可选扩展层（`plugins/extras/`，2 个）

| 插件 | 路径 | 职责 | 修改指引 |
|---|---|---|---|
| `markdown-enhancer` | `extras/markdown-enhancer/index.mjs` | Markdown 渲染服务（气泡在用） | 增强/精简 Markdown 语法 |
| `lang-zh-cn` | `extras/lang-zh-cn/index.mjs` | 简体中文语言包（i18n 实例插件） | 复制目录改翻译表即可新增语种 |

> 已移除（后续以独立扩展插件回归）：`bubble-qq`、`bubble-wechat`、`pomodoro`、`music-player`、`rss-reader`、`tts-reader`、`translator`、`channel-telegram`。
> 重新添加时的做法：照抄同类插件结构 → `npm run sync-plugins` → 补 `scripts/smoke.mjs`。

---

## 渠道插件（`plugins/channels/`，3 个）

| 插件 | 路径 | 职责 | 修改指引 |
|---|---|---|---|
| `napcat` | `channels/napcat/index.mjs` + `bridge.mjs` | NapCatQQ / OneBot 11 渠道：注册「NapCat」类型、私聊 / 群聊 / 隐私、目标 QQ / 群号、多 QQ 连接复用、黑名单 / 艾特 / 回复概率 / 引用 / 艾特触发者、静默 20 轮群上下文、发现会话 | OneBot 协议 / 连接池 / 群聊规则见插件目录 `README.md` |
| `wechat-clawbot` | `channels/wechat-clawbot/index.mjs` + `bridge.mjs` | 微信 Clawbot 渠道：注册「微信clawbot」类型、添加/编辑窗口（角色 / 分类 / 权限）、扫码登录、入站消息进入角色模型链路、typing 与聊天记录 | 渠道 UI / 协议行为；单独分发见插件目录 `README.md` |
| `qqbot` | `channels/qqbot/index.mjs` + `bridge.mjs` | QQ 官方机器人渠道：注册「QQ官方机器人」类型、q.qq.com 扫码/AppID 接入、**本地沙箱免 IP 白名单**、`user_openid` 自动绑定、WebSocket / Webhook、**仅私聊**、图片收发、被动回复与聊天记录 | 渠道 UI / 协议行为；扫码协议与范围见插件目录 `README.md` 与 `docs/qqbot-plugin.md` |

微信入站消息由插件写入角色对应的 `wechat-clawbot:<channelId>` 渠道记录，再以
`skipUserAppend` 触发 `chat-flow`；等 `chat:request-done`（整轮工具调用彻底结束）后，
才把模型消息发回微信并关闭 typing 状态。

QQ 官方机器人按事件类型区分会话：`C2C_MESSAGE_CREATE`（私聊）/ `GROUP_AT_MESSAGE_CREATE`
（群聊 @）/ `AT_MESSAGE_CREATE`（频道）。桥按 `(sessionType, openid)` 路由到唯一渠道，
每个渠道只订阅一个私聊 openid 或一个群 openid，避免同一机器人被拉群后与私聊串线；
入站消息同样写入 `qqbot:<channelId>` 记录并以 `skipUserAppend` 触发 `chat-flow`，
整轮结束后作为被动消息（带 `msg_id` + `msg_seq`）发回 QQ。

NapCat 一个登录 QQ 只维护一条 OneBot WebSocket 连接，多个渠道通过 `instanceId` 复用；
桥按 `instanceId + targetType + targetId` 路由到渠道。群聊消息无论是否触发模型，
默认都会以 `skipUserAppend` 写入本渠道记录，`context-builder` 对
`contextMode=channel-only` 的渠道只取本群最近 20 轮可见消息，不混入其它私聊工作记忆。

---
## 后端插件（`server/plugins/`，8 个 + 渠道桥 4 个）

| 插件 | 路径 | 职责 | 对外服务 / 接口 |
|---|---|---|---|
| `plugin-registry` | `server/plugins/plugin-registry.mjs` | 内置 + 外部插件目录扫描、清单合并、`/user-plugins` 文件服务、目录选择与删除 | `pluginRegistry`；`/api/plugins*`、`/user-plugins/*` |
| `instance` | `server/plugins/instance.mjs` + `server/data-dir.mjs` | 实例数据目录（默认 `user_data/`，支持切换 / 迁移 / 恢复默认） | `instance`；`GET/PUT /api/data-dir` |
| `settings` | `server/plugins/settings.mjs` | `user_data/config.json` 读写、深合并、凭据脱敏 | `settings`；`GET/PUT /api/config` |
| `sessions` | `server/plugins/sessions.mjs` | `user_data/sessions.json` 会话元数据 + `user_data/chat.db` 聊天原文（内置 SQLite；旧数据自动迁移、无 SQLite 时回退 JSON）、渠道会话复用 | `sessions`；`/api/sessions*` |
| `models` | `server/plugins/models.mjs` | OpenAI 兼容 / DeepSeek 官方 / Anthropic Claude / Google Gemini / Ollama 真实接入；各厂商原生工具调用与 reasoning 转换；`registerProvider()` 预留托管扩展点 | `models`；`/api/providers*`、`/api/chat` |
| `hub` | `server/plugins/hub.mjs` | SSE 客户端管理与广播 | `hub`；`/api/events` |
| `http` | `server/plugins/http.mjs` | 手写路由 REST + SSE + 可选静态托管；提供 `httpApi` 路由 / 能力扩展点 | `http`、`httpApi` |
| `napcat-bridge` | `channels/napcat/bridge.mjs` | NapCat / OneBot 11 连接池（forward WS + 自实现 reverse WS 服务端）、私聊 / 群聊路由、发送、发现会话、通用 `action` 透传；状态写入 `<数据目录>/napcat.json`（token AES-GCM 加密） | `napcat`；自行通过 `httpApi` 注册 `/api/napcat/*` |
| `wechat-clawbot-bridge` | `channels/wechat-clawbot/bridge.mjs` | Clawbot 扫码登录 / getupdates 长轮询 / sendmessage / typing；账号状态写入 `<数据目录>/clawbot.json`（token AES-GCM 加密） | `clawbot`；自行通过 `httpApi` 注册 `/api/clawbot/*` |
| `qqbot-bridge` | `channels/qqbot/bridge.mjs` | QQ 官方机器人 access_token / WebSocket 网关 / Webhook 回调 / 扫码适配器；按 `(sessionType, openid)` 路由与绑定过滤；被动回复 `msg_seq` 管理；账号状态写入 `<数据目录>/qqbot.json`（AppSecret / token AES-GCM 加密） | `qqbot`；自行通过 `httpApi` 注册 `/api/qqbot/*` |
| `image-service-bridge` | `domain/image-service/bridge.mjs` | 图片文件存储与 `/api/images` / `/api/images/:id` / `/api/images/prune` 路由；索引写入 `<数据目录>/images.json`（不含 base64） | `imageStore`；通过 `httpApi` 注册 `/api/images*` |
| （已移除）`telegram` | — | 随 `channel-telegram` 一起移除 | — |

> 后端会在 HTTP 服务就绪后自动扫描 `plugins/channels/**/bridge.mjs` 与外部插件目录里的
> `bridge.mjs` 并加载；渠道插件通过 `httpApi.route()` 注册自己的接口，不需要修改
> `server/index.mjs` 或 `server/plugins/http.mjs`。外部 bridge 是 Node 代码，只应安装可信插件。

保留但暂无前端调用：`GET /api/rss`、`POST /api/translate`（供未来的扩展插件使用，均为真实实现）。

---

## 按需求定位

| 我想改… | 去这里 |
|---|---|
| 启动流程 / 端口 / 代理提示 / 崩溃日志 | `start.mjs`、`start.cmd`、`start.ps1`、`server/index.mjs` |
| 插件状态、启停、自检规则 | `src/runtime/app.mjs#selfCheck/reclassify/enable/disable` |
| 插件管理页的红色/黄色标记与原因 | `plugins/views/settings-item-plugins/{index.mjs,style.mjs}` |
| 外部插件目录 / 扫描 / 安装删除 | `server/plugins/plugin-registry.mjs`、`plugins/views/settings-item-plugins/{index.mjs,style.mjs}` |
| 事件与错误 | `plugins/kernel/event-bus`、`plugins/foundation/error-reporter` |
| 会话与消息数据 | `plugins/domain/session-service`、`message-service`、`server/plugins/sessions.mjs` |
| 模型调用与提供商 | `plugins/features/model-adapter-backend`、`plugins/domain/model-service`、`server/plugins/models.mjs` |
| 聊天工具 / 记忆 / 权限 | `plugins/features/chat-tools`、`context-builder`、`plugins/domain/chat-store`、`chat-permissions`、`chat-queue`、`tool-registry` |
| 界面骨架 / 布局 | `plugins/shell/*` |
| 三视图 UI | `plugins/views/chat-view`、`channel-view`、`settings-view` |
| 主题 / 背景 / 气泡 | `plugins/foundation/theme-tokens`、`plugins/shell/bg-*`、`plugins/views/bubble-default` |
| 桌面端（.exe / 无边框） | `docs/DESKTOP.md`、`plugins/views/win-buttons`、`plugins/shell/app-shell` |
| Windows 使用与排障 | `docs/WINDOWS.md`、`start.cmd`、`install.cmd` |

---

## 模型页改版（用户第 4 点，已实现）

### 目标形态

顶层一个开关 **「使用念风内置模型」**（默认开启）：

* **开启时**：下方展示内置模型列表 + 请求参数（自定义请求体）+ 超时时间。
  * 内置模型来自官方服务端。**官方服务端是独立官网项目，尚未发布**：未接入时列表显示空状态并给出说明（不要做假模型、假登录）。
* **关闭时**：下方整个切换为「自定义提供商」配置页，交互参考 AstrBot：
  * 左侧：提供商列表（新增 / 选择 / 删除），显示名称、Base URL、Key 是否已配置、启停状态。
  * 右侧：当前提供商详情
    * ID、API Key、Base URL（可编辑）
    * 「获取模型列表」→ 调 `POST /api/providers/:id/refresh`（真实拉取）
    * 模型列表：每个模型一行（模型 ID / 显示名 / 启用开关 / 编辑 / 删除 / 新增自定义模型）
    * 每个模型可编辑参数：显示名、上下文长度、temperature、max_tokens、额外请求体（JSON）
    * 「高级配置」折叠区：超时、代理、请求头覆盖

### 涉及的文件（已改）

| 文件 | 改动 |
|---|---|
| `plugins/views/settings-item-model/index.mjs` | 整个页面重写（开关 + 内置模型面板 / 自定义提供商双栏面板） |
| `plugins/views/settings-item-model/style.mjs` | 模型页专用样式（内置面板 + 提供商双栏 + 模型编辑器） |
| `plugins/foundation/backend-client/index.mjs` | 增加模型 CRUD 的 api 方法（addProvider/removeProvider/addModel/updateModel/removeModel/builtinModels） |
| `server/plugins/http.mjs` | 新增路由：`GET /api/builtin/models`、`POST /api/providers`、`DELETE /api/providers/:id`、`POST/PUT/DELETE /api/providers/:id/models[/:modelId]` |
| `server/plugins/models.mjs` | 提供商 / 模型增删改与参数校验；`stream()` 合并模型参数；拉取模型与已有列表按 id 合并；真实代理隧道 |
| `server/plugins/settings.mjs` | provider schema 增加 `models[].params` / `timeoutMs` / `proxy` / `headers`；删除用 `deleted` 标记防止 DEFAULTS 复活 |
| `plugins/features/model-adapter-backend/index.mjs` | 停用模型不注册；模型参数透传到 `/api/chat`；后端删除提供商时注销前端注册表 |
| `plugins/features/chat-flow/index.mjs` | 只有显式设置「思考强度」时才传 temperature，否则遵循模型参数 |
| `plugins/foundation/config/index.mjs` | 新增默认项 `model.useBuiltin` / `model.timeoutMs` / `model.requestBody` |
| `plugins/views/settings-item-unimplemented/index.mjs` | 「登录 / 注册 / 官方模型」更新为部分实现并说明现状 |
| `scripts/smoke.mjs` / `scripts/test-backend.mjs` | 补 UI 与接口测试 |

### 边界与约定

* 未登录 + 开关开启：展示"官方服务未接入"，**不**回退到自定义提供商，也不产生假数据。
* 开关状态持久化到 config：`model.useBuiltin`（默认 true）。
* 自定义提供商沿用现有 `/api/providers/:id`（PUT）与 `settings.providers` 结构，兼容已有用户数据。
* 模型参数为空时必须保持旧行为（默认 temperature 0.7、后端超时 60s）。

### 第二轮补充（已实现）

* 生成参数拆成两个互不相关的紧凑滑块：推理等级 `off / low / high / max`（对应 DeepSeek `thinking` + `reasoning_effort`），以及连续 `temperature` 0-2；样式分别为白→浅绿/蓝/粉（max 带闪点）与浅绿→深绿。
* 自定义提供商左栏拉伸到底，列表项自带删除按钮；检测到旧版后端进程时页面顶部给出「请重启念风」的可操作提示。
* 新增后端 `instance` 插件与 `GET/PUT /api/data-dir`：默认数据目录 `<root>/user_data`，首次启动自动迁移旧 `data/`，设置 → 数据 可切换 / 迁移 / 恢复默认。
* 新增 `bg-image` 插件与外观页背景图上传（压缩后本机保存）；composer 接入 Web Speech API 语音输入。
* 网络 / 隐私 / 数据页移除不生效的假开关，改为真实配置或如实说明；顶栏昵称、后台通知、插件通知开关全部接通。
* API Key 与敏感请求头改为 AES-256-GCM 密文落盘（`user_data/.secret-key`），数据目录迁移会连密钥一起复制。
* 导出服务扩展为 Markdown / JSON / TXT / HTML / CSV / PDF（浏览器打印另存）；设置页新增 JavaScript Web Worker 代码运行器。
* `scripts/stop.mjs`（`npm run stop` / `stop.cmd` / `stop.ps1`）用于关闭无头终端里残留的旧实例；`start.mjs` 启动前会自动检测并关闭端口上的旧念风实例。
* `scripts/test-chat.mjs` + `scripts/mock-openai.mjs` 提供无网络 / 无 Key 的对话链路验证（含推理等级 wire 字段）。
* 聊天链路一期：新增 `chat-store / document-service / chat-permissions / chat-queue / tool-registry / chat-tools / context-builder`；`chat-flow` 升级为工具循环（tools / tool_calls / role=tool），配置项 `chat.*`；`scripts/test-chat-tools.mjs` 用 Mock function calling 走通 Nova 渠道 101 项断言，`scripts/test-vendors.mjs` 用 30 项断言覆盖 DeepSeek / Anthropic / Gemini / 通用 OpenAI 参数降级。
* 新增 `character-editor`：新建会话先弹捏人窗口（人格 / 模型 / 头像），会话头部「更多 → 编辑角色」可再次修改；人设由 chat-flow 注入 system 段落。
* 新增 `permissions` 权限中心：插件声明 `permissions`，只读/标准/完全权限预设 + 按插件开关，`inject` 时下发活代理并可在运行中即时拦截 `api / storage / notification`。

---

## 已知问题 / 技术债（新会话可继续处理）

| 项 | 说明 |
|---|---|
| 偶发 Windows 弹窗 | 已加 `user_data/logs/error.log` 崩溃日志与端口占用友好提示；若复现，先看该日志 |
| 设置页 `settings:page` | 曾因 null 解构报错，现已兼容 `{page}` 与 null |
| API Key / 系统凭据库 | 已改为 AES-256-GCM + `.secret-key` 同目录存储；尚未接入系统 Keychain / DPAPI |
| `channel-registry` 渠道类型 | `wechat-clawbot` 通过 `channel-base.defineChannel()` 注册真实类型；Discord/邮箱仍在 `plannedList` 标注原因 |
| 后端 `/api/rss`、`/api/translate` | 无前端调用，保留给扩展插件 |
| 插件列表排序 | 默认按状态；`installTime` 字段目前恒为 0，未实现真实安装时间 |
| 双配置存储 | 前端偏好走 localStorage（config 服务），后端配置走 `user_data/config.json`；跨端同步未实现 |
| 语义检索 | `read_messages` 的 `semantic` 参数当前回退为关键词；向量索引 / 权限过滤属于方案第三阶段 |
| 厂商高级能力 | OpenAI 兼容 / DeepSeek / Claude / Gemini / Ollama 的常用文本与工具调用已覆盖；Gemini 图片输入、thinkingConfig、thoughtSignature 回传与 Claude 扩展思考签名等高级字段后续按需补 |
| 群聊 / 隐私渠道 | 数据结构（`channelGroup / participatesWorkingMemory / crossReadable`）已留好，尚未接真实渠道插件与静默记录规则 |
| 主题/背景/气泡/模型 | 均为可选中服务，新增实现只需 `register()`，无需改 UI |




