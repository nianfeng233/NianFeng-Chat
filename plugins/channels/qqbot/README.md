<!--
念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
项目全称：念风 Chat（NianFeng-Chat）
仓库：https://github.com/nianfeng233/NianFeng-Chat
-->
# QQ官方机器人 渠道插件（念风Chat）

通过 QQ 官方机器人 OpenAPI v2（正式 `api.bot.qq.com` / `api.sgroup.qq.com`，沙箱 `sandbox.api.sgroup.qq.com`）接入 **QQ 私聊（C2C）与 QQ 群聊（`GROUP_AT_MESSAGE_CREATE` / `GROUP_MESSAGE_CREATE`）**。

> 群聊范围：QQ 群默认只推送 **@机器人** 的消息；群管理员在 QQ 群设置里打开「机器人可获取群内全部消息」后，
> 未 @ 的消息也会通过 `GROUP_MESSAGE_CREATE` 进入本渠道。群成员身份使用 `author.member_openid` 作为群内专属 id，
> 群昵称通过群成员信息只读接口 best-effort 获取，拿不到时回退为「QQ成员·尾号」。群聊与 NapCat 渠道一样
> 只使用本群最近若干条消息作为上下文，并支持触发概率 / 白名单 / 黑名单 / 静默上下文等群规则。
>
> 多机器人联动：两个 QQ 官方机器人渠道填上相同的「跨机器人联动标识」后，出站群消息会在本地互相镜像；
> 可配置“对方发言时自动接话”和每个用户消息后的接话轮数上限，适合双角色 bot 同群互动。

## 功能

- 在「渠道 → 添加渠道」中注册 **QQ官方机器人** 类型；
- 添加渠道时选择角色、渠道分类（私聊 / 群聊 / 隐私）与权限；
- 两种接入方式：
  - **扫码接入（推荐）**：调用 `q.qq.com` 官方 `/lite/create_bind_task` + `/lite/poll_bind_result`；手机 QQ 扫一扫二维码 → 确认授权 → 自动拿到 AppID / AppSecret（AES-256-GCM 解密），无需手动去开放平台复制密钥；
  - **手动 AppID + AppSecret**：QQ 开放平台直接获取；
- 本地接入不需要公网、也不需要手动加 IP 白名单：
  - 扫码账号默认走 WebSocket 出站连接；若正式 OpenAPI 返回 `11298 / 40023002`，插件会**自动切换为沙箱环境**（`sandbox.api.sgroup.qq.com`，实测免 IP 白名单）并继续连接；
  - 手动凭据保持显式选择：正式 / 沙箱由用户在接入弹窗中选择，不会静默切换；
- 扫码确认后，如果 `poll_bind_result` 返回 `user_openid`（QQ Connector 1.2.0 起），自动绑定模式会把它直接绑成本渠道默认会话，扫完码即可私聊；手动绑定模式则只把该 openid 加入「允许确认的用户」列表；
- 未绑定 / 未匹配到绑定关系的私聊，bridge 会自动回一条被动消息，提示到 WebUI「发现会话」复制 openid 并绑定；同一个 openid 10 分钟内只提醒一次；
- 渠道被删除后会自动清理对应的聊天记录容器，启动时也会清理已经没有渠道的孤立记录，聊天记录页不会残留已删除渠道；
- 连接方式支持 **WebSocket 网关**（本地直连，推荐，Node 22+）与 **Webhook 回调**（需公网 HTTPS）；
- 登录凭据保存在本机数据目录，并具有以下恢复行为：
  - 保存渠道不会自动弹二维码，点详情里的「接入」才进入连接流程；
  - 已有凭据时再次打开「接入」会直接复用重连，不重复创建绑定任务，因此不会出现“重新扫码时手机提示机器人已绑定”；
  - 断开渠道或从渠道列表删除渠道只停用 / 移除本机渠道，不删除 AppID / AppSecret，之后可在新渠道里直接复用；
  - 重启时未完成的扫码任务会被恢复并继续轮询。
- 渠道可绑定一个私聊 openid（C2C）或一个群 openid（群聊）；同一 AppID 可创建多个渠道（多个私聊 / 群会话、多个角色），互不串线；
- 群成员以 `member_openid` 作为群内唯一身份标识，消息 `sender_name` / `senderNickname` 使用群昵称；
- 群聊上下文与 NapCat 对齐：`channel-only`、按条数读取（默认 20，可配置）、@ 默认 100% 回复（可在「被 @ 时必定回复」里关掉，改为参与概率 / 白名单）、未 @ 消息按概率 / 白名单 / 黑名单触发、未触发时静默写入；「回复时引用触发消息」「回复时艾特触发者」两个开关默认关闭，可单独勾选；QQ 群开启「机器人可获取群内全部消息」后，未 @ 消息也会进入本渠道；
- 多机器人联动（1.4.0）：群聊渠道可以配置同一个「跨机器人联动标识」，本机把出站群消息镜像给同标识的其它 QQ 官方机器人渠道；对方消息默认只写入上下文，开启自动接话后按轮数上限回应，避免两个 bot 无限刷屏；
- SILK 语音（1.5.0）：`/send` 支持 `voice: { dataUrl | base64 | url }`，群聊 / 私聊分别上传到 `/v2/groups/{group_openid}/files` 或 `/v2/users/{openid}/files`（`file_type=3`、`srv_send_msg=false`），再用 `msg_type=7 + media.file_info` 发送；非 SILK 会返回 `VOICE_FORMAT_INVALID`；
- 后端向其它插件提供 `qqbot` 服务（`send` / `channelInfo` / `supportsVoice` / `voiceFormat`），点歌台 media-post 的 `mode=voice` 会自动转 SILK 后调用；
- 图片收发：入站附件转存到 image-service，出站经 `/v2/users/{openid}/files` 或 `/v2/groups/{group_openid}/files` 上传后以 `msg_type 7` 发送；
- 入站消息写入所选角色的 qqbot 渠道记录，并走念风完整模型链路；
- 模型整轮调用（包括工具调用与全部回复消息）结束后，回复才作为 QQ 被动消息发出。

## 扫码协议（QQ Connector 1.2.0 / AstrBot 最新版同款）

```text
1) POST https://q.qq.com/lite/create_bind_task
   body: { "key": "<base64 32字节 AES-256 key>" }
   resp: { "retcode": 0, "data": { "task_id": "..." } }
2) 展示二维码内容：
   https://q.qq.com/qqbot/openclaw/connect.html?task_id=<task_id>&_wv=2&source=nianfeng
3) 手机 QQ 扫码并确认后轮询：
   POST https://q.qq.com/lite/poll_bind_result  body: { "task_id": "..." }
   status: 0 未开始 / 1 待确认 / 2 已完成 / 3 已过期
4) status=2 时返回：
   bot_appid + bot_encrypt_secret + user_openid
   bot_encrypt_secret = base64(nonce[12] + ciphertext + tag[16])
   用第 1 步的 key 做 AES-256-GCM 解密，得到 AppSecret。
```

拿到 AppID/AppSecret 后复用 OpenAPI：`api.bot.qq.com` 换 token（不可达时回退 `bots.qq.com`）→ `api.bot.qq.com` / `api.sgroup.qq.com` WebSocket 或 Webhook。正式环境被 IP 白名单拒绝时，扫码账号自动降级到 `sandbox.api.sgroup.qq.com`。

## QQ 官方接口的关键事实

- 私聊：`C2C_MESSAGE_CREATE`，`author.user_openid` 是用户；新版事件还可能带 `author.username`（用作昵称）；
- 群聊：`GROUP_AT_MESSAGE_CREATE`（@机器人）与 `GROUP_MESSAGE_CREATE`（群开启全量消息后的普通消息），`group_openid` 是群，`author.member_openid` 是该成员在群内的专属 id；
- 群昵称：事件可能带 `nickname / nick`；没有时 bridge 会 best-effort 请求群成员信息只读端点并缓存，失败则用「QQ成员·尾号」；
- 官方接口给的是 **openid，不是 QQ 号 / 群号**；openid 对每个机器人不同，无法反查；
- 图片在 `d.attachments[]`（`content_type` 以 `image` 开头，HTTPS URL）；
- 群聊回复使用 `POST /v2/groups/{group_openid}/messages`，图片上传使用 `POST /v2/groups/{group_openid}/files`；被动回复窗口约 5 分钟。

## 被动回复策略

- 不预先按 TTL 拒绝：总是先带 `msg_id + msg_seq` 尝试被动回复；
- 同一条消息最多 5 次；超过时若开启「允许主动消息」则改发主动消息，否则提示失败；
- 主动消息默认关闭（QQ 官方每月仅 4 条）。

## 如何获取自己的 openid 并授权

### 私聊（C2C）

1. 扫码确认后，自动绑定模式会直接把扫码用户 `user_openid` 绑为本渠道默认会话；
2. 如果是手动绑定模式，或收到了其它 openid 的消息，打开渠道详情 →「发现会话」会出现对应 openid；
3. 点「绑定到本渠道」即可；也可以复制 openid 填进编辑窗口的「允许确认的用户 openid」；
4. 绑定项默认「视为主人」，跨渠道确认默认由你放行；如果是「独立用户」模式，点「信任该 openid」。

### 群聊

1. 创建渠道时把「渠道分类」选为 **群聊**，保存后到详情页「接入」；
2. 把机器人拉进群，在群里 **@机器人** 发一条消息；
3. 自动绑定模式会把该群的 `group_openid` 绑为本渠道；手动绑定模式则在详情页「发现会话」里手动绑定群；
4. 群成员身份使用 `member_openid`（群内专属 id），群昵称由成员信息接口回填，显示为正常的群内称呼；
5. 群聊规则（@ 直回、概率 / 白名单 / 黑名单 / 静默上下文 / 上下文条数）可在编辑渠道的「群聊规则」里配置；
6. 如果希望未 @ 的普通群消息也写入聊天记录并参与概率触发，请群管理员在 QQ 群设置里打开 **「机器人可获取群内全部消息」**；仅 @ 消息时，QQ 平台不会把普通消息推给插件。

## 环境与排错

- **正式环境**：OpenAPI 使用 `api.bot.qq.com` / `api.sgroup.qq.com`，需要在 QQ 开放平台把调用方公网 IP 加入白名单（错误码 11298 / 40023002）；
- **沙箱环境**：`sandbox.api.sgroup.qq.com`，本地实测无需 IP 白名单；扫码账号被正式环境拒绝后自动降级，渠道详情里会显示「接入环境：沙箱（自动降级，免 IP 白名单）」；
- Webhook 模式仍需要公网 HTTPS 回调，本地推荐默认的 WebSocket。

## 目录说明

```text
qqbot/
├── index.mjs          # 前端 cordis 插件（渠道类型、设置窗口、扫码、详情、消息链路）
├── bridge.mjs         # Node 后端插件（q.qq.com 绑定 / OpenAPI / 绑定路由 / 发送）
├── manifest.json
├── style.mjs
├── qrcode.mjs          # re-export 共享二维码模块
└── README.md
```

## 安装（完整版内置 / 外部插件目录）

内置：`plugins/channels/qqbot`，执行 `npm run sync-plugins` 后在添加渠道菜单出现。
外部：放到外部插件目录的 `channels/qqbot/`，后端 `bridge.mjs` 会被 `server/index.mjs` 自动扫描加载。

## 许可

原创部分与念风Chat 一致：Apache License 2.0。
`qrcode.mjs` 复用共享的 `src/vendor/qrcode`（QRCode for JavaScript，MIT License，Copyright (c) 2009 Kazuhiko Arase）。
