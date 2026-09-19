<!--
念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
项目全称：念风 Chat（NianFeng-Chat）
仓库：https://github.com/nianfeng233/NianFeng-Chat
-->
# 图片出入站与上下文保险 · 设计说明

> 覆盖：WebUI、微信 Clawbot、QQ 官方机器人（私聊 C2C + 群聊 `GROUP_AT_MESSAGE_CREATE` / `GROUP_MESSAGE_CREATE`）。
> 目标：用户图片模型能看到、助手能发图，同时避免图片把上下文 / 聊天记录撑爆。

## 1. 存储：消息只存 imageId

图片原文件由 `image-service` 管理：

```text
<数据目录>/images/<id>.<ext>     原文件
<数据目录>/images.json           索引 {id,file,mime,size,name,width,height,createdAt}
```

- 后端：`plugins/domain/image-service/bridge.mjs` + `store.mjs`
  - `POST /api/images` 保存 data URL / base64
  - `GET /api/images/:id` 返回图片字节（immutable）
  - `POST /api/images/prune` 按数量裁剪
- 前端：`plugins/domain/image-service/index.mjs`
  - `saveFile(file)`（canvas 压缩）、`saveDataUrl()`、`urlOf()`、`dataUrlOf()`
  - 内存缓存 imageId → data URL（20MB / 48 条 LRU，仅用于模型上下文与本地预览）
  - `hydrateImages / hydrateConversation / needsHydration`
- 消息里的 `meta.images` 只存元信息：

```json
{ "id": "img_xxx", "mime": "image/jpeg", "name": "a.png", "width": 1280, "height": 720, "size": 321000 }
```

兼容旧数据：`dataUrl`（后端不可用时的降级）与外部 `url` 仍然支持。

## 2. WebUI 输入 / 输出

- composer：图片按钮 / 粘贴 / 拖拽；canvas 压缩（最长边 1280、目标 ≤720KB、单条最多 4 张）；
- 压缩后调用 `image-service.saveDataUrl`，消息只写 imageId；
- `bubble-default` 通过 `image-service.urlOf` 渲染 `/api/images/<id>`；
- `chat_send` 工具新增 `images`：data URL 会先存 image-service，外链保留 URL。

## 3. 模型上下文策略（核心）

### 3.1 自动上下文：最近图片原样保留

`context-builder` 对带图片的用户消息返回多模态 content：

```text
[
  { type: "text", text: "{meta..., text, image_count}" },
  { type: "image_url", image_url: { url: "data:..." } }
]
```

- 图片 URL 优先从 `image-service.dataUrlOf` 取缓存；没有缓存则回退 `dataUrl / 外链 URL`；
- 单条消息最多 `chat.imagesPerMessage`（默认 2），整轮请求最多 `chat.imagesPerRequest`（默认 2）；
- 从最新消息往旧消息分配名额，超出部分替换为 `[图片]`；
- token 估算对图片用固定 `chat.imageTokens`（默认 800），绝不按 base64 长度算；
- `chat-store.sanitizeProtocolMessage` 遇到图片 part 只存 `[图片]`。

### 3.2 工具查历史：默认 [图片] 占位，按需查看

- `read_messages` 默认返回 `[图片×N]` + `has_images / image_count / images[]` 元信息；
- 需要看图：`include_images=true` 或 `image_message_ids: [message_id]`，`image_limit` 默认 2、最大 4；
- 命中的图片通过 `output.images` 返回；`chat-flow` 把它们从 role=tool 的 JSON 中剥离，
  作为一条额外的 user 多模态消息注入下一轮；
- system 工具规则明确：“除非确实需要，不要查看原图”。

### 3.3 出站图片

- Web：气泡直接展示；
- 渠道：助手消息写入 `meta.images` 后，整轮 `chat:request-done` 结束，渠道插件按协议发送。

## 4. 模型适配（`server/plugins/models.mjs`）

| 提供商 | 转换 |
|---|---|
| OpenAI 兼容（含 DeepSeek） | `image_url` 透传（data URL / https URL） |
| Anthropic Claude | `{ type:"image", source:{ type:"base64", media_type, data } }`；外链降级为文本提示 |
| Gemini | `{ inlineData: { mimeType, data } }` |
| Ollama | 文本进 `content`，base64 进独立的 `images[]` |
| 其他 / 旧路径 | `stringifyContent()` 统一降级 `[图片]` |

## 5. 渠道适配

### 5.1 QQ 官方机器人（私聊 / 群聊）

- 入站：`C2C_MESSAGE_CREATE` / `GROUP_AT_MESSAGE_CREATE` / `GROUP_MESSAGE_CREATE` 的 `attachments[]`（HTTPS URL）由 bridge 下载（≤3MB/张、≤4 张、总量≤6MB）→ 存 image-service → `meta.images` 只留 id；
- 出站私聊：`POST /v2/users/{openid}/files`（`file_type:1, srv_send_msg:false`）→ `file_info` → `POST /v2/users/{openid}/messages`（`msg_type:7 + media + msg_id/msg_seq`）；
- 出站群聊：`POST /v2/groups/{group_openid}/files`（`file_type:1, srv_send_msg:false`）→ `file_info` → `POST /v2/groups/{group_openid}/messages`（`msg_type:7 + media + msg_id/msg_seq`）。

### 5.2 微信 Clawbot

参考 `D:\D\model\2\clawbot-manager`：

- 入站：item type 2 → 下载 → AES-128-ECB 解密 → 存 image-service（单张 ≤2MB、单条总量 ≤3MB）；
- 出站：`/ilink/bot/getuploadurl` → AES-128-ECB PKCS7 → POST CDN 取 `x-encrypted-param` → `/ilink/bot/sendmessage` image_item；接口 `POST /api/clawbot/send-media`，支持传 `image.id`。

### 5.3 WebUI

气泡通过 image-service 渲染。

## 6. 已知限制

| 项 | 说明 |
|---|---|
| 渠道入站图片 | 只限大小，不重编码；如原图很大，后续可在桥里做尺寸压缩 |
| 图片缓存 | 内存 LRU 20MB，切换会话后会按需重新拉取 |
| 模型支持 | 需要模型本身支持视觉；不支持视觉的模型会收到 `[图片]` 占位文本 |
| exe 关闭 | Rust 改动本机未能编译验证，打包时跑 `npm run build:desktop` |
