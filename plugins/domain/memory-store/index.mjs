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

function groupRounds(messages) {
  const rounds = []
  let current = null
  for (const message of messages || []) {
    if (!message || message.kind === 'divider' || message.role === 'system') continue
    if (message.role === 'user' || !current) {
      current = { messages: [] }
      rounds.push(current)
    }
    current.messages.push(message)
  }
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
    content: messageText(message).slice(0, 4000),
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

  const ingestConversation = async conversationId => {
    if (config.get('memory.enabled', true) === false) return { ok: false, code: 'MEMORY_DISABLED', error: '长期记忆已关闭' }
    const conv = sessions.get(conversationId)
    if (!conv) return { ok: false, code: 'CONVERSATION_NOT_FOUND', error: '会话不存在' }
    const channel = store.channelForConversation(conversationId)
    if (!channel) return { ok: false, code: 'CHANNEL_NOT_FOUND', error: '渠道不存在' }
    // 长期概括需要覆盖最近若干完整轮次；聊天窗口分页后主动补拉最近一段原文。
    if (typeof sessions.ensureMessages === 'function') {
      await sessions.ensureMessages(conversationId, { limit: 80 }).catch(() => null)
    }
    const rounds = collectCompleteRounds(channel.channelId)
    if (!rounds.length) return { ok: true, created: 0, pending: 0, ignored: 0 }
    const client = api()
    if (!client?.memoryIngest && !client?.post) return { ok: false, code: 'NO_BACKEND', error: '后端连接不可用' }
    const active = ctx.registry.get('model-registry')?.active?.() || null
    const payload = {
      roleId: channel.roleId || conv.meta?.roleId || conv.id,
      memoryScope: resolveScope(channel),
      channelId: channel.channelId,
      conversationId,
      sourceGroup: channel.group || 'private',
      everyRounds: Math.max(2, Number(config.get('memory.summaryRounds', 10)) || 10),
      summaryProvider: active?.provider || '',
      summaryModel: active?.model?.id || '',
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

  const scheduleIngest = conversationId => {
    if (!conversationId || disposed) return
    if (config.get('memory.enabled', true) === false || config.get('memory.autoSummarize', true) === false) return
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
