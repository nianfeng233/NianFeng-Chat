<!--
念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
项目全称：念风 Chat（NianFeng-Chat）
仓库：https://github.com/nianfeng233/NianFeng-Chat
-->
# 念风 · 插件化架构（实现版）

> 本文描述当前架构、模块边界与数据流。
> 每一个设计点都标注了代码位置，以及与原草稿的差异。

---

## 一、设计哲学

| 原则 | 实现 |
|---|---|
| **UI 不认识逻辑** | UI 插件只 `ctx.emit('message:send')`；chat-flow 只监听事件，二者互不知道对方存在 |
| **一切通过事件和服务** | 跨插件通信只有 `ctx.emit/on` 与 `ctx.provide/inject`（底层为 cordis 原生服务与事件） |
| **用户能改的都要能换** | 主题、背景、气泡、模型都是 selectable 服务，切换即时生效 |

---

## 二、两个 cordis 应用

念风由两个独立进程/Context 组成，共享同一套插件思想：

### 1. 前端应用（浏览器）

`src/main.mjs` → `src/runtime/app.mjs` 创建 cordis `Context`，把 `plugins/registry.mjs`
里的 82 个模块逐个交给 `ctx.plugin()`。cordis 负责：

* **fiber 生命周期**：每个插件独立 fiber，卸载时自动回收 `provide` 的服务、`on` 的监听、`effect` 的清理
* **依赖注入**：`export const inject = ['config', 'api']`，服务没就绪插件保持 PENDING，就绪后自动激活
* **事件总线 / 日志**：`ctx.emit/on`、`ctx.logger`
* **服务注册**：`ctx.provide()` 自动随 fiber 释放，重复注册由 cordis 直接报错

念风运行时（`src/runtime/`）在 cordis 之上补：

| 能力 | 位置 | 说明 |
|---|---|---|
| 兼容 ctx | `compat.mjs` | `inject()` 无回调取值；`provide()` 记录 owner/type；`emit()` 支持拦截；`effect()` 统一为"注册清理函数"；`registry`/`events` 只读视图；`logger` 带插件名 |
| 插件清单与状态 | `app.mjs` | 把 cordis 的 fiber 状态映射为 active / inactive / error / disabled，并给出原因 |
| 依赖图 | `app.mjs#graph()` | 基于插件名 `depends` 的拓扑排序 + 环检测（服务级依赖交给 cordis） |
| 依赖健康 | `app.mjs#dependencyReport()/list()` | `depends`（必须，缺失标红并阻止激活）与 `optionalDepends`（可选，缺失标黄）的结构化报告，含版本范围与实际版本 |
| 启停 | `app.mjs#enable/disable` | 调 `fiber.dispose()` 或重新 `ctx.plugin()`，状态持久化到 config |
| 语义冲突提示 | `app.mjs#detectSemanticConflicts()` | 插槽拥挤 / 多监听者 / 多实现 |
| 诊断 | `main.mjs` + `#wind-diag` | 状态、错误、告警，供测试与排障 |

### 2. 后端应用（Node）

`server/index.mjs#startBackend()` 创建另一个 cordis `Context`，按顺序加载
`server/plugins/*.mjs`（原生 cordis 插件写法）：

| 服务 | 职责 |
|---|---|
| `instance` | 实例数据目录（默认 `user_data/`，支持切换 / 迁移 / 恢复默认） |
| `settings` | `user_data/config.json` 读写、脱敏、深合并 |
| `sessions` | `user_data/sessions.json` 会话元数据 + `user_data/chat.db`（内置 SQLite）聊天原文、渠道会话复用 |
| `models` | 提供商适配器（OpenAI 兼容 / DeepSeek 官方 / Anthropic / Gemini / Ollama），真实 `listModels / test / stream`、各厂商 tools / tool_calls / reasoning 转换、参数降级重试、提供商 / 模型 CRUD、模型参数与代理 |
| `hub` | SSE 客户端管理与广播 |
| `http` | 手写路由的 REST + SSE API，可选静态托管（单端口模式） |

前端只通过 `backend-client` 插件（`/api`）（`plugins/foundation/backend-client`）访问后端。

---

## 三、插件模型

```js
// plugins/features/model-adapter-backend/index.mjs（节选）
export const name = 'model-adapter-backend'
export const version = '2.0.0'
export const inject = ['api', 'model-registry', 'config', 'toast']
export const provides = []

export function apply(ctx) {
  const api = ctx.inject('api')
  ctx.on('backend:status', ({ online }) => { if (online) sync() })
  ctx.provide('model-adapter', { sync, refresh })
}
```

* 模块 `apply(ctx)` 就是 cordis 的插件入口；`inject` / `provides` / `depends` 是清单元数据。
* `ctx` 是 `compat.mjs` 生成的兼容视图，原型指向该插件 fiber 的真实 cordis Context。
* `ctx.effect(fn)` 语义：**把 fn 注册为卸载清理函数**（cordis 原生是 `effect(execute)` 立即执行并注册返回值，兼容层做了统一）。

> **范围说明**：念风仓库是**纯客户端单机项目**。官方服务端（账户体系 / 官方模型 / 计费）由
> 独立的官网项目提供，不包含在本仓库内，也不做本地模拟。后端 `models.registerProvider()`
> 是保留给未来"托管提供商"的扩展点；官网项目发布后，客户端只需新增一个调用方插件。

### 服务类型

| 类型 | 注册方式 | 行为 |
|---|---|---|
| singleton | `ctx.provide('x', impl)` | 第二个 owner 会抛 `ConflictError`，插件标记 inactive |
| multi | `ctx.provide('x', impl, { type: 'multi' })` | 多 owner 共存（台账展示） |
| selectable | `service-container.createSelectable(name)` | 多实现，用户可选，activeId 持久化在 `selectable.<name>.activeId` |

当前 selectable：`theme`、`bg`、`bubble-styles`、`model`。

聊天链路新增的服务：`chat-store`（渠道记录）、`document-service`（资料库）、
`chat-permissions`（权限 / 确认 / 审计）、`chat-queue`（角色级队列）、
`tool-registry`（工具编目执行）、`chat-tools`（聊天工具集）、
`context-builder`（记忆合并与 token 截断）。它们之间只通过服务与事件协作。

---

## 四、事件

前端事件遵循 `命名空间:动作`，全部经兼容层分发（同时写事件索引，供插件管理器统计）：

| 事件 | 触发者 | 载荷 |
|---|---|---|
| `message:send`（拦截型） | composer → message-service | `{ conversationId, text }`，敏感确认消费时带 `confirmHandled` |
| `chat:request-start / done` | chat-flow | 一轮工具循环的开始 / 结束 |
| `chat:typing` | chat-tools | `{ conversationId, channelId, typing }` |
| `chat:confirm-request / resolved` | chat-permissions | 敏感操作确认 |
| `chat:message-stored` | chat-store | `{ conversationId, channelId, message }` |
| `chat:permission-changed` / `chat:audit` | chat-permissions | 授权 / 审计变化 |
| `tool:registered / unregistered` | tool-registry | `{ name }` |
| `chat-queue:start / finish / enqueue / cancel` | chat-queue | 队列状态 |
| `message:added / chunk / done / error / updated / delete` | message-service | 消息对象或 `{ conversationId, message }` |
| `conversation:switch / create / delete / update / sync` | session-service | 会话对象或 `{ id }` |
| `view:registered / switch / changed / ready` | view-router | `{ view }` |
| `channel:add / activated / status / message / moved` | channel-registry / channel-base | 渠道对象或 `{ channelId, message }` |
| `backend:status` / `backend:event` | backend-client | 后端状态 / 后端 SSE 事件 |
| `models:synced` / `model:provider-registered` / `model:models-updated` | model-registry / model-adapter | 模型同步结果 |
| `plugin:loaded / enabled / disabled / error / inactive / warning` | runtime | `{ id, ... }` |
| `provider/status` / `sessions:source` / `error:reported` … | 各自插件 | — |

后端事件（`/api/events`）：`channel:message`、
`provider/status`、`chat/start|done|error`、`sessions/changed`、`settings/updated`。

### 微信 Clawbot 渠道

`wechat-clawbot` 插件是当前唯一内置的真实渠道：

- 前端 `plugins/channels/wechat-clawbot/index.mjs` 负责类型注册、添加/编辑窗口、详情与扫码；
- 后端 `plugins/channels/wechat-clawbot/bridge.mjs` 负责 iLink 登录、`getupdates` 长轮询、`sendmessage` 与 typing；
- 入站消息落为 `wechat-clawbot:<channelId>` 渠道记录后触发 `chat-flow`；
- `chat:request-done`（整轮工具调用结束）之后才发送微信回复并调用 `sendtyping status=2`。
---

## 五、数据流

### 一条消息（Nova 渠道 / 工具调用）

```
composer ──message:send──▶ chat-permissions（敏感确认拦截）
   └─▶ chat-flow
        ├─ chat-queue.enqueue(roleId)         角色级 FIFO，同一角色串行
        ├─ chat-store.append()                用户消息入渠道记录（message_id/seq/timestamp）
        ├─ context-builder.build()            工作记忆 + 渠道记忆 + system 工具规则
        ├─ 工具循环（最多 chat.maxToolRounds 轮）
        │    ├─ model-service.stream(tools) ──▶ model-adapter-backend ──▶ POST /api/chat
        │    │        └─ 上游 SSE/NDJSON ──▶ chunk / tool_call ──▶ 前端汇总 tool_calls
        │    ├─ tool-registry.execute() ──▶ chat-tools
        │    │        ├─ read_messages
        │    │        ├─ chat_send ──▶ chat-store.append() ──▶ 消息气泡
        │    │        ├─ send_document ──▶ document-service（聊天记录只存引用）
        │    │        └─ read_document（role=tool 分段返回原文）
        │    └─ chat_send / send_document end=true -> 结束本轮
        └─ 模型完全不返回 tool_calls -> 降级为普通流式回复（兼容小模型）
session-service 在新增 / 更新消息后防抖写回 /api/sessions/:id
```

> 工具调用历史使用合法的 `assistant.tool_calls` + `role=tool` 结构，只在处理本轮的内存中流转；
> 聊天记录库保存的是工具最终发给用户的消息（含完整渠道元数据），而不是工具调用协议本身。

### 会话持久化（在线 / 离线）

```
启动：GET /api/sessions
  ├─ 后端为空 && 本地有历史 → 逐个 POST /api/sessions（迁移，不丢数据）
  ├─ 后端有数据 → 以后端为准，替换本地缓存
  └─ 请求失败 → source = local（列表顶部显示「离线模式」，可点重试）
写入：任何修改 → 本地缓存 + 防抖 PUT /api/sessions/:id（500ms）
```

## 六、加载顺序

`App.loadAll()`：

1. 动态 `import` 所有插件模块，收集 manifest（name/version/inject/provides/depends/enabled）
2. 按插件名 `depends` 做拓扑排序（环 → 全部标记 inactive）
3. 用户禁用 / 默认关闭 → 标记 disabled
4. 逐个 `ctx.plugin()`：依赖不满足的由 cordis 保持 PENDING
5. `settle()` 轮询 fiber 状态，`reclassify()` 回填 active / inactive / error / disabled
6. 对所有 active 插件调用 `start()` 钩子
7. 语义冲突启发式检测 → 写入插件管理器与诊断

失败处理与文档 §9.2 一致：单个插件失败不影响其他插件，原因可见于「设置 → 插件」。

---

## 七、开发注意事项（文档 §10 落地）

| 事项 | 落地 |
|---|---|
| 事件命名 | `命名空间:动作` |
| 服务命名 | kebab-case，禁止与 cordis 内置属性同名（`logger`/`events`/`registry`/`config` 等已改用 `logs`/`event-bus`） |
| 内存管理 | 所有 `ctx.on / effect / setTimeout / slots.register` 随 fiber 自动释放 |
| 性能 | 消息列表 rAF 合帧；会话写回防抖 500ms |
| 用户数据 | 前端 config/storage 服务 + 后端 `user_data/*.json`，不散落 localStorage |
| 样式 | `useStyle(ctx, css)` 注入 `<style data-plugin>`，卸载移除；颜色只取 CSS 变量；玻璃板透明度由 `--glass-alpha-*` 变量控制 |
| 调试 | `__wind_debug`、`#wind-diag`、后端 `/api/logs` |
| 敏感数据 | 只存后端本机文件；接口脱敏；API Key 与敏感请求头用 AES-256-GCM 加密 |
| 测试 | `npm test`：模块检查 + 后端 63 项 + 安全回归 39 项 + 前端 189 项 + 对话链路 13 项 + Nova 工具链路 101 项 + 厂商协议 30 项 |

---

## 八、cordis 兼容层与升级边界（已知架构债）

前端 `src/runtime/compat.mjs` 在 cordis `Context` 上做了一层兼容视图，这是当前有意为之、
但也必须正视的架构债：

| 项目 | cordis 原生语义 | 念风兼容层语义 | 影响 |
|---|---|---|---|
| `ctx.effect(fn)` | 立即执行 `fn`，把返回值注册为 disposer | 把 `fn` 注册为卸载时才执行的清理函数 | 两边写法相反，迁移插件时必须逐个改 |
| `ctx.inject(deps, cb)` | 仅回调形式 | 同时支持直接取值 / 返回对象 | 与 cordis 的 fiber 依赖时机不同 |
| `ctx.provide(name, value)` | 随 fiber 自动释放 | 额外维护 owner / type 台账与冲突检测 | 台账逻辑要跟随 cordis 内部结构变化 |
| 服务名 | 内置 `logger` / `events` / `registry` / `config` | 改用 `logs` / `event-bus` 等避免同名 | 生态插件按 cordis 命名接入时需要适配 |

**升级策略（在完成整体迁移前）**：

1. `package.json` 固定 cordis 版本，不跟随 `^` 自动跨 rc / 小版本升级；
2. 每次升级 cordis 前先跑 `npm run check:kernels`、`npm test`（含 `test:security`）与桌面端烟测；
3. 新插件优先使用与 cordis 语义一致的两层 `ctx.effect(() => () => cleanup())` 写法（后端
   `server/plugins/*.mjs` 已经是这种写法），不要继续扩大兼容层面积；
4. 中长期目标是把前端 93 个内置插件按“原生 `effect` / 原生 `inject` / 服务改名”分批迁移，
   迁完一批删除一批兼容分支，而不是一次性重写。

---

## 九、安全模型（v1.1.7 加固后）

- 默认只监听 `127.0.0.1`；开放监听必须同时处理访问令牌与白名单；
- `Host` / `Origin` 双重校验；CORS 精确回显白名单 Origin；不返回通配 `*`，阻挡 DNS rebinding；
- `?token=` 只作为 HTML 首屏换 Cookie 的引导，API 只认 Cookie / `X-NianFeng-Token` / `Authorization`；
- `/api/health`、`/api/version` 作为探活入口；配置令牌后，health 的目录 / 配置 / 提供商 / 会话详情
  只对通过校验的请求返回；
- `/api/rss` 走 SSRF 安全网（私有 / 环回 / 链路本地 / 元数据地址、重定向与 DNS 逐跳校验）；
- 令牌比较使用 SHA-256 + `timingSafeEqual` 常量时间实现；
- 静态资源用 `path.relative` 做目录边界判断，`startsWith` 前缀绕过已移除。

安全回归测试：`npm run test:security`。

