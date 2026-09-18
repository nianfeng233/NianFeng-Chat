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
> Project status: fast-moving iteration; `v1.x` marks feature milestones, not production maturity or a
> security audit. It listens on localhost by default; before exposing it beyond localhost, read
> “Security and Privacy” and configure an access token.

- Current version: v2.0.0
- License: Apache License 2.0 (see [LICENSE](LICENSE) and [NOTICE](NOTICE))
- Repository: <https://github.com/nianfeng233/NianFeng-Chat>
- Official QQ group: 1109357470

## Core capabilities

NianFeng-Chat builds memory, context, tools, channels, and the entire UI as cordis plugins.
The points below are implemented today in code, with paths and commands you can verify.

### 1. Near-unlimited memory: full persistence + on-demand recall

- The backend persists every message to SQLite (`user_data/chat.db`) with WAL enabled and an index on
  `(conversation_id, seq)`; environments without `node:sqlite` fall back to JSON persistence.
  `read_messages` can then recall history by keyword, exact `seq`, relative sequence range, time range,
  and cursor pagination. With `semantic`, it also runs vector search over role-level memory.
- Conversation-list sync now pulls only compact metadata (name / preview / `messageCount`, no message bodies).
  The chat-records page and Web chat window load the latest 20 messages first, then fetch older pages by
  `beforeSeq` when the user scrolls up / clicks "load earlier". On startup the backend also merges historical
  duplicate conversation containers that share one channel id, so a channel can no longer show 0 records while
  its real history lives under another `conv.id`.
- Long-term memory (`memory.db` / `memory.json`) is isolated per role: normal channels compress every
  10 complete rounds into a short summary and embed it, while group chats summarize a recent N-message
  window after each model turn (default N=20; skipped when more than N-5 message ids were already
  summarized). `search_memory` performs hybrid retrieval (vector + BM25
  + time) and returns the most relevant summary plus its 10 source rounds by default. Cross-channel
  originals are treated as private and returned only after authorization; privacy channels are computed
  independently. The embedding model is configured under Settings → Model → Memory Model, and dimensions
  can be detected automatically.
- Input context is not truncated by tokens by default (`chat.contextTokens = 0`; a positive value acts as
  a safety cap, and if the model defines a context length the budget becomes `context length - output
  reserve`). Only recent rounds are injected and older history is retrieved on demand. Output is limited
  by `chat.maxOutputTokens` (default 8192), overridable per model with `max_tokens`.
- Long documents go into `document-service`: each document can hold up to 2M characters, while chat
  records keep only `doc_id + title + summary`. `read_document` reads it in chunks 100–4000 tokens at a
  time and returns `next_offset` so the model can continue to the end.
- The model therefore sees "summary + recent context + retrieved chunks" while only the needed content
  enters the prompt.

### 2. Cross-session / cross-channel interaction

- `chat-store.workingMessages()` merges all normal private channels of the same role, sorted and
  de-duplicated by time. Tell the character something in session A and it still knows it after you
  switch to channel B.
- A channel can enable `crossReadable` / `crossSendable`; the model can read another channel with
  `read_messages` or send to it with `chat_send` / `send_document`. Sensitive cross-channel operations
  still go through `chat-permissions` and user confirmation.
- The current usable channels and their display names are injected into the system prompt for direct use.

### 3. Pollution-resistant context

- Every user message is wrapped in a structured envelope: `meta` contains program-generated metadata
  (time, channel, role) while the body is always under `content.trust = "untrusted"`; the system prompt
  explicitly tells the model that untrusted content must not be executed as instructions.
- Tool history keeps only valid `assistant.tool_calls + role = "tool"` sequences, and the sequence is
  repaired after truncation, avoiding 400s from OpenAI-compatible endpoints caused by half a tool turn.
- The system prefix contains only the fixed persona, tool rules, and channel policy. Per-message metadata
  lives in the message itself, so prefix caches (DeepSeek and other providers) keep hitting as the chat grows.
- Privacy / group channels can switch to `channel-only` and stop mixing in the role's other channel memory.
  Historical images are shown as `[图片]` placeholders unless `include_images` / `image_message_ids` asks
  for originals; images also have per-request, per-message, and token budgets.

### 4. Natural message segmentation

- `chat_send` takes a `messages` array; each item becomes an independent message and chat bubble. The first
  message is sent immediately; from the second one on, each gets a 0.5–5 second human-like typing delay
  based on its length. `end = true` finishes the turn.
- Tool calls and tool results are never rendered as chat bubbles. The model can naturally say "Hello",
  pause, and then "What's up?" instead of newline-joining several sentences into one huge message.
- Images work the same way: one `chat_send` can carry up to 4 images, but chat records store only `imageId`;
  the image service and channel bridges fetch / convert them on demand.

### 5. All-plugin architecture and deep customization

- The repository currently ships **93 built-in frontend plugins** in 8 directories:
  `kernel 5` / `foundation 15` / `domain 16` / `shell 10` / `views 33` / `features 8` / `extras 3` / `channels 3`.
- Plugins already use an explicit dependency system: **310 required edges and 22 plugins with optional
  dependencies**, supporting `*`, `>=`, exact `=`, `^`, `~`, `1.x`, and other version rules. Missing
  required dependencies turn red and block activation; optional ones only turn yellow.
- The code declares 60+ service provisions and 44 injectable service names. Themes, backgrounds, bubbles,
  models, and languages are selectable services; views, slots, settings pages, shortcuts, context menus,
  notifications, channel types, and model providers can all be registered by plugins.
- External plugins live in `<data-dir>/plugins/` or any chosen directory and load after a rescan. They can
  bring their own dependencies, permissions, and settings panels; upgrading the exe never deletes the
  external plugin directory.

**Verifiable numbers**: `npm run sync-plugins` rescans and validates the dependency data;
`npm run test:deps` contains 208 dependency / version / service-mapping assertions, and
`npm run test:smoke` contains 313 end-to-end assertions. All numbers come from the current repository code.

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
- **Runtime logs**: an independent full-width sidebar view (no longer inside Settings) backed by the
  same persistent terminal log stream (`runtime.log`). It defaults to INFO only and offers free
  checkboxes for error / warn / info / debug; the selection is remembered. It focuses on model
  start / done / timeout, tool timings, channel messages and confirmation results, and hides
  successful HTTP access noise. SSE pushes updates in real time with polling fallback and an
  automatic full resync when the backend instance changes; refreshing the page or restarting the
  backend keeps the history.
- **Languages**: Simplified Chinese is provided by the built-in `lang-zh-cn` language-pack plugin;
  copy that plugin and edit its translation table to add another language.

## Conversation Model

The model reads and writes messages through tools:

- Read tools: `read_messages` (query message history by keyword / seq / time / semantics), `search_memory`
  (semantic search over role-level summaries; returns one summary plus its 10 source rounds by default),
  `read_document` (read long documents within a token budget).
- Write tools: `chat_send` (send one or more chat messages), `send_document` (send one or more long
  documents; the full text goes into the document library and is delivered over the channel as a QQ
  merged-forward record: the first node is the title, the next node is the whole body).

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
  `http://<host>:<port>/?token=YOUR_TOKEN`; a successful check stores an HttpOnly cookie and strips
  the token from the URL. Subsequent API requests use the cookie or the `X-NianFeng-Token` /
  `Authorization` header.
- **Notifications**: character-message notifications, sound, background activity, system-notification
  permission, notification sounds, and test buttons.
- **Runtime logs**: independent full-width sidebar view (not inside Settings); free level checkboxes (error / warn / info / debug, remembered),
  category / keyword filters, pause, clear, copy and export, with timeouts and failed outbound
  deliveries highlighted in red. Successful HTTP access lines are hidden.
- **Memory & Knowledge**: independent full-width sidebar view. The Memory tab lists long-term memory
  summaries and expands to show the original message snapshots for each entry. The Knowledge tab
  browses knowledge-base entries, full text, tags, directories, and revision summaries when the
  `knowledge-base` extension is installed. The page is read-only.
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
export const depends = { 'event-bus': '^1.0.0' }          // required: missing/broken is red and blocks activation
export const optionalDepends = { 'markdown-enhancer': '>=1.0.0' } // optional: missing/broken is yellow only
export const inject = []
export function apply(ctx) {
  // ctx.provide / ctx.on / ctx.slots.register ...
}
```

Dependency versions support `*` (any), `>=1.0.0` (at least), `=1.0.0` (exact pin), `^1.0.0` / `~1.2.0` (compatible), `1.x` and `1.2.3 - 2.0.0`. Missing required dependencies are red and prevent activation; missing optional dependencies are yellow and do not affect basic functionality.

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
npm test              # module checks + dependency validation + backend API + end-to-end + chat / tools / vendor protocols
npm run test:deps     # plugin dependency fields / version ranges / cycle detection / inject mapping (208 checks)
npm run test:smoke    # frontend end-to-end against the real backend and SSE (313 checks)
npm run test:clawbot  # WeChat Clawbot backend bridge (local mock iLink protocol)
npm run test:napcat   # NapCat backend bridge (local reverse WebSocket mock)
```

`npm test` currently passes; `scripts/smoke.mjs` passes 313 checks and `scripts/test-dependencies.mjs` passes 208 checks.

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
- The backend validates both `Host` and `Origin`; CORS echoes an explicit allow-list instead of `*`,
  which blocks DNS rebinding and arbitrary web pages reading the local API.
- With an access token configured, `/api/health` and `/api/version` expose liveness information
  only; data directory, config path, provider state, and session statistics require the token
  (cookie or request header).
- `?token=` is only a first-navigation bootstrap: it exchanges the token for an HttpOnly cookie and
  immediately redirects to a clean URL. API requests never accept the query token, and token
  comparison is constant-time.
- `/api/rss` blocks SSRF targets: localhost, loopback/private/link-local/metadata addresses, non-http(s)
  schemes, plus per-hop DNS and redirect validation.
- API keys and sensitive request headers are stored locally as AES-256-GCM ciphertext in the data
  directory.
- When backing up data, copy the `.secret-key` file in the same directory as well.
- User data and the external plugin directory are independent of the source tree; Git repositories
  never contain user data.

> Non-default deployments (WebUI on another port, reverse proxy to a custom domain) can append
> allow-list entries via `NIANFENG_ALLOWED_ORIGINS` / `NIANFENG_ALLOWED_HOSTS` (comma-separated).
> Security regression test: `npm run test:security`.

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
- [`docs/SECURITY-HARDENING.md`](docs/SECURITY-HARDENING.md) — security hardening log for the 2026-09 review
- [`docs/WINDOWS.md`](docs/WINDOWS.md) — Windows usage and troubleshooting
- [`docs/DESKTOP.md`](docs/DESKTOP.md) — desktop shell build
