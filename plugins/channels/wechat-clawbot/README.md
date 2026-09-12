<!--
念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
项目全称：念风 Chat（NianFeng-Chat）
仓库：https://github.com/nianfeng233/NianFeng-Chat
-->
# 微信clawbot 渠道插件（念风Chat）

念风Chat 的第一个渠道插件：通过腾讯 `openclaw-weixin` / iLink HTTP JSON 协议接入微信 Clawbot。

## 功能

- 在「渠道 → 添加渠道」中注册 **微信clawbot** 类型；
- 添加渠道时选择角色、渠道分类（私聊 / 群聊 / 隐私）与权限开关；
- 渠道详情中点击「接入」，展示微信登录二维码，手机扫码后自动上线；
- 微信入站消息写入所选角色对应的 clawbot 渠道聊天记录，并走念风完整模型链路；
- 模型整轮调用（含工具调用与全部回复消息）彻底结束后，才关闭微信侧 typing 状态；
- 聊天记录可在「设置 → 聊天记录」中按角色/渠道查看与修改。

## 目录说明

```text
wechat-clawbot/
├── index.mjs          # 前端 cordis 插件（渠道类型、设置窗口、详情、消息链路）
├── bridge.mjs         # Node 后端插件（登录 / 长轮询 / sendmessage / typing）
├── manifest.json      # 插件元信息（便于单独分发）
├── style.mjs          # 插件样式
├── qrcode.mjs         # 本地二维码渲染
└── vendor/qrcode/     # QRCode for JavaScript（MIT，Kazuhiko Arase）
```

## 安装（完整版内置）

本插件已随念风Chat 完整版内置在 `plugins/channels/wechat-clawbot`，
重新执行 `npm run sync-plugins` 后即可在添加渠道菜单中出现。

## 安装（外部插件目录）

将本目录放到任意外部插件目录下的 `channels/wechat-clawbot/`，例如：

```text
<插件目录>/channels/wechat-clawbot/index.mjs
```

然后在「设置 → 插件」中重新扫描并刷新。注意：前端插件依赖完整版内置的
`/api/clawbot/*` 后端桥；如果宿主版本没有该后端桥，需要同时接入同目录的
`bridge.mjs`（在 `server/index.mjs` 中作为后端插件加载）。

## 单独分发

独立分发脚本已移除（`extensions/wechat-clawbot` 是早期测试目录，已不再随仓库维护）。
如需单独分发，请手动把本目录（含 `index.mjs` / `bridge.mjs` / `style.mjs` / `vendor/`）复制到外部插件目录，
并确保宿主包含所需的 `/api/clawbot/*` 后端桥与 `image-service/store.mjs`。

## 协议参考

登录二维码、扫码状态、消息长轮询与发送接口参考
[Tencent/openclaw-weixin](https://github.com/Tencent/openclaw-weixin)；
第三方 QRCode 库许可见 `THIRD-PARTY-NOTICES.md`。

## 许可

本插件原创部分与念风Chat 一致：Apache License 2.0。
`vendor/qrcode` 来自 QRCode for JavaScript（MIT License，Copyright (c) 2009 Kazuhiko Arase）。