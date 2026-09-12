/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * D5 · view-router
 * 当前视图、列表宽度记忆、视图注册表。
 * 每个视图插件调用 register(viewId, { label, icon, list, main }) 注册自己，
 * 左列表容器 / 右主面板只认 view-router，不认具体视图（文档 §3、§8.2）。
 */
export const name = 'view-router'
export const version = '1.0.0'
export const displayName = '视图路由'
export const description = '业务服务 · 当前视图、列表宽度记忆与视图注册。'
export const author = '念风内核'
export const icon = '🧭'
export const core = true
export const depends = { config: '^1.0.0' }
export const inject = ['config', 'event-bus']
export const provides = [{ name: 'view-router', type: 'singleton' }]

export const LIST_CONFIG = {
  chat: { min: 68, max: 520, default: 300 },
  channel: { min: 200, max: 520, default: 260 },
  settings: { min: 200, max: 520, default: 260 },
}

export function apply(ctx) {
  const config = ctx.inject('config')
  const events = ctx.inject('event-bus')

  const views = new Map()
  let active = config.get('view.active', 'chat')
  const widths = {
    chat: config.get('view.width.chat', LIST_CONFIG.chat.default),
    channel: config.get('view.width.channel', LIST_CONFIG.channel.default),
  }

  const applyWidth = () => {
    const key = widths[active] === undefined ? 'chat' : active
    const cfg = LIST_CONFIG[key] || LIST_CONFIG.chat
    widths[key] = clamp(widths[key], cfg.min, cfg.max)
    document.documentElement.style.setProperty('--list-w', `${widths[key]}px`)
    return widths[key]
  }

  const service = {
    name: 'view-router',

    /** 注册一个视图：list / main 都是 (container, ctx) => cleanup 的挂载函数 */
    register(id, definition = {}) {
      if (views.has(id)) throw new Error(`视图已注册：${id}`)
      views.set(id, {
        id,
        label: definition.label || id,
        icon: definition.icon || '',
        order: definition.order ?? 100,
        rail: definition.rail !== false,
        list: definition.list || null,
        main: definition.main || null,
        meta: definition.meta || {},
      })
      events.emit('view:registered', { id, definition: { label: definition.label, rail: definition.rail !== false } })
      return () => {
        if (!views.has(id)) return false
        views.delete(id)
        events.emit('view:unregistered', { id })
        if (active === id) {
          const previous = active
          const next = [...views.values()].sort((a, b) => a.order - b.order)[0]?.id || null
          active = next
          config.set('view.active', next)
          applyWidth()
          events.emit('view:switch', { view: next, previous })
          events.emit('view:changed', { view: next, previous })
        }
        return true
      }
    },

    list: () => [...views.values()].sort((a, b) => a.order - b.order),
    get: id => views.get(id) || null,
    has: id => views.has(id),
    active: () => active,
    activeView: () => views.get(active) || null,

    switch(id) {
      if (id === active) return false
      if (!views.has(id)) throw new Error(`视图不存在：${id}`)
      const previous = active
      active = id
      config.set('view.active', id)
      applyWidth()
      events.emit('view:switch', { view: id, previous })
      events.emit('view:changed', { view: id, previous })
      return true
    },

    /** 视图渲染完成 */
    ready(id) {
      events.emit('view:ready', { view: id })
    },

    /* -------- 列表宽度记忆（文档 §8.2） -------- */
    getWidth(view = active) {
      return widths[view] ?? LIST_CONFIG[view]?.default ?? 300
    },
    setWidth(view, width) {
      const cfg = LIST_CONFIG[view] || LIST_CONFIG.chat
      widths[view] = clamp(width, cfg.min, cfg.max)
      config.set(`view.width.${view}`, widths[view])
      applyWidth()
      return widths[view]
    },
    widthConfig: view => LIST_CONFIG[view] || LIST_CONFIG.chat,
    applyWidth,
  }

  ctx.provide('view-router', service, { type: 'singleton' })

  // 让左右面板在启动后拿到正确的宽度
  if (typeof document !== 'undefined') applyWidth()
  ctx.logger.debug(`视图路由就绪 · 当前视图 ${active}`)
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v))
}
