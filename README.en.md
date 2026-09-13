<!--
念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
项目全称：念风 Chat（NianFeng-Chat）
仓库：https://github.com/nianfeng233/NianFeng-Chat
-->
# NianFeng-Chat

English | [简体中文](README.md)

NianFeng-Chat is a local-first, plugin-based AI chat client. Both the frontend and the local backend run on cordis,
and features are organized as plugins. The plugin directory and the data directory can both be
placed outside the application directory. The same source tree builds both a Web deployment and
a Windows desktop application.

> Note: This README was organized and generated with the assistance of DeepSeek (AI).
> The actual code and automated tests are the source of truth for behavior.

- Current version: v1.1.4
- License: Apache License 2.0 (see [LICENSE](LICENSE) and [NOTICE](NOTICE))
- Repository: <https://github.com/nianfeng233/NianFeng-Chat>
- Official QQ group: 1109357470

## Features and Architecture

- **Frontend core**: real cordis v4 (plugin fibers, dependency injection, event bus, service
  container). Plugins are grouped into kernel / foundation / domain / shell / views / features / extras.
- **Local backend**: a Node.js cordis application with a hand-written HTTP/SSE layer and no Web
  framework. It handles model access, session persistence, file serving, and related services.
- **Desktop shell**: Rust + WebView2 borderless window with an embedded portable Node runtime,
  packaged as a single `念风Chat.exe`.
- **Selectable services**: themes, backgrounds, bubble styles, models, and languages can each have
  multiple implementations that are selected in Settings.
- **External plugins**: built-in plugins ship with each release; user plugins can live in
  `<data-dir>/plugins/` or any chosen directory and are loaded after a rescan. Upgrading the exe
  does not delete the external plugin directory.
- **External storage**: the data directory can be changed in Settings; the plugin directory can be
  configured independently.
- **Network**: listens on `127.0.0.1` by default. It can bind to `0.0.0.0` with an access token;
  changes take effect after the prompted restart.
- **Notifications**: system, character-message, and other notifications; character messages include
  the character avatar and a preview. Built-in and custom notification sounds are supported.
- **Immediate channel delivery**: assistant messages are sent to the target channel as soon as they
  are written, instead of waiting for the whole model turn to finish. Cross-channel `chat_send`
  calls therefore really reach the target channel (sensitive operations still require confirmation).
  When a tool sends several messages, the first one goes out immediately and the rest keep the
  simulated-human typing delay on both web and external channels.
- **Input state**: the WeChat clawbot keeps its typing state alive for the whole turn, re-asserting it
  after authorization prompts or replies, and stops only when the turn is completely done. A separate
  `napcat-input-state` extension keeps refreshing NapCat private-chat `set_input_status`; group input
  state is not supported by the OneBot API.
- **Mobile layout**: mobile browsers automatically get a single-column layout with a back bar and a
  bottom navigation for Chat / Channels / Settings; use `?mobile=1` or `?mobile=0` to debug.
- **Runtime logs**: Settings → System → Runtime Logs is backed by the same persistent
  terminal log stream (`runtime.log`) and shows DEBUG-level model start / done / timeout, tool
  timings, confirmation results, outbound delivery, HTTP requests, and frontend chat-flow logs.
  SSE pushes updates in real time with polling fallback; refreshing the page or restarting the
  backend keeps the history.
- **Languages**: Simplified Chinese is provided by the built-in `lang-zh-cn` language-pack plugin;
  copy that plugin and edit its translation table to add another language.

## Conversation Model

The model reads and writes messages through tools:

- Read tools: `read_messages` (query message history), `read_document` (read long documents within a
  token budget).
- Write tools: `chat_send` (send one or more chat messages), `send_document` (send a long document,
  storing only a reference and summary).

Implementation notes:

- Role-level working memory and channel-level recent messages are stored separately.
- A single model turn may send several messages through `chat_send`; each message is displayed
  independently, and tool-call protocol data is not rendered into chat bubbles.
- Long documents are stored in the document library. Chat records keep only `doc_id`, title, and
  summary; the full text is read on demand.
- Messages carry `message_id / seq / channel_id / timestamp / sender / visibility / source`.
- Channel read/write permissions, sensitive-action confirmation, and audit logs are supported.

## Quick Start

Requires Node.js ≥ 20.

```bash
npm install
npm start
```

Then open Settings → Models, add a provider (OpenAI-compatible / DeepSeek / Anthropic / Gemini /
Ollama), fill in the Base URL and API key, fetch the model list, and choose a default model.

On Windows you can also double-click `start.cmd`.

## Settings Overview

- **Data**: change the data directory; an empty directory starts a fresh instance, while a directory
  containing `config.json` / `sessions.json` loads that instance.
- **Plugins**: the built-in plugin directory is read-only; the external plugin directory can be
  selected, opened, rescanned, and external plugins can be deleted.
- **Network**: WebUI host, port, and access token. When a token is set, open
  `http://<host>:<port>/?token=YOUR_TOKEN`; a successful check stores a cookie.
- **Notifications**: character-message notifications, sound, background activity, system-notification
  permission, notification sounds, and test buttons.
- **Runtime logs**: Settings → System → Runtime Logs; filter by level / category / keyword, pause,
  clear, or copy, with timeouts and failed outbound deliveries highlighted in red.
- **Language**: Simplified Chinese comes from the `lang-zh-cn` plugin; copy it to create another
  language pack.

## Plugins

Regenerate the built-in plugin registry:

```bash
npm run sync-plugins
```

External plugins live in `<data-dir>/plugins/` by default (for the exe:
`%LOCALAPPDATA%\NianFengChat\user_data\plugins\`) and use this layout:

```text
<external-dir>/views/my-plugin/index.mjs
```

After copying a plugin, click “Rescan” in Settings → Plugins and reload. Plugin module protocol:

```js
export const name = 'my-plugin'
export const version = '1.0.0'
export const displayName = 'My Plugin'
export const description = 'Plugin description'
export const core = false
export const inject = []
export function apply(ctx) {
  // ctx.provide / ctx.on / ctx.slots.register ...
}
```

Plugins can register their own settings panels; the Plugins page then shows a “Settings” action:

```js
export function apply(ctx) {
  const manager = ctx.inject('plugin-manager')
  ctx.effect(() => manager.registerSettings({
    id: 'my-plugin',
    title: 'My Plugin Settings',
    description: 'Plugin-specific configuration.',
    render(container, { close, manager: pm }) {
      container.innerHTML = '...'
      return () => { /* cleanup on close */ }
    },
  }))
}
```

Channel backend bridges are auto-discovered from `plugins/channels/<name>/bridge.mjs`; inject
`httpApi` and register your own `/api/<channel>/...` routes without touching the core.

### Built-in channel plugin: WeChat Clawbot

- Add it from Channels → Add Channel → **WeChat Clawbot**;
- configure role, category (private/group/privacy), user name / user id and permissions;
- click Connect in channel details, scan the QR code with WeChat, then use it;
- channel messages go through the full model pipeline; typing is closed after the whole model
  call (including tool calls and all reply messages) finishes;
- channel conversations are hidden from the normal session list and can be viewed/edited under
  Settings → Chat Records;
- plugin-specific panel: Settings → Plugins → WeChat Clawbot → Settings.

## Building

```bash
npm run build:release   # Web source + Web deploy + desktop source + 念风Chat.exe
npm run build:desktop   # desktop only
```

Artifacts are written to `release/`:

- `release/web/source/`: clean Web source;
- `release/web/deploy/`: Web deployment with a portable Node runtime;
- `release/desktop/source/`: desktop shell source and runtime app;
- `release/desktop/deploy/念风Chat.exe`: single-file Windows desktop build.

`node.exe`, `念风Chat.exe`, and deployment archives are large and are distributed as GitHub Release
assets rather than committed to Git.

## Tests

```bash
npm test              # module checks + backend API + end-to-end + chat / tools / vendor protocols
npm run test:smoke    # frontend end-to-end against the real backend and SSE
```

`npm test` currently passes; `scripts/smoke.mjs` passes 212 checks.

## Versioning and Releases

- The version is stored in both `package.json` and `scripts/desktop-wrapper/Cargo.toml`.
- The release repository is generated by `scripts/prepare-publish.mjs` from `release/web/source`,
  followed by a mandatory sensitive-information scan.
- Release process, semantic versioning, hotfixes, and rollback rules: [`docs/RELEASING.md`](docs/RELEASING.md).

The scan rejects usernames, local absolute paths, API keys, private keys, email addresses, phone
numbers, `user_data`, and similar content.

## Security and Privacy

- Listens on `127.0.0.1` by default; public access requires explicitly configuring the bind address
  and an access token.
- API keys and sensitive request headers are stored locally as AES-256-GCM ciphertext in the data
  directory.
- When backing up data, copy the `.secret-key` file in the same directory as well.
- User data and the external plugin directory are independent of the source tree; Git repositories
  never contain user data.

## Directory Layout

```text
.
├── index.html
├── start.mjs             # backend + WebUI + reverse proxy
├── server/               # local backend (cordis application)
├── src/                  # frontend runtime and utility libraries
├── plugins/              # built-in frontend plugins
├── scripts/              # build, test, and release scripts
├── docs/                 # architecture, plugin, and release documentation
├── public/               # static assets
└── user_data/            # created at runtime: config, sessions, key, external plugins (not in Git)
```

## Third-Party Dependencies and Licenses

- Original project code, documentation, and assets: Apache License 2.0;
- Third-party components and license texts: [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md);
- Generated dependency inventory: [docs/DEPENDENCIES.md](docs/DEPENDENCIES.md);
- Commercial distribution notes: [docs/COMMERCIAL-USE.md](docs/COMMERCIAL-USE.md).

## Documentation

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — architecture and data flow
- [`docs/CHAT-FLOW.md`](docs/CHAT-FLOW.md) — message pipeline
- [`docs/PLUGIN-GUIDE.md`](docs/PLUGIN-GUIDE.md) — plugin development guide
- [`docs/PLUGIN-LIST.md`](docs/PLUGIN-LIST.md) — plugin inventory
- [`docs/RELEASING.md`](docs/RELEASING.md) — versioning and release process
- [`docs/WINDOWS.md`](docs/WINDOWS.md) — Windows usage and troubleshooting
- [`docs/DESKTOP.md`](docs/DESKTOP.md) — desktop shell build
