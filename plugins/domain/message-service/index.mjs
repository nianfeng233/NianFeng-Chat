/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * D2 · message-service
 * 消息增删改、流式追加、状态管理（文档 §6.1）。
 * 所有消息事件（message:added / chunk / done / error / updated / delete）的唯一来源。
 */
export const name = 'message-service'
export const version = '1.0.0'
export const displayName = '消息服务'
export const description = '业务服务 · 消息增删改与流式状态管理。'
export const author = '念风内核'
export const icon = '✉️'
export const core = true
export const depends = {
  'config': '^1.0.0',
  'event-bus': '*',
  'session-service': '^2.0.0',
}
export const optionalDepends = {}
export const inject = ['session-service', 'event-bus', 'config']
export const provides = [{ name: 'message-service', type: 'singleton' }]

import { nowTime } from '../../../src/util/format.mjs'
import {
  DEFAULT_DIVIDER_GAP_MS,
  DEFAULT_DIVIDER_INTERVAL_MS,
  formatFullDateTime,
  messageTimestampMs,
  toDate,
} from '../../../src/util/time-format.mjs'

let localSeq = 0

export function apply(ctx) {
  const sessions = ctx.inject('session-service')
  const events = ctx.inject('event-bus')
  const config = ctx.inject('config')

  const newId = () => `m${Date.now().toString(36)}${(++localSeq).toString(36)}`

  const emit = (event, payload) => events.emit(event, payload, { owner: 'message-service', interceptor: event === 'message:send' })

  const positiveNumber = (value, fallback) => {
    const num = Number(value)
    return Number.isFinite(num) && num >= 0 ? num : fallback
  }

  const dividerGapMs = () => positiveNumber(config.get('chat.dividerGapMs', DEFAULT_DIVIDER_GAP_MS), DEFAULT_DIVIDER_GAP_MS)
  const dividerIntervalMs = () => positiveNumber(config.get('chat.dividerIntervalMs', DEFAULT_DIVIDER_INTERVAL_MS), DEFAULT_DIVIDER_INTERVAL_MS)

  /** 会话里真正参与对话的消息（扣除时间戳分隔线与系统占位） */
  const conversationalMessages = conv => (conv.messages || []).filter(message => message.kind !== 'divider' && message.role !== 'system')

  const lastDividerAt = conv => {
    for (let index = conv.messages.length - 1; index >= 0; index -= 1) {
      const message = conv.messages[index]
      if (message.kind !== 'divider') continue
      const at = messageTimestampMs(message, NaN)
      return Number.isFinite(at) ? at : null
    }
    return null
  }

  /**
   * 时间戳插入规则（对应产品要求）：
   *   1. 第一次聊天：先创建时间戳；
   *   2. 连续聊天（上一条消息间隔 ≤ 10 分钟）每半小时补一条；
   *   3. 等待超过 10 分钟才出现新消息：补一条。
   * 阈值可通过 config 调整，便于测试与用户自定义。
   */
  const shouldInsertDivider = (conv, nowMs) => {
    const list = conversationalMessages(conv)
    if (!list.length) return true
    const previousAt = messageTimestampMs(list[list.length - 1], nowMs)
    if (nowMs - previousAt > dividerGapMs()) return true
    const previousDividerAt = lastDividerAt(conv)
    if (previousDividerAt === null) return true
    return nowMs - previousDividerAt >= dividerIntervalMs()
  }

  const insertDivider = (convId, atMs = Date.now()) => {
    const date = new Date(atMs)
    sessions.appendMessage(convId, {
      id: newId(),
      role: 'system',
      kind: 'divider',
      content: formatFullDateTime(date),
      time: '',
      timestamp: date.toISOString(),
      meta: { at: date.getTime() },
    })
  }

  const service = {
    name: 'message-service',

    list: convId => sessions.messages(convId),
    get: (convId, id) => sessions.message(convId, id),

    /** 新增一条消息并广播 message:added
     *  extra：结构化聊天记录字段（message_id / seq / channel_id / timestamp …），
     *  由 chat-store 等上层服务注入，普通 UI 调用不需要关心。
     */
    add(convId, { role, content = '', time = nowTime(), status, kind = 'text', meta, streaming = false, extra, withDivider = true } = {}) {
      const conv = sessions.get(convId)
      if (!conv) return null
      // 消息自身带 timestamp / createdAt 时（导入历史、测试注入等），时间戳分隔线也按该时间生成。
      const messageDate =
        toDate(extra?.timestamp ?? meta?.at ?? extra?.createdAt ?? null) || new Date()
      const messageAt = messageDate.getTime()
      if (withDivider && kind !== 'divider' && role !== 'system' && shouldInsertDivider(conv, messageAt)) insertDivider(convId, messageAt)
      const message = {
        id: (extra && extra.id) || newId(),
        role,
        content,
        time,
        status,
        kind,
        streaming,
        createdAt: messageAt,
        meta: meta || {},
        ...(extra || {}),
      }
      if (extra?.id) message.id = extra.id
      sessions.appendMessage(convId, message)
      emit('message:added', { conversationId: convId, message })
      return message
    },

    /** 用户消息：带 demo 的 已发送 → 已送达 → 已读 状态机 */
    send(convId, content, { scheduleStatus = true, meta = undefined, withDivider = true } = {}) {
      const message = service.add(convId, { role: 'user', content, status: 'sent', meta, withDivider })
      if (!message) return null
      if (scheduleStatus) {
        ctx.setTimeout(() => {
          const current = service.get(convId, message.id)
          if (current?.status === 'sent') service.update(convId, message.id, { status: 'delivered' })
        }, 700)
        ctx.setTimeout(() => {
          const current = service.get(convId, message.id)
          if (current?.status === 'delivered') service.update(convId, message.id, { status: 'read' })
        }, 1800)
      }
      return message
    },

    /** 助手占位消息，等待流式内容 */
    placeholder(convId) {
      return service.add(convId, { role: 'assistant', content: '', streaming: true })
    },

    /** 流式追加一个片段 */
    appendChunk(convId, messageId, delta) {
      const message = service.get(convId, messageId)
      if (!message) return null
      message.content += delta
      sessions.updateMessage(convId, messageId, { content: message.content })
      if (delta) emit('message:chunk', { conversationId: convId, id: messageId, message, delta })
      return message
    },

    finish(convId, messageId, patch = {}) {
      const message = service.get(convId, messageId)
      if (!message) return null
      Object.assign(message, { streaming: false, ...patch })
      sessions.updateMessage(convId, messageId, message)
      sessions.touch(convId, { preview: message.content })
      emit('message:done', { conversationId: convId, message })
      return message
    },

    fail(convId, messageId, error) {
      const message = service.get(convId, messageId)
      if (!message) return null
      Object.assign(message, { streaming: false, error: String(error?.message || error) })
      sessions.updateMessage(convId, messageId, message)
      emit('message:error', { conversationId: convId, id: messageId, message, error })
      return message
    },

    update(convId, messageId, patch) {
      const message = sessions.updateMessage(convId, messageId, patch)
      if (!message) return null
      emit('message:updated', { conversationId: convId, message })
      return message
    },

    remove(convId, messageId) {
      const ok = sessions.removeMessage(convId, messageId)
      if (ok) emit('message:delete', { conversationId: convId, id: messageId })
      return ok
    },

    /** 请求发送（供 composer 等 UI 调用；chat-flow 监听）
     *  payload: { conversationId, text, images? }
     */
    requestSend(conversationId, text, extras = {}) {
      const payload = { conversationId, text, ...(extras || {}) }
      const result = events.emit('message:send', payload, {
        owner: 'message-service',
        interceptor: true,
        onIntercept: (next, pluginId) => ctx.logger.debug(`[${pluginId}] 修改了 message:send`, next),
      })
      return result
    },
  }

  ctx.provide('message-service', service, { type: 'singleton' })
  ctx.logger.debug('消息服务就绪')
}
