# 风语 · AI Chat

> 万物皆插件的 AI 聊天程序。视觉 1:1 复刻工作区中的 `deepseek_html_20260910_f355e0.html`，
> 内核使用**真实的 cordis v4**，并配有一套**可实际使用的本地后端**（模型接入 / 会话持久化）。

```
84 个插件 · 6 层架构 · 真实 cordis v4 内核 · 本地后端（Node，零 Web 框架）· 无假数据
```

---

## 快速开始

环境要求：Node.js ≥ 20（ES Module 需要通过 http 加载，不能直接双击 `index.html`）。

```bash
npm install        # 安装 cordis（已内置依赖，通常直接可用）
npm start          # 一键启动「后端 + WebUI」，并自动打开浏览器
```

`npm start` 会做这些事：

```
╭─────────────────────────────────────────────────────╮
│ WebUI : http://127.0.0.1:5173                       │
│ API   : http://127.0.0.1:8788/api/health            │
│ 数据  : <项目目录>/user_data                        │
│ 代理  : http://127.0.0.1:5173/api → 127.0.0.1:8788  │
╰─────────────────────────────────────────────────────╯
```

| 命令 | 说明 |
|---|---|
| `npm start` | 后端 + WebUI 一起启动（开发模式，推荐） |
| `npm run stop` | 关闭占用 5173 / 8788 的风语实例（找不到就说明没在运行） |
| `npm run serve` | 单端口模式：后端直接托管 WebUI（只开 5173） |
| `npm run backend` | 只启动后端（8788，便于单独调试 API） |
| `npm test` | 模块检查 + 后端 API 测试（63 项）+ 前端端到端测试（199 项）+ 对话链路测试（13 项）+ Nova 工具链路测试（101 项）+ 厂商协议测试（30 项） |
| `npm run test:chat` | 本地 Mock OpenAI 兼容服务 → 真实 `/api/chat` SSE 的对话链路集成测试 |
| `npm run test:vendors` | DeepSeek / Anthropic / Gemini 协议转换与通用 OpenAI 参数降级的集成测试 |
| `npm run mock:openai` | 启动本地 Mock 提供商（无网络 / 无 Key 时验证聊天 UI 用） |
| `npm run build:release` | 生成 `release/`：Web 源码版 + Web 部署版 + 桌面源码 + `风语.exe` |
| `npm run build:desktop` | 只生成无边框桌面版 `release/desktop/deploy/风语.exe` |
| `npm run sync-plugins` | 新增/删除插件目录后，重新生成 `plugins/registry.mjs` |
### 插件目录与外部插件

* **内置插件**：`plugins/`（随版本发布；exe 升级时 runtime 目录会被替换）。
* **外部插件**：默认读取数据目录下的 `plugins/`：
  * 开发版 / Web 版：`user_data/plugins/`
  * exe 版：`%LOCALAPPDATA%\FengyuChat\user_data\plugins\`（数据目录改到别处时跟随数据目录）
  * 也可以在「设置 → 插件 → 插件目录」里选择任意外部目录，或用环境变量 `FENGYU_PLUGINS_DIR` 指定。
* 插件结构：`<外部目录>/<分层>/<插件id>/index.mjs`，例如 `views/my-plugin/index.mjs`；放好后点「重新扫描」并刷新页面即可，**不需要**重新生成 `registry.mjs`，升级 exe 也不会删除外部插件。
* 外部插件与内置插件使用同一套插件协议：`export const name / version / displayName / depends / inject / provides` + `export function apply(ctx)`；相对引用可用 `../../../src/...`，同源绝对路径也可用 `/src/...`。
* 从外部插件目录删除后点「重新扫描」即可卸载；「设置 → 插件」里也能单独删除外部插件文件。

### Windows 用户（推荐）

直接双击 `start.cmd` 即可：检查 Node → 缺依赖自动安装 → 启动后端 + WebUI → 自动打开浏览器。

* 首次使用建议先双击 `install.cmd`（网络需要代理时填写，例如 `http://127.0.0.1:7890`）
* 也可以双击 `start.ps1`（PowerShell 版，支持 `-NoOpen` / `-Serve` / `-WebPort` / `-Proxy` 参数）
* 生成桌面快捷方式：`powershell -ExecutionPolicy Bypass -File scripts\create-shortcut.ps1`
* 详细说明与排障见 [`docs/WINDOWS.md`](docs/WINDOWS.md)

### 第一次使用：配置模型（必须，否则聊天不可用）

风语不提供任何"演示模型"。没有配置提供商时，发送消息会明确提示去配置：

1. 打开 `设置 → 模型`，关闭顶层的「使用风语内置模型」（内置模型由尚未发布的官方服务端提供，当前为空状态）
2. 在左侧提供商列表点「新增」，选择类型并填写配置：
   * **DeepSeek 官方**：Base URL 默认 `https://api.deepseek.com`，填 API Key 后获取模型（如 `deepseek-v4-flash` / `deepseek-v4-pro`）
   * **Anthropic Claude**：Base URL 默认 `https://api.anthropic.com`，原生支持 tools / tool_use
   * **Google Gemini**：Base URL 默认 `https://generativelanguage.googleapis.com`，原生支持 functionDeclarations / functionCall
   * **Ollama（本地，零成本）**：地址 `http://localhost:11434`
   * **OpenAI 兼容接口**：填 Base URL 与 API Key（也适用于 DeepSeek / Moonshot / OneAPI / vLLM 等）
3. 保存后点「测试连接」——这是真实请求，成功/失败都会给出服务端返回的原因
4. 点「获取模型列表」拉取真实模型，或手动添加自定义模型；在「默认模型」里选一个，回到会话开始聊天
5. 每个模型还能单独配置 temperature / max_tokens / 额外请求体，提供商支持超时、代理与请求头覆盖

> API Key 只保存在本机 `user_data/config.json`，且以 AES-256-GCM 密文存储（密钥文件 `user_data/.secret-key`）；接口返回时始终打码，**不会**发送到浏览器。备份数据时请把 `.secret-key` 一起复制。接入系统凭据库（Keychain / DPAPI）仍是后续事项，已列入「未实现清单」。

---

## 目录结构

```
.
├── index.html                  # 只有 #app 挂载点 + cordis 的 import map
├── start.mjs                   # 一键启动：后端 + WebUI + 反代 + 打开浏览器
├── server/                     # 本地后端（真实 cordis 应用）
│   ├── index.mjs               #   startBackend()：组装后端插件
│   └── plugins/
│       ├── settings.mjs        #   user_data/config.json 读写 + 凭据脱敏
│       ├── sessions.mjs        #   user_data/sessions.json 真实持久化
│       ├── models.mjs          #   OpenAI 兼容 / Anthropic / Ollama 真实接入
│       ├── hub.mjs             #   SSE 实时事件总线
│       └── http.mjs            #   REST + SSE API + 可选静态托管
├── src/
│   ├── main.mjs                # 启动引导（加载 84 个插件）
│   ├── runtime/                # cordis 之上的风语运行时
│   │   ├── app.mjs             #   插件清单 / 状态 / 启停 / 依赖图
│   │   ├── compat.mjs          #   插件 ctx 兼容层（底层是真实 cordis fiber）
│   │   ├── errors.mjs
│   │   └── semver.mjs
│   └── util/                   # 库（非插件）：dom / format / icons / style / settings
├── plugins/                    # 所有前端功能都是插件
│   ├── registry.mjs            #   自动生成的插件清单
│   ├── kernel/  foundation/  domain/  shell/  views/  features/  extras/
├── scripts/
│   ├── smoke.mjs               # 前端端到端测试（会启动真实后端）
│   ├── test-backend.mjs        # 后端 API 测试（真实 HTTP）
│   ├── dom-shim.mjs            # 测试用极简 DOM
│   ├── sync-plugins.mjs
│   └── check-syntax.mjs
├── docs/                       # 架构 / 插件开发 / 插件清单 / Demo 对照
├── public/assets/logo.png
├── user_data/                  # 运行后生成：config.json、sessions.json、.secret-key、外部插件 plugins/（已 gitignore）
├── 文档.txt                     # 原始架构设计草稿（未改动）
└── deepseek_html_20260910_f355e0.html   # 原始视觉 Demo（未改动）
```

---

## 架构

### 前端：真实 cordis + 风语运行时

* 内核是 npm 包 **cordis v4**（`node_modules/cordis`），浏览器通过 import map 直接加载；
  plugin fiber、依赖注入（`inject`）、事件总线、日志、`ctx.effect` 生命周期全部是 cordis 原生实现。
* `src/runtime/compat.mjs` 是薄兼容层，让插件用统一、简洁的 ctx API，同时把所有权/状态暴露给插件管理器：
  `inject()` 无需回调也能取值、`provide()` 带归属与冲突检测、`emit()` 支持拦截型事件、`effect()` 统一为"注册清理函数"。
* 插件模块格式与 cordis 完全一致：`export const name/inject/provides` + `export function apply(ctx)`。

六层结构（详细清单见 `docs/PLUGIN-LIST.md`）：

| 层 | 职责 | 数量 |
|---|---|---|
| L6 可选扩展 | Markdown 渲染、简体中文语言包（其余扩展插件后续按需加入） | 2 |
| L5 业务功能 | chat-flow、渠道基座、后端模型适配器、工具集、上下文构建、角色消息提醒 | 8 |
| L4 视觉内容 | 三视图、列表、气泡、输入框、全局搜索、设置页等 | 31 |
| L3 视觉框架 | 外壳、顶栏、侧栏、左右玻璃板、背景 | 9 |
| L2 业务服务 | 会话、消息、模型、视图路由、渠道、插件管理、搜索、导出、渠道记录、资料库、聊天权限、串行队列、工具注册表 | 14 |
| L1 基础服务 | 存储、配置、日志、主题、多语言、权限、插槽、弹窗/菜单/提示宿主、后端连接等 | 15 |
| L0 内核 | event-bus、plugin-loader、dependency-resolver、lifecycle、service-container | 5 |

### 后端：另一个 cordis 应用

后端不是"假接口"，而是一个独立的 cordis Context，加载 `server/plugins/*`：

* `settings` → 真实读写 `user_data/config.json`，接口返回时脱敏
* `sessions` → 真实读写 `user_data/sessions.json`（原子写 + 防抖落盘）
* `models` → 真实请求上游：OpenAI 兼容 `/chat/completions`（SSE）、Anthropic `/v1/messages`（SSE）、Ollama `/api/chat`（NDJSON）
* `hub` → SSE 实时通道（提供商状态、聊天进度、会话变更）
* `http` → REST + SSE，零 Web 框架手写路由；可选托管 WebUI（单端口模式）

API 一览（全部有真实实现）：

```
GET    /api/health                     服务状态 / 提供商概览 / 数据规模
GET    /api/config                     脱敏配置
PUT    /api/config                     保存配置（可含明文 Key，仅本机）
GET    /api/providers                  提供商 + 模型 + 最近测试结果
PUT    /api/providers/:id              修改 Base URL / Key / 启用 / 默认模型
POST   /api/providers/:id/test         真实连通性测试
POST   /api/providers/:id/refresh      真实拉取模型列表
POST   /api/chat                       真实流式补全（SSE：start/chunk/tool_call/done/error）
GET    /api/sessions                   会话列表
POST   /api/sessions                   新建会话
PUT    /api/sessions/:id               更新会话（含消息）
DELETE /api/sessions/:id               删除会话
POST   /api/sessions/:id/messages      追加消息
PUT    /api/sessions/:id/messages/:mid 更新消息
GET    /api/rss?url=                   服务端代理抓取 RSS/Atom（保留给扩展插件）
POST   /api/translate                  通过已配置模型真实翻译（保留给扩展插件）
GET    /api/events                     SSE 实时事件
GET    /api/logs                       近期请求与连接信息
```

---

## 哪些是真的 / 哪些没做

**真实可用**：模型接入与流式对话（OpenAI 兼容 / DeepSeek 官方 / Anthropic Claude / Google Gemini / Ollama，含各厂商原生工具调用与 reasoning 回传）、会话持久化（后端文件）、Markdown 渲染、全局搜索浮层（Ctrl+Shift+F）、
导出（MD/JSON/TXT/HTML/CSV/PDF）、主题/背景/气泡热切换、玻璃板透明度调节、插件运行时启停与卸载恢复、
插件自检与错误标红、外部插件目录（可指定任意目录 / 热扫描 / 删除，升级不丢失）、快捷键、三分类通知（系统通知 / 角色消息 / 其他；桌面端由宿主直发系统通知）、统一头像（默认风语 logo，可在顶栏更换）、错误上报、设置 → 聊天记录（图形逐条编辑 / JSON 源码双模式，草稿式保存）、**Nova 渠道工具调用循环（read_messages / chat_send / send_document / read_document）与工作记忆 / 渠道记忆 / 权限校验 / 敏感确认**；优先使用原生 `tool_calls`，模型只输出 `<tool_call>` JSON / DSML·DSLM 文本标记时也能解析并执行，标记不会进入气泡。
（气泡扩展、音乐播放器、番茄钟、RSS、TTS、翻译、Telegram 渠道已移出内置，后续以扩展插件形式回归；见「未实现清单」。）

**明确未实现（设置 → 未实现清单里也会列出）**：

| 功能 | 状态与原因 |
|---|---|
| 官方服务登录（账户 / 官方模型 / 计费） | 未实现：官方服务端由**独立的官网项目**提供，尚未发布；本仓库是纯客户端，不内置也不模拟云服务。用户自带模型时无需登录 |
| 多设备云同步 | 未实现：需要云端存储与冲突合并 |
| 微信 / Discord / 邮箱 / Telegram 渠道 | 未实现：协议与权限问题（添加渠道菜单里会标注原因）；Telegram 已从内置移除，待扩展插件回归 |
| 插件市场 / 在线安装 | 部分实现：本地外部插件目录已支持；市场与在线安装需要服务端索引与签名校验 |
| 代码运行器 | 部分实现：JavaScript Web Worker 沙箱（无 DOM / 无网络 / 5 秒超时）；Python / Node / 系统命令需要 OS 级沙箱，未实现 |
| 语音输入 | 部分实现：已接入浏览器 Web Speech API（Chrome / Edge）；不支持的浏览器仍提示插件扩展 |
| API Key 加密 | 部分实现：已用 AES-256-GCM 密文本机存储；尚未接入 Keychain / DPAPI 系统凭据库 |
| 桌面窗口控制 | 桌面端已实现：最小化 / 最大化 / 关闭与「关闭时最小化」；浏览器环境仅提供页面内提示 |

---

## 调试

```js
__wind_debug.runtime          // 'cordis'
__wind_debug.status()         // 84 个插件状态 / 原因 / 告警
__wind_debug.services()       // 服务台账（含归属）
__wind_debug.fibers()         // 每个插件对应的 cordis fiber 状态
__wind_debug.trace(true)      // 打开事件追踪
__wind_debug.enable('bg-solid')   // 运行时启用插件
__wind_debug.graph()          // 依赖图与拓扑顺序
```

后端数据目录默认是 `user_data/`：`config.json`（配置与凭据）、`sessions.json`（全部会话与消息）。
* 首次启动如果检测到旧版 `data/` 里有数据，会自动复制到 `user_data/`（只复制，不删除）
* `设置 → 数据` 可以把实例切换到任意目录（不存在自动创建；目标已有数据则加载目标实例），并支持「恢复默认」
* 指向的目录记录在 `user_data/instance.json`；删掉 `config.json` / `sessions.json` 即可恢复初始状态（`.secret-key` 用于加密凭据，备份时要保留）

---

## 延伸阅读

* [`docs/WINDOWS.md`](docs/WINDOWS.md) — Windows 双击脚本、代理安装与排障
* [`docs/DESKTOP.md`](docs/DESKTOP.md) — 无边框桌面端与 `release/` 打包说明
* [`docs/DEPENDENCIES.md`](docs/DEPENDENCIES.md) — 依赖与许可证清单（`npm run audit:deps`）
* [`docs/COMMERCIAL-USE.md`](docs/COMMERCIAL-USE.md) — 商用可行性检查与合规清单
* [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md) — 第三方组件与许可证声明
* [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — 架构实现（cordis + 后端）
* [`docs/CHAT-FLOW.md`](docs/CHAT-FLOW.md) — 一条消息经过哪些插件：聊天链路复盘
* [`docs/STATUS.md`](docs/STATUS.md) — 当前完成状态与遗留事项（交接用）
* [`docs/PLUGIN-GUIDE.md`](docs/PLUGIN-GUIDE.md) — 插件开发指南
* [`docs/PLUGIN-LIST.md`](docs/PLUGIN-LIST.md) — 84 个插件清单与状态

## 常见问题

**聊天时提示"尚未配置模型提供商"？**
这是预期行为：去 `设置 → 模型` 配置 DeepSeek 官方、OpenAI 兼容接口、Anthropic、Google Gemini 或本地 Ollama。

**Ollama 测试连接失败？**
先确认 `ollama serve` 正在运行、地址是 `http://localhost:11434`、并且至少 `ollama pull` 过一个模型。

**后端离线会怎样？**
WebUI 会出现「离线模式」提示条，会话暂存浏览器本地；后端恢复后可点「重试」同步。






