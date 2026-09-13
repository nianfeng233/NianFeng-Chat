<!--
念风chat · 扩展插件 · group-chat-tools
项目全称：念风 Chat（NianFeng-Chat）
仓库：https://github.com/nianfeng233/NianFeng-Chat
-->
# 群聊工具（group-chat-tools）

给 AI 加一组 NapCat / OneBot 11 群聊工具：查人、@人、禁言、踢人、改头衔、发群公告、看群信息、审批入群申请。
参考 AstrBot 的 `xiaofeng_plugin_group_master`，但按念风的工具链路与权限模型重新实现。

- **类型**：外部扩展插件（本目录不随主体打包，需安装到数据目录的插件目录）
- **依赖**：内置 `napcat` 渠道插件（v1.0.0+）；建议同时装有 `chat-permissions`（跨群操作会走它的确认流程）
- **工具数量**：5 个（内部覆盖 30+ 个动作）

---

## 1. 功能清单

| 需求 | 实现 | 工具 / 动作 |
|---|---|---|
| AI 直接输出 CQ 码 | NapCat 后端桥解析出站正文里的 CQ 码 / `[at:qq]` 简写 | `chat_send` 正文直接写 `[CQ:at,qq=123]`、`[at:123]`（白名单类型） |
| 用工具 @ 人 | 按 QQ 号或名字（精确 / 唯一模糊）艾特一个或多个成员 | `napcat_group_send.action=at` |
| @全体成员 | 自动检查剩余次数后发送 `at all` | `napcat_group_send.action=at_all` |
| 群内按用户名精确 / 模糊匹配成员并返回 QQ 号 | 匹配群名片 / QQ昵称 / QQ号，返回 QQ 号、角色、头衔、群等级、QQ等级、入群时间等 | `napcat_group_member.action=search` |
| 按精确 QQ 号拉取资料，字段可选 / `all` 全拉 | `fields` 选择 `basic / signature / qq_level / vip / group_member / friend / honor / likes / status / space`，`all` 全拉 | `napcat_group_member.action=info` |
| 禁言 / 解禁 | 任意自定义时长：数字秒数、`90秒`、`1分钟`、`5分钟`、`1.5小时`、`1小时30分钟`、`三分钟`、`2天`；`0` / `unmute` 解禁；上限 30 天 | `napcat_group_manage.action=mute / unmute` |
| 全员禁言 | 开 / 关 | `napcat_group_manage.action=mute_all` |
| 踢人 | 可选 `reject_add` 拒绝再次加群 | `napcat_group_manage.action=kick` |
| 群头衔 | 设置 / 清除专属头衔（QQ 规则：仅群主） | `napcat_group_manage.action=set_title` |
| 群名片 | 设置 / 清除群名片 | `napcat_group_manage.action=set_card` |
| 管理员 | 设置 / 取消管理员（QQ 规则：仅群主） | `napcat_group_manage.action=set_admin` |
| 群公告 | 读取 / 发布 / 删除 / “编辑”（删旧发新）；支持 `pinned` 置顶、`confirm` 需成员确认、`popup` 弹窗、`show_edit_card` 提醒改名片、`type`；`params` 里其它键会原样透传给 NapCat，方便使用新版本参数 | `napcat_group_notice` |
| 其他群功能 | 撤回消息、群打卡、戳一戳、群资料、群荣誉、被禁言名单、@全体剩余次数、入群 / 邀请申请列表与审批、任意 OneBot action 透传（需开启） | `napcat_group_manage` / `napcat_group_info` |
| 一起听歌（近似） | 发送 QQ 音乐卡片（qq / 163 / kugou / kuwo / migu / custom） | `napcat_group_send.action=music` |

> QQ 空间：`fields=space` 返回 `https://user.qzone.qq.com/<QQ>` 空间主页链接。

---

## 2. 安装

### 方式 A：脚本安装（推荐）

在仓库根目录执行：

```powershell
powershell -ExecutionPolicy Bypass -File .\extensions\group-chat-tools\install.ps1
```

默认安装到 `<仓库根目录>\user_data\plugins\group-chat-tools\`。
数据目录不在默认位置时：

```powershell
# 指定数据目录（脚本会自动追加 \plugins）
.\extensions\group-chat-tools\install.ps1 -DataDir "D:\nianfeng-data"

# 或直接指定插件目录
.\extensions\group-chat-tools\install.ps1 -PluginsDir "D:\plugins"
```

### 方式 B：手动复制

把 `index.mjs`、`manifest.json`、`README.md` 复制到：

```text
<数据目录>/plugins/group-chat-tools/
```

然后在 设置 → 插件 里重新扫描 / 刷新页面；插件列表出现「群聊工具」即安装成功（默认启用）。

> 注意：外部插件目录要正好是插件根目录，不要再套一层同名文件夹，否则插件里的相对路径层级会变。

### 验证

```powershell
node extensions\group-chat-tools\test.mjs
```

70 项断言覆盖查询、发送、管理、公告、参数防覆盖、安全约束、跨群权限、自定义禁言时长、设置面板与总开关。

---

## 3. 使用方式（对 AI 说人话即可）

- “查一下群里叫小明的人” → `napcat_group_member(search)`
- “艾特小明说该交作业了” → `napcat_group_send(at)`
- “@全体成员 明天下午三点开会” → `napcat_group_send(at_all)`
- “把 123456 的资料全拉一遍” → `napcat_group_member(info, qq=123456, fields=all)`
- “禁言小明 10 分钟” / “给小明解除禁言” → `napcat_group_manage(mute/unmute)`
- “把捣乱的踢了，别再让他进群” → `napcat_group_manage(kick, reject_add=true)`
- “给小明上一个‘卷王’头衔” → `napcat_group_manage(set_title)`（机器人需为群主）
- “发个群公告：明天停服维护；置顶、弹窗提醒、不用确认” → `napcat_group_notice(send, params)`
- “看看群公告，把过期的第一条删了” → `napcat_group_notice(get → delete)`
- “谁还被禁言着？” → `napcat_group_info(muted)`
- “看看待处理的入群申请，第一个同意” → `napcat_group_info(requests → handle_request)`

也可以让 AI 直接在回复里写 CQ 码，例如：

```text
[CQ:at,qq=123456] 晚上好
[at:123456] 晚上好
[CQ:image,file=https://example.com/a.png]
```

---

## 4. 安全与权限

- **硬性保护**：任何管理动作都不会作用于机器人自己、群主与插件设置里的「保护名单」QQ 号；
- **权限预检**：能用成员列表判断机器人角色时，会提前拒绝权限不足的操作（如非管理员禁言、非群主改头衔），错误信息比 NapCat 原始报错更直白；
- **跨群操作**：默认只作用于当前群。要远程操作其它群，需要在念风的渠道权限里给角色开启「跨渠道发送 / 读取」；此时所有跨群动作都会走 `chat-permissions` 的敏感确认（来源渠道回复“确认”放行）；
- **CQ 白名单**：出站 CQ 只解析 `text / at / image / face / music / json / xml / reply`；`file`、`record`、`video`、`node` 等类型直接丢弃，图片只允许 `http(s)`、`base64://`、`data:image/`，避免模型让 NapCat 读取本机文件；
- **raw 透传**：默认关闭；开启后会拦截 `bot_exit`、`set_restart`、`clean_cache`、`set_qq_profile`、`set_qq_avatar`、`delete_friend`；
- **落库**：工具实际发出的消息会写入对应群会话的聊天记录（`via=group-chat-tools`，`direction=outbound`），不会触发二次外发；查询与操作会写运行日志，并广播 `group-chat-tools:action` 事件供其它扩展监听。

---

## 5. 插件设置

设置 → 插件 → 群聊工具 → 设置：

| 配置 | 默认 | 说明 |
|---|---|---|
| `napcat.groupMaster.enabled` | `true` | 总开关 |
| `napcat.groupMaster.allowManage` | `true` | 管理类操作开关（禁言 / 踢人 / 头衔 / 公告等） |
| `napcat.groupMaster.allowRawAction` | `false` | 任意 OneBot action 透传 |
| `napcat.groupMaster.memberCacheMs` | `60000` | 群成员列表缓存时间 |
| `napcat.groupMaster.maxResults` | `20` | 成员列表 / 搜索单次返回上限 |
| `napcat.groupMaster.protectedUsers` | 空 | 保护名单（逗号分隔 QQ 号） |

> 上下文提示：本插件的 5 个工具定义约 4300 字符，加上内置工具会明显增加 system prompt。默认 `chat.contextTokens = 4096` 时建议调到 `8192` 以上（设置 → 模型 / 通用），否则留给聊天历史的预算会很少。

---

## 6. 对其它扩展的接口

插件提供 `group-chat-tools` 服务：

```js
const gm = ctx.inject('group-chat-tools')
gm.toolNames()                     // 已注册的工具名
gm.members(target, { refresh })    // 拉群成员
gm.resolveGroup('群名或群号', context) // 解析目标群渠道
gm.action(instanceId, action, params) // 直接透传 OneBot action
gm.protectedUsers()
```

事件（可监听）：`group-chat-tools:action`，payload 形如 `{ action, at, groupId, qq, messageId, ... }`。

---

## 7. 已知限制与候选功能（拿不准 / 理论可加）

**当前明确不做或做不到的：**

1. **未建渠道的群直接管理**：本插件只操作念风里已配置的 NapCat 群聊渠道，避免绕过权限模型；如果确实需要“凭群号裸操作”，可加 `allowRawGroupIds` 开关，但会绕过跨渠道权限；
2. **群公告原地编辑**：QQ 协议没有编辑接口，`edit` 是“删旧 + 发新”，公告 ID 会变；
3. **消息历史/聊天记录的群管取值**：撤回、回复等依赖 `message_id`，模型只能对上下文中出现过的消息使用；更早消息需要 `read_messages` 或人工提供 ID。

**理论可加、等你说要不要做：**

| 方向 | 说明 | 依赖 |
|---|---|---|
| 入群欢迎 / 退群通知 | 监听 `napcat:notice`，按模板欢迎新人、通报退群 | 前端事件即可 |
| 入群自动审核 | 关键词白名单 / 黑名单、拒绝理由、最低等级，自动同意或拒绝 | 需处理 notice 事件 + 配置面板 |
| 宵禁 / 定时全员禁言 | 按时间表自动开关全员禁言，支持多时段 | 定时器 + 配置 |
| 违禁词 / 刷屏自动处理 | 静默写入时检测关键词或短时间高频消息，自动警告 / 禁言 / 撤回 | 需要消息监听与计数 |
| 群文件管理 | 上传 / 列出 / 删除群文件（`upload_group_file` 等已存在） | 后端文件路径或 URL |
| 群相册 | 列出 / 上传 / 点赞群相册（NapCat 有相册 action） | 图片与接口支持 |
| 精华消息 / 群待办 | 设置 / 移除精华，设置群待办 | 已存在 action，直接加即可 |
| 群名 / 群头像 / 群备注 | `set_group_name`、`set_group_portrait`、`set_group_remark` | 直传 action |
| 批量 / 广播 | 一句话对多个群或全部群发消息、发公告（参考插件的多群互联） | 需要目标群列表与逐群权限校验 |
| 定时消息 / 公告 | “今晚 8 点提醒大家打卡” | 定时器 + 持久化 |
| 自动撤回 | 机器人自己发的消息 N 秒后撤回（配合输入状态类扩展） | `delete_msg` + 定时器 |
| 主动欢迎语 / 龙王榜定期播报 | 定时或事件触发 | 定时器 |
| QQ 空间 | 空间资料 / 说说（风险与协议成本高） | 后端网络 + Cookie |
| 资源热度榜 / 表情回应 | `set_msg_emoji_like`、`fetch_emoji_like` | 已存在 action |

> 建议优先级：入群欢迎/退群通知 → 入群自动审核 → 定时宵禁 → 违禁词/刷屏 → 群文件/精华/待办这类单动作工具。
