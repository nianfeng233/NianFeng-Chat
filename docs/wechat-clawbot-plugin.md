<!--
念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
项目全称：念风 Chat（NianFeng-Chat）
仓库：https://github.com/nianfeng233/NianFeng-Chat
-->
# 微信clawbot 渠道插件 · 更新说明

> 更新分支：`update/wechat-clawbot`（预览分支，确认稳定后再合并 `main`）
> 基线版本：念风Chat v0.41.0（原“风语”仓库重命名前）

## 1. 插件位置与分发

| 用途 | 路径 |
|---|---|
| 内置插件（前端） | `plugins/channels/wechat-clawbot/index.mjs` |
| 内置插件（后端桥） | `plugins/channels/wechat-clawbot/bridge.mjs` |
| 独立分发副本 | `extensions/wechat-clawbot/`（`npm run sync:clawbot-plugin` 同步） |
| 单独打包 | `npm run build:clawbot-plugin`，产物在 `release/plugins/wechat-clawbot/` 与同名 zip |

插件目录自带 `manifest.json` 与 `README.md`，压缩目录即可单独分发。

## 2. 新增功能

1. 「渠道 → 添加渠道」中新增 **微信clawbot** 类型；
2. 添加时弹出渠道设置窗口，可选择角色、渠道分类（私聊 / 群聊 / 隐私）与权限；
3. 渠道详情显示接入状态、角色、分类、权限、微信账号与聊天记录入口；
4. 点击「接入」按 Clawbot / iLink 流程获取二维码，本地渲染，手机微信扫码后上线；
5. 微信消息写入所选角色的 clawbot 渠道聊天记录，并触发念风完整模型链路；
6. 模型整轮调用（含工具调用与全部回复消息）彻底结束后，才关闭微信 typing 状态；
7. 「设置 → 聊天记录」可按角色查看 / 编辑该渠道记录；
8. 渠道会话标记为 `hiddenFromSessionList`，不再出现在普通会话列表，避免同一角色出现两个入口；
9. 渠道设置支持「用户显示名 / 用户唯一标识」（默认与网页端一致），解决微信侧消息与网页端历史被模型识别成两个用户的问题；
10. 插件页对应条目提供「设置」按钮，可打开插件自己的配置面板（微信clawbot 面板会列出所有 clawbot 渠道）；
11. 后端桥自动加载 + `httpApi` 路由扩展点，后续新增渠道插件不需要修改 `server/index.mjs` / `server/plugins/http.mjs`。

## 3. 对本体做的必要改动

| 文件 | 改动 |
|---|---|
| `plugins/domain/channel-registry/index.mjs` | 渠道类型注册增加 `create / detail / settingsSchema` 扩展点；移除微信占位 |
| `plugins/features/channel-base/index.mjs` | `defineChannel()` 透传上述扩展点 |
| `plugins/views/channel-list/index.mjs` | 添加渠道时优先调用类型自带的 `create()` |
| `plugins/views/channel-detail-host/index.mjs` | 渠道详情支持类型自带的 `detail()` 渲染器 |
| `plugins/features/chat-flow/index.mjs` | `message:send` 支持 `skipUserAppend`，供渠道先落库再触发模型 |
| `plugins/foundation/backend-client/index.mjs` | 订阅 `clawbot:message` / `clawbot:status` 后端事件 |
| `plugins/domain/plugin-manager/index.mjs` | 新增通用插件设置面板注册 / 打开扩展点（`registerSettings` / `openSettings`） |
| `plugins/views/settings-item-plugins/index.mjs` | 有设置面板的插件在插件页显示「设置」按钮 |
| `plugins/views/session-list/index.mjs` | 过滤 `hiddenFromSessionList` 的渠道会话，避免渠道消息在普通会话列表出现第二份 |
| `server/index.mjs` | 新增通用渠道后端桥加载器：自动扫描 `plugins/channels/**/bridge.mjs` 与外部插件目录 |
| `server/plugins/http.mjs` | 新增通用 `httpApi` 路由 / 能力扩展点；Clawbot 专用路由已移回自己的 `bridge.mjs` |
| `plugins/channels/wechat-clawbot/bridge.mjs` | 通过 `httpApi.route()` 自行注册 `/api/clawbot/*`，不再依赖本体路由 |
| `server/data-dir.mjs` / `start.mjs` / `server/index.mjs` | 兼容旧 `FENGYU_*` 环境变量与旧 AppData 指针 |

## 4. 项目重命名

- 中文名：**念风Chat**；英文名：**NianFeng-Chat**；仓库：`https://github.com/nianfeng233/NianFeng-Chat`
- 包名：`nianfeng-chat`；桌面端产物：`念风Chat.exe`
- 旧品牌 “风语 / Fengyu / fengyu / FENGYU_” 已统一替换；所有文本源文件补充了“念风chat”文件头标记
- 应用数据目录新增 `nianfeng` / `NianFengChat`，并保留旧目录一次性回退读取，避免升级丢数据

## 5. 头像统一修复

- 全项目唯一头像 / 品牌 logo 常量：`src/util/identity.mjs` 的 `BRAND_LOGO`
- 用户头像、消息头像、通知图标、顶栏品牌、网页 favicon 均引用该常量
- 修复 `cssUrl()` 使用双引号导致 `style="background-image:url("..."")"` 被截断、消息头像空白的问题；现在统一输出单引号 `url('...')`

## 5.1 扫码与连接状态修复

- `get_qrcode_status` 实际是约 30s 的长轮询接口；此前前端每次查询都同步请求，12s 超时后统一显示“接口未返回有效数据”。现在后台维护一条 45s 超时的扫码长轮询，前端 `/login/status` 立即返回后台最新状态；网络错误会显示真实原因并自动重试。
- token 使用 `.secret-key` AES-GCM 加密写入 `<数据目录>/clawbot.json`；后端重启后加载状态并自动重连，`test:clawbot` 增加了“重启后自动登录并恢复在线”断言。
- “已接入”状态现在等 `notifystart` 或首次 `getupdates` 成功后才亮，不再是拿到 token 就显示在线；网络/会话过期会更新为错误或已过期。

## 6. 验证与构建

```bash
npm run check:kernels     # 157 个模块语法 / 导入检查
npm test                  # 全量测试，包含 test:clawbot（本地 mock iLink）
npm run build:release     # 同时生成 Web 与桌面版；exe 内含 wechat-clawbot 内置插件
npm run build:clawbot-plugin
```

当前测试结果：`npm test` 全部通过；`test:clawbot` 18/18，`smoke` 212/212，
`test-backend` 63/63，其余测试均通过。
