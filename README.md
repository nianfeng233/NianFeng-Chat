# 风语 (Fengyu) · 万物皆插件的 AI 聊天程序

> 真实 cordis v4 内核 · 本地后端 · 外部插件目录 · 桌面 / Web 双端 · Apache-2.0

风语不是又一个"套壳聊天页"。它把聊天软件拆成一套可替换的插件系统：会话、消息、模型、
工具、通知、背景、气泡、语言包……全部是可独立启停、可外部安装的插件；数据、插件、
主题与模型都保存在本机，并且可以外置到任意目录。

当前版本：**v0.41.0**（发布与版本规范见 [`docs/RELEASING.md`](docs/RELEASING.md)）

---

## 为什么选择风语

### 框架层：一切皆插件、一切可替换

| 能力 | 说明 |
|---|---|
| 真实 cordis v4 内核 | fiber 生命周期、依赖注入、事件总线、服务注册全部是 cordis 原生实现，不是自己仿的"插件感" |
| 6 层插件架构 | kernel / foundation / domain / shell / views / features / extras，依赖拓扑加载，可运行时启停、卸载、恢复 |
| 可选中服务 | 主题、背景、气泡样式、模型、语言都是 selectable：同一个接口可以注册多个实现，用户在设置里切换 |
| 外部插件目录 | 插件不必再嵌入 exe：放在数据目录的 `plugins/` 或任意指定目录，扫描即可加载，升级 exe 不丢插件 |
| 存储可外置 | 数据目录、插件目录都可在设置中切换；配置、会话、密钥、插件都跟着数据目录走 |
| 桌面 / Web 同源 | 同一套源码生成 Web 部署版与 Windows 单文件 exe；exe 只是无边框 WebView2 容器 |
| 本地优先 | 默认只监听 `127.0.0.1`；需要开放访问时可切换 `0.0.0.0` 并设置访问令牌 |

### 对话模式：用「读工具 + 写工具」解决常规聊天软件的痛点

传统聊天软件把一切都塞进消息文本，靠不断增长的上下文"记得住"。风语把对话拆成两类工具：

- **读**：`read_messages`（按条件读取历史消息）、`read_document`（按 token 预算读取长资料）
- **写**：`chat_send`（一条或分多条发送聊天消息）、`send_document`（发送长资料，只存引用与摘要）

这套模型带来几个结构性优势：

1. **长期记忆不再靠"撑上下文"**
   模型需要回忆时主动调用 `read_messages` / `read_document`；不需要时，记忆不占当前上下文。
   再叠加"角色级工作记忆 + 渠道级最近消息"的分层，长期记忆与当前对话互不挤占。

2. **跨会话交互是原生能力**
   每个会话就是一个渠道（`nova:web:<id>`，后续可扩展 QQ / Telegram 等）。
   模型可以在权限允许时跨渠道读取或发送，实现同一角色在不同会话间的连续存在，
   而不是每个会话一座信息孤岛。

3. **消息分段天然成立**
   模型需要发多段就调用多次 `chat_send`：每段是独立气泡、独立时间戳、独立发送状态；
   工具调用过程本身不会展示成消息，不会出现"一大段 JSON 混在聊天记录里"。

4. **长资料不污染聊天记录**
   `send_document` 只在聊天记录里保存 `doc_id`、标题、摘要和 token 数；
   需要细节时再用 `read_document` 按 token 预算读取。聊天上下文保持干净，原文完整保存在资料库。

5. **每一条消息都可审计**
   消息带稳定的 `message_id / seq / channel_id / timestamp / sender_id / sender_name / visibility / source`；
   工具协议轨迹（tool_calls）单独保存并可在下一轮还原，方便排查"模型到底做了什么"。

6. **权限与隐私是一等公民**
   渠道读写权限表、跨渠道校验、敏感操作确认、审计日志；隐私渠道默认禁止跨渠道读写，
   群聊与私聊的记忆策略分开，不靠"提示词自律"。

### 与常规聊天软件对比

| 常见痛点 | 常规做法 | 风语 |
|---|---|---|
| 记忆越长越贵、越容易丢 | 全文回灌上下文 | 读工具按需读取 + 工作记忆 / 渠道记忆分层 |
| 不同会话互不相通 | 每个会话独立 | 渠道模型 + 跨渠道读写工具（受权限约束） |
| 长回复挤在一个气泡 | 一段超长文本 | `chat_send` 可多次调用，天然分段 |
| 长资料塞满历史 | 资料全文进消息 | 资料库 + `doc_id` 引用 + `read_document` 按需读取 |
| 工具调用格式泄漏进界面 | 原始 JSON / 标记上屏 | 专门拦截与渲染，不进入气泡 |
| 想换主题 / 气泡 / 模型只能等更新 | 写死在 UI 里 | selectable 服务，插件即可替换 |
| 想装插件只能重发新版本 | 全部内置 | 外部插件目录，复制文件夹 + 重新扫描即可 |
| 数据散落在 C 盘 / 浏览器 | 不可控 | 数据、插件、密钥全部可外置 |

---

## 快速开始

环境要求：Node.js ≥ 20（ES Module 需要通过 HTTP 加载，不能直接双击 `index.html`）。

```bash
npm install        # 安装 cordis（通常仓库已带 node_modules，可直接跳过）
npm start          # 一键启动「后端 + WebUI」，并自动打开浏览器
```

Windows 用户可直接双击 `start.cmd`。首次使用需要配置模型：

1. 打开 `设置 → 模型`，关闭「使用风语内置模型」（官方服务端尚未发布，当前为空状态）；
2. 在提供商列表新增 DeepSeek / OpenAI 兼容 / Anthropic / Gemini / Ollama；
3. 填 Base URL 与 API Key，获取模型列表并设为默认模型；
4. 回到会话开始聊天。

API Key 只保存在本机数据目录的 `config.json`，以 AES-256-GCM 密文存储，接口返回时始终打码。

---

## 插件系统

### 内置插件

内置插件位于 `plugins/`，随版本发布；`npm run sync-plugins` 会扫描插件目录并生成
`plugins/registry.mjs`。当前包括：

- kernel：事件总线、插件加载器、依赖解析、生命周期、服务容器
- foundation：配置、日志、i18n、主题、通知、插槽、弹窗 / 菜单 / 提示宿主、后端连接
- domain：会话、消息、渠道、模型、权限、队列、工具注册表、聊天记录库、资料库
- shell / views：外壳、顶栏、侧栏、聊天视图、消息气泡、输入区、设置页
- features / extras：聊天主链路、工具循环、角色编辑、Markdown、简体中文语言包等

### 外部插件目录（不需要重新打包 exe）

| 版本 | 默认外部插件目录 |
|---|---|
| 开发版 / Web 部署版 | `<数据目录>/plugins/`（默认 `user_data/plugins/`） |
| Windows exe | `%LOCALAPPDATA%\FengyuChat\user_data\plugins\` |

也可以在「设置 → 插件 → 插件目录」选择任意目录，或用环境变量 `FENGYU_PLUGINS_DIR` 指定。

插件结构（推荐与内置保持一致的分层）：

```
<外部目录>/views/my-plugin/index.mjs
```

把目录放好后：

1. 点击「重新扫描」或重启应用；
2. 前端启动时会请求 `/api/plugins`，后端合并「内置 + 外部」清单；
3. 外部插件按 `/user-plugins/<相对路径>` 动态加载，升级 exe 不会删除外部目录。

插件协议与内置完全一致：

```js
export const name = 'my-plugin'
export const version = '1.0.0'
export const displayName = '我的插件'
export const description = '一句话说明'
export const core = false
export const inject = []
export function apply(ctx) {
  // ctx.provide / ctx.on / ctx.slots.register ...
}
```

外置插件默认放在 `user_data/plugins`，因此数据目录外置到 D 盘 / 移动硬盘时，插件也跟着走。

---

## 数据、隐私与安全

- **数据目录**：默认 `user_data/`，可在「设置 → 数据」中切换到任意目录；空目录 = 全新实例，
  已有 `config.json / sessions.json` 的目录 = 加载该实例。
- **插件目录**：作为数据目录的 `plugins/` 子目录，也可以独立指定。
- **凭据保护**：API Key 与敏感请求头以 AES-256-GCM 密文存储，密钥文件 `.secret-key` 与数据同目录，
  备份数据时需要一起复制。
- **本地优先**：默认监听 `127.0.0.1`；只有在显式设置监听地址与访问令牌后才会开放到局域网 / 公网。
- **发布安全门禁**：`scripts/prepare-publish.mjs` 会在发布前扫描用户名、本机绝对路径、API Key、
  私钥、邮箱、手机号与 `user_data` 等内容，命中即中止发布。

---

## 桌面版与 Web 版

| | Web 部署版 | Windows 桌面版 |
|---|---|---|
| 入口 | `release/web/deploy/启动风语.cmd`（自带便携 Node） | `release/desktop/deploy/风语.exe` |
| 形态 | 本地服务 + 浏览器 | 无边框 WebView2 窗口，内置便携 Node |
| 外部插件 | `user_data/plugins/` | `%LOCALAPPDATA%\FengyuChat\user_data\plugins\` |
| 数据 | 部署目录 `user_data/`（可切换） | `%LOCALAPPDATA%\FengyuChat\user_data\`（可切换） |
| 通知 | 浏览器 Notification + 右下角通知中心 | Rust 宿主直接发送 Windows 通知（带头像），不依赖浏览器权限 |
| 升级 | 解压覆盖部署目录 | 替换 exe；`user_data` 与外部插件保留 |

构建两个版本：

```bash
npm run build:release        # Web 源码 + Web 部署 + 桌面源码 + 风语.exe
npm run build:desktop        # 只构建桌面版
```

---

## WebUI 监听与访问令牌

「设置 → 网络 → WebUI 访问」支持：

- **监听地址**：`127.0.0.1`（仅本机）/ `0.0.0.0`（开放访问）
- **监听端口**：Web 部署 / `npm start` 模式生效
- **访问令牌**：非空时浏览器必须带令牌访问：
  `http://<主机>:<端口>/?token=你的令牌`
  验证通过后会写入本机 Cookie，后续直接访问即可；`/api/health` 与 `/api/version` 始终放行，
  供宿主探活使用。

保存后会弹出「是否立即重启」：确认后 Web 版由启动脚本自动拉起新进程，桌面版重启整个 exe；
取消则配置已保存，下次启动生效。

---

## 通知与提示音

- 通知分为三类：**系统通知**（风语 logo + 标题 + 内容）、**角色消息**（角色头像 + 角色名 + 预览）、
  **其他通知**（通用图标 + 标题 + 内容），统一展示在右下角通知中心。
- 角色消息在窗口后台或不在该会话时逐条提醒；桌面版由 Rust 宿主发送 Windows 通知，
  并把角色头像作为通知大图标，不再受 WebView2 浏览器通知权限限制。
- 提示音支持 4 种内置音色（默认 / 清脆 / 柔和 / 双响）与自定义音频上传（mp3 / wav / ogg）。
- 语言包：内置简体中文语言包插件 `lang-zh-cn`；复制该插件目录、修改翻译表即可新增语种。

---

## 测试

```bash
npm test             # 模块检查 + 后端 API + 前端端到端 + 对话 / 工具 / 厂商协议
npm run test:smoke   # 前端端到端（真实后端 + 真实 SSE）
npm run test:chat    # 本地 Mock OpenAI 兼容服务 → 真实 /api/chat
npm run test:vendors # DeepSeek / Anthropic / Gemini 协议转换
```

当前基线：前端端到端 **207 项全绿**，完整 `npm test` 通过。

---

## 版本管理与发布

所有开发都在工作区完成；发布仓库由 `scripts/prepare-publish.mjs` 从
`release/web/source` 同步生成，并强制通过敏感信息扫描。

```powershell
npm test
npm run build:release
node scripts/prepare-publish.mjs
node scripts/publish-release.mjs --tag v0.41.0 --notes docs/releases/v0.41.0.md
```

详细规范（语义化版本、分支模型、hotfix、回滚、发布 Checklist）见
**[`docs/RELEASING.md`](docs/RELEASING.md)**。

- 发布仓库：<https://github.com/nianfeng233/fengyu-chat>
- 预编译 exe 与 Web 部署包：GitHub Releases 附件

---

## 目录结构

```
.
├── index.html                  # #app 挂载点 + cordis import map
├── start.mjs                   # 后端 + WebUI + 反向代理 + 崩溃兜底
├── server/                     # 本地后端（真实 cordis 应用）
│   ├── index.mjs               #   startBackend()：组装后端插件
│   ├── data-dir.mjs            #   数据目录解析与 instance 指针
│   └── plugins/                #   settings / sessions / models / hub / instance / plugin-registry / http
├── src/
│   ├── main.mjs                # 启动引导（内置 + 外部插件清单）
│   ├── runtime/                # 插件运行时（app / compat / errors / semver）
│   └── util/                   # 库：dom / format / icons / style / identity / settings / glass
├── plugins/                    # 内置插件（kernel / foundation / domain / shell / views / features / extras）
├── scripts/                    # 构建、测试、发布与安全检查脚本
├── docs/                       # 架构、插件指南、插件清单、发布规范
├── public/assets/logo.png      # 品牌 logo
└── user_data/                  # 运行后生成：配置、会话、密钥、外部插件（已忽略）
```

---

## 许可证与第三方声明

- 风语原创代码、文档、界面与资源：**Apache License 2.0**（[`LICENSE`](LICENSE)，版权信息见 [`NOTICE`](NOTICE)）。
- 第三方依赖：见 [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md) 与自动生成的
  [`docs/DEPENDENCIES.md`](docs/DEPENDENCIES.md)；各依赖按其各自许可证授权。
- `release/*/deploy` 中的便携 Node 运行时遵循 Node.js 及其内置组件的许可证；
  Rust 桌面壳依赖的许可证审计结果同样记录在 `docs/DEPENDENCIES.md`。

---

## 文档索引

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — 架构与数据流
- [`docs/CHAT-FLOW.md`](docs/CHAT-FLOW.md) — 一条消息经过哪些插件
- [`docs/PLUGIN-GUIDE.md`](docs/PLUGIN-GUIDE.md) — 插件开发指南
- [`docs/PLUGIN-LIST.md`](docs/PLUGIN-LIST.md) — 插件清单与状态
- [`docs/RELEASING.md`](docs/RELEASING.md) — 版本管理与发布规范
- [`docs/DESKTOP.md`](docs/DESKTOP.md) — 桌面壳构建与运行
- [`docs/WINDOWS.md`](docs/WINDOWS.md) — Windows 使用与排障
- [`docs/STATUS.md`](docs/STATUS.md) — 当前功能状态
