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
export const depends = {
  'config': '>=1.1.0',
  'event-bus': '*',
  'storage': '^1.0.0',
}
export const optionalDepends = {}
export const inject = ['storage', 'event-bus', 'config']
export const provides = [{ name: 'channel-registry', type: 'singleton' }]

const NS = 'channels'
const KEY = 'data'
const TABS = ['private', 'group', 'privacy']

/**
 * 渠道类型完全由插件注册后出现在「添加渠道」菜单里。
 *
 * 这里不再保留 Discord / 邮箱之类的“未实现”占位条目：菜单里只显示
 * 真正可用的渠道，避免用户点到一个永远无法创建的选项。
 * plannedList() 仍保留为空实现，供旧代码/外部插件兼容调用。
 */

export function apply(ctx) {
  const storage = ctx.inject('storage')
  const events = ctx.inject('event-bus')
  const config = ctx.inject('config')

  const defaults = () => ({
    groups: {
      private: [{ id: 'g-default-private', name: '我的渠道', expanded: true, channels: [] }],
      group: [{ id: 'g-default-group', name: '我的渠道', expanded: true, channels: [] }],
      privacy: [{ id: 'g-default-privacy', name: '我的渠道', expanded: true, channels: [] }],
    },
    activeKey: null,
    updatedAt: 0,
  })
  const isValid = value =>
    !!(value && typeof value === 'object' && value.groups && typeof value.groups === 'object' && !Array.isArray(value.groups))
  const clone = value => structuredClone(value)
  const bestLocalData = () => {
    const candidates = [config.get('app.channels'), storage.get(NS, KEY, null)].filter(isValid)
    if (!candidates.length) return defaults()
    candidates.sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0))
    return clone(candidates[0])
  }
  const hasUserChannels = value =>
    isValid(value) && Object.values(value.groups).some(group => Array.isArray(group?.channels) && group.channels.length > 0)

  // 渠道数据既写入当前浏览器 localStorage，也通过 config 持久化到共享数据目录
  // 的 config.json preferences.app.channels，这样 exe 和 web 切换后渠道列表一致。
  let data = bestLocalData()
  data.activeKey = null
  storage.set(NS, KEY, data)

  let syncingFromConfig = false
  const publishToConfig = () => {
    if (!data?.updatedAt) return
    syncingFromConfig = true
    try {
      config.set('app.channels', clone(data))
    } finally {
      syncingFromConfig = false
    }
  }
  const persist = () => {
    data.updatedAt = Date.now()
    storage.set(NS, KEY, data)
    publishToConfig()
  }
  const publishLocal = () => {
    data.updatedAt = Date.now()
    storage.set(NS, KEY, data)
    publishToConfig()
  }
  const activeStillExists = (candidate, activeKey) => {
    const [tab, channelId] = String(activeKey || '').split(':')
    return !!channelId && !!candidate?.groups?.[tab]?.some(group => group.channels?.some(channel => channel.id === channelId))
  }
  const applyRemote = remote => {
    if (!isValid(remote)) return false
    const remoteAt = Number(remote.updatedAt) || 0
    const localAt = Number(data.updatedAt) || 0
    if (remoteAt < localAt) {
      // 本机修改更新：继续把本机数据发布到共享目录，别被旧的后端数据覆盖。
      publishLocal()
      return false
    }
    if (remoteAt === localAt) return false
    const previousActiveKey = data.activeKey
    data = clone(remote)
    data.activeKey = activeStillExists(data, previousActiveKey) ? previousActiveKey : null
    storage.set(NS, KEY, data)
    events.emit('channel:sync', { data })
    return true
  }

  const offConfig = config.watch('app.channels', value => {
    if (syncingFromConfig || !isValid(value)) return
    const remoteAt = Number(value.updatedAt) || 0
    const localAt = Number(data.updatedAt) || 0
    if (remoteAt < localAt) {
      publishLocal()
      return
    }
    if (remoteAt > localAt) applyRemote(value)
  })
  const offRemoteSynced = ctx.on('config:remote-synced', ({ remote } = {}) => {
    const remoteChannels = remote?.app?.channels
    if (isValid(remoteChannels)) {
      applyRemote(remoteChannels)
      return
    }
    // 后端从未保存过渠道：把本机已有的用户渠道迁移发布一次，
    // 默认空渠道不发布，避免新浏览器首次启动用空数据覆盖共享渠道。
    if (data.updatedAt || hasUserChannels(data)) publishLocal()
  })
  ctx.effect(() => {
    offConfig()
    offRemoteSynced()
  })

  const types = new Map()
  const nextGroupId = () => `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
  const nextChannelId = () => `ch${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`

  const service = {
    name: 'channel-registry',
    tabs: () => [...TABS],

    /** 旧的“未实现类型”扩展点：占位条目已移除，固定返回空列表。 */
    plannedList: () => [],

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
      // 分组里的渠道会一并移除：逐个广播，渠道插件才能注销后端连接、
      // 清理二维码长轮询等资源，避免留下孤儿连接。
      for (const channel of group.channels || []) events.emit('channel:removed', { tab, channel, groupId: group.id })
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
      // 渠道权限（跨渠道读取 / 发送 / 敏感确认）是角色级策略：通知权限服务
      // 同步到该角色已有的其它渠道，避免“渠道详情全开、设置页却全关”。
      if (partial.meta && Object.prototype.hasOwnProperty.call(partial.meta, 'permissions')) {
        events.emit('channel:permissions-changed', { tab, channel, reason: 'add' })
      }
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
      const permissionsBefore = JSON.stringify(channel.meta?.permissions || null)
      Object.assign(channel, patch)
      persist()
      const permissionsChanged =
        !!patch?.meta &&
        Object.prototype.hasOwnProperty.call(patch.meta, 'permissions') &&
        JSON.stringify(channel.meta?.permissions || null) !== permissionsBefore
      // 先发权限变化事件，让 chat-permissions 把角色级策略同步到其它渠道。
      if (permissionsChanged) events.emit('channel:permissions-changed', { tab, channel, reason: 'update' })
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
