/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * D? · chat-store
 * 聊天记录库（文档 §3.1 / §5）。
 *
 *   - WebUI 里的每个会话 = 一个 Nova 渠道（nova:web:<会话id>），按普通私聊处理
 *   - 每条消息补齐稳定 message_id / channel_id / seq / timestamp / sender / visibility / source
 *   - 为未来的 qq:* / wechat:* / 群聊 / 隐私渠道保留同一套数据结构
 *   - 存储仍然复用 session-service（会话级 JSON 持久化），本插件只负责“渠道视图 + 元数据”
 *
 * 对外提供：
 *   channelForConversation(convId)  渠道记录（自动补齐 meta.channelId）
 *   resolveChannel(ref)             渠道 ID / 会话 ID -> 渠道记录
 *   append(convId, message)         追加一条带完整元数据的消息
 *   messagesOf(channelId)           渠道内全部消息（按 seq 排序）
 *   rounds(channelId, limit)        渠道最近 N 轮
 *   workingMessages({roleId, limit}) 角色级工作记忆（仅普通私聊，按时间合并）
 *   search(query) / stats()
 */
export const name = 'chat-store'
export const version = '1.0.0'
export const displayName = '聊天记录库'
export const description = '业务服务 · 渠道消息元数据、序号、工作记忆与 Nova 渠道识别。'
export const author = '念风内核'
export const icon = '🗂️'
export const core = true
export const depends = {
  'config': '>=1.1.0',
  'event-bus': '*',
  'message-service': '^1.0.0',
  'session-service': '^2.0.0',
  'storage': '*',
}
export const optionalDepends = {
  'user-identity': '>=1.0.0',
}
export const inject = ['session-service', 'message-service', 'storage', 'event-bus', 'config', 'user-identity?']
export const provides = [{ name: 'chat-store', type: 'singleton' }]

import { resolveUserNickname } from '../../../src/util/identity.mjs'

const NS = 'chat-store'
const KEY = 'index'
const MAX_PROTOCOL_TURNS = 20
const MAX_PROTOCOL_MESSAGES = 40
const MAX_PROTOCOL_CONTENT = 8000

const pad = n => String(n).padStart(2, '0')

/** ISO 8601（毫秒 + 本地时区偏移，既便于排序也便于模型直接理解“现在几点”） */
export function toLocalIso(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date)
  if (Number.isNaN(d.getTime())) return new Date().toISOString()
  const offset = -d.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  const abs = Math.abs(offset)
  const ms = String(d.getMilliseconds()).padStart(3, '0')
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${ms}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  )
}

export function nowTime(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 工具协议轨迹只保留模型协议需要的最小字段，并限制体积 */
function sanitizeProtocolMessage(message) {
  if (!message || typeof message !== 'object') return null
  const role = message.role === 'assistant' ? 'assistant' : message.role === 'tool' ? 'tool' : 'user'
  // 多模态 content 不能直接 String()：图片 base64 会以字符串形式进入轨迹并撑爆存储。
  const rawContent = Array.isArray(message.content)
    ? message.content
        .map(part => {
          if (typeof part === 'string') return part
          if (part?.type === 'text') return String(part.text ?? '')
          if (part?.type === 'image_url' || part?.type === 'image' || part?.inlineData) return '[图片]'
          return ''
        })
        .filter(Boolean)
        .join('\n')
    : message.content
  const out = { role, content: String(rawContent ?? '').slice(0, MAX_PROTOCOL_CONTENT) }
  // 空字符串同样保留：它代表“本轮思考模式没有产生可回传推理”，
  // 与字段完全缺失不同，排查 DeepSeek reasoning_content 400 时很关键。
  if (message.reasoning_content !== undefined && message.reasoning_content !== null) {
    out.reasoning_content = String(message.reasoning_content).slice(0, MAX_PROTOCOL_CONTENT)
  }
  if (role === 'tool') {
    out.tool_call_id = String(message.tool_call_id || message.toolCallId || '').slice(0, 200)
    if (message.name) out.name = String(message.name).slice(0, 100)
  }
  if (role === 'assistant' && Array.isArray(message.tool_calls)) {
    out.tool_calls = message.tool_calls.slice(0, 20).map(call => ({
      id: String(call.id || '').slice(0, 200) || `call_${Math.random().toString(36).slice(2, 8)}`,
      type: 'function',
      function: {
        name: String(call.function?.name || call.name || '').slice(0, 100),
        arguments: String(call.function?.arguments ?? call.arguments ?? '{}').slice(0, MAX_PROTOCOL_CONTENT),
      },
      ...(call.thoughtSignature ? { thoughtSignature: String(call.thoughtSignature).slice(0, MAX_PROTOCOL_CONTENT) } : {}),
    }))
  }
  return out
}

export function apply(ctx) {
  const sessions = ctx.inject('session-service')
  const messages = ctx.inject('message-service')
  const storage = ctx.inject('storage')
  const events = ctx.inject('event-bus')
  const config = ctx.inject('config')

  /** 当前用户标识：优先 user-identity 服务，未来联网账号插件注册后自动生效。 */
  const currentUser = () => {
    const identity = ctx.registry.get('user-identity')?.get?.() || {}
    return {
      userId: String(identity.userId || config.get('chat.userId', 'web-user') || 'web-user'),
      userName: String(identity.userName || resolveUserNickname(config)),
      source: identity.source || 'local',
    }
  }

  let data = storage.get(NS, KEY, null)
  if (!data || typeof data !== 'object' || typeof data.channels !== 'object') data = { channels: {} }
  const persist = () => storage.set(NS, KEY, data)

  const novaChannelId = convId => `nova:web:${convId}`

  const isDivider = message => message?.kind === 'divider' || message?.role === 'system'

  /** 把一条旧消息补齐为结构化消息（只改内存，不触发写盘；下一次 append 会连带持久化） */
  const normalizeMessage = (conv, message, seq) => {
    if (!message || isDivider(message)) return message
    if (message.message_id && message.channel_id && message.timestamp && message.seq) return message
    const channelId = message.channel_id || conv.meta?.channelId || novaChannelId(conv.id)
    const role = message.role === 'assistant' ? 'assistant' : message.role === 'system' ? 'system' : 'user'
    const timestamp =
      message.timestamp ||
      message.createdAt ||
      toLocalIso(new Date(Number(conv.createdAt || Date.now()) + Math.max(0, seq - 1) * 1000))
    const id = message.message_id || message.id || `m_${conv.id}_${seq}`
    Object.assign(message, {
      id,
      message_id: id,
      seq,
      channel_id: channelId,
      timestamp,
      sender_id: message.sender_id || (role === 'user' ? currentUser().userId : `role_${conv.id}`),
      sender_name: message.sender_name || (role === 'user' ? currentUser().userName : conv.name),
      role,
      content_type: message.content_type || (message.kind === 'document' ? 'document' : 'text'),
      visibility: message.visibility || 'shareable',
      source: message.source || message.meta?.source || 'nova',
      is_bot: message.is_bot ?? role === 'assistant',
      mentions_bot: message.mentions_bot ?? false,
      reply_to: message.reply_to ?? null,
    })
    return message
  }

  /** 确保会话有渠道记录，并补齐历史消息元数据 */
  const ensureConversation = (conv, { persistMeta = false } = {}) => {
    if (!conv?.id) return null
    const channelId = conv.meta?.channelId || novaChannelId(conv.id)
    let changed = false
    if (conv.meta?.channelId !== channelId) {
      conv.meta = {
        ...(conv.meta || {}),
        channelId,
        channelType: conv.meta?.channelType || 'nova',
        channelGroup: conv.meta?.channelGroup || 'private',
        source: conv.meta?.source || 'nova',
        participatesWorkingMemory: conv.meta?.participatesWorkingMemory !== false,
      }
      changed = true
    }
    const list = conv.messages || []
    let seq = data.channels[channelId]?.seq || 0
    for (const message of list) {
      if (isDivider(message) || (message.streaming && !message.message_id)) continue
      const before = message.seq
      normalizeMessage(conv, message, before && Number.isFinite(before) ? before : seq + 1)
      if (message.seq > seq) seq = message.seq
    }
    // 修复历史脏时间戳：未来时间 / 与 seq 倒序的派生时间会让上下文排错
    const nowMs = Date.now()
    let previousAt = 0
    for (const message of list) {
      if (isDivider(message) || (message.streaming && !message.message_id)) continue
      const parsed = Date.parse(message.timestamp)
      let at = Number.isNaN(parsed) ? nowMs : parsed
      if (at > nowMs) at = nowMs
      if (at < previousAt) at = previousAt + 1
      message.timestamp = toLocalIso(new Date(at))
      previousAt = at
    }
    const record = {
      channelId,
      conversationId: conv.id,
      roleId: conv.meta?.roleId || conv.id,
      group: conv.meta?.channelGroup || 'private',
      source: conv.meta?.source || 'nova',
      participatesWorkingMemory: conv.meta?.participatesWorkingMemory !== false,
      crossReadable: conv.meta?.crossReadable === true,
      crossSendable: conv.meta?.crossSendable === true,
      // 渠道插件可以按渠道指定上下文策略：
      //   contextRounds   -> 按轮数（私聊 / 隐私 / 普通渠道）；
      //   contextMessages -> 按消息条数（群聊，避免推算“轮”）。
      contextMode: String(conv.meta?.contextMode || ''),
      contextRounds: Math.max(0, Number(conv.meta?.contextRounds) || 0),
      contextMessages: Math.max(0, Number(conv.meta?.contextMessages) || 0),
      agentTurns: data.channels[channelId]?.agentTurns || [],
      seq,
      lastAt: data.channels[channelId]?.lastAt || list.at(-1)?.timestamp || null,
    }
    data.channels[channelId] = record
    if (changed && persistMeta) sessions.update(conv.id, { meta: conv.meta })
    return record
  }

  const findConversationByChannel = channelId => {
    const record = data.channels[channelId]
    if (record) return sessions.get(record.conversationId)
    if (String(channelId || '').startsWith('nova:web:')) return sessions.get(String(channelId).slice('nova:web:'.length))
    return null
  }

  const channelRecord = channelId => {
    if (!channelId) return null
    const existing = data.channels[channelId]
    if (existing) {
      const bound = sessions.get(existing.conversationId)
      if (bound) return existing
      // 后端数据修复 / 渠道会话去重后旧 conversationId 可能不存在：按稳定 channelId 重新绑定。
      const repaired = sessions
        .list()
        .filter(conv => String(conv?.meta?.channelId || '') === String(channelId))
        .sort((a, b) => (Number(b.messageCount) || 0) - (Number(a.messageCount) || 0))[0]
      if (repaired) {
        existing.conversationId = repaired.id
        persist()
        ensureConversation(repaired)
        return existing
      }
      return existing
    }
    const conv = findConversationByChannel(channelId)
    return conv ? ensureConversation(conv) : null
  }

  const sortMessages = list =>
    [...list].sort((a, b) => {
      // 渠道内 seq 是权威顺序（append 时单调分配）；timestamp 只用于跨渠道合并
      const sa = Number(a.seq)
      const sb = Number(b.seq)
      if (Number.isFinite(sa) && Number.isFinite(sb) && sa !== sb) return sa - sb
      const ta = Date.parse(a.timestamp) || 0
      const tb = Date.parse(b.timestamp) || 0
      if (ta !== tb) return ta - tb
      return (sa || 0) - (sb || 0)
    })

  /**
   * 跨渠道工作记忆必须按时间合并，不能拿不同渠道的 seq 互相比大小；
   * 同一时间戳再按渠道 / seq 保持稳定顺序。
   */
  const sortMessagesByTime = list =>
    [...list].sort((a, b) => {
      const ta = Date.parse(a.timestamp) || 0
      const tb = Date.parse(b.timestamp) || 0
      if (ta !== tb) return ta - tb
      const ca = String(a.channel_id || '')
      const cb = String(b.channel_id || '')
      if (ca !== cb) return ca.localeCompare(cb)
      return (Number(a.seq) || 0) - (Number(b.seq) || 0)
    })

  const groupRounds = (list, sorter = sortMessages) => {
    const rounds = []
    let current = null
    for (const message of sorter(list)) {
      if (isDivider(message)) continue
      if (message.role === 'user' || !current) {
        current = { id: message.message_id || message.id, messages: [] }
        rounds.push(current)
      }
      current.messages.push(message)
    }
    return rounds
  }

  const service = {
    name: 'chat-store',
    novaChannelId,
    toLocalIso,
    nowTime,

    /** WebUI 会话 -> 渠道记录（首次访问自动补齐 meta.channelId） */
    channelForConversation(conversationId) {
      const conv = sessions.get(conversationId)
      if (!conv) return null
      const record = ensureConversation(conv, { persistMeta: true })
      persist()
      return record
    },

    channelRecord,
    conversationForChannel(channelId) {
      const found = channelRecord(channelId)
      return found ? sessions.get(found.conversationId) : null
    },
    conversationIdFor(channelId) {
      if (String(channelId || '').startsWith('nova:web:')) return String(channelId).slice('nova:web:'.length)
      return channelRecord(channelId)?.conversationId || null
    },
    /** 渠道 ID / 会话 ID / 显示名前缀 -> 渠道记录 */
    resolveChannel(ref) {
      if (!ref || typeof ref !== 'string') return null
      const raw = ref.trim()
      const direct = channelRecord(raw)
      if (direct) return direct
      const byConv = sessions.get(raw)
      if (byConv) return ensureConversation(byConv, { persistMeta: true })
      // 允许只写下半段，如 "web:xxx"
      if (!raw.includes(':')) {
        const byNova = channelRecord(novaChannelId(raw))
        if (byNova) return byNova
        // 模型通常只知道渠道显示名，不知道内部 channelId；支持按会话名精确 /
        // 唯一模糊匹配，避免把“读取某渠道记录”误判成未知渠道。
        const wanted = raw.toLowerCase()
        const exact = sessions.list().find(conv => String(conv.name || '').trim().toLowerCase() === wanted)
        if (exact) return ensureConversation(exact, { persistMeta: true })
        const partial = sessions.list().filter(conv => String(conv.name || '').toLowerCase().includes(wanted))
        if (partial.length === 1) return ensureConversation(partial[0], { persistMeta: true })
      }
      return null
    },

    /**
     * 追加结构化消息。
     * @param {string} conversationId
     * @param {{role:string, content?:string, content_type?:string, kind?:string, visibility?:string,
     *   source?:string, sender_id?:string, sender_name?:string, is_bot?:boolean, mentions_bot?:boolean,
     *   reply_to?:string|null, status?:string, meta?:object, id?:string}} input
     */
    append(conversationId, input = {}) {
      const conv = sessions.get(conversationId)
      if (!conv) return null
      const record = ensureConversation(conv, { persistMeta: true })
      const seq = (data.channels[record.channelId]?.seq || 0) + 1
      const now = new Date()
      const id = input.id || `m_${conv.id}_${seq}`
      const role = input.role === 'assistant' ? 'assistant' : input.role === 'system' ? 'system' : 'user'
      const channelId = record.channelId
      const identity = currentUser()
      const userId = identity.userId
      const userName = identity.userName
      const extra = {
        id,
        message_id: id,
        seq,
        channel_id: channelId,
        timestamp: input.timestamp || toLocalIso(now),
        source: input.source || record.source || 'nova',
        visibility: input.visibility || 'shareable',
        content_type: input.content_type || (input.kind === 'document' ? 'document' : 'text'),
        sender_id: input.sender_id || (role === 'user' ? userId : `role_${conv.id}`),
        sender_name: input.sender_name || (role === 'user' ? userName : conv.name),
        is_bot: input.is_bot ?? role === 'assistant',
        mentions_bot: input.mentions_bot ?? false,
        reply_to: input.reply_to ?? null,
      }
      // message-service 负责 message:* 事件；这里补齐结构化字段与 UI 字段
      const message = messages.add(conversationId, {
        role,
        content: String(input.content ?? ''),
        time: input.time || nowTime(now),
        status: input.status,
        kind: input.kind || (extra.content_type === 'document' ? 'document' : 'text'),
        streaming: false,
        meta: input.meta || {},
        extra,
      })
      if (!message) return null
      data.channels[channelId] = {
        ...(data.channels[channelId] || record),
        seq,
        lastAt: extra.timestamp,
      }
      persist()
      events.emit('chat:message-stored', { conversationId, channelId, message })
      return message
    },

    /**
     * 给通过 message-service 直接创建的消息（占位、降级回复、错误消息等）
     * 补上渠道元数据、seq 和 timestamp，保证历史顺序正确。
     */
    stampMessage(conversationId, messageId, patch = null) {
      const conv = sessions.get(conversationId)
      if (!conv) return null
      const record = ensureConversation(conv, { persistMeta: true })
      const message = sessions.message(conversationId, messageId)
      if (!message) return null
      if (!message.message_id || !message.channel_id || !message.timestamp || !message.seq) {
        const seq = (data.channels[record.channelId]?.seq || 0) + 1
        // 实时消息必须用“现在”，不能用 conv.createdAt + seq 的迁移启发式时间，否则会得到未来时间戳
        if (!message.timestamp) message.timestamp = toLocalIso(new Date())
        normalizeMessage(conv, message, seq)
        data.channels[record.channelId] = {
          ...(data.channels[record.channelId] || record),
          seq: Number(message.seq) || seq,
          lastAt: message.timestamp,
        }
        persist()
      }
      if (patch && typeof patch === 'object') Object.assign(message, patch)
      sessions.updateMessage(conversationId, messageId, {})
      return message
    },

    /** 追加一轮工具协议轨迹（assistant.tool_calls + role=tool），供下一轮构建模型上下文 */
    appendTranscript(channelId, messages) {
      const record = channelRecord(channelId)
      if (!record) return null
      const clean = (Array.isArray(messages) ? messages : [])
        .map(sanitizeProtocolMessage)
        .filter(Boolean)
        .slice(0, MAX_PROTOCOL_MESSAGES)
      if (!clean.length) return record
      let turns = [...(record.agentTurns || []), { at: toLocalIso(new Date()), messages: clean }].slice(-MAX_PROTOCOL_TURNS)
      // localStorage 有容量上限：超预算时丢弃最旧的轮次
      while (turns.length > 1 && JSON.stringify(turns).length > 200000) turns = turns.slice(1)
      record.agentTurns = turns
      data.channels[channelId] = record
      persist()
      events.emit('chat:transcript-updated', { channelId, turns: record.agentTurns.length })
      return record
    },

    /** 返回按顺序展开的协议消息；limitTurns > 0 时只取最近 N 轮 */
    transcriptMessages(channelId, { limitTurns = 0 } = {}) {
      const record = channelRecord(channelId)
      const turns = record?.agentTurns || []
      const selected = limitTurns > 0 ? turns.slice(-limitTurns) : turns
      return selected.flatMap(turn => turn.messages.map(sanitizeProtocolMessage).filter(Boolean))
    },

    /**
     * 返回按轮次分组的协议消息（保留每轮结束时间 at）。
     * 渠道 / 重新生成等 skipUserAppend 轮次历史上可能没有写入 user wire，
     * context-builder 需要按 at 把对应的可见用户消息补回对应轮次，避免模型失忆。
     */
    transcriptTurns(channelId, { limitTurns = 0 } = {}) {
      const record = channelRecord(channelId)
      const turns = record?.agentTurns || []
      const selected = limitTurns > 0 ? turns.slice(-limitTurns) : turns
      return selected.map(turn => ({
        at: String(turn?.at || ''),
        messages: (Array.isArray(turn?.messages) ? turn.messages : []).map(sanitizeProtocolMessage).filter(Boolean),
      }))
    },

    clearTranscript(channelId) {
      const record = channelRecord(channelId)
      if (!record || !record.agentTurns?.length) return false
      record.agentTurns = []
      data.channels[channelId] = record
      persist()
      return true
    },

    transcriptInfo(channelId) {
      const record = channelRecord(channelId)
      const turns = record?.agentTurns || []
      return {
        turns: turns.length,
        firstAt: turns[0]?.at || null,
        lastAt: turns[turns.length - 1]?.at || null,
      }
    },

    /** 渠道内全部消息（按 seq / 时间排序，自动补齐旧消息元数据） */
    messagesOf(channelId) {
      const record = channelRecord(channelId)
      if (!record) return []
      const conv = sessions.get(record.conversationId)
      if (!conv) return []
      ensureConversation(conv)
      return sortMessages((conv.messages || []).filter(message => !isDivider(message) && !message.streaming), record.channelId)
    },

    messageById(channelId, messageId) {
      return service.messagesOf(channelId).find(message => message.message_id === messageId || message.id === messageId) || null
    },

    /** 渠道消息总数（来自 session-service.messageCount，不要求原文已加载）。 */
    messageCount(channelId) {
      const record = channelRecord(channelId)
      if (!record) return 0
      if (typeof sessions.messageCount === 'function') return sessions.messageCount(record.conversationId) || 0
      return service.messagesOf(channelId).length
    },

    /** 分页加载渠道消息，并修正 chat-store 索引指向的 conversationId。 */
    async loadMessages(channelId, options = {}) {
      const record = channelRecord(channelId)
      if (!record || typeof sessions.loadMessages !== 'function') return null
      const result = await sessions.loadMessages(record.conversationId, options)
      const conv = sessions.get(record.conversationId)
      if (conv) {
        data.channels[channelId] = { ...(data.channels[channelId] || record), conversationId: conv.id }
        persist()
      }
      return result
    },

    /** 显式全量加载渠道原文（导出 / 搜索 / 保存编辑器）。 */
    async loadAllMessages(channelId) {
      const record = channelRecord(channelId)
      if (!record || typeof sessions.loadAllMessages !== 'function') return null
      return sessions.loadAllMessages(record.conversationId)
    },

    /**
     * 用一段 JSON 覆盖某个渠道的聊天记录（设置 → 聊天记录 JSON 编辑器使用）。
     * 只补齐结构字段，不允许写入 tool_call 协议消息；返回写入条数。
     */
    replaceMessages(channelId, list) {
      const record = channelRecord(channelId)
      if (!record) throw new Error(`渠道不存在：${channelId}`)
      const conv = sessions.get(record.conversationId)
      if (!conv) throw new Error('渠道对应的会话不存在')
      if (!Array.isArray(list)) throw new Error('聊天记录必须是 JSON 数组')
      const identity = currentUser()
      const userId = identity.userId
      const userName = identity.userName
      const usedSeqs = new Set()
      const usedIds = new Set()
      let nextSeq = 0
      const normalized = list.map((raw, index) => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`第 ${index + 1} 条不是合法的消息对象`)
        const role = raw.role === 'assistant' ? 'assistant' : raw.role === 'system' ? 'system' : 'user'
        let seq = Number(raw.seq)
        if (!Number.isFinite(seq) || seq <= 0 || usedSeqs.has(seq)) seq = nextSeq + 1
        usedSeqs.add(seq)
        nextSeq = Math.max(nextSeq, seq)
        const id = String(raw.message_id || raw.id || `m_${conv.id}_${seq}`)
        const uniqueId = usedIds.has(id) ? `${id}_${seq}` : id
        usedIds.add(uniqueId)
        const timestamp = raw.timestamp || toLocalIso(new Date())
        const kind = raw.kind === 'document' ? 'document' : 'text'
        return {
          ...raw,
          id: uniqueId,
          message_id: uniqueId,
          seq,
          channel_id: channelId,
          timestamp,
          role,
          content: String(raw.content ?? ''),
          content_type: raw.content_type || (kind === 'document' ? 'document' : 'text'),
          kind,
          time: raw.time || nowTime(new Date(timestamp)),
          visibility: raw.visibility || 'shareable',
          source: raw.source || record.source || 'nova',
          sender_id: raw.sender_id || (role === 'user' ? userId : `role_${conv.id}`),
          sender_name: raw.sender_name || (role === 'user' ? userName : conv.name),
          is_bot: raw.is_bot ?? role === 'assistant',
          mentions_bot: raw.mentions_bot ?? false,
          reply_to: raw.reply_to ?? null,
          meta: raw.meta && typeof raw.meta === 'object' && !Array.isArray(raw.meta) ? raw.meta : {},
        }
      })
      const last = normalized.at(-1)
      sessions.update(conv.id, { messages: normalized, preview: last?.content || '', time: last?.time || '' })
      data.channels[channelId] = {
        ...(data.channels[channelId] || record),
        seq: normalized.reduce((max, message) => Math.max(max, Number(message.seq) || 0), 0),
        lastAt: last?.timestamp || null,
        agentTurns: [],
      }
      persist()
      events.emit('chat:messages-replaced', { conversationId: conv.id, channelId, count: normalized.length })
      return { ok: true, count: normalized.length }
    },

    /** 渠道最近 limit 轮（默认 5；0 表示不取），返回消息数组 */
    rounds: (channelId, limit = 5) => {
      const all = groupRounds(service.messagesOf(channelId))
      const take = Number.isFinite(Number(limit)) ? Math.max(0, Number(limit)) : 5
      return take > 0 ? all.slice(-take) : []
    },

    /** 渠道清单：供 context-builder 把可读 / 可写渠道名告诉模型，工具调用不再只认内部 ID。 */
    channels() {
      return Object.values(data.channels).map(record => {
        const conv = sessions.get(record.conversationId)
        return {
          channelId: record.channelId,
          conversationId: record.conversationId,
          name: conv?.name || record.channelId,
          roleId: record.roleId,
          group: record.group,
          source: record.source,
          crossReadable: record.crossReadable === true,
          crossSendable: record.crossSendable === true,
          messages: record.seq || 0,
          hiddenFromSessionList: conv?.meta?.hiddenFromSessionList === true,
          lastAt: record.lastAt || null,
        }
      })
    },

    /** 角色级工作记忆：只聚合普通私聊渠道，按 timestamp 合并去重，取最近 limit 轮 */
    workingMessages({ roleId, limit = 5, excludeChannelId = null } = {}) {
      const channels = Object.values(data.channels).filter(
        record =>
          record.roleId === roleId &&
          record.participatesWorkingMemory &&
          record.group === 'private' &&
          record.channelId !== excludeChannelId,
      )
      const all = []
      for (const record of channels) all.push(...service.messagesOf(record.channelId))
      const seen = new Set()
      const deduped = all.filter(message => {
        const key = message.message_id || message.id
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      const rounds = groupRounds(deduped, sortMessagesByTime)
      const take = Number.isFinite(Number(limit)) ? Math.max(0, Number(limit)) : 5
      return take > 0 ? rounds.slice(-take).flatMap(round => round.messages) : []
    },

    /** 供 read_messages 使用：关键词 / seq / 相对序号 / 时间 / 游标 */
    search({ channelId, query = '', seq = null, relative = null, limit = 10, timeStart = null, timeEnd = null, cursor = null } = {}) {
      const all = service.messagesOf(channelId)
      let list = all
      let relativeRange = relative
      if (typeof relativeRange === 'string') {
        // 兼容 "+1..+5" / "1:5" 这类相对范围写法；第二种数字为范围末偏移
        const match = relativeRange.trim().match(/^([+-]?\d+)\s*(?:\.\.|~|:|至)\s*([+-]?\d+)$/)
        if (match) relativeRange = { base: data.channels[channelId]?.seq || 0, from: Number(match[1]), to: Number(match[2]) }
      }
      if (seq !== null && seq !== undefined && seq !== '') {
        const target = Number(seq)
        list = list.filter(message => Number(message.seq) === target)
      }
      if (relativeRange) {
        const base = Number(relativeRange.base ?? data.channels[channelId]?.seq ?? 0)
        const from = Number(relativeRange.from ?? relativeRange[0] ?? 0)
        const to = Number(relativeRange.to ?? relativeRange[1] ?? from)
        const lo = Math.min(from, to)
        const hi = Math.max(from, to)
        list = list.filter(message => {
          const offset = Number(message.seq) - base
          return offset >= lo && offset <= hi
        })
      }
      if (query) {
        const needle = String(query).toLowerCase()
        list = list.filter(
          message =>
            String(message.content || '').toLowerCase().includes(needle) ||
            String(message.sender_name || '').toLowerCase().includes(needle) ||
            String(message.meta?.title || '').toLowerCase().includes(needle),
        )
      }
      if (timeStart) {
        const t = Date.parse(timeStart)
        if (!Number.isNaN(t)) list = list.filter(message => (Date.parse(message.timestamp) || 0) >= t)
      }
      if (timeEnd) {
        const t = Date.parse(timeEnd)
        if (!Number.isNaN(t)) list = list.filter(message => (Date.parse(message.timestamp) || 0) <= t)
      }
      const total = list.length
      const offset = Math.max(0, Number(cursor) || 0)
      const size = Math.max(1, Math.min(50, Number(limit) || 10))
      const page = list.slice(offset, offset + size)
      return {
        total,
        returned: page.length,
        offset,
        next_cursor: offset + page.length < total ? offset + page.length : null,
        messages: page,
      }
    },

    listChannels: () => Object.values(data.channels).map(record => ({ ...record })),

    stats() {
      const records = Object.values(data.channels)
      const messageCount = records.reduce((sum, record) => {
        const conv = sessions.get(record.conversationId)
        if (!conv) return sum
        return sum + (Number(conv.messageCount) || conv.messages?.length || 0)
      }, 0)
      return { channels: records.length, messages: messageCount }
    },
  }

  // 启动时补齐已存在的会话（含老数据迁移）：只改内存，下一次写盘自然持久化
  for (const conv of sessions.list()) ensureConversation(conv)
  persist()

  // 会话创建 / 从后端同步 / 角色信息变化时，保证渠道元数据存在
  const refresh = payload => {
    const dropTranscriptIfEmpty = conv => {
      if (!conv) return
      // 分页加载后内存里 messages 为空是常态；messageCount > 0 说明后端仍有原文，不能清轨迹。
      if (Array.isArray(conv.messages) && conv.messages.length > 0) return
      if (Number(conv.messageCount) > 0) return
      const channelId = conv.meta?.channelId || novaChannelId(conv.id)
      const record = data.channels[channelId]
      if (record?.agentTurns?.length) record.agentTurns = []
    }
    if (Array.isArray(payload?.conversations)) {
      for (const conv of payload.conversations) {
        ensureConversation(conv)
        dropTranscriptIfEmpty(conv)
      }
    } else {
      const conv = payload?.conversation || payload?.id
      if (conv && typeof conv === 'object') {
        ensureConversation(conv, { persistMeta: true })
        dropTranscriptIfEmpty(conv)
      } else if (conv) {
        const found = sessions.get(conv)
        if (found) {
          ensureConversation(found, { persistMeta: true })
          dropTranscriptIfEmpty(found)
        }
      }
    }
    persist()
  }
  const offCreate = events.on('conversation:create', refresh)
  const offSync = events.on('conversation:sync', refresh)
  const offUpdate = events.on('conversation:update', refresh)
  const offDelete = events.on('conversation:delete', payload => {
    const channelId = payload?.conversation?.meta?.channelId || (payload?.id ? novaChannelId(payload.id) : null)
    if (channelId && data.channels[channelId]) {
      delete data.channels[channelId]
      persist()
    }
  })

  ctx.provide('chat-store', service, { type: 'singleton' })
  ctx.effect(offCreate)
  ctx.effect(offSync)
  ctx.effect(offUpdate)
  ctx.effect(offDelete)
  ctx.logger.debug(`聊天记录库就绪 · ${service.stats().channels} 个渠道`)
}
