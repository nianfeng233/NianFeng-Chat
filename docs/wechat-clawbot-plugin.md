<!--
念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
项目全称：念风 Chat（NianFeng-Chat）
仓库：https://github.com/nianfeng233/NianFeng-Chat
-->
# 微信clawbot 渠道插件 · 更新说明

> 更新分支：`update/wechat-clawbot`（预览分支，确认稳定后再合并 `main`）
> 基线版本：念风Chat v0.42.0

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
| `server/data-dir.mjs` / `start.mjs` / `server/index.mjs` | 兼容旧版本环境变量与旧 AppData 指针 |

## 4. 项目重命名

- 中文名：**念风Chat**；英文名：**NianFeng-Chat**；仓库：`https://github.com/nianfeng233/NianFeng-Chat`
- 包名：`nianfeng-chat`；桌面端产物：`念风Chat.exe`
- 旧品牌环境变量与旧安装目录指针已统一替换为念风相关名称；所有文本源文件补充了“念风chat”文件头标记
- 应用数据目录新增 `nianfeng` / `NianFengChat`，并保留旧目录一次性回退读取，避免升级丢数据

## 5. 头像统一修复

- 全项目唯一头像 / 品牌 logo 常量：`src/util/identity.mjs` 的 `BRAND_LOGO`
- 用户头像、消息头像、通知图标、顶栏品牌、网页 favicon 均引用该常量
- 修复 `cssUrl()` 使用双引号导致 `style="background-image:url("..."")"` 被截断、消息头像空白的问题；现在统一输出单引号 `url('...')`

## 5.1 扫码与连接状态修复

- `get_qrcode_status` 实际是约 30s 的长轮询接口；此前前端每次查询都同步请求，12s 超时后统一显示“接口未返回有效数据”。现在后台维护一条 45s 超时的扫码长轮询，前端 `/login/status` 立即返回后台最新状态；网络错误会显示真实原因并自动重试。
- token 使用 `.secret-key` AES-GCM 加密写入 `<数据目录>/clawbot.json`；后端重启后加载状态并自动重连，`test:clawbot` 增加了“重启后自动登录并恢复在线”断言。
- “已接入”状态现在等 `notifystart` 或首次 `getupdates` 成功后才亮，不再是拿到 token 就显示在线；网络/会话过期会更新为错误或已过期。

## 5.2 重新连接 / 多账号 / 权限与持久化修复

- **每次扫码都是新连接**：`get_bot_qrcode` 不再把本机保存的 token 作为 `local_token_list` 传给微信，每次获取二维码都会生成新的 `loginId`、新 ticket，各自对应独立连接；删除渠道重新添加、同一微信号重新扫码时会由微信正常提示解除旧连接，不再静默复用。
- **多微信号可同时在线**：后端桥按渠道 ID 隔离 token、同步游标与消息长轮询；每个渠道有独立的 epoch，重新获取二维码会使旧的扫码 / 消息长轮询立即失效。
- **移除渠道会注销连接**：删除渠道（含删除分组）会触发 `channel:removed`，插件调用 `/api/clawbot/logout` 清理后端凭据与长轮询；编辑渠道切换分类时同 id 的 remove + add 不会被误判为删除。
- **状态显示以真实链路为准**：`/login/status` 返回 `online / connecting / error` 等真实状态，前端会继续轮询到消息链路真正 online，不再在登录弹窗里手动把状态改回“连接中”；渠道详情挂载时也会主动同步一次后端状态。
- **渠道设置中的跨渠道权限直接生效**：渠道设置里的“跨渠道读取 / 跨渠道发送”会随会话 meta 持久化，`chat-permissions` 直接读取来源侧策略，无需再手工维护 grants；`sensitiveConfirm` 跟随渠道权限设置决定是否二次确认，`read_messages` / `chat_send` 不再把所有拒绝都吞成“目标渠道不可用”。微信侧也会收到确认提示，直接回复“确认”即可放行。
- **渠道记录不再误弹通知**：`hiddenFromSessionList` / `channelConversation` 的渠道会话不再触发角色消息系统通知。
- **输入框高度等界面偏好**：`chat.composerHeight` 在后端偏好同步到账后补应用；`config` 远端偏好合并支持运行时动态键，避免重启 / 换 origin 后界面状态回落。
- **桌面退出更彻底**：Windows 桌面壳关闭窗口 / 重启时用 `taskkill /T` 结束 Node 进程树，避免后台残留进程占端口或打断落盘。
- **会话落盘冲突合并**：前端会话服务启动时按 `updatedAt` + 消息数合并本地与后端，并记录删除墓碑；关闭 exe 时没来得及写回的最后修改不会被后端旧数据覆盖。
- **渠道列表跨 web/exe 共享**：渠道分组、渠道实例与设置除写入浏览器 localStorage 外，还会通过 `config` 的 `preferences.app.channels` 同步到共享数据目录的 `config.json`；按 `updatedAt` 取新并自动发布本机已有渠道。exe 里创建的渠道切到 web 版（同一数据目录）后可以直接看到，新增 / 删除 / 状态变化也会双向同步。

## 6. 验证与构建

```bash
npm run check:kernels     # 157 个模块语法 / 导入检查
npm test                  # 全量测试，包含 test:clawbot（本地 mock iLink）
npm run build:release     # 同时生成 Web 与桌面版；exe 内含 wechat-clawbot 内置插件
npm run build:clawbot-plugin
```

当前测试结果：`npm test` 全部通过；`test:clawbot` 26/26（含重新扫码新连接、双渠道并行与重启恢复），
`smoke` 212/212，`test-backend` 63/63，`test:chat-tools` 104/104，其余测试均通过。
