<!--
念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
项目全称：念风 Chat（NianFeng-Chat）
仓库：https://github.com/nianfeng233/NianFeng-Chat
-->
# 聊天链路复盘：一条消息经过了哪些插件

> 目的：验证念风是「全插件实现」——每一步都由独立插件通过事件或服务协作。
> 本文描述当前消息链路：message:send → 会话与消息 → 模型 → 工具循环 → 回显。
> **渠道消息模型 / 工作记忆 / 工具调用循环 / 资料库 / 权限校验**。

## 时序图（Nova 渠道 = WebUI 会话）

```
用户点击发送
  │
  ▼
[composer]  只广播事件，不认识 chat-flow
  │  message-service.requestSend(convId, text)
  │  -> events.emit('message:send', {...}, { interceptor: true })
  ▼
[chat-permissions]  若当前会话有敏感确认在等待：
  │  网页输入框：输入“确认” -> 放行原工具调用
  │  外部渠道：微信clawbot / NapCat 插件先用渠道身份消费“确认”，不会触发模型
  │  输入其它   -> 视为拒绝
  │  两种情况下这条输入都被消费（confirmHandled=true）
  ▼
[chat-flow]  监听 message:send（拦截型事件）
  │  0. 按角色丢进 [chat-queue]（FIFO，同一角色同一时刻只跑一轮）
  │  1. [chat-store].append()  用户消息入渠道记录
  │       message_id / channel_id / seq / timestamp / sender / source / visibility
  │  2. [context-builder].build()
  │       system(人设 + 工具规则 + 时间/时区/渠道)
  │       + 工作记忆(最近 5 轮，仅普通私聊)
  │       + 当前渠道记忆(最近 5 轮)
  │       按 message_id 去重、timestamp 排序、token 预算整轮截断
  │  3. 工具循环（默认最多 10 轮）：
  │       [model-service].stream(messages, { tools, tool_choice })
  │         └─ 后端按提供商类型转换：OpenAI/DeepSeek(chat/completions) / Claude(messages+tool_use) / Gemini(generateContent+functionCall)
  │         └─ [model-adapter-backend] -> /api/chat（SSE，含 tool_call 事件）
  │              └─ 后端 [models]：OpenAI 兼容 / Ollama 的 tools / tool_calls 协议
  │       [chat-tools].execute(...)
  │         · read_messages  读取当前 / 有权限渠道
  │         · chat_send      发送聊天消息（end=true 结束本轮）
  │         · send_document  资料入库，只发引用 + 缩略
  │         · read_document  按 token 分段加载资料原文
  │       assistant.tool_calls + role=tool 结果回填到本轮 messages
  │       chat_send / send_document 返回 end=true -> 结束
  │       模型不返回 tool_calls 时的兼容处理：
  │         · 正文含 <tool_call> JSON / DSML·DSLM 标记 -> 解析成工具调用继续执行
  │         · 识别出工具标记但无法解析 -> 立即撤掉流式内容并拦截，绝不进入气泡
  │         · 普通正文 -> 降级为普通流式回复（兼容不支持工具的模型）
  ▼
[chat-store] -> [message-service]  追加 / 更新消息状态
  │  message:added / message:chunk / message:done / message:error
  ▼
[message-list] 调度渲染；[bubble-default] 负责气泡、代码块、资料卡片、流式光标
  │
  ├─> [session-service] 消息级防抖写回后端（元数据 sessions.json + 聊天原文 chat.db）
  ├─> [composer] 停止生成 / “正在输入”状态
  └─> [chat-notify] -> [notification] 页面在后台 / 不在当前会话时，逐条生成通知（角色消息带角色头像、名称与内容预览）
```

## 每个插件的角色（本轮新增）

| 插件 | 层 | 在这条链路里做什么 | 不做什么 |
|---|---|---|---|
| `composer` | views | 收集输入、广播 `message:send`、停止生成、显示正在输入 | 不存消息、不调模型 |
| `chat-permissions` | domain | 渠道权限表、跨渠道校验、敏感确认、审计日志 | 不执行工具、不存聊天记录 |
| `chat-queue` | domain | 角色级 FIFO 串行队列 | 不理解消息内容 |
| `chat-store` | domain | 渠道标识、消息元数据、seq、工作记忆、历史查询 | 不调模型、不管 UI |
| `document-service` | domain | 资料原文存储、分段读取 | 不进入聊天记录正文 |
| `tool-registry` | domain | 通用工具注册 / 编目 / 执行 | 不认识具体聊天业务 |
| `chat-tools` | features | 把 read_messages / chat_send / send_document / read_document 注册成工具 | 不直接操作模型协议 |
| `context-builder` | features | 工作记忆 + 渠道记忆合并、去重、排序、token 截断、untrusted 包装 | 不负责模型选择 |
| `chat-flow` | features | 串联队列 → 存 → 上下文 → 工具循环 → 收尾；兼容文本工具协议 | 不认识任何具体模型 / 工具实现 |
| `model-service` | domain | `stream / complete` 抽象接口，转发 tools / onToolCall | 不关心 OpenAI / Ollama 差异 |
| `model-adapter-backend` | features | 把后端提供商注册成前端模型，经 `/api/chat` 转发 tools | 不解析具体厂商协议 |
| `backend-client` | foundation | 唯一 REST / SSE 通道，解析 `start/chunk/tool_call/done/error` | 不含业务逻辑 |
| `server/models` | 后端 | 真实上游请求；OpenAI/DeepSeek 的 tools/tool_calls、Claude 的 tool_use/tool_result、Gemini 的 functionCall/functionResponse 与 reasoning 转换 | 不保存聊天记录 |
| `server/http` | 后端 | `POST /api/chat` SSE，转发 chunk / reasoning / tool_call / done | 不执行业务工具 |
| `message-list` + `bubble-default` | views | 渲染消息、资料卡片与流式内容 | 不存数据 |

## 关键事件

| 事件 | 生产者 | 消费者 | 含义 |
|---|---|---|---|
| `message:send` | composer → message-service | chat-permissions / chat-flow（拦截） | 用户请求发送 |
| `chat:request-start/done` | chat-flow | composer、UI / 扩展插件 | 一轮工具循环开始 / 结束 |
| `chat:typing` | chat-tools | composer | 工具发送消息前的“正在输入”状态 |
| `chat:confirm-request/resolved` | chat-permissions | UI 扩展点 | 敏感操作确认 |
| `chat:message-stored` | chat-store | 搜索 / 审计等扩展 | 结构化消息落库 |
| `message:added/chunk/done/error` | message-service | message-list、气泡、通知 | 消息状态变化 |
| `model:start/done/error` | model-service | 日志 / 扩展插件 | 模型层事件 |
| `tool:registered/unregistered` | tool-registry | 调试 / 插件页 | 工具编目变化 |
| `chat-queue:start/finish/cancel` | chat-queue | 对话状态扩展 | 队列状态变化 |
| `provider/status` / `settings/updated` | 后端 → SSE | model-adapter-backend、设置页 | 提供商 / 配置变化 |

## 插件是真实参与，不是摆设

- 把 `chat-tools` 换成别的工具插件，只要有 `tool-registry`，`chat-flow` 不需要改。
- 把 `chat-store` 换成后端渠道存储实现（QQ / 微信就绪后），`context-builder` 与 `chat-tools` 不需要改。
- 把 `bubble-default` 换成任意气泡插件，消息链路不变。
- 把 `model-service` 指向另一个实现（例如本地推理插件），`chat-flow` 不需要改。
- 权限校验在 `chat-permissions` 服务层做，模型只能拿到 `{ok:false,error:"目标渠道不可用"}`，不依赖提示词自觉。
