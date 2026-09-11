# 当前状态核对（截至本轮结束）

> 给下一个会话的工作交接。详细链路见 `docs/CHAT-FLOW.md`，插件清单见 `docs/PLUGIN-LIST.md`。

## 本轮（聊天链路 · 方案第一阶段）

按 `docs/LEGACY-DESIGN.md` 落地了聊天主链路，WebUI 会话即 `nova:web:<会话id>` 渠道。

### 新增插件（7 个，全部 core）
- `chat-store`（L2）：渠道记录、nova 渠道识别、消息 `message_id / seq / timestamp / sender / source / visibility`、工作记忆查询。
- `document-service`（L2）：资料原文存储、按 token 分段读取；聊天记录只存 `doc_id + 标题 + 缩略`。
- `chat-permissions`（L2）：`role_id / user_id / source_channel / target_channel / can_read / can_send / can_cross_read / can_cross_send` 权限表；跨渠道统一返回“目标渠道不可用”；敏感操作输入“确认”同意、其它内容拒绝；审计日志。
- `chat-queue`（L2）：角色级 FIFO 串行队列，同一角色同一时刻只跑一轮；`cancelCurrent` 对应“停止生成”。
- `tool-registry`（L2）：通用 OpenAI function-calling 工具注册 / 编目 / 执行。
- `chat-tools`（L5）：`read_messages / chat_send / send_document / read_document` 四个工具。
- `context-builder`（L5）：工作记忆（最近 5 轮普通私聊）+ 渠道记忆（最近 5 轮）合并去重、按 timestamp 排序、token 预算整轮截断；用户内容按 `trust=untrusted` 紧凑 JSON 包装；system 注入人设 / 工具规则 / 当前时间 / 时区 / 渠道。

### 链路改造
- `chat-flow` 升级为工具循环编排器：队列 → 存用户消息 → 上下文 → `model-service.stream(tools)` → `tool_calls` → `chat-tools.execute` → 直到 `end=true` 或达到 `chat.maxToolRounds`。
- 工具历史使用合法的 `assistant.tool_calls` + `role=tool` 内存结构；assistant 直出正文按方案丢弃。
- **兼容降级**：模型不返回 tool_calls 时，先尝试把正文里的 `<tool_call>` JSON / DSML·DSLM 标记解析成工具调用继续执行；识别出工具标记但无法解析时，立即撤掉流式内容并拦截，绝不进入气泡；只有普通正文才回退为普通流式回复。
- **旧后端提示**：后端健康检查新增 `tools` 能力位；前端发现旧进程未支持时会提示重启，并自动按文本工具协议兼容。
- 后端 `server/models` 增加厂商适配：
  - **OpenAI 兼容**：tools / tool_calls 流式解析，并对 `tool_choice` / `max_tokens` / `max_completion_tokens` / `temperature` / `stream_options` 做参数降级重试；
  - **DeepSeek 官方**（对齐官方 `deepseek-harness`）：不发送 `tool_choice`，`reasoningEffort` 映射 `thinking` + `reasoning_effort`，流式 `reasoning_content` 捕获并在后续工具轮原样回传；
  - **Anthropic Claude**：`tools[].input_schema`、assistant `tool_use`、user `tool_result` 与流式 `input_json_delta` 全链路；
  - **Google Gemini**：`functionDeclarations`、`functionCall` / `functionResponse`、`toolConfig.mode` 与流式 function call 解析；
  - **Ollama**：tools / tool_calls 与 `message.thinking`。
- `server/http` 的 `/api/chat` SSE 新增 `tool_call` 事件，`done` 带完整 `toolCalls`。
- `backend-client` / `model-service` / `model-adapter-backend` / `message-service` 透传 tools、工具调用回调和结构化消息字段。
- 气泡对 `kind=document` 的资料消息做卡片区分；输入区新增“正在输入…”状态。
- 配置新增：`chat.toolsEnabled / chat.toolChoice / chat.maxToolRounds / chat.contextTokens / chat.memoryRounds / chat.channelRounds / chat.readTokens / chat.confirmSensitive / chat.simulateTyping / chat.userId`。

### 本轮交互修复与补充
- 修复“正在输入”提示始终显示：`.typing-hint[hidden]` 现在真正隐藏。
- 修复“清空消息”无反应：消息区现在监听 `conversation:update` 并同步重渲染。
- 模型思考期间显示三点占位气泡；工具真正发送消息前移除，资料/多条消息不会留下占位。
- 聊天消息动态延迟：首条不延迟，之后按字数在 0.5s ~ 5s 之间动态计算，可在设置调整下限/上限/每字延迟。
- 严格工具模式（默认开启）：模型直接输出正文时丢弃并发送系统纠正重试；多次未调用工具则终止本轮，保证用户不会看到绕过工具协议的正文。
- 修复多轮上下文错乱：占位 / 降级消息现在先写入真实 timestamp 再 finish，渠道内改为 seq 优先排序；`context-builder` 不再把错误消息和自动推导的未来时间戳带进历史。
- 新增工具协议轨迹：每轮真实的 `assistant.tool_calls` + `role=tool` 存入 chat-store，下一轮按协议格式回放，模型能看到自己真实的工具调用历史。
- 新增 设置 → 聊天记录：图形视图逐条编辑 + JSON 源码双模式；所有修改先进草稿，支持单条确认 / 取消与整体保存 / 取消，保存前做格式校验。

### 测试
- `npm run test:chat-tools`：真实 Mock OpenAI function calling ↔ 后端 ↔ WebUI 插件链路，101 项（含 DeepSeek thinking / reasoning_content 回传、严格工具模式、多轮上下文排序、工具协议轨迹、动态延迟、图形化聊天记录编辑器）。覆盖 nova 渠道元数据、read_messages、chat_send、send_document、read_document、跨渠道拒绝、工作记忆合并、敏感确认、工具不支持时降级、DSML·DSLM 文本工具协议解析、无法解析标记拦截。
- `npm run test:vendors`：DeepSeek / Anthropic / Gemini 协议转换 + 通用 OpenAI 参数降级，30 项。覆盖 DeepSeek thinking/reasoning_content/不发送 tool_choice、Claude tool_use/tool_result、Gemini functionCall/functionResponse，以及 tool_choice / max_tokens 参数降级重试。

### 已知边界
- 当前 `chat-store / document-service / chat-permissions` 运行在前端插件层，Nova 渠道（WebUI）已经闭环；接入 QQ / 微信等后端渠道时建议把这三者下沉到后端，前端只保留展示与工具 UI。
- 群聊 / 隐私渠道的触发与隔离只留了数据结构（`channelGroup / participatesWorkingMemory / crossReadable`），尚未接真实渠道插件。
- 语义检索（`semantic`）当前回退为关键词，第三阶段再做向量索引。
- 敏感确认是简单关键词判断（与方案 §14 一致）。
- Gemini 原生适配覆盖常用文本 / 工具路径；图片输入、thinkingConfig、thoughtSignature 回传等高级能力后续按需补。
- Anthropic 已覆盖 tools / tool_use / tool_result；扩展思考签名等高级字段后续按需补。

## 上一轮已完成

### 模型页
- 顶层「使用风语内置模型」开关（默认开启，官方服务未接入时为空状态）。
- 自定义提供商：新增 / 编辑 / 删除（列表项大号红色删除按钮 + 详情删除按钮），左栏拉伸到底。
- 模型列表：获取模型列表（防重复点击）、自定义模型、启用/停用、编辑、删除。
- 模型参数：显示名 / 上下文长度 / temperature / max_tokens / 额外请求体。
- 提供商高级配置：单独超时、单独代理、请求头覆盖。
- **推理等级**独立滑块：`off / low / high / max`，映射 DeepSeek `thinking` + `reasoning_effort`。
- **temperature** 独立滑块：0–2 连续。
- 当前生效的模型改成下拉选择（从已启用模型中选）。

### 数据目录
- 默认 `<项目根>/user_data`，首次启动迁移旧 `data/`。
- 本机 AppData 指针（`%APPDATA%/fengyu/instance.json`）：新部署首次启动可找回上次数据目录；首次解析后写入本部署的 `user_data/instance.json`，之后只认本部署记录。
- 设置 → 数据：可手动填写路径、**选择目录**（Windows 文件夹对话框）、恢复默认；空目录 = 全新空白实例，已有数据目录 = 加载该实例。
- 路径信息用统一的只读输入框展示。

### 会话与角色
- 新建会话先弹「捏人窗口」：角色名 / 人格 / 模型 / 头像配色，头像可点选图片上传（128×128 压缩存储）。
- 会话头部「更多」菜单：分组（角色 / 导出 / 会话 / 危险操作），支持编辑角色、重命名、清空、删除会话。
- 会话列表支持悬停删除按钮 + 右键菜单删除。
- 等待模型首个 token 时显示三点思考动画；流式输出时末尾细光标。
- 人设由 `chat-flow` 作为 system 段落注入；会话级模型可覆盖全局。

### 网络 / 稳定性
- 网络页：真实后端状态、可编辑后端地址、全局请求超时、**全局代理**（`http://127.0.0.1:7890` 等，对未单独配置代理的提供商生效）。
- 提供商请求超时 / 代理回落全局配置；DeepSeek 连接超时可通过全局代理绕过。
- 启动脚本会自动关闭端口上的旧风语实例；`stop.cmd` / `stop.ps1` / `npm run stop` 可手动关闭。

### 权限
- `permissions` 插件：只读 / 标准 / 完全权限预设 + 按插件授权。
- 受管插件通过 `inject` 获得活代理，`api / storage / notification` 可即时拦截；代码运行器有 `code-execution` 权限位；core 插件豁免。

### 其他
- API Key / 敏感请求头 AES-256-GCM 加密落盘（`.secret-key` 随数据目录迁移）。
- 导出 Markdown / JSON / TXT / HTML / CSV / PDF（浏览器打印）。
- 背景图上传（`bg-image`）、语音输入（Web Speech API）、代码运行器（Web Worker 沙箱）。

### 本轮审计与修复
- 修复插件禁用后重新启用不即时生效的问题：可选中服务（背景等）会记住用户偏好实现，重新启用时立即切回；事件、插槽、设置页、视图路由、快捷键、渠道类型、模型提供商等注册型服务统一随插件 fiber 生命周期释放，避免残留 / 重复 / 注册冲突。
- 修复会话列表收起为头像栏后删除按钮压头像的问题；紧凑搜索浮层改为浮层定位，不再被窄面板裁切。
- 新增全局搜索浮层（侧栏按钮 + `Ctrl+Shift+F`），搜索结果可真正打开会话 / 渠道 / 设置 / 插件。
- 输入区新增「停止生成」按钮；取消请求会结束流式占位消息，而不是留下永久转圈。
- 插件支持卸载后恢复：已卸载列表保留数据并提供恢复入口。
- 外观页新增每块玻璃板的透明度滑块（左列表 / 右主面板 / 设置导航 / 设置内容 / 顶栏），并统一到 `theme-tokens` 的 CSS 变量。
- 背景图片上传改为自定义文件选择器；强调色、数字输入等原生控件的视觉细节一并收口。
- Markdown 代码块不再被二次转义；提供商启用开关可真实写回；请求头覆盖支持精确清空。
- 消息、设置、插件页同时补了端到端回归用例。

## 仍未实现（需要独立项目 / 架构改造）

| 项 | 原因 |
|---|---|
| 登录 / 注册 / 官方模型 | 官方服务端为独立官网项目，未发布 |
| 多设备云同步 | 需要云端存储与冲突合并 |
| 插件市场 / 在线安装 | 需要服务端索引与签名校验 |
| QQ / 微信 / Discord / 邮箱 / Telegram 渠道 | 第三方协议、OAuth/网关或合规风险 |
| 插件操作系统级沙箱 | 需要独立插件进程 + RPC，当前是服务访问层拦截 |
| 系统级窗口控制 | 需要 Electron/Tauri 宿主 |
| 代码运行器 Python/Node | 需要系统级安全沙箱 |
| 背景图裁剪 / 多图管理 | 需要交互式图片编辑器 |
| PDF 服务端生成 | 需要额外排版依赖；当前用浏览器打印另存 |

## 测试状态

```
npm test
  check:kernels      OK 135 个 .mjs
  test:backend       63/63
  test:smoke         189/189
  test:chat          13/13
  test:chat-tools    101/101
  test:vendors       30/30
```
