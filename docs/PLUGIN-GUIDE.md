# 风语插件开发指南

> 风语使用**真实的 cordis v4**：插件就是 cordis 插件。
> 三步：写 manifest → 写 `apply(ctx)` → 放进目录 `npm run sync-plugins`。

---

## 1. 最小前端插件

```js
// plugins/extras/my-plugin/index.mjs
export const name = 'my-plugin'            // 全局唯一 id（kebab-case）
export const version = '1.0.0'
export const displayName = '我的插件'
export const description = '一句话说明'
export const author = '你的名字'
export const icon = '😀'
export const core = false                  // true = 核心，不可禁用
export const enabled = true                // false = 默认关闭，用户可在插件管理中开启
export const depends = { 'event-bus': '^1.0.0' }   // 依赖"插件"（影响加载顺序）
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
| `depends` | `{ 插件名: semver范围 }`，用于拓扑排序 |
| `inject` | 需要的服务名数组；`'api?'` 为可选依赖 |
| `provides` | 声明提供的服务（加载期冲突预检 + 统计） |
| `slots` | 会用到的插槽（可选，用于语义冲突提示） |

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
ctx.setTimeout(fn, 1000)                        // 随插件卸载自动清理
ctx.setInterval(fn, 1000)

/* 日志：cordis 原生 logger，自动带插件名 */
ctx.logger.debug('...')
ctx.logger.info('...')

/* 只读视图（插件管理器/调试用） */
ctx.registry.get('toast') / .has() / .list() / .ownerOf()
ctx.events.owners('message:send') / .listeners() / .eventNames()

/* 可选导出 */
export function start(ctx) {}
export function stop(ctx) {}
export function dispose(ctx) {}
```

> **effect 语义**：`ctx.effect(fn)` 表示"把 `fn` 注册为卸载时的清理函数"。
> 这与 cordis 原生 `effect(execute)`（立即执行并注册返回值）不同，兼容层已统一，插件按风语语义写即可。

---

## 4. 插槽

| 插槽 | 位置 | 典型用途 |
|---|---|---|
| `app:*` | 外壳结构位 | 框架插件使用 |
| `titlebar:left/center/right` | 顶部栏 | 品牌、用户信息、窗口按钮 |
| `rail:top/middle/bottom` | 侧边栏 | 视图入口 / **用户插件** / 设置 |
| `chat:list` | 左列（会话视图） | 会话列表 |
| `chat:header` / `chat:header:actions` / `chat:header:before-title` / `chat:header:after-title` | 会话头部 | 标题、翻译/TTS 等开关 |
| `chat:messages` | 消息区 | 消息列表 |
| `chat:composer` | 输入区 | 输入框、工具条 |
| `channel:list` / `channel:detail` | 渠道视图 | 列表、详情 |
| `settings:nav` / `settings:main` / `settings:content` | 设置页 | 导航、内容容器 |

---

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
通过 `ctx.inject()` 拿到 `event-bus / slots / settings-container / view-router / keyboard-shortcuts / channel-base / model-registry / search-service` 时，兼容层会把这些服务返回的 disposer 自动绑定到当前插件 fiber：插件卸载时自动清理监听器、插槽、设置页、视图、快捷键、渠道类型和模型提供商。这样运行时禁用再启用插件不会留下重复 DOM 或触发“已注册”冲突。手写 `ctx.effect(disposer)` 仍然有效，但不再是必须的。

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

## 7. 往后端加一个插件

后端也是 cordis 应用，插件放 `server/plugins/`：

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
__wind_debug.status()  # 我的插件是 active / inactive / error？原因是什么？
__wind_debug.fibers()  # 对应 cordis fiber 的真实状态
__wind_debug.services()
__wind_debug.trace(true)
```

常见状态与处理：

| 状态/原因 | 处理 |
|---|---|
| `inactive · 缺少依赖：服务:xxx` | 检查 `inject` 拼写；服务是否真的有人 provide |
| `error · service "x" has been registered` | singleton 冲突，换名字或禁用冲突插件 |
| `inactive · 循环依赖` | 检查 `depends` 互相引用 |
| 插件 active 但界面没反应 | 检查插槽 id 是否写对；用 `ctx.events.listeners('event')` 看监听 |

---

## 10. 发布前 Checklist

- [ ] `name / version / displayName / description / author` 完整
- [ ] `inject` 与 `provides` 准确，可选依赖加 `?`
- [ ] 没有全局变量、没有直接 `localStorage`、没有跨插件 DOM 操作
- [ ] `ctx.on / effect / setTimeout / 插槽注册` 都能随卸载释放
- [ ] 样式走 `useStyle` + CSS 变量，深色主题可读
- [ ] `npm run sync-plugins && npm test` 通过
- [ ] 插件管理页能启用/禁用，界面无残留
- [ ] 如果依赖后端：离线时给出明确提示，而不是假装成功

---

## 11. 做「大幅视觉调整」的推荐路径

| 目标 | 推荐做法 | 注意 |
|---|---|---|
| 换配色 / 玻璃板透明度 | 优先改 `theme-tokens` 的 CSS 变量，或写一个只 `useStyle` 的扩展插件；外观页已有玻璃板透明度滑块 | 需要覆盖时提高选择器特异性，不要直接改 DOM 结构 |
| 重做某一列列表（会话 / 渠道） | 依赖 `left-list-panel` + 对应 view，插件里注入针对 `[data-view="chat"] .list-pane` 等稳定 hook 的样式 | 不要注册已有的 view id，会触发「视图已注册」冲突 |
| 完全替换某块面板结构 | 新插件注册一个新的 `view-router` 视图（新 id + rail 入口），或直接改源插件 `chat-view` / `left-list-panel` | 替换内置 view id 目前需要改源码；扩展插件建议新建视图 |
| 给设置页加视觉选项 | `ctx.inject('appearance-page')?.addSection()`，配合 `bindConfigControls` / `theme-tokens` | config 变更后由 theme-tokens 广播到全局 CSS 变量 |
| 换气泡 / 背景 / 主题实现 | 往 selectable 服务 `bubble-styles / bg / theme` 注册新实现，用户可在设置中切换 | 这是官方扩展点，不会判定为冲突 |

**冲突规则**：同名 singleton `provides`、重复 view id 会冲突；只注入 CSS / 新增 view id / 新增 selectable 实现不会冲突。`useStyle` 的 `<style data-plugin="...">` 按插件加载顺序追加，依赖目标插件（`depends` / `inject`）可以保证你的样式排在后面。
