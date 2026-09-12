<!--
念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
项目全称：念风 Chat（NianFeng-Chat）
仓库：https://github.com/nianfeng233/NianFeng-Chat
-->
# 微信clawbot 渠道插件 · 独立分发包

本目录由 `npm run sync:clawbot-plugin` 从内置插件目录同步生成：

- 同步源：`plugins/channels/wechat-clawbot/`
- 插件代码：`channels/wechat-clawbot/`
- 直接压缩本目录或 `channels/wechat-clawbot/` 即可分发。

## 安装为外部插件

把 `channels/wechat-clawbot/` 整个目录放到念风的外部插件目录下，例如：

```text
<数据目录>/plugins/channels/wechat-clawbot/index.mjs
```

然后打开「设置 → 插件」→ 重新扫描 → 刷新页面。

## 后端桥说明

前端插件依赖完整版内置的 Clawbot 后端桥
`plugins/channels/wechat-clawbot/bridge.mjs` 与 `/api/clawbot/*` 路由。
本分发包同时带上了 `bridge.mjs`；如果你在其它宿主上安装，需要把
`bridge.mjs` 作为后端插件加载（参考完整版 `server/index.mjs` 的接入方式）。

## 重新同步

修改内置插件后执行：

```bash
npm run sync:clawbot-plugin
```

切勿只编辑本目录中的副本，否则下一次同步会覆盖。
