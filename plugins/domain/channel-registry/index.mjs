/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * D6 · channel-registry
 * 注册所有渠道类型与实例（文档 §6.3）。
 * 渠道插件（B3~B6）只负责 registerType + 上报状态；
 * 渠道视图（V12~V14）只负责展示与交互。
 */
export const name = 'channel-registry'
export const version = '1.0.0'
export const displayName = '渠道注册中心'
export const description = '业务服务 · 渠道类型注册与渠道实例管理。'
export const author = '念风内核'
export const icon = '📡'
export const core = true
export const depends = { storage: '^1.0.0' }
export const inject = ['storage', 'event-bus']
export const provides = [{ name: 'channel-registry', type: 'singleton' }]

const NS = 'channels'
const KEY = 'data'
const TABS = ['private', 'group', 'privacy']

/**
 * 已知但未实现的渠道类型：明确标注，不用假数据填充。
 * 微信 Clawbot 已由独立插件 plugins/channels/wechat-clawbot 实现，
 * 不再放在这里占位；插件未安装时菜单里不会出现“微信clawbot”。
 */
const PLANNED = [
  { type: 'discord', name: 'Discord', color: '#5865f2', reason: '未实现：需要 Discord Bot Gateway 长连接与完整权限申请流程' },
  { type: 'email', name: '邮箱', color: '#8b5cf6', reason: '未实现：需要 IMAP/SMTP 凭据与邮件线程解析' },
]

export function apply(ctx) {
  const storage = ctx.inject('storage')
  const events = ctx.inject('event-bus')

  let data = storage.get(NS, KEY, null)
  if (!data || !data.groups) {
    data = {
      groups: {
        private: [{ id: 'g-default-private', name: '我的渠道', expanded: true, channels: [] }],
        group: [{ id: 'g-default-group', name: '我的渠道', expanded: true, channels: [] }],
        privacy: [{ id: 'g-default-privacy', name: '我的渠道', expanded: true, channels: [] }],
      },
      activeKey: null,
    }
    storage.set(NS, KEY, data)
  }
  data.activeKey = null

  const types = new Map()
  const planned = new Map(PLANNED.map(item => [item.type, item]))
  const persist = () => storage.set(NS, KEY, data)
  const nextGroupId = () => `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
  const nextChannelId = () => `ch${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`

  const service = {
    name: 'channel-registry',
    tabs: () => [...TABS],

    /** 已知但未实现的渠道类型 */
    plannedList: () => [...planned.values()],

    /* -------- 渠道类型 -------- */
    registerType(id, definition = {}) {
      if (types.has(id)) throw new Error(`渠道类型已注册：${id}`)
      types.set(id, {
        id,
        name: definition.name || id,
        color: definition.color || '#8b919c',
        icon: definition.icon || '',
        description: definition.description || '',
        meta: definition.meta || {},
        connect: definition.connect || (() => Promise.resolve()),
        disconnect: definition.disconnect || (() => Promise.resolve()),
        // 渠道类型扩展点：
        //   create(options)  自定义「添加渠道」流程（例如 Clawbot 的配置窗口）
        //   detail(options)  自定义渠道详情渲染（例如 Clawbot 的接入二维码/状态）
        //   settingsSchema   预留给通用表单型渠道插件
        create: typeof definition.create === 'function' ? definition.create : null,
        detail: typeof definition.detail === 'function' ? definition.detail : null,
        settingsSchema: definition.settingsSchema || null,
      })
      events.emit('channel:type-registered', { id })
      return () => types.delete(id)
    },
    typeList: () => [...types.values()],
    type: id => types.get(id) || null,

    /* -------- 分组 / 渠道 -------- */
    groups: tab => data.groups[tab] || [],
    allGroups: () => data.groups,
    group(tab, groupId) {
      return service.groups(tab).find(g => g.id === groupId) || null
    },
    channels: tab => service.groups(tab).flatMap(g => g.channels),

    addGroup(tab, name) {
      const group = { id: nextGroupId(), name, expanded: true, channels: [] }
      data.groups[tab].push(group)
      persist()
      events.emit('channel:group-added', { tab, group })
      return group
    },
    renameGroup(tab, groupId, name) {
      const group = service.group(tab, groupId)
      if (!group) return null
      group.name = name
      persist()
      events.emit('channel:group-updated', { tab, group })
      return group
    },
    removeGroup(tab, groupId) {
      const list = data.groups[tab]
      if (list.length <= 1) return false
      const index = list.findIndex(g => g.id === groupId)
      if (index < 0) return false
      const [group] = list.splice(index, 1)
      persist()
      events.emit('channel:group-removed', { tab, group })
      return true
    },
    toggleGroup(tab, groupId) {
      const group = service.group(tab, groupId)
      if (!group) return null
      group.expanded = !group.expanded
      persist()
      events.emit('channel:group-updated', { tab, group })
      return group
    },

    addChannel(tab, groupId, partial = {}) {
      const group = service.group(tab, groupId)
      if (!group) return null
      const typeDef = types.get(partial.type)
      const channel = {
        id: partial.id || nextChannelId(),
        type: partial.type || 'custom',
        name: partial.name || typeDef?.name || '新渠道',
        color: partial.color || typeDef?.color || '#8b919c',
        status: partial.status || 'offline',
        meta: partial.meta || {},
      }
      group.channels.push(channel)
      group.expanded = true
      persist()
      events.emit('channel:add', { tab, groupId, channel })
      return channel
    },
    removeChannel(tab, channelId) {
      for (const group of service.groups(tab)) {
        const index = group.channels.findIndex(c => c.id === channelId)
        if (index >= 0) {
          const [channel] = group.channels.splice(index, 1)
          persist()
          events.emit('channel:removed', { tab, channel })
          return channel
        }
      }
      return null
    },
    updateChannel(tab, channelId, patch) {
      const channel = service.findChannel(tab, channelId)
      if (!channel) return null
      Object.assign(channel, patch)
      persist()
      events.emit('channel:updated', { tab, channel })
      return channel
    },
    findChannel(tab, channelId) {
      return service.channels(tab).find(c => c.id === channelId) || null
    },

    /** 拖拽排序：把 channelId 移到目标分组（文档对应的 demo 交互） */
    moveChannel(tab, channelId, targetGroupId, targetIndex = null) {
      const groups = service.groups(tab)
      let moved = null
      for (const group of groups) {
        const index = group.channels.findIndex(c => c.id === channelId)
        if (index >= 0) {
          ;[moved] = group.channels.splice(index, 1)
          break
        }
      }
      if (!moved) return null
      const target = groups.find(g => g.id === targetGroupId)
      if (!target) return null
      if (targetIndex === null || targetIndex > target.channels.length) target.channels.push(moved)
      else target.channels.splice(targetIndex, 0, moved)
      persist()
      events.emit('channel:moved', { tab, channel: moved, targetGroupId })
      return moved
    },

    /* -------- 激活 / 状态 -------- */
    activate(tab, channelId) {
      const key = channelId ? `${tab}:${channelId}` : null
      data.activeKey = data.activeKey === key ? null : key
      persist()
      events.emit('channel:activated', { tab, id: data.activeKey ? channelId : null, active: data.activeKey === key })
      return data.activeKey
    },
    activeKey: () => data.activeKey,
    active() {
      if (!data.activeKey) return null
      const [tab, channelId] = data.activeKey.split(':')
      return service.findChannel(tab, channelId)
    },
    setStatus(channelId, status) {
      for (const tab of TABS) {
        const channel = service.findChannel(tab, channelId)
        if (channel) {
          channel.status = status
          persist()
          events.emit('channel:status', { id: channelId, status })
          return channel
        }
      }
      return null
    },

    /** 调用渠道类型注册的 connect 钩子；没有真实类型插件时退化为本地状态切换 */
    async connect(tab, channelId) {
      const channel = service.findChannel(tab, channelId)
      if (!channel) return null
      const type = types.get(channel.type)
      if (!type) return service.setStatus(channelId, 'online')
      service.setStatus(channelId, 'connecting')
      try {
        await type.connect(channel)
        service.setStatus(channelId, 'online')
        events.emit('channel:updated', { tab, channel })
        return channel
      } catch (err) {
        channel.status = 'error'
        channel.meta = { ...(channel.meta || {}), lastError: String(err?.message || err) }
        persist()
        events.emit('channel:status', { id: channelId, status: 'error', error: channel.meta.lastError })
        throw err
      }
    },

    /** 调用渠道类型注册的 disconnect 钩子；没有真实类型插件时退化为本地状态切换 */
    async disconnect(tab, channelId) {
      const channel = service.findChannel(tab, channelId)
      if (!channel) return null
      const type = types.get(channel.type)
      if (!type) return service.setStatus(channelId, 'offline')
      try {
        await type.disconnect(channel)
        service.setStatus(channelId, 'offline')
        events.emit('channel:updated', { tab, channel })
        return channel
      } catch (err) {
        channel.status = 'error'
        channel.meta = { ...(channel.meta || {}), lastError: String(err?.message || err) }
        persist()
        events.emit('channel:status', { id: channelId, status: 'error', error: channel.meta.lastError })
        throw err
      }
    },

    stats() {
      const list = service.channels('private').concat(service.channels('group'), service.channels('privacy'))
      const by = status => list.filter(c => c.status === status).length
      return { total: list.length, online: by('online'), offline: by('offline'), error: by('error') }
    },
  }

  ctx.provide('channel-registry', service, { type: 'singleton' })

  // 全局搜索选择渠道结果时走这个事件，真正更新 activeKey 并刷新详情。
  ctx.effect(
    events.on('search:open-channel', ({ tab, id } = {}) => {
      if (!tab || !id) return
      if (data.activeKey !== `${tab}:${id}` && service.findChannel(tab, id)) service.activate(tab, id)
    }),
  )
  ctx.logger.info(`渠道注册中心就绪 · ${service.stats().total} 个渠道`)
}
