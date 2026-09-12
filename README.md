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

- 当前版本：v1.0.0
- 许可证：Apache License 2.0（见 [LICENSE](LICENSE) 与 [NOTICE](NOTICE)）
- 仓库：<https://github.com/nianfeng233/NianFeng-Chat>
- 官方 QQ 群：1109357470

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
- **网络**：默认监听 `127.0.0.1`；可切换 `0.0.0.0` 并设置访问令牌，保存后按提示重启生效。
- **通知**：系统通知、角色消息、其他通知三类；角色消息通知带角色头像与消息预览；
  支持内置音色与自定义提示音。
- **微信clawbot 渠道**：内置第一个真实渠道插件；添加渠道时选择角色、分类（私聊/群聊/隐私）与权限，渠道详情点「接入」后用微信扫码。微信消息会进入所选角色的 clawbot 渠道并走念风完整模型链路，模型整轮调用彻底结束后才关闭微信 typing 状态。

- **语言**：内置简体中文语言包插件；复制该插件目录并修改翻译表即可新增语种。

## 对话机制

模型通过工具读写消息：

- 读取类：`read_messages`（按条件读取历史消息）、`read_document`（按 token 预算读取长资料）；
- 写入类：`chat_send`（发送一条或多条聊天消息）、`send_document`（发送长资料，只保存引用与摘要）。

实现要点：

- 角色级工作记忆与渠道级最近消息分层保存；
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

启动后打开 `设置 → 模型`，关闭“使用念风内置模型”（官方服务端尚未发布，当前为空状态），
添加提供商（OpenAI 兼容 / DeepSeek / Anthropic / Gemini / Ollama），填写 Base URL 与 API Key，
获取模型列表并设置默认模型，即可开始聊天。

Windows 用户也可以直接双击 `start.cmd`。

## 设置说明

- **数据**：数据目录可在设置中切换；空目录为全新实例，已有 `config.json` / `sessions.json`
  的目录会直接加载。
- **插件**：内置插件目录只读；外部插件目录可指定、打开、重新扫描，也可删除外部插件。
- **网络**：WebUI 监听地址、端口、访问令牌；非空令牌时访问地址为
  `http://<主机>:<端口>/?token=你的令牌`，验证通过后写入 Cookie。
- **通知**：角色消息通知、声音、后台活动、系统通知权限、提示音与测试按钮。
- **语言**：简体中文由 `lang-zh-cn` 语言包插件提供；复制该插件即可制作其他语言包。

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
export const inject = []
export function apply(ctx) {
  // ctx.provide / ctx.on / ctx.slots.register ...
}
```

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
5. 群聊可以在添加 / 编辑窗口里配置黑名单、仅艾特回复、回复概率、引用回复、艾特触发者与静默上下文；
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
npm test              # 模块检查 + 后端 API + Clawbot / QQ / NapCat + 前端端到端 + 对话 / 工具 / 厂商协议
npm run test:smoke    # 前端端到端（真实后端与 SSE）
npm run test:clawbot  # 微信 Clawbot 后端桥（本地 mock iLink 协议）
npm run test:napcat   # NapCat 后端桥（本地 reverse WebSocket mock）
```

当前 `npm test` 通过；`scripts/smoke.mjs` 共 241 项通过。

## 版本管理与发布

- 版本号同时记录在 `package.json` 与 `scripts/desktop-wrapper/Cargo.toml`；
- 发布仓库由 `scripts/prepare-publish.mjs` 从 `release/web/source` 同步生成，并进行敏感信息扫描；
- 发布流程、语义化版本、hotfix 与回滚规范见 [`docs/RELEASING.md`](docs/RELEASING.md)。

发布前会检查用户名、本机路径、API Key、私钥、邮箱、手机号、`user_data` 等敏感内容；
命中任意一条即中止发布。

## 安全与隐私

- 默认只监听本机 `127.0.0.1`；开放访问需显式配置监听地址与访问令牌；
- API Key 与敏感请求头以 AES-256-GCM 密文保存在本机数据目录的配置文件中；
- 备份数据时需要连同同目录的 `.secret-key` 一起复制；
- 用户数据目录、插件目录与发布源码相互独立；Git 仓库不包含用户数据。

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
- [`docs/WINDOWS.md`](docs/WINDOWS.md) — Windows 使用与排障
- [`docs/DESKTOP.md`](docs/DESKTOP.md) — 桌面壳构建
