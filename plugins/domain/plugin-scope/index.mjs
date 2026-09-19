/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * D7+ · plugin-scope
 * 外部插件的「角色 / 渠道启用范围」中心。
 *
 * 每个外部插件一份配置：
 *   default: 'all' | 'none'   未单独设置的角色 / 渠道按此默认执行
 *   roles:    { [roleId]: true|false }    角色级覆盖
 *   channels: { [channelId]: true|false } 渠道级覆盖（优先级高于角色级）
 *
 * 解析顺序：渠道覆盖 > 角色覆盖 > 插件默认。
 * 没有配置条目的插件视为「未限制」，保持旧版行为（默认启用）。
 */
export const name = 'plugin-scope'
export const version = '1.0.1'
export const displayName = '插件启用范围'
export const description = '业务服务 · 按角色 / 渠道统一管理外部插件的启用范围。'
export const author = '念风内核'
export const icon = '🎛️'
export const core = true
export const depends = {
  'config': '^1.0.0',
  'event-bus': '*',
  'session-service': '^2.0.0',
  'channel-registry': '^1.0.0',
}
export const optionalDepends = {}
export const inject = ['config', 'event-bus', 'session-service', 'channel-registry']
export const provides = [{ name: 'plugin-scope', type: 'singleton' }]

const KEY = 'plugin.scope'
const INIT_KEY = 'plugin.scopeInitialized'
const KNOWN_KEY = 'plugin.scopeKnownIds'

const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value)
const asText = value => String(value ?? '').trim()
const normalizeId = value => asText(value).replace(/^plugin:/, '')
const normalizeMode = value => (value === 'none' ? 'none' : 'all')

/** 把一条配置收敛成固定结构，兼容手工改坏 / 旧格式。 */
const normalizeEntry = entry => ({
  default: normalizeMode(entry?.default),
  roles: isObject(entry?.roles) ? { ...entry.roles } : {},
  channels: isObject(entry?.channels) ? { ...entry.channels } : {},
})

const hasKey = (object, key) => Object.prototype.hasOwnProperty.call(object || {}, key)

export function apply(ctx) {
  const config = ctx.inject('config')
  const events = ctx.inject('event-bus')
  const sessions = ctx.inject('session-service')
  const channels = ctx.inject('channel-registry')

  const readAll = () => {
    const raw = config.get(KEY, {})
    return isObject(raw) ? raw : {}
  }
  const writeAll = all => {
    // 不用在这里额外 emit：config.set 会广播 config:changed，下面的监听统一转发
    // 成 plugin-scope:changed；避免本地改动触发两次重绘。
    config.set(KEY, all)
  }
  const entryOf = id => {
    const all = readAll()
    return isObject(all[id]) ? all[id] : null
  }

  /** 遍历渠道注册表，返回带 tab / 分组信息的扁平静态快照。 */
  const listChannels = () => {
    const out = []
    for (const tab of channels.tabs()) {
      for (const group of channels.groups(tab)) {
        for (const channel of group.channels || []) {
          if (!channel?.id) continue
          out.push({
            id: String(channel.id),
            name: channel.name || channel.id,
            type: channel.type || '',
            status: channel.status || 'offline',
            tab,
            groupName: group.name || '',
            meta: channel.meta || {},
          })
        }
      }
    }
    return out
  }

  const findChannelById = value => {
    const wanted = asText(value)
    if (!wanted) return null
    return listChannels().find(channel => channel.id === wanted || wanted.endsWith(`:${channel.id}`)) || null
  }

  const findChannelByConversation = conversationId => {
    const wanted = asText(conversationId)
    if (!wanted) return null
    return listChannels().find(channel => asText(channel.meta?.conversationId) === wanted) || null
  }

  const channelIdFromStable = value => {
    const text = asText(value)
    if (!text || text.startsWith('nova:web:')) return ''
    const found = findChannelById(text)
    if (found) return found.id
    const separator = text.indexOf(':')
    return separator >= 0 ? text.slice(separator + 1) : text
  }

  /** 从工具 / 消息 / 渠道通知上下文解析出统一的 roleId / channelId。 */
  const resolveContext = (context = {}) => {
    const conversationId = asText(context?.conversationId)
    const conv = conversationId ? sessions.get(conversationId) : null
    let roleId = asText(context?.roleId)
    if (!roleId && conv) roleId = asText(conv.meta?.roleId || conv.id)

    let channel = null
    if (context?.channelId) channel = findChannelById(context.channelId)
    if (!channel && conversationId) channel = findChannelByConversation(conversationId)
    if (!channel && conv) {
      const stable = channelIdFromStable(conv.meta?.channelId)
      if (stable) channel = findChannelById(stable)
    }
    const channelId = channel?.id || channelIdFromStable(context?.channelId) || ''
    // 渠道通知通常只带 channelId；这里补出它绑定的角色，否则“只开启了小风角色”
    // 的配置会在投递通知时因为 context.roleId 为空而被误判成默认策略。
    if (!roleId && channel?.meta?.roleId) roleId = asText(channel.meta.roleId)
    if (!roleId && channelId) {
      const fallback = findChannelById(channelId)
      if (fallback?.meta?.roleId) roleId = asText(fallback.meta.roleId)
    }
    return { roleId: normalizeId(roleId), channelId }
  }

  const service = {
    name: 'plugin-scope',

    /** 是否已经有这个插件的范围配置。没有配置条的按旧行为默认启用。 */
    has: pluginId => !!entryOf(normalizeId(pluginId)),

    /** 读取规范化配置；没有时返回 null，调用方可用 `default: 'all'` 兜底展示。 */
    get(pluginId) {
      const id = normalizeId(pluginId)
      const entry = entryOf(id)
      return entry ? normalizeEntry(entry) : null
    },

    /** 修改“未单独设置时”的默认策略。 */
    setDefault(pluginId, mode) {
      const id = normalizeId(pluginId)
      if (!id) return null
      const all = readAll()
      const entry = isObject(all[id]) ? { ...all[id] } : {}
      entry.default = normalizeMode(mode)
      entry.roles = isObject(entry.roles) ? { ...entry.roles } : {}
      entry.channels = isObject(entry.channels) ? { ...entry.channels } : {}
      all[id] = entry
      writeAll(all)
      return normalizeEntry(entry)
    },

    /** mode: 'inherit' | 'all' | 'none' */
    setRole(pluginId, roleId, mode) {
      const id = normalizeId(pluginId)
      const key = asText(roleId)
      if (!id || !key) return null
      const all = readAll()
      const entry = isObject(all[id]) ? { ...all[id] } : {}
      entry.default = normalizeMode(entry.default)
      entry.roles = isObject(entry.roles) ? { ...entry.roles } : {}
      entry.channels = isObject(entry.channels) ? { ...entry.channels } : {}
      if (mode === 'inherit') delete entry.roles[key]
      else entry.roles[key] = mode === 'all'
      all[id] = entry
      writeAll(all)
      return normalizeEntry(entry)
    },

    /** mode: 'inherit' | 'all' | 'none' */
    setChannel(pluginId, channelId, mode) {
      const id = normalizeId(pluginId)
      const key = asText(channelId)
      if (!id || !key) return null
      const all = readAll()
      const entry = isObject(all[id]) ? { ...all[id] } : {}
      entry.default = normalizeMode(entry.default)
      entry.roles = isObject(entry.roles) ? { ...entry.roles } : {}
      entry.channels = isObject(entry.channels) ? { ...entry.channels } : {}
      if (mode === 'inherit') delete entry.channels[key]
      else entry.channels[key] = mode === 'all'
      all[id] = entry
      writeAll(all)
      return normalizeEntry(entry)
    },

    /** 清掉某个插件的全部角色 / 渠道覆盖，恢复“默认启用、不限制”。 */
    reset(pluginId) {
      const id = normalizeId(pluginId)
      if (!id) return null
      const all = readAll()
      all[id] = { default: 'all', roles: {}, channels: {} }
      writeAll(all)
      return normalizeEntry(all[id])
    },

    /** 确保配置条目存在；已存在时不覆盖用户设置。 */
    ensure(pluginId, defaultMode = 'all') {
      const id = normalizeId(pluginId)
      if (!id) return { created: false, entry: null }
      const all = readAll()
      if (isObject(all[id])) return { created: false, entry: normalizeEntry(all[id]) }
      all[id] = { default: normalizeMode(defaultMode), roles: {}, channels: {} }
      writeAll(all)
      return { created: true, entry: normalizeEntry(all[id]) }
    },

    /**
     * 核心判定：外部插件在某个角色 / 渠道下是否启用。
     * - 没有插件条目：true（兼容旧插件和未初始化插件）；
     * - 渠道有显式配置：优先渠道；
     * - 角色有显式配置：其次角色；
     * - 最后看插件默认策略。
     */
    allows(pluginId, context = {}) {
      const id = normalizeId(pluginId)
      if (!id) return true
      const raw = entryOf(id)
      if (!raw) return true
      const entry = normalizeEntry(raw)
      const target = resolveContext(context)
      if (target.channelId && hasKey(entry.channels, target.channelId)) {
        return entry.channels[target.channelId] !== false
      }
      if (target.roleId && hasKey(entry.roles, target.roleId)) {
        return entry.roles[target.roleId] !== false
      }
      return entry.default !== 'none'
    },

    /** 对外暴露当前上下文解析结果，便于插件统一日志 / 排错。 */
    resolve: resolveContext,

    /** 给「插件启用」设置页使用的角色 → 渠道树。 */
    roleTree() {
      const roleMap = new Map()
      const roleOrder = []
      const addRole = (id, name, avatar, missing = false) => {
        const key = asText(id)
        if (!key) return null
        let item = roleMap.get(key)
        if (!item) {
          item = { id: key, name: asText(name) || key, avatar: asText(avatar), missing: !!missing, channels: [] }
          roleMap.set(key, item)
          roleOrder.push(item)
        } else if (item.missing && !missing) {
          item.name = asText(name) || item.name
          item.avatar = asText(avatar) || item.avatar
          item.missing = false
        }
        return item
      }

      for (const conv of sessions.list() || []) {
        if (!conv?.id) continue
        if (conv.meta?.channelConversation === true || conv.meta?.hiddenFromSessionList === true) continue
        const channelId = asText(conv.meta?.channelId)
        if (channelId && !channelId.startsWith('nova:web:')) continue
        addRole(conv.id, conv.name || conv.id, conv.avatar, false)
      }

      const unboundChannels = []
      for (const channel of listChannels()) {
        const roleId = asText(channel.meta?.roleId)
        const item = {
          id: channel.id,
          name: channel.name || channel.id,
          type: channel.type || '',
          status: channel.status || 'offline',
          tab: channel.tab,
          groupName: channel.groupName || '',
          roleId,
        }
        if (!roleId) {
          unboundChannels.push(item)
          continue
        }
        const role = addRole(roleId, `角色 ${roleId}`, '?', true)
        role?.channels.push(item)
      }

      const byName = (a, b) => String(a.name).localeCompare(String(b.name), 'zh-Hans-CN')
      return {
        roles: roleOrder
          .map(role => ({ ...role, channels: role.channels.slice().sort(byName) }))
          .sort(byName),
        unboundChannels: unboundChannels.sort(byName),
      }
    },
  }

  ctx.provide('plugin-scope', service, { type: 'singleton' })

  /**
   * 老用户升级：第一次启动时把当前所有外部插件写成“默认全体启用”，
   * 避免弹出十几个选择框；之后新增的插件才会走“添加时选择一次”。
   */
  let migrateAttempts = 0
  const migrateExistingPlugins = () => {
    // 用 plugin-loader 而不是 plugin-manager：后者是 WebUI-only，
    // 服务端代聊 Worker 里拿不到，但配置需要两边都保持同一份默认值。
    const loader = ctx.registry.get('plugin-loader')
    const records = loader?.list?.()
    if (!Array.isArray(records)) {
      if (migrateAttempts++ < 30) ctx.setTimeout(migrateExistingPlugins, 500)
      return
    }

    const initialized = config.get(INIT_KEY, false) === true
    const knownRaw = config.get(KNOWN_KEY, [])
    const known = new Set((Array.isArray(knownRaw) ? knownRaw : []).map(normalizeId).filter(Boolean))
    const all = readAll()
    let scopeChanged = false
    let knownChanged = false

    for (const record of records) {
      const manifest = record?.manifest || {}
      if (!(manifest.external || record?.external) || manifest.core || manifest.removed) continue
      const id = normalizeId(record.id || manifest.id)
      if (!id) continue
      if (!known.has(id)) {
        known.add(id)
        knownChanged = true
        // 首次接入该功能：把当前已装插件统一当“历史插件”，默认全体启用，避免大批弹窗。
        // 之后新增的插件故意不写入 scope，留给「插件启用」页面 / 安装弹窗选择一次。
        if (!initialized && !isObject(all[id])) {
          all[id] = { default: 'all', roles: {}, channels: {} }
          scopeChanged = true
        }
      }
    }

    if (!initialized) config.set(INIT_KEY, true)
    if (knownChanged) config.set(KNOWN_KEY, [...known])
    if (scopeChanged) writeAll(all)
    ctx.logger.debug(`插件启用范围已扫描（外部插件 ${Object.keys(all).length} 个，已知 ${known.size} 个）`)
  }
  ctx.setTimeout(migrateExistingPlugins, 800)

  ctx.effect(
    ctx.on('config:changed', payload => {
      const key = asText(payload?.key)
      if (key === '*' || key === KEY) events.emit('plugin-scope:changed', { fromConfig: true, at: Date.now() })
    }),
  )

  ctx.logger.debug('插件启用范围服务就绪')
}
