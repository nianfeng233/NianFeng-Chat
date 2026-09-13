/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目：念风 Chat（NianFeng-Chat）
 *
 * QQ 官方机器人渠道插件。
 *
 * 安装后会在「渠道 → 添加渠道」里注册“QQ官方机器人”类型：
 *   1. 添加渠道时选择角色、渠道分类（私聊 / 隐私）；QQ 官方机器人当前仅支持私聊（C2C）；
 *   2. 支持“扫码接入”（q.qq.com 官方绑定接口）与“手动 AppID/AppSecret”两种方式；
 *   3. 渠道只绑定一个 QQ 私聊 openid，避免同一机器人的多个会话串线；
 *   4. 入站消息写入所选角色的 qqbot 渠道聊天记录，并走念风完整模型链路；
 *   5. 模型整轮调用（含工具调用与全部回复消息）结束后，才把回复作为被动消息发回 QQ。
 *
 * 后端桥接代码在同目录 bridge.mjs，由 server/index.mjs 自动加载。
 */
import { useStyle } from '../../../src/util/style.mjs'
import { escapeHtml } from '../../../src/util/format.mjs'
import { resolveUserNickname } from '../../../src/util/identity.mjs'
import { QQBOT_CSS } from './style.mjs'
import { renderQrSvg, isQrImageContent } from './qrcode.mjs'

export const name = 'qqbot'
export const version = '1.2.1'
export const displayName = 'QQ官方机器人'
export const description = '渠道插件 · QQ 官方机器人扫码/凭据接入、本地沙箱免白名单、私聊绑定与被动回复。'
export const author = '念风插件'
export const icon = '🐧'
export const core = false
export const depends = {
  'channel-base': '>=1.0.0',
  'channel-detail-host': '^3.0.0',
  'channel-list': '>=1.0.0',
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
export const provides = []
export const permissions = ['network']

const TYPE_ID = 'qqbot'
const TYPE_COLOR = '#12b7f5'
const TYPE_ICON = '🐧'
const TAB_LABELS = { private: '私聊', group: '群聊', privacy: '隐私' }
const TAB_ORDER = ['private', 'group', 'privacy']
const SESSION_TYPES = [{ id: 'c2c', label: 'QQ 私聊（C2C）', help: '当前仅支持私聊' }]
const SESSION_LABEL = { c2c: 'QQ私聊', group: 'QQ群聊' }
const CATEGORY_SESSION = { private: 'c2c', group: 'c2c', privacy: 'c2c' }
const CATEGORY_OPTIONS = [
  ['private', '私聊（参与角色工作记忆）'],
  ['privacy', '隐私（独立单会话，不与其他渠道交互）'],
]
const DEFAULT_PERMISSIONS = {
  read: true,
  reply: true,
  context: true,
  crossRead: false,
  crossSend: false,
  confirm: true,
}
const PERMISSION_META = [
  ['read', '接收消息', '把 QQ 消息写入角色上下文'],
  ['reply', '自动回复', '模型生成后作为被动消息发回 QQ'],
  ['context', '参与工作记忆', '私聊渠道消息参与角色级工作记忆'],
  ['crossRead', '跨渠道读取', '允许该角色读取其它渠道记录'],
  ['crossSend', '跨渠道发送', '允许向其它渠道发送消息'],
  ['confirm', '敏感操作确认', '跨渠道等敏感操作需要二次确认'],
]
const STATUS_LABEL = { online: '已接入', connecting: '连接中', offline: '未连接', error: '异常' }
const STATUS_COLOR = { online: '#70a15a', connecting: '#c9a227', offline: '#b3b9c2', error: '#c65b5b' }
const PASSIVE_HINT =
  'QQ 被动回复：官方窗口口径不一致，插件总是先带 msg_id 尝试被动回复；窗口失效或同一条消息超过 5 次时，会自动改发主动消息（是否成功仍取决于 QQ 官方额度）。'

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

  useStyle(ctx, QQBOT_CSS)

  /** conversationId -> resolve，等 chat-flow 整轮完成 */
  const pendingTurns = new Map()
  /** conversationId -> 本轮入站上下文（外发时用于 sessionType / peerId / msg_id 解析） */
  const activeTurns = new Map()
  /** conversationId -> 串行 Promise，保证同一渠道消息按顺序处理 */
  const busyChains = new Map()
  /** channelId -> Set(messageId)，页面内去重（SSE 与 inbox 可能同时到达） */
  const handledInbound = new Map()
  const closing = []
  let backendEvents = null

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
  const isQQChannel = channel => channel?.type === TYPE_ID
  const permissionsOf = channel => ({ ...DEFAULT_PERMISSIONS, ...(channel?.meta?.permissions || {}) })
  const statusClickColor = status => STATUS_COLOR[status] || STATUS_COLOR.offline
  const categoryOf = channel => channel?.meta?.category || 'private'
  // 当前范围：QQ 官方机器人只做私聊（C2C）；历史渠道即使残留 sessionType=group，
  // 也统一按 c2c 过滤，避免群消息误入。
  const sessionTypeOf = channel => 'c2c'
  const bindingsOf = channel => (Array.isArray(channel?.meta?.bindings) ? channel.meta.bindings : [])
  const bindingLabel = binding => {
    const alias = String(binding?.alias || '').trim()
    const id = String(binding?.peerId || '')
    const tail = id.length > 8 ? `…${id.slice(-6)}` : id
    return `${SESSION_LABEL[binding?.sessionType] || binding?.sessionType || '会话'} · ${alias || tail || '未命名'}`
  }
  const roleOf = channel => sessions.get(channel?.meta?.roleId) || null

  /**
   * 只把「真正的角色会话」列进角色选择框。
   *
   * chat-store 会把普通会话登记成 Nova 网页渠道（channelType=nova、
   * channelId=nova:web:<会话id>），它们就是角色；而 wechat-clawbot / qqbot
   * 等渠道的聊天记录容器会带自己的 channelType / channelId 与隐藏标记，
   * 绝不能出现在角色下拉框里（之前旧页面只排除了本渠道前缀，导致把微信
   * clawbot 的渠道记录也当成角色列出来）。
   */
  const isRoleConversation = conv => {
    const meta = conv?.meta || {}
    if (meta.channelConversation === true || meta.hiddenFromSessionList === true) return false
    const channelType = String(meta.channelType || '')
    const channelId = String(meta.channelId || '')
    // 还没有任何渠道元数据的普通会话：角色创建的初始状态，正常可选。
    if (!channelType && !channelId) return true
    // Nova 网页会话是角色本体，允许；其它 channelType（clawbot/qqbot/...）都不是角色。
    if (channelType && channelType !== 'nova') return false
    if (channelId && !channelId.startsWith('nova:web:')) return false
    return true
  }

  const roleOptions = (selectedId = '') => {
    const list = sessions.list().filter(isRoleConversation)
    // 正在编辑的渠道若绑定了一个旧数据里的角色，保证它仍然出现在选项里，避免值被重置。
    if (selectedId && !list.some(conv => conv.id === selectedId)) {
      const selected = sessions.get(selectedId)
      if (selected) list.unshift(selected)
    }
    return list
      .map(conv => `<option value="${escapeHtml(conv.id)}" ${conv.id === selectedId ? 'selected' : ''}>${escapeHtml(conv.name || conv.id)}</option>`)
      .join('')
  }

  /** 渠道身份：默认跟随念风网页端；私聊渠道可把绑定的 openid 视为同一位主人。 */
  const channelIdentity = channel => {
    const shared = ctx.registry.get('user-identity')?.get?.() || {}
    const fallbackUserId = String(shared.userId || config.get('chat.userId', 'web-user') || 'web-user').trim() || 'web-user'
    const fallbackUserName = String(shared.userName || resolveUserNickname(config)).trim() || resolveUserNickname(config)
    return {
      userId: String(channel?.meta?.identity?.userId || '').trim() || fallbackUserId,
      userName: String(channel?.meta?.identity?.userName || '').trim() || fallbackUserName,
    }
  }

  /** 前端调用后端桥（/api/qqbot/*）的薄封装。 */
  const bridgeGet = (path, options) => (api ? api.get(`/qqbot${path}`, options) : Promise.reject(new Error('本地后端未连接')))
  const bridgePost = (path, body, options) => (api ? api.post(`/qqbot${path}`, body, options) : Promise.reject(new Error('本地后端未连接')))

  /* ---------------- 渠道会话容器 ---------------- */

  const bindingSummary = channel => {
    const list = bindingsOf(channel)
    if (!list.length) return '未绑定（等待首次消息或手动指定）'
    return list.map(bindingLabel).join('、')
  }

  /** 渠道 -> 独立会话（角色在渠道里的聊天记录容器） */
  function ensureConversation(channel) {
    if (!isQQChannel(channel)) return null
    const role = roleOf(channel)
    const roleId = channel.meta?.roleId || role?.meta?.roleId || role?.id || channel.id
    const category = categoryOf(channel)
    const permissions = permissionsOf(channel)
    const identity = channelIdentity(channel)
    const sessionType = sessionTypeOf(channel)
    let conv = sessions.get(channel.meta?.conversationId)
    const firstBinding = bindingsOf(channel)[0]
    const suffix = firstBinding ? `（${bindingLabel(firstBinding)}）` : ''
    const metaPatch = {
      channelId: channelKey(channel.id),
      channelType: TYPE_ID,
      channelGroup: category,
      source: 'qqbot',
      roleId,
      qqbotChannelId: channel.id,
      hiddenFromSessionList: true,
      channelConversation: true,
      identityUserId: identity.userId,
      identityUserName: identity.userName,
      participatesWorkingMemory: category === 'private' && permissions.context !== false,
      crossReadable: permissions.crossRead === true,
      crossSendable: permissions.crossSend === true,
      sensitiveConfirm: permissions.confirm !== false,
      qqSessionType: sessionType,
      trustedConfirmIds: Array.isArray(channel.meta?.trustedUserIds) ? channel.meta.trustedUserIds : [],
      persona: role?.meta?.persona ?? conv?.meta?.persona ?? '',
      model: role?.meta?.model ?? conv?.meta?.model ?? '',
      avatarImage: role?.meta?.avatarImage ?? conv?.meta?.avatarImage ?? '',
    }
    if (!conv) {
      conv = sessions.create({
        name: `${role?.name || '角色'} · ${SESSION_LABEL[sessionType] || 'QQ'}${suffix}`,
        avatar: role?.avatar || (role?.name || 'Q').slice(0, 1),
        c1: role?.c1,
        c2: role?.c2,
        preview: `${role?.name || '角色'} 的 QQ 官方机器人渠道 · ${bindingSummary(channel)}`,
        meta: metaPatch,
      })
      channels.updateChannel(findTab(channel.id), channel.id, {
        meta: { ...(channel.meta || {}), conversationId: conv.id },
      })
    } else {
      sessions.update(conv.id, {
        name: conv.name || `${role?.name || '角色'} · ${SESSION_LABEL[sessionType] || 'QQ'}`,
        preview: conv.preview || `${role?.name || '角色'} 的 QQ 官方机器人渠道`,
        meta: { ...(conv.meta || {}), ...metaPatch },
      })
    }
    try {
      store?.channelForConversation?.(conv.id)
    } catch (_) {
      /* chat-store 未就绪时忽略 */
    }
    return conv
  }

  /** 渠道删除 / 启动后清理已经没有对应渠道的 QQ 聊天记录容器。 */
  function pruneOrphanConversations() {
    const tabs = typeof channels.tabs === 'function' ? channels.tabs() : []
    const known = new Set()
    for (const tab of tabs) {
      for (const channel of channels.channels(tab)) {
        if (isQQChannel(channel)) known.add(String(channel.id || ''))
      }
    }
    for (const conv of sessions.list()) {
      if (conv?.meta?.channelType !== TYPE_ID) continue
      const owner = String(conv.meta.qqbotChannelId || '')
      const rawKey = String(conv.meta.channelId || '')
      const keyed = rawKey.startsWith(`${TYPE_ID}:`) ? rawKey.slice(TYPE_ID.length + 1) : ''
      if (owner && known.has(owner)) continue
      if (!owner && keyed && known.has(keyed)) continue
      if (!owner && !keyed) continue
      sessions.remove(conv.id)
    }
  }

  /* ---------------- 后端状态 ---------------- */

  const markChanged = () => events.emit('qqbot:changed', {})

  function updateChannelFromStatus(data) {
    if (!data) return
    let channel = data.channelId ? findChannel(data.channelId) : null
    if (!channel && data.accountId) {
      // 账号级状态：广播给所有引用该账号的渠道；已经被用户断开的渠道保持离线。
      for (const tab of channels.tabs()) {
        for (const item of channels.channels(tab)) {
          if (item?.meta?.accountId && String(item.meta.accountId) === String(data.accountId)) {
            updateChannelFromStatus({
              ...data,
              channelId: item.id,
              channelDisabled: data.channelDisabled === true || item.meta?.channelDisabled === true,
            })
          }
        }
      }
      return
    }
    if (!channel) return
    const channelDisabled = data.channelDisabled === true || (data.channelDisabled === undefined && channel.meta?.channelDisabled === true)
    const mapped = channelDisabled
      ? 'offline'
      : data.status === 'online'
        ? 'online'
        : data.status === 'offline' || data.status === 'idle'
          ? 'offline'
          : data.status === 'error'
            ? 'error'
            : 'connecting'
    const nextMeta = {
      ...(channel.meta || {}),
      channelDisabled,
      qqbotStatus: channelDisabled ? 'offline' : data.status || mapped,
      accountId: data.accountId || channel.meta?.accountId || '',
      appId: data.appId || channel.meta?.appId || '',
      botName: data.bot?.username || channel.meta?.botName || '',
      botAvatar: data.bot?.avatar || '',
      lastError: data.error || '',
      transport: data.transport || channel.meta?.transport || 'ws',
      sandbox: data.sandbox === true,
      sandboxFallback: data.sandboxFallback === true,
    }
    const bindings = Array.isArray(data.bindings) ? data.bindings : null
    if (bindings) nextMeta.bindings = bindings
    if (typeof data.autoBind === 'boolean') nextMeta.bindingMode = data.autoBind ? 'auto' : 'manual'
    const unchanged =
      channel.status === mapped &&
      (channel.meta?.channelDisabled === true) === channelDisabled &&
      (channel.meta?.qqbotStatus || '') === nextMeta.qqbotStatus &&
      (channel.meta?.accountId || '') === nextMeta.accountId &&
      (channel.meta?.appId || '') === nextMeta.appId &&
      (channel.meta?.botName || '') === nextMeta.botName &&
      (channel.meta?.transport || '') === nextMeta.transport &&
      (channel.meta?.lastError || '') === nextMeta.lastError &&
      channel.meta?.sandbox === nextMeta.sandbox &&
      channel.meta?.sandboxFallback === nextMeta.sandboxFallback &&
      JSON.stringify(channel.meta?.bindings || []) === JSON.stringify(nextMeta.bindings || [])
    if (unchanged) return
    channels.updateChannel(findTab(channel.id), channel.id, { status: mapped, meta: nextMeta })
    markChanged()
  }

  async function refreshChannelStatus(channel) {
    if (!api || !channel) return null
    try {
      const data = await bridgeGet(`/login/status?channelId=${encodeURIComponent(channel.id)}`)
      if (data) updateChannelFromStatus(data)
      return data
    } catch (_) {
      return null
    }
  }

  /** 把前端渠道 meta 里的绑定关系同步给后端（后端需要它才能正确路由事件）。 */
  async function syncChannelToBridge(channel, { notify = false } = {}) {
    if (!api || !isQQChannel(channel)) return null
    const meta = channel.meta || {}
    if (!meta.appId && !meta.accountId) return null
    try {
      const data = await bridgePost('/bind', {
        channelId: channel.id,
        accountId: meta.accountId || undefined,
        appId: meta.appId || undefined,
        sessionType: sessionTypeOf(channel),
        autoBind: meta.bindingMode !== 'manual',
        intents: 0,
        trustedUserIds: Array.isArray(meta.trustedUserIds) ? meta.trustedUserIds : [],
        bindings: bindingsOf(channel).map(item => ({
          sessionType: item.sessionType,
          peerId: item.peerId,
          alias: item.alias || '',
          identityMode: item.identityMode || (item.sessionType === 'c2c' ? 'owner' : 'member'),
          auto: item.auto === true,
          boundAt: item.boundAt,
        })),
      })
      if (data) updateChannelFromStatus(data)
      if (notify && data?.ok === false && data?.code === 'NO_ACCOUNT') {
        toast.warn('后端还没有这个 QQ 机器人的登录信息，请先点「接入」。')
      }
      return data
    } catch (err) {
      if (notify) toast.error(`同步 QQ 渠道绑定失败：${err.message}`)
      return null
    }
  }

  async function drainInbox(channel) {
    if (!api) return
    try {
      const data = await bridgeGet(`/inbox?channelId=${encodeURIComponent(channel.id)}`)
      for (const message of data?.messages || []) await handleInbound({ channelId: channel.id, message })
    } catch (_) {
      /* 后端未就绪时忽略 */
    }
  }

  /* ---------------- 后端 SSE（插件自带订阅，不改 backend-client） ---------------- */

  function ensureBackendEvents() {
    if (backendEvents || !api || typeof EventSource === 'undefined') return
    try {
      const source = new EventSource(`${api.baseUrl()}/events`)
      const forward = type => event => {
        let data = null
        try {
          data = event.data ? JSON.parse(event.data) : null
        } catch (_) {
          data = null
        }
        if (type === 'qqbot:message') handleInbound(data).catch(() => {})
        else if (type === 'qqbot:member') handleMemberUpdate(data)
        else if (type === 'qqbot:status') {
          updateChannelFromStatus(data)
          if (data?.channelId && data?.status === 'online') {
            const channel = findChannel(data.channelId)
            if (channel) drainInbox(channel).catch(() => {})
          }
        } else if (type === 'qqbot:discover') {
          markChanged()
        }
      }
      for (const type of ['qqbot:message', 'qqbot:member', 'qqbot:status', 'qqbot:discover']) source.addEventListener(type, forward(type))
      backendEvents = source
    } catch (_) {
      backendEvents = null
    }
  }

  /* ---------------- 身份映射 ---------------- */

  const shortId = id => {
    const value = String(id || '')
    return value.length > 6 ? `…${value.slice(-6)}` : value
  }

  const cssEscape = value => {
    const text = String(value ?? '')
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(text)
    return text.replace(/["\\\]\[]/g, '\\$&')
  }

  function senderIdentityFor(channel, message, binding) {
    const identity = channelIdentity(channel)
    if (message.sessionType === 'c2c') {
      const mode = binding?.identityMode || 'owner'
      if (mode === 'owner') return { userId: identity.userId, userName: identity.userName }
      return {
        userId: `qq:${message.senderId || message.peerId}`,
        userName: String(binding?.alias || '').trim() || `QQ用户·${shortId(message.senderId || message.peerId)}`,
      }
    }
    const memberName = String(message.senderName || '').trim() || `QQ成员·${shortId(message.senderId)}`
    const groupAlias = String(binding?.alias || '').trim()
    return {
      userId: `qq:${message.sessionType}:${message.senderId || message.peerId}`,
      userName: groupAlias ? `${groupAlias}·${memberName}` : memberName,
    }
  }

  /* ---------------- QQ 消息 -> 角色模型 -> QQ ---------------- */

  const buildOutboundText = message => {
    if (!message) return ''
    if (message.kind === 'document') {
      const title = message.meta?.title || message.content || '资料'
      const summary = message.meta?.summary || ''
      return [`【资料】${title}`, summary].filter(Boolean).join('\n')
    }
    return String(message.content || '').trim()
  }

  const splitForQQ = (text, max = 1800) => {
    const value = String(text || '').trim()
    if (!value) return []
    const parts = []
    let current = ''
    for (const line of value.split('\n')) {
      const next = current ? `${current}\n${line}` : line
      if (next.length <= max) {
        current = next
        continue
      }
      if (current) parts.push(current)
      let rest = line
      while (rest.length > max) {
        parts.push(rest.slice(0, max))
        rest = rest.slice(max)
      }
      current = rest
    }
    if (current) parts.push(current)
    // 被动回复同一条消息最多 5 次；超出时合并最后几段，避免整段丢失。
    if (parts.length <= 5) return parts
    const head = parts.slice(0, 4)
    const tail = parts.slice(4).join('\n')
    head.push(tail.length > max ? `${tail.slice(0, max - 1)}…` : tail)
    return head
  }

  async function ackInbox(channelId, ids) {
    if (!api || !ids?.length) return
    try {
      await bridgePost('/inbox/ack', { channelId, ids })
    } catch (_) {
      /* ignore */
    }
  }

  /** 解析外发需要的会话类型 / peer / 被动回复 msg_id。 */
  function resolveOutboundTarget(channel, conversationId) {
    const active = activeTurns.get(conversationId)
    if (active && String(active.channel?.id || '') === String(channel.id)) {
      return {
        sessionType: active.message.sessionType,
        peerId: active.message.peerId,
        msgId: active.message.qqMessageId || '',
        eventId: active.message.eventId || '',
      }
    }
    const lastInbound = [...(sessions.messages(conversationId) || [])]
      .reverse()
      .find(item => item.meta?.direction === 'inbound' && item.meta?.peerId)
    if (lastInbound) {
      return {
        sessionType: lastInbound.meta.sessionType || 'private',
        peerId: lastInbound.meta.peerId,
        msgId: lastInbound.meta.qqMessageId || '',
        eventId: lastInbound.meta.qqEventId || '',
      }
    }
    const binding = bindingsOf(channel)[0]
    if (binding) {
      return {
        sessionType: binding.sessionType || 'private',
        peerId: binding.peerId,
        msgId: '',
        eventId: '',
      }
    }
    return null
  }

  /**
   * 即时外发：消息写入渠道会话后立刻发送，不再等整轮结束。
   * 有被动 msg_id 时先走被动回复；窗口失效 / 次数用尽自动改发主动消息，
   * 不再需要用户额外开启权限开关（实际能否发出仍受 QQ 官方额度限制）。
   */
  async function deliverOutbound({ channel, conversationId, message }) {
    const target = resolveOutboundTarget(channel, conversationId)
    if (!target) return { ok: false, error: 'QQ 官方机器人渠道还没有可用的目标会话，无法外发' }
    const payloadBase = {
      channelId: channel.id,
      sessionType: target.sessionType,
      peerId: target.peerId,
      msgId: target.msgId,
      eventId: target.eventId,
    }
    const preferActive = !payloadBase.msgId
    const errors = []
    let sent = false
    let lastResult = null
    for (const segment of splitForQQ(buildOutboundText(message))) {
      if (!segment) continue
      const payload = { ...payloadBase, text: segment }
      let result = await bridgePost('/send', { ...payload, active: preferActive })
      if (result?.ok === false && ['PASSIVE_EXPIRED', 'PASSIVE_LIMIT'].includes(result.code)) {
        result = await bridgePost('/send', { ...payload, msgId: '', active: true })
      }
      if (result?.ok === false) {
        errors.push(result.error || '文本发送失败')
        continue
      }
      sent = true
      lastResult = result
    }
    const images = Array.isArray(message.meta?.images) ? message.meta.images.slice(0, 4) : []
    if (images.length) {
      const payload = { ...payloadBase, text: '', images }
      let result = await bridgePost('/send', { ...payload, active: preferActive })
      if (result?.ok === false && ['PASSIVE_EXPIRED', 'PASSIVE_LIMIT'].includes(result.code)) {
        result = await bridgePost('/send', { ...payload, msgId: '', active: true })
      }
      if (result?.ok === false) errors.push(result.error || '图片发送失败')
      else {
        sent = true
        lastResult = result
      }
    }
    if (!sent && errors.length) return { ok: false, error: errors.join('；') }
    messages?.update?.(conversationId, message.id, {
      source: 'qqbot',
      meta: {
        ...(message.meta || {}),
        via: 'qqbot',
        direction: 'outbound',
        sessionType: target.sessionType,
        peerId: target.peerId,
        qqMessageId: target.msgId,
        msgSeq: lastResult?.msgSeq || 0,
        outboundMode: lastResult?.mode || 'passive',
        ...(images.length && sent ? { imagesSent: true } : {}),
        ...(errors.length ? { outboundError: errors.join('；') } : { outboundError: '' }),
      },
    })
    return errors.length ? { ok: true, warning: errors.join('；') } : { ok: true }
  }

  async function runInboundTurn(channel, conv, message, binding, permissions) {
    activeTurns.set(conv.id, { channel, message, binding, permissions })
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
          else events.emit('message:send', { conversationId: conv.id, text: message.text, skipUserAppend: true })
        } catch (_) {
          finish()
        }
      })
      await base.outboundIdle?.(conv.id)
    } finally {
      const current = activeTurns.get(conv.id)
      if (!current || String(current.channel?.id || '') === String(channel.id)) activeTurns.delete(conv.id)
    }
  }

  /** 群成员昵称 best-effort 回填：把同 openid 的历史用户消息显示名更新掉。 */
  function handleMemberUpdate(payload) {
    const memberId = String(payload?.memberId || '')
    const name = String(payload?.name || '').trim()
    if (!memberId || !name) return
    const channelIds = []
    if (payload?.channelId) channelIds.push(payload.channelId)
    else {
      for (const tab of channels.tabs()) {
        for (const item of channels.channels(tab)) {
          if (isQQChannel(item) && item.meta?.accountId && String(item.meta.accountId) === String(payload?.accountId)) channelIds.push(item.id)
        }
      }
    }
    for (const channelId of channelIds) {
      const channel = findChannel(channelId)
      const convId = channel?.meta?.conversationId
      if (!channel || !isQQChannel(channel) || !convId) continue
      for (const message of sessions.messages(convId) || []) {
        if (
          message.role === 'user' &&
          String(message.meta?.senderOpenid || '') === memberId &&
          (!message.sender_name || String(message.sender_name).startsWith('QQ成员'))
        ) {
          messages?.update?.(convId, message.id, {
            sender_name: name,
            meta: { ...(message.meta || {}), memberName: name },
          })
        }
      }
    }
    markChanged()
  }

  async function handleInbound(payload) {    const channelId = payload?.channelId
    // 服务端常驻代聊已接管时，WebUI 只负责展示，不再重复处理入站消息。
    if (api?.supports?.('server-agent') && globalThis.__NIANFENG_SERVER_AGENT__ !== true) return
    const message = payload?.message
    if (!channelId || !message?.id || !message?.text) return
    const channel = findChannel(channelId)
    if (!isQQChannel(channel)) return

    let seen = handledInbound.get(channelId)
    if (!seen) {
      seen = new Set()
      handledInbound.set(channelId, seen)
    }
    if (seen.has(message.id)) return
    seen.add(message.id)
    if (seen.size > 500) {
      const first = seen.values().next().value
      seen.delete(first)
    }

    // 防御性过滤：桥已经按绑定路由，这里再校验一次会话类型与绑定，避免串线。
    const expected = sessionTypeOf(channel)
    if (expected && message.sessionType !== expected) return
    const bindings = bindingsOf(channel)
    const binding = bindings.find(item => item.sessionType === message.sessionType && String(item.peerId) === String(message.peerId))
    if (bindings.length && !binding) return

    const conv = ensureConversation(channel)
    if (!conv) return

    const sender = senderIdentityFor(channel, message, binding)
    // 敏感操作确认权限：
    // - 私聊“主人身份”：默认由主人（网页端统一身份）确认；
    // - 私聊“访客身份”：只有渠道里显式信任的 openid 才能确认，其他人“确认”会被无视且不消费 pending。
    // （群聊已不在当前范围，这里保留兼容分支。）
    const trustedIds = Array.isArray(channel.meta?.trustedUserIds)
      ? channel.meta.trustedUserIds.map(item => String(item || '').trim()).filter(Boolean)
      : []
    const trustedForSender = trustedIds.map(id => (id.startsWith('qq:') ? id : `qq:${id}`))
    const trustedForGroup = trustedIds.map(id => (id.startsWith('qq:') ? id : `qq:group:${id}`))
    const confirmContext =
      message.sessionType === 'group'
        ? { senderId: String(sender.userId || ''), allowedUserIds: trustedForGroup }
        : (binding?.identityMode || 'owner') === 'guest'
          ? { senderId: sender.userId, allowedUserIds: trustedForSender }
          : { senderId: sender.userId, allowedUserIds: [sender.userId].filter(Boolean), owner: true }
    const chatPermissions = ctx.registry.get('chat-permissions')
    const pendingConfirm = chatPermissions?.resolvePending?.(conv.id, message.text, confirmContext)
    if (pendingConfirm?.handled) {
      await ackInbox(channel.id, [message.id])
      return
    }

    const permissions = permissionsOf(channel)
    if (store?.append) {
      store.append(conv.id, {
        role: 'user',
        content: message.text,
        sender_id: sender.userId,
        sender_name: sender.userName,
        source: 'qqbot',
        meta: {
          via: 'qqbot',
          direction: 'inbound',
          qqbotChannelId: channel.id,
          sessionType: message.sessionType,
          peerId: message.peerId,
          senderOpenid: message.senderId,
          qqMessageId: message.qqMessageId,
          qqEventId: message.eventId,
          images: Array.isArray(message.images) ? message.images : [],
        },
      })
    } else {
      messages?.add?.(conv.id, { role: 'user', content: message.text, status: 'sent', meta: { images: message.images || [] } })
    }
    await ackInbox(channel.id, [message.id])
    if (permissions.read === false || permissions.reply === false) return

    const previous = busyChains.get(conv.id) || Promise.resolve()
    const task = previous
      .catch(() => {})
      .then(() => runInboundTurn(channel, conv, message, binding, permissions))
      .catch(err => ctx.logger?.warn?.(`[qqbot] 处理 ${message.id} 失败：${err?.message || err}`))
    busyChains.set(conv.id, task)
    task.finally(() => {
      if (busyChains.get(conv.id) === task) busyChains.delete(conv.id)
    }).catch(() => {})
  }

  /* ---------------- 添加 / 编辑渠道窗口 ---------------- */

  function openSettings({ mode = 'create', tab = 'private', channel = null, onSaved } = {}) {
    const editing = mode === 'edit' && channel
    const source = editing ? findChannel(channel.id) || channel : null
    const meta = source?.meta || {}
    const roleId = meta.roleId || ''
    const category = meta.category || (TAB_ORDER.includes(tab) ? tab : 'private')
    const sessionType = meta.sessionType || CATEGORY_SESSION[category] || 'c2c'
    const permissions = permissionsOf(source)
    const identity = channelIdentity(source)
    const bindings = bindingsOf(source)
    const firstBinding = bindings[0] || null
    const bindingMode = meta.bindingMode === 'manual' ? 'manual' : 'auto'
    const accessMode = meta.accessMode || (meta.appId ? 'manual' : 'qrcode')
    const transport = meta.transport || 'ws'
    let overlay = null
    let access = accessMode

    overlay = document.createElement('div')
    overlay.className = 'wc-mask'
    overlay.innerHTML = `
      <div class="wc-dialog" role="dialog" aria-modal="true">
        <h3>${editing ? '编辑 QQ 官方机器人渠道' : '添加 QQ 官方机器人渠道'}</h3>
        <div class="wc-sub">${
          editing
            ? '修改角色、会话类型、绑定与权限后立即生效；已保存的 AppSecret 不会回显。'
            : 'QQ 消息会进入所选角色的渠道记录，整轮模型调用结束后作为被动消息回复。'
        }</div>
        <label class="wc-field">
          <span>渠道名称</span>
          <input data-wc-name maxlength="30" value="${escapeHtml(source?.name || 'QQ官方机器人')}" placeholder="例如：猫娘的QQ机器人" />
        </label>
        <label class="wc-field">
          <span>使用角色</span>
          <select data-wc-role>
            <option value="">请选择角色</option>
            ${roleOptions(roleId)}
          </select>
        </label>
        <div class="wc-grid">
          <label class="wc-field">
            <span>渠道分类（决定渠道 Tab 与工作记忆）</span>
            <select data-wc-category>
              ${CATEGORY_OPTIONS.map(([value, label]) => `<option value="${value}" ${value === category ? 'selected' : ''}>${label}</option>`).join('')}
            </select>
          </label>
          <label class="wc-field" ${editing ? '' : 'hidden'}>
            <span>QQ 会话类型</span>
            <select data-wc-session disabled>
              ${SESSION_TYPES.map(item => `<option value="${item.id}" selected>${item.label}</option>`).join('')}
            </select>
          </label>
        </div>
        <div class="wc-note">
          当前范围<b>只支持 QQ 私聊（C2C）</b>，暂不支持群聊：群消息不会进入渠道，请勿把渠道绑定到群。
          隐私渠道仍然是正常聊天，只是只使用本渠道自己的上下文，且不能与其他任何渠道互读 / 互发。
        </div>
        ${editing ? '' : '<div class="wc-note">这里只负责创建渠道并选择角色。保存后请到渠道详情点「接入」，再选择扫码或手动凭证；保存时不会自动弹出二维码。</div>'}

        <div data-wc-advanced="" ${editing ? '' : 'hidden'}>
        <div class="wc-field">
          <span>接入方式</span>
          <div class="wc-access">
            <label><input type="radio" name="wc-access" value="qrcode" ${access === 'qrcode' ? 'checked' : ''}/> 扫码接入（手机 QQ 扫一扫）</label>
            <label><input type="radio" name="wc-access" value="manual" ${access === 'manual' ? 'checked' : ''}/> 手动 AppID + AppSecret</label>
          </div>
        </div>

        <div data-wc-pane="manual" ${access === 'manual' ? '' : 'hidden'}>
          <div class="wc-grid">
            <label class="wc-field">
              <span>AppID</span>
              <input data-wc-appid maxlength="64" value="${escapeHtml(meta.appId || '')}" placeholder="机器人 AppID" />
            </label>
            <label class="wc-field">
              <span>AppSecret</span>
              <input data-wc-secret type="password" maxlength="128" value="" placeholder="${meta.appId ? '已保存，留空则不修改' : '机器人 AppSecret'}" />
            </label>
          </div>
          <div class="wc-grid">
            <label class="wc-field">
              <span>连接方式</span>
              <select data-wc-transport>
                <option value="ws" ${transport !== 'webhook' ? 'selected' : ''}>WebSocket（本地直连，需 Node 22+，推荐）</option>
                <option value="webhook" ${transport === 'webhook' ? 'selected' : ''}>Webhook（需要公网 HTTPS 回调）</option>
              </select>
            </label>
            <label class="wc-field">
              <span>环境</span>
              <select data-wc-sandbox>
                <option value="0" ${meta.sandbox ? '' : 'selected'}>正式环境</option>
                <option value="1" ${meta.sandbox ? 'selected' : ''}>沙箱环境</option>
              </select>
            </label>
          </div>
          <div class="wc-note">
            AppSecret 只加密保存在本机数据目录（<code>qqbot.json</code>），不会写进渠道列表 / localStorage / config.json。
          </div>
        </div>

        <div data-wc-pane="qrcode" ${access === 'qrcode' ? '' : 'hidden'}>
          <div class="wc-note">
            扫码流程：点击「获取二维码」→ 手机 QQ 扫一扫 → 在打开的页面确认授权 →
            插件自动拿到 AppID / AppSecret 并连接。扫码默认使用本地 WebSocket（无需公网）；若 QQ 正式环境提示本机 IP 不在白名单，插件会自动切换沙箱 OpenAPI（免白名单）。
          </div>
          <label class="wc-field">
            <span>绑定服务域名（高级，默认 q.qq.com）</span>
            <input data-wc-bindhost maxlength="120" value="${escapeHtml(meta.bindHost || '')}" placeholder="q.qq.com；一般留空" />
          </label>
        </div>

        <div class="wc-grid">
          <label class="wc-field">
            <span>绑定模式</span>
            <select data-wc-bindmode>
              <option value="auto" ${bindingMode === 'auto' ? 'selected' : ''}>自动绑定首次匹配的会话</option>
              <option value="manual" ${bindingMode === 'manual' ? 'selected' : ''}>手动指定私聊 openid</option>
            </select>
          </label>
          <label class="wc-field">
            <span>私聊身份</span>
            <select data-wc-identitymode>
              <option value="owner" ${(firstBinding?.identityMode || 'owner') === 'owner' ? 'selected' : ''}>把该私聊用户视为网页端主人</option>
              <option value="guest" ${firstBinding?.identityMode === 'guest' ? 'selected' : ''}>作为独立 QQ 用户</option>
            </select>
          </label>
        </div>
        <div class="wc-grid" data-wc-manual-binding ${bindingMode === 'manual' ? '' : 'hidden'}>
          <label class="wc-field">
            <span>私聊 openid</span>
            <input data-wc-peerid maxlength="128" value="${escapeHtml(firstBinding?.peerId || '')}" placeholder="QQ 官方接口给的是 openid，不是 QQ 号" />
          </label>
          <label class="wc-field">
            <span>会话备注</span>
            <input data-wc-alias maxlength="30" value="${escapeHtml(firstBinding?.alias || '')}" placeholder="例如：我 / 测试群" />
          </label>
        </div>
        <div class="wc-note">
          QQ 官方接口出于隐私保护只提供 <b>openid</b>（每个机器人不同），拿不到 QQ 号 / 群号。
          自动绑定模式下，第一次收到哪个会话的消息就绑定哪个；之后同一机器人的其它会话不会进入本渠道。
        </div>
        <label class="wc-field">
          <span>允许确认的用户 openid（逗号分隔）</span>
          <input data-wc-trusted maxlength="400" value="${escapeHtml((meta.trustedUserIds || []).join(','))}" placeholder="例如把你的 openid 填进来；留空时只有「主人身份」能确认" />
        </label>
        <div class="wc-note">如何知道自己的 openid：用手机 QQ 给机器人发一条消息，渠道详情的「发现会话」会显示你的 openid；也可以直接把它填在这里授权。</div>
        </div>

        <div class="wc-grid">
          <label class="wc-field">
            <span>用户显示名（绑定为“主人”时使用）</span>
            <input data-wc-identity-name maxlength="30" value="${escapeHtml(identity.userName)}" placeholder="例如：我 / 猫娘主人" />
          </label>
          <label class="wc-field">
            <span>用户唯一标识</span>
            <input data-wc-identity-id maxlength="80" value="${escapeHtml(identity.userId)}" placeholder="例如：web-user" />
          </label>
        </div>

        <div class="wc-field">
          <span>权限设置</span>
          <div class="wc-perms">
            ${PERMISSION_META.map(([key, label, help]) => `
              <label class="wc-perm">
                <input type="checkbox" data-wc-perm="${key}" ${permissions[key] !== false ? 'checked' : ''} />
                <span>${label}<small>${help}</small></span>
              </label>`).join('')}
          </div>
        </div>
        <div class="wc-note">${PASSIVE_HINT}主动消息配额由 QQ 官方限制，失败会回写错误提示。</div>
        <div class="wc-error" data-wc-error hidden></div>
        <div class="wc-actions">
          <button class="outline-btn" data-wc-cancel>取消</button>
          <button class="outline-btn primary-soft" data-wc-save>${editing ? '保存修改' : '添加渠道'}</button>
        </div>
      </div>`

    const nameInput = overlay.querySelector('[data-wc-name]')
    const roleSelect = overlay.querySelector('[data-wc-role]')
    const categorySelect = overlay.querySelector('[data-wc-category]')
    const sessionSelect = overlay.querySelector('[data-wc-session]')
    const appIdInput = overlay.querySelector('[data-wc-appid]')
    const secretInput = overlay.querySelector('[data-wc-secret]')
    const transportSelect = overlay.querySelector('[data-wc-transport]')
    const sandboxSelect = overlay.querySelector('[data-wc-sandbox]')
    const bindHostInput = overlay.querySelector('[data-wc-bindhost]')
    const bindModeSelect = overlay.querySelector('[data-wc-bindmode]')
    const identityModeSelect = overlay.querySelector('[data-wc-identitymode]')
    const peerIdInput = overlay.querySelector('[data-wc-peerid]')
    const aliasInput = overlay.querySelector('[data-wc-alias]')
    const identityNameInput = overlay.querySelector('[data-wc-identity-name]')
    const identityIdInput = overlay.querySelector('[data-wc-identity-id]')
    const trustedInput = overlay.querySelector('[data-wc-trusted]')
    const manualPane = overlay.querySelector('[data-wc-pane="manual"]')
    const qrPane = overlay.querySelector('[data-wc-pane="qrcode"]')
    const manualBindingRow = overlay.querySelector('[data-wc-manual-binding]')
    const errorEl = overlay.querySelector('[data-wc-error]')

    const setError = message => {
      errorEl.textContent = message || ''
      errorEl.hidden = !message
    }
    const close = () => {
      overlay?.remove()
      overlay = null
    }
    const syncAccessPanes = () => {
      manualPane.hidden = access !== 'manual'
      qrPane.hidden = access !== 'qrcode'
    }
    const syncManualBinding = () => {
      manualBindingRow.hidden = bindModeSelect.value !== 'manual'
    }
    const syncSessionFromCategory = () => {
      const next = CATEGORY_SESSION[categorySelect.value] || 'c2c'
      sessionSelect.value = next
    }

    overlay.querySelectorAll('input[name="wc-access"]').forEach(input =>
      input.addEventListener('change', () => {
        access = input.value
        syncAccessPanes()
      }),
    )
    categorySelect.addEventListener('change', syncSessionFromCategory)
    bindModeSelect.addEventListener('change', syncManualBinding)

    const save = async () => {
      setError('')
      const name = String(nameInput.value || '').trim() || 'QQ官方机器人'
      const nextRoleId = String(roleSelect.value || '').trim()
      if (!nextRoleId) return setError('请先选择一个角色；没有角色时可先到「会话」里创建一个角色。')
      const nextCategory = TAB_ORDER.includes(categorySelect.value) ? categorySelect.value : 'private'
      const nextSession = SESSION_TYPES.some(item => item.id === sessionSelect.value) ? sessionSelect.value : 'c2c'
      const nextTransport = transportSelect.value === 'webhook' ? 'webhook' : 'ws'
      const nextSandbox = sandboxSelect.value === '1'
      const nextBindingMode = bindModeSelect.value === 'manual' ? 'manual' : 'auto'
      const appId = String(appIdInput.value || '').trim()
      const appSecret = String(secretInput.value || '').trim()
      const peerId = String(peerIdInput.value || '').trim()
      const alias = String(aliasInput.value || '').trim()
      const identityMode = identityModeSelect.value === 'guest' ? 'guest' : 'owner'
      const sharedIdentity = ctx.registry.get('user-identity')?.get?.() || {}
      const nextIdentity = {
        userId: String(identityIdInput.value || '').trim() || sharedIdentity.userId || config.get('chat.userId', 'web-user') || 'web-user',
        userName: String(identityNameInput.value || '').trim() || sharedIdentity.userName || resolveUserNickname(config),
      }
      const nextPermissions = {}
      for (const [key] of PERMISSION_META) nextPermissions[key] = !!overlay.querySelector(`[data-wc-perm="${key}"]`)?.checked

      if (access === 'manual') {
        if (!appId) return setError('手动接入需要填写 AppID。')
        if (!appSecret && !meta.appId) return setError('手动接入需要填写 AppSecret（首次接入时）。')
      }
      if (nextBindingMode === 'manual' && !peerId && !bindings.length) {
        return setError('手动绑定模式需要填写私聊 openid。')
      }

      const nextBindings = peerId
        ? [{ sessionType: nextSession, peerId, alias, identityMode, boundAt: Date.now() }]
        : bindings.filter(item => item.sessionType === nextSession)
      const nextMeta = {
        ...meta,
        kind: TYPE_ID,
        roleId: nextRoleId,
        category: nextCategory,
        sessionType: nextSession,
        transport: nextTransport,
        accessMode: access,
        appId,
        sandbox: nextSandbox,
        bindingMode: nextBindingMode,
        bindings: nextBindings,
        bindHost: String(bindHostInput.value || '').trim(),
        identity: nextIdentity,
        trustedUserIds: String(trustedInput.value || '')
          .split(/[,，\s]+/)
          .map(value => value.trim())
          .filter(Boolean),
        permissions: nextPermissions,
        updatedAt: Date.now(),
        lastError: '',
      }

      let saved = null
      if (editing && source) {
        const fromTab = findTab(source.id)
        channels.updateChannel(fromTab, source.id, { name, meta: nextMeta })
        if (fromTab !== nextCategory) {
          const moved = channels.removeChannel(fromTab, source.id)
          if (moved) {
            const groups = channels.groups(nextCategory)
            const group = groups[0] || channels.addGroup(nextCategory, '我的渠道')
            saved = channels.addChannel(nextCategory, group.id, { ...moved, name, meta: nextMeta })
            channels.activate(nextCategory, saved.id)
          }
        } else {
          saved = channels.findChannel(fromTab, source.id)
        }
        toast.success(`「${name}」已更新`)
      } else {
        const groups = channels.groups(nextCategory)
        const group = groups[0] || channels.addGroup(nextCategory, '我的渠道')
        saved = channels.addChannel(nextCategory, group.id, { type: TYPE_ID, name, color: TYPE_COLOR, status: 'offline', meta: nextMeta })
        channels.activate(nextCategory, saved.id)
        toast.success(`「${name}」已添加，点击详情里的「接入」扫码或手动登录`)
      }
      if (saved) {
        try {
          ensureConversation(saved)
        } catch (err) {
          ctx.logger?.warn?.(`创建 QQ 渠道会话失败：${err.message}`)
        }
      }
      if (!saved) {
        setError('保存渠道失败，请重试。')
        return
      }

      try {
        // 与微信 clawbot 对齐：保存渠道只负责持久化与同步绑定，
        // 真正的扫码 / 连接由用户在详情页点「接入」触发，避免保存瞬间创建绑定任务。
        if (access === 'manual' && appSecret) {
          const data = await bridgePost('/login/start', {
            mode: 'manual',
            channelId: saved.id,
            appId,
            appSecret,
            transport: nextTransport,
            sandbox: nextSandbox,
            sessionType: nextSession,
            autoBind: nextBindingMode === 'auto',
          })
          if (data) updateChannelFromStatus(data)
          if (data?.ok === false) toast.warn(data.error || '保存凭据失败')
        }
        await syncChannelToBridge(findChannel(saved.id) || saved)
      } catch (err) {
        toast.error(`同步 QQ 渠道失败：${err.message}`)
      }

      onSaved?.(findChannel(saved.id) || saved)
      close()
    }

    overlay.querySelector('[data-wc-cancel]')?.addEventListener('click', close)
    overlay.querySelector('[data-wc-save]')?.addEventListener('click', () => save().catch(err => setError(err.message)))
    overlay.addEventListener('mousedown', event => {
      if (event.target === overlay) close()
    })
    const onKeydown = event => {
      if (event.key === 'Escape') close()
    }
    document.addEventListener('keydown', onKeydown)
    closing.push(() => document.removeEventListener('keydown', onKeydown))
    document.body.appendChild(overlay)
    syncAccessPanes()
    syncManualBinding()
    setTimeout(() => nameInput?.focus(), 30)
  }

  /* ---------------- 接入弹窗（扫码 / 手动 / Webhook） ---------------- */

  function qrMarkup(qr) {
    if (!qr) return '<div class="wc-qr-fallback">还没有二维码，点击下方「获取二维码」。</div>'
    const content = String(qr.content || '').trim()
    const imageUrl = String(qr.imageUrl || '').trim()
    if (imageUrl) return `<img src="${escapeHtml(imageUrl)}" alt="QQ 登录二维码" />`
    if (!content) return '<div class="wc-qr-fallback">扫码服务没有返回二维码内容，请检查「创建二维码」端点配置。</div>'
    if (isQrImageContent(content)) {
      const src = /^data:/i.test(content) ? content : /^https?:/i.test(content) ? content : `data:image/png;base64,${content.replace(/\s+/g, '')}`
      return `<img src="${escapeHtml(src)}" alt="QQ 登录二维码" />`
    }
    const svg = renderQrSvg(content, { size: 244, margin: 3 })
    return svg || `<div class="wc-qr-fallback">${escapeHtml(content)}</div>`
  }

  function openLogin(channel) {
    let overlay = null
    let closed = false
    let pollTimer = null
    let latest = null
    let existingAccounts = []
    let currentTab = 'qrcode'
    /** 是否正在等待「重新扫码绑定」的二次确认，用于关闭接入弹窗时一并取消。 */
    let rebindPending = false

    const close = () => {
      if (closed) return
      closed = true
      if (rebindPending) {
        rebindPending = false
        try {
          ctx.registry.get('modal')?.close?.()
        } catch (_) {
          /* ignore */
        }
      }
      if (pollTimer) clearTimeout(pollTimer)
      overlay?.remove()
      overlay = null
    }

    overlay = document.createElement('div')
    overlay.className = 'wc-mask'
    overlay.innerHTML = `
      <div class="wc-dialog" role="dialog" aria-modal="true" style="width:min(540px,94vw)">
        <h3>接入 QQ 官方机器人</h3>
        <div class="wc-tabs">
          <button class="wc-tab" data-wc-tab="qrcode">扫码接入</button>
          <button class="wc-tab" data-wc-tab="manual">手动凭据</button>
          <button class="wc-tab" data-wc-tab="webhook">Webhook</button>
        </div>

        <div data-wc-pane="qrcode">
          <div class="wc-qr" data-wc-qr><div class="wc-qr-fallback">正在读取二维码状态…</div></div>
          <div data-wc-existing hidden>
            <div class="wc-note">检测到本机已保存 QQ 官方机器人登录凭据，可以直接绑定到本渠道，不需要重新扫码：</div>
            <label class="wc-field"><span>已登录机器人</span><select data-wc-login-account></select></label>
            <div class="wc-actions"><button class="outline-btn primary-soft" data-wc-login-use>绑定到本渠道</button></div>
          </div>
          <div class="wc-note">
            点击「获取二维码」后用<b>手机 QQ 扫一扫</b>，在打开的页面确认授权即可，插件会自动拿到 AppID / AppSecret。
            扫码接入默认走<b>本地 WebSocket</b>，不需要公网回调；若 QQ 正式环境提示本机 IP 不在白名单，
            插件会自动切换到<b>沙箱 OpenAPI</b>（免白名单）完成接入，不会再要求你手动去开放平台加白名单。
            <br/>扫码确认后，插件会把扫码用户的 openid 自动绑定为本渠道默认会话（手动绑定模式则只加入信任列表）；
            跨渠道确认等敏感操作默认由你放行。
          </div>
          <details class="wc-details">
            <summary>高级：绑定服务域名（默认 q.qq.com）</summary>
            <label class="wc-field"><span>绑定服务域名</span><input data-wc-login-bindhost maxlength="120" value="${escapeHtml(channel?.meta?.bindHost || '')}" placeholder="q.qq.com；一般留空" /></label>
          </details>
          <div class="wc-actions">
            <button class="outline-btn primary-soft" data-wc-login-qr>获取二维码</button>
            <button class="outline-btn" data-wc-login-rebind hidden>重新扫码绑定</button>
          </div>
        </div>

        <div data-wc-pane="manual" hidden>
          <div class="wc-grid">
            <label class="wc-field"><span>AppID</span><input data-wc-login-appid maxlength="64" value="${escapeHtml(channel?.meta?.appId || '')}" placeholder="机器人 AppID" /></label>
            <label class="wc-field"><span>AppSecret</span><input data-wc-login-secret type="password" maxlength="128" value="" placeholder="填入后加密保存到本机" /></label>
          </div>
          <div class="wc-grid">
            <label class="wc-field">
              <span>连接方式</span>
              <select data-wc-login-transport>
                <option value="ws" ${channel?.meta?.transport !== 'webhook' ? 'selected' : ''}>WebSocket（推荐）</option>
                <option value="webhook" ${channel?.meta?.transport === 'webhook' ? 'selected' : ''}>Webhook</option>
              </select>
            </label>
            <label class="wc-field">
              <span>环境</span>
              <select data-wc-login-sandbox>
                <option value="0" ${channel?.meta?.sandbox ? '' : 'selected'}>正式环境</option>
                <option value="1" ${channel?.meta?.sandbox ? 'selected' : ''}>沙箱环境</option>
              </select>
            </label>
          </div>
          <div class="wc-actions"><button class="outline-btn primary-soft" data-wc-login-manual>保存并连接</button></div>
        </div>

        <div data-wc-pane="webhook" hidden>
          <div class="wc-note">
            Webhook 需要把本机地址暴露成公网 HTTPS。推荐 Cloudflare Tunnel / 反向代理，然后把下面地址填到 QQ 开放平台的「回调配置」：
          </div>
          <label class="wc-field">
            <span>回调地址</span>
            <input readonly value="${escapeHtml(`${typeof location !== 'undefined' ? location.origin : ''}/api/qqbot/webhook`)}" />
          </label>
          <div class="wc-note">
            QQ 在保存回调时会发送 op=13 校验请求，本插件会用 AppSecret 派生 Ed25519 私钥自动签名；
            普通事件用 <code>op=12</code> ACK。沙箱外网校验失败时，改回 WebSocket 即可。
          </div>
          <div class="wc-actions"><button class="outline-btn primary-soft" data-wc-login-webhook-apply>改用 Webhook 连接</button></div>
        </div>

        <div class="wc-status" data-wc-login-status><span class="dot" style="background:#c9a227"></span><span>正在读取状态…</span></div>
        <div class="wc-error" data-wc-login-error hidden></div>
        <div class="wc-actions">
          <button class="outline-btn" data-wc-login-refresh>刷新状态</button>
          <button class="outline-btn" data-wc-login-close>关闭</button>
        </div>
      </div>`

    const qrEl = overlay.querySelector('[data-wc-qr]')
    const existingEl = overlay.querySelector('[data-wc-existing]')
    const existingSelect = overlay.querySelector('[data-wc-login-account]')
    const statusEl = overlay.querySelector('[data-wc-login-status]')
    const errorEl = overlay.querySelector('[data-wc-login-error]')
    const bindHostInput = overlay.querySelector('[data-wc-login-bindhost]')
    const appIdInput = overlay.querySelector('[data-wc-login-appid]')
    const secretInput = overlay.querySelector('[data-wc-login-secret]')
    const transportSelect = overlay.querySelector('[data-wc-login-transport]')
    const sandboxSelect = overlay.querySelector('[data-wc-login-sandbox]')

    const setError = message => {
      errorEl.textContent = message || ''
      errorEl.hidden = !message
    }
    const setStatus = (text, color = '#c9a227') => {
      statusEl.innerHTML = `<span class="dot" style="background:${color}"></span><span>${escapeHtml(text)}</span>`
    }
    const switchTab = tab => {
      currentTab = tab
      overlay.querySelectorAll('[data-wc-tab]').forEach(button => button.classList.toggle('active', button.dataset.wcTab === tab))
      overlay.querySelectorAll('[data-wc-pane]').forEach(pane => {
        pane.hidden = pane.dataset.wcPane !== tab
      })
    }
    overlay.querySelectorAll('[data-wc-tab]').forEach(button => button.addEventListener('click', () => switchTab(button.dataset.wcTab)))

    const renderExistingAccounts = () => {
      if (!existingEl || !existingSelect) return
      const accounts = existingAccounts.filter(item => item?.appId)
      const show = !latest?.loggedIn && !latest?.qr?.id && accounts.length > 0
      existingEl.hidden = !show
      if (!show) return
      const previous = String(existingSelect.value || '')
      existingSelect.innerHTML = accounts
        .map(item => {
          const name = item.bot?.username || item.appId
          const state = STATUS_LABEL[item.status] || item.status || ''
          return `<option value="${escapeHtml(item.accountId || item.appId)}">${escapeHtml(`${name}（AppID ${item.appId}${state ? ` · ${state}` : ''}）`)}</option>`
        })
        .join('')
      if (previous && accounts.some(item => String(item.accountId || item.appId) === previous)) existingSelect.value = previous
    }

    const loadExistingAccounts = async () => {
      if (!api) return
      try {
        const data = await bridgeGet('/accounts')
        existingAccounts = Array.isArray(data?.accounts) ? data.accounts.filter(item => item?.appId) : []
      } catch (_) {
        existingAccounts = []
      }
      renderExistingAccounts()
    }

    const paint = data => {
      if (!data) return
      latest = data
      updateChannelFromStatus(data)
      const qr = data.qr || null
      const loggedIn = data.loggedIn === true
      const status = String(data.status || '')
      const qrButton = overlay.querySelector('[data-wc-login-qr]')
      const rebindButton = overlay.querySelector('[data-wc-login-rebind]')
      if (qrButton) qrButton.textContent = loggedIn ? '重新连接' : '获取二维码'
      if (rebindButton) rebindButton.hidden = !loggedIn
        const envLabel = data.sandbox
          ? data.sandboxFallback
            ? '沙箱环境（自动降级，免 IP 白名单）'
            : '沙箱环境'
          : '正式环境'
      if (currentTab === 'qrcode') {
        if (loggedIn && status !== 'idle') {
          qrEl.innerHTML = `<div class="wc-qr-fallback">本机已保存机器人凭据（AppID：${escapeHtml(data.appId || '—')} · ${escapeHtml(envLabel)}）。<br/>当前状态：${escapeHtml(STATUS_LABEL[status] || status || '未连接')}。<br/>点下方「重新连接」建立消息链路；如需更换机器人，点「重新扫码绑定」。</div>`
        } else {
          qrEl.innerHTML = qrMarkup(qr)
        }
      }
      renderExistingAccounts()

      if (status === 'online' && loggedIn) {
        setStatus(`已接入${data.bot?.username ? `：${data.bot.username}` : ''}，${envLabel}，消息链路正常。`, '#70a15a')
        setError('')
        // 把渠道里配置的绑定关系补同步给后端，确保扫码登录前后的绑定一致。
        syncChannelToBridge(findChannel(channel.id) || channel).catch(() => {})
        if (pollTimer) clearTimeout(pollTimer)
        pollTimer = setTimeout(close, 1400)
        return
      }

      const errorText = String(data.error || qr?.error || '').trim()
      if (status === 'error' || qr?.status === 'error') {
        setStatus(errorText || '接入失败，请点「重新连接」重试', '#c65b5b')
        setError(errorText)
        return
      }
      if (errorText) setError(errorText)
      else setError('')

      if (status === 'connecting') setStatus('正在连接 QQ 网关…', '#c9a227')
      else if (qr?.status === 'scanned') setStatus('已扫码，请在手机 QQ 上确认授权…', '#c9a227')
      else if (qr?.status === 'expired') setStatus('二维码已过期，请点击「获取二维码」重新获取。', '#c65b5b')
      else if (qr?.status === 'canceled') setStatus('已取消扫码授权。', '#b3b9c2')
      else if (qr?.status === 'confirmed') setStatus('扫码已确认，正在建立 QQ 消息链路…', '#70a15a')
      else if (loggedIn) setStatus('凭据已保存，点击「重新连接」建立消息链路。', '#c9a227')
      else if (currentTab === 'qrcode') setStatus('点击「获取二维码」，然后用手机 QQ 扫一扫并确认授权。', '#c9a227')
      else setStatus('填写 AppID / AppSecret 后保存并连接。', '#c9a227')
    }

    const poll = async () => {
      if (closed) return
      try {
        const data = await bridgeGet(`/login/status?channelId=${encodeURIComponent(channel.id)}`)
        paint(data)
      } catch (err) {
        setError(`查询状态失败：${err.message}`)
      }
      if (!closed && !(latest?.status === 'online' && latest?.loggedIn)) pollTimer = setTimeout(poll, latest?.loggedIn ? 1200 : 2000)
    }

    const bindExistingAccount = async () => {
      const accountId = String(existingSelect?.value || '') || String(existingAccounts[0]?.accountId || existingAccounts[0]?.appId || '')
      const account = existingAccounts.find(item => String(item.accountId || item.appId) === accountId)
      if (!account?.appId) {
        setError('没有可绑定的已登录机器人，请先获取二维码扫码接入。')
        return
      }
      setError('')
      setStatus('正在绑定已保存的机器人…')
      try {
        const current = findChannel(channel.id) || channel
        const meta = current.meta || {}
        channels.updateChannel(findTab(current.id), current.id, {
          status: 'connecting',
          meta: {
            ...meta,
            accountId: account.accountId || '',
            appId: account.appId,
            botName: account.bot?.username || current.meta?.botName || '',
            accessMode: 'qrcode',
            lastError: '',
          },
        })
        const data = await bridgePost('/login/start', {
          mode: 'reconnect',
          channelId: current.id,
          accountId: account.accountId || '',
          appId: account.appId,
          autoBind: meta.bindingMode !== 'manual',
          sessionType: meta.sessionType || sessionTypeOf(current),
        })
        if (closed) return
        paint(data)
        if (data?.ok === false) setError(data.error || '绑定失败')
        if (!closed) pollTimer = setTimeout(poll, 1200)
      } catch (err) {
        if (!closed) {
          setError(err.message || String(err))
          setStatus('绑定失败', '#c65b5b')
        }
      }
    }

    const startQr = async (force = false) => {
      if (closed) return
      const current = findChannel(channel.id) || channel
      const meta = current.meta || {}
      const loggedIn = latest?.loggedIn === true
      if (loggedIn && !force) {
        setError('')
        setStatus('正在使用本机保存的凭据重新连接…')
        try {
          const data = await bridgePost('/login/start', {
            mode: 'reconnect',
            channelId: current.id,
            autoBind: meta.bindingMode !== 'manual',
            sessionType: meta.sessionType || sessionTypeOf(current),
          })
          if (closed) return
          if (data?.ok === false) {
            setError(data.error || '重新连接失败')
            setStatus('重新连接失败', '#c65b5b')
            return
          }
          paint(data)
          if (!closed) pollTimer = setTimeout(poll, 1200)
        } catch (err) {
          if (!closed) {
            setError(err.message || String(err))
            setStatus('重新连接失败', '#c65b5b')
          }
        }
        return
      }
      if (force && loggedIn) {
        const modal = ctx.registry.get('modal')
        rebindPending = true
        let confirmed = true
        try {
          confirmed = modal
            ? (await modal.confirm('重新扫码绑定', '本机已有登录凭据；重新扫码会绑定新的机器人并替换本渠道的登录信息。手机 QQ 上如果旧机器人仍在线，可能提示断开当前服务。')).ok
            : true
        } finally {
          rebindPending = false
        }
        // 旧实现在用户关闭接入弹窗后仍会继续创建二维码任务，导致再打开时又要重扫。
        // 关闭弹窗即取消本次重扫；确认弹窗已经由 modal-host 提到渠道弹窗上层。
        if (closed || !confirmed) return
      }
      setError('')
      setStatus('正在获取二维码…')
      try {
        const bindHost = String(bindHostInput?.value || '').trim()
        channels.updateChannel(findTab(current.id), current.id, {
          meta: { ...(current.meta || {}), bindHost },
        })
        const data = await bridgePost('/login/start', {
          mode: 'qrcode',
          channelId: current.id,
          bindHost,
          forceBind: force === true,
          autoBind: meta.bindingMode !== 'manual',
          sessionType: meta.sessionType || sessionTypeOf(current),
        })
        if (closed) return
        if (data?.ok === false) {
          setError(data.error || '获取二维码失败')
          setStatus('二维码获取失败', '#c65b5b')
          return
        }
        paint(data)
        if (!closed) pollTimer = setTimeout(poll, 1500)
      } catch (err) {
        if (!closed) {
          setError(err.message || String(err))
          setStatus('二维码获取失败', '#c65b5b')
        }
      }
    }

    const saveManual = async () => {
      setError('')
      const appId = String(appIdInput.value || '').trim()
      const appSecret = String(secretInput.value || '').trim()
      if (!appId || !appSecret) {
        setError('手动接入需要同时填写 AppID 和 AppSecret。')
        return
      }
      setStatus('正在获取 access_token 并连接…')
      try {
        const current = findChannel(channel.id) || channel
        const meta = current.meta || {}
        const data = await bridgePost('/login/start', {
          mode: 'manual',
          channelId: current.id,
          appId,
          appSecret,
          transport: transportSelect.value === 'webhook' ? 'webhook' : 'ws',
          sandbox: sandboxSelect.value === '1',
          sessionType: meta.sessionType || sessionTypeOf(current),
          autoBind: meta.bindingMode !== 'manual',
        })
        if (closed) return
        paint(data)
        if (data?.ok === false) setError(data.error || '连接失败')
        if (!closed) pollTimer = setTimeout(poll, 1500)
      } catch (err) {
        if (!closed) {
          setError(err.message)
          setStatus('连接失败', '#c65b5b')
        }
      }
    }

    const applyWebhook = async () => {
      try {
        const current = findChannel(channel.id) || channel
        const meta = { ...(current.meta || {}), transport: 'webhook' }
        channels.updateChannel(findTab(current.id), current.id, { meta })
        const data = await bridgePost('/login/start', { mode: 'reconnect', channelId: current.id, transport: 'webhook' })
        if (closed) return
        paint(data)
        if (data?.ok === false) setError(data.error || '切换 Webhook 失败')
        else setStatus('已切换为 Webhook，事件会通过回调地址进入；请确保公网可达。', '#c9a227')
      } catch (err) {
        if (!closed) setError(err.message)
      }
    }

    overlay.querySelector('[data-wc-login-qr]')?.addEventListener('click', () => startQr(false).catch(err => setError(err.message)))
    overlay.querySelector('[data-wc-login-rebind]')?.addEventListener('click', () => startQr(true).catch(err => setError(err.message)))
    overlay.querySelector('[data-wc-login-use]')?.addEventListener('click', () => bindExistingAccount().catch(err => setError(err.message)))
    overlay.querySelector('[data-wc-login-manual]')?.addEventListener('click', () => saveManual().catch(err => setError(err.message)))
    overlay.querySelector('[data-wc-login-webhook-apply]')?.addEventListener('click', () => applyWebhook().catch(err => setError(err.message)))
    overlay.querySelector('[data-wc-login-refresh]')?.addEventListener('click', () => poll())
    overlay.querySelector('[data-wc-login-close]')?.addEventListener('click', close)
    overlay.addEventListener('mousedown', event => {
      if (event.target === overlay) close()
    })
    const onKeydown = event => {
      if (event.key === 'Escape') close()
    }
    document.addEventListener('keydown', onKeydown)
    closing.push(() => document.removeEventListener('keydown', onKeydown))
    document.body.appendChild(overlay)
    switchTab(currentTab)
    poll()
      .catch(() => {})
      .finally(() => loadExistingAccounts().catch(() => {}))
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
    const sessionType = sessionTypeOf(channel)
    const permissions = permissionsOf(channel)
    const conv = sessions.get(channel.meta?.conversationId)
    const status = channel.status || 'offline'
    const bindings = bindingsOf(channel)
    const discovered = (live.discovered || []).filter(item => !item.channelId && (!item.sessionType || item.sessionType === sessionType || item.unsupported))
    const count = conv ? (sessions.messages(conv.id) || []).filter(m => m.kind !== 'divider').length : 0
    const enabled = PERMISSION_META.filter(([key]) => permissions[key] !== false).map(([, label]) => label)
    const accountText = channel.meta?.botName ? `${channel.meta.botName}（${channel.meta.appId || '—'}）` : channel.meta?.appId || '未登录'
    return `
      <div class="wc-detail">
        <div class="wc-detail-head">
          <div class="wc-detail-avatar">${TYPE_ICON}</div>
          <div style="flex:1;min-width:0">
            <div class="wc-detail-name">${escapeHtml(channel.name || 'QQ官方机器人')}</div>
            <div class="wc-detail-sub">${escapeHtml(channel.id)} · ${escapeHtml(TAB_LABELS[category] || category)} · ${escapeHtml(SESSION_LABEL[sessionType] || sessionType)} · ${escapeHtml(role?.name || '未绑定角色')}</div>
          </div>
          <span class="wc-badge"><span class="dot" style="width:8px;height:8px;border-radius:50%;background:${statusClickColor(status)}"></span>${escapeHtml(STATUS_LABEL[status] || status)}</span>
        </div>

        <div class="wc-detail-actions">
          ${status === 'online'
            ? '<button class="outline-btn primary-soft" data-wc-action="refresh">已接入</button>'
            : '<button class="outline-btn primary-soft" data-wc-action="connect">接入</button>'}
          <button class="outline-btn" data-wc-action="edit">编辑渠道</button>
          ${conv ? '<button class="outline-btn" data-wc-action="open">打开聊天记录</button>' : ''}
          <button class="outline-btn" data-wc-action="refresh">刷新状态</button>
          ${status === 'online' ? '<button class="outline-btn" data-wc-action="logout">断开连接</button>' : ''}
        </div>
        ${channel.meta?.lastError ? `<div class="wc-error" style="margin-top:12px">${escapeHtml(channel.meta.lastError)}</div>` : ''}

        <div class="settings-section" style="margin-top:18px">
          <div class="settings-section-title">渠道配置</div>
          <div class="settings-card" style="padding:14px 16px">
            <div class="wc-kv">
              <span class="k">使用角色</span><span class="v">${escapeHtml(role?.name || '未绑定（请在编辑渠道里选择）')}</span>
              <span class="k">渠道分类</span><span class="v">${escapeHtml(TAB_LABELS[category] || category)}${category === 'private' ? '（参与角色工作记忆）' : '（仅本渠道上下文）'}</span>
              <span class="k">QQ 会话类型</span><span class="v">${escapeHtml(SESSION_LABEL[sessionType] || sessionType)}</span>
              <span class="k">机器人账号</span><span class="v">${escapeHtml(accountText)}</span>
              <span class="k">连接方式</span><span class="v">${escapeHtml(channel.meta?.transport === 'webhook' ? 'Webhook 回调' : 'WebSocket 网关')}</span>
              <span class="k">接入环境</span><span class="v">${channel.meta?.sandbox ? `沙箱${channel.meta?.sandboxFallback ? '（自动降级，免 IP 白名单）' : ''}` : '正式'}</span>
              <span class="k">聊天记录</span><span class="v">${conv ? `${escapeHtml(conv.name)} · ${count} 条` : '接入后自动创建'}</span>
              <span class="k">权限</span><span class="v">${escapeHtml(enabled.join(' · ') || '仅基础权限')}</span>
              <span class="k">绑定模式</span><span class="v">${channel.meta?.bindingMode === 'manual' ? '手动绑定' : '自动绑定首次会话'}</span>
              <span class="k">owner 标识</span><span class="v">${escapeHtml(channelIdentity(channel).userName)} · ${escapeHtml(channelIdentity(channel).userId)}</span>
            </div>
          </div>
        </div>

        <div class="settings-section">
          <div class="settings-section-title">会话绑定（只接收这些会话）</div>
          <div class="settings-card" style="padding:12px 14px">
            ${bindings.length
              ? bindings
                  .map(
                    binding => `
                    <div class="wc-bind-row">
                      <div class="wc-bind-main">
                        <div class="wc-bind-name">${escapeHtml(bindingLabel(binding))} ${binding.auto ? '<span class="wc-tag">自动</span>' : ''}</div>
                        <div class="wc-bind-id">${escapeHtml(binding.sessionType)} · ${escapeHtml(binding.peerId)}</div>
                      </div>
                      <div class="wc-bind-actions">
                        <select data-wc-bind-identity="${escapeHtml(`${binding.sessionType}|${binding.peerId}`)}">
                          <option value="owner" ${(binding.identityMode || 'owner') === 'owner' ? 'selected' : ''}>视为主人</option>
                          <option value="guest" ${binding.identityMode === 'guest' ? 'selected' : ''}>独立用户</option>
                        </select>
                        <button class="outline-btn" data-wc-action="unbind" data-wc-session="${escapeHtml(binding.sessionType)}" data-wc-peer="${escapeHtml(binding.peerId)}">解绑</button>
                        <button class="outline-btn" data-wc-action="copy" data-wc-peer="${escapeHtml(binding.peerId)}">复制 openid</button>
                      </div>
                    </div>`,
                  )
                  .join('')
              : '<div class="wc-bind-empty">还没有绑定会话。收到匹配类型的消息后，如果是自动绑定模式会自动绑定第一个；也可以从下方「发现会话」手动绑定。</div>'}
          </div>
        </div>

        <div class="settings-section">
          <div class="settings-section-title">发现会话（同一机器人收到的其它 openid）</div>
          <div class="settings-card" style="padding:12px 14px">
            ${discovered.length
              ? discovered
                  .map(
                    item => `
                    <div class="wc-bind-row">
                      <div class="wc-bind-main">
                        <div class="wc-bind-name">${item.unsupported ? `<span class="wc-tag">${escapeHtml(item.unsupported)}</span> ` : ''}${escapeHtml(SESSION_LABEL[item.sessionType] || item.sessionType)} · ${escapeHtml(item.peerId)}</div>
                        <div class="wc-bind-id">${escapeHtml(item.preview || '（暂无内容）')} · ${escapeHtml(formatTime(item.at))} · 共 ${Number(item.count) || 0} 条${item.lastSenderName ? ` · ${escapeHtml(item.lastSenderName)}` : ''}</div>
                      </div>
                      <div class="wc-bind-actions">
                        <input data-wc-discover-alias="${escapeHtml(`${item.sessionType}|${item.peerId}`)}" maxlength="20" placeholder="备注" />
                        <button class="outline-btn primary-soft" data-wc-action="bind" data-wc-session="${escapeHtml(item.sessionType)}" data-wc-peer="${escapeHtml(item.peerId)}" ${item.unsupported ? 'disabled title="暂不支持群聊"' : ''}>绑定到本渠道</button>
                        <button class="outline-btn" data-wc-action="trust" data-wc-peer="${escapeHtml(item.peerId)}" ${item.unsupported ? 'disabled' : ''}>信任该 openid</button>
                      </div>
                    </div>`,
                  )
                  .join('')
              : '<div class="wc-bind-empty">还没有发现其它会话。让 QQ 用户先给机器人发一条私聊消息，这里就会出现对应 openid；点「绑定并允许确认」即可把它授权给本渠道。</div>'}
          </div>
        </div>

        ${channel.meta?.transport === 'webhook'
          ? `<div class="settings-section">
              <div class="settings-section-title">Webhook 回调</div>
              <div class="settings-card" style="padding:12px 14px">
                <div class="wc-kv"><span class="k">回调地址</span><span class="v">${escapeHtml(`${typeof location !== 'undefined' ? location.origin : ''}/api/qqbot/webhook`)}</span></div>
                <div class="wc-note" style="margin-top:8px">需要公网 HTTPS 可达；QQ 保存回调时的 op=13 校验由本插件自动完成。</div>
              </div>
            </div>`
          : ''}

        <div class="settings-section">
          <div class="settings-note">
            入站消息会写入当前渠道记录并触发所选角色；模型整轮调用结束后，回复作为被动消息按 <code>msg_seq</code> 发回 QQ。
            ${PASSIVE_HINT}窗口失效时自动改发主动消息（受 QQ 官方配额限制），无需额外开关。
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
        const data = await bridgeGet(`/login/status?channelId=${encodeURIComponent(channel.id)}`)
        if (data) {
          live = { ...live, ...data }
          updateChannelFromStatus(data)
        }
      } catch (_) {
        /* 后端未就绪时保持本地状态 */
      }
      render()
    }
    const onClick = async event => {
      const button = event.target.closest?.('[data-wc-action]')
      if (!button) return
      const current = findChannel(channel.id) || channel
      const action = button.dataset.wcAction
      if (action === 'connect') {
        openLogin(current)
      } else if (action === 'edit') {
        openSettings({ mode: 'edit', channel: current, onSaved: render })
      } else if (action === 'open') {
        openChannelRecords(current)
      } else if (action === 'refresh') {
        await refresh()
        toast.info('已刷新 QQ 机器人状态')
      } else if (action === 'logout') {
        const modal = ctx.registry.get('modal')
        const confirmed = modal
          ? (await modal.confirm('断开 QQ 官方机器人', '只断开当前渠道并保留本机登录凭据；之后点「接入」可直接重新连接。如需更换机器人，请在接入弹窗里点「重新扫码绑定」。')).ok
          : true
        if (!confirmed) return
        try {
          await bridgePost('/logout', { channelId: current.id, disposeAccount: false })
          channels.updateChannel(findTab(current.id), current.id, {
            status: 'offline',
            meta: { ...(current.meta || {}), qqbotStatus: 'offline', lastError: '' },
          })
          live = {}
          toast.warn('已断开 QQ 官方机器人')
          render()
        } catch (err) {
          toast.error(`退出失败：${err.message}`)
        }
      } else if (action === 'unbind') {
        try {
          const data = await bridgePost('/bind', {
            channelId: current.id,
            remove: { sessionType: button.dataset.wcSession, peerId: button.dataset.wcPeer },
          })
          if (data) {
            live = { ...live, ...data }
            updateChannelFromStatus(data)
          }
          toast.info('已解绑该会话')
          render()
        } catch (err) {
          toast.error(`解绑失败：${err.message}`)
        }
      } else if (action === 'bind') {
        const sessionType = button.dataset.wcSession
        const peerId = button.dataset.wcPeer
        const aliasInput = container.querySelector(`[data-wc-discover-alias="${cssEscape(`${sessionType}|${peerId}`)}"]`)
        try {
          const data = await bridgePost('/bind', {
            channelId: current.id,
            add: {
              sessionType,
              peerId,
              alias: String(aliasInput?.value || '').trim(),
              identityMode: sessionType === 'c2c' ? 'owner' : 'member',
              channelSessionType: sessionType,
            },
          })
          if (data) {
            live = { ...live, ...data }
            updateChannelFromStatus(data)
          }
          toast.success('已绑定到本渠道')
          render()
        } catch (err) {
          toast.error(`绑定失败：${err.message}`)
        }
      } else if (action === 'trust') {
        const peerId = String(button.dataset.wcPeer || '')
        const currentMeta = (findChannel(current.id) || current).meta || {}
        const trusted = Array.isArray(currentMeta.trustedUserIds) ? [...currentMeta.trustedUserIds] : []
        if (peerId && !trusted.includes(peerId)) trusted.push(peerId)
        channels.updateChannel(findTab(current.id), current.id, {
          meta: { ...currentMeta, trustedUserIds: trusted },
        })
        try {
          const data = await bridgePost('/bind', { channelId: current.id, trustedUserIds: trusted })
          if (data) {
            live = { ...live, ...data }
            updateChannelFromStatus(data)
          }
        } catch (_) {
          /* 后端未就绪时保留本地授权 */
        }
        toast.success('已信任该 openid，可用“确认”放行敏感操作')
        render()
      } else if (action === 'copy') {
        const peerId = String(button.dataset.wcPeer || '')
        try {
          await navigator.clipboard.writeText(peerId)
          toast.info('openid 已复制')
        } catch (_) {
          toast.info(peerId)
        }
      }
    }
    container.addEventListener('click', onClick)

    const onIdentityChange = async event => {
      const select = event.target.closest?.('[data-wc-bind-identity]')
      if (!select) return
      const [sessionType, peerId] = String(select.dataset.wcBindIdentity || '').split('|')
      try {
        const current = findChannel(channel.id) || channel
        const data = await bridgePost('/bind', {
          channelId: current.id,
          add: { sessionType, peerId, identityMode: select.value, channelSessionType: sessionType },
        })
        if (data) {
          live = { ...live, ...data }
          updateChannelFromStatus(data)
        }
        render()
      } catch (_) {
        /* 后端未就绪时忽略 */
      }
    }
    container.addEventListener('change', onIdentityChange)

    const offs = [
      events.on('channel:updated', payload => {
        const id = payload?.channel?.id || payload?.id
        if (id === channel.id) render()
      }),
      events.on('channel:status', payload => {
        if (payload?.id === channel.id) render()
      }),
      events.on('qqbot:changed', () => render()),
      events.on('channel:sync', () => render()),
    ]
    const bootTimer = setTimeout(() => refresh().catch(() => {}), 0)
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
      container.removeEventListener('change', onIdentityChange)
    }
    onDispose?.(cleanup)
    return cleanup
  }

  /** 渠道详情「打开聊天记录」：进入 设置 → 聊天记录 并定位到该渠道。 */
  const openChannelRecords = channel => {
    if (!isQQChannel(channel)) return
    ensureConversation(channel)
    const channelId = channelKey(channel.id)
    const settingsView = ctx.registry.get('settings-view')
    const settingsContainer = ctx.registry.get('settings-container')
    if (settingsView?.open) settingsView.open('chat-records')
    else settingsContainer?.open?.('chat-records')
    setTimeout(() => events.emit('chat-records:select', { channelId }), 0)
  }

  /* ---------------- 插件挂载 ---------------- */

  const registration = base.defineChannel({
    type: TYPE_ID,
    name: 'QQ官方机器人',
    color: TYPE_COLOR,
    icon: TYPE_ICON,
    description: 'QQ 官方机器人渠道：扫码 / AppID 接入，支持私聊绑定、被动回复与完整聊天记录（暂不支持群聊）。',
    create: options => openSettings({ mode: 'create', ...(options || {}) }),
    detail: options => mountDetail(options),
    outbound: deliverOutbound,
  })
  ctx.effect(() => () => registration.dispose?.())

  // 插件设置面板：出现在「设置 → 插件 → QQ官方机器人 → 设置」。
  const pluginManager = ctx.registry.get('plugin-manager')
  if (pluginManager?.registerSettings) {
    const disposePanel = pluginManager.registerSettings({
      id: name,
      title: 'QQ 官方机器人渠道设置',
      description: '查看 / 配置本插件创建的 QQ 机器人渠道与接入状态。',
      render(container, helpers = {}) {
        const closePanel = () => helpers.close?.()
        const listChannels = () => {
          const list = []
          for (const tab of channels.tabs()) for (const channel of channels.channels(tab)) if (isQQChannel(channel)) list.push({ tab, channel })
          return list
        }
        const paint = () => {
          const list = listChannels()
          container.innerHTML = list.length
            ? list
                .map(({ tab, channel }) => {
                  const role = roleOf(channel)
                  const bindings = bindingsOf(channel)
                  return `
                    <div class="plugin-panel-item">
                      <div class="plugin-panel-item-main">
                        <div class="plugin-panel-item-name">${escapeHtml(channel.name || 'QQ官方机器人')} <span class="plugin-tag">${escapeHtml(TAB_LABELS[tab] || tab)}</span></div>
                        <div class="plugin-panel-item-desc">
                          角色：${escapeHtml(role?.name || '未绑定')} · 状态：${escapeHtml(STATUS_LABEL[channel.status] || channel.status)} ·
                          机器人：${escapeHtml(channel.meta?.botName || channel.meta?.appId || '未登录')} · 绑定：${escapeHtml(bindings.length ? bindings.map(bindingLabel).join('、') : '无')}
                        </div>
                      </div>
                      <div class="plugin-panel-item-actions">
                        <button class="outline-btn" data-wc-panel-edit="${escapeHtml(channel.id)}">配置</button>
                        ${channel.status === 'online'
                          ? `<button class="outline-btn" data-wc-panel-open="${escapeHtml(channel.id)}">打开记录</button>`
                          : `<button class="outline-btn primary-soft" data-wc-panel-connect="${escapeHtml(channel.id)}">接入</button>`}
                      </div>
                    </div>`
                })
                .join('')
            : '<div class="plugin-panel-empty">还没有 QQ 官方机器人渠道。请到「渠道 → 添加渠道 → QQ官方机器人」创建。</div>'
        }
        const onClick = event => {
          const edit = event.target.closest?.('[data-wc-panel-edit]')
          const connect = event.target.closest?.('[data-wc-panel-connect]')
          const open = event.target.closest?.('[data-wc-panel-open]')
          const target = findChannel(edit?.dataset.wcPanelEdit || connect?.dataset.wcPanelConnect || open?.dataset.wcPanelOpen)
          if (!target) return
          closePanel()
          if (edit) openSettings({ mode: 'edit', channel: target, onSaved: paint })
          else if (connect) openLogin(target)
          else if (open) openChannelRecords(target)
        }
        container.addEventListener('click', onClick)
        const offs = [
          events.on('channel:add', paint),
          events.on('channel:removed', paint),
          events.on('channel:updated', paint),
          events.on('channel:status', paint),
          events.on('channel:sync', paint),
        ]
        paint()
        return () => {
          offs.forEach(off => off?.())
          container.removeEventListener('click', onClick)
        }
      },
    })
    ctx.effect(() => () => disposePanel?.())
  }

  /* ---------------- 整轮结束 / 后端事件 / 敏感确认 ---------------- */

  const offDone = events.on('chat:request-done', payload => {
    const finish = pendingTurns.get(payload?.conversationId)
    if (typeof finish === 'function') finish()
  })
  ctx.effect(offDone)

  const offConfirmBridge = events.on('chat:confirm-request', payload => {
    const conv = sessions.get(payload?.conversationId)
    if (!conv || conv.meta?.channelType !== TYPE_ID) return
    const channel = findChannel(conv.meta?.qqbotChannelId)
    if (!channel || !api) return
    const lastInbound = [...(sessions.messages(conv.id) || [])]
      .reverse()
      .find(item => item.meta?.direction === 'inbound' && item.meta?.peerId)
    if (!lastInbound) return
    const actionText = payload.action === 'read' ? '读取另一个渠道的聊天记录' : '向另一个渠道发送消息'
    const targetName = payload.targetName || payload.targetChannel || '其它渠道'
    bridgePost('/send', {
      channelId: channel.id,
      sessionType: lastInbound.meta.sessionType,
      peerId: lastInbound.meta.peerId,
      msgId: lastInbound.meta.qqMessageId || '',
      eventId: lastInbound.meta.qqEventId || '',
      text: `检测到敏感跨渠道操作（${actionText}：${targetName}）。如果同意，请直接回复“确认”；回复其它内容将视为拒绝。`,
    }).catch(() => {
      /* 提示发送失败不影响原确认流程 */
    })
  })
  ctx.effect(offConfirmBridge)

  const channelExists = channelId => {
    for (const tab of channels.tabs()) if (channels.findChannel(tab, channelId)) return true
    return false
  }
  const offRemoved = events.on('channel:removed', payload => {
    const removed = payload?.channel
    if (!isQQChannel(removed)) return
    setTimeout(() => {
      if (channelExists(removed.id)) return
      pruneOrphanConversations()
      if (!api) return
      bridgePost('/logout', { channelId: removed.id, disposeAccount: false, removeChannel: true }).catch(() => {})
    }, 0)
  })
  ctx.effect(offRemoved)

  // 启动后 / 渠道同步完成后清理历史残留：
  // 修复升级前删除渠道但聊天记录页仍显示 qqbot 空渠道的问题。
  let orphanPruneTimer = null
  const scheduleOrphanPrune = (delay = 1200) => {
    if (orphanPruneTimer) clearTimeout(orphanPruneTimer)
    orphanPruneTimer = setTimeout(() => {
      orphanPruneTimer = null
      try {
        pruneOrphanConversations()
      } catch (err) {
        ctx.logger?.warn?.(`[qqbot] 清理孤立聊天记录失败：${err?.message || err}`)
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
    for (const tab of channels.tabs()) {
      for (const channel of channels.channels(tab)) {
        if (!isQQChannel(channel)) continue
        try {
          ensureConversation(channel)
        } catch (_) {
          /* ignore */
        }
        if (channel.meta?.appId || channel.meta?.accountId) {
          await syncChannelToBridge(channel)
        }
        await refreshChannelStatus(channel)
        drainInbox(channel).catch(() => {})
        if (channel.status === 'connecting') setTimeout(() => refreshChannelStatus(channel).catch(() => {}), 1500)
      }
    }
  }
  const bootTimer = setTimeout(() => {
    boot().catch(err => ctx.logger?.warn?.(`[qqbot] 启动同步失败：${err?.message || err}`))
  }, 700)
  ctx.effect(() => () => clearTimeout(bootTimer))

  ctx.logger?.debug?.('QQ 官方机器人渠道插件就绪')
}
