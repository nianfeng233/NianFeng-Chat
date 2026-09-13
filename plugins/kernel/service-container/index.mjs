/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * K5 · service-container
 * 服务注册与注入的对外入口（内核实现见 src/kernel/registry.mjs），
 * 并实现文档 §4.2 的可选中型服务工厂 createSelectable()。
 */
export const name = 'service-container'
export const version = '1.0.0'
export const displayName = '服务容器'
export const description = '内核层 · provide / inject 服务注册与注入，支持单体 / 聚合 / 可选中三种类型。'
export const author = '念风内核'
export const icon = '📦'
export const core = true
export const depends = {
  'config': '>=1.1.0',
  'event-bus': '*',
}
export const optionalDepends = {}
export const inject = ['event-bus', 'config']
export const provides = [{ name: 'service-container', type: 'singleton' }]

export function apply(ctx) {
  const config = ctx.inject('config')
  const events = ctx.inject('event-bus')

  /**
   * 可选中型服务：多实现注册，同一时刻只有一个激活。
   * 文档 §4.2 的接口：register / unregister / select / getActive / list
   */
  function createSelectable(serviceName, { displayName: label = serviceName, fallback = null } = {}) {
    const items = new Map()
    const persistKey = `selectable.${serviceName}.activeId`
    const preferredKey = `selectable.${serviceName}.preferredId`
    let activeId = config.get(persistKey, null)
    // 用户真正想用的实现。实现被卸载时 activeId 会临时落到别的实现上，
    // 但 preferredId 保留；同一个实现重新注册时自动切回来。
    let preferredId = config.get(preferredKey, null)
    /** 只在配置真的变化时写回，避免 select/register/unregister 触发 settings/updated 回环。 */
    const setConfigIfChanged = (key, value) => {
      if (config.get(key, undefined) === value) return false
      config.set(key, value)
      return true
    }
    if (!preferredId && activeId) {
      preferredId = activeId
      setConfigIfChanged(preferredKey, preferredId)
    }

    // 允许 config 的远程 / 本地变化直接驱动可选中服务。
    // 典型场景：后端偏好同步、设置页写入配置后，主题 / 背景 / 气泡立即切换。
    config.watch(persistKey, value => {
      if (!value || value === activeId || !items.has(value)) return
      activeId = value
      events.emit(`${serviceName}:changed`, activeId, { owner: 'service-container' })
    })
    config.watch(preferredKey, value => {
      if (value) preferredId = value
    })

    const api = {
      __selectable: true,
      name: serviceName,
      displayName: label,

      register(id, impl, meta = {}) {
        if (items.has(id)) throw new Error(`可选中服务 ${serviceName} 已注册实现：${id}`)
        const hadActiveImpl = !!activeId && items.has(activeId)
        items.set(id, { impl, meta: { ...meta, id } })

        let changed = false
        // 当前 choice 还没有对应实现时（首次注册 / 选了未安装的 id），
        // 自动落到 fallback 或本次注册的实现上，保证界面始终有实现可用。
        if (!hadActiveImpl) {
          const next = items.has(activeId) ? activeId : (fallback && items.has(fallback) ? fallback : id)
          activeId = next
          setConfigIfChanged(persistKey, next)
          changed = true
        }
        // 用户偏好的实现回来了：立即切回来，而不是让它挂在后台注册着。
        if (preferredId && preferredId !== activeId && items.has(preferredId)) {
          activeId = preferredId
          setConfigIfChanged(persistKey, activeId)
          changed = true
        }
        if (!preferredId && activeId) {
          preferredId = activeId
          setConfigIfChanged(preferredKey, preferredId)
        }
        if (changed) events.emit(`${serviceName}:changed`, activeId, { owner: 'service-container' })

        events.emit(`${serviceName}:registered`, { id, meta })
        ctx.logger.debug(`可选中服务 ${serviceName} 注册实现 ${id}`)
        return () => api.unregister(id)
      },

      unregister(id) {
        items.delete(id)
        events.emit(`${serviceName}:unregistered`, { id })
        if (activeId === id) {
          activeId = items.has(fallback) ? fallback : [...items.keys()][0] || null
          setConfigIfChanged(persistKey, activeId)
          events.emit(`${serviceName}:changed`, activeId, { owner: 'service-container' })
        }
      },

      select(id) {
        if (!items.has(id)) throw new Error(`未安装的实现：${id}（服务 ${serviceName}）`)
        if (preferredId !== id) {
          preferredId = id
          setConfigIfChanged(preferredKey, id)
        }
        if (activeId === id) return
        activeId = id
        setConfigIfChanged(persistKey, id)
        events.emit(`${serviceName}:changed`, id, { owner: 'service-container' })
      },

      getActive() {
        return items.get(activeId)?.impl ?? null
      },

      getActiveId() {
        return activeId
      },

      get(id) {
        return items.get(id)?.impl ?? null
      },

      has(id) {
        return items.has(id)
      },

      list() {
        // 兼容两种注册写法：label / description 可以放在 meta，也可以直接放在实现对象上。
        // 设置页统一读取合并后的 label，避免把 bg-aurora 这样的内部 id 当成名称展示。
        return [...items.entries()].map(([id, v]) => ({
          ...v.meta,
          id,
          label: v.meta.label ?? v.impl?.label,
          description: v.meta.description ?? v.impl?.description,
          active: id === activeId,
        }))
      },

      onChange(cb) {
        return ctx.on(`${serviceName}:changed`, cb)
      },
    }

    return api
  }

  const service = {
    name: 'service-container',
    createSelectable,
    has: name => ctx.registry.has(name),
    get: name => ctx.registry.get(name),
    ownerOf: name => ctx.registry.ownerOf(name),
    list: () => ctx.registry.list(),
    /** 服务名 → 驼峰写法：session-service → sessionService */
    toCamel: name => String(name).replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase()),
  }

  ctx.provide('service-container', service, { type: 'singleton' })
  ctx.logger.debug('服务容器就绪')
}
