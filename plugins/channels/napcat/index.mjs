/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 *
 * NapCatQQ 渠道插件（OneBot 11）。
 *
 *  - 安装后「渠道 → 添加渠道」出现「NapCat」；
 *  - 支持私聊 / 群聊 / 隐私三类。私聊与隐私填写目标 QQ 号，群聊填写群号；
 *  - 同一个 NapCat 登录 QQ 只需要建立一条连接，多个渠道可以复用；
 *  - QQ 名、QQ 号、群号、群昵称、实际昵称都会写入消息身份与上下文；
 *  - 群聊支持黑名单 / 仅艾特 / 回复概率 / 引用回复 / 艾特触发者 / 静默上下文；
 *  - 长消息 / 资料消息自动折叠成 QQ 合并转发（聊天记录），转发里第一条是标题、其后是正文；
 *    阈值见 chat.forwardThreshold / chat.forwardNodeChars / chat.forwardMaxNodes；
 *  - 通过 napcat:* 事件、napcat-channel 服务和 /api/napcat/* 路由给其它插件扩展。
 */
import { useStyle } from '../../../src/util/style.mjs'
import { escapeHtml } from '../../../src/util/format.mjs'
import { resolveUserNickname } from '../../../src/util/identity.mjs'
import { describeIncomingMessage } from '../../../src/util/message-log.mjs'
import { NAPCAT_CSS } from './style.mjs'
import { createOutboundPlanner } from './outbound.mjs'

export const name = 'napcat'
export const version = '1.0.2'
export const displayName = 'NapCat'
export const description = '渠道插件 · NapCatQQ / OneBot 11：私聊、群聊、隐私、连接复用与群聊规则。'
export const author = '念风插件'
export const icon = '🐱'
export const core = false
export const depends = {
  'channel-base': '^1.0.0',
  'channel-detail-host': '^3.0.0',
  'channel-list': '^1.0.0',
  'channel-registry': '>=1.0.0',
  'config': '>=1.1.0',
  'event-bus': '*',
  'session-service': '^2.0.0',
  'toast-host': '>=1.0.0',
}
export const optionalDepends = {
  'backend-client': '>=1.0.0',
  'chat-store': '>=1.0.0',
  'message-service': '>=1.0.0',
  'plugin-manager': '>=1.0.0',
}
export const inject = [
  'channel-base',
  'channel-registry',
  'session-service',
  'event-bus',
  'toast',
  'config',
  'api?',
  'message-service?',
  'chat-store?',
  'plugin-manager?',
]
export const provides = [{ name: 'napcat-channel', type: 'singleton' }]
export const permissions = ['network']

const TYPE_ID = 'napcat'
const TYPE_COLOR = '#0099ff'
const TYPE_ICON = '🐱'
const TAB_LABELS = { private: '私聊', group: '群聊', privacy: '隐私' }
const TAB_ORDER = ['private', 'group', 'privacy']
const SESSION_LABEL = { private: 'QQ私聊', group: 'QQ群聊' }
const GROUP_CONTEXT_MESSAGES = 20
const DEFAULT_PERMISSIONS = {
  read: true,
  reply: true,
  context: true,
  crossRead: false,
  crossSend: false,
  confirm: true,
}
const PERMISSION_META = [
  ['read', '接收消息', '把 NapCat 消息写入角色上下文'],
  ['reply', '自动回复', '助手消息生成后立即外发到 QQ'],
  ['context', '参与工作记忆', '私聊消息参与角色级工作记忆；群聊 / 隐私固定只用自己的记录'],
  ['crossRead', '跨渠道读取', '允许该角色的模型读取其它渠道记录'],
  ['crossSend', '跨渠道发送', '允许该角色的模型向其它渠道发送消息'],
  ['confirm', '敏感操作确认', '跨渠道等敏感操作需要二次确认'],
]
/** 按渠道分类决定哪些权限真正有意义，避免把无关选项全堆给用户。 */
const PERMISSION_SCOPES = {
  read: ['private', 'group', 'privacy'],
  reply: ['private', 'group', 'privacy'],
  context: ['private'],
  crossRead: ['private', 'group'],
  crossSend: ['private', 'group'],
  confirm: ['private', 'group'],
}
const permissionMetaFor = category => PERMISSION_META.filter(([key]) => (PERMISSION_SCOPES[key] || ['private', 'group', 'privacy']).includes(category))
const CATEGORY_HELP = {
  private: '私聊：目标 QQ 的消息进入所选角色的角色级工作记忆，可参与跨渠道协作。',
  group: '群聊：只使用本群最近若干条消息作为上下文；使用独立的群聊触发与回复规则。',
  privacy: '隐私：独立单会话，不与其它渠道互读 / 互发；适合不希望消息进入角色工作记忆的用途。',
}
const DEFAULT_GROUP_RULES = {
  blacklist: [],
  whitelist: [],
  whitelistForAt: false,
  whitelistForProbability: false,
  requireAt: true,
  replyProbability: 50,
  quote: true,
  mention: true,
  silentContext: true,
  // 0 = 继承 通用 → 群聊上下文条数（chat.groupMessages，默认 20）；>0 = 本群单独覆盖。
  contextMessages: 0,
  // 旧字段仅用于兼容：读取时若 contextMessages 未设置，会把旧值迁移为条数。
  contextRounds: 0,
}
const STATUS_LABEL = {
  online: '已连接',
  connecting: '连接中',
  waiting: '等待 NapCat 连接',
  offline: '未连接',
  error: '异常',
}
const STATUS_COLOR = {
  online: '#70a15a',
  connecting: '#c9a227',
  waiting: '#c9a227',
  offline: '#b3b9c2',
  error: '#c65b5b',
}

/**
 * 判断一条入站消息是否属于“连接建立前的历史积压”：
 *   - connectedAt 是 NapCat 后端桥本次连接进入 online 的时间（毫秒）；
 *   - receivedAt 是 NapCat 桥收到消息的时间戳（毫秒，本地时钟）；
 *   - time 是消息本身的发送时间（ISO 字符串，可能来自 QQ 服务器）。
 *
 * 优先以 connectedAt 为基准：连接建立后、只是前端 WebUI 重启期间漏收的消息
 * 仍属于实时消息，应当补写并触发回复；只有连接建立前就已经存在的历史消息才
 * 静默写入上下文，避免“重开程序/重连后把历史消息全部回一遍”。
 * 没有 connectedAt 的旧后端数据回退到 sessionStartedAt 判断。
 * napcat.replyBacklog = true 可恢复旧行为（积压也回复）。
 */
export function isBacklogMessage(message, { sessionStartedAt = 0, graceMs = 15000, replyBacklog = false, connectedAt = 0 } = {}) {
  if (replyBacklog) return false
  const receivedAt = Number(message?.receivedAt) || 0
  const sentAt = Date.parse(message?.time || '') || 0
  const messageConnectedAt = Number(message?.connectedAt) || 0
  const referenceAt =
    (Number(connectedAt) > 0 ? Number(connectedAt) : 0) || (messageConnectedAt > 0 ? messageConnectedAt : 0) || Number(sessionStartedAt) || 0
  if (!referenceAt) return false
  const cutoff = referenceAt - Math.max(0, Number(graceMs) || 0)
  return (receivedAt > 0 && receivedAt < cutoff) || (sentAt > 0 && sentAt < cutoff)
}

export function apply(ctx) {
  const base = ctx.inject('channel-base')
  const channels = ctx.inject('channel-registry')
  const sessions = ctx.inject('session-service')
  const events = ctx.inject('event-bus')
  const toast = ctx.inject('toast')
  const config = ctx.inject('config')
  const api = ctx.inject('api?')
  const messages = ctx.inject('message-service?')
  const store = ctx.inject('chat-store?')

  useStyle(ctx, NAPCAT_CSS)

  /** conversationId -> resolve，等 chat-flow 整轮完成 */
  const pendingTurns = new Map()
  /** conversationId -> 本轮入站上下文（外发时用于引用 / 艾特 / 目标解析） */
  const activeTurns = new Map()
  /** conversationId -> 串行 Promise，保证同一渠道消息按顺序处理 */
  const busyChains = new Map()
  /** channelId -> Set(messageId)，页面内去重（SSE 与 inbox 可能同时到达） */
  const handledInbound = new Map()
  /** 后端实例缓存 */
  let instances = []
  const instanceWaiters = new Set()
  const closing = []
  let backendEvents = null
  /** 启动流程结束后才允许在 SSE 重连时主动补收件箱，避免和会话同步竞争。 */
  let bootFinished = false
  let pendingOpenDrain = false
  /** SSE 静默失效时的兜底轮询：定时补收后端 inbox，避免消息永远躺在收件箱里。 */
  let inboxPollTimer = null
  /**
   * 本次前端启动时间：只作为旧后端（消息里没有 connectedAt）的兜底基准。
   * 新后端会把 NapCat 连接进入 online 的时间随消息一起传下来，这样“连接后、
   * 前端 WebUI 重启期间漏收的消息”不会被误判成历史积压。
   * 如确需回复连接建立前的积压消息，可把 napcat.replyBacklog 设为 true。
   */
  const sessionStartedAt = Date.now()
  // 连接切换 / 心跳抖动通常只有几秒到一两分钟；宽限设大一些，避免把刚收到
  // 的实时消息误判成积压。真正几小时前的历史消息仍会被静默写入上下文。
  const BACKLOG_GRACE_MS = 2 * 60 * 1000
  const replyBacklogEnabled = () => config.get('napcat.replyBacklog', false) === true
  const backlogOf = message => isBacklogMessage(message, { sessionStartedAt, graceMs: BACKLOG_GRACE_MS, replyBacklog: replyBacklogEnabled() })

  /* ---------------- 基础工具 ---------------- */

  const findChannel = channelId => {
    for (const tab of channels.tabs()) {
      const channel = channels.findChannel(tab, channelId)
      if (channel) return channel
    }
    return null
  }
  const findTab = channelId => channels.tabs().find(tab => channels.findChannel(tab, channelId)) || 'private'
  const channelKey = channelId => `${TYPE_ID}:${channelId}`
  const isNapcatChannel = channel => channel?.type === TYPE_ID
  const permissionsOf = channel => ({ ...DEFAULT_PERMISSIONS, ...(channel?.meta?.permissions || {}) })
  const categoryOf = channel => {
    const category = channel?.meta?.category
    return TAB_ORDER.includes(category) ? category : 'private'
  }
  const targetTypeOf = channel => (channel?.meta?.targetType === 'group' || categoryOf(channel) === 'group' ? 'group' : 'private')
  const targetIdOf = channel => String(channel?.meta?.targetId || '').trim()
  const instanceIdOf = channel => String(channel?.meta?.instanceId || '').trim()
  const groupRulesOf = channel => {
    const rules = { ...DEFAULT_GROUP_RULES, ...(channel?.meta?.rules || {}) }
    // 兼容旧版按“轮”保存的群规则：只有新字段没配时才沿用旧值。
    if (!(Number(rules.contextMessages) > 0) && Number(rules.contextRounds) > 0) {
      rules.contextMessages = Number(rules.contextRounds)
    }
    return rules
  }
  const clampGroupMessages = (value, fallback = GROUP_CONTEXT_MESSAGES) => {
    const n = Math.floor(Number(value))
    if (!Number.isFinite(n) || n <= 0) return Math.max(1, Math.min(1000, Math.floor(Number(fallback) || GROUP_CONTEXT_MESSAGES)))
    return Math.max(1, Math.min(1000, n))
  }
  const globalGroupMessages = () => clampGroupMessages(config.get('chat.groupMessages', GROUP_CONTEXT_MESSAGES), GROUP_CONTEXT_MESSAGES)
  /** 群聊上下文条数：群规则里 contextMessages > 0 时本群覆盖，否则跟随全局设置。 */
  const groupContextMessagesOf = channel => {
    const override = Math.floor(Number(groupRulesOf(channel).contextMessages))
    return Number.isFinite(override) && override > 0 ? clampGroupMessages(override) : globalGroupMessages()
  }
  const roleOf = channel => sessions.get(channel?.meta?.roleId) || null
  const maskId = value => {
    const text = String(value || '')
    return text.length > 10 ? `${text.slice(0, 4)}…${text.slice(-4)}` : text
  }
  const statusColor = status => STATUS_COLOR[status] || STATUS_COLOR.offline
  const mapInstanceStatus = status => {
    if (status === 'online') return 'online'
    if (status === 'connecting') return 'connecting'
    if (status === 'waiting') return 'connecting'
    if (status === 'error') return 'error'
    return 'offline'
  }
  const findInstance = instanceId => instances.find(item => String(item.id) === String(instanceId || '')) || null

  const isRoleConversation = conv => {
    const meta = conv?.meta || {}
    if (meta.channelConversation === true || meta.hiddenFromSessionList === true) return false
    const channelType = String(meta.channelType || '')
    const channelId = String(meta.channelId || '')
    if (!channelType && !channelId) return true
    if (channelType && channelType !== 'nova') return false
    if (channelId && !channelId.startsWith('nova:web:')) return false
    return true
  }

  const roleOptions = (selectedId = '') => {
    const list = sessions.list().filter(isRoleConversation)
    if (selectedId && !list.some(conv => conv.id === selectedId)) {
      const selected = sessions.get(selectedId)
      if (selected) list.unshift(selected)
    }
    return list
      .map(conv => `<option value="${escapeHtml(conv.id)}" ${conv.id === selectedId ? 'selected' : ''}>${escapeHtml(conv.name || conv.id)}</option>`)
      .join('')
  }

  const channelIdentity = channel => {
    const shared = ctx.registry.get('user-identity')?.get?.() || {}
    const fallbackUserId = String(shared.userId || config.get('chat.userId', 'web-user') || 'web-user').trim() || 'web-user'
    const fallbackUserName = String(shared.userName || resolveUserNickname(config)).trim() || resolveUserNickname(config)
    return {
      userId: String(channel?.meta?.identity?.userId || '').trim() || fallbackUserId,
      userName: String(channel?.meta?.identity?.userName || '').trim() || fallbackUserName,
    }
  }

  const bridgeGet = (path, options) => (api ? api.get(`/napcat${path}`, options) : Promise.reject(new Error('本地后端未连接')))
  const bridgePost = (path, body, options) => (api ? api.post(`/napcat${path}`, body, options) : Promise.reject(new Error('本地后端未连接')))
  const bridgeDel = (path, options) => {
    if (!api) return Promise.reject(new Error('本地后端未连接'))
    const request = typeof api.del === 'function' ? api.del.bind(api) : api.delete?.bind(api)
    return request ? request(`/napcat${path}`, options) : Promise.reject(new Error('当前后端连接不支持 DELETE 请求'))
  }

  /* ---------------- 实例缓存 ---------------- */

  function notifyInstances() {
    for (const waiter of [...instanceWaiters]) {
      try {
        waiter(instances)
      } catch (_) {
        /* ignore */
      }
      instanceWaiters.delete(waiter)
    }
  }

  async function refreshInstances({ notify = true } = {}) {
    if (!api) return []
    try {
      const data = await bridgeGet('/instances')
      instances = Array.isArray(data?.instances) ? data.instances : []
    } catch (_) {
      /* 后端没就绪时保留旧缓存 */
    }
    if (notify) notifyInstances()
    return instances
  }

  function waitInstances(timeout = 2600) {
    if (instances.length) return Promise.resolve(instances)
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        instanceWaiters.delete(waiter)
        resolve(instances)
      }, timeout)
      const waiter = list => {
        clearTimeout(timer)
        resolve(list)
      }
      instanceWaiters.add(waiter)
    })
  }

  function applyInstanceToChannels(instance) {
    if (!instance?.id) return
    let changed = false
    for (const tab of channels.tabs()) {
      for (const channel of channels.channels(tab)) {
        if (!isNapcatChannel(channel) || instanceIdOf(channel) !== String(instance.id)) continue
        const status = mapInstanceStatus(instance.status)
        const nextMeta = {
          ...(channel.meta || {}),
          napcatStatus: instance.status,
          napcatError: instance.error || '',
          napcatLoginId: instance.login?.userId || '',
          napcatLoginName: instance.login?.nickname || '',
          napcatVersion: instance.versionInfo || '',
          napcatInstanceRemark: instance.remark || '',
        }
        const unchanged =
          channel.status === status &&
          (channel.meta?.napcatStatus || '') === nextMeta.napcatStatus &&
          (channel.meta?.napcatError || '') === nextMeta.napcatError &&
          (channel.meta?.napcatLoginId || '') === nextMeta.napcatLoginId &&
          (channel.meta?.napcatLoginName || '') === nextMeta.napcatLoginName &&
          (channel.meta?.napcatInstanceRemark || '') === nextMeta.napcatInstanceRemark
        if (unchanged) continue
        channels.updateChannel(findTab(channel.id), channel.id, { status, meta: nextMeta })
        changed = true
      }
    }
    if (changed) events.emit('napcat:changed', {})
  }

  function applyInstancesToChannels(list = []) {
    for (const instance of list || []) applyInstanceToChannels(instance)
  }

  async function refreshChannelStatus(channel) {
    if (!api || !isNapcatChannel(channel)) return null
    try {
      const data = await bridgeGet(`/status?channelId=${encodeURIComponent(channel.id)}`)
      if (data?.status) {
        const local = findInstance(data.status.id) ? null : data.status
        if (local?.id && !findInstance(local.id)) instances.push(local)
        applyInstanceToChannels(data.status)
        events.emit('napcat:changed', {})
      }
      return data
    } catch (_) {
      return null
    }
  }

  /* ---------------- 渠道会话容器 ---------------- */

  function targetDisplayName(channel) {
    const type = targetTypeOf(channel)
    const id = targetIdOf(channel)
    const alias = String(channel?.meta?.targetName || '').trim()
    if (alias) return alias
    return type === 'group' ? `群 ${id}` : `QQ ${id}`
  }

  function bindingSummary(channel) {
    const instance = findInstance(instanceIdOf(channel))
    const account = instance?.login?.userId ? `${instance.login.nickname || instance.login.userId}（${instance.login.userId}）` : '未连接'
    return `${SESSION_LABEL[targetTypeOf(channel)] || 'QQ'} · ${targetDisplayName(channel)} · 机器人 ${account}`
  }

  function ensureConversation(channel) {
    if (!isNapcatChannel(channel)) return null
    const role = roleOf(channel)
    const roleId = channel.meta?.roleId || role?.meta?.roleId || role?.id || channel.id
    const category = categoryOf(channel)
    const permissions = permissionsOf(channel)
    const identity = channelIdentity(channel)
    const targetType = targetTypeOf(channel)
    const instance = findInstance(instanceIdOf(channel))
    const stableChannelId = channelKey(channel.id)
    // 先按稳定 channelId 找已有容器（历史竞态可能产生多个，取消息最多的规范容器）。
    let conv = typeof sessions.findByChannelId === 'function' ? sessions.findByChannelId(stableChannelId) : null
    if (!conv) conv = sessions.get(channel.meta?.conversationId)
    // 首次后端同步结束前不要创建：否则每次启动都会新建空容器，旧记录被落在另一个 conv.id 下。
    if (
      !conv &&
      typeof sessions.ready === 'function' &&
      typeof sessions.isInitialSyncSettled === 'function' &&
      sessions.isInitialSyncSettled() === false
    ) {
      sessions.ready().then(() => {
        try {
          ensureConversation(channel)
        } catch (_) {
          /* ignore */
        }
      }).catch(() => {})
      return null
    }
    const label = targetDisplayName(channel)
    const metaPatch = {
      channelId: channelKey(channel.id),
      channelType: TYPE_ID,
      channelGroup: category,
      source: TYPE_ID,
      roleId,
      napcatChannelId: channel.id,
      napcatInstanceId: instanceIdOf(channel),
      napcatTargetType: targetType,
      napcatTargetId: targetIdOf(channel),
      napcatTargetName: label,
      hiddenFromSessionList: true,
      channelConversation: true,
      identityUserId: identity.userId,
      identityUserName: identity.userName,
      participatesWorkingMemory: category === 'private' && permissions.context !== false,
      crossReadable: permissions.crossRead === true,
      crossSendable: permissions.crossSend === true,
      sensitiveConfirm: permissions.confirm !== false,
      // 群聊上下文：只保留本群记录，条数可在群规则 / 通用设置里配置；私聊分类继续参与角色工作记忆。
      contextMode: category === 'group' ? 'channel-only' : '',
      contextRounds: 0,
      contextMessages: category === 'group' ? groupContextMessagesOf(channel) : 0,
      napcatBotUserId: instance?.login?.userId || '',
      napcatBotName: instance?.login?.nickname || '',
      persona: role?.meta?.persona ?? conv?.meta?.persona ?? '',
      model: role?.meta?.model ?? conv?.meta?.model ?? '',
      backupMode: role?.meta?.backupMode ?? conv?.meta?.backupMode ?? 'global',
      backupModels: role?.meta?.backupModels ?? conv?.meta?.backupModels ?? [],
      backupModel: role?.meta?.backupModel ?? conv?.meta?.backupModel ?? 'global',
      avatarImage: role?.meta?.avatarImage ?? conv?.meta?.avatarImage ?? '',
    }
    if (!conv) {
      conv = sessions.create({
        name: `${role?.name || '角色'} · ${SESSION_LABEL[targetType] || 'QQ'} · ${label}`,
        avatar: role?.avatar || (role?.name || 'N').slice(0, 1),
        c1: role?.c1,
        c2: role?.c2,
        preview: `${role?.name || '角色'} 的 NapCat 渠道 · ${bindingSummary(channel)}`,
        meta: metaPatch,
      })
      channels.updateChannel(findTab(channel.id), channel.id, {
        meta: { ...(channel.meta || {}), conversationId: conv.id },
      })
    } else {
      sessions.update(conv.id, {
        name: `${role?.name || '角色'} · ${SESSION_LABEL[targetType] || 'QQ'} · ${label}`,
        preview: `${role?.name || '角色'} 的 NapCat 渠道 · ${bindingSummary(channel)}`,
        meta: { ...(conv.meta || {}), ...metaPatch },
      })
    }
    // 历史重复容器修复后，把渠道配置指向规范容器，后续页面/代聊都不会再用旧空会话。
    if (String(channel.meta?.conversationId || '') !== String(conv.id)) {
      channels.updateChannel(findTab(channel.id), channel.id, {
        meta: { ...(channel.meta || {}), conversationId: conv.id },
      })
    }
    try {
      store?.channelForConversation?.(conv.id)
    } catch (_) {
      /* chat-store 未就绪时忽略 */
    }
    return conv
  }

  function pruneOrphanConversations() {
    const tabs = typeof channels.tabs === 'function' ? channels.tabs() : []
    const known = new Set()
    for (const tab of tabs) {
      for (const channel of channels.channels(tab)) {
        if (isNapcatChannel(channel)) known.add(String(channel.id || ''))
      }
    }
    for (const conv of sessions.list()) {
      if (conv?.meta?.channelType !== TYPE_ID) continue
      const owner = String(conv.meta.napcatChannelId || '')
      const rawKey = String(conv.meta.channelId || '')
      const keyed = rawKey.startsWith(`${TYPE_ID}:`) ? rawKey.slice(TYPE_ID.length + 1) : ''
      if (owner && known.has(owner)) continue
      if (!owner && keyed && known.has(keyed)) continue
      if (!owner && !keyed) continue
      sessions.remove(conv.id)
    }
  }

  /* ---------------- 渠道 <-> 后端同步 ---------------- */

  async function syncChannelToBridge(channel, { notify = false } = {}) {
    if (!api || !isNapcatChannel(channel)) return null
    if (!instanceIdOf(channel)) return null
    const meta = channel.meta || {}
    try {
      const data = await bridgePost('/channels/sync', {
        channelId: channel.id,
        channelName: channel.name || '',
        roleId: meta.roleId || '',
        instanceId: meta.instanceId,
        category: categoryOf(channel),
        targetType: targetTypeOf(channel),
        targetId: targetIdOf(channel),
        identityMode: meta.identityMode === 'guest' ? 'guest' : 'owner',
        rules: groupRulesOf(channel),
        permissions: permissionsOf(channel),
        trustedUserIds: Array.isArray(meta.trustedUserIds) ? meta.trustedUserIds : [],
      })
      if (data?.instance) {
        const index = instances.findIndex(item => item.id === data.instance.id)
        if (index >= 0) instances[index] = data.instance
        else instances.push(data.instance)
        applyInstanceToChannels(data.instance)
      }
      return data
    } catch (err) {
      if (notify) toast.error(`同步 NapCat 渠道失败：${err.message}`)
      return null
    }
  }

  async function removeChannelFromBridge(channelId) {
    if (!api) return
    try {
      await bridgePost('/channels/remove', { channelId })
    } catch (_) {
      /* 后端未就绪时忽略 */
    }
  }

  async function pruneBridgeChannels() {
    if (!api) return
    const ids = []
    for (const tab of channels.tabs()) {
      for (const channel of channels.channels(tab)) {
        if (isNapcatChannel(channel)) ids.push(channel.id)
      }
    }
    try {
      await bridgePost('/channels/prune', { channelIds: ids })
    } catch (_) {
      /* ignore */
    }
  }

  /* ---------------- SSE / 收件箱 ---------------- */

  function ensureBackendEvents() {
    if (backendEvents || !api || typeof EventSource === 'undefined') return
    try {
      const source = new EventSource(`${api.baseUrl()}/events`)
      const parse = event => {
        try {
          return event.data ? JSON.parse(event.data) : null
        } catch (_) {
          return null
        }
      }
      const forward = type => event => {
        const data = parse(event)
        if (type === 'napcat:message') {
          handleInbound(data).catch(err => ctx.logger?.warn?.(`[napcat] 处理入站失败：${err?.message || err}`))
        } else if (type === 'napcat:status') {
          if (data?.record) {
            const index = instances.findIndex(item => item.id === data.record.id)
            if (index >= 0) instances[index] = data.record
            else instances.push(data.record)
          }
          applyInstanceToChannels({
            id: data?.instanceId,
            status: data?.status,
            error: data?.error,
            login: data?.login,
            remark: data?.record?.remark,
            versionInfo: data?.record?.versionInfo,
          })
          events.emit('napcat:status', data || {})
        } else if (type === 'napcat:instances') {
          instances = Array.isArray(data?.instances) ? data.instances : []
          applyInstancesToChannels(instances)
          notifyInstances()
          events.emit('napcat:instances', data || {})
        } else if (type === 'napcat:discover') {
          events.emit('napcat:discover', data || {})
        } else if (type === 'napcat:notice') {
          events.emit('napcat:notice', data || {})
        } else if (type === 'napcat:request') {
          events.emit('napcat:request', data || {})
        } else if (type === 'napcat:recall') {
          events.emit('napcat:recall', data || {})
        }
      }
      for (const type of ['napcat:message', 'napcat:status', 'napcat:instances', 'napcat:discover', 'napcat:notice', 'napcat:request', 'napcat:recall']) {
        source.addEventListener(type, forward(type))
      }
      // EventSource 断开重连后，断线期间的消息只会留在后端 inbox 里，不会自动
      // 重放。这里在重连成功时主动补收一次，避免用户消息“后台收到了但前端没反应”。
      source.addEventListener('open', () => {
        if (!bootFinished) {
          pendingOpenDrain = true
          return
        }
        drainAllInboxes().catch(err => ctx.logger?.warn?.(`[napcat] 重连补收消息失败：${err?.message || err}`))
      })
      backendEvents = source
    } catch (_) {
      backendEvents = null
    }
  }

  async function drainInbox(channel) {
    if (!api) return
    try {
      const data = await bridgeGet(`/inbox?channelId=${encodeURIComponent(channel.id)}`)
      for (const item of data?.messages || []) await handleInbound({ channelId: channel.id, instanceId: data?.instanceId, message: item.message || item })
    } catch (_) {
      /* ignore */
    }
  }

  /** SSE 重连后补收所有 NapCat 渠道的 inbox；chat-flow 未就绪时留给 boot 首轮处理。 */
  async function drainAllInboxes() {
    if (!api || !ctx.registry.get('chat-flow')) return
    for (const tab of channels.tabs()) {
      for (const channel of channels.channels(tab)) {
        if (!isNapcatChannel(channel)) continue
        if (!instanceIdOf(channel)) continue
        await drainInbox(channel)
      }
    }
  }

  async function ackInbox(channelId, ids) {
    if (!api || !ids?.length) return
    try {
      await bridgePost('/inbox/ack', { channelId, ids })
    } catch (_) {
      /* ignore */
    }
  }

  /* ---------------- 身份与内容 ---------------- */

  const shortId = id => {
    const value = String(id || '')
    return value.length > 8 ? `…${value.slice(-6)}` : value
  }

  function senderDisplayName(message) {
    const qq = String(message.senderId || '')
    const nickname = String(message.senderNickname || '').trim()
    const card = String(message.senderCard || '').trim()
    if (message.messageType === 'group') {
      const parts = []
      if (message.groupId) parts.push(`群${message.groupId}`)
      if (card) parts.push(card)
      if (nickname && nickname !== card) parts.push(nickname)
      parts.push(`QQ${qq || '未知'}`)
      return parts.join(' · ')
    }
    return `${nickname || message.senderName || `QQ用户·${shortId(qq)}`}（QQ${qq || '未知'}）`
  }

  function senderIdentityFor(channel, message) {
    const identity = channelIdentity(channel)
    const display = senderDisplayName(message)
    if (message.messageType === 'group') {
      return {
        userId: qqUserId(message.senderId),
        userName: display,
      }
    }
    const mode = channel?.meta?.identityMode === 'guest' ? 'guest' : 'owner'
    if (mode === 'owner') return { userId: identity.userId, userName: display }
    return { userId: qqUserId(message.senderId), userName: display }
  }

  const qqUserId = userId => `qq:${String(userId || '').trim()}`

  /* ---------------- 外发内容组装（含合并转发） ---------------- */

  // 资料 / 超长消息 -> 合并转发（聊天记录）：第一条是标题，往下是正文。
  // 阈值与节点上限见 chat.forwardThreshold / chat.forwardNodeChars / chat.forwardMaxNodes。
  const outbound = createOutboundPlanner({
    config,
    resolveDocument: docId => ctx.registry.get('document-service')?.get?.(docId) || null,
  })
  const buildOutboundContent = message => outbound.buildOutboundContent(message)

  function triggerDecision(channel, message) {
    const category = categoryOf(channel)
    const rules = groupRulesOf(channel)
    const senderId = String(message.senderId || '').trim()
    const blacklist = rules.blacklist.map(item => String(item || '').trim()).filter(Boolean)
    // 黑名单优先级最高：命中后连静默写入也一起忽略。
    if (category === 'group' && senderId && blacklist.includes(senderId)) {
      return { trigger: false, ignore: true, reason: 'blacklist', rules }
    }
    const whitelist = rules.whitelist.map(item => String(item || '').trim()).filter(Boolean)
    const whitelistAllowed = () => !!senderId && whitelist.includes(senderId)
    let decision = null
    if (category !== 'group') {
      decision = { trigger: true, ignore: false, reason: 'private', rules }
    } else if (message.mentionedSelf === true) {
      // @ 机器人始终优先回复（可再受“艾特白名单”限制）；
      // “仅 @ 时回复”关闭后，只影响未 @ 的普通消息是否按概率触发。
      let trigger = true
      let reason = 'mention'
      if (rules.whitelistForAt === true) {
        trigger = whitelistAllowed()
        reason = trigger ? 'mention+whitelist' : 'mention+whitelist-blocked'
      }
      decision = { trigger, ignore: false, reason, rules }
    } else if (rules.requireAt) {
      // 启用“仅 @ 时回复”：没有 @ 机器人的群消息不触发，只静默写入上下文。
      decision = { trigger: false, ignore: false, reason: 'requireAt', rules }
    } else {
      const probability = Math.max(0, Math.min(100, Number(rules.replyProbability) || 0))
      let trigger = true
      let reason = 'probability'
      if (rules.whitelistForProbability === true) {
        trigger = whitelistAllowed()
        reason = trigger ? 'probability+whitelist' : 'probability+whitelist-blocked'
      }
      // 白名单通过后再掷概率；未通过白名单不消耗随机数。
      decision = { trigger: trigger && Math.random() * 100 < probability, ignore: false, reason, rules }
    }
    // 扩展插件可以通过拦截 napcat:trigger-decision 接管 / 修改触发规则。
    const payload = { channel, message, ...decision }
    try {
      const intercepted = events.emit('napcat:trigger-decision', payload, { interceptor: true }) || payload
      if (intercepted && typeof intercepted === 'object') {
        return {
          trigger: intercepted.trigger === true,
          ignore: intercepted.ignore === true,
          reason: intercepted.reason || decision.reason,
          rules: intercepted.rules || rules,
        }
      }
    } catch (_) {
      /* 扩展失败时继续默认规则 */
    }
    return decision
  }

  /* ---------------- NapCat 消息 -> 角色模型 -> NapCat ---------------- */

  /**
   * 即时外发：助手消息写入渠道会话后立刻发给 NapCat。
   * 整轮期间的正常回复会带上当前入站消息的引用 / 艾特；
   * 其它渠道 chat_send 跨渠道写进来的消息没有当前入站消息，则不引用、不艾特，直接发送。
   */
  async function deliverOutbound({ channel, conversationId, message }) {
    const targetType = targetTypeOf(channel)
    const targetId = targetIdOf(channel)
    const instanceId = instanceIdOf(channel)
    if (!instanceId) return { ok: false, error: 'NapCat 渠道未绑定连接' }
    if (!targetId) return { ok: false, error: 'NapCat 渠道未配置目标 QQ / 群号' }

    const active = activeTurns.get(conversationId)
    const inbound = active && String(active.channel?.id || '') === String(channel.id) ? active.message : null
    const rules = groupRulesOf(channel)
    const content = buildOutboundContent(message)
    const forwarding = Array.isArray(content.forward) && content.forward.length > 0
    // 转发路径下图片会被挂到最后一个节点上（见 bridge 的 sendForwardMessage）。
    const images = content.images

    const body = {
      channelId: channel.id,
      instanceId,
      targetType,
      targetId,
      text: content.text,
      images,
      // 合并转发无法与引用 / 艾特混发：转发记录本身就是一条消息。
      quoteMsgId: !forwarding && targetType === 'group' && rules.quote && inbound?.messageId ? String(inbound.messageId) : '',
      mentionUserId: !forwarding && targetType === 'group' && rules.mention && inbound?.senderId ? String(inbound.senderId) : '',
      ...(forwarding
        ? { forward: { name: String(sessions.get(conversationId)?.meta?.napcatBotName || '').trim(), nodes: content.forward } }
        : {}),
    }
    const result = await bridgePost('/send', body)
    if (result?.ok === false) return { ok: false, error: result.error || 'NapCat 返回发送失败' }
    messages?.update?.(conversationId, message.id, {
      source: TYPE_ID,
      meta: {
        ...(message.meta || {}),
        via: TYPE_ID,
        direction: 'outbound',
        instanceId,
        targetType,
        targetId,
        napcatMessageId: result?.messageId || '',
        quoteMessageId: body.quoteMsgId || '',
        mentionUserId: body.mentionUserId || '',
        imagesSent: images.length > 0,
        forwarded: forwarding || undefined,
        forwardNodes: forwarding ? content.forward.length : undefined,
        outboundError: '',
      },
    })
    return { ok: true, messageId: result?.messageId || '' }
  }

  async function runInboundTurn(channel, conv, message, permissions) {
    activeTurns.set(conv.id, { channel, message, permissions })
    try {
      await new Promise(resolve => {
        let settled = false
        const finish = () => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          if (pendingTurns.get(conv.id) === finish) pendingTurns.delete(conv.id)
          resolve()
        }
        const timer = setTimeout(finish, 10 * 60 * 1000)
        pendingTurns.set(conv.id, finish)
        try {
          if (!ctx.registry.get('chat-flow')) finish()
          else events.emit('message:send', {
            conversationId: conv.id,
            text: message.text || (Array.isArray(message.images) && message.images.length ? '[图片]' : ''),
            images: Array.isArray(message.images) ? message.images : [],
            skipUserAppend: true,
          })
        } catch (_) {
          finish()
        }
      })
      // 等当前会话排队的外发全部完成，保证下一轮入站不会插到未发完的消息前面。
      await base.outboundIdle?.(conv.id)
    } finally {
      const current = activeTurns.get(conv.id)
      if (!current || String(current.channel?.id || '') === String(channel.id)) activeTurns.delete(conv.id)
    }
  }

  async function handleInbound(payload) {
    // 服务端常驻代聊已接管时，WebUI 只负责展示，不再重复处理入站消息。
    if (api?.supports?.('server-agent') && globalThis.__NIANFENG_SERVER_AGENT__ !== true) return
    const channelId = payload?.channelId
    const message = payload?.message
    if (!channelId || !message?.id) return
    const channel = findChannel(channelId)
    if (!isNapcatChannel(channel)) return
    if (payload?.instanceId && instanceIdOf(channel) && String(payload.instanceId) !== instanceIdOf(channel)) return
    if (String(message.messageType || '') !== targetTypeOf(channel)) return
    if (targetIdOf(channel) && String(message.peerId || '') !== targetIdOf(channel)) return

    let seen = handledInbound.get(channelId)
    if (!seen) {
      seen = new Set()
      handledInbound.set(channelId, seen)
    }
    if (seen.has(message.id)) return
    seen.add(message.id)
    if (seen.size > 600) {
      const first = seen.values().next().value
      seen.delete(first)
    }

    const conv = ensureConversation(channel)
    if (!conv) return

    const decision = triggerDecision(channel, message)
    const permissions = permissionsOf(channel)
    const sender = senderIdentityFor(channel, message)
    // 被规则忽略 / 仅用于敏感确认的入站消息不会进入 chat-store，也就不会走
    // channel-base 的 message:added 统一日志。这里补一条 [收到消息]，
    // 让日志页也能看到“消息收到了，但为什么没有触发回复”。
    const logReceived = suffix => {
      if (typeof ctx.logger?.info !== 'function') return
      const text = String(message.text || '').trim() || (Array.isArray(message.images) && message.images.length ? '[图片]' : '')
      ctx.logger.info(
        `${describeIncomingMessage(
          {
            role: 'user',
            content: text,
            sender_name: sender.userName,
            sender_id: sender.userId,
            meta: {
              direction: 'inbound',
              via: TYPE_ID,
              messageType: message.messageType,
              groupId: message.groupId,
              senderId: message.senderId,
              senderNickname: message.senderNickname,
              senderCard: message.senderCard,
              images: Array.isArray(message.images) ? message.images : [],
              forward: message.forward || null,
              quote: message.quote || null,
            },
          },
          { channelName: channel.name, channelType: TYPE_ID },
        )}${suffix ? `（${suffix}）` : ''}`,
      )
    }
    // 启动前积压的消息：只写上下文，不触发模型回复（避免重启后批量刷屏）。
    const backlog = backlogOf(message)
    if (backlog && decision.trigger) {
      decision.trigger = false
      decision.reason = 'backlog'
    }

    if (decision.ignore) {
      logReceived(`已忽略：${decision.reason || '规则未触发'}`)
      await ackInbox(channel.id, [message.id])
      events.emit('napcat:ignored', { channel, message, reason: decision.reason })
      return
    }

    // 群聊黑名单由后端路由进来后在这里静默忽略；其它情况默认保留全部群消息形成最近 N 条上下文（N 可配置）。
    const shouldWrite = decision.trigger || decision.rules.silentContext !== false
    if (!shouldWrite) logReceived(`未写入上下文：${decision.reason || '规则未触发'}`)
    const text = String(message.text || '').trim() || (Array.isArray(message.images) && message.images.length ? '[图片]' : '')
    const senderIds = Array.isArray(channel.meta?.trustedUserIds) ? channel.meta.trustedUserIds.map(item => String(item || '').trim()).filter(Boolean) : []
    const trustedForSender = senderIds.map(id => (id.startsWith('qq:') ? id : `qq:${id}`))
    const chatPermissions = ctx.registry.get('chat-permissions')
    const confirmContext =
      targetTypeOf(channel) === 'group'
        ? { senderId: sender.userId, allowedUserIds: trustedForSender }
        : channel.meta?.identityMode === 'guest'
          ? { senderId: sender.userId, allowedUserIds: trustedForSender }
          : { senderId: sender.userId, allowedUserIds: [sender.userId].filter(Boolean), owner: true }
    const pendingConfirm = chatPermissions?.resolvePending?.(conv.id, text, confirmContext)
    if (pendingConfirm?.handled) {
      logReceived('已作为敏感操作确认消费')
      await ackInbox(channel.id, [message.id])
      return
    }

    if (shouldWrite) {
      const messageMeta = {
        via: TYPE_ID,
        direction: 'inbound',
        napcatChannelId: channel.id,
        instanceId: instanceIdOf(channel),
        messageType: message.messageType,
        peerId: message.peerId,
        groupId: message.groupId || '',
        senderId: message.senderId || '',
        senderNickname: message.senderNickname || '',
        senderCard: message.senderCard || '',
        senderRole: message.senderRole || '',
        messageId: message.messageId,
        mentionedSelf: message.mentionedSelf === true,
        mentionOnly: message.mentionOnly === true,
        atUserIds: Array.isArray(message.atUserIds) ? message.atUserIds : [],
        quote: message.quote || null,
          forward: message.forward || null,
          card: message.card || null,
          cards: Array.isArray(message.cards) ? message.cards.slice(0, 2) : [],
        images: Array.isArray(message.images) ? message.images : [],
        triggered: decision.trigger === true,
        triggerReason: decision.reason,
        backlog: backlog || undefined,
        replyRules: { quote: decision.rules.quote !== false, mention: decision.rules.mention !== false },
      }
      if (store?.append) {
        store.append(conv.id, {
          role: 'user',
          content: text,
          sender_id: sender.userId,
          sender_name: sender.userName,
          source: TYPE_ID,
          meta: messageMeta,
        })
      } else {
        messages?.add?.(conv.id, {
          role: 'user',
          content: text,
          status: 'sent',
          sender_id: sender.userId,
          sender_name: sender.userName,
          meta: messageMeta,
        })
      }
    }

    await ackInbox(channel.id, [message.id])
    try {
      events.emit('napcat:inbound', { channel, message, conversationId: conv.id, decision, permissions })
    } catch (_) {
      /* 扩展监听失败不影响主链路 */
    }
    if (!decision.trigger) return
    if (permissions.read === false || permissions.reply === false) return

    const previous = busyChains.get(conv.id) || Promise.resolve()
    const task = previous
      .catch(() => {})
      .then(() => runInboundTurn(channel, conv, message, permissions))
      .catch(err => ctx.logger?.warn?.(`[napcat] 处理 ${message.id} 失败：${err?.message || err}`))
    busyChains.set(conv.id, task)
    task.finally(() => {
      if (busyChains.get(conv.id) === task) busyChains.delete(conv.id)
    }).catch(() => {})
  }

  /* ---------------- 发现会话选择器 ---------------- */

  function openDiscoverPicker({ instanceId, type = '', onPick }) {
    let overlay = document.createElement('div')
    overlay.className = 'nc-mask'
    overlay.innerHTML = `
      <div class="nc-dialog" role="dialog" aria-modal="true">
        <h3>选择${type === 'group' ? '群聊' : type === 'private' ? '私聊' : ''}目标</h3>
        <div class="nc-sub">从该 NapCat 连接最近发现的会话里选择；也可以关闭本窗口手动填写 QQ 号 / 群号。</div>
        <div class="nc-picker" data-nc-picker><div class="nc-empty">正在读取发现列表…</div></div>
        <div class="nc-actions"><button class="outline-btn" data-nc-picker-close>取消</button></div>
      </div>`
    const close = () => {
      overlay?.remove()
      overlay = null
    }
    const picker = overlay.querySelector('[data-nc-picker]')
    overlay.querySelector('[data-nc-picker-close]')?.addEventListener('click', close)
    overlay.addEventListener('mousedown', event => {
      if (event.target === overlay) close()
    })
    document.body.appendChild(overlay)
    ;(async () => {
      let peers = []
      try {
        const data = await bridgeGet(`/discover?instanceId=${encodeURIComponent(instanceId)}${type ? `&type=${encodeURIComponent(type)}` : ''}`)
        peers = Array.isArray(data?.peers) ? data.peers : []
        if (!peers.length) {
          try {
            const refreshed = await bridgePost(`/instances/${encodeURIComponent(instanceId)}/refresh`, {})
            peers = Array.isArray(refreshed?.peers) ? refreshed.peers : peers
          } catch (_) {
            /* ignore */
          }
          if (type) peers = peers.filter(item => item.type === type)
        }
      } catch (_) {
        peers = []
      }
      if (!overlay) return
      picker.innerHTML = peers.length
        ? peers
            .map(item => `
              <div class="nc-picker-row" data-nc-peer="${escapeHtml(`${item.type}:${item.peerId}`)}">
                <div class="nc-picker-main">
                  <div class="nc-picker-name">
                    <span class="nc-tag ${item.type === 'group' ? '' : 'ok'}">${item.type === 'group' ? '群聊' : '私聊'}</span>
                    ${escapeHtml(item.name || (item.type === 'group' ? `群 ${item.peerId}` : `QQ ${item.peerId}`))}
                    <span class="nc-row-id">${escapeHtml(String(item.peerId))}</span>
                  </div>
                  <div class="nc-picker-sub">${escapeHtml(item.lastText || item.lastSenderName || '暂无消息')} · ${Number(item.count) || 0} 条</div>
                </div>
              </div>`)
            .join('')
        : '<div class="nc-empty">还没有发现会话。请先在 QQ 里给机器人发一条消息，或点渠道详情的「刷新」拉取好友 / 群列表。</div>'
      picker.querySelectorAll('[data-nc-peer]').forEach(row => {
        row.addEventListener('click', () => {
          const [peerType, ...rest] = String(row.dataset.ncPeer || '').split(':')
          const peerId = rest.join(':')
          const item = peers.find(peer => peer.type === peerType && String(peer.peerId) === peerId)
          onPick?.(item || { type: peerType, peerId })
          close()
        })
      })
    })()
  }

  /* ---------------- 连接地址弹窗 ---------------- */

  async function showEndpointModal(instanceId) {
    let url = ''
    let simpleUrl = ''
    let host = ''
    let path = '/ws'
    let port = 0
    let token = ''
    try {
      const data = await bridgePost(`/instances/${encodeURIComponent(instanceId)}/endpoint`, {
        baseUrl: typeof location !== 'undefined' ? location.origin : '',
        clientHost: typeof location !== 'undefined' ? location.hostname : '',
      })
      url = data?.url || ''
      simpleUrl = data?.simpleUrl || url
      host = data?.host || ''
      path = data?.path || '/ws'
      port = Number(data?.port) || 0
      token = String(data?.token || '')
    } catch (err) {
      toast.error(`获取连接地址失败：${err.message}`)
      return
    }
    const copyValue = token ? url : simpleUrl
    let overlay = document.createElement('div')
    overlay.className = 'nc-mask'
    overlay.innerHTML = `
      <div class="nc-dialog" role="dialog" aria-modal="true">
        <h3>NapCat 反向 WebSocket 连接地址</h3>
        <div class="nc-sub">NapCat 侧新建「WebSocket 客户端（反向）」，地址填下面的值即可。格式与你现有 NapCat 里的反向地址一致。</div>
        <label class="nc-field">
          <span>WebSocket 客户端连接地址${token ? '（含 Token，推荐直接复制）' : ''}</span>
          <input readonly value="${escapeHtml(copyValue)}" />
        </label>
        <div class="nc-grid">
          <label class="nc-field">
            <span>反向主机</span>
            <input readonly value="${escapeHtml(host)}" />
          </label>
          <label class="nc-field">
            <span>反向端口</span>
            <input readonly value="${escapeHtml(String(port || ''))}" />
          </label>
        </div>
        <label class="nc-field">
          <span>反向路径</span>
          <input readonly value="${escapeHtml(path)}" />
        </label>
        <div class="nc-note">
          ${
            token
              ? `当前连接设置了 Token：<code>${escapeHtml(token)}</code><br/>如果 NapCat 的配置页有单独的 Token 输入框，也可以把地址填成 <code>${escapeHtml(
                  simpleUrl,
                )}</code>，Token 填上面这个值；直接复制含 Token 的完整地址也可以。`
              : '当前连接未设置 Token：NapCat 的 Token 保持留空即可，不需要额外配置。'
          }
          <b>每新增一个 QQ 号，请新建一个反向 WebSocket 客户端</b>指向对应地址；同一个 QQ 号请复用同一个连接。
        </div>
        <div class="nc-actions">
          <button class="outline-btn" data-nc-copy>复制地址</button>
          <button class="outline-btn primary-soft" data-nc-close>关闭</button>
        </div>
      </div>`
    const close = () => {
      overlay?.remove()
      overlay = null
    }
    overlay.querySelector('[data-nc-close]')?.addEventListener('click', close)
    overlay.querySelector('[data-nc-copy]')?.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(copyValue)
        toast.success('反向连接地址已复制')
      } catch (_) {
        toast.info(copyValue)
      }
    })
    overlay.addEventListener('mousedown', event => {
      if (event.target === overlay) close()
    })
    document.body.appendChild(overlay)
  }

  /* ---------------- 添加 / 编辑渠道窗口 ---------------- */

  function preferredInstanceId(roleId, selected) {
    const local = []
    for (const tab of channels.tabs()) {
      for (const channel of channels.channels(tab)) {
        if (!isNapcatChannel(channel)) continue
        local.push({ id: channel.id, instanceId: instanceIdOf(channel), roleId: channel.meta?.roleId || '' })
      }
    }
    const score = instance => {
      let value = instance.status === 'online' ? 100 : instance.status === 'waiting' ? 20 : 0
      const used = local.filter(item => item.instanceId === instance.id)
      value += used.length * 8
      if (roleId) value += used.filter(item => item.roleId === roleId).length * 40
      return value
    }
    const list = [...instances].sort((a, b) => score(b) - score(a))
    if (selected && list.some(item => item.id === String(selected))) return String(selected)
    return list[0]?.id || '__new__'
  }

  function instanceOptionsHtml(selectedId) {
    const rows = instances.map(instance => {
      const account = instance.login?.userId ? `${instance.login.nickname || 'QQ'}（${instance.login.userId}）` : '未获取到登录账号'
      const status = STATUS_LABEL[instance.status] || instance.status || '未连接'
      const count = Array.isArray(instance.channelIds) ? instance.channelIds.length : 0
      const endpoint =
        instance.mode === 'reverse'
          ? `反向 ${instance.host || '127.0.0.1'}:${instance.port || '自动'}${instance.path || '/ws'}`
          : instance.url || 'Forward'
      return `<option value="${escapeHtml(instance.id)}" ${String(instance.id) === String(selectedId) ? 'selected' : ''}>${escapeHtml(
        `${instance.remark || instance.id} · ${account} · ${status} · ${endpoint}${count ? ` · 已复用 ${count}` : ''}`,
      )}</option>`
    })
    rows.push(`<option value="__new__" ${selectedId === '__new__' ? 'selected' : ''}>➕ 新建一个 NapCat 连接…</option>`)
    return rows.join('')
  }

  function openSettings({ mode = 'create', tab = 'private', channel = null, preset = null, onSaved } = {}) {
    const editing = mode === 'edit' && channel
    const source = editing ? findChannel(channel.id) || channel : null
    const meta = source?.meta || {}
    const presetCategory = preset?.targetType === 'group' ? 'group' : preset?.targetType === 'private' ? 'private' : ''
    const roleId = meta.roleId || ''
    const category = editing
      ? TAB_ORDER.includes(meta.category)
        ? meta.category
        : TAB_ORDER.includes(tab)
          ? tab
          : 'private'
      : TAB_ORDER.includes(presetCategory)
        ? presetCategory
        : TAB_ORDER.includes(tab)
          ? tab
          : 'private'
    const targetType = category === 'group' ? 'group' : 'private'
    const targetId = String(editing ? meta.targetId || '' : preset?.targetId || '')
    const targetName = String(editing ? meta.targetName || '' : preset?.targetName || '')
    const permissions = permissionsOf(source)
    const rules = groupRulesOf(source)
    const identity = channelIdentity(source)
    const identityMode = meta.identityMode === 'guest' ? 'guest' : 'owner'
    let overlay = null
    let selectedInstanceId = editing ? instanceIdOf(source) || '__new__' : String(preset?.instanceId || '') || '__new__'
    let saving = false

    overlay = document.createElement('div')
    overlay.className = 'nc-mask'
    overlay.innerHTML = `
      <div class="nc-dialog" role="dialog" aria-modal="true">
        <h3>${editing ? '编辑 NapCat 渠道' : '添加 NapCat 渠道'}</h3>
        <div class="nc-sub">${
          editing
            ? '修改角色、目标、连接或群聊规则后立即生效；所有渠道共享底层的 NapCat 连接。'
            : '先为这个渠道指定一个角色、目标 QQ / 群号和 NapCat 连接。同一个 NapCat 连接可以给多个渠道复用。'
        }</div>
        <label class="nc-field">
          <span>渠道名称</span>
          <input data-nc-name maxlength="30" value="${escapeHtml(source?.name || 'NapCat')}" placeholder="例如：小风的QQ" />
        </label>
        <label class="nc-field">
          <span>使用角色</span>
          <select data-nc-role>
            <option value="">请选择角色</option>
            ${roleOptions(roleId)}
          </select>
        </label>
        <div class="nc-grid">
          <label class="nc-field">
            <span>渠道分类</span>
            <div class="nc-mode-tabs" data-nc-category-tabs>
              ${TAB_ORDER.map(value => `
                <button type="button" class="nc-mode-tab" data-nc-category-tab="${value}">
                  <b>${TAB_LABELS[value]}</b>
                  <small>${value === 'private' ? '角色工作记忆' : value === 'group' ? '本群独立上下文' : '单会话隔离'}</small>
                </button>`).join('')}
            </div>
            <select data-nc-category style="display:none" aria-hidden="true">
              <option value="private" ${category === 'private' ? 'selected' : ''}>私聊</option>
              <option value="group" ${category === 'group' ? 'selected' : ''}>群聊</option>
              <option value="privacy" ${category === 'privacy' ? 'selected' : ''}>隐私</option>
            </select>
            <div class="nc-field-help" data-nc-category-help>${CATEGORY_HELP[category] || CATEGORY_HELP.private}</div>
          </label>
          <label class="nc-field">
            <span data-nc-target-label>${targetType === 'group' ? '群聊目标群号' : '私聊目标 QQ 号'}</span>
            <div class="nc-grid-3">
              <input data-nc-target maxlength="30" value="${escapeHtml(targetId)}" placeholder="${targetType === 'group' ? '例如：123456789' : '例如：10001'}" />
              <button class="outline-btn" data-nc-pick-target title="从该 NapCat 连接收到过的会话 / 好友 / 群里选择目标，省得手动输入">从已发现会话选择…</button>
            </div>
            <div class="nc-field-help" data-nc-target-help>这里填<b>要接入聊天的目标</b>：私聊 / 隐私填对方的 QQ 号，群聊填群号。只有这个目标的消息会进入本渠道。</div>
          </label>
        </div>
        <input type="hidden" data-nc-target-name value="${escapeHtml(targetName)}" />
        <div class="nc-note">
          <b>“从已发现会话选择”</b>：先选一个已经连接过、且拉取过好友 / 群列表或收到过消息的 NapCat 连接，
          就能直接从列表里挑目标；新连接保存后也可以在渠道详情里使用发现列表。
        </div>
        <label class="nc-field">
          <span>NapCat 连接（同一连接可被多个渠道复用）</span>
          <select data-nc-instance>${instanceOptionsHtml(selectedInstanceId)}</select>
        </label>
        <div data-nc-instance-status class="nc-status"><span class="dot" style="background:${STATUS_COLOR.offline}"></span><span>正在读取连接状态…</span></div>

        <div data-nc-new-instance class="nc-rule-card" hidden>
          <div class="nc-note">
            <b>Forward（正向）</b>：念风主动连接 NapCat 的 WebSocket 服务，适合本机 NapCat；
            <b>Reverse（反向）</b>：NapCat 主动连到念风后端，适合远程 / 内网穿透，保存后会给你连接地址。
          </div>
          <div class="nc-grid">
            <label class="nc-field">
              <span>连接方式</span>
              <select data-nc-mode>
                <option value="forward" selected>Forward · 连接 NapCat 的 WS 服务</option>
                <option value="reverse">Reverse · NapCat 连到念风</option>
              </select>
            </label>
            <label class="nc-field">
              <span>连接备注</span>
              <input data-nc-inst-remark maxlength="30" value="" placeholder="例如：主 QQ / 小号" />
            </label>
          </div>
          <label class="nc-field" data-nc-url-row>
            <span>NapCat WebSocket 地址（Forward）</span>
            <input data-nc-url maxlength="200" value="ws://127.0.0.1:3001" placeholder="ws://127.0.0.1:3001" />
            <div class="nc-field-help">NapCat 网络配置里开启的 WebSocket 服务器地址，常见是 ws://127.0.0.1:3001。</div>
          </label>
          <div data-nc-reverse-row hidden>
            <div class="nc-grid">
              <label class="nc-field">
                <span>反向 WebSocket 主机（Reverse）</span>
                <input data-nc-host maxlength="64" value="127.0.0.1" placeholder="127.0.0.1；要远程接入可填 0.0.0.0" />
              </label>
              <label class="nc-field">
                <span>反向 WebSocket 端口</span>
                <input data-nc-port type="number" min="0" max="65535" value="0" placeholder="0 = 自动分配 6199 起" />
              </label>
            </div>
            <label class="nc-field">
              <span>反向 WebSocket 路径（默认 /ws）</span>
              <input data-nc-path maxlength="120" value="/ws" placeholder="/ws；和 NapCat 已有反向地址保持一致即可" />
            </label>
            <div class="nc-field-help">
              端口填 0 时念风会自动从 6199 起选一个空闲端口并保存。NapCat 的「WebSocket 客户端」地址最终形如
              <code>ws://127.0.0.1:6199/ws</code>，和你现在 AstrBot 里那种格式一致。
            </div>
          </div>
          <label class="nc-field">
            <span>访问令牌 / Token（可选，Forward 填 NapCat 的 token；Reverse 留空即不启用）</span>
            <input data-nc-token type="password" maxlength="200" value="" placeholder="可留空；已有 NapCat 没配 token 就保持空" />
          </label>
        </div>

        <div data-nc-identity-row class="nc-field">
          <span>私聊身份</span>
          <select data-nc-identity>
            <option value="owner" ${identityMode === 'owner' ? 'selected' : ''}>把目标 QQ 视为主人（默认，方便跨渠道协作）</option>
            <option value="guest" ${identityMode === 'guest' ? 'selected' : ''}>作为独立 QQ 用户</option>
          </select>
        </div>

        <div data-nc-group-rules hidden>
          <div class="settings-section-title" style="margin:6px 0 4px">群聊规则</div>
          <div class="nc-rule-card">
            <label class="nc-field">
              <span>黑名单（无视这些 QQ 号的消息，逗号 / 空格分隔）</span>
              <input data-nc-blacklist maxlength="500" value="${escapeHtml((rules.blacklist || []).join(','))}" placeholder="例如：12345,67890" />
              <div class="nc-field-help">黑名单优先级最高：命中后无论 @ 还是概率都不会触发，消息也不会写入上下文。</div>
            </label>
            <label class="nc-field">
              <span>白名单（只允许这些 QQ 号触发回复，逗号 / 空格分隔）</span>
              <input data-nc-whitelist maxlength="500" value="${escapeHtml((rules.whitelist || []).join(','))}" placeholder="例如：10001,10002" />
              <div class="nc-field-help">白名单列表本身不会自动生效；下面两个开关分别控制「艾特回复」和「概率回复」是否只允许白名单里的 QQ 触发。</div>
            </label>
            <div class="nc-checks" style="flex-direction:column;gap:7px">
              <label><input type="checkbox" data-nc-whitelist-at ${rules.whitelistForAt === true ? 'checked' : ''} /> @ 触发也受白名单限制（只有白名单 QQ 的 @ 才会回复）</label>
              <label><input type="checkbox" data-nc-whitelist-prob ${rules.whitelistForProbability === true ? 'checked' : ''} /> 概率回复时应用白名单（只有白名单 QQ 才参与概率触发）</label>
            </div>
            <div class="nc-checks">
              <label><input type="checkbox" data-nc-require-at ${rules.requireAt !== false ? 'checked' : ''} /> 仅 @ 时回复（关闭后：@ 仍直接回复，其它消息按概率触发）</label>
            </div>
            <div class="nc-field" data-nc-probability-row>
              <span>普通消息回复概率（@ 机器人的消息不受此概率影响）</span>
              <div class="nc-range-row">
                <input type="range" min="0" max="100" step="1" data-nc-probability value="${Number(rules.replyProbability) || 0}" />
                <input class="nc-range-num" type="number" min="0" max="100" step="1" data-nc-probability-number value="${Number(rules.replyProbability) || 0}" />
                <span class="nc-range-unit">%</span>
              </div>
            </div>
            <div class="nc-checks">
              <label><input type="checkbox" data-nc-quote ${rules.quote !== false ? 'checked' : ''} /> 回复时引用触发消息</label>
              <label><input type="checkbox" data-nc-mention ${rules.mention !== false ? 'checked' : ''} /> 回复时艾特触发者</label>
              <label><input type="checkbox" data-nc-silent ${rules.silentContext !== false ? 'checked' : ''} /> 未触发时也静默写入本群上下文</label>
            </div>
            <label class="nc-field">
              <span>本群上下文条数（留空 = 继承通用设置）</span>
              <input type="number" min="1" max="1000" step="1" data-nc-context-messages value="${Math.floor(Number(rules.contextMessages)) > 0 ? Math.floor(Number(rules.contextMessages)) : ''}" placeholder="继承通用设置（${globalGroupMessages()} 条）" style="width:120px" />
              <div class="nc-field-help">只使用本群最近 N 条消息；填 0 或留空跟随全局，当前生效 <b data-nc-context-messages-effective>${groupContextMessagesOf(source)}</b> 条。</div>
            </label>
            <div class="nc-note">开启静默写入后，未触发回复的群消息也会进入本群上下文。</div>
          </div>
        </div>

        <div class="nc-field">
          <span>权限设置</span>
          <div class="nc-perms">
            ${PERMISSION_META.map(([key, label, help]) => `
              <label class="nc-perm" data-nc-perm-row="${key}" data-nc-perm-scope="${(PERMISSION_SCOPES[key] || []).join(',')}">
                <input type="checkbox" data-nc-perm="${key}" ${permissions[key] !== false ? 'checked' : ''} />
                <span>${label}<small>${help}</small></span>
              </label>`).join('')}
          </div>
          <div class="nc-field-help" data-nc-perm-note></div>
        </div>
        <div class="nc-error" data-nc-error hidden></div>
        <div class="nc-actions">
          <button class="outline-btn" data-nc-cancel>取消</button>
          <button class="outline-btn primary-soft" data-nc-save>${editing ? '保存修改' : '添加渠道'}</button>
        </div>
      </div>`

    const nameInput = overlay.querySelector('[data-nc-name]')
    const roleSelect = overlay.querySelector('[data-nc-role]')
    const categorySelect = overlay.querySelector('[data-nc-category]')
    const categoryTabs = [...overlay.querySelectorAll('[data-nc-category-tab]')]
    const categoryHelp = overlay.querySelector('[data-nc-category-help]')
    const permRows = [...overlay.querySelectorAll('[data-nc-perm-row]')]
    const permNote = overlay.querySelector('[data-nc-perm-note]')
    const targetInput = overlay.querySelector('[data-nc-target]')
    const targetLabel = overlay.querySelector('[data-nc-target-label]')
    const targetNameInput = overlay.querySelector('[data-nc-target-name]')
    const instanceSelect = overlay.querySelector('[data-nc-instance]')
    const instanceStatus = overlay.querySelector('[data-nc-instance-status]')
    const newInstancePanel = overlay.querySelector('[data-nc-new-instance]')
    const modeSelect = overlay.querySelector('[data-nc-mode]')
    const urlRow = overlay.querySelector('[data-nc-url-row]')
    const urlInput = overlay.querySelector('[data-nc-url]')
    const reverseRow = overlay.querySelector('[data-nc-reverse-row]')
    const hostInput = overlay.querySelector('[data-nc-host]')
    const portInput = overlay.querySelector('[data-nc-port]')
    const pathInput = overlay.querySelector('[data-nc-path]')
    const pickTargetButton = overlay.querySelector('[data-nc-pick-target]')
    const targetHelp = overlay.querySelector('[data-nc-target-help]')
    const tokenInput = overlay.querySelector('[data-nc-token]')
    const instRemarkInput = overlay.querySelector('[data-nc-inst-remark]')
    const identityRow = overlay.querySelector('[data-nc-identity-row]')
    const identitySelect = overlay.querySelector('[data-nc-identity]')
    const groupRulesPanel = overlay.querySelector('[data-nc-group-rules]')
    const blacklistInput = overlay.querySelector('[data-nc-blacklist]')
    const whitelistInput = overlay.querySelector('[data-nc-whitelist]')
    const whitelistAtInput = overlay.querySelector('[data-nc-whitelist-at]')
    const whitelistProbInput = overlay.querySelector('[data-nc-whitelist-prob]')
    const requireAtInput = overlay.querySelector('[data-nc-require-at]')
    const probabilityInput = overlay.querySelector('[data-nc-probability]')
    const probabilityNumberInput = overlay.querySelector('[data-nc-probability-number]')
    const probabilityRow = overlay.querySelector('[data-nc-probability-row]')
    const quoteInput = overlay.querySelector('[data-nc-quote]')
    const mentionInput = overlay.querySelector('[data-nc-mention]')
    const silentInput = overlay.querySelector('[data-nc-silent]')
    const contextMessagesInput = overlay.querySelector('[data-nc-context-messages]')
    const contextMessagesEffective = overlay.querySelector('[data-nc-context-messages-effective]')
    const errorEl = overlay.querySelector('[data-nc-error]')

    const setError = value => {
      errorEl.textContent = value || ''
      errorEl.hidden = !value
    }
    const close = () => {
      overlay?.remove()
      overlay = null
    }

    const syncInstanceStatus = () => {
      const selected = instanceSelect.value === '__new__' ? null : findInstance(instanceSelect.value)
      if (!selected) {
        instanceStatus.innerHTML = '<span class="dot" style="background:#c9a227"></span><span>保存后会新建连接：Forward 立即连接，Reverse 会给出 NapCat 需要填写的地址。</span>'
        return
      }
      const status = STATUS_LABEL[selected.status] || selected.status || '未连接'
      const login = selected.login?.userId ? `${selected.login.nickname || 'QQ'}（${selected.login.userId}）` : '未获取到登录账号'
      instanceStatus.innerHTML = `<span class="dot" style="background:${statusColor(selected.status)}"></span><span>${escapeHtml(`${status} · ${login}`)}${
        selected.mode === 'reverse' ? ' · Reverse' : ' · Forward'
      }</span>`
    }

    const syncPanes = () => {
      const isNew = instanceSelect.value === '__new__'
      newInstancePanel.hidden = !isNew
      const reverse = modeSelect.value === 'reverse'
      urlRow.hidden = !isNew || reverse
      reverseRow.hidden = !isNew || !reverse
      if (pickTargetButton) {
        pickTargetButton.disabled = isNew
        pickTargetButton.title = isNew
          ? '新连接保存后，可在渠道详情或编辑渠道时从发现列表选择目标'
          : '从该 NapCat 连接收到过的会话 / 好友 / 群里选择目标'
      }
      if (!isNew) {
        syncInstanceStatus()
      } else {
        instanceStatus.innerHTML = `<span class="dot" style="background:#c9a227"></span><span>${
          reverse ? '保存后会新建反向监听：NapCat 的 WebSocket 客户端填生成的地址。' : '保存后会新建 Forward 连接：立即尝试连接 NapCat。'
        }</span>`
      }
    }

    const syncCategory = () => {
      const value = categorySelect.value
      const isGroup = value === 'group'
      const isPrivacy = value === 'privacy'
      const activeCategory = isGroup ? 'group' : isPrivacy ? 'privacy' : 'private'
      groupRulesPanel.hidden = !isGroup
      identityRow.hidden = isGroup
      targetLabel.textContent = isGroup ? '群聊目标群号' : isPrivacy ? '隐私目标 QQ 号' : '私聊目标 QQ 号'
      targetInput.placeholder = isGroup ? '例如：123456789' : '例如：10001'
      if (categoryHelp) categoryHelp.textContent = CATEGORY_HELP[activeCategory] || CATEGORY_HELP.private
      for (const tab of categoryTabs) tab.classList.toggle('active', tab.dataset.ncCategoryTab === activeCategory)
      // 按分类隐藏无意义的权限项，但保留在 DOM 里，保存时仍能保留原有的勾选状态。
      for (const row of permRows) {
        const scopes = String(row.dataset.ncPermScope || '').split(',').filter(Boolean)
        row.hidden = scopes.length > 0 && !scopes.includes(activeCategory)
      }
      if (permNote) {
        permNote.textContent = isPrivacy
          ? '隐私渠道按设计不能与其它渠道互读 / 互发，因此跨渠道相关权限已隐藏。'
          : isGroup
            ? '群聊只使用本群记录，因此「参与工作记忆」已隐藏。'
            : '私聊可使用全部权限；跨渠道操作仍可能要求二次确认。'
      }
      if (targetHelp) {
        targetHelp.innerHTML = isGroup
          ? '这里填<b>要接入聊天的群号</b>；只有这个群的消息会进入本渠道，其它群不会触发模型。'
          : isPrivacy
            ? '这里填<b>隐私会话对应的 QQ 号</b>；该渠道有独立记录，不会参与角色工作记忆，也不能和其它渠道互读 / 互发。'
            : '这里填<b>要接入聊天的对方 QQ 号</b>；只有这个 QQ 的私聊消息会进入本渠道。'
      }
      if (isGroup) targetNameInput.value = ''
    }

    const clampProbability = value => {
      const num = Number(value)
      if (!Number.isFinite(num)) return 0
      return Math.max(0, Math.min(100, Math.round(num)))
    }
    const syncProbability = () => {
      const disabled = requireAtInput.checked
      const value = clampProbability(probabilityInput.value)
      probabilityInput.value = String(value)
      probabilityNumberInput.value = String(value)
      probabilityInput.disabled = disabled
      probabilityNumberInput.disabled = disabled
      probabilityRow.style.opacity = disabled ? '.5' : '1'
    }
    const onProbabilityNumber = () => {
      const value = clampProbability(probabilityNumberInput.value)
      probabilityInput.value = String(value)
      probabilityNumberInput.value = String(value)
      syncProbability()
    }

    const syncPreferredInstance = () => {
      if (editing) return
      instanceSelect.innerHTML = instanceOptionsHtml(preferredInstanceId(String(roleSelect.value || ''), ''))
      syncPanes()
    }

    categorySelect.addEventListener('change', syncCategory)
    for (const tab of categoryTabs) {
      tab.addEventListener('click', () => {
        const next = TAB_ORDER.includes(tab.dataset.ncCategoryTab) ? tab.dataset.ncCategoryTab : 'private'
        if (categorySelect.value === next) return
        categorySelect.value = next
        syncCategory()
      })
    }
    requireAtInput.addEventListener('change', syncProbability)
    probabilityInput.addEventListener('input', syncProbability)
    probabilityNumberInput.addEventListener('input', onProbabilityNumber)
    contextMessagesInput?.addEventListener('input', () => {
      if (!contextMessagesEffective) return
      const n = Math.floor(Number(contextMessagesInput.value))
      contextMessagesEffective.textContent = String(Number.isFinite(n) && n > 0 ? Math.max(1, Math.min(1000, n)) : globalGroupMessages())
    })
    modeSelect.addEventListener('change', syncPanes)
    instanceSelect.addEventListener('change', syncPanes)
    roleSelect.addEventListener('change', () => {
      if (!editing) syncPreferredInstance()
    })

    overlay.querySelector('[data-nc-pick-target]')?.addEventListener('click', () => {
      const selected = instanceSelect.value === '__new__' ? '' : instanceSelect.value
      if (!selected) {
        setError('请先选择一个已有的 NapCat 连接，再使用「从发现选择」；新连接保存后也能在渠道详情里选择目标。')
        return
      }
      const type = categorySelect.value === 'group' ? 'group' : 'private'
      openDiscoverPicker({
        instanceId: selected,
        type,
        onPick: item => {
          if (!item) return
          if (type === 'group' && item.type !== 'group') return
          if (type !== 'group' && item.type !== 'private') return
          targetInput.value = String(item.peerId || '')
          targetNameInput.value = String(item.name || '')
        },
      })
    })

    const save = async () => {
      if (saving) return
      setError('')
      const nextName = String(nameInput.value || '').trim() || 'NapCat'
      const nextRoleId = String(roleSelect.value || '').trim()
      if (!nextRoleId) return setError('请先选择一个角色；没有角色时可先到「会话」里创建一个角色。')
      const nextCategory = TAB_ORDER.includes(categorySelect.value) ? categorySelect.value : 'private'
      const nextTargetType = nextCategory === 'group' ? 'group' : 'private'
      const nextTargetId = String(targetInput.value || '').trim()
      if (!/^\d{3,20}$/.test(nextTargetId)) return setError(nextTargetType === 'group' ? '请填写合法的群号（数字）。' : '请填写合法的目标 QQ 号（数字）。')
      const nextIdentityMode = identitySelect.value === 'guest' ? 'guest' : 'owner'
      const requestedContextMessages = Math.floor(Number(contextMessagesInput?.value))
      const nextRules = {
        blacklist: String(blacklistInput.value || '')
          .split(/[,，\s]+/)
          .map(value => value.trim())
          .filter(Boolean),
        whitelist: String(whitelistInput.value || '')
          .split(/[,，\s]+/)
          .map(value => value.trim())
          .filter(Boolean),
        whitelistForAt: !!whitelistAtInput.checked,
        whitelistForProbability: !!whitelistProbInput.checked,
        requireAt: !!requireAtInput.checked,
        replyProbability: clampProbability(probabilityNumberInput.value),
        quote: !!quoteInput.checked,
        mention: !!mentionInput.checked,
        silentContext: !!silentInput.checked,
        // 0 = 继承全局群聊上下文条数；>0 = 本群单独覆盖。
        contextMessages: Number.isFinite(requestedContextMessages) && requestedContextMessages > 0 ? Math.min(1000, requestedContextMessages) : 0,
        // 写新字段的同时清空旧轮数字段，避免下次读取时旧值覆盖新配置。
        contextRounds: 0,
      }
      const nextPermissions = {}
      for (const [key] of PERMISSION_META) nextPermissions[key] = !!overlay.querySelector(`[data-nc-perm="${key}"]`)?.checked

      saving = true
      const saveButton = overlay.querySelector('[data-nc-save]')
      if (saveButton) saveButton.disabled = true
      try {
        let nextInstanceId = instanceSelect.value
        let createdReverse = false
        if (nextInstanceId === '__new__') {
          const mode = modeSelect.value === 'reverse' ? 'reverse' : 'forward'
          const created = await bridgePost('/instances', {
            mode,
            url: mode === 'forward' ? String(urlInput.value || '').trim() : '',
            host: mode === 'reverse' ? String(hostInput.value || '').trim() || '127.0.0.1' : '',
            port: mode === 'reverse' ? Math.max(0, Math.min(65535, Number(portInput.value) || 0)) : 0,
            path: mode === 'reverse' ? String(pathInput.value || '').trim() || '/ws' : '',
            accessToken: String(tokenInput.value || '').trim(),
            remark: String(instRemarkInput.value || '').trim() || nextName,
            autoConnect: true,
          })
          if (created?.ok === false || !created?.instance?.id) throw new Error(created?.error || '创建 NapCat 连接失败')
          nextInstanceId = created.instance.id
          createdReverse = mode === 'reverse'
          await refreshInstances()
        }
        const targetName =
          String(targetNameInput.value || '').trim() ||
          (nextTargetType === 'group' ? `群 ${nextTargetId}` : `QQ ${nextTargetId}`)
        const nextMeta = {
          ...meta,
          kind: TYPE_ID,
          roleId: nextRoleId,
          category: nextCategory,
          targetType: nextTargetType,
          targetId: nextTargetId,
          targetName,
          instanceId: nextInstanceId,
          identityMode: nextIdentityMode,
          rules: nextRules,
          permissions: nextPermissions,
          updatedAt: Date.now(),
        }
        let saved = null
        if (editing && source) {
          const fromTab = findTab(source.id)
          channels.updateChannel(fromTab, source.id, { name: nextName, meta: nextMeta })
          if (fromTab !== nextCategory) {
            const moved = channels.removeChannel(fromTab, source.id)
            if (moved) {
              const groups = channels.groups(nextCategory)
              const group = groups[0] || channels.addGroup(nextCategory, '我的渠道')
              saved = channels.addChannel(nextCategory, group.id, { ...moved, name: nextName, meta: nextMeta })
              channels.activate(nextCategory, saved.id)
            }
          } else {
            saved = channels.findChannel(fromTab, source.id)
          }
        } else {
          const groups = channels.groups(nextCategory)
          const group = groups[0] || channels.addGroup(nextCategory, '我的渠道')
          saved = channels.addChannel(nextCategory, group.id, {
            type: TYPE_ID,
            name: nextName,
            color: TYPE_COLOR,
            status: 'offline',
            meta: nextMeta,
          })
          channels.activate(nextCategory, saved.id)
        }
        if (!saved) throw new Error('保存渠道失败')
        try {
          ensureConversation(saved)
        } catch (err) {
          ctx.logger?.warn?.(`[napcat] 创建渠道会话失败：${err.message}`)
        }
        await syncChannelToBridge(findChannel(saved.id) || saved, { notify: true })
        await refreshChannelStatus(findChannel(saved.id) || saved)
        if (editing) toast.success(`「${nextName}」已更新`)
        else toast.success(`「${nextName}」已添加`)
        onSaved?.(findChannel(saved.id) || saved)
        close()
        if (createdReverse) await showEndpointModal(nextInstanceId)
      } catch (err) {
        setError(err.message || String(err))
      } finally {
        saving = false
        if (saveButton) saveButton.disabled = false
      }
    }

    overlay.querySelector('[data-nc-cancel]')?.addEventListener('click', close)
    overlay.querySelector('[data-nc-save]')?.addEventListener('click', () => save().catch(err => setError(err.message)))
    overlay.addEventListener('mousedown', event => {
      if (event.target === overlay) close()
    })
    const onKeydown = event => {
      if (event.key === 'Escape') close()
    }
    document.addEventListener('keydown', onKeydown)
    closing.push(() => document.removeEventListener('keydown', onKeydown))
    document.body.appendChild(overlay)

    // DOM 垫片 / 旧浏览器对 selected 属性的默认值同步不完整，显式赋值一次。
    categorySelect.value = TAB_ORDER.includes(category) ? category : 'private'
    modeSelect.value = modeSelect.value === 'reverse' ? 'reverse' : 'forward'
    instanceSelect.value = selectedInstanceId
    requireAtInput.checked = rules.requireAt !== false
    probabilityInput.value = String(Math.max(0, Math.min(100, Number(rules.replyProbability) || 0)))
    probabilityNumberInput.value = probabilityInput.value
    syncCategory()
    syncProbability()
    syncPanes()
    refreshInstances().then(() => {
      if (!overlay) return
      const current = editing ? instanceIdOf(source) || '' : String(preset?.instanceId || '')
      selectedInstanceId = current || preferredInstanceId(String(roleSelect.value || ''), current) || '__new__'
      instanceSelect.innerHTML = instanceOptionsHtml(selectedInstanceId)
      instanceSelect.value = selectedInstanceId
      syncPanes()
      if (selectedInstanceId !== '__new__') syncInstanceStatus()
    })
    setTimeout(() => nameInput?.focus(), 30)
  }

  /* ---------------- 连接实例编辑窗口 ---------------- */

  function openInstanceDialog({ instance = null, onSaved } = {}) {
    const editingInstance = !!instance
    let overlay = document.createElement('div')
    overlay.className = 'nc-mask'
    overlay.innerHTML = `
      <div class="nc-dialog" role="dialog" aria-modal="true">
        <h3>${editingInstance ? '编辑 NapCat 连接' : '新建 NapCat 连接'}</h3>
        <div class="nc-sub">一个 NapCat 登录 QQ 只需要一条连接；多个渠道可以复用同一条连接。</div>
        <div class="nc-grid">
          <label class="nc-field">
            <span>连接方式</span>
            <select data-nc-inst-mode>
              <option value="forward" ${instance?.mode !== 'reverse' ? 'selected' : ''}>Forward · 连接 NapCat 的 WS 服务</option>
              <option value="reverse" ${instance?.mode === 'reverse' ? 'selected' : ''}>Reverse · NapCat 连到念风</option>
            </select>
          </label>
          <label class="nc-field">
            <span>连接备注</span>
            <input data-nc-inst-remark maxlength="30" value="${escapeHtml(instance?.remark || '')}" placeholder="例如：主 QQ / 小号" />
          </label>
        </div>
        <label class="nc-field" data-nc-inst-url-row>
          <span>NapCat WebSocket 地址（Forward）</span>
          <input data-nc-inst-url maxlength="200" value="${escapeHtml(instance?.url || 'ws://127.0.0.1:3001')}" placeholder="ws://127.0.0.1:3001" />
          <div class="nc-field-help">NapCat 网络配置 → WebSocket 服务器 / 正向，常见地址 ws://127.0.0.1:3001。</div>
        </label>
        <div data-nc-inst-reverse-row hidden>
          <div class="nc-grid">
            <label class="nc-field">
              <span>反向 WebSocket 主机</span>
              <input data-nc-inst-host maxlength="64" value="${escapeHtml(instance?.host || '127.0.0.1')}" placeholder="127.0.0.1；远程接入可填 0.0.0.0" />
            </label>
            <label class="nc-field">
              <span>反向 WebSocket 端口</span>
              <input data-nc-inst-port type="number" min="0" max="65535" value="${Number(instance?.port) || 0}" placeholder="0 = 自动分配 6199 起" />
            </label>
          </div>
            <label class="nc-field">
              <span>反向 WebSocket 路径</span>
              <input data-nc-inst-path maxlength="120" value="${escapeHtml(instance?.path || '/ws')}" placeholder="/ws；和 NapCat 已有反向地址保持一致" />
            </label>
          <div class="nc-field-help">
            推荐主机 127.0.0.1 + 端口 0 + 路径 /ws。念风会自动从 6199 起选空闲端口并保存；保存后点「连接地址」复制给 NapCat 的「WebSocket 客户端」。
            要允许远程 NapCat 连接，主机可填 0.0.0.0（注意放行服务器防火墙端口）。
          </div>
        </div>
        <label class="nc-field">
          <span>访问令牌 / Token（可选；Forward 填 NapCat token，Reverse 留空即不启用）</span>
          <input data-nc-inst-token type="password" maxlength="200" value="" placeholder="${instance?.hasToken ? '已保存；留空表示不修改，勾选下方可清空' : 'Forward 填 NapCat 的 token；Reverse 可留空'}" />
        </label>
        ${
          editingInstance && instance?.mode === 'reverse' && instance?.hasToken
            ? '<div class="nc-checks"><label><input type="checkbox" data-nc-inst-clear-token /> 清空 Token（让 NapCat 保持不填 Token，兼容已有反向连接）</label></div>'
            : ''
        }
        <div class="nc-note" data-nc-inst-note>
          Forward 由念风主动连接 NapCat；Reverse 由 NapCat 的 WebSocket 客户端连到念风，适合云服务器 / 内网穿透。
        </div>
        <div class="nc-error" data-nc-inst-error hidden></div>
        <div class="nc-actions">
          <button class="outline-btn" data-nc-inst-cancel>取消</button>
          <button class="outline-btn primary-soft" data-nc-inst-save>${editingInstance ? '保存修改' : '创建并连接'}</button>
        </div>
      </div>`

    const modeSelect = overlay.querySelector('[data-nc-inst-mode]')
    const remarkInput = overlay.querySelector('[data-nc-inst-remark]')
    const urlRow = overlay.querySelector('[data-nc-inst-url-row]')
    const urlInput = overlay.querySelector('[data-nc-inst-url]')
    const reverseRow = overlay.querySelector('[data-nc-inst-reverse-row]')
    const hostInput = overlay.querySelector('[data-nc-inst-host]')
    const portInput = overlay.querySelector('[data-nc-inst-port]')
    const pathInput = overlay.querySelector('[data-nc-inst-path]')
    const tokenInput = overlay.querySelector('[data-nc-inst-token]')
    const clearTokenInput = overlay.querySelector('[data-nc-inst-clear-token]')
    const errorEl = overlay.querySelector('[data-nc-inst-error]')
    const close = () => {
      overlay?.remove()
      overlay = null
    }
    const setError = value => {
      errorEl.textContent = value || ''
      errorEl.hidden = !value
    }
    const syncMode = () => {
      const reverse = modeSelect.value === 'reverse'
      urlRow.hidden = reverse
      reverseRow.hidden = !reverse
    }
    modeSelect.addEventListener('change', syncMode)

    overlay.querySelector('[data-nc-inst-cancel]')?.addEventListener('click', close)
    overlay.querySelector('[data-nc-inst-save]')?.addEventListener('click', async () => {
      setError('')
      const mode = modeSelect.value === 'reverse' ? 'reverse' : 'forward'
      const url = String(urlInput.value || '').trim()
      if (mode === 'forward' && !url) return setError('Forward 模式需要填写 NapCat WebSocket 地址。')
      const token = String(tokenInput.value || '').trim()
      try {
        const body = {
          id: instance?.id || '',
          mode,
          url,
          host: mode === 'reverse' ? String(hostInput.value || '').trim() || '127.0.0.1' : '',
          port: mode === 'reverse' ? Math.max(0, Math.min(65535, Number(portInput.value) || 0)) : 0,
          path: mode === 'reverse' ? String(pathInput.value || '').trim() || '/ws' : '',
          remark: String(remarkInput.value || '').trim(),
          autoConnect: true,
          enabled: true,
        }
        if (clearTokenInput?.checked) body.accessToken = ''
        else if (!instance?.hasToken || token) body.accessToken = token
        const data = await bridgePost('/instances', body)
        if (data?.ok === false) throw new Error(data.error || '保存连接失败')
        await refreshInstances()
        toast.success(editingInstance ? 'NapCat 连接已更新' : 'NapCat 连接已创建')
        const id = data?.instance?.id || instance?.id
        close()
        onSaved?.(data?.instance || null)
        if (id && (data?.reused || mode === 'reverse')) {
          if (mode === 'reverse') await showEndpointModal(id)
        }
      } catch (err) {
        setError(err.message || String(err))
      }
    })
    overlay.addEventListener('mousedown', event => {
      if (event.target === overlay) close()
    })
    const onKeydown = event => {
      if (event.key === 'Escape') close()
    }
    document.addEventListener('keydown', onKeydown)
    closing.push(() => document.removeEventListener('keydown', onKeydown))
    document.body.appendChild(overlay)
    syncMode()
  }

  /* ---------------- 渠道详情 ---------------- */

  const formatTime = ts => {
    if (!ts) return '—'
    const date = new Date(ts)
    const pad = value => String(value).padStart(2, '0')
    return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
  }

  function detailHtml(channel, live = {}) {
    const role = roleOf(channel)
    const category = categoryOf(channel)
    const targetType = targetTypeOf(channel)
    const targetId = targetIdOf(channel)
    const permissions = permissionsOf(channel)
    const rules = groupRulesOf(channel)
    const conv = sessions.get(channel.meta?.conversationId)
    const instance = findInstance(instanceIdOf(channel))
    const status = instance?.status || channel.meta?.napcatStatus || 'offline'
    const statusLabel = STATUS_LABEL[status] || status
    const enabled = permissionMetaFor(category)
      .filter(([key]) => permissions[key] !== false)
      .map(([, label]) => label)
    const count = conv ? (sessions.messages(conv.id) || []).filter(m => m.kind !== 'divider').length : 0
    const peers = Array.isArray(live.peers) ? live.peers : []
    const shared = Number(instance?.channelIds?.length) || 0
    const lastError = instance?.error || channel.meta?.napcatError || ''
    const accountText = instance?.login?.userId
      ? `${instance.login.nickname || 'QQ'}（${instance.login.userId}）`
      : instance?.remark || '未获取到登录账号'
    const groupRulesHtml =
      category === 'group'
        ? `<div class="settings-section">
            <div class="settings-section-title">群聊规则</div>
            <div class="settings-card" style="padding:12px 14px">
              <div class="nc-kv">
                <span class="k">黑名单</span><span class="v">${escapeHtml(rules.blacklist.join('、') || '无')}（最高优先级，命中永不触发）</span>
                <span class="k">白名单</span><span class="v">${escapeHtml(rules.whitelist.join('、') || '无')} · 艾特${rules.whitelistForAt ? '应用' : '不应用'} · 概率${rules.whitelistForProbability ? '应用' : '不应用'}</span>
                <span class="k">触发方式</span><span class="v">${
                  rules.requireAt
                    ? `仅 @ 机器人时回复${rules.whitelistForAt ? '（且触发者需在白名单）' : ''}`
                    : `所有消息按 ${rules.replyProbability}% 概率回复${rules.whitelistForProbability ? '（且触发者需在白名单）' : ''}`
                }</span>
                <span class="k">引用回复</span><span class="v">${rules.quote ? '开启' : '关闭'}</span>
                <span class="k">艾特触发者</span><span class="v">${rules.mention ? '开启' : '关闭'}</span>
                <span class="k">静默上下文</span><span class="v">${rules.silentContext ? `开启（未触发也写入最近 ${groupContextMessagesOf(channel)} 条）` : '关闭（未触发不写入）'}</span>
              </div>
            </div>
          </div>`
        : ''
    const peerRows = peers.length
      ? peers
          .slice(0, 30)
          .map(item => `
            <div class="nc-row">
              <div class="nc-row-main">
                <div class="nc-row-name">
                  <span class="nc-tag ${item.type === 'group' ? '' : 'ok'}">${item.type === 'group' ? '群聊' : '私聊'}</span>
                  ${escapeHtml(item.name || (item.type === 'group' ? `群 ${item.peerId}` : `QQ ${item.peerId}`))}
                  ${item.bound ? '<span class="nc-tag ok">已是目标</span>' : ''}
                </div>
                <div class="nc-row-id">${escapeHtml(String(item.peerId))} · ${escapeHtml(item.lastText || '暂无消息')} · ${Number(item.count) || 0} 条 · ${escapeHtml(
                  formatTime(item.lastAt),
                )}</div>
              </div>
              <div class="nc-row-actions">
                <button class="outline-btn primary-soft" data-nc-action="new-peer" data-nc-peer-type="${escapeHtml(item.type)}" data-nc-peer-id="${escapeHtml(
                  String(item.peerId),
                )}" data-nc-peer-name="${escapeHtml(item.name || '')}" title="用同一个 NapCat 连接新建另一个渠道，目标就是这条会话">新建渠道</button>
                <button class="outline-btn" data-nc-action="use-peer" data-nc-peer-type="${escapeHtml(item.type)}" data-nc-peer-id="${escapeHtml(
                  String(item.peerId),
                )}" data-nc-peer-name="${escapeHtml(item.name || '')}" title="修改当前这个渠道的目标，不会新增渠道">设为本渠道目标</button>
              </div>
            </div>`)
          .join('')
      : '<div class="nc-empty">还没有发现会话。先让 QQ 联系人 / 群给这个机器人发一条消息，或点「刷新」拉取好友与群列表。</div>'

    return `
      <div class="nc-detail">
        <div class="nc-detail-head">
          <div class="nc-detail-avatar">${TYPE_ICON}</div>
          <div style="flex:1;min-width:0">
            <div class="nc-detail-name">${escapeHtml(channel.name || 'NapCat')}</div>
            <div class="nc-detail-sub">${escapeHtml(channel.id)} · ${escapeHtml(TAB_LABELS[category] || category)} · ${escapeHtml(
              SESSION_LABEL[targetType] || targetType,
            )} · ${escapeHtml(targetDisplayName(channel))} · ${escapeHtml(role?.name || '未绑定角色')}</div>
          </div>
          <span class="nc-badge"><span class="dot" style="width:8px;height:8px;border-radius:50%;background:${statusColor(status)}"></span>${escapeHtml(
            statusLabel,
          )}</span>
        </div>

        <div class="nc-detail-actions">
          <button class="outline-btn primary-soft" data-nc-action="connect">连接 / 刷新</button>
          ${instance && instance.status !== 'offline' ? '<button class="outline-btn" data-nc-action="disconnect">断开连接</button>' : ''}
          <button class="outline-btn" data-nc-action="edit">编辑渠道</button>
          ${conv ? '<button class="outline-btn" data-nc-action="open">打开聊天记录</button>' : ''}
          <button class="outline-btn" data-nc-action="refresh">刷新状态与发现</button>
          ${
            instance?.mode === 'reverse'
              ? '<button class="outline-btn" data-nc-action="endpoint">复制反向连接地址</button>'
              : ''
          }
          <button class="outline-btn" data-nc-action="settings">NapCat 连接设置</button>
        </div>
        ${lastError ? `<div class="nc-error" style="margin-top:12px">${escapeHtml(lastError)}</div>` : ''}

        <div class="settings-section" style="margin-top:18px">
          <div class="settings-section-title">渠道配置</div>
          <div class="settings-card" style="padding:14px 16px">
            <div class="nc-kv">
              <span class="k">使用角色</span><span class="v">${escapeHtml(role?.name || '未绑定（请在编辑渠道里选择）')}</span>
              <span class="k">渠道分类</span><span class="v">${escapeHtml(TAB_LABELS[category] || category)}</span>
              <span class="k">目标类型</span><span class="v">${escapeHtml(SESSION_LABEL[targetType] || targetType)}</span>
              <span class="k">目标 QQ / 群</span><span class="v">${escapeHtml(targetDisplayName(channel))} · ${escapeHtml(targetId)}</span>
              <span class="k">NapCat 连接</span><span class="v">${escapeHtml(instance?.remark || instanceIdOf(channel) || '未选择')}</span>
              <span class="k">机器人账号</span><span class="v">${escapeHtml(accountText)}</span>
              <span class="k">连接方式</span><span class="v">${escapeHtml(instance?.mode === 'reverse' ? 'Reverse WebSocket' : instance ? 'Forward WebSocket' : '—')}</span>
              ${
                instance?.mode === 'reverse'
                  ? `<span class="k">反向监听</span><span class="v">${escapeHtml(
                      `${instance.host || '127.0.0.1'}:${instance.port || 0}${instance.path || '/ws'}`,
                    )}${instance.port ? '' : '（等待分配）'}</span>`
                  : ''
              }
              <span class="k">连接状态</span><span class="v">${escapeHtml(statusLabel)}${instance?.versionInfo ? ` · ${escapeHtml(instance.versionInfo)}` : ''}</span>
              <span class="k">聊天记录</span><span class="v">${conv ? `${escapeHtml(conv.name)} · ${count} 条` : '接入后自动创建'}</span>
              <span class="k">权限</span><span class="v">${escapeHtml(enabled.join(' · ') || '仅基础权限')}</span>
              ${
                category === 'group'
                  ? ''
                  : `<span class="k">私聊身份</span><span class="v">${channel.meta?.identityMode === 'guest' ? '独立 QQ 用户' : '视为主人'}</span>`
              }
              ${category === 'group' ? `<span class="k">上下文</span><span class="v">本群最近 ${groupContextMessagesOf(channel)} 条消息（静默写入 ${rules.silentContext ? '开启' : '关闭'}）</span>` : ''}
            </div>
          </div>
        </div>

        ${groupRulesHtml}

        <div class="settings-section">
          <div class="settings-section-title">连接复用</div>
          <div class="settings-card" style="padding:12px 14px">
            <div class="nc-note">
              ${
                shared > 1
                  ? `当前 NapCat 连接同时被 <b>${shared}</b> 个渠道复用，念风只为它维持一条 WebSocket 连接。修改连接配置会影响所有这些渠道。`
                  : '当前只有一个渠道使用这个 NapCat 连接。后续创建的新渠道可以在这里直接复用，不需要重复连接 NapCat。'
              }
            </div>
          </div>
        </div>

        <div class="settings-section">
          <div class="settings-section-title">发现会话（点「设为目标」可切换本渠道目标）</div>
          <div class="settings-card" style="padding:12px 14px">
            ${peerRows}
          </div>
        </div>

        <div class="settings-section">
          <div class="settings-note">
            入站消息会写入本渠道并触发角色；群聊只使用本群最近若干条消息作为上下文（默认 20，可在群聊规则 / 通用设置里调整），未触发的消息也会静默写入。
            Forward 模式请确认 NapCat 已开启 WebSocket 服务；Reverse 模式请把连接地址填进 NapCat 的 WebSocket 客户端配置。
          </div>
        </div>
      </div>`
  }

  function mountDetail({ container, channel, onDispose }) {
    let live = {}
    const render = () => {
      const current = findChannel(channel.id) || channel
      container.innerHTML = detailHtml(current, live)
    }
    const refresh = async () => {
      if (!api) return
      try {
        const data = await bridgeGet(`/status?channelId=${encodeURIComponent(channel.id)}`)
        if (data?.status) {
          live = { ...live, ...data, peers: Array.isArray(data.peers) ? data.peers : live.peers || [] }
          const index = instances.findIndex(item => item.id === data.status.id)
          if (index >= 0) instances[index] = data.status
          else if (data.status?.id) instances.push(data.status)
          applyInstanceToChannels(data.status)
        }
      } catch (_) {
        /* 后端未就绪时保持本地状态 */
      }
      render()
    }
    const refreshDiscover = async () => {
      const instanceId = instanceIdOf(findChannel(channel.id) || channel)
      if (!instanceId || !api) return
      try {
        const data = await bridgeGet(`/discover?instanceId=${encodeURIComponent(instanceId)}`)
        live = { ...live, peers: Array.isArray(data?.peers) ? data.peers : [] }
        render()
      } catch (_) {
        /* ignore */
      }
    }
    const onClick = async event => {
      const button = event.target.closest?.('[data-nc-action]')
      if (!button) return
      const current = findChannel(channel.id) || channel
      const instanceId = instanceIdOf(current)
      const action = button.dataset.ncAction
      if (action === 'connect') {
        if (!instanceId) return toast.warn('这个渠道还没有绑定 NapCat 连接，请先编辑渠道。')
        try {
          await bridgePost(`/instances/${encodeURIComponent(instanceId)}/connect`, {})
          await refresh()
          toast.success('已请求连接 NapCat')
        } catch (err) {
          toast.error(`连接失败：${err.message}`)
        }
      } else if (action === 'disconnect') {
        if (!instanceId) return
        try {
          await bridgePost(`/instances/${encodeURIComponent(instanceId)}/disconnect`, { keepConfig: true })
          await refresh()
          toast.info('已断开该 NapCat 连接（配置保留）')
        } catch (err) {
          toast.error(`断开失败：${err.message}`)
        }
      } else if (action === 'refresh') {
        if (!instanceId) return
        try {
          const data = await bridgePost(`/instances/${encodeURIComponent(instanceId)}/refresh`, {})
          if (data?.status) {
            const index = instances.findIndex(item => item.id === data.status.id)
            if (index >= 0) instances[index] = data.status
            else instances.push(data.status)
            applyInstanceToChannels(data.status)
          }
          live = { ...live, peers: Array.isArray(data?.peers) ? data.peers : live.peers || [] }
          render()
          toast.info('已刷新 NapCat 状态与发现列表')
        } catch (err) {
          toast.error(`刷新失败：${err.message}`)
        }
      } else if (action === 'edit') {
        openSettings({ mode: 'edit', channel: current, onSaved: render })
      } else if (action === 'open') {
        openChannelRecords(current)
      } else if (action === 'endpoint') {
        if (instanceId) await showEndpointModal(instanceId)
      } else if (action === 'settings') {
        const manager = ctx.registry.get('plugin-manager')
        if (manager?.openSettings) manager.openSettings(name)
        else toast.info('可在「设置 → 插件 → NapCat → 设置」里管理连接')
      } else if (action === 'new-peer') {
        const peerType = button.dataset.ncPeerType === 'group' ? 'group' : 'private'
        const peerId = String(button.dataset.ncPeerId || '').trim()
        const peerName = String(button.dataset.ncPeerName || '').trim()
        if (!peerId) return
        const nextCategory = peerType === 'group' ? 'group' : 'private'
        openSettings({
          mode: 'create',
          tab: nextCategory,
          preset: { instanceId: instanceIdOf(current), targetType: peerType, targetId: peerId, targetName: peerName },
        })
      } else if (action === 'use-peer') {
        const peerType = button.dataset.ncPeerType === 'group' ? 'group' : 'private'
        const peerId = String(button.dataset.ncPeerId || '').trim()
        const peerName = String(button.dataset.ncPeerName || '').trim()
        if (!peerId) return
        const nextCategory = peerType === 'group' ? 'group' : categoryOf(current) === 'privacy' ? 'privacy' : 'private'
        const nextMeta = { ...(current.meta || {}), category: nextCategory, targetType: peerType, targetId: peerId, targetName: peerName || current.meta?.targetName || '' }
        const fromTab = findTab(current.id)
        let saved = null
        if (fromTab !== nextCategory) {
          const moved = channels.removeChannel(fromTab, current.id)
          if (moved) {
            const groups = channels.groups(nextCategory)
            const group = groups[0] || channels.addGroup(nextCategory, '我的渠道')
            saved = channels.addChannel(nextCategory, group.id, { ...moved, name: current.name, meta: nextMeta })
            channels.activate(nextCategory, saved.id)
          }
        } else {
          channels.updateChannel(fromTab, current.id, { meta: nextMeta })
          saved = findChannel(current.id) || current
        }
        if (!saved) return
        ensureConversation(saved)
        await syncChannelToBridge(saved, { notify: true })
        await refreshDiscover()
        render()
        toast.success(peerType === 'group' ? '已把该群设为本渠道目标' : '已把该 QQ 设为本渠道目标')
      }
    }
    container.addEventListener('click', onClick)

    const offs = [
      events.on('channel:updated', payload => {
        const id = payload?.channel?.id || payload?.id
        if (id === channel.id) render()
      }),
      events.on('channel:status', payload => {
        if (payload?.id === channel.id) render()
      }),
      events.on('napcat:changed', () => render()),
      events.on('napcat:instances', () => render()),
      events.on('napcat:discover', payload => {
        if (String(payload?.instanceId) === instanceIdOf(findChannel(channel.id) || channel)) {
          live = { ...live, peers: Array.isArray(payload.peers) ? payload.peers : live.peers || [] }
          render()
        }
      }),
      events.on('channel:sync', () => render()),
    ]
    const bootTimer = setTimeout(() => {
      refresh().catch(() => {})
      refreshDiscover().catch(() => {})
    }, 0)
    const statusTimer = setInterval(() => {
      const current = findChannel(channel.id) || channel
      if (current.status === 'connecting') refresh().catch(() => {})
    }, 4000)

    render()
    const cleanup = () => {
      clearTimeout(bootTimer)
      clearInterval(statusTimer)
      offs.forEach(off => off?.())
      container.removeEventListener('click', onClick)
    }
    onDispose?.(cleanup)
    return cleanup
  }

  const openChannelRecords = channel => {
    if (!isNapcatChannel(channel)) return
    ensureConversation(channel)
    const channelId = channelKey(channel.id)
    const settingsView = ctx.registry.get('settings-view')
    const settingsContainer = ctx.registry.get('settings-container')
    if (settingsView?.open) settingsView.open('chat-records')
    else settingsContainer?.open?.('chat-records')
    setTimeout(() => events.emit('chat-records:select', { channelId }), 0)
  }

  /* ---------------- 插件设置面板：连接管理 ---------------- */

  function instanceRowHtml(instance) {
    const status = STATUS_LABEL[instance.status] || instance.status || '未连接'
    const login = instance.login?.userId ? `${instance.login.nickname || 'QQ'}（${instance.login.userId}）` : '未获取到登录账号'
    const count = Array.isArray(instance.channelIds) ? instance.channelIds.length : 0
    return `
      <div class="plugin-panel-item">
        <div class="plugin-panel-item-main">
          <div class="plugin-panel-item-name">
            <span class="dot" style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${statusColor(instance.status)};margin-right:6px"></span>
            ${escapeHtml(instance.remark || instance.id)}
            <span class="plugin-tag">${escapeHtml(instance.mode === 'reverse' ? 'Reverse' : 'Forward')}</span>
            <span class="plugin-tag ${instance.status === 'online' ? '' : 'warn'}">${escapeHtml(status)}</span>
          </div>
          <div class="plugin-panel-item-desc">
            账号：${escapeHtml(login)} · 渠道：${count ? `${count} 个复用` : '暂无'} · ${
              instance.mode === 'forward'
                ? `Forward：${escapeHtml(instance.url || '—')}`
                : `Reverse 监听：${escapeHtml(`${instance.host || '127.0.0.1'}:${instance.port || 0}${instance.path || '/ws'}`)}${instance.port ? '' : '（等待分配）'}`
            }${instance.lastEventAt ? ` · 最后事件：${escapeHtml(formatTime(instance.lastEventAt))}` : ''}
          </div>
        </div>
        <div class="plugin-panel-item-actions" style="flex-wrap:wrap;justify-content:flex-end">
          <button class="outline-btn" data-nc-inst-action="connect" data-nc-inst-id="${escapeHtml(instance.id)}">连接</button>
          <button class="outline-btn" data-nc-inst-action="disconnect" data-nc-inst-id="${escapeHtml(instance.id)}">断开</button>
          <button class="outline-btn" data-nc-inst-action="refresh" data-nc-inst-id="${escapeHtml(instance.id)}">刷新</button>
          ${
            instance.mode === 'reverse'
              ? `<button class="outline-btn" data-nc-inst-action="endpoint" data-nc-inst-id="${escapeHtml(instance.id)}">连接地址</button>`
              : ''
          }
          <button class="outline-btn" data-nc-inst-action="edit" data-nc-inst-id="${escapeHtml(instance.id)}">编辑</button>
          <button class="outline-btn danger" data-nc-inst-action="delete" data-nc-inst-id="${escapeHtml(instance.id)}">删除</button>
        </div>
      </div>`
  }

  function registerPluginSettings() {
    const pluginManager = ctx.registry.get('plugin-manager')
    if (!pluginManager?.registerSettings) return
    const disposePanel = pluginManager.registerSettings({
      id: name,
      title: 'NapCat 渠道设置',
      description: '管理 NapCat / OneBot 连接池；一个登录 QQ 只需要一条连接，可被多个渠道复用。',
      render(container, helpers = {}) {
        const paint = () => {
          container.innerHTML = `
            <div class="plugin-panel-body">
              <div class="nc-note">
                NapCat 推荐开启 <b>WebSocket 服务</b>（Forward）：在 NapCat 网络配置里记下地址与 token，然后点击下方「新建连接」。
                也可以用 <b>Reverse 反向连接</b>：新建后在连接地址里复制网址，填到 NapCat 的 WebSocket 客户端配置。
              </div>
              <div style="display:flex;justify-content:flex-end;gap:8px">
                <button class="outline-btn primary-soft" data-nc-inst-add>＋ 新建 NapCat 连接</button>
              </div>
              <div class="plugin-panel-body" style="gap:8px">
                ${
                  instances.length
                    ? [...instances]
                        .sort((a, b) => (b.lastEventAt || 0) - (a.lastEventAt || 0) || String(a.id).localeCompare(String(b.id)))
                        .map(instanceRowHtml)
                        .join('')
                    : '<div class="plugin-panel-empty">还没有 NapCat 连接。点击「新建连接」连接本机 NapCat，或让 NapCat 反向连接到念风。</div>'
                }
              </div>
              <div class="nc-note">
                修改连接地址 / token 会立即重连；删除连接前需要先移除使用它的渠道。
              </div>
            </div>`
        }
        const onClick = async event => {
          const add = event.target.closest?.('[data-nc-inst-add]')
          if (add) {
            openInstanceDialog({ onSaved: () => { paint(); refreshInstances().then(() => paint()).catch(() => {}) } })
            return
          }
          const button = event.target.closest?.('[data-nc-inst-action]')
          if (!button) return
          const id = String(button.dataset.ncInstId || '')
          const action = button.dataset.ncInstAction
          const instance = findInstance(id)
          if (!instance) return
          try {
            if (action === 'connect') {
              await bridgePost(`/instances/${encodeURIComponent(id)}/connect`, {})
              await refreshInstances()
              applyInstanceToChannels(findInstance(id))
              paint()
              toast.success('已请求连接')
            } else if (action === 'disconnect') {
              await bridgePost(`/instances/${encodeURIComponent(id)}/disconnect`, {})
              await refreshInstances()
              applyInstanceToChannels(findInstance(id))
              paint()
              toast.info('已断开 NapCat 连接（配置保留）')
            } else if (action === 'refresh') {
              const data = await bridgePost(`/instances/${encodeURIComponent(id)}/refresh`, {})
              if (data?.status) {
                const index = instances.findIndex(item => item.id === data.status.id)
                if (index >= 0) instances[index] = data.status
                else instances.push(data.status)
                applyInstanceToChannels(data.status)
              }
              paint()
              toast.info('已刷新')
            } else if (action === 'edit') {
              openInstanceDialog({ instance, onSaved: () => { paint(); refreshInstances().then(() => paint()).catch(() => {}) } })
            } else if (action === 'endpoint') {
              await showEndpointModal(id)
            } else if (action === 'delete') {
              const modal = ctx.registry.get('modal')
              const confirmed = modal
                ? (await modal.confirm('删除 NapCat 连接', '只有没有渠道使用该连接时才能删除。配置删除后需要重新填写地址 / token。')).ok
                : true
              if (!confirmed) return
              await bridgeDel(`/instances/${encodeURIComponent(id)}`)
              await refreshInstances()
              paint()
              toast.warn('已删除 NapCat 连接')
            }
          } catch (err) {
            toast.error(err.message || String(err))
          }
        }
        container.addEventListener('click', onClick)
        const offs = [
          events.on('channel:add', paint),
          events.on('channel:removed', paint),
          events.on('channel:updated', paint),
          events.on('napcat:changed', paint),
          events.on('napcat:instances', paint),
        ]
        paint()
        return () => {
          offs.forEach(off => off?.())
          container.removeEventListener('click', onClick)
          container.innerHTML = ''
        }
      },
    })
    ctx.effect(() => () => disposePanel?.())
  }

  /* ---------------- 插件挂载 ---------------- */

  const registration = base.defineChannel({
    type: TYPE_ID,
    name: 'NapCat',
    color: TYPE_COLOR,
    icon: TYPE_ICON,
    description: 'NapCatQQ / OneBot 11 渠道：私聊、群聊、隐私、多 QQ 连接复用与群聊规则。',
    create: options => openSettings({ mode: 'create', ...(options || {}) }),
    detail: options => mountDetail(options),
    outbound: deliverOutbound,
  })
  ctx.effect(() => () => registration.dispose?.())

  registerPluginSettings()

  // 给其它插件使用的稳定接口：查询连接、监听 napcat:* 事件、直接发送 / 调用 OneBot action。
  ctx.provide(
    'napcat-channel',
    {
      name,
      version,
      listInstances: () => [...instances],
      instance: instanceId => findInstance(instanceId),
      rulesOf: channel => groupRulesOf(channel),
      decide: (channel, message) => triggerDecision(channel, message),
      targetOf: channel => ({ type: targetTypeOf(channel), id: targetIdOf(channel), name: targetDisplayName(channel) }),
      send: body => bridgePost('/send', body),
      action: (instanceId, action, params) => bridgePost(`/instances/${encodeURIComponent(instanceId)}/action`, { action, params }),
      refresh: instanceId => (instanceId ? bridgePost(`/instances/${encodeURIComponent(instanceId)}/refresh`, {}) : refreshInstances()),
    },
    { type: 'singleton' },
  )

  /* ---------------- 整轮结束 / 敏感确认 ---------------- */

  const offDone = events.on('chat:request-done', payload => {
    const finish = pendingTurns.get(payload?.conversationId)
    if (typeof finish === 'function') finish()
  })
  ctx.effect(offDone)

  const offConfirmBridge = events.on('chat:confirm-request', payload => {
    const conv = sessions.get(payload?.conversationId)
    if (!conv || conv.meta?.channelType !== TYPE_ID) return
    const channel = findChannel(conv.meta?.napcatChannelId)
    if (!channel || !api) return
    const lastInbound = [...(sessions.messages(conv.id) || [])]
      .reverse()
      .find(item => item.meta?.direction === 'inbound' && item.meta?.peerId)
    if (!lastInbound) return
    const actionText = payload.action === 'read' ? '读取另一个渠道的聊天记录' : '向另一个渠道发送消息'
    const targetName = payload.targetName || payload.targetChannel || '其它渠道'
    bridgePost('/send', {
      channelId: channel.id,
      targetType: targetTypeOf(channel),
      targetId: targetIdOf(channel),
      quoteMsgId: '',
      mentionUserId: '',
      text: `检测到敏感跨渠道操作（${actionText}：${targetName}）。如果同意，请直接回复“确认”；回复其它内容将视为拒绝。`,
    }).catch(() => {
      /* ignore */
    })
  })
  ctx.effect(offConfirmBridge)

  /* ---------------- 渠道删除 / 清理 ---------------- */

  const channelExists = channelId => {
    for (const tab of channels.tabs()) if (channels.findChannel(tab, channelId)) return true
    return false
  }
  const offRemoved = events.on('channel:removed', payload => {
    const removed = payload?.channel
    if (!isNapcatChannel(removed)) return
    setTimeout(() => {
      if (channelExists(removed.id)) return
      pruneOrphanConversations()
      removeChannelFromBridge(removed.id).catch(() => {})
    }, 0)
  })
  ctx.effect(offRemoved)

  let orphanPruneTimer = null
  const scheduleOrphanPrune = (delay = 1200) => {
    if (orphanPruneTimer) clearTimeout(orphanPruneTimer)
    orphanPruneTimer = setTimeout(() => {
      orphanPruneTimer = null
      try {
        pruneOrphanConversations()
      } catch (err) {
        ctx.logger?.warn?.(`[napcat] 清理孤立聊天记录失败：${err?.message || err}`)
      }
    }, delay)
  }
  const offChannelSync = events.on('channel:sync', () => scheduleOrphanPrune(300))
  ctx.effect(offChannelSync)
  scheduleOrphanPrune(1500)
  ctx.effect(() => {
    if (orphanPruneTimer) clearTimeout(orphanPruneTimer)
  })

  ctx.effect(() => () => {
    if (inboxPollTimer) {
      clearInterval(inboxPollTimer)
      inboxPollTimer = null
    }
    if (backendEvents) {
      try {
        backendEvents.close()
      } catch (_) {
        /* ignore */
      }
      backendEvents = null
    }
    for (const cleanup of closing.splice(0)) {
      try {
        cleanup()
      } catch (_) {
        /* ignore */
      }
    }
  })

  /* ---------------- 启动 ---------------- */

  const boot = async () => {
    ensureBackendEvents()
    await refreshInstances()
    applyInstancesToChannels(instances)
    const drains = []
    for (const tab of channels.tabs()) {
      for (const channel of channels.channels(tab)) {
        if (!isNapcatChannel(channel)) continue
        try {
          ensureConversation(channel)
        } catch (_) {
          /* ignore */
        }
        if (!instanceIdOf(channel)) continue
        await syncChannelToBridge(channel)
        await refreshChannelStatus(channel)
        drains.push(drainInbox(channel).catch(() => {}))
      }
    }
    await Promise.allSettled(drains)
    bootFinished = true
    if (pendingOpenDrain) {
      pendingOpenDrain = false
      drainAllInboxes().catch(err => ctx.logger?.warn?.(`[napcat] 启动后补收消息失败：${err?.message || err}`))
    }
    pruneBridgeChannels().catch(() => {})
    if (!inboxPollTimer) {
      inboxPollTimer = setInterval(() => {
        if (!bootFinished) return
        // EventSource 处于 CLOSED 时浏览器通常会自动重连；这里兜底重建，避免只剩轮询。
        if (backendEvents && typeof EventSource !== 'undefined' && backendEvents.readyState === EventSource.CLOSED) {
          try { backendEvents.close() } catch (_) { /* ignore */ }
          backendEvents = null
          ensureBackendEvents()
        }
        drainAllInboxes().catch(() => {})
      }, 60000)
      inboxPollTimer?.unref?.()
    }
  }
  const bootTimer = setTimeout(() => {
    boot().catch(err => ctx.logger?.warn?.(`[napcat] 启动同步失败：${err?.message || err}`))
  }, 700)
  ctx.effect(() => () => clearTimeout(bootTimer))

  ctx.logger?.debug?.('NapCatQQ 渠道插件就绪')
}
