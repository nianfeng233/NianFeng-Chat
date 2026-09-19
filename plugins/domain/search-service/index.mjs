/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * D8 · search-service
 * 全局搜索：聚合会话 / 消息 / 渠道 / 插件 / 设置页，支持插件注册新的数据源。
 */
export const name = 'search-service'
export const version = '1.0.1'
export const displayName = '全局搜索服务'
export const description = '业务服务 · 跨会话 / 渠道 / 插件的全局搜索。'
export const author = '念风内核'
export const icon = '🔍'
export const core = false
export const depends = {
  'event-bus': '*',
  'session-service': '^2.0.0',
}
export const optionalDepends = {}
export const inject = ['session-service', 'event-bus']
export const provides = [{ name: 'search-service', type: 'singleton' }]

export function apply(ctx) {
  const sessions = ctx.inject('session-service')
  const events = ctx.inject('event-bus')

  /** 插件注册的数据源：id -> (query) => results[] */
  const providers = new Map()

  const builtinProviders = {
    conversation(query) {
      const q = query.toLowerCase()
      return sessions
        .list()
        .filter(c => !c.meta?.hiddenFromSessionList)
        .filter(c => c.name.toLowerCase().includes(q) || String(c.preview || '').toLowerCase().includes(q))
        .slice(0, 6)
        .map(c => ({ type: 'conversation', id: c.id, title: c.name, snippet: c.preview, action: { event: 'search:open-conversation', payload: { id: c.id } } }))
    },
    message(query) {
      const q = query.toLowerCase()
      const out = []
      for (const conv of sessions.list()) {
        for (const msg of conv.messages) {
          if (msg.kind === 'divider') continue
          const index = String(msg.content).toLowerCase().indexOf(q)
          if (index < 0) continue
          out.push({
            type: 'message',
            id: msg.id,
            conversationId: conv.id,
            title: `${conv.name} · ${msg.role === 'user' ? '我' : conv.name}`,
            snippet: snippet(msg.content, index, query.length),
            action: { event: 'search:open-conversation', payload: { id: conv.id } },
          })
          if (out.length >= 8) return out
        }
      }
      return out
    },
    channel(query) {
      const registry = ctx.registry.get('channel-registry')
      if (!registry) return []
      const q = query.toLowerCase()
      const out = []
      for (const tab of registry.tabs()) {
        for (const channel of registry.channels(tab)) {
          if (!channel.name.toLowerCase().includes(q) && !channel.type.toLowerCase().includes(q)) continue
          out.push({
            type: 'channel',
            id: channel.id,
            title: channel.name,
            snippet: `${channel.type} · ${channel.status}`,
            action: { event: 'search:open-channel', payload: { tab, id: channel.id } },
          })
        }
      }
      return out.slice(0, 6)
    },
    plugin(query) {
      const manager = ctx.registry.get('plugin-manager')
      if (!manager) return []
      const q = query.toLowerCase()
      return manager
        .list()
        .filter(p => p.id.includes(q) || p.name.toLowerCase().includes(q) || String(p.description).toLowerCase().includes(q))
        .slice(0, 6)
        .map(p => ({ type: 'plugin', id: p.id, title: p.name, snippet: `${p.id} · ${p.statusLabel}`, action: { event: 'settings:open', payload: { page: 'plugins' } } }))
    },
    setting(query) {
      const container = ctx.registry.get('settings-container')
      if (!container) return []
      const q = query.toLowerCase()
      return container
        .list()
        .filter(p => p.label.toLowerCase().includes(q) || p.id.includes(q))
        .map(p => ({ type: 'setting', id: p.id, title: `设置 · ${p.label}`, snippet: p.group, action: { event: 'settings:open', payload: { page: p.id } } }))
    },
  }

  const service = {
    name: 'search-service',
    registerProvider(id, fn) {
      providers.set(id, fn)
      return () => providers.delete(id)
    },
    providers: () => [...Object.keys(builtinProviders), ...providers.keys()],
    search(query, { limit = 24, types } = {}) {
      const q = String(query || '').trim()
      if (!q) return { query: '', groups: {}, total: 0 }
      const groups = {}
      const all = [
        ...Object.entries(builtinProviders).map(([id, fn]) => ({ id, fn })),
        ...[...providers.entries()].map(([id, fn]) => ({ id, fn })),
      ]
      for (const { id, fn } of all) {
        if (types && !types.includes(id)) continue
        try {
          const results = fn(q) || []
          if (results.length) groups[id] = results
        } catch (err) {
          ctx.logger.warn(`搜索源 ${id} 出错`, err)
        }
      }
      const total = Object.values(groups).reduce((sum, list) => sum + list.length, 0)
      const result = { query: q, groups, total: Math.min(total, limit) }
      events.emit('search:performed', result)
      return result
    },
    /** 执行结果上的 action */
    run(result) {
      if (!result?.action) return
      events.emit(result.action.event, result.action.payload, { owner: 'search-service' })
    },
  }

  ctx.provide('search-service', service, { type: 'singleton' })
  ctx.logger.debug('全局搜索就绪')
}

function snippet(content, index, length) {
  const text = String(content).replace(/\s+/g, ' ')
  const start = Math.max(0, index - 16)
  const end = Math.min(text.length, index + length + 24)
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`
}
