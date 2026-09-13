<!--
念风chat · 本地优先、件件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
项目全称：念风 Chat（NianFeng-Chat）
仓库：https://github.com/nianfeng233/NianFeng-Chat
-->
# 念风件件开发指南

> 念风使用**真实的 cordis v4**：件件就是 cordis 件件。
> 三步：写 manifest → 写 `apply(ctx)` → 放进目录 `npm run sync-plugins`。

---

## 1. 最小前端件件

```js
// plugins/extras/my-plugin/index.mjs
export const name = 'my-plugin'            // 全局唯一 id（kebab-case）
export const version = '1.0.0'
export const displayName = '我的件件'
export const description = '一句话说明'
export const author = '你的名字'
export const icon = '😀'
export const core = false                  // true = 核心，不可禁用
export const enabled = true                // false = 默认关闭，用户可在件件管理中开启
export const depends = { 'event-bus': '^1.0.0' }   // 必须依赖（缺失 = 标红 / 不激活）
export const optionalDepends = { 'markdown-enhancer': '^1.0.0' } // 可选依赖（缺失 = 标黄 / 不影响运行）
export const inject = ['config', 'slots']  // 依赖"服务"（不满足则保持 PENDING，'xxx?' 表示可选）
export const provides = [{ name: 'my-service', type: 'singleton' }]

export function apply(ctx) {
  ctx.logger.info('my-plugin 已启动')
  ctx.provide('my-service', { ping: () => 'pong' })

  ctx.slots.register('rail:middle', container => {
    const btn = document.createElement('button')
    btn.className = 'rail-btn'
    btn.textContent = '😀'
    container.appendChild(btn)
    return () => btn.remove()
  })
}
```

新增目录后：

```bash
npm run sync-plugins   # 重新生成 plugins/registry.mjs
npm test               # 确认没有破坏启动与闭环
```

---

## 2. Manifest 字段

| 字段 | 说明 |
|---|---|
| `name` / `version` | 插件 id 与 semver |
| `displayName` / `description` / `author` / `icon` | 插件管理页展示 |
| `core` / `enabled` | 是否核心 / 默认是否启用 |
| `depends` | `{ 插件名: semver范围 }`，必须依赖；缺失 / 未激活 / 加载失败会标红并阻止加载 |
| `optionalDepends` / `softDepends` | `{ 插件名: semver范围 }`，可选依赖；缺失 / 未启用 / 版本不匹配只标黄，不影响基础功能 |
| `inject` | 需要的服务名数组；`'api?'` 表示可选服务依赖 |
| `provides` | 声明提供的服务（加载期冲突预检 + 统计） |
| `slots` | 会用到的插槽（可选，用于语义冲突提示） |

### 2.1 依赖版本写法

`depends` / `optionalDepends` 的值支持以下写法：

| 写法 | 含义 |
|---|---|
| `'*'`、`'x'`、`''` | 无所谓哪个版本 |
| `'=1.0.0'`、`'1.0.0'` | 硬限制，精确锁定 `1.0.0` |
| `'>=1.0.0'`、`'>1.0.0'`、`'<=2.0.0'`、`'<2.0.0'` | 大于等于 / 大于 / 小于等于 / 小于 |
| `'^1.2.0'` | 兼容 `1.x`（`>=1.2.0 <2.0.0`） |
| `'~1.2.0'` | 兼容 `1.2.x`（`>=1.2.0 <1.3.0`） |
| `'1.2.x'`、`'1'` | 主/次版本前缀 |
| `'1.2.3 - 2.0.0'` | 闭区间 |
| `'>=1.0.0 <2.0.0 \|\| >=3.0.0'` | 空格 / 逗号表示且，`\|\|` 表示或 |

语义约定：

- **必须依赖**缺失、被禁用、加载失败或未激活：插件列表标红，本插件不激活，卡片直接写出缺失的插件与原因。
- **可选依赖**缺失、被禁用、加载失败或版本不匹配：插件列表标黄，本插件仍可运行。
- **版本不匹配**目前只标黄提示，不阻止加载；页面会显示声明的范围与实际版本，便于排查协议漂移。

---

## 3. ctx API（兼容层，底层是 cordis）

```js
/* 事件：载荷式，监听器统一收到 (payload, meta) */
const off = ctx.on('message:done', ({ message }) => {})
ctx.once('app:ready', () => {})
ctx.emit('my-plugin:something', { a: 1 })
ctx.emit('message:send', payload, {          // 拦截型：
  interceptor: true,                          // 监听器可返回新 payload
  onIntercept: (next, pluginId) => {},
})
off()

/* 服务 */
ctx.provide('my-service', impl, { type: 'singleton' })
const config = ctx.inject('config')            // 无回调直接取值
const { config, logs } = ctx.inject(['config', 'logs'])
ctx.inject(['model-service?'], (fork, { modelService }) => { /* 可选依赖 */ })

/* 生命周期 */
ctx.effect(() => { /* 卸载时执行 */ })
ctx.setTimeout(fn, 1000)                        // 随件件卸载自动清理
ctx.setInterval(fn, 1000)

/* 日志：cordis 原生 logger，自动带件件名 */
ctx.logger.debug('...')
ctx.logger.info('...')

/* 只读视图（件件管理器/调试用） */
ctx.registry.get('toast') / .has() / .list() / .ownerOf()
ctx.events.owners('message:send') / .listeners() / .eventNames()

/* 可选导出 */
export function start(ctx) {}
export function stop(ctx) {}
export function dispose(ctx) {}
```

> **effect 语义**：`ctx.effect(fn)` 表示"把 `fn` 注册为卸载时的清理函数"。
> 这与 cordis 原生 `effect(execute)`（立即执行并注册返回值）不同，兼容层已统一，插件按念风的语义写即可。

---

## 4. 件槽

| 件槽 | 位置 | 典型用途 |
|---|---|---|
| `app:*` | 外壳结构位 | 框架件件使用 |
| `titlebar:left/center/right` | 顶部栏 | 品牌、用户信息、窗口按钮 |
| `rail:top/middle/bottom` | 侧边栏 | 视图入口 / **用户件件** / 设置 |
| `chat:list` | 左列（会话视图） | 会话列表 |
| `chat:header` / `chat:header:actions` / `chat:header:before-title` / `chat:header:after-title` | 会话头部 | 标题、翻译/TTS 等开关 |
| `chat:messages` | 消息区 | 消息列表 |
| `chat:composer` | 输入区 | 输入框、工具条 |
| `channel:list` / `channel:detail` | 渠道视图 | 列表、详情 |
| `settings:nav` / `settings:main` / `settings:content` | 设置页 | 导航、内容容器 |

---

## 4.1 渠道件件扩展点

渠道件件通过 `ctx.inject('channel-base').defineChannel()` 注册类型，除了
`name / color / icon / description / connect / disconnect` 之外，还支持：

| 字段 | 类型 | 说明 |
|---|---|---|
| `create(options)` | `Function` | 自定义「添加渠道」流程；`channel-list` 发现该字段后直接调用，不再弹默认的名称输入框。`options.tab` 是当前分类。 |
| `detail(options)` | `Function` | 自定义渠道详情渲染；`options` 包含 `{ container, channel, type }`，返回清理函数。适合接入二维码、状态轮询、专属设置等。 |
| `settingsSchema` | `Object` | 预留给通用表单型渠道件件（当前内置件件未使用，第三方件件可按自己的约定解释）。 |

参考实现：`plugins/channels/wechat-clawbot/index.mjs`。

### 4.2 后端桥与件件设置面板

后端渠道桥放在 `plugins/channels/<name>/bridge.mjs`，会被后端启动器自动扫描加载；
通过 `httpApi` 注册自己的接口，不需要修改本体：

```js
export const name = 'my-channel-bridge'
export const inject = ['settings', 'hub', 'httpApi']
export function apply(ctx) {
  ctx.effect(() => ctx.httpApi.route('GET', '/api/my-channel/status', async (req, res) => {
    ctx.httpApi.sendJson(res, 200, { ok: true })
  }))
}
```

前端件件可以注册自己的设置面板，件件页对应条目会自动出现「设置」按钮：

```js
export function apply(ctx) {
  const manager = ctx.inject('plugin-manager')
  ctx.effect(() => manager.registerSettings({
    id: 'my-plugin',
    title: '我的件件设置',
    description: '件件专属配置',
    render(container, { close, manager: pm }) {
      container.innerHTML = '...'
      return () => { /* 关闭时清理 */ }
    },
  }))
}
```

### 4.3 用户身份接口

Nova 会话、渠道消息的 `sender_id / sender_name` 统一从 `user-identity` 服务读取。
默认值来自 `config` 的 `chat.userId` 与昵称；未来联网账号 / 渠道件件可以注册真实用户：

```js
export function apply(ctx) {
  const identity = ctx.inject('user-identity')
  ctx.effect(() => identity.registerProvider(() => ({
    userId: 'account-12345',
    userName: '念风的主人',
    source: 'my-network-plugin',
  })))
}
```

`user-identity.get()` 会按注册顺序返回第一个有效 provider；不会联网时保留本机默认值。

## 5. 样式

```js
import { useStyle } from '../../../src/util/style.mjs'
useStyle(ctx, ` .my-panel{ background: var(--glass-bg); } `)
```

* 注入 `<style data-plugin="my-plugin">`，卸载自动移除
* 颜色/圆角/阴影只用 `theme-tokens` 的 CSS 变量；深色主题用 `html[data-theme="dark"]` 覆盖
* 不操作别人的 DOM，不污染全局选择器

---

## 6. 可选中服务

```js
// 消费者创建
const bubbles = ctx.inject('service-container').createSelectable('bubble-styles', { fallback: 'bubble-default' })
ctx.provide('bubble-styles', bubbles, { type: 'selectable' })

// 实现方注册
export const inject = ['bubble-styles']
export function apply(ctx) {
  const dispose = ctx.inject('bubble-styles').register('my-bubble', { renderRow }, { order: 20 })
  ctx.effect(dispose)   // 卸载自动注销
}
```

现有 selectable：`theme`、`bg`、`bubble-styles`、`model`。
可选中服务会记住用户「真正选中的实现」：当前实现被卸载时先回退到其它实现，原实现重新注册后自动切回来，不需要刷新页面。

### 6.1 注册型服务的生命周期
通过 `ctx.inject()` 拿到 `event-bus / slots / settings-container / view-router / keyboard-shortcuts / channel-base / model-registry / search-service` 时，兼容层会把这些服务返回的 disposer 自动绑定到当前件件 fiber：件件卸载时自动清理监听器、件槽、设置页、视图、快捷键、渠道类型和模型提供商。这样运行时禁用再启用件件不会留下重复 DOM 或触发“已注册”冲突。手写 `ctx.effect(disposer)` 仍然有效，但不再是必须的。

### 6.2 新增一个聊天工具

聊天工具走 `tool-registry`：`chat-flow` 每轮把全部工具定义交给模型，收到 `tool_calls` 后交给注册的 handler。
新增工具不需要改 `chat-flow`。

```js
// plugins/features/my-tool/index.mjs
export const name = 'my-tool'
export const version = '1.0.0'
export const inject = ['tool-registry', 'event-bus']
export const core = false

export function apply(ctx) {
  const registry = ctx.inject('tool-registry')
  const dispose = registry.register(
    'my_tool',
    {
      description: '一句话告诉模型这个工具做什么、什么时候用。',
      parameters: {
        type: 'object',
        properties: { keyword: { type: 'string', description: '查询关键词' } },
        required: ['keyword'],
      },
    },
    async (args, context) => {
      // context: { conversationId, channelId, roleId, userId, userName, round, sentContents, entry }
      return { ok: true, result: args.keyword }
    },
  )
  ctx.effect(dispose)
}
```

> 需要读渠道历史的工具请先调用 `chat-permissions.authorize()`；跨渠道被拒绝时统一返回
> `{ ok:false, error:'目标渠道不可用' }`，不要向模型暴露具体的权限表内容。

---

## 7. 往后端加一个件件

后端也是 cordis 应用，件件放 `server/plugins/`：

```js
// server/plugins/hello.mjs
export const name = 'hello'
export const inject = ['settings']

export function apply(ctx, config) {
  const settings = ctx.settings                 // cordis 原生：注入即为属性
  ctx.provide('hello', { greet: () => 'hi' })
  ctx.on('settings/updated', () => {})          // 后端事件
}
```

然后在 `server/index.mjs` 的 `plugins` 数组里加入：

```js
import * as helloPlugin from './plugins/hello.mjs'
...
[helloPlugin, {}],
```

需要在 `/api/*` 暴露接口时，把路由写进 `server/plugins/http.mjs` 的路由表：

```js
route('GET', '/api/hello', async (req, res) => {
  sendJson(res, 200, { message: ctx.hello.greet() })
})
```

> 后端服务命名注意避开 cordis 的内置属性（`logger`、`events`、`registry`、`config`、`fiber`、`root`）。

---

## 8. 往设置页加一项

```js
export const inject = ['settings-container']

export function apply(ctx) {
  ctx.inject('settings-container').register({
    id: 'my-page',
    group: '偏好',
    groupOrder: 30,
    label: '我的设置',
    icon: '<svg …/>',
    order: 70,
    render(container, ctx) {
      container.innerHTML = page('我的设置', '说明', card(
        row('开关', '说明文字', switchBtn('my.enabled', true)),
      ))
      return bindConfigControls(container, ctx)
    },
  })
}
```

`src/util/settings.mjs` 提供 `page / section / card / row / switchBtn / segmented / select / input`
与 `bindConfigControls`（自动绑定 `data-config-*` 到 config 服务）。

---

## 9. 测试与排障

```bash
npm test               # 模块检查 + 后端 63 + 前端 189 + 对话链路 13 + Nova 工具链路 101 + 厂商协议 30
__wind_debug.status()  # 我的件件是 active / inactive / error？原因是什么？
__wind_debug.fibers()  # 对应 cordis fiber 的真实状态
__wind_debug.services()
__wind_debug.trace(true)
```

常见状态与处理：

| 状态/原因 | 处理 |
|---|---|
| `inactive · 缺少依赖：服务:xxx` | 检查 `inject` 拼写；服务是否真的有人 provide |
| `error · service "x" has been registered` | singleton 冲突，换名字或禁用冲突件件 |
| `inactive · 循环依赖` | 检查 `depends` 互相引用 |
| 件件 active 但界面没反应 | 检查件槽 id 是否写对；用 `ctx.events.listeners('event')` 看监听 |

---

## 10. 发布前 Checklist

- [ ] `name / version / displayName / description / author` 完整
- [ ] `inject` 与 `provides` 准确，可选依赖加 `?`；插件依赖按必须 / 可选分别写 `depends` 与 `optionalDepends`
- [ ] 没有全局变量、没有直接 `localStorage`、没有跨件件 DOM 操作
- [ ] `ctx.on / effect / setTimeout / 件槽注册` 都能随卸载释放
- [ ] 样式走 `useStyle` + CSS 变量，深色主题可读
- [ ] `npm run sync-plugins && npm test` 通过
- [ ] 件件管理页能启用/禁用，界面无残留
- [ ] 如果依赖后端：离线时给出明确提示，而不是假装成功

---

## 11. 做「大幅视觉调整」的推荐路径

| 目标 | 推荐做法 | 注意 |
|---|---|---|
| 换配色 / 玻璃板透明度 | 优先改 `theme-tokens` 的 CSS 变量，或写一个只 `useStyle` 的扩展件件；外观页已有玻璃板透明度滑块 | 需要覆盖时提高选择器特异性，不要直接改 DOM 结构 |
| 重做某一列列表（会话 / 渠道） | 依赖 `left-list-panel` + 对应 view，件件里注入针对 `[data-view="chat"] .list-pane` 等稳定 hook 的样式 | 不要注册已有的 view id，会触发「视图已注册」冲突 |
| 完全替换某块面板结构 | 新件件注册一个新的 `view-router` 视图（新 id + rail 入口），或直接改源件件 `chat-view` / `left-list-panel` | 替换内置 view id 目前需要改源码；扩展件件建议新建视图 |
| 给设置页加视觉选项 | `ctx.inject('appearance-page')?.addSection()`，配合 `bindConfigControls` / `theme-tokens` | config 变更后由 theme-tokens 广播到全局 CSS 变量 |
| 换气泡 / 背景 / 主题实现 | 往 selectable 服务 `bubble-styles / bg / theme` 注册新实现，用户可在设置中切换 | 这是官方扩展点，不会判定为冲突 |

**冲突规则**：同名 singleton `provides`、重复 view id 会冲突；只注入 CSS / 新增 view id / 新增 selectable 实现不会冲突。`useStyle` 的 `<style data-plugin="...">` 按件件加载顺序追加，依赖目标件件（`depends` / `inject`）可以保证你的样式排在后面。
