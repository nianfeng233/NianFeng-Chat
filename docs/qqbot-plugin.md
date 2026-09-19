<!--
念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
项目全称：念风 Chat（NianFeng-Chat）
仓库：https://github.com/nianfeng233/NianFeng-Chat
-->
# QQ 官方机器人渠道插件 · 设计与实现说明

> 状态：可运行。扫码走 QQ 官方 `q.qq.com/lite` 协议（QQ Connector 1.2.0 / AstrBot 最新版同款），
> 摘要信息包含 `user_openid`；正式环境被 IP 白名单拒绝时扫码账号自动降级沙箱，本地无需公网。
> 当前范围：**私聊（C2C）+ 群聊（`GROUP_AT_MESSAGE_CREATE` / `GROUP_MESSAGE_CREATE`）**；图片入站转存 image-service、
> 出站私聊走 `/v2/users/{openid}/files`、群聊走 `/v2/groups/{group_openid}/files`。

## 1. 范围与文件

| 用途 | 路径 |
|---|---|
| 前端插件 | `plugins/channels/qqbot/index.mjs` |
| 后端桥 | `plugins/channels/qqbot/bridge.mjs` |
| 图片服务（通用） | `plugins/domain/image-service/` |
| 测试 | `scripts/test-qqbot.mjs`（66 项）、`scripts/test-images.mjs`（8 项） |

**会话范围**：
- 私聊 `C2C_MESSAGE_CREATE`：绑定 `user_openid`，身份按主人 / 独立用户处理；
- 群聊 `GROUP_AT_MESSAGE_CREATE`：QQ 群默认只在群内 @机器人 时推送；群管理员打开「机器人可获取群内全部消息」后，未 @ 消息也会通过 `GROUP_MESSAGE_CREATE` 推送；绑定 `group_openid`，
  群成员以 `author.member_openid` 作为群内专属 id，`sender_name` / `senderNickname` 使用群昵称（best-effort）；
- 群聊上下文与 NapCat 对齐：`channel-only`、按条数（默认 20，可配置）、@ 直接回复、未 @ 消息按概率触发、白名单 / 黑名单 / 静默写入；
- 频道 / 频道私信仍不进入渠道，只在「发现会话」标注暂不支持。

## 2. 扫码接入（QQ Connector 1.2.0 / AstrBot 最新版同款）

来源：QQ 官方 `@tencent-connect/qqbot-connector` 1.2.0 与 AstrBot 最新
`astrbot/core/platform/sources/qqofficial/login_registration.py`。

```text
1) POST https://q.qq.com/lite/create_bind_task
   body: { "key": "<base64 32字节 AES-256 key>" }
   resp: { "retcode": 0, "data": { "task_id": "..." } }

2) 二维码内容：
   https://q.qq.com/qqbot/openclaw/connect.html?task_id=<task_id>&_wv=2&source=nianfeng

3) 手机 QQ 扫码确认后轮询：
   POST https://q.qq.com/lite/poll_bind_result
   body: { "task_id": "..." }
   data.status: 0 未开始 / 1 待确认 / 2 已完成 / 3 已过期

4) status=2 时：
   bot_appid            -> AppID
   bot_encrypt_secret   -> base64(nonce[12] + ciphertext + tag[16])
   用第 1 步的 key 做 AES-256-GCM 解密 -> AppSecret
   user_openid          -> 扫码用户 openid（可选，用于自动绑定默认会话 / 信任列表）
```

拿到 AppID / AppSecret 后复用 OpenAPI：`api.bot.qq.com/app/getAppAccessToken`（不可达时回退 `bots.qq.com`）→ `api.bot.qq.com` / `api.sgroup.qq.com` WebSocket 或 Webhook。
绑定服务域名默认 `q.qq.com`，可用 `NIANFENG_QQBOT_BIND_HOST` 或渠道高级设置覆盖（便于测试 / 镜像）。

> **IP 白名单与自动沙箱**：正式 OpenAPI 要求把调用方公网 IP 加入 QQ 开放平台白名单；
> 扫码账号被 `code=11298 / err_code=40023002` 拒绝时，bridge 会把该账号标记为沙箱并改用
> `sandbox.api.sgroup.qq.com` 重试（实测免白名单），同时通过 WebSocket 出站连接，因此本地
> 部署不需要公网。手动填写凭据的账号保持显式选择，不会静默切换；渠道详情会显示当前接入环境。

### 2.1 登录 / 渠道生命周期

- **保存渠道 ≠ 立即扫码**：保存只做持久化与提示，二维码只在用户点击详情「接入」后生成（与微信 clawbot 流程对齐）；
- **已有凭据默认复用**：再次点「接入」时 `login/start` 不再创建绑定任务，而是直接重连，
  避免重复扫码导致手机 QQ 提示“机器人已绑定”；
- **断开是停用而非删除**：渠道详情「断开连接」只把渠道标记为 disabled 并关闭连接，本机 AppID/AppSecret 保留；
- **删除渠道不丢凭据**：从渠道列表删除时只移除本机渠道配置，机器人账号仍保留，
  新渠道可在「接入」弹窗里从“已登录机器人”列表直接复用；
- **重启续扫**：二维码任务写入 `qqbot.json`，后端重启后会恢复未完成任务继续轮询，不需要重新扫码；
- **重新扫码换机器人**：接入弹窗提供「重新扫码绑定」，二次确认弹窗层级已提到接入弹窗之上；
  用户若关闭接入弹窗，本次重扫会被取消，不会在后台偷偷创建二维码任务；
  旧账号会被摘出本渠道；若新扫码返回同一 AppID 会自动合并状态；
- **扫码即绑定**：`poll_bind_result` 返回的 `user_openid` 在自动绑定模式下会直接写入本渠道
  默认会话（`identityMode=owner`、`auto=true`）；手动绑定模式只把它加入渠道信任列表；
- **未绑定私聊提示**：手动绑定 / 多候选 / 未匹配到绑定关系时，bridge 会自动回一条被动消息，
  提示用户到 WebUI 的「发现会话」复制 openid 并点「绑定到本渠道」；同一个 openid 10 分钟内只提醒一次，
  不会反复打扰；
- **删除渠道清理记录**：渠道被真正移除后，插件会删除对应的隐藏聊天记录容器，并在启动 / 渠道同步后
  清理已经没有对应渠道的孤立会话，避免「渠道删了但聊天记录页还留着 qqbot 空渠道」。

## 3. 会话判定与身份

- 私聊事件：`C2C_MESSAGE_CREATE`；`author.user_openid` / `author.id` 是用户；新版事件可能带 `author.username`，直接作为昵称使用；
- 群聊事件：`GROUP_AT_MESSAGE_CREATE`（@机器人）与 `GROUP_MESSAGE_CREATE`（群开启「机器人可获取群内全部消息」后的普通消息）；`group_openid` 是群，`author.member_openid` 是该成员在群内的专属 id；
- 群昵称：优先使用事件里的 `nickname / nick`，没有时 bridge 会 best-effort 请求群成员信息只读端点并缓存；失败时用「QQ成员·尾号」兜底；
- 官方给的是 **openid，不是 QQ 号 / 群号**；openid 对每个机器人不同，无法反查；
- 渠道绑定：
  - 私聊 `{ sessionType:'c2c', peerId:user_openid, alias, identityMode }`：
    - 自动绑定：第一次收到谁的消息就绑定谁；其它 openid 进「发现会话」；
    - 手动绑定：编辑窗口直接填 openid；
  - 群聊 `{ sessionType:'group', peerId:group_openid, alias }`：
    - 自动绑定：第一次收到哪个群的 @消息 就绑定哪个群；
    - 也可以从「发现会话」手动绑定群 openid；
  - 同一会话只绑定到一个渠道；一个 AppID 可以创建多个渠道（多个私聊 / 群会话）。
- 身份映射：
  - 私聊 `identityMode=owner`（默认）：该 openid 视为网页端主人，工作记忆与确认权限都按主人处理；
  - 私聊 `identityMode=guest`：`sender_id = qq:<openid>`，与主人区分；
  - 群聊：`sender_id = qq:group:<member_openid>`，`sender_name = 群昵称`；同一渠道内用 member_openid 区分每个群成员。

## 4. 如何知道自己的 openid 并授权

### 私聊

1. 扫码确认后，自动绑定模式会直接把扫码用户 `user_openid` 绑为本渠道默认会话；
2. 如果是手动绑定模式，或收到了其它 openid 的消息，打开「渠道 → QQ 渠道详情 → 发现会话」，
   会列出对应 openid，点「复制 openid」可取；
3. 点「绑定到本渠道」；自动绑定模式下第一条消息已经绑定；
4. 绑定项默认「视为主人」——跨渠道敏感操作默认由主人确认放行；
5. 如果你把它设成「独立用户」，点「信任该 openid」，或在编辑窗口的
   「允许确认的用户 openid」里填你的 openid。

### 群聊

1. 创建渠道时把「渠道分类」选为 **群聊**，保存后到详情页「接入」；
2. 把机器人拉进群，在群里 **@机器人** 发一条消息；
3. 自动绑定模式会绑定该群的 `group_openid`；手动绑定模式可在「发现会话」里点「绑定到本渠道」；
4. 群成员以 `member_openid` 作为群内专属身份；群昵称由成员信息接口回填，显示为群内称呼；
5. 如果群管理员在 QQ 群设置里打开 **「机器人可获取群内全部消息」**，未 @ 的普通消息也会进入本渠道并按群规则决定是否回复；否则聊天记录里只会出现 @机器人 的消息。

确认规则：`chat-permissions.resolvePending(convId, text, { senderId, allowedUserIds })`
只允许授权发送者消费确认；群聊里需要把成员 openid 填进信任列表，或使用「信任该成员 openid」按钮。
私聊里其他用户就是普通消息，不会放行也不会消耗 pending。

## 5. 消息与图片链路

```text
QQ C2C / GROUP_AT / GROUP_MESSAGE 事件
  ├─ 文本：message.text
  └─ 图片：d.attachments[] HTTPS URL
        → bridge 下载（≤3MB/张、≤4 张、总量≤6MB）
        → image-service 落盘（<数据目录>/images/<id>.<ext>）
        → 消息 meta.images 只存 { id, mime, width, height, size }
  → chat-store.append(qqbot:<channelId>) → chat-flow → 工具循环
  → chat:request-done（整轮彻底结束）
  → 私聊文本：POST /v2/users/{openid}/messages（msg_id + msg_seq）
  → 私聊图片：POST /v2/users/{openid}/files（file_type=1, srv_send_msg=false）
           → POST /v2/users/{openid}/messages（msg_type=7 + media.file_info）
  → 群聊文本：POST /v2/groups/{group_openid}/messages（msg_id + msg_seq）
  → 群聊图片：POST /v2/groups/{group_openid}/files（file_type=1, srv_send_msg=false）
           → POST /v2/groups/{group_openid}/messages（msg_type=7 + media.file_info）
```

模型上下文里，imageId 由 image-service 的缓存转成 data URL；工具查历史默认 `[图片]` 占位，
按需 `include_images` / `image_message_ids` 才注入原图。详见 `docs/image-pipeline.md`。

## 6. 被动回复

- 不预先按 TTL 拒绝：总是先带 `msg_id + msg_seq` 尝试被动回复；
- 同一条消息最多 5 次；超限时若开启「允许主动消息」则改发主动消息，否则提示失败；
- 主动消息默认关闭（QQ 官方每月仅 4 条）；
- 群聊被动回复走 `/v2/groups/{group_openid}/messages`，官方窗口约 5 分钟；窗口失效时同样自动改发主动消息，是否能发出取决于官方配额。

### 6.1 SILK 语音（1.5.0）

QQ 官方语音不是普通文件上传，要求：

- 上传接口：`/v2/groups/{group_openid}/files` 或 `/v2/users/{openid}/files`；
- `file_type = 3`（语音 silk）、`srv_send_msg = false`；
- 拿到 `file_info` 后用 `msg_type = 7` + `media.file_info` 发送，并带 `msg_id + msg_seq` 走被动回复。

bridge 的 `/api/qqbot/send` 现在接受：

```jsonc
{
  "channelId": "<本机渠道 id>",
  "sessionType": "group",
  "peerId": "<group_openid>",
  "msgId": "<可选的被动消息 id>",
  "text": "可选的前置文本",
  "voice": { "dataUrl": "data:audio/silk;base64,..." }
}
```

- 非 SILK 会返回 `VOICE_FORMAT_INVALID`，不会静默失败；
- 同时提供 `qqbot` 后端服务：`send(body)` / `channelInfo(channelId)` / `supportsVoice()` / `voiceFormat()`；
- 点歌台 `media-post` 的 `mode=voice` 会自动判断目标渠道：NapCat 走 record（mp3→amr 兜底），QQ 官方机器人则用 ffmpeg 转 24k 单声道 PCM → 内置 `silk-wasm` 编码 → 调用 `qqbot.send`，插件设置面板也会显示「QQ 官方语音可用（SILK）」状态。

## 7. 渠道分类与隐私语义

| 渠道分类 | 本插件行为 |
|---|---|
| 私聊（private） | 正常聊天；参与角色级工作记忆；跨渠道能力按权限开关 |
| 群聊（group） | @机器人 默认 100% 触发，可关闭「被 @ 时必定回复」改为参与概率 / 白名单；群开启「机器人可获取群内全部消息」后，未 @ 消息按概率 / 白名单 / 黑名单触发；引用触发消息与艾特触发者两个开关默认关闭；使用本群最近若干条消息作为上下文（`channel-only`），不参与角色工作记忆；未触发的消息静默写入 |
| 群聊 + 多机器人联动 | 两个渠道填相同的「跨机器人联动标识」后，bridge 把群内出站消息镜像到对方渠道；对方消息按 `linkAutoReply` 与 `linkMaxTurns` 决定自动接话或只写入上下文；适合双角色 bot 同群互动 |
| 隐私（privacy） | **正常聊天与自动回复**；不参与角色级工作记忆，且不能与任何其它渠道互读 / 互发（`chat-permissions` 直接拒绝） |

### 7.1 多机器人联动（1.4.0）

QQ 官方默认只把群内 @机器人 的消息推送给被 @ 的那个 bot（群开启全量消息后能看到更多，但两个官方 bot 之间仍不会互推），两个官方 bot 同群时默认互相看不到对方
的模型上下文。渠道增加了一个本机联动层：

- 两个群聊渠道在编辑窗口里填 **相同的 `linkGroupId`**（跨机器人联动标识）；
- bridge 每次成功发出群消息后，把这条消息（文本 / 图片 id）镜像写入同 `linkGroupId`
  的其它机器人渠道的本地 inbox，并通过 SSE 广播；
- 镜像消息 `message.linkedBot = true`，`sender_name` 使用来源渠道名，前端 `senderIdentityFor`
  会用 `qq:linked-bot:<accountId>` 标记；
- 前端 `applyLinkDecision`：人类用户发言会重置联动轮数；对方 bot 发言默认只写入群上下文，
  开启 `linkAutoReply` 后按 `linkMaxTurns` 自动接话，轮数用尽即停止，避免两个 bot 无限互刷；
- 该联动只在本机同一念风实例内生效，不调用 QQ 接口，不额外消耗被动回复额度；自动接话仍然
  调用本地模型，请在「群聊规则」里按需控制轮数（推荐 1）。

双角色群聊的角色卡与配置步骤见 `docs/characters/README.md`。

## 8. 对本体 / 测试的改动

QQ 渠道本身仍全部走已有扩展点；为图片、确认权限与隐私隔离，动了通用链路：

| 文件 | 改动 | 原因 |
|---|---|---|
| `plugins/features/context-builder` | 图片多模态 + 图片预算 + 工具占位 + 隐私渠道跳过工作记忆 | 自动上下文带图、历史占位，避免 base64 撑爆；隐私隔离 |
| `plugins/features/chat-flow` | `message:send` 支持 images；工具图片剥离后作为 user 多模态注入；按需 hydrate imageId | 工具结果是文本协议，图片不能塞进 role=tool |
| `plugins/features/chat-tools` | `read_messages` 增加 include_images / image_message_ids / image_limit；`chat_send` 增加 images | 模型按需看图与发图 |
| `plugins/domain/message-service` | `send / requestSend` 透传 images | Web 输入携带图片 |
| `plugins/domain/chat-permissions` | 确认支持 senderId / allowedUserIds；隐私渠道跨渠道一律拒绝 | 防止无权限用户确认；隐私隔离 |
| `plugins/domain/chat-store` | 协议轨迹遇到图片只存 `[图片]` | 防止 base64 写进 transcript |
| `plugins/domain/image-service`（新） | 图片文件存储、压缩、按需转 data URL、`/api/images` | 消息只存 imageId，避免 sessions.json 膨胀 |
| `plugins/foundation/config` | `chat.imagesPerRequest / imagesPerMessage / imageTokens` | 图片预算可配 |
| `plugins/views/composer` + `bubble-default` | 图片上传 / 粘贴 / 拖拽、压缩预览、气泡渲染 | Web 图片出入站 |
| `server/index.mjs` | 后端桥扫描根从 `plugins/channels` 扩到 `plugins` | 让 `plugins/domain/image-service/bridge.mjs` 这类通用后端服务也能自动加载 |
| `server/plugins/models.mjs` | OpenAI / Claude / Gemini / Ollama 图片格式转换 | 上游模型协议要求 |
| `scripts/desktop-wrapper/src/main.rs` | 关闭按钮快速隐藏 + 异步 taskkill + CREATE_NO_WINDOW | 旧实现同步等待 taskkill，卡顿且闪黑窗 |
| `plugins/foundation/modal-host` | 遮罩 `z-index` 从 300 提到 1300 | 渠道自己的 `.wc-mask` 为 1200，二次确认弹窗原先会被压在接入弹窗下层 |
| `plugins/channels/qqbot/index.mjs` | 「重新扫码绑定」增加关闭取消保护、扫码环境展示、`user_openid` 绑定状态同步 | 关闭接入弹窗后不再继续创建二维码任务，避免重开重扫的死循环 |
| `plugins/channels/qqbot/bridge.mjs` | 扫码账号正式环境被 IP 白名单拒绝时自动降级沙箱；解析并自动绑定 `user_openid`；未绑定私聊自动回复绑定提示 | 本地部署免白名单、免公网，扫完码即可私聊，未绑定时用户也能收到引导 |
| `plugins/channels/qqbot/bridge.mjs` + `index.mjs` | 群聊适配：`group_openid` 绑定、`member_openid` 群成员身份、群昵称回填、群规则、群图片 / 被动回复 | 群聊处理口径与 NapCat 渠道对齐 |
| `plugins/channels/qqbot/bridge.mjs` + `index.mjs` | 多机器人联动：`linkGroupId` 配对、出站消息本地镜像、`linkedBot` 标记、自动接话轮数上限 | 两个官方 bot 同群时互见消息并产生可控联动 |
| `plugins/channels/qqbot/bridge.mjs` + `extensions/media-post` | SILK 语音：`file_type=3` 上传 + `msg_type=7` 发送；`qqbot` 服务供外部插件调用；点歌台 ffmpeg → PCM → silk-wasm → QQ 语音 | QQ 官方 bot 支持点歌 / 发语音条 |
| `plugins/kernel/service-container` | `select` / `register` / `unregister` 只在配置值真的变化时写 config | 修复可选中服务重复写 `selectable.*` 触发 `settings/updated` 回环 |
| `plugins/domain/model-registry` | `replaceModels` 先做差异比较，未变化不再重注册全部可选中模型 | 修复模型设置页被反复刷新、输入框无法停留的问题 |
| `plugins/features/model-adapter-backend` | 同步时避免重复 `select`，模型无变化时不再广播 `models:synced` | 与上两条共同阻断模型页自刷新循环 |

测试 / 文档：`scripts/smoke.mjs`（渠道类型不唯一）、`package.json`（test:qqbot / test:images）、
`scripts/test-qqbot.mjs`、`scripts/test-images.mjs`、`plugins/registry.mjs`、`docs/*`。

## 9. 验证

```bash
npm run check:kernels     # 206 个模块语法 / 导入检查
npm run test:backend      # 63/63
npm run test:images       # 8/8（保存 / 读取 / 索引无 base64 / 裁剪）
npm run test:clawbot      # 26/26
npm run test:qqbot        # 59/59（原生扫码 / user_openid 自动绑定 / 未绑定提示 / 沙箱降级 / 私聊与群聊绑定 / 群成员身份与群昵称 / 多机器人联动镜像 / SILK 语音 / msg_seq / 图片上传）
npm run test:smoke        # 332/332
npm run test:chat         # 13/13
npm run test:chat-tools   # 113/113
npm run test:vendors      # 30/30（多模态转换不破坏原协议）
```

## 10. 仍可继续完善

| 项 | 说明 |
|---|---|
| 真实扫码联调 | 协议按 QQ Connector 1.2.0 / AstrBot 最新实现，已在本机对真实账号验证沙箱网关可 READY；建议你用真手机 QQ 再走一遍扫码，异常时看渠道详情的 lastError / 后端日志 |
| 群昵称 | 官方 v2 SDK 未承诺群成员资料接口；bridge 已按 `nick / nickname / member_name` 等字段 best-effort 请求群成员信息并缓存，失败时回退「QQ成员·尾号」 |
| 图片压缩 | Web 端上传会压缩；渠道入站图片只限大小（≤3MB/张），不重编码 |
| exe 关闭 | `npm run build:desktop` 已在本机编译通过（cargo release + 离线缓存）；输出 `release/desktop/deploy/念风Chat.exe` |
