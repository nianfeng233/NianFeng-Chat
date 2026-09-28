<!--
念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
项目全称：念风 Chat（NianFeng-Chat）
仓库：https://github.com/nianfeng233/NianFeng-Chat
-->
# 念风Chat（NianFeng-Chat）

[English](README.en.md) | 简体中文

念风Chat（NianFeng-Chat）是一个本地优先、插件化的 AI 聊天客户端。前端与本地后端都运行在 cordis 之上，功能通过插件组织；
插件目录和数据目录都可以放在外部；同一套源码可以构建 Web 部署版和 Windows 桌面版。

> 说明：本 README 由 DeepSeek（AI）协助整理生成，项目实际功能与行为以代码和测试为准。
> 项目状态：仍处于快速迭代期，`v2.x` 版本号只表示功能里程碑，不代表生产级成熟度或安全审计结论。默认仅监听本机；如需开放监听或部署到公网，请先阅读「安全与隐私」并设置访问令牌。生产环境建议执行 `npm run release:gate` 后再发布。

- 当前版本：v2.2.0
- 许可证：Apache License 2.0（见 [LICENSE](LICENSE) 与 [NOTICE](NOTICE)）
- 仓库：<https://github.com/nianfeng233/NianFeng-Chat>
- 官方 QQ 群：1109357470

## 核心能力

念风 Chat 把**记忆、上下文、工具、渠道和整个 UI** 都拆成 cordis 插件。
下面这些能力已经存在于当前代码中，可以通过命令复现。

### 1. 近似无限记忆：全量落盘 + 按需召回

- 后端默认用 SQLite（`user_data/chat.db`）逐条保存消息，开启 WAL，并为 `(conversation_id, seq)` 建索引；
  聊天记录不会因为模型上下文窗口有限而丢失。没有 `node:sqlite` 的环境会自动回退到 JSON 持久化。
  `read_messages` 再通过关键词、精确 `seq`、相对序号、时间段和 `cursor` 分页召回历史；传入
  `semantic` 时还会走长期记忆库的向量语义检索。
- 会话列表同步默认只取 `compact` 元数据（名称 / 预览 / `messageCount`，不传聊天正文）；聊天记录页
  与 Web 会话窗口首屏只拉最近 20 条，向上翻 / 点击「加载更早」时再按 `beforeSeq` 拉下一页。
  后端启动时会自动合并历史上因竞态产生的同渠道重复会话容器，避免出现「渠道显示 0 条但旧记录在另一个
  `conv.id` 下」或群聊 / 私聊内容串位的问题。
- 长期记忆库（`memory.db` / `memory.json`）按角色独立：普通渠道默认每 10 轮完整对话压缩成一段短概括并向量化
  （轮次可在「设置 → 模型 → 记忆模型 → 私聊总结轮次」调整，范围 2-50），
  群聊则默认在每次模型轮结束后按最近 N 条消息窗口概括（默认 20 条；与已概括 message_id 重复超过 N-5 条时跳过），
  并支持总开关 / 逐群渠道关闭；关闭后的渠道绝不生成新概括，但已存记忆仍可检索。
  `search_memory` 可做「向量 + BM25 关键词 + 时间」混合召回，默认返回最相关的 1 条概括及其
  10 轮原文；跨渠道原文会按权限标记为隐私内容，未授权时只返回概括。隐私渠道单独计算，不与其它渠道互读。
  向量模型在「设置 → 模型 → 记忆模型」里选择，维度可自动检测。
- 输入上下文默认不按 token 截断（`chat.contextTokens = 0`，填正数时才作为安全上限；模型设置里填了
  “上下文长度”时会自动按 `上下文长度 - 输出预留` 约束），当前会话 / 角色工作记忆只按最近几轮进入
  prompt，更早历史由模型主动检索；输出侧由 `chat.maxOutputTokens`（默认 8192）限制，模型级
  `max_tokens` 可覆盖。
- 长资料进入 `document-service`：单份最多 2M 字符，聊天记录里只留 `doc_id + 标题 + 摘要`；
  `read_document` 每次按 `chat.readTokens`（默认 1500，单次最多 4000）分段读取，返回 `next_offset`
  可以连续读到结尾。
- 因此模型看到的是“摘要 + 最近上下文 + 按需检索结果”，只需要的内容会进入 prompt。

### 2. 跨会话 / 跨渠道交互

- `chat-store.workingMessages()` 会聚合**同一角色的所有普通私聊渠道**，按时间合并去重。
  在 A 会话说过的事，切到 B 渠道后角色仍然知道，这是刻意设计的工作记忆。
- 渠道可选择开启 `crossReadable` / `crossSendable`：模型可以用 `read_messages` 读取其它渠道，
  也可以用 `chat_send` / `send_document` 往其它渠道发送；跨渠道敏感操作仍由
  `chat-permissions` 先做权限判断与确认。
- 上下文构建时会把当前可用的其它渠道名称注入 system prompt，模型可以直接使用这些渠道名称。

### 3. 不易被污染的上下文

- 每条用户内容都会被包成结构化信封：`meta` 放时间 / 渠道 / 角色等程序生成的元数据，
  正文固定放在 `content.trust = "untrusted"` 中；system prompt 会明确告诉模型不可信正文不能当指令执行。
- 工具轨迹只保留合法的 `assistant.tool_calls + role = "tool"` 序列，并在截断后重新修复协议，
  避免 OpenAI 兼容端点因为半截工具调用直接 400。
- system 前缀只包含固定人格、工具规则和渠道策略；逐条变化的元数据放在消息层，
  DeepSeek 等支持前缀缓存的接口可以持续命中，上下文越长越省。
- 隐私渠道 / 群聊可以切到 `channel-only`，不串其它渠道的工作记忆；
  历史图片默认只给 `[图片]` 占位，只有显式 `include_images` / `image_message_ids` 才注入原图；
  当前请求和单条消息也各有图片数量与 token 预算。

### 4. 天然消息分段

- `chat_send` 的 `messages` 是数组，每一项就是一条独立消息、独立气泡；首条立即发出，
  第 2 条开始按字数模拟 0.5～5 秒的真人打字延迟，`end = true` 表示本轮回复结束。
- 模型协议里的 tool call / tool result 不会被渲染成聊天气泡；
  模型可以自然地说“第一句”，停一下，再说“第二句”，而不是把多句话用换行拼成一条超长消息。
- 图片同样支持分段：一条 `chat_send` 最多 4 张图，消息里只存 `imageId`，由图片服务和渠道桥
  按需取图 / 下载 / 转存。

### 5. 全插件结构与高自定义

- 当前内置 **93 个前端插件**，按目录分为 8 层：
 `kernel 5` / `foundation 15` / `domain 16` / `shell 10` / `views 33` / `features 8` / `extras 3` / `channels 3`。
- 插件之间已经使用显式依赖系统：**310 条必须依赖、22 个插件声明可选依赖**；
  支持 `*`、`>=`、`=` 精确锁定、`^`、`~`、`1.x` 等版本规则；必须依赖缺失会标红并阻止激活，
  可选依赖只标黄，不在启动仪式上误伤。
- 代码中声明了 60+ 项服务提供、44 个可注入服务名。主题、背景、气泡、模型、语言都是可切换的
  可选中服务；视图、插槽、设置页、快捷键、右键菜单、通知、渠道类型、模型提供商也都能由插件注册。
- 外部插件放在 `<数据目录>/plugins/` 或任意目录，重新扫描后加载；插件可以带自己的依赖、
  权限声明和设置面板，升级 exe 不会删除外部插件目录。

**可验证指标**：`npm run sync-plugins` 会重新扫描并校验上述依赖数据；
`npm run test:deps` 有 214 项依赖结构 / 版本 / 服务映射断言；`npm run test:smoke` 有 322 项端到端断言。
所有数字都来自当前仓库代码。

## 功能与架构

- **前端内核**：真实 cordis v4（插件 fiber、依赖注入、事件总线、服务容器）；插件按
  kernel / foundation / domain / shell / views / features / extras 分层。
- **本地后端**：Node.js + cordis 应用，零 Web 框架手写 HTTP / SSE；负责模型接入、会话持久化、
  文件服务等。
- **桌面端**：Rust + WebView2 无边框容器，内嵌便携 Node 运行时，可打包为单个 `念风Chat.exe`。
- **可选中服务**：主题、背景、气泡样式、模型、语言都可以注册多个实现，并在设置中切换。
- **外部插件**：内置插件随版本发布；用户插件放在 `<数据目录>/plugins/` 或任意指定目录，
  重新扫描后加载；升级 exe 不删除外部插件目录。
- **数据外置**：数据目录可在设置中切换；插件目录可独立指定。
- **网络**：默认监听 `127.0.0.1`；首次运行会在终端最上方打印随机访问令牌（只显示一次），
  之后可在设置中换成自己的值。后端只保存盐化摘要，不保存明文；保存后按提示重启生效。
- **通知**：系统通知、角色消息、其他通知三类；角色消息通知带角色头像与消息预览；
  支持内置音色与自定义提示音。
- **微信clawbot 渠道**：内置第一个真实渠道插件；添加渠道时选择角色、分类（私聊/群聊/隐私）与权限，渠道详情点「接入」后用微信扫码。微信消息会进入所选角色的 clawbot 渠道并走念风完整模型链路，模型整轮调用彻底结束后才关闭微信 typing 状态。
- **渠道即时外发**：助手消息写入目标渠道会话后立即外发，不再等整轮模型结束；模型用 `chat_send` 跨渠道发送时，目标渠道也会真正收到消息（敏感操作仍先走确认）。工具一次发送多条消息时，网页和渠道都会按“首条立即、后续模拟打字延迟”的节奏发出。
- **渠道内确认**：跨渠道等敏感操作会把确认提示发到来源渠道（微信clawbot / NapCat 等）；用户在来源渠道回复“确认”即可放行，渠道身份与网页端主人身份都可确认，确认输入不会再写进聊天记录。
- **输入状态**：微信clawbot 在整轮调用期间持续保活“输入中”，发送授权提示或回复后会自动补报，整轮彻底结束才停止；NapCat 私聊额外提供 `napcat-input-state` 扩展，按固定间隔重报 `set_input_status`（群聊接口不支持）。
- **手机端界面**：手机访问会自动进入单栏界面（顶部返回栏 + 底部 会话 / 渠道 / 设置 导航，设置页改为横向导航），桌面访问保持原布局；可用 `?mobile=1` / `?mobile=0` 调试。
- **运行日志**：侧栏独立日志视图（不属于设置页，全宽展示），终端 / `runtime.log` / WebUI 三端统一且持久化；默认只显示 INFO，级别做成可自由组合的勾选（错误 / 警告 / 信息 / 调试，选择会记住），聚焦模型请求开始 / 完成 / 超时、工具调用耗时、渠道消息收发与权限确认，成功 HTTP 访问日志不再上屏；SSE 实时推送 + 轮询 + 后端实例变化自动全量重同步，刷新页面或重启后端都不丢历史、也不会卡住不更新。

- **语言**：内置简体中文语言包插件；复制该插件目录并修改翻译表即可新增语种。

## 对话机制

模型通过工具读写消息：

- 读取类：`read_messages`（按关键词 / 序号 / 时间 / 语义读取历史消息）、`search_memory`（按语义检索角色长期记忆概括，默认返回 1 条概括及 10 轮原文）、`read_document`（按 token 预算读取长资料）；
- 写入类：`chat_send`（发送一条或多条聊天消息）、`send_document`（发送长资料，可一次多篇；原文进资料库，渠道侧按 QQ 合并转发发送：首条标题 + 正文）。

实现要点：

- 角色级工作记忆与渠道级最近消息分层保存；
- 角色级长期记忆库按渠道生成短概括并向量化：普通渠道每 10 轮一条，群聊按最近 N 条消息窗口去重后生成；
  支持跨渠道语义召回，隐私渠道独立计算；
- 模型可以一次调用发送多条消息，每条消息独立展示；工具调用过程本身不进入消息气泡；
- 长资料保存在资料库，聊天记录只保留 `doc_id`、标题与摘要，需要时再按预算读取原文；
- 消息包含 `message_id / seq / channel_id / timestamp / sender / visibility / source` 等字段；
- 渠道读写权限、敏感操作确认与审计日志。

## 快速开始

环境要求：Node.js ≥ 20。

```bash
npm install
npm start
```

启动后打开 `设置 → 模型`，添加提供商（OpenAI 兼容 / DeepSeek / Anthropic / Gemini / Ollama），填写 Base URL 与 API Key，
获取模型列表并设置默认模型，即可开始聊天。

Windows 用户也可以直接双击 `start.cmd`。

## 设置说明

- **数据**：数据目录可在设置中切换；空目录为全新实例，已有 `config.json` / `sessions.json`
  的目录会直接加载。
- **插件**：内置插件目录只读；外部插件目录可指定、打开、重新扫描，也可删除外部插件。
- **网络**：WebUI 监听地址、端口、访问令牌。首次运行自动生成随机令牌并打印在终端最上方
  （只打印一次）；之后可在「设置 → 网络」里设置自己的值。令牌只以随机盐摘要落盘，接口不会回显明文。首次访问
  `http://<主机>:<端口>/?token=你的令牌`，校验通过后会写入 HttpOnly Cookie 并自动把地址栏清理为无令牌 URL；后续 API 请求只认 Cookie 或 `X-NianFeng-Token` / `Authorization` 请求头，不再接受查询串令牌。
- **通知**：角色消息通知、声音、后台活动、系统通知权限、提示音与测试按钮。
- **运行日志**：侧栏独立日志视图（全宽主面板，不在设置页内）；级别为错误 / 警告 / 信息 / 调试图标的自由勾选，另可按分类 / 关键词筛选，支持暂停、清空、复制与导出；选择会自动记住，成功 HTTP 访问日志不再展示，并会标红超时和失败外发。
- **记忆与知识库**：侧栏独立视图（全宽），「记忆库」标签页列出长期记忆概括，展开可查看该条目对应的消息原文快照；「知识库」标签页在安装 knowledge-base 扩展后浏览条目全文、标签、目录与历史版本。页面只读，不修改数据。
- **版本更新**：侧栏「欢迎」页可选择国内 GitHub 镜像源（默认）或 GitHub 官方源，从官方仓库 Release 升级 / 降级；自动识别当前是 Web 版还是 EXE 版并下载对应安装包；更新与「重启念风」都会完全关闭当前项目，随后自动重新运行。
- **语言**：简体中文由 `lang-zh-cn` 语言包插件提供；复制该插件即可制作其他语言包。
- **角色模型**：全局模型与备用模型在「设置 → 模型」里配置；单个角色可在「新建 / 编辑角色」页选择自己的主模型，并单独设置备用模型（跟随全局 / 不启用 / 指定模型），角色级配置优先于全局。

## 插件

内置插件的清单由脚本生成：

```bash
npm run sync-plugins
```

外部插件目录（默认 `<数据目录>/plugins/`，exe 为
`%LOCALAPPDATA%\NianFengChat\user_data\plugins\`）中的插件按以下结构放置：

```text
<外部目录>/views/my-plugin/index.mjs
```

放好后在「设置 → 插件」中点击「重新扫描」并刷新页面。插件模块协议：

```js
export const name = 'my-plugin'
export const version = '1.0.0'
export const displayName = '我的插件'
export const description = '插件说明'
export const core = false
export const depends = { 'event-bus': '^1.0.0' }          // 必须依赖：缺失 / 失效标红并阻止激活
export const optionalDepends = { 'markdown-enhancer': '>=1.0.0' } // 可选依赖：缺失 / 失效只标黄
export const inject = []
export function apply(ctx) {
  // ctx.provide / ctx.on / ctx.slots.register ...
}
```

依赖版本支持 `*`（任意版本）、`>=1.0.0`（大于等于）、`=1.0.0`（精确锁定）、`^1.0.0` / `~1.2.0`（兼容范围）、`1.x` 与 `1.2.3 - 2.0.0` 等写法。必须依赖缺失会标红并阻止加载；可选依赖缺失只标黄，不影响基础功能。

插件可以注册自己的配置面板，「设置 → 插件」对应条目后会出现「设置」按钮：

```js
export function apply(ctx) {
  const manager = ctx.inject('plugin-manager')
  ctx.effect(() => manager.registerSettings({
    id: 'my-plugin',
    title: '我的插件设置',
    description: '在插件页直接完成的专属配置。',
    render(container, { close, manager: pm }) {
      // container.innerHTML = ...
      return () => { /* 面板关闭时清理 */ }
    },
  }))
}
```

后端渠道桥也采用同一思路：在 `plugins/channels/<name>/bridge.mjs` 里注入 `httpApi` 并注册
自己的 `/api/<channel>/...` 路由，启动时会自动加载，不需要改 `server/index.mjs`。

### 内置渠道插件：微信clawbot

插件目录：`plugins/channels/wechat-clawbot/`（可单独分发，编译 exe 时会一并作为内置插件打包）。

使用步骤：

1. 打开「渠道」页，点击「添加渠道」，在菜单中选择 **微信clawbot**；
2. 在渠道设置窗口里选择使用角色、渠道分类（私聊 / 群聊 / 隐私）、用户显示名 / 用户唯一标识，并按需勾选权限；
3. 添加完成后在左侧选中该渠道，右侧详情点「接入」；使用手机微信扫描弹出的二维码；
4. 扫码确认后渠道变为「已接入」，微信侧发来的消息会进入对应角色的 clawbot 渠道；
5. 模型整轮调用（含工具调用与全部回复消息）结束后，微信侧的 typing 状态会自动关闭；
6. 聊天记录可在「设置 → 聊天记录」里查看和修改；插件专属配置也可从「设置 → 插件 → 微信clawbot → 设置」打开。

单独分发：

```bash
npm run build:clawbot-plugin
```

仓库内独立分发目录为 `extensions/wechat-clawbot/`；执行打包脚本会在 `release/plugins/wechat-clawbot/` 生成同样结构的分发包，并尽量生成同名 zip。插件后端桥在
`plugins/channels/wechat-clawbot/bridge.mjs`，完整版启动时会自动加载；外部插件目录
放置方式见下一节。

### 内置渠道插件：NapCat

插件目录：`plugins/channels/napcat/`，通过 NapCatQQ 的 OneBot 11 协议接入 QQ。

使用步骤：

1. 先安装并启动 NapCatQQ，在「网络配置」里开启 WebSocket 服务器（Forward，常见端口 3001，建议设置 token）；
2. 打开「渠道」页 →「添加渠道」→ **NapCat**；
3. 选择角色、渠道分类（私聊 / 群聊 / 隐私），填写目标 QQ 号或群号；
4. NapCat 连接处如果已有连接会自动优先复用；没有就新建连接：
   - Forward 模式填 `ws://127.0.0.1:3001` 与 token；
   - Reverse 模式填反向主机 / 端口 / 路径，默认生成 `ws://127.0.0.1:6199/ws`；Token 可选，留空则 NapCat 也不用填；
5. 群聊可以在添加 / 编辑窗口里配置黑名单、@ 触发、回复概率、引用回复、@ 触发者与静默上下文；@ 机器人始终优先回复，关闭“仅 @ 时回复”后，普通消息才按回复概率触发；
6. 每个 NapCat 登录 QQ 只建议建立一条连接，多个渠道 / 多个角色可以复用它；状态与连接管理在
   「设置 → 插件 → NapCat → 设置」里。

详细说明见 `plugins/channels/napcat/README.md`。

## 构建

```bash
npm run build:release   # Web 源码 + Web 部署 + 桌面源码 + 念风Chat.exe
npm run build:desktop   # 只构建桌面版
```

产物位于 `release/`：

- `release/web/source/`：纯净 Web 源码；
- `release/web/deploy/`：Web 可部署版（自带便携 Node，不需要 WebView2；云服务器用 `启动念风-无浏览器.cmd`）；
- `release/desktop/source/`：桌面壳源码与运行时 app；
- `release/desktop/deploy/念风Chat.exe`：Windows 桌面单文件。系统没有 WebView2 Runtime 时会优先自动下载并静默安装（国内镜像优先，可用 `NIANFENG_WEBVIEW2_INSTALLER_URL` 覆盖），安装失败才回退浏览器并保持 Node 后台运行。

`node.exe`、`念风Chat.exe` 与部署压缩包体积较大，作为 GitHub Release 附件分发，不进入 Git 仓库。

## 测试

```bash
npm test              # 模块/风格检查 + 依赖标注 + 后端 API + 安全回归 + 备用模型 + Clawbot / QQ / NapCat + 前端端到端 + 对话 / 工具 / 厂商协议
npm run test:security # Origin / Host / CORS / health 脱敏 / SSRF / 令牌摘要 / SSE 关闭
npm run check:style   # .mjs 文件 LF / 无 Tab / 无行尾空白 / 以换行结尾
npm run test:failover # 备用模型有序列表 / 逐个降级 / 循环轮数
npm run test:deps     # 插件依赖字段 / 版本范围 / 无环 / inject 服务映射
npm run test:smoke    # 前端端到端（真实后端与 SSE）
npm run test:clawbot  # 微信 Clawbot 后端桥（本地 mock iLink 协议）
npm run test:napcat   # NapCat 后端桥（本地 reverse WebSocket mock）
```

当前 `npm test` 全部通过；各脚本的具体断言数量以本次 `npm test` 输出为准，不在文档里写死。

## 版本管理与发布

- 版本号同时记录在 `package.json` 与 `scripts/desktop-wrapper/Cargo.toml`；
- 发布仓库由 `scripts/prepare-publish.mjs` 从 `release/web/source` 同步生成，并进行敏感信息扫描；
- 发布流程、语义化版本、hotfix 与回滚规范见 [`docs/RELEASING.md`](docs/RELEASING.md)。

发布前会检查用户名、本机路径、API Key、私钥、邮箱、手机号、`user_data` 等敏感内容；
命中任意一条即中止发布。

## 安全与隐私

- 默认只监听本机 `127.0.0.1`；开放访问需显式配置监听地址与访问令牌；
- 后端对 `Host` 与 `Origin` 双重校验，CORS 只按白名单精确回显，不再返回 `Access-Control-Allow-Origin: *`，可阻挡 DNS rebinding 与任意网页直读本机 API；
- 配置了访问令牌时，`/api/health`、`/api/version` 只返回存活探针信息；数据目录、配置文件路径、提供商状态、会话统计等详情需要携带令牌（Cookie / 请求头）才能读取；
- `?token=` 仅用于浏览器首次打开页面换取 HttpOnly Cookie，兑换后立即 302 到无令牌地址；API 不接受查询串令牌，令牌比较使用常量时间算法；
- 访问令牌不落明文：首次运行随机令牌只打印在终端一次，磁盘只保存带随机盐的 `nf1$...` 摘要；旧版 `network.webuiToken` 明文在启动时自动迁移并删除，`.webui-token` 运行时文件不再写入；设置页也不回显现有令牌；后端强制新令牌至少 12 位；
- `NODE_ENV=production` 且监听 `0.0.0.0` / `::` 时，若没有访问令牌会直接拒绝启动（仅 `NIANFENG_ALLOW_INSECURE_LISTEN=1` 可显式跳过），用于防止生产环境误暴露；
- `/api/rss` 内置 SSRF 防护：拒绝 `localhost`、环回 / 私有 / 链路本地 / 云元数据地址与非 http(s) 协议，并逐跳校验 DNS 与重定向；
- API Key 与敏感请求头以 AES-256-GCM 密文保存在本机数据目录的配置文件中；
- 备份数据时需要连同同目录的 `.secret-key` 一起复制；
- 用户数据目录、插件目录与发布源码相互独立；Git 仓库不包含用户数据。

> 非默认部署（例如把 WebUI 放到其它端口 / 反向代理到自定义域名）可通过
> `NIANFENG_ALLOWED_ORIGINS` / `NIANFENG_ALLOWED_HOSTS` 显式追加白名单，多个值用英文逗号分隔。
> 安全回归测试：`npm run test:security`。

## 目录结构

```text
.
├── index.html
├── start.mjs             # 后端 + WebUI + 反向代理
├── server/               # 本地后端（cordis 应用）
├── src/                  # 前端运行时与工具库
├── plugins/              # 内置前端插件
├── scripts/              # 构建、测试、发布脚本
├── docs/                 # 架构、插件、发布等文档
├── public/               # 静态资源
└── user_data/            # 运行后生成：配置、会话、密钥、外部插件（不进入仓库）
```

## 第三方依赖与许可证

- 项目原创代码、文档与资源：Apache License 2.0；
- 第三方组件与许可证文本：[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)；
- 自动生成的依赖清单：[docs/DEPENDENCIES.md](docs/DEPENDENCIES.md)；
- 商业分发注意事项：[docs/COMMERCIAL-USE.md](docs/COMMERCIAL-USE.md)。

## 文档索引

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — 架构与数据流
- [`docs/CHAT-FLOW.md`](docs/CHAT-FLOW.md) — 消息链路
- [`docs/PLUGIN-GUIDE.md`](docs/PLUGIN-GUIDE.md) — 插件开发指南
- [`docs/PLUGIN-LIST.md`](docs/PLUGIN-LIST.md) — 插件清单
- [docs/wechat-clawbot-plugin.md](docs/wechat-clawbot-plugin.md) — 微信clawbot 渠道插件更新与本体改动说明
- [`docs/RELEASING.md`](docs/RELEASING.md) — 版本管理与发布规范
- [`docs/SECURITY-HARDENING.md`](docs/SECURITY-HARDENING.md) — 2026-09 审查反馈逐条结论与安全加固记录
- [`docs/WINDOWS.md`](docs/WINDOWS.md) — Windows 使用与排障
- [`docs/DESKTOP.md`](docs/DESKTOP.md) — 桌面壳构建
