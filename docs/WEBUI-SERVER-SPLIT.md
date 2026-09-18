<!--
念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
项目全称：念风 Chat（NianFeng-Chat）
仓库：https://github.com/nianfeng233/NianFeng-Chat
-->
# WebUI / 后端终端职责分离

> 本轮架构目标：**后端终端是本体，WebUI 是视觉与操作界面。**
> 打开或关闭 WebUI 都不影响后端实际运行；WebUI 不再在浏览器里重复加载聊天执行引擎。

## 一、运行范围（scope）

每个插件有一个 scope：

| scope | 在哪里加载 | 说明 |
|---|---|---|
| `server` | 后端 / 服务端常驻代聊 Worker | 聊天执行、工具、上下文、记忆等业务核心 |
| `webui` | 浏览器 WebUI | 视图、设置、气泡、背景、交互、前端运维 |
| `both` | 两边都加载 | 内核、基础服务、会话 / 消息 / 渠道 / 模型数据适配、渠道插件 |

### server-only（浏览器不再加载）

- `chat-flow`
- `context-builder`
- `chat-tools`
- `tool-registry`
- `document-service`
- `memory-store`
- `model-service`
- `chat-queue`

### webui-only（后端终端不加载）

- `plugins/views/**`、`plugins/shell/**`、`plugins/extras/**`
- `view-router`、`search-service`、`export-service`、`plugin-manager`
- `character-editor`、`chat-notify`、`plugin-health-guard`
- 新增的 `agent-client`

### 两边都加载

- `plugins/kernel/**`
- `plugins/foundation/**`
- `session-service`、`message-service`、`channel-registry`、`chat-store`、`chat-permissions`、`model-registry`、`image-service`、`user-identity`
- `model-adapter-backend`（后端用于真实调用模型，WebUI 用于模型列表 / 设置页数据）
- `plugins/channels/**`（渠道管理 UI + 渠道消息接入）

外部插件默认 `both`；也可以在 manifest 里声明：

```json
{ "scope": "server" }
```

或模块导出：

```js
export const scope = 'webui'
```

## 二、WebUI 发消息如何交给后端终端

浏览器不再本地执行 `chat-flow`，新增 `agent-client` 插件作为唯一业务代理：

```
composer
  └─ message:send
       └─ agent-client
            ├─ POST /api/agent/send  { conversationId, text, images, clientId }
            │     └─ 后端 hub.broadcast('agent/send')
            │           └─ 服务端代聊 Worker 收到
            │                 └─ Worker 内部 emit('message:send')
            │                       └─ Worker 的 chat-flow / tools / memory / context 正常执行
            │                             └─ 写回 session-service → 后端 sessions/changed(agent=true)
            │                                   └─ 浏览器 session-service 增量合并并渲染
            └─ 后端 /api/agent/status ← Worker 的 chat:request-start / done
                  └─ 浏览器 chat:request-start / done（输入框“生成中 / 停止”）
```

关键接口：

| 接口 | 方向 | 作用 |
|---|---|---|
| `POST /api/agent/send` | WebUI → 后端 | 把浏览器消息投递给后端终端代聊 Worker |
| `POST /api/agent/status` | Worker → 后端 → WebUI | 同步一轮模型处理的开始 / 结束 |
| `POST /api/agent/cancel` | WebUI → 后端 → Worker | 停止生成（映射到 Worker 内部 chat-flow.abort） |
| `sessions/changed (agent=true)` | Worker → 后端 → WebUI | 业务消息与流式结果增量同步到界面 |

回归测试：

- `npm run test:webui-scope`：22 项，验证 WebUI scope 不加载业务执行插件且视觉插件正常；
- `npm run test:agent-bridge`：6 项，启动真实后端 + Mock 模型 + Worker，
  走通「WebUI → /api/agent/send → Worker → chat-flow → chat_send → 后端会话写回」。

## 三、浏览器现在还会加载什么

浏览器启动流程：

1. `index.html` 以 `boot({ scope: 'webui' })` 启动；
2. 插件清单优先使用 `localStorage` 缓存，后台再增量同步；
3. 只 import scope 允许的视觉 / 数据适配插件，业务执行插件完全不进入浏览器；
4. 加载完成后，通过 REST / SSE 拉取会话、设置、模型、记忆等数据。

因此：

- 后端终端启动约 2~3 秒加载核心业务插件；
- WebUI 二次打开通常只做条件请求（304）和少量数据请求，不会再整包重下业务执行代码；
- 业务执行代码（chat-flow / 工具 / 上下文 / 记忆）只在后端终端驻留。

## 四、当前边界与后续可继续收拢

1. 浏览器仍保留 `session-service`、`message-service`、`channel-registry`、`model-registry`、`chat-store`、`chat-permissions`、`image-service` 等**数据适配 / 状态缓存**插件，供视图渲染与设置页读取。它们不执行模型、不调用工具、不构建上下文。
2. 浏览器仍保留三个渠道插件 `index.mjs`，用于渠道管理 UI；真正收发的 `bridge.mjs` 只在后端运行。当后端 `server-agent` 能力在线时，渠道插件会自动让出消息处理权。
3. 如果要做到“浏览器一行业务代码都不加载”，下一步应把 `session-service` / `message-service` 也改成纯 REST 客户端，并把各视图从服务注入改为 API 注入；这会是下一轮更大的重写。
4. 插件管理页当前只能看到 / 管理 WebUI scope 的插件；后端终端插件的管理建议走「后端插件页 / API」扩展，或后续把 `/api/plugins` 的 server 状态合并展示。
