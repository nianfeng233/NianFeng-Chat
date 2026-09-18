/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * D? · memory-store
 * 前端记忆库入口：把「每个渠道的完整轮次」提交给后端长期记忆库，
 * 并在 read_messages / search_memory 中按角色做向量 + 关键词 + 时间混合检索。
 *
 * 与 chat-store 的分工：
 *   - chat-store：当前渠道的原始消息、工作记忆、关键词检索；
 *   - memory-store：角色级长期记忆库（跨渠道概括 + 向量），不保存原始消息副本的权威版本。
 *     原文仍以 chat-store 为准；概括里保存 10 轮快照，只用于后端检索后按 message_id 找回。
 *
 * 存储、概括、embedding 全部在后端 server/plugins/memories.mjs：
 * 浏览器 / 服务端代聊共用同一条链路，换设备也能读到同一份角色记忆。
 */
export const name = 'memory-store'
export const version = '1.0.0'
export const displayName = '长期记忆库'
export const description = '业务服务 · 每 10 轮概括、向量语义 + 关键词 + 时间混合检索。'
export const author = '念风内核'
export const icon = '🧠'
export const core = false
export const depends = {
  'chat-store': '^1.0.0',
  'config': '>=1.1.0',
  'event-bus': '*',
  'session-service': '^2.0.0',
}
export const optionalDepends = {
  'backend-client': '>=1.0.0',
  'model-registry': '>=1.0.0',
}
export const inject = ['chat-store', 'session-service', 'config', 'event-bus', 'api?', 'model-registry?']
export const provides = [{ name: 'memory-store', type: 'singleton' }]

const MAX_ROUNDS_PER_INGEST = 30
const AUTO_INGEST_DELAY_MS = 800
/** 后端 memory 快照的单条正文上限，与 server/plugins/memories.mjs 的 MAX_MESSAGE_CHARS 对齐。 */
const MAX_SNAPSHOT_CHARS = 12000
/** 群聊窗口概括：窗口内至少要有这么多条“从未概括过”的消息，才值得再调一次概括模型。 */
const MIN_WINDOW_NEW_MESSAGES = 5
/** 单次窗口概括最多携带的消息数，与后端 MAX_MESSAGES_PER_ROUND 对齐。 */
const MAX_WINDOW_MESSAGES = 80

/**
 * 只有真正触发过模型的用户消息才能开始一轮记忆；群聊里的静默上下文消息
 * （NapCat 等渠道会写入 chat-store 供模型参考，但 meta.triggered === false）
 * 绝不能单独成轮，否则未触发模型的聊天也会被概括，造成 token 浪费。
 *
 * 没有 meta.triggered 字段的渠道（网页 / 私聊 / QQBot / 微信）默认视为每条
 * 用户消息都触发过模型；助手回复只有挂在一轮已触发的用户消息后才能成轮。
 */
function isTriggeredUserMessage(message) {
  return message?.role === 'user' && message?.meta?.triggered !== false
}

function groupRounds(messages) {
  const rounds = []
  let current = null
  const flush = () => {
    if (current && current.messages.some(message => message.role === 'assistant')) rounds.push(current)
    current = null
  }
  for (const message of messages || []) {
    if (!message || message.kind === 'divider' || message.role === 'system') continue
    if (message.role === 'user') {
      if (!isTriggeredUserMessage(message)) {
        // 静默消息出现时，如果当前轮已经有回复，说明这一轮已经闭环：先封口，
        // 防止后续主动发出的 assistant 消息被错误算进上一轮触发对话。
        if (current && current.messages.some(item => item.role === 'assistant')) flush()
        continue
      }
      flush()
      current = { messages: [message] }
      continue
    }
    if (message.role === 'assistant' && current) current.messages.push(message)
  }
  flush()
  return rounds
}

function messageText(message) {
  const content = message?.content
  if (Array.isArray(content)) {
    return content
      .map(part => (typeof part === 'string' ? part : part?.type === 'text' ? part.text || '' : '[图片]'))
      .filter(Boolean)
      .join('\n')
  }
  return String(content ?? '')
}

function compactMessage(message, index) {
  return {
    message_id: String(message?.message_id || message?.id || ''),
    seq: Number(message?.seq) || index + 1,
    role: message?.role === 'assistant' ? 'assistant' : message?.role === 'system' ? 'system' : 'user',
    content: messageText(message).slice(0, MAX_SNAPSHOT_CHARS),
    sender_name: String(message?.sender_name || ''),
    timestamp: String(message?.timestamp || ''),
    content_type: String(message?.content_type || 'text'),
    meta: {
      ...(Array.isArray(message?.meta?.images) && message.meta.images.length
        ? { images: message.meta.images.map(image => ({ mime: image.mime || '', name: image.name || '' })) }
        : {}),
      via: message?.meta?.via || undefined,
    },
  }
}

export function apply(ctx) {
  const store = ctx.inject('chat-store')
  const sessions = ctx.inject('session-service')
  const config = ctx.inject('config')
  const events = ctx.inject('event-bus')
  const timers = new Map()
  let disposed = false

  const api = () => ctx.registry.get('api')

  const collectCompleteRounds = channelId => {
    const messages = store.messagesOf(channelId)
    if (!messages.length) return []
    return groupRounds(messages)
      .filter(round => round.messages.some(message => message.role === 'user') && round.messages.some(message => message.role === 'assistant'))
      .slice(-MAX_ROUNDS_PER_INGEST)
      .map(round => {
        const firstUser = round.messages.find(message => message.role === 'user')
        const firstId = String(firstUser?.message_id || firstUser?.id || round.messages[0]?.message_id || round.messages[0]?.id || '')
        return {
          id: `round:${channelId}:${firstId || round.messages[0]?.seq || '0'}`,
          channel_id: channelId,
          messages: round.messages.map(compactMessage),
        }
      })
  }

  const resolveScope = channel => (channel?.group === 'privacy' ? 'privacy' : 'normal')

  /** 群聊记忆窗口大小：优先本群上下文条数，其次聊天通用设置，默认 20。 */
  const groupWindowSizeOf = channel => {
    const groupOverride = Number(channel?.contextMessages)
    const globalMessages = Number(config.get('chat.groupMessages', 20))
    const raw = groupOverride > 0 ? groupOverride : globalMessages > 0 ? globalMessages : 20
    return Math.max(2, Math.min(MAX_WINDOW_MESSAGES, Math.floor(raw) || 20))
  }

  /**
   * 群聊记忆总开关 + 逐渠道开关。
   * - memory.groupSummaryEnabled=false：所有群聊都不再生成新记忆；
   * - memory.groupSummaryDisabled.<channelId>=true：对应的那个群聊绝不总结（已存记忆仍可检索）。
   */
  const groupSummaryAllowed = channel => {
    if (!channel || channel.group !== 'group') return true
    if (config.get('memory.groupSummaryEnabled', true) === false) return false
    const disabled = config.get('memory.groupSummaryDisabled', {})
    if (!disabled || typeof disabled !== 'object' || Array.isArray(disabled)) return true
    const flag = disabled[String(channel.channelId || '')]
    return !(flag === true || flag === 'true')
  }

  /** 群聊窗口按“最近 N 条消息”取值，包含未触发模型的静默上下文，和模型实际看到的一致。 */
  const collectWindowMessages = (channelId, limit) => {
    const messages = store.messagesOf(channelId)
    if (!messages.length) return []
    return messages.slice(-Math.max(1, Number(limit) || 20)).map(compactMessage)
  }

  const ingestConversation = async conversationId => {
    if (config.get('memory.enabled', true) === false) return { ok: false, code: 'MEMORY_DISABLED', error: '长期记忆已关闭' }
    const conv = sessions.get(conversationId)
    if (!conv) return { ok: false, code: 'CONVERSATION_NOT_FOUND', error: '会话不存在' }
    const channel = store.channelForConversation(conversationId)
    if (!channel) return { ok: false, code: 'CHANNEL_NOT_FOUND', error: '渠道不存在' }
    // 群聊记忆开关：总开关 / 逐渠道关闭后，这个渠道绝不提交新概括。
    if (!groupSummaryAllowed(channel)) {
      return { ok: true, created: 0, pending: 0, ignored: 0, skipped: true, reason: 'group-summary-disabled' }
    }
    // 长期概括需要覆盖最近若干完整轮次；聊天窗口分页后主动补拉最近一段原文。
    if (typeof sessions.ensureMessages === 'function') {
      await sessions.ensureMessages(conversationId, { limit: 80 }).catch(() => null)
    }
    // 群聊按“最近 N 条消息窗口”概括：每次模型轮结束后由后端对照已概括过的 message id，
    // 重复 > N-5 条时跳过，避免同一段群聊被反复概括。私聊 / 隐私则继续按完整轮次概括，
    // 完全由 memory.summaryRounds 控制，不允许再复用群聊窗口（windowSize=0）。
    const groupWindowSize = channel.group === 'group' ? groupWindowSizeOf(channel) : 0
    let rounds = []
    if (groupWindowSize > 0) {
      const messages = collectWindowMessages(channel.channelId, groupWindowSize)
      const lastMessage = messages.at(-1)
      if (messages.length) {
        rounds = [
          {
            id: `window:${channel.channelId}:${lastMessage?.message_id || lastMessage?.seq || '0'}`,
            channel_id: channel.channelId,
            conversation_id: conversationId,
            source_group: channel.group || 'group',
            messages,
          },
        ]
      }
    } else {
      rounds = collectCompleteRounds(channel.channelId)
    }
    if (!rounds.length) return { ok: true, created: 0, pending: 0, ignored: 0 }
    const client = api()
    if (!client?.memoryIngest && !client?.post) return { ok: false, code: 'NO_BACKEND', error: '后端连接不可用' }
    const active = ctx.registry.get('model-registry')?.active?.() || null
    // 「设置 → 模型 → 记忆模型」里选择的概括模型优先；没有单独配置时才回落到当前对话模型，
    // 避免用户为了省 token 选了便宜模型但仍被显式覆盖成贵的对话模型。
    const preferredSummaryProvider = String(config.get('memory.summaryProvider', '') || '').trim()
    const preferredSummaryModel = String(config.get('memory.summaryModel', '') || '').trim()
    const summaryProvider = preferredSummaryProvider || active?.provider || ''
    const summaryModel = preferredSummaryProvider
      ? preferredSummaryModel
      : preferredSummaryModel || active?.model?.id || ''
    // 外部渠道会话名是「角色 · 平台 · 目标」，概括时必须使用角色本名，
    // 否则概括模型会把渠道名 / 应用名（例如「念风」）当成对话人物。
    const roleId = String(channel.roleId || conv.meta?.roleId || conv.id || '').trim()
    const roleConv = roleId ? sessions.get(roleId) : null
    const roleName = String(roleConv?.name || roleConv?.meta?.name || '').trim()
    const payload = {
      roleId,
      roleName,
      mode: groupWindowSize > 0 ? 'window' : 'round',
      windowSize: groupWindowSize,
      minNewMessages: MIN_WINDOW_NEW_MESSAGES,
      memoryScope: resolveScope(channel),
      channelId: channel.channelId,
      conversationId,
      sourceGroup: channel.group || 'private',
      everyRounds: Math.max(2, Number(config.get('memory.summaryRounds', 10)) || 10),
      summaryProvider,
      summaryModel,
      rounds,
    }
    try {
      return client.memoryIngest ? await client.memoryIngest(payload) : await client.post('/memory/ingest', payload, { timeoutMs: 180000 })
    } catch (err) {
      ctx.logger?.debug?.(`[memory-store] 提交记忆失败：${err?.message || err}`)
      return { ok: false, code: 'MEMORY_INGEST_FAILED', error: String(err?.message || err) }
    }
  }

  const search = async (params = {}) => {
    const client = api()
    if (!client?.memorySearch && !client?.post) return { ok: false, code: 'NO_BACKEND', error: '后端连接不可用' }
    const payload = {
      roleId: String(params.roleId || ''),
      memoryScope: params.memoryScope === 'privacy' ? 'privacy' : 'normal',
      channelId: String(params.channelId || ''),
      semantic: String(params.semantic ?? params.query ?? ''),
      keywords: String(params.keywords ?? ''),
      timeStart: params.timeStart || params.time_start || '',
      timeEnd: params.timeEnd || params.time_end || '',
      topSummaries: Math.max(1, Math.min(20, Number(params.topSummaries ?? params.top_summaries ?? params.limit) || 1)),
    }
    if (!payload.roleId) return { ok: false, code: 'NO_ROLE', error: '缺少角色 ID' }
    try {
      return client.memorySearch ? await client.memorySearch(payload) : await client.post('/memory/search', payload, { timeoutMs: 60000 })
    } catch (err) {
      ctx.logger?.debug?.(`[memory-store] 检索失败：${err?.message || err}`)
      return { ok: false, code: 'MEMORY_SEARCH_FAILED', error: String(err?.message || err) }
    }
  }

  const status = async () => {
    const client = api()
    if (!client?.memoryStatus && !client?.get) return { ok: false, code: 'NO_BACKEND', error: '后端连接不可用' }
    try {
      return client.memoryStatus ? await client.memoryStatus() : await client.get('/memory/status')
    } catch (err) {
      return { ok: false, code: 'MEMORY_STATUS_FAILED', error: String(err?.message || err) }
    }
  }

  /** 记忆管理页：分页读取已有记忆条目（不含原文 messages）。 */
  const listRecords = async (params = {}) => {
    const client = api()
    if (!client?.get) return { ok: false, code: 'NO_BACKEND', error: '后端连接不可用' }
    const query = new URLSearchParams()
    const put = (key, value) => {
      const text = String(value ?? '').trim()
      if (text) query.set(key, text)
    }
    put('roleId', params.roleId)
    put('scope', params.memoryScope === 'privacy' ? 'privacy' : params.memoryScope === 'all' ? 'all' : '')
    put('channelId', params.channelId)
    put('q', params.q ?? params.query)
    put('limit', params.limit)
    put('offset', params.offset)
    if (params.includeMessages === true) query.set('includeMessages', '1')
    try {
      return await client.get(`/memory/records${query.toString() ? `?${query.toString()}` : ''}`, { timeoutMs: 60000 })
    } catch (err) {
      ctx.logger?.debug?.(`[memory-store] 记忆条目读取失败：${err?.message || err}`)
      return { ok: false, code: 'MEMORY_RECORDS_FAILED', error: String(err?.message || err), status: err?.status }
    }
  }

  /** 记忆管理页：读取单条记忆的概括与消息原文快照。 */
  const getRecord = async id => {
    const client = api()
    const recordId = String(id || '').trim()
    if (!client?.get) return { ok: false, code: 'NO_BACKEND', error: '后端连接不可用' }
    if (!recordId) return { ok: false, code: 'MISSING_ID', error: '缺少记忆条目 id' }
    try {
      return await client.get(`/memory/records/${encodeURIComponent(recordId)}`, { timeoutMs: 60000 })
    } catch (err) {
      ctx.logger?.debug?.(`[memory-store] 记忆条目详情读取失败：${err?.message || err}`)
      return { ok: false, code: 'MEMORY_RECORD_FAILED', error: String(err?.message || err), status: err?.status }
    }
  }

  /** 记忆管理页：筛选用角色 / 范围 / 渠道概况。 */
  const listRoles = async () => {
    const client = api()
    if (!client?.get) return { ok: false, code: 'NO_BACKEND', error: '后端连接不可用' }
    try {
      return await client.get('/memory/roles', { timeoutMs: 30000 })
    } catch (err) {
      ctx.logger?.debug?.(`[memory-store] 记忆角色列表读取失败：${err?.message || err}`)
      return { ok: false, code: 'MEMORY_ROLES_FAILED', error: String(err?.message || err), status: err?.status }
    }
  }

  const scheduleIngest = conversationId => {
    if (!conversationId || disposed) return
    if (config.get('memory.enabled', true) === false || config.get('memory.autoSummarize', true) === false) return
    try {
      const channel = store.channelForConversation(conversationId)
      if (channel && !groupSummaryAllowed(channel)) return
    } catch (_) {
      /* 会话 / 渠道暂时不可用时仍按原逻辑延后处理 */
    }
    const previous = timers.get(conversationId)
    if (previous) clearTimeout(previous)
    const timer = setTimeout(() => {
      timers.delete(conversationId)
      if (disposed) return
      ingestConversation(conversationId).catch(err => ctx.logger?.debug?.(`[memory-store] 自动概括失败：${err?.message || err}`))
    }, AUTO_INGEST_DELAY_MS)
    timer?.unref?.()
    timers.set(conversationId, timer)
  }

  const service = {
    name: 'memory-store',
    collectCompleteRounds,
    ingestConversation,
    search,
    status,
    listRecords,
    getRecord,
    listRoles,
    available: () => {
      const client = api()
      return !!(client?.status?.().online && (client.supports?.('memory') || client.memorySearch))
    },
  }

  ctx.provide('memory-store', service, { type: 'singleton' })

  // 每次完整模型轮次结束后提交；后端按 round_id 去重，只会在攒够 N 轮时生成一条新概括。
  const offDone = events.on('chat:request-done', payload => {
    scheduleIngest(payload?.conversationId)
  })
  ctx.effect?.(() => () => {
    disposed = true
    offDone?.()
    for (const timer of timers.values()) clearTimeout(timer)
    timers.clear()
  })

  ctx.logger.debug('长期记忆库前端服务就绪')
}
