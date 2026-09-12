/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * B? · chat-tools
 * 聊天工具集（文档 §6）：
 *   read_messages  读取当前 / 有权限的其它渠道历史
 *   chat_send      发送聊天消息（可多条，end=true 结束本轮）
 *   send_document  发送长资料（原文入库，聊天记录只存引用）
 *   read_document  按需分段读取资料原文（结果作为 role=tool 返回）
 *
 * 本插件只负责“把业务能力包装成工具”，权限、存储、上下文都是注入的独立服务。
 */
export const name = 'chat-tools'
export const version = '1.0.0'
export const displayName = '聊天工具集'
export const description = '业务功能 · read_messages / chat_send / send_document / read_document。'
export const author = '念风内核'
export const icon = '🧰'
export const core = true
export const depends = {
  'tool-registry': '^1.0.0',
  'chat-store': '^1.0.0',
  'document-service': '^1.0.0',
  'chat-permissions': '^1.0.0',
  'context-builder': '^1.0.0',
  config: '^1.0.0',
}
export const inject = ['tool-registry', 'chat-store', 'document-service', 'chat-permissions', 'context-builder', 'session-service', 'config', 'event-bus']
export const provides = [{ name: 'chat-tools', type: 'singleton' }]

import { looksLikeToolMarkup, parseTextToolCalls } from '../../../src/util/tool-text.mjs'

export function apply(ctx) {
  const registry = ctx.inject('tool-registry')
  const store = ctx.inject('chat-store')
  const documents = ctx.inject('document-service')
  const permissions = ctx.inject('chat-permissions')
  const contextBuilder = ctx.inject('context-builder')
  const sessions = ctx.inject('session-service')
  const config = ctx.inject('config')
  const events = ctx.inject('event-bus')

  const unavailable = () => ({ ok: false, code: 'CHANNEL_UNAVAILABLE', error: '目标渠道不可用' })

  const sleep = (ms, entry) =>
    new Promise(resolve => {
      const started = Date.now()
      const tick = () => {
        if (entry?.cancelled === true) return resolve()
        if (Date.now() - started >= ms) return resolve()
        setTimeout(tick, Math.min(60, ms))
      }
      tick()
    })

  /** 按消息字数计算动态打字延迟：最小 0.5s，最大 5s（可通过 chat.typing* 配置） */
  const typingDelayMs = content => {
    const min = Math.max(0, Number(config.get('chat.typingMinMs', 500)) || 500)
    const max = Math.max(min, Number(config.get('chat.typingMaxMs', 5000)) || 5000)
    const perChar = Math.max(0, Number(config.get('chat.typingPerCharMs', 35)) || 35)
    return Math.max(min, Math.min(max, Math.round(250 + String(content ?? '').length * perChar)))
  }

  /** 工具参数里的 channel 缺省 = 当前渠道 */
  const authorize = async (args, context, action) => {
    const target = args?.channel ? String(args.channel) : null
    const decision = await permissions.authorize({
      conversationId: context.conversationId,
      action,
      channel: target,
    })
    return decision
  }

  /** 保留权限层给出的真实原因（无权限 / 需要确认 / 用户拒绝），不要一律吞成“目标渠道不可用”。 */
  const denied = decision => ({ ok: false, code: decision.code, error: decision.error || '目标渠道不可用' })

  const readMessages = async (args, context) => {
    const decision = await authorize(args, context, 'read')
    if (!decision.ok) return denied(decision)
    const query = args.query ?? (args.semantic ? String(args.semantic) : '')
    const result = store.search({
      channelId: decision.channelId,
      query,
      seq: args.seq ?? null,
      relative: args.relative ?? null,
      limit: args.limit ?? 10,
      timeStart: args.time_start ?? null,
      timeEnd: args.time_end ?? null,
      cursor: args.cursor ?? null,
    })

    const maxTokens = Math.max(200, Number(config.get('chat.readTokens', 1500)) || 1500)
    const items = []
    let used = 0
    let truncated = false
    for (const message of result.messages) {
      const item = contextBuilder.formatForTool(message)
      const tokens = contextBuilder.estimateTokens(JSON.stringify(item))
      if (items.length && used + tokens > maxTokens) {
        truncated = true
        break
      }
      items.push(item)
      used += tokens
    }

    const payload = {
      ok: true,
      channel: decision.channelId,
      total: result.total,
      returned: items.length,
      next_cursor: truncated ? result.offset + items.length : result.next_cursor,
      truncated,
      messages: items,
    }
    if (truncated) payload.hint = '结果超过单次读取 token 上限，已返回部分消息；请缩小时间 / 关键词范围或使用 cursor 继续。'
    if (args.semantic) {
      payload.semantic_applied = false
      payload.hint = [payload.hint, '语义检索将在第三阶段启用，本次已按关键词匹配。'].filter(Boolean).join(' ')
    }
    return payload
  }

  const chatSend = async (args, context) => {
    const decision = await authorize(args, context, 'send')
    if (!decision.ok) return denied(decision)

    const conv = sessions.get(context.conversationId)
    const channelId = decision.channelId
    const isCurrent = channelId === context.channelId
    // 跨渠道发送时，消息写入目标渠道对应的会话；默认渠道永远写当前会话
    const conversationId = isCurrent ? context.conversationId : store.conversationIdFor(channelId)
    const targetConv = conversationId ? sessions.get(conversationId) : null
    if (!targetConv) return unavailable()

    const messageInput = args.messages ?? args.message ?? args.content
    const rawList = Array.isArray(messageInput) ? messageInput : messageInput === undefined || messageInput === null ? [] : [messageInput]
    const sent = []
    const duplicates = []
    let reasoningAttached = false
    const delivery = context.delivery || { count: 0 }
    const simulate = config.get('chat.simulateTyping', true) && isCurrent
    const emitTyping = typing => {
      if (simulate) events.emit('chat:typing', { conversationId, channelId, typing })
    }
    for (const raw of rawList) {
        if (context.entry?.cancelled === true) return { ok: false, code: 'CHAT_ABORTED', error: '请求已取消' }
        const item = typeof raw === 'string' ? { content: raw } : raw || {}
        const content = String(item.content ?? item.text ?? '').trim()
        if (!content) continue
        const existing = context.sentContents?.get(content)
        if (existing) {
          duplicates.push({ content, message_id: existing })
          continue
        }
        // 首条消息不延迟；从第二条开始，按字数计算 0.5s ~ 5s 的动态延迟
        if (simulate && delivery.count > 0) {
          emitTyping(true)
          await sleep(typingDelayMs(content), context.entry)
          emitTyping(false)
          if (context.entry?.cancelled === true) return { ok: false, code: 'CHAT_ABORTED', error: '请求已取消' }
        }
        const message = store.append(conversationId, {
          role: 'assistant',
          content,
          content_type: item.content_type || 'text',
          sender_id: `role_${targetConv.id}`,
          sender_name: targetConv.name,
          is_bot: true,
          source: 'nova',
          visibility: 'shareable',
          meta: {
            via: 'chat_send',
            round: context.round,
            channel: channelId,
            ...(context.reasoningContent && !reasoningAttached ? { reasoningContent: context.reasoningContent } : {}),
          },
        })
        if (!message) continue
        context.sentContents?.set(content, message.message_id)
        reasoningAttached = true
        delivery.count += 1
        sent.push(message.message_id)
    }

    if (!sent.length && !duplicates.length) {
      return { ok: false, error: 'messages 不能为空：请传入要发送的文本（可多条），并设置 end 表示是否结束本轮。' }
    }

    return {
      ok: true,
      channel: channelId,
      message_ids: sent,
      duplicates: duplicates.length ? duplicates : undefined,
      sent_at: store.toLocalIso(),
      end: args.end === true || args.end === 'true',
    }
  }

  const sendDocument = async (args, context) => {
    const decision = await authorize(args, context, 'send')
    if (!decision.ok) return denied(decision)

    const channelId = decision.channelId
    const isCurrent = channelId === context.channelId
    const conversationId = isCurrent ? context.conversationId : store.conversationIdFor(channelId)
    const targetConv = conversationId ? sessions.get(conversationId) : null
    if (!targetConv) return unavailable()

    const title = String(args.title || '未命名资料').slice(0, 200)
    const summary = String(args.summary || '').slice(0, 500)
    const content = String(args.content ?? '')
    if (!content.trim()) return { ok: false, error: '资料内容不能为空' }

    const reference = documents.put({
      title,
      summary,
      content,
      content_type: args.content_type || 'text/plain',
      channelId,
      source: 'nova',
    })

    const delivery = context.delivery || { count: 0 }
    const simulate = config.get('chat.simulateTyping', true) && isCurrent
    if (simulate && delivery.count > 0) {
      events.emit('chat:typing', { conversationId, channelId, typing: true })
      await sleep(typingDelayMs(summary || title), context.entry)
      events.emit('chat:typing', { conversationId, channelId, typing: false })
      if (context.entry?.cancelled === true) return { ok: false, code: 'CHAT_ABORTED', error: '请求已取消' }
    }

    // 聊天记录只存引用和缩略，不存资料全文
    const message = store.append(conversationId, {
      role: 'assistant',
      content: summary || title,
      kind: 'document',
      content_type: 'document',
      sender_id: `role_${targetConv.id}`,
      sender_name: targetConv.name,
      is_bot: true,
      source: 'nova',
      visibility: 'shareable',
      meta: {
        via: 'send_document',
        round: context.round,
        ...(context.reasoningContent ? { reasoningContent: context.reasoningContent } : {}),
        docId: reference.doc_id,
        title: reference.title,
        summary: reference.summary,
        documentType: reference.content_type,
        tokens: reference.tokens,
        length: reference.length,
      },
    })
    delivery.count += 1

    return {
      ok: true,
      channel: channelId,
      doc_id: reference.doc_id,
      title: reference.title,
      summary: reference.summary,
      content_type: reference.content_type,
      tokens: reference.tokens,
      message_ids: message ? [message.message_id] : [],
      sent_at: store.toLocalIso(),
      end: args.end === true || args.end === 'true',
    }
  }

  const readDocument = async (args, context) => {
    const docId = String(args.doc_id || args.docId || '').trim()
    if (!docId) return { ok: false, error: '缺少 doc_id' }
    const doc = documents.get(docId)
    if (!doc) return { ok: false, error: '资料不存在或已被清理' }
    if (doc.channel_id && doc.channel_id !== context.channelId) {
      const decision = await permissions.authorize({
        conversationId: context.conversationId,
        action: 'read',
        channel: doc.channel_id,
      })
      if (!decision.ok) return denied(decision)
    }
    const maxTokens = Math.max(100, Math.min(Number(args.max_tokens) || 0 || Number(config.get('chat.readTokens', 1500)) || 1500, 4000))
    const result = documents.read(docId, { offset: args.offset ?? 0, maxTokens })
    return { ok: result.ok, ...result, error: result.error }
  }

  const disposers = [
    registry.register(
      'read_messages',
      {
        description:
          '读取聊天记录。默认当前渠道；可用 query 关键词、seq 精确序号、relative 相对序号范围、time_start / time_end 时间段、semantic 语义检索、cursor 分页。',
        parameters: {
          type: 'object',
          properties: {
            channel: { type: 'string', description: '目标渠道 ID，默认当前渠道；跨渠道需要权限。' },
            query: { type: 'string', description: '关键词过滤。' },
            seq: { type: 'number', description: '精确消息序号。' },
            relative: {
              type: 'object',
              description: '相对序号范围，例如 { base: 5, from: 1, to: 5 } 表示第 6~10 条。',
              properties: { base: { type: 'number' }, from: { type: 'number' }, to: { type: 'number' } },
            },
            limit: { type: 'number', description: '返回条数，默认 10，最大 50。' },
            time_start: { type: 'string', description: 'ISO 8601 起始时间。' },
            time_end: { type: 'string', description: 'ISO 8601 结束时间。' },
            semantic: { type: 'string', description: '语义检索内容（第三阶段启用，当前回退为关键词）。' },
            cursor: { type: 'number', description: '上一页返回的 next_cursor。' },
          },
        },
      },
      readMessages,
    ),
    registry.register(
      'chat_send',
      {
        description:
          '发送一条或多条聊天消息。只有通过本工具发送的内容才会展示给用户。end=true 表示发送后结束本轮，end=false 表示继续下一轮工具调用。',
        parameters: {
          type: 'object',
          properties: {
            channel: { type: 'string', description: '目标渠道 ID，默认当前渠道；跨渠道需要权限。' },
            messages: {
              type: 'array',
              items: { type: 'string' },
              description: '要发送的消息文本列表。',
            },
            end: { type: 'boolean', description: 'true=发送后结束本轮；false=发送后继续下一步。' },
          },
          required: ['messages'],
        },
      },
      chatSend,
    ),
    registry.register(
      'send_document',
      {
        description:
          '发送长文本 / 资料 / 文献。原文存入资料库，聊天记录只保存标题、缩略和 doc_id；之后可用 read_document 读取原文。',
        parameters: {
          type: 'object',
          properties: {
            channel: { type: 'string', description: '目标渠道 ID，默认当前渠道。' },
            title: { type: 'string', description: '资料标题。' },
            summary: { type: 'string', description: '一句话缩略，展示在聊天记录里。' },
            content_type: { type: 'string', description: '如 text/markdown、text/plain。' },
            content: { type: 'string', description: '资料原文。' },
            end: { type: 'boolean', description: 'true=发送后结束本轮。' },
          },
          required: ['content'],
        },
      },
      sendDocument,
    ),
    registry.register(
      'read_document',
      {
        description: '按需读取资料原文。单次受 token 上限约束；返回 truncated=true 时用 next_offset 继续读取。',
        parameters: {
          type: 'object',
          properties: {
            doc_id: { type: 'string', description: 'send_document 返回的 doc_id。' },
            offset: { type: 'number', description: '从第几个字符开始读，默认 0。' },
            max_tokens: { type: 'number', description: '本次最多返回的 token 数。' },
          },
          required: ['doc_id'],
        },
      },
      readDocument,
    ),
  ]

  const service = {
    name: 'chat-tools',
    definitions: () => registry.definitions(),
    names: () => registry.names(),
    execute: (name, args, context) => registry.execute(name, args, context),
    /** 文本工具调用兼容解析（模型不支持原生 function calling 时使用） */
    parseTextCalls: text => parseTextToolCalls(text, registry.names()),
    looksLikeToolMarkup: text => looksLikeToolMarkup(text),
  }

  ctx.provide('chat-tools', service, { type: 'singleton' })
  ctx.effect(() => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch (_) {
        /* ignore */
      }
    }
  })
  ctx.logger.debug(`聊天工具集就绪（${registry.names().length} 个工具）`)
}
