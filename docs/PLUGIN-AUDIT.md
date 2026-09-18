<!--
念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
项目全称：念风 Chat（NianFeng-Chat）
仓库：https://github.com/nianfeng233/NianFeng-Chat
-->
# 工作区插件 / 工具审计（本轮大更新）

> 本文对应本轮「底层架构优化 → 上下文构建 → 插件检查」三阶段改动。
> 目标是把工作区里的**本体项目**、**内置插件**、**外部插件源码 / 已安装副本**和
> **模型工具**放在一张图里，标出重复、相似和可以收拢的地方。

## 一、结论速览

| 优先级 | 问题 | 本轮处理 |
|---|---|---|
| 1 | 插件热插拔不完整，安装 / 卸载 / 更新经常需要刷新或重启 | `App.syncEntries()` 运行期热同步；外部插件 mtime 版本号变化会重新 import；禁用上游会级联停用依赖者，恢复后自动拉回；服务端代聊 Worker 改为消息通知热同步，不再整体重启 |
| 2 | 远程 WebUI 每次刷新都要重下全部插件，首屏慢 | 插件模块并发导入、禁用插件完全不 import；静态资源加 ETag / Last-Modified / gzip；带 `?v=` 的插件模块长期强缓存 |
| 3 | 页面停留一段时间偶发“加载失败”，切出再切入才好 | 只读 GET 自动重试；模型设置页保留上次成功数据并指数退避重试；后端状态抖动不再清空表单 |
| 4 | 群聊人设漂移、把上一轮旧话题当成现在 | 人设移到 system prompt 偏后位置；增加角色名 / 群聊身份提示；每条消息标注 `scope` 和 `is_current_request`；跨渠道工作记忆默认限流 2 轮 |
| 5 | 日志重复、来源混乱 | 前端日志带 `clientId`，后端与日志页按 clientId 去重；HTTP 成功访问日志继续默认隐藏 |
| 6 | 插件项目重复 / 可收拢 | 两套二维码 vendor 已合并到 `src/vendor/qrcode`；其余重叠项见第四节 |

## 二、本体项目（`<workspace>`）

- 版本：`v2.0.0`（preview 分支工作区）
- 内核：cordis v4（前端 + Node 后端两个 Context）
- 前端插件目录：`plugins/`，当前 95 个内置插件
- 后端服务：`server/plugins/*.mjs`（settings / sessions / models / hub / http / memories / logs / plugin-registry / instance）
- 外部插件桥：`server/index.mjs#createExternalBridgeLoader` 自动扫描外部插件目录的 `bridge.mjs`，安装 / 删除 / 重扫时热加载
- 服务端代聊：`src/headless/runtime.mjs` Worker，本轮改为跟随 `plugins/changed` 热同步

### 内置插件分布（95 个）

| 层 | 数量 | 职责 | 代表插件 |
|---|---:|---|---|
| `kernel/` | 5 | 依赖解析、事件总线、生命周期、插件加载、服务容器 | plugin-loader、event-bus |
| `foundation/` | 16 | 配置、存储、日志、主题、弹窗 / Toast / 提示、权限、i18n、后端通道 | config、storage、backend-client |
| `domain/` | 19 | 会话、消息、渠道、聊天记录、记忆、模型、工具、图片、资料、导出、搜索 | session-service、chat-store、memory-store、model-service |
| `features/` | 8 | 聊天主链路、上下文构建、工具集、角色编辑、模型适配、通知、健康守卫 | chat-flow、context-builder、chat-tools |
| `channels/` | 3 | NapCat / QQ 官方机器人 / 微信 Clawbot 渠道 | napcat、qqbot、wechat-clawbot |
| `views/` | 27 | 设置页、聊天页、消息气泡、搜索、库页面、侧栏按钮 | settings-item-model、message-list、library-view |
| `shell/` | 10 | 外壳布局、背景、标题栏、移动端壳、左侧列表 | app-shell、bg-provider、mobile-shell |
| `extras/` | 3 | 中文包、Markdown 增强、NapCat 输入状态 | lang-zh-cn、markdown-enhancer |

### 核心工具（模型可见）

由 `tool-registry` 统一注册，`context-builder` 只把**当前真实注册**的工具写进 system prompt：

| 工具 | 提供方 | 说明 |
|---|---|---|
| `read_messages` | chat-tools | 当前 / 有权渠道的消息检索，支持关键词、seq、时间、semantic |
| `search_memory` | chat-tools + memory-store | 角色长期记忆概括的向量 / BM25 / 时间混合召回 |
| `chat_send` | chat-tools | 日常回复，messages 数组逐条气泡发送 |
| `send_document` | chat-tools + document-service | 长资料 / 代码 / 文章，进资料库后按聊天记录转发 |
| `read_document` | chat-tools + document-service | 按 token 分段读取资料原文 |
| `read_forward` | chat-tools | 合并转发记录分页深读 |
| `napcat_*` | 外部 `group-chat-tools` | 群成员 / @ / 管理 / 公告 / 群资料，仅在安装该扩展后出现 |
| 其它 `*` | 外部扩展 | github-hub、media-post、web-access、social-bridge 等自行注册，未安装则不会进入提示词 |

## 三、工作区插件项目清单

### 1. 随版本发布的内置插件

`plugins/**` 下的 95 个目录，升级 exe / release 时整体替换。第三方不要在
这一层长期放自己的插件。

### 2. 外部插件源码（`extensions/`，规范源）

| 项目 | 版本 | 依赖 / 用途 | 备注 |
|---|---|---|---|
| `github-hub` | 1.1.4 | GitHub 仓库订阅、卡片预览、Issue 分析 | 前端 + bridge |
| `group-chat-tools` | 1.0.2 | NapCat 群成员 / @ / 管理 / 公告工具 | 依赖内置 napcat |
| `knowledge-base` | 1.1.x | 知识库条目存储与检索 | 前端 + bridge |
| `media-post` | 1.0.0 | B站 / 抖音媒体点播 | 依赖 web-access |
| `napcat-group-guard` | 1.1.9 | 入群审核、黑名单、不活跃清理、档案图 | 前端 + bridge |
| `social-bridge` | 1.1.x | 邮箱等社交桥 | 前端 + bridge |
| `web-access` | 1.1.x | 联网搜索 / 网页读取 / 站点解析 | media-post 的前置 |

### 3. 已安装副本（`user_data/plugins/`，运行数据目录）

本机已安装：`github-hub`、`group-chat-tools`、`media-post`、`social-bridge`、`web-access`。
需要注意：

- 已安装副本不一定等于 `extensions/` 的最新版本。例如 `group-chat-tools` 在
  `extensions/` 是 **1.0.2**，已安装副本是 **1.0.0**；`github-hub` 也经历过
  多个小版本。建议在「设置 → 插件 → 添加插件」里重新上传对应版本的 zip，或
  用目录对比后手工覆盖。
- `user_data/` 属于本机数据目录，不随 git 发布；不要把它的内容当项目源码提交。

### 4. 工作区中的测试 / 历史副本（`.tmp/`）

`.tmp/` 下有大量历史打包、`github-hub` 多版本、MemMachine 与知识库测试副本。
它们只是测试产物，不参与运行；建议在版本发布前清空，避免审计时误判“重复项目”。
本轮未删除任何 `.tmp` 内容，以免影响既有测试快照。

## 四、功能重叠 / 可优化项

### 已处理

1. **二维码实现重复**：`plugins/channels/qqbot/vendor/qrcode` 与
   `plugins/channels/wechat-clawbot/vendor/qrcode` 原本是 10 个文件、约 100KB 的
   逐字节重复。已合并到 `src/vendor/qrcode`，两个渠道的 `qrcode.mjs` 只做 re-export。
2. **插件清单重复请求**：WebUI 启动时原本每个插件模块串行请求且禁用插件也 import；
   现在按 `/api/plugins` 清单元数据先建记录，只并发 import 启用的模块。
3. **日志源重复**：前端 `logs.history` 与后端 `runtime.log` 会各显示一次同一条日志；
   现在前端日志带 `clientId`，后端和日志页两级去重。

### 观察 / 后续建议

| 相似项 | 关系判断 | 建议 |
|---|---|---|
| 内置 `napcat` 的群工具提示 vs 外部 `group-chat-tools` | **不是重复实现**：内置 NapCat 负责渠道收发与设置，外部 group-chat-tools 才注册 `napcat_group_*` 工具；context-builder 只展示真实注册的工具 | 保持现状；若未来内置渠道要自带群工具，先下线外部同名注册，避免 `tool-registry` 冲突 |
| `group-chat-tools` vs `napcat-group-guard` | **部分重叠**：成员搜索 / 群资料查询两边都有，guard 偏自动审核和清理，group-chat-tools 偏手动群管 | 长期可把“成员解析 / 群资料查询”抽成共享服务；短期保持独立，避免大改已稳定插件 |
| `web-access` vs `search-service` / `global-search` | **不同层**：前者是模型外部联网工具，后者是 WebUI 本地搜索 | 不需要合并 |
| `knowledge-base` + `library-view` | **配套关系**：bridge 存条目、library-view 展示；条目接口缺失时 UI 会自动标记不可用 | 保持配对发布 |
| `notification` / `chat-notify` / `toast-host` | **不同生命周期**：系统通知、聊天消息通知、操作提示 | 不要合并；若做统一“通知中心”只做 UI 聚合 |
| `error-reporter` vs `logger` | reporter 负责用户可见错误，logger 负责落盘 / 终端 / SSE | 可让 reporter 的 errorId 进入 logger，方便关联，无需合并 |
| `plugins/foundation/*` 多个 host（modal / toast / tooltip / context-menu） | 都是独立 UI 原语，依赖面不同 | 保持独立 |

### 目录 / 版本卫生

- `.tmp/`：建议定期清理；如保留，请在每个子目录写清楚“测试快照”。
- `extensions/` 是规范源，`user_data/plugins/` 是已安装副本；两者版本差异需要
  在每次扩展发版后用「添加插件 → 覆盖安装」收口。
- `release/` 与打包产物不要与外部插件源码混放。

## 五、本轮架构改动落点

| 文件 | 改动 |
|---|---|
| `src/runtime/app.mjs` | 并发导入、禁用插件延迟 import、`syncEntries` / `reloadPlugin` / `removeRuntimeRecord`、级联启停、`manifestFromEntry` |
| `src/main.mjs` | 插件清单缓存秒开 + 后台热同步、启动进度文案、`plugins:changed` 监听 |
| `src/headless/runtime.mjs` | `boot({ awaitRemote: true })`；父进程消息驱动热同步 |
| `start.mjs` | 插件变化不再重启代聊 Worker；静态资源 ETag / gzip |
| `server/static-cache.mjs` | 静态资源缓存 / 压缩 / 条件请求新模块 |
| `server/plugins/http.mjs` | 单端口静态托管、`/user-plugins/*` 接入新缓存策略 |
| `plugins/kernel/plugin-loader` | 暴露 `sync / reloadPlugin / removePlugin / hardReload` |
| `plugins/domain/plugin-manager` | 运行期 `sync()`、启停后 flush 偏好 + 重扫外部 bridge（不再重启代聊）、事件通知插件页重绘 |
| `plugins/views/settings-item-plugins` | 安装 / 删除 / 重扫 / 切换目录改为热同步，不再 `location.reload()` |
| `plugins/foundation/backend-client` | GET 自动重试、订阅 `plugins/changed` |
| `plugins/features/context-builder` | 人设 / 群聊身份 / 跨渠道限流、`scope` 与 `is_current_request`、当前请求标注 |
| `plugins/foundation/config` | 新增 `chat.crossChannelMemoryRounds`（默认 2） |
| `plugins/views/settings-item-model` | 保留上次成功数据、指数退避重试、编辑态保护、后端状态只在恢复在线时刷新 |
| `plugins/foundation/logger` + `server/plugins/logs.mjs` + 日志页 | `clientId` 全链路去重 |
| `scripts/test-hot-plugins.mjs` | 新增热插拔回归测试（16 项） |
| `src/runtime/plugin-scope.mjs` + `docs/WEBUI-SERVER-SPLIT.md` | 插件运行范围拆分：浏览器只加载视觉 / 数据适配插件，业务执行插件全部留在后端终端 |
| `plugins/features/agent-client` + `/api/agent/send|status` + `src/headless/runtime.mjs` | WebUI → 后端终端代聊桥：浏览器不再执行 chat-flow，消息统一交给后端 Worker |
