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
 *                   可一次发送多篇（documents 数组）；渠道侧按「聊天记录转发」发送：
 *                   转发里第一条是标题，往下是正文；多篇资料各自一条转发。
 *   read_document  按需分段读取资料原文（结果作为 role=tool 返回）
 *
 * 本插件只负责“把业务能力包装成工具”，权限、存储、上下文都是注入的独立服务。
 */
export const name = 'chat-tools'
export const version = '1.1.0'
export const displayName = '聊天工具集'
export const description = '业务功能 · read_messages / chat_send / send_document / read_document。'
export const author = '念风内核'
export const icon = '🧰'
export const core = true
export const depends = {
  'chat-permissions': '^1.0.0',
  'chat-store': '^1.0.0',
  'config': '^1.0.0',
  'context-builder': '^1.0.0',
  'document-service': '^1.0.0',
  'event-bus': '*',
  'session-service': '>=2.0.0',
  'tool-registry': '^1.0.0',
}
export const optionalDepends = {
  'napcat': '^1.0.0',
  'backend-client': '>=1.0.0',
  'image-service': '>=1.0.0',
}
export const inject = [
  'tool-registry',
  'chat-store',
  'document-service',
  'chat-permissions',
  'context-builder',
  'session-service',
  'config',
  'event-bus',
  'api?',
  'napcat-channel?',
  'image-service?',
]
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
  const api = ctx.inject('api?')
  const napcatChannel = ctx.inject('napcat-channel?')
  const imageService = ctx.inject('image-service?') || ctx.registry.get('image-service')
  const memoryStore = () => ctx.registry.get('memory-store')

  const messageTextForSearch = message => {
    const content = message?.content
    if (Array.isArray(content)) {
      return content
        .map(part => (typeof part === 'string' ? part : part?.type === 'text' ? part.text || '' : '[图片]'))
        .filter(Boolean)
        .join('\n')
    }
    return String(content ?? '')
  }

  const unavailable = () => ({ ok: false, code: 'CHANNEL_UNAVAILABLE', error: '目标渠道不可用' })

  /** 目标是否是真正的外部渠道（Nova 网页会话不算）。 */
  const isExternalChannel = channelId => {
    const record = store.channelRecord?.(channelId)
    return !!record && record.source !== 'nova' && !String(channelId || '').startsWith('nova:web:')
  }

  /** 支持「合并转发（聊天记录）」的渠道类型：目前只有 NapCat / OneBot 的 QQ 私聊与群聊。 */
  const FORWARD_CHANNEL_SOURCES = new Set(['napcat'])
  const supportsForward = channelId => FORWARD_CHANNEL_SOURCES.has(String(store.channelRecord?.(channelId)?.source || ''))

  /** 资料发送结果给模型看的一句提示：QQ 合并转发 / 其它外部渠道 / 网页资料卡片。 */
  const documentDeliveryNote = (channelId, count) => {
    if (supportsForward(channelId)) {
      return count > 1
        ? `已按 ${count} 条聊天记录转发到渠道（每份资料一条转发）；不要再用 chat_send 重复正文。`
        : '资料已按「标题 + 正文」转发到渠道；不要再用 chat_send 重复正文。'
    }
    if (isExternalChannel(channelId)) {
      return `资料已发到渠道（该渠道不支持合并转发，正文按长消息阈值截断）；不要再用 chat_send 重复正文。`
    }
    return '资料已存入资料库，聊天记录只保留标题与缩略；需要原文时用 read_document。'
  }

  const queuedDelivery = channelId =>
    isExternalChannel(channelId)
      ? {
          delivery: 'queued',
          delivery_note: '消息已进入渠道外发队列；实际发送结果会写入聊天记录与运行日志，失败时会回写错误提示。',
        }
      : { delivery: 'inline' }

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

  /**
   * chat_send 的 images 统一处理：
   *   - model 给 data URL：优先存 image-service，消息里只留 imageId；
   *   - http(s) 外链：保留 URL，由渠道桥下载/转存；
   *   - 已经是 imageId 对象：透传。
   */
  async function normalizeOutboundImages(input) {
    const imageService = ctx.registry.get('image-service')
    const list = (Array.isArray(input) ? input : []).slice(0, 4)
    const out = []
    for (const raw of list) {
      const image =
        typeof raw === 'string'
          ? /^data:image\//i.test(raw)
            ? { dataUrl: raw }
            : { url: raw }
          : raw || {}
      if (image.id) {
        out.push({ id: String(image.id), mime: image.mime || '', name: String(image.name || '').slice(0, 80) })
        continue
      }
      const source = image.dataUrl || image.url || ''
      if (!source) continue
      if (/^data:image\//i.test(source) && imageService?.saveDataUrl) {
        try {
          out.push({ ...(await imageService.saveDataUrl(source, image)) })
          continue
        } catch (_) {
          /* 后端不可用时降级为 dataUrl 存在消息里 */
        }
      }
      out.push({
        id: '',
        url: image.url || '',
        dataUrl: image.dataUrl || '',
        mime: image.mime || '',
        name: String(image.name || '').slice(0, 80),
      })
    }
    return out
  }

  /** 把工具结果消息裁到 token 预算内：至少保留第一条，超限时截断并标记。 */
  const formatToolMessages = (messageList, maxTokens) => {
    const items = []
    let used = 0
    let truncated = false
    for (const message of messageList || []) {
      const item = contextBuilder.formatForTool(message)
      if (!item) continue
      const tokens = contextBuilder.estimateTokens(JSON.stringify(item))
      if (items.length && used + tokens > maxTokens) {
        truncated = true
        break
      }
      items.push(item)
      used += tokens
    }
    return { items, used, truncated }
  }

  /** 按需查看图片：默认只给 [图片] 占位；include_images / image_message_ids 才真带原图。 */
  const collectToolImages = (candidates, { includeImages = false, wantedIds = [], imageLimit = 2 } = {}) => {
    const images = []
    if (!includeImages && !wantedIds.length) return images
    for (const message of candidates || []) {
      if (images.length >= imageLimit) break
      const messageId = String(message.message_id || message.id || '')
      const list = Array.isArray(message.meta?.images) ? message.meta.images : []
      for (const image of list) {
        if (images.length >= imageLimit) break
        const url = image?.dataUrl || image?.url
        if (!url) continue
        images.push({ type: 'image_url', image_url: { url: String(url) }, message_id: messageId })
      }
    }
    return images
  }

  const filterMessagesByTime = (messageList, timeStart, timeEnd) => {
    const from = timeStart ? Date.parse(timeStart) : NaN
    const to = timeEnd ? Date.parse(timeEnd) : NaN
    return (messageList || []).filter(message => {
      const at = Date.parse(message?.timestamp || '')
      if (Number.isNaN(at)) return true
      if (!Number.isNaN(from) && at < from) return false
      if (!Number.isNaN(to) && at > to) return false
      return true
    })
  }

  /**
   * 旧关键词 / 序号 / 时间检索路径。semantic 未启用或语义检索不可用时回退到这里。
   * options.semanticHint 只用于在结果里如实说明“语义没有生效 / 已回退”。
   */
  const runKeywordRead = async (args, context, decision, { queryOverride = null, semanticHint = '' } = {}) => {
    const query = queryOverride ?? args.query ?? ''
    // 浏览器默认只缓存最近可见的一页；模型显式 read_messages 检索历史时必须按需拉全量。
    const targetRecord = store.channelRecord?.(decision.channelId)
    if (targetRecord?.conversationId && typeof sessions.loadAllMessages === 'function') {
      await sessions.loadAllMessages(targetRecord.conversationId).catch(() => null)
    }
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
    const { items, truncated } = formatToolMessages(result.messages, maxTokens)
    const includeImages = args.include_images === true || String(args.include_images) === 'true'
    const wantedIds = Array.isArray(args.image_message_ids)
      ? args.image_message_ids.map(item => String(item || '')).filter(Boolean)
      : []
    const imageLimit = Math.min(4, Math.max(1, Number(args.image_limit) || 2))
    const candidates = wantedIds.length
      ? store.messagesOf(decision.channelId).filter(message => wantedIds.includes(String(message.message_id || message.id || '')))
      : result.messages
    const images = collectToolImages(candidates, { includeImages, wantedIds, imageLimit })
    const payload = {
      ok: true,
      channel: decision.channelId,
      total: result.total,
      returned: items.length,
      next_cursor: truncated ? result.offset + items.length : result.next_cursor,
      truncated,
      messages: items,
    }
    if (images.length) {
      payload.images = images
      payload.image_note = '图片已追加在本次工具结果之后；一般情况下不需要查看图片，只有确实必要时才使用 include_images。'
    } else if (includeImages || wantedIds.length) {
      payload.image_note = '没有找到可用的图片（可能图片已过期、只存在 URL 或 message_id 不正确）。'
    }
    if (truncated) payload.hint = '结果超过单次读取 token 上限，已返回部分消息；请缩小时间 / 关键词范围或使用 cursor 继续。'
    if (semanticHint) {
      payload.semantic_applied = false
      payload.hint = [payload.hint, semanticHint].filter(Boolean).join(' ')
    }
    return payload
  }

  /**
   * 语义检索主路径（MemMachine 复刻的核心）：
   *   1. 在角色记忆库的概括向量里做混合召回，模型可指定 top_summaries；
   *   2. 同一渠道的概括默认带回原文；
   *   3. 其它渠道的原文属于隐私内容，先走 chat-permissions 授权，拒绝时只返回概括；
   *   4. 可用 query 做关键词二次过滤，time_start / time_end 做时间过滤。
   */
  const readSemanticMessages = async (args, context, decision) => {
    const semantic = String(args.semantic || '').trim()
    const memory = memoryStore()
    const fallbackQuery = String(args.query || semantic || '').trim()
    if (!semantic) return runKeywordRead(args, context, decision)
    if (!memory?.search) {
      return runKeywordRead(args, context, decision, { queryOverride: fallbackQuery, semanticHint: '记忆库服务未启用，本次已按关键词回退查询原记录。' })
    }
    const channelRecord = store.channelRecord(decision.channelId) || store.channelForConversation(context.conversationId)
    const roleId = String(channelRecord?.roleId || context.roleId || '')
    const topSummaries = Math.max(1, Math.min(10, Number(args.semantic_limit ?? args.top_summaries ?? 1) || 1))
    const memoryScope = channelRecord?.group === 'privacy' ? 'privacy' : 'normal'
    const result = await memory.search({
      roleId,
      memoryScope,
      channelId: channelRecord?.channelId || decision.channelId || '',
      semantic,
      keywords: args.query || '',
      timeStart: args.time_start || '',
      timeEnd: args.time_end || '',
      topSummaries,
    })
    if (!result?.ok) {
      return runKeywordRead(args, context, decision, {
        queryOverride: fallbackQuery,
        semanticHint: `语义检索不可用（${result?.error || '未知原因'}），本次已按关键词回退查询原记录。`,
      })
    }
    const summaries = Array.isArray(result.summaries) ? result.summaries : []
    if (!summaries.length) {
      return runKeywordRead(args, context, decision, {
        queryOverride: fallbackQuery,
        semanticHint: '记忆库暂未找到匹配的概括（可能尚未累计到 N 轮或向量模型未返回结果），已按关键词回退查询原记录。',
      })
    }

    const rawMessages = []
    const seenMessages = new Set()
    const summaryOut = []
    const channelAccess = new Map()
    const canReadChannel = async sourceChannelId => {
      if (!sourceChannelId) return { ok: false, reason: '来源渠道未知' }
      if (sourceChannelId === decision.channelId) return { ok: true }
      if (channelAccess.has(sourceChannelId)) return channelAccess.get(sourceChannelId)
      const authDecision = await permissions.authorize({
        conversationId: context.conversationId,
        action: 'read',
        channel: sourceChannelId,
      })
      const access = authDecision.ok === true ? { ok: true } : { ok: false, reason: authDecision.error || '需要授权' }
      channelAccess.set(sourceChannelId, access)
      return access
    }
    for (const hit of summaries) {
      const sourceChannelId = String(hit.source?.channel_id || '')
      const sameChannel = !!sourceChannelId && sourceChannelId === decision.channelId
      let allowed = sameChannel
      let deniedReason = ''
      if (!allowed) {
        // 跨渠道原文：复用现有权限 / 敏感确认链路；用户拒绝或未授权时只返回概括。
        // 同一次工具调用里按来源渠道缓存结果，避免同一渠道的多个概括反复弹确认。
        const access = await canReadChannel(sourceChannelId)
        allowed = access.ok === true
        if (!allowed) deniedReason = access.reason || '需要授权'
      }
      const info = {
        id: hit.id,
        summary: hit.summary,
        score: hit.score,
        source_channel_id: sameChannel || allowed ? sourceChannelId || undefined : undefined,
        source_group: sameChannel || allowed ? hit.source?.group || undefined : undefined,
        started_at: hit.source?.started_at || undefined,
        ended_at: hit.source?.ended_at || undefined,
        round_count: Number(hit.round_count) || 0,
        included_messages: false,
        privacy: !sameChannel,
        authorization_required: !sameChannel && !allowed,
        authorization_error: deniedReason || undefined,
      }
      if (allowed) {
        const liveMessages = sourceChannelId ? store.messagesOf(sourceChannelId) : []
        const byId = new Map(liveMessages.map(message => [String(message.message_id || message.id || ''), message]))
        const candidates = (hit.messages || []).map(message => byId.get(String(message.message_id || '')) || message)
        for (const message of filterMessagesByTime(candidates, args.time_start, args.time_end)) {
          const id = String(message.message_id || message.id || '')
          if (id && seenMessages.has(id)) continue
          if (id) seenMessages.add(id)
          rawMessages.push(message)
        }
        info.included_messages = true
      }
      summaryOut.push(info)
    }

    // 明确传了关键词时，对原文再做一次关键词过滤（概括命中可能存在语义相近但关键词不出现的轮次）。
    const keyword = String(args.query || '').trim()
    const filteredRaw = keyword
      ? rawMessages.filter(message => {
          const hay = `${messageTextForSearch(message)} ${message.sender_name || ''}`.toLowerCase()
          return hay.includes(keyword.toLowerCase())
        })
      : rawMessages
    const maxTokens = Math.max(200, Number(config.get('chat.readTokens', 1500)) || 1500)
    const { items, truncated } = formatToolMessages(filteredRaw, maxTokens)
    const includeImages = args.include_images === true || String(args.include_images) === 'true'
    const wantedIds = Array.isArray(args.image_message_ids)
      ? args.image_message_ids.map(item => String(item || '')).filter(Boolean)
      : []
    const imageLimit = Math.min(4, Math.max(1, Number(args.image_limit) || 2))
    const imageCandidates = wantedIds.length
      ? store.messagesOf(decision.channelId).filter(message => wantedIds.includes(String(message.message_id || message.id || '')))
      : filteredRaw
    const images = collectToolImages(imageCandidates, { includeImages, wantedIds, imageLimit })

    const payload = {
      ok: true,
      channel: decision.channelId,
      total: filteredRaw.length,
      returned: items.length,
      next_cursor: null,
      truncated,
      messages: items,
      semantic_applied: true,
      memory_scope: memoryScope,
      summaries: summaryOut,
    }
    if (images.length) {
      payload.images = images
      payload.image_note = '图片已追加在本次工具结果之后；一般情况下不需要查看图片，只有确实必要时才使用 include_images。'
    } else if (includeImages || wantedIds.length) {
      payload.image_note = '没有找到可用的图片（可能图片已过期、只存在 URL 或 message_id 不正确）。'
    }
    if (truncated) payload.hint = '结果超过单次读取 token 上限，已返回部分消息；请缩小时间 / 关键词范围或减少概括条数。'
    if (summaryOut.some(item => !item.included_messages)) {
      payload.authorization_required = true
      payload.hint = [
        payload.hint,
        '部分相关概括来自其它渠道，原文属于隐私内容；未获授权时只返回概括。可先向用户说明需要授权，再由用户输入“确认”。',
      ]
        .filter(Boolean)
        .join(' ')
    } else if (!filteredRaw.length && keyword) {
      payload.hint = '相关概括已命中，但按关键词过滤原文后为空；可去掉 query 重试，或查看 summaries 后再决定。'
    }
    return payload
  }

  const readMessages = async (args, context) => {
    const decision = await authorize(args, context, 'read')
    if (!decision.ok) return denied(decision)
    if (args.semantic) return readSemanticMessages(args, context, decision)
    return runKeywordRead(args, context, decision)
  }

  /**
   * 独立的长期记忆搜索工具（MemMachine 式 episode_summary 检索）。
   * 语义query -> 概括向量混合召回；默认返回最相关的 1 条概括；
   * 同渠道直接带出该概括底下的 10 轮原文；跨渠道/群聊默认只返回概括，
   * 只有模型显式传 include_messages=true 时才走授权并展开原文。
   */
  const searchMemory = async (args, context) => {
    const semantic = String(args.semantic ?? args.query ?? '').trim()
    if (!semantic) return { ok: false, error: '请提供 semantic（语义描述）或 query（关键词）。' }
    const memory = memoryStore()
    if (!memory?.search) {
      return { ok: false, code: 'NO_MEMORY_STORE', error: '长期记忆库未启用（需要后端支持）。' }
    }
    const currentChannel = store.channelForConversation(context.conversationId)
    if (!currentChannel) return unavailable()
    const roleId = String(currentChannel.roleId || context.roleId || '')
    const memoryScope = currentChannel.group === 'privacy' ? 'privacy' : 'normal'
    const topSummaries = Math.max(1, Math.min(10, Number(args.top_summaries ?? args.topSummaries ?? args.limit ?? 1) || 1))
    const explicitInclude = args.include_messages === true || String(args.include_messages) === 'true'
    const result = await memory.search({
      roleId,
      memoryScope,
      channelId: currentChannel.channelId || '',
      semantic,
      keywords: args.keywords ?? args.query ?? '',
      timeStart: args.time_start || '',
      timeEnd: args.time_end || '',
      topSummaries,
    })
    if (!result?.ok) {
      return { ok: false, code: result?.code || 'MEMORY_SEARCH_FAILED', error: result?.error || '记忆检索失败' }
    }
    const rawMessages = []
    const seen = new Set()
    const summaries = []
    const channelAccess = new Map()
    const canReadChannel = async sourceChannelId => {
      if (!sourceChannelId) return { ok: false, reason: '来源渠道未知' }
      if (sourceChannelId === currentChannel.channelId) return { ok: true }
      if (channelAccess.has(sourceChannelId)) return channelAccess.get(sourceChannelId)
      const authDecision = await permissions.authorize({
        conversationId: context.conversationId,
        action: 'read',
        channel: sourceChannelId,
      })
      const access = authDecision.ok === true ? { ok: true } : { ok: false, reason: authDecision.error || '需要授权' }
      channelAccess.set(sourceChannelId, access)
      return access
    }
    for (const hit of result.summaries || []) {
      const sourceChannelId = String(hit.source?.channel_id || '')
      const sameChannel = !!sourceChannelId && sourceChannelId === currentChannel.channelId
      const omitted = args.include_messages === false || String(args.include_messages) === 'false'
      let allowed = sameChannel && !omitted
      let deniedReason = ''
      if (!sameChannel && explicitInclude) {
        const access = await canReadChannel(sourceChannelId)
        allowed = access.ok === true
        if (!allowed) deniedReason = access.reason || '需要授权'
      }
      if (allowed) {
        const liveMessages = sourceChannelId ? store.messagesOf(sourceChannelId) : []
        const byId = new Map(liveMessages.map(message => [String(message.message_id || message.id || ''), message]))
        const candidates = (hit.messages || []).map(message => byId.get(String(message.message_id || '')) || message)
        for (const message of filterMessagesByTime(candidates, args.time_start, args.time_end)) {
          const id = String(message.message_id || message.id || '')
          if (id && seen.has(id)) continue
          if (id) seen.add(id)
          rawMessages.push(message)
        }
      }
      summaries.push({
        id: hit.id,
        summary: hit.summary,
        score: hit.score,
        source_channel_id: sameChannel || (allowed && explicitInclude) ? sourceChannelId || undefined : undefined,
        source_group: sameChannel || allowed ? hit.source?.group || undefined : undefined,
        started_at: hit.source?.started_at || undefined,
        ended_at: hit.source?.ended_at || undefined,
        round_count: Number(hit.round_count) || 0,
        included_messages: allowed,
        privacy: !sameChannel,
        authorization_required: !sameChannel && !allowed,
        authorization_error: deniedReason || undefined,
        message_note: omitted
          ? '调用方指定 include_messages=false，本次只返回概括。'
          : !sameChannel && !allowed
            ? '该概括来自其它渠道，原文属于隐私内容；需要授权后才能展开，已仅返回概括。'
            : undefined,
      })
    }

    const maxTokens = Math.max(200, Number(config.get('chat.readTokens', 1500)) || 1500)
    const { items, truncated } = formatToolMessages(rawMessages, maxTokens)
    const payload = {
      ok: true,
      role_id: roleId,
      memory_scope: memoryScope,
      returned_summaries: summaries.length,
      top_summaries: topSummaries,
      messages_returned: items.length,
      truncated,
      summaries,
      query: semantic,
      embedding: result.embedding || undefined,
    }
    if (items.length) {
      payload.messages = items
      payload.note = `默认返回每条概括底下的最近 ${summaries[0]?.round_count || config.get('memory.summaryRounds', 10)} 轮原文；跨渠道原文需授权。`
    } else if (summaries.length) {
      payload.messages = []
      payload.note = summaries.some(item => item.authorization_required)
        ? '已只返回相关概括；其它渠道原文属于隐私内容，需要授权。模型可先向用户说明，再传 include_messages=true 请求授权展开。'
        : '相关概括已命中，但调用方未要求展开原文（include_messages=false）。'
    } else {
      payload.messages = []
      payload.note = '记忆库中暂时没有匹配的概括；可能这段对话还没累计到 N 轮。'
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
    // 运行期兜底：chat_send 禁止在单条消息里用换行拆句，模型偶尔不遵守时
    // 直接按换行拆成多条独立消息，避免 QQ / 微信用一个气泡显示奇怪折行。
    const expandedList = []
    for (const raw of rawList) {
      if (typeof raw !== 'string') {
        expandedList.push(raw)
        continue
      }
      for (const part of raw.split(/\r?\n+/)) {
        const text = part.trim()
        if (text) expandedList.push(text)
      }
    }
    const sent = []
    const duplicates = []
    let reasoningAttached = false
    const delivery = context.delivery || { count: 0 }
    // 跨渠道发送也要像网页端一样：首条立即发送，后续消息按字数模拟真人打字延迟。
    const simulate = config.get('chat.simulateTyping', true)
    const emitTyping = typing => {
      if (simulate) events.emit('chat:typing', { conversationId, channelId, typing })
    }
    for (const raw of expandedList) {
        if (context.entry?.cancelled === true) return { ok: false, code: 'CHAT_ABORTED', error: '请求已取消' }
        const item = typeof raw === 'string' ? { content: raw } : raw || {}
        const content = String(item.content ?? item.text ?? '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim()
        const normalizedImages = await normalizeOutboundImages(item.images)
        if (!content && !normalizedImages.length) continue
        const existing = content ? context.sentContents?.get(content) : null
        if (existing && !normalizedImages.length) {
          duplicates.push({ content, message_id: existing })
          continue
        }
        // 首条消息不延迟；从第二条开始，按字数计算 0.5s ~ 5s 的动态延迟
        if (simulate && delivery.count > 0) {
          emitTyping(true)
          await sleep(typingDelayMs(content || '[图片]'), context.entry)
          emitTyping(false)
          if (context.entry?.cancelled === true) return { ok: false, code: 'CHAT_ABORTED', error: '请求已取消' }
        }
        const message = store.append(conversationId, {
          role: 'assistant',
          content,
          content_type: item.content_type || (normalizedImages.length && !content ? 'image' : 'text'),
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
            ...(normalizedImages.length ? { images: normalizedImages } : {}),
          },
        })
        if (!message) continue
        if (content) context.sentContents?.set(content, message.message_id)
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
      ...queuedDelivery(channelId),
    }
  }

  /**
   * 归一化资料参数：既支持单篇（title / summary / content），
   * 也支持一次多篇（documents: [{ title?, summary?, content, content_type? }]）。
   * documents 里没写标题的条目沿用最外层 title，实现“一个标题多篇资料”。
   */
  const collectDocuments = args => {
    const list = []
    const push = (raw, fallback = {}) => {
      const item = typeof raw === 'string' ? { content: raw } : raw && typeof raw === 'object' ? raw : {}
      const content = String(item.content ?? item.text ?? '').replace(/[\u200B-\u200D\uFEFF]/g, '')
      if (!content.trim()) return
      list.push({
        title: String(item.title || item.name || fallback.title || '').trim() || '未命名资料',
        summary: String(item.summary || item.digest || fallback.summary || '').trim(),
        content_type: String(item.content_type || item.contentType || fallback.content_type || 'text/plain').trim() || 'text/plain',
        content,
      })
    }
    const batch = args.documents ?? args.docs ?? args.items
    if (Array.isArray(batch)) for (const item of batch) push(item, args)
    push({ title: args.title, summary: args.summary, content_type: args.content_type, content: args.content })
    return list.slice(0, 10)
  }

  const sendDocument = async (args, context) => {
    const decision = await authorize(args, context, 'send')
    if (!decision.ok) return denied(decision)

    const channelId = decision.channelId
    const isCurrent = channelId === context.channelId
    const conversationId = isCurrent ? context.conversationId : store.conversationIdFor(channelId)
    const targetConv = conversationId ? sessions.get(conversationId) : null
    if (!targetConv) return unavailable()

    const list = collectDocuments(args)
    if (!list.length) return { ok: false, error: '资料内容不能为空' }

    const delivery = context.delivery || { count: 0 }
    // 跨渠道资料消息同样保留逐条延迟，避免多条资料 / 消息一次性轰炸目标渠道。
    const simulate = config.get('chat.simulateTyping', true)
    const references = []
    const messageIds = []
    for (const item of list) {
      const reference = documents.put({
        title: item.title.slice(0, 200),
        summary: item.summary.slice(0, 500),
        content: item.content,
        content_type: item.content_type,
        channelId,
        source: 'nova',
      })
      references.push(reference)

      if (simulate && delivery.count > 0) {
        events.emit('chat:typing', { conversationId, channelId, typing: true })
        await sleep(typingDelayMs(reference.summary || reference.title), context.entry)
        events.emit('chat:typing', { conversationId, channelId, typing: false })
        if (context.entry?.cancelled === true) return { ok: false, code: 'CHAT_ABORTED', error: '请求已取消' }
      }

      // 聊天记录只存引用和缩略，不存资料全文；一份资料 = 一条消息 = 一个转发气泡。
      const message = store.append(conversationId, {
        role: 'assistant',
        content: reference.summary || reference.title,
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
          batch: list.length > 1 ? list.length : undefined,
        },
      })
      delivery.count += 1
      if (message) messageIds.push(message.message_id)
    }

    const first = references[0]
    return {
      ok: true,
      channel: channelId,
      count: references.length,
      // 兼容单篇调用：顶层仍然直接给出 doc_id / title。
      doc_id: first.doc_id,
      title: first.title,
      summary: first.summary,
      content_type: first.content_type,
      tokens: first.tokens,
      documents: references.map(reference => ({
        doc_id: reference.doc_id,
        title: reference.title,
        summary: reference.summary,
        tokens: reference.tokens,
        length: reference.length,
      })),
      message_ids: messageIds,
      sent_at: store.toLocalIso(),
      end: args.end === true || args.end === 'true',
      note: documentDeliveryNote(channelId, references.length),
      ...queuedDelivery(channelId),
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

  /** 读取当前渠道 / 指定消息的合并转发记录：后端按页返回，避免一次把转发全部塞进上下文。 */
  const readForward = async (args, context) => {
    const list = store.messagesOf(context.channelId) || []
    const byMessageId = id => list.find(item => String(item.message_id || item.id || '') === String(id || ''))
    const latestForward = () => [...list].reverse().find(item => item.meta?.forward?.id)
    let message = null
    let forwardId = String(args.forward_id || args.forwardId || '').trim()
    if (!forwardId && args.message_id) message = byMessageId(args.message_id)
    if (!forwardId) message = message || latestForward()
    if (!forwardId) forwardId = String(message?.meta?.forward?.id || '').trim()
    if (!forwardId) return { ok: false, error: '没有找到合并转发记录：请传 forward_id 或 message_id，或先在当前渠道转发一段聊天记录。' }
    if (!api?.post) return { ok: false, code: 'NO_BACKEND', error: '后端连接不可用，无法深读转发记录。' }

    const includeImages = args.include_images === true || String(args.include_images) === 'true'
    // 默认从第 0 条开始，而不是跳过预览：预览可能被截断，模型需要能重新读取完整正文。
    // 继续读后续消息时应显式传 offset=已返回条数。
    const offset = Math.max(0, Number(args.offset ?? 0) || 0)
    const limit = Math.max(1, Math.min(20, Number(args.limit) || 5))
    const textOffset = Math.max(0, Number(args.text_offset) || 0)
    const imageLimit = Math.max(0, Math.min(2, Number(args.image_limit) || 2))
    let result = null
    try {
      result = await api.post('/napcat/forward/read', {
        id: forwardId,
        instanceId: String(args.instance_id || message?.meta?.instanceId || ''),
        offset,
        limit,
        text_offset: textOffset,
          include_images: includeImages,
        image_limit: imageLimit,
      })
    } catch (err) {
      return { ok: false, error: `读取转发记录失败：${err?.message || err}` }
    }
    if (!result?.ok) return { ok: false, code: result?.code || 'READ_FAILED', error: result?.error || '转发记录读取失败' }

    const items = Array.isArray(result.items) ? result.items : []
    const imageParts = []
    if (includeImages && imageLimit > 0 && imageService) {
      const refs = []
      for (const item of items) {
        for (const image of Array.isArray(item.preview_images) ? item.preview_images : []) refs.push(image)
      }
      if (refs.length && imageService.hydrateImages) {
        try {
          await imageService.hydrateImages(refs)
        } catch (_) {
          /* 单张失败不影响文字结果 */
        }
      }
      for (const item of items) {
        for (const image of Array.isArray(item.preview_images) ? item.preview_images : []) {
          if (imageParts.length >= imageLimit) break
          const url = image?.dataUrl || imageService.dataUrlOf?.(image) || image?.url || ''
          if (url) imageParts.push({ type: 'image_url', image_url: { url: String(url) }, item_index: item.index })
        }
        if (imageParts.length >= imageLimit) break
      }
    }

    return {
      ok: true,
      forward_id: result.id || forwardId,
      instance_id: result.instance_id || undefined,
      title: result.title || '聊天记录',
      total: result.total,
      offset: result.offset ?? offset,
      returned: items.length,
      next_offset: result.next_offset ?? null,
        next_text_offset: result.next_text_offset ?? null,
      has_more: result.has_more === true,
        truncated: result.truncated || undefined,
      items: items.map(item => ({
        index: item.index,
        sender_name: item.sender_name,
        time: item.time,
        text: item.text,
          text_offset: item.text_offset || undefined,
          text_length: item.text_length || undefined,
          text_truncated: item.text_truncated || undefined,
        image_count: item.image_count || item.image_available || undefined,
        nested_forward: item.nested_forward || undefined,
      })),
      images: imageParts.length ? imageParts : undefined,
      image_note: imageParts.length ? '已附带本页前两张图片；非必要不要继续读取图片。' : undefined,
      hint:
        result.hint ||
        '继续读取请带同一个 forward_id 和 next_offset；嵌套转发可用 items[].nested_forward.id 作为新的 forward_id。',
    }
  }

  const extractCardFlag = card => {
    const direct = card?.flag || card?.request_id || card?.requestId || card?.reqId || ''
    if (direct) return String(direct)
    const raw = String(card?.raw || '')
    try {
      const parsed = JSON.parse(raw)
      const found = parsed?.flag || parsed?.request_id || parsed?.requestId || parsed?.reqId || ''
      if (found) return String(found)
    } catch (_) {
      /* raw 不是 JSON 时继续用正则 */
    }
    const match = raw.match(/(?:flag|request_id|requestId)["']?\s*[:=]\s*["']?([^"',\s}]+)/i)
    return match ? String(match[1]) : ''
  }

  const classifyCard = card => {
    const app = String(card?.app || '')
    const hay = `${app} ${card?.title || ''} ${card?.summary || ''}`.toLowerCase()
    if (card?.kind === 'group_invite' || /群邀请|加入群聊|group.?join|join.?group/.test(hay)) return 'group_invite'
    if (card?.kind === 'contact_card') return 'contact_card'
    if (card?.kind === 'binding_card') return 'binding_card'
    if (/推荐|联系人|名片|friend|contact|recommend/.test(hay)) return 'contact_card'
    if (/绑定|关系|bind|relation/.test(hay)) return 'binding_card'
    return 'qq_card'
  }

  const findCardMessage = (messageId, context) => {
    const list = store.messagesOf(context.channelId) || []
    if (messageId) return list.find(item => String(item.message_id || item.id || '') === String(messageId)) || null
    return [...list].reverse().find(item => item.meta?.card || item.meta?.cards?.length) || null
  }

  /** QQ 卡片处理：查看 / 提取链接 / 对有 request flag 的邀请执行同意或拒绝。 */
  const napcatCard = async (args, context) => {
    const action = String(args.action || 'info').toLowerCase()
    const message = findCardMessage(args.message_id, context)
    if (!message) return { ok: false, error: '当前渠道没有找到可处理的 QQ 卡片消息。' }
    const card =
      message.meta?.card && typeof message.meta.card === 'object'
        ? message.meta.card
        : Array.isArray(message.meta?.cards)
          ? message.meta.cards.find(item => item && typeof item === 'object') || null
          : null
    if (!card) return { ok: false, error: '这条消息没有可解析的卡片数据。' }
    const kind = classifyCard(card)
    const messageId = String(message.message_id || message.id || '')
    const summary = {
      kind,
      app: card.app || undefined,
      title: card.title || undefined,
      summary: card.summary || undefined,
      url: card.url || undefined,
      prompt: card.prompt || undefined,
    }
    const flag = extractCardFlag(card)
    const instanceId = String(message.meta?.instanceId || args.instance_id || '')
    const canHandle = !!(flag && napcatChannel?.action && instanceId && kind !== 'binding_card')
    const availableActions = ['info', 'open', 'ignore']
    if (canHandle) availableActions.push('handle')

    if (action === 'info') {
      return {
        ok: true,
        message_id: messageId,
        card: summary,
        has_request_flag: !!flag,
        can_auto_handle: canHandle,
        available_actions: availableActions,
        hint: canHandle
          ? '可用 handle + approve=true/false 处理这条邀请；敏感操作前应先询问用户。'
          : '这条卡片没有 OneBot request flag，无法自动同意/拒绝；可把内容或链接转述给用户，请用户在 QQ 客户端里确认。',
      }
    }

    if (action === 'open') {
      const url = String(card.url || '').trim()
      return url
        ? { ok: true, message_id: messageId, url, hint: '可以把链接转述给用户，由用户决定是否打开。' }
        : { ok: false, code: 'NO_URL', error: '这条卡片没有可打开的链接。' }
    }

    if (action === 'ignore') {
      try {
        sessions.updateMessage(context.conversationId, messageId, {
          meta: { ...(message.meta || {}), cardHandled: 'ignored', cardHandledAt: Date.now() },
        })
      } catch (_) {
        /* 标记失败不影响返回 */
      }
      return { ok: true, message_id: messageId, handled: 'ignored', hint: '已忽略这条卡片，不再处理。' }
    }

    if (action !== 'handle') {
      return { ok: false, error: 'action 只支持 info / open / ignore / handle。' }
    }
    if (kind === 'binding_card') {
      return {
        ok: false,
        code: 'UNSUPPORTED_CARD',
        message_id: messageId,
        card: summary,
        error: '绑定关系卡片没有通用 OneBot 处理接口；模型只能转述详情/链接，或让用户自行确认绑定，不能替用户操作。',
      }
    }

    if (!flag) {
      return {
        ok: false,
        code: 'MANUAL_REQUIRED',
        message_id: messageId,
        card: summary,
        error: '这条卡片没有 OneBot request flag，无法自动处理；请把卡片内容/链接转述给用户，由用户在 QQ 客户端确认。',
      }
    }
    if (!napcatChannel?.action || !instanceId) {
      return { ok: false, code: 'NO_NAPCAT', message_id: messageId, error: '当前消息没有可用的 NapCat 连接，无法自动处理。' }
    }
    const approve = args.approve !== false && String(args.approve) !== 'false'
    const reason = String(args.reason || '').slice(0, 200)
    const napcatAction = kind === 'group_invite' || /group/.test(String(card.app || '')) ? 'set_group_add_request' : 'set_friend_add_request'
    const params =
      napcatAction === 'set_group_add_request'
        ? { flag, approve, reason: reason || ' ' }
        : { flag, approve, remark: reason || ' ' }
    let result = null
    try {
      result = await napcatChannel.action(instanceId, napcatAction, params)
    } catch (err) {
      return { ok: false, error: `NapCat 处理失败：${err?.message || err}` }
    }
    if (!result || result.ok !== true) return { ok: false, code: result?.code || 'ACTION_FAILED', error: result?.error || 'NapCat 返回处理失败', card: summary }
    try {
      sessions.updateMessage(context.conversationId, messageId, {
        meta: { ...(message.meta || {}), cardHandled: approve ? 'approved' : 'rejected', cardHandledAt: Date.now() },
      })
    } catch (_) {
      /* 标记失败不影响结果 */
    }
    return {
      ok: true,
      message_id: messageId,
      handled: approve ? 'approved' : 'rejected',
      kind,
      action: napcatAction,
      hint: approve ? '已同意；可以简短告知用户处理结果。' : '已拒绝；可以简短告知用户处理结果。',
    }
  }

  const disposers = [
    registry.register(
      'read_messages',
      {
        description:
          '读取聊天记录。只有确实缺少必要上下文时才调用，同一轮最多一次，不要为了“确认一下”反复读取。默认当前渠道；query 是关键词过滤，semantic 会用长期记忆库的概括做向量语义检索并回捞对应原文（比关键词更能找到同义改述），可再叠加 time_start / time_end 和 query 关键词做精确过滤；seq / relative / cursor 保留原有精确读取能力。跨渠道原文需要授权，未授权时只会返回相关概括。图片默认以“[图片]”占位；确需原图时用 include_images 或 image_message_ids。',
        parameters: {
          type: 'object',
          properties: {
            channel: { type: 'string', description: '目标渠道 ID，默认当前渠道；跨渠道需要权限。' },
            query: { type: 'string', description: '关键词过滤；在 semantic 检索时作为二次精筛。' },
            seq: { type: 'number', description: '精确消息序号。' },
            relative: {
              type: 'object',
              description: '相对序号范围，例如 { base: 5, from: 1, to: 5 } 表示第 6~10 条。',
              properties: { base: { type: 'number' }, from: { type: 'number' }, to: { type: 'number' } },
            },
            limit: { type: 'number', description: '返回条数，默认 10，最大 50。' },
            time_start: { type: 'string', description: 'ISO 8601 起始时间。' },
            time_end: { type: 'string', description: 'ISO 8601 结束时间。' },
            semantic: { type: 'string', description: '语义检索描述，例如“用户之前提到的咖啡习惯 / 上海出差安排”。' },
            semantic_limit: { type: 'number', description: '语义检索先取多少条概括来比对，默认 1，最大 10；调大可对比更多候选概括。' },
            cursor: { type: 'number', description: '上一页返回的 next_cursor。' },
            include_images: {
              type: 'boolean',
              description: '是否把本次结果里的图片作为原图返回。默认 false；一般没有必要开启，开启会占用大量上下文。',
            },
            image_message_ids: {
              type: 'array',
              items: { type: 'string' },
              description: '只查看这些 message_id 的图片；比 include_images 更精确。',
            },
            image_limit: { type: 'number', description: '本次最多返回的图片数量，默认 2，最大 4。' },
          },
        },
      },
      readMessages,
    ),
    registry.register(
      'search_memory',
      {
        description:
          '长期记忆语义检索：先用一段语义描述在角色的记忆库里查找相关的概括（每条约 10 轮对话压缩而成），再按需展开概括底下的原文。默认只返回最相关的 1 条概括；top_summaries 可指定返回几条供模型比对；同一渠道的概括会附带原文，跨渠道 / 群聊场景默认只返回概括，并把原文标记为隐私内容，只有显式传 include_messages=true 才会请求授权并展开。可用 keywords 叠加关键词精筛、time_start / time_end 限定时间。用户问“我们之前聊过什么 / 你还记得吗 / 找以前某段对话”时优先用本工具；日常聊天里只要你怀疑自己应该记得用户说过的习惯 / 日常 / 人物 / 事件，也可以主动调用一次，不要反复调用 read_messages。搜不到结果就按当前上下文正常回复，不要为了“确认一下”连续重复调用。',
        parameters: {
          type: 'object',
          properties: {
            semantic: { type: 'string', description: '需要的语义描述；也可以用 query 代替。' },
            query: { type: 'string', description: 'semantic 的别名；若同时传 keywords，query 会作为关键词精筛。' },
            keywords: { type: 'string', description: '可选关键词，与向量语义做混合检索 / 二次过滤。' },
            top_summaries: { type: 'number', description: '返回的概括条数，默认 1，最大 10；返回多条时便于模型比对哪条底下的记录更符合需求。' },
            include_messages: { type: 'boolean', description: '是否展开概括底下的聊天原文。同渠道默认可展开；跨渠道默认只给概括，显式传 true 才会走授权展开。' },
            time_start: { type: 'string', description: 'ISO 8601 起始时间。' },
            time_end: { type: 'string', description: 'ISO 8601 结束时间。' },
          },
        },
      },
      searchMemory,
    ),
    registry.register(
      'chat_send',
      {
        description:
          '发送一条或多条短聊天消息；普通聊天回复必须通过本工具，不要直接输出 assistant 正文。messages 数组每一项是一条独立消息，按 QQ / 微信真人聊天习惯分条发送，单条消息正文不要包含换行符（\\n），想发两句就传两个数组项，否则同一气泡里会出现奇怪的折行；发完设置 end=true 结束本轮，end=false 表示继续下一轮工具调用。需要发大段长文 / 资料 / 文献时改用 send_document。',
        parameters: {
          type: 'object',
          properties: {
            channel: { type: 'string', description: '目标渠道 ID，默认当前渠道；跨渠道需要权限。' },
            messages: {
              type: 'array',
              items: { type: 'string' },
              description: '短聊天消息列表，每个数组项会作为独立消息发出。多条消息请拆开，例如 ["你好","有什么事？"]；单条消息正文禁止使用换行符（\\n），不要用换行把多句话塞进一条。日常聊天一般不需要句尾句号，更像 QQ / 微信真人输入；不要加编号、前缀或解释。',
            },
            images: {
              type: 'array',
              items: { type: 'string' },
              description: '可选图片列表：可以是 https 图片 URL 或 data:image/...;base64,... 数据。一般只在确实需要发图时使用，单次最多 4 张。',
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
          '发送长文本 / 资料 / 文献（例如大段说明、代码、文章，或内容里本来就有大段换行的情况）。原文存入资料库，聊天记录只保存标题、缩略和 doc_id；之后可用 read_document 读取原文。在支持合并转发的渠道（NapCat / QQ）会按「聊天记录转发」发送：第一条是标题，往下是一整段正文（多份资料各自一条转发）；网页端仍是资料卡片。日常短聊天不要用这个工具，改用 chat_send；资料发出去以后也不要用 chat_send 重复正文。',
        parameters: {
          type: 'object',
          properties: {
            channel: { type: 'string', description: '目标渠道 ID，默认当前渠道。' },
            title: { type: 'string', description: '资料标题（同时作为 documents 里没写标题的条目的默认标题；一个标题可以带多篇资料）。' },
            summary: { type: 'string', description: '一句话缩略，展示在聊天记录里。' },
            content_type: { type: 'string', description: '如 text/markdown、text/plain。' },
            content: { type: 'string', description: '资料原文（只发一篇时可以不用 documents，直接传 content）。' },
            documents: {
              type: 'array',
              description:
                '一次发送多篇资料时使用：每一项是一篇资料，可以是 {"title":"可选标题","content":"正文","summary":"可选缩略"} 对象，也可以直接传正文字符串（沿用最外层 title）。每一项都会单独发一条聊天记录转发，不要为了发多篇而调用多次工具。',
              items: {
                type: 'object',
                properties: {
                  title: { type: 'string', description: '这一篇的标题；省略时用最外层 title。' },
                  summary: { type: 'string', description: '这一篇的缩略。' },
                  content_type: { type: 'string', description: '这一篇的内容类型。' },
                  content: { type: 'string', description: '这一篇的正文。' },
                },
                required: ['content'],
              },
            },
            end: { type: 'boolean', description: 'true=发送后结束本轮。' },
          },
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
    registry.register(
      'read_forward',
      {
        description:
          '分页读取合并转发聊天记录。转发消息默认只自动展示前几条和前两张图片；只有确实需要更多内容时才调用本工具，默认从预览结束的位置继续，每次 limit 建议 5~10，不要一次性读取全部。若某条 items[].text_truncated=true，说明该条正文很长，需要带同一个 offset、limit=1 和 text_offset（从 0 开始，之后用返回的 next_text_offset 续读）直到拿到完整正文。嵌套转发可用 items[].nested_forward.id 作为新的 forward_id。图片不是必要信息时保持 include_images=false。',
        parameters: {
          type: 'object',
          properties: {
            forward_id: { type: 'string', description: '转发的根 id；通常从当前消息 meta.forward.id 或上一次 read_forward 返回里获取。' },
            message_id: { type: 'string', description: '指定某条包含转发记录的消息；省略时使用当前渠道最近一条转发。' },
            offset: { type: 'number', description: '从第几条开始读，默认 0（预览可能被截断，需要完整正文时要用这个重新读）；继续读后续消息时传 next_offset。' },
            limit: { type: 'number', description: '本次读取条数，默认 5，最大 20。续读单条长文本时建议 limit=1。' },
              text_offset: { type: 'number', description: '单条长文本的字符偏移；text_truncated=true 时配合同一个 offset、limit=1 使用，并按 next_text_offset 续读。' },
            include_images: { type: 'boolean', description: '是否附带本页图片；默认 false，非必要不要开启。' },
            image_limit: { type: 'number', description: '附带图片数量上限，默认 2，最大 2。' },
            instance_id: { type: 'string', description: '可选 NapCat 连接 id；一般由工具从消息 meta 自动获取。' },
          },
        },
      },
      readForward,
    ),
    registry.register(
      'napcat_card',
      {
        description:
          '处理 QQ 卡片消息（群邀请、推荐联系人、绑定关系等）。先用 action=info 查看卡片详情与可用动作；action=open 返回卡片链接；action=ignore 忽略；只有卡片带 OneBot request flag 时才能用 action=handle + approve=true/false 自动同意或拒绝。同意好友/入群、拒绝等敏感操作前必须先让用户确认。',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['info', 'open', 'ignore', 'handle'], description: '默认 info。' },
            message_id: { type: 'string', description: '卡片消息的 message_id；省略时使用当前渠道最近一条卡片。' },
            approve: { type: 'boolean', description: 'handle 时 true=同意，false=拒绝。' },
            reason: { type: 'string', description: 'handle 时的备注 / 拒绝理由，可选。' },
            instance_id: { type: 'string', description: '可选 NapCat 连接 id；一般自动获取。' },
          },
        },
      },
      napcatCard,
    ),

  ]

  const service = {
    name: 'chat-tools',
    definitions: context => registry.definitions(context),
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
