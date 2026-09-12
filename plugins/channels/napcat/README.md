<!--
念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
项目全称：念风 Chat（NianFeng-Chat）
仓库：https://github.com/nianfeng233/NianFeng-Chat
-->
# NapCat 渠道插件（念风Chat）

通过 [NapCatQQ](https://github.com/NapNeko/NapCatQQ) 的 OneBot 11 协议接入 QQ 私聊与群聊。
安装后，「渠道 → 添加渠道」会出现 **NapCat** 类型；渠道支持 **私聊 / 群聊 / 隐私** 三类，
并在创建时指定**目标 QQ 号或群号**用于启用聊天。

## 功能

- **连接池 / 复用**：一个 NapCat 登录 QQ 只维护一条 WebSocket 连接，多个渠道共用一个
  `instanceId`，不会为每个渠道重复连接 NapCat；
- **两种连接模式**：
  - `Forward`：念风主动连接 NapCat 的 WebSocket 服务，例如 `ws://127.0.0.1:3001`；
  - `Reverse`：念风开一个独立反向 WebSocket 监听，NapCat 用「WebSocket 客户端」连过来；
    配置项与 AstrBot / NapCat 风格一致：**反向主机 / 反向端口 / 路径 / Token（可选）**。
    端口填 `0` 时会自动从 `6199` 起选空闲端口并保存，路径默认 `/ws`；Token 留空就保持空，
    兼容已有“只填 ws://主机:端口/ws”的 NapCat 反向配置；
- **精准身份**：私聊身份展示 `QQ昵称（QQ号）`；群聊身份展示 `群号 · 群昵称 · QQ昵称 · QQ号`；
- **群聊规则面板**：
  - 黑名单：无视指定 QQ 号的消息，优先级最高，命中后永不会触发；
  - 白名单：只允许列表里的 QQ 触发回复；
  - 启用艾特才回复：只有消息 @ 登录的机器人 QQ 时才调用模型；可单独选择是否应用白名单；
  - 回复概率：关闭艾特限制后，任意消息按概率触发模型；可单独选择是否应用白名单；
  - 回复时引用触发消息；
  - 回复时艾特触发者；
  - 未触发时也静默写入本群上下文（默认开启）；
- **群聊上下文**：本群消息无论是否触发都默认静默写入，上下文使用本群最近 **20 轮**滚动记录，
  不会和其它私聊渠道串记忆；
- **发现会话**：连接后会拉取好友 / 群列表并记录最近消息，可在渠道详情里直接“设为目标”；
- **完整聊天记录**：入站消息按渠道落库，可在「设置 → 聊天记录」按角色 / 渠道查看与修改；
- **消息发送**：模型整轮结束后才回复；支持文本拆分、引用、艾特与图片（`base64://` 发图）。

## 使用步骤

### Forward（推荐，本机 NapCat）

1. 打开 NapCat 的网络配置，开启 **WebSocket 服务器**，记下端口（默认常见 `3001`）与 `token`；
2. 念风「渠道 → 添加渠道 → NapCat」；
3. 选择角色、分类和目标：
   - **私聊 / 隐私**：目标填对方的 QQ 号；
   - **群聊**：目标填群号；
   - 只有这个目标的消息会进入本渠道，不会把同机器人其它会话的聊天混进来；
   - 已经有连接后，可以点「从已发现会话选择…」从该 NapCat 收到过 / 拉取到的好友群列表里挑目标；
4. NapCat 连接选择「新建一个 NapCat 连接」，方式选 Forward，填地址与 token，保存即可。

### Reverse（远程 / 内网穿透，与 NapCat「WebSocket 客户端」对应）

1. 新建渠道或到「设置 → 插件 → NapCat → 设置 → 新建连接」，方式选 Reverse；
2. 填写 **反向主机**（本机填 `127.0.0.1`；云服务器要远程接入可填 `0.0.0.0`）、
   **反向端口**（推荐填 `0` 自动分配，或手动填 `6199`）、**路径**（默认 `/ws`），
   Token **可选**；已有 NapCat 没配 Token 就保持留空；
3. 保存后点击「连接地址」，直接复制 `ws://主机:端口/ws`（如果设置了 Token，也可以复制带
   `?access_token=...` 的完整地址）；
4. 在 NapCat 的网络配置中新建 / 继续使用 **WebSocket 客户端（反向）**，地址格式与你现有
   AstrBot 里的 `ws://localhost:6199/ws` 一致；
5. 回到念风点「连接 / 刷新」，状态变为已连接即可。

## 连接复用规则

- 创建第二个、第三个 NapCat 渠道时，连接下拉框会自动优先选择：
  - 同一角色已用过的连接；
  - 已在线 / 已被更多渠道复用的连接。
- 也可以手动切换为其它已有连接，或新建连接。
- 后端对相同地址 + token 的 Forward 连接也会自动复用，避免重复连接。
- 同一个 NapCat 登录 QQ 请只使用一条连接；反向模式下不要为同一 QQ 配置多个反向地址。

## 上下文与权限

- `私聊`：参与角色级工作记忆，和其它普通私聊渠道共享角色记忆；
- `群聊`：`channel-only` 模式，只取本群最近 20 轮记录，未触发也静默写入；
- `隐私`：独立单会话，不读取 / 不参与其它任何渠道的工作记忆；
- 权限沿用渠道基座：接收消息、自动回复、参与工作记忆、跨渠道读取 / 发送、敏感操作确认。

## 给其它插件的扩展接口

前端插件会在事件总线广播以下事件：

| 事件 | 说明 |
|---|---|
| `napcat:inbound` | 每条已落库的入站消息（含命中后的触发决策） |
| `napcat:trigger-decision` | **拦截型**事件，可修改 `trigger` / `ignore` / `rules` 接管群聊触发规则 |
| `napcat:ignored` | 被黑名单等规则忽略的消息 |
| `napcat:status` / `napcat:instances` | 连接状态与实例列表变化 |
| `napcat:discover` | 发现会话列表变化 |
| `napcat:notice` / `napcat:request` / `napcat:recall` | OneBot notice / request / 撤回事件 |

前端服务 `napcat-channel`：

```js
const napcat = ctx.inject('napcat-channel')
napcat.listInstances()
napcat.instance('napcat-xxxx')
napcat.rulesOf(channel)
napcat.targetOf(channel)
napcat.send({ channelId, text: 'hello' })
napcat.action('napcat-xxxx', 'get_friend_list', {})
```

后端后端桥注册了 `napcat` 服务，并提供 `/api/napcat/*` 路由（实例、渠道同步、发送、发现、收件箱、
通用 `action` 透传）。其它插件可直接注入后端 `napcat` 服务或注册依赖它的插件。

## 目录说明

```text
napcat/
├── index.mjs          # 前端 cordis 插件（渠道类型、创建/详情、规则、消息链路）
├── bridge.mjs         # Node 后端桥（连接池、OneBot 事件、发送、发现、HTTP 路由）
├── manifest.json
├── style.mjs
└── README.md
```

## 排错

- Forward 连不上：确认 NapCat 已开启 WebSocket 服务、端口 / token / 地址正确；Node 需要 22+ 原生 WebSocket；
- Reverse 连不上：确认念风后端已重启加载了本 bridge，地址和 token 与插件设置里一致；
- 账号未获取：点 NapCat 连接设置里的「刷新」，或先让 QQ 给机器人发一条消息；
- 群聊不回复：检查“启用艾特才回复”与回复概率，确认消息确实 @ 了机器人 QQ；黑名单会完全忽略消息。

## 许可

本插件原创部分与念风Chat 一致：Apache License 2.0。
