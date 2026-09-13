/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * B1 · chat-flow
 * 聊天主流程（文档 §6.4 / §6.5）：
 *
 *   message:send
 *     → 角色级 FIFO 队列
 *     → 用户消息写入 chat-store（完整渠道元数据）
 *     → context-builder 组装工作记忆 + 渠道记忆 + system 工具规则
 *     → 工具循环：models.stream(tools) → tool_calls → chat-tools.execute(...) → 下一轮
 *     → 直到某个 chat_send / send_document 返回 end=true，或达到最大轮次
 *
 * 兼容策略（模型能力差异兜底）：
 *   1. 模型不返回 tool_calls，但正文是 <tool_call> JSON / DSML·DSLM 标记 -> 解析成工具调用继续执行；
 *   2. 识别出工具标记但无法解析 -> 立即撤掉流式内容并拦截，绝不把标记展示给用户；
 *   3. 只有普通正文才回退为“普通流式回复”。
 * chat-flow 自己不认识 OpenAI / Ollama / 任何具体工具实现，只编排服务。
 */
export const name = 'chat-flow'
export const version = '2.0.0'
export const displayName = '聊天流程'
export const description = '业务功能 · 串联"发送 → 存 → 工具循环 → 回显"主链路。'
export const author = '念风内核'
export const icon = '🔀'
export const core = true
export const depends = {
  'config': '>=1.1.0',
  'event-bus': '*',
  'message-service': '^1.0.0',
  'model-service': '^1.0.0',
  'session-service': '^2.0.0',
  'toast-host': '>=1.0.0',
}
export const optionalDepends = {
  'backend-client': '>=1.0.0',
  'chat-permissions': '^1.0.0',
  'chat-queue': '^1.0.0',
  'chat-store': '^1.0.0',
  'chat-tools': '^1.0.0',
  'context-builder': '^1.0.0',
  'user-identity': '>=1.0.0',
}
export const inject = [
  'event-bus',
  'session-service',
  'message-service',
  'model-service',
  'config',
  'toast',
  'api?',
  'user-identity?',
  'chat-store?',
  'chat-tools?',
  'context-builder?',
  'chat-queue?',
  'chat-permissions?',
]
export const provides = [{ name: 'chat-flow', type: 'singleton' }]

import { resolveUserNickname } from '../../../src/util/identity.mjs'

export function apply(ctx) {
  const sessions = ctx.inject('session-service')
  const messages = ctx.inject('message-service')
  const models = ctx.inject('model-service')
  const config = ctx.inject('config')
  const events = ctx.inject('event-bus')
  const store = ctx.inject('chat-store')
  const tools = ctx.inject('chat-tools')
  const builder = ctx.inject('context-builder')
  const queue = ctx.inject('chat-queue')
  const permissions = ctx.inject('chat-permissions')
  const api = ctx.inject('api')

  /** 工具名 -> 给用户看的状态文案 */
  const TOOL_LABELS = {
    read_messages: '读取消息',
    chat_send: '发送消息',
    send_document: '发送资料',
    read_document: '读取资料',
  }
  const TYPING_TOOLS = new Set(['chat_send', 'send_document'])

  const emitStatus = (conversationId, status, extra = {}) => {
    events.emit('chat:status', { conversationId, status, at: Date.now(), ...extra })
  }

  /** 把工具调用阶段转成“正在调用 xx 工具 / 正在输入”状态 */
  const emitToolStatus = (conversationId, name) => {
    const label = TOOL_LABELS[name] || name || '工具'
    if (TYPING_TOOLS.has(name)) emitStatus(conversationId, 'typing', { tool: name, label: '正在输入' })
    else emitStatus(conversationId, 'tool', { tool: name, label: `正在调用「${label}」` })
  }

  const toNumber = value => {
    const num = Number(value)
    return Number.isFinite(num) ? num : null
  }

  const normalizeUsage = usage => {
    if (!usage || typeof usage !== 'object') return null
    const inputTokens = toNumber(usage.inputTokens) ?? 0
    const outputTokens = toNumber(usage.outputTokens) ?? 0
    const cachedTokens = toNumber(usage.cachedTokens) ?? 0
    const reasoningTokens = toNumber(usage.reasoningTokens)
    const totalTokens = toNumber(usage.totalTokens) ?? inputTokens + outputTokens
    const cost = toNumber(usage.cost)
    const normalized = { inputTokens, outputTokens, cachedTokens, totalTokens }
    if (reasoningTokens !== null) normalized.reasoningTokens = reasoningTokens
    if (cost !== null) normalized.cost = cost
    return normalized
  }

  const mergeUsage = (base, extra) => {
    const add = normalizeUsage(extra)
    if (!add) return base || null
    if (!base) return add
    const merged = {
      inputTokens: base.inputTokens + add.inputTokens,
      outputTokens: base.outputTokens + add.outputTokens,
      cachedTokens: base.cachedTokens + add.cachedTokens,
      totalTokens: base.totalTokens + add.totalTokens,
    }
    if (base.reasoningTokens !== undefined || add.reasoningTokens !== undefined) {
      merged.reasoningTokens = (base.reasoningTokens || 0) + (add.reasoningTokens || 0)
    }
    if (base.cost !== undefined || add.cost !== undefined) {
      merged.cost = (base.cost || 0) + (add.cost || 0)
    }
    return merged
  }

  const callMeta = snapshot => {
    if (!snapshot) return null
    const usage = normalizeUsage(snapshot.usage)
    const thinkingMs = Number(snapshot.thinkingMs) || 0
    if (!usage && !thinkingMs) return null
    const inputTokens = usage?.inputTokens || 0
    const cachedTokens = usage?.cachedTokens || 0
    const info = {
      ...(usage || {}),
      thinkingMs,
      elapsedMs: Number(snapshot.elapsedMs) || 0,
      cacheHitRate: inputTokens > 0 ? cachedTokens / inputTokens : 0,
    }
    return { usage: usage || null, call: info, thinkingMs }
  }

  /** 把本轮真实调用信息补写到模型已经通过 chat_send / send_document 发出的消息上 */
  const attachCallInfo = (conversationId, messageIds, snapshot) => {
    const ids = Array.isArray(messageIds) ? messageIds : []
    const metaPatch = callMeta(snapshot)
    if (!ids.length || !metaPatch) return
    for (const id of ids) {
      const message = messages.get(conversationId, id)
      if (!message) continue
      messages.update(conversationId, id, { meta: { ...(message.meta || {}), ...metaPatch } })
    }
  }

  /** conversationId -> entry */
  const running = new Map()
  let warnedLegacyBackend = false

  const roleOf = conv => conv.meta?.roleId || conv.id
  const toolsEnabled = () => !!store && !!tools && !!builder && config.get('chat.toolsEnabled', true) !== false

  const abortError = () => {
    const err = new Error('请求已取消')
    err.code = 'CHAT_ABORTED'
    return err
  }

  const createEntry = (conversationId, roleId) => {
    let rejectCancel = () => {}
    const cancelPromise = new Promise((_, reject) => {
      rejectCancel = reject
    })
    cancelPromise.catch(() => {})
    const entry = {
      conversationId,
      roleId,
      cancelled: false,
      draftId: null,
      abort: () => {},
      startedAt: Date.now(),
      cancelPromise,
      cancel(reason) {
        if (entry.cancelled) return
        entry.cancelled = true
        try {
          entry.abort()
        } catch (_) {
          /* ignore */
        }
        rejectCancel(reason || abortError())
      },
    }
    return entry
  }

  const ensureDraft = (entry, conversationId) => {
    if (entry.draftId) {
      const existing = messages.get(conversationId, entry.draftId)
      if (existing) return existing
      entry.draftId = null
    }
    const draft = messages.placeholder(conversationId)
    entry.draftId = draft?.id || null
    return draft
  }

  const removeDraft = (entry, conversationId) => {
    if (!entry.draftId) return
    try {
      messages.remove(conversationId, entry.draftId)
    } catch (_) {
      /* ignore */
    }
    entry.draftId = null
  }

  const scheduleStatus = (conversationId, messageId) => {
    if (!messageId) return
    ctx.setTimeout(() => {
      const current = messages.get(conversationId, messageId)
      if (current?.status === 'sent') messages.update(conversationId, messageId, { status: 'delivered' })
    }, 700)
    ctx.setTimeout(() => {
      const current = messages.get(conversationId, messageId)
      if (current?.status === 'delivered') messages.update(conversationId, messageId, { status: 'read' })
    }, 1800)
  }

  const generationOptions = conv => {
    const options = { stream: config.get('chat.stream', true) }
    const temperature = Number(config.get('chat.temperature', 1))
    if (Number.isFinite(temperature)) options.temperature = temperature
    const reasoningEffort = config.get('chat.reasoningEffort', 'off')
    if (['off', 'low', 'high', 'max'].includes(reasoningEffort)) options.reasoningEffort = reasoningEffort
    // 输出上限：全局默认值；模型设置里单独填了 max_tokens 时以模型级为准。
    const maxOutputTokens = Math.max(0, Number(config.get('chat.maxOutputTokens', 8192)) || 0)
    if (maxOutputTokens > 0) options.maxTokens = maxOutputTokens
    const conversationModel = conv.meta?.model
    if (conversationModel) options.model = conversationModel
    // 全局 temperature 是默认值：用户在模型列表里单独设置过 temperature 时，
    // 模型级参数优先，避免“模型参数页设置了却永远不生效”。
    options.preferModelParams = true
    return options
  }

  const toolOptions = conv => {
    const options = generationOptions(conv)
    if (toolsEnabled()) {
      options.tools = tools.definitions()
      const choice = config.get('chat.toolChoice', 'required')
      if (choice === 'auto' || choice === 'required' || choice === 'none') options.toolChoice = choice
    }
    return options
  }

  /** 单次模型调用：流式内容写入占位消息；tool_calls 等到 onDone 统一返回 */
  function attemptStream(entry, conversationId, messagesToSend, options) {
    return new Promise((resolve, reject) => {
      let settled = false
      let buffered = ''
      let reasoningBuffered = ''
      const finish = (fn, value) => {
        if (settled) return
        settled = true
        fn(value)
      }
      if (entry.cancelled) return finish(reject, abortError())

      entry.suppressContent = false
      const suppressStream = entry.suppressStream === true
      let handle = null
      try {
        handle = models.stream(messagesToSend, options, {
          onStart() {},
          onChunk(delta) {
            if (entry.cancelled || !delta) return
            buffered += delta
            // 一旦识别出工具标记，立刻把已经流出的内容从界面上撤掉，
            // 后续内容只留在 buffered 里交给解析器，绝不原样展示。
            if (!entry.suppressContent && !suppressStream && tools?.looksLikeToolMarkup?.(buffered)) {
              entry.suppressContent = true
              if (entry.draftId) removeDraft(entry, conversationId)
            }
            if (!entry.suppressContent && !suppressStream && options.stream !== false) {
              const draft = ensureDraft(entry, conversationId)
              if (draft) messages.appendChunk(conversationId, draft.id, delta)
            }
          },
          onToolCall() {
            // 原生 function calling：模型可能先吐少量正文再给出 tool_call。
            // 这里立刻停止展示并撤掉占位，避免“文本闪一下又消失”。
            if (entry.suppressContent) return
            entry.suppressContent = true
            if (entry.draftId) removeDraft(entry, conversationId)
          },
          onReasoning(delta) {
            if (entry.cancelled || !delta) return
            reasoningBuffered += delta
          },
          onDone(summary) {
            finish(resolve, {
              text: buffered || summary?.text || '',
              toolCalls: summary?.toolCalls || [],
              reasoning: reasoningBuffered || summary?.reasoning || '',
              reason: summary?.reason || null,
              usage: summary?.usage || null,
            })
          },
          onError(error) {
            finish(reject, error)
          },
        })
      } catch (err) {
        finish(reject, err)
      }
      entry.abort = () => {
        try {
          handle?.abort?.()
        } catch (_) {
          /* ignore */
        }
      }
      entry.cancelPromise.catch(err => finish(reject, err))
    })
  }

  const isToolUnsupported = err =>
    /tool_choice|tool_calls|function.?call|tools? (?:are )?(?:not|unsupported)|(?:not support|unsupported|invalid).{0,20}(?:tool|function)|不支持.{0,6}工具/i.test(
      String(err?.message || err),
    )

  async function streamRound(entry, conversationId, messagesToSend, options) {
    try {
      return await attemptStream(entry, conversationId, messagesToSend, options)
    } catch (err) {
      if (options.tools?.length && isToolUnsupported(err) && !entry.cancelled) {
        // 部分模型 / 提供商不支持 function calling：移除工具重试，走普通流式回复
        entry.toolUnsupported = true
        entry.suppressStream = false
        ctx.logger.warn(`模型不支持工具调用，回退为普通回复：${err?.message || err}`)
        removeDraft(entry, conversationId)
        return attemptStream(entry, conversationId, messagesToSend, { ...options, tools: undefined, toolChoice: undefined })
      }
      throw err
    }
  }

  const normalizeToolCalls = raw =>
    (Array.isArray(raw) ? raw : [])
      .map((call, index) => {
        const fn = call?.function || {}
        const name = fn.name || call?.name
        if (!name) return null
        let args = fn.arguments ?? call?.arguments ?? '{}'
        if (typeof args !== 'string') args = JSON.stringify(args || {})
        return {
          id: call.id || `call_${Date.now().toString(36)}_${index}`,
          type: 'function',
          function: { name, arguments: args },
          ...(call.thoughtSignature ? { thoughtSignature: call.thoughtSignature } : {}),
        }
      })
      .filter(Boolean)

  const parseArgs = raw => {
    if (raw && typeof raw === 'object') return raw
    try {
      return raw ? JSON.parse(raw) : {}
    } catch (_) {
      return {}
    }
  }

  async function finalizeFallback(entry, conversationId, text, reasoning = '') {
    const draft = ensureDraft(entry, conversationId)
    if (!draft) return
    if (config.get('chat.stream', true) === false && text) {
      messages.appendChunk(conversationId, draft.id, text)
    }
    // 必须在 finish/touch 触发 chat-store 自动补时间戳之前写入结构化元数据，
    // 否则会被按 createdAt 推导出的假时间戳占位，导致多轮历史排序错乱。
    store?.stampMessage?.(conversationId, draft.id)
    const call = callMeta(entry.lastRound)
    messages.finish(conversationId, draft.id, {
      content: text || draft.content || '',
      meta: {
        ...(draft.meta || {}),
        elapsed: Date.now() - entry.startedAt,
        ...(reasoning ? { reasoningContent: reasoning } : {}),
        ...(call || {}),
      },
    })
  }

  /**
   * 严格模式的正文兜底：模型坚持不调工具时，不让裸 assistant 正文直接走渠道，
   * 而是复用 chat_send 的标准发送链（零宽字符清理、去重、模拟输入、落库、渠道外发）。
   */
  async function fallbackViaChatSend(entry, conversationId, content, reasoning, contextBase = {}) {
    const text = String(content ?? '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim()
    if (!text) return { ok: false, error: '正文为空，无法兜底。' }
    if (entry.draftId) removeDraft(entry, conversationId)
    try {
      const output = await tools.execute('chat_send', { messages: [text], end: true }, {
        conversationId,
        ...contextBase,
        reasoningContent: reasoning || '',
      })
      if (output?.ok && Array.isArray(output.message_ids) && output.message_ids.length) {
        attachCallInfo(conversationId, output.message_ids, entry.lastRound)
      }
      return output || { ok: false, error: 'chat_send 未返回结果。' }
    } catch (err) {
      return { ok: false, error: String(err?.message || err) }
    }
  }

  function handleTurnError(entry, conversationId, error) {
    const cancelled = entry.cancelled || error?.code === 'CHAT_ABORTED' || error?.name === 'AbortError'
    const draft = ensureDraft(entry, conversationId)
    if (draft) store?.stampMessage?.(conversationId, draft.id)
    if (draft) messages.fail(conversationId, draft.id, cancelled ? abortError() : error)
    if (draft && !entry.finalWire) {
      entry.finalWire = {
        role: 'assistant',
        content: String(draft.content || '').trim() || (cancelled ? '（生成已取消）' : `（生成失败：${error?.message || error}）`),
      }
    }
    if (!cancelled) {
      const message = error?.message || String(error)
      const timedOut = /timeout|超时|aborted.*timeout|ETIMEDOUT/i.test(message)
      ctx.inject('toast')?.error?.(`模型调用失败${timedOut ? '（请求超时）' : ''}：${message}`)
      ctx.logger.error(`[chat-flow] 模型调用失败${timedOut ? '（请求超时，可在设置 → 网络调整超时时间）' : ''}`, error)
      // 外部渠道看不到网页 toast：把原始错误内容作为一条助手消息写回来源渠道。
      try {
        const channel = store?.channelForConversation?.(conversationId)
        const external = channel && channel.source !== 'nova' && !String(channel.channelId || '').startsWith('nova:web:')
        if (external && typeof store?.append === 'function') {
          const conv = sessions.get(conversationId)
          const raw = String(message || '').trim() || '未知错误'
          store.append(conversationId, {
            role: 'assistant',
            content: `【模型调用失败】${raw}`,
            sender_name: conv?.name || '角色',
            is_bot: true,
            source: 'nova',
            visibility: 'shareable',
            meta: { fallback: 'model-error', error: raw, timedOut },
          })
        }
      } catch (writeErr) {
        ctx.logger?.warn?.(`[chat-flow] 写入渠道错误提示失败：${writeErr?.message || writeErr}`)
      }
    }
  }

  /** 把本轮真实协议轨迹写入 chat-store，供下一轮 context-builder 还原 tool_calls 历史 */
  function finalizeTranscript(entry, conversationId) {
    if (entry.transcriptDone) return
    entry.transcriptDone = true
    if (!entry.channelId || typeof store?.appendTranscript !== 'function') return
    const protocol = [...(entry.protocol || [])]
    if (Array.isArray(entry.roundProtocol) && entry.roundProtocol.length) protocol.push(...entry.roundProtocol)
    if (entry.finalWire) protocol.push(entry.finalWire)
    if (protocol.length >= 2) store.appendTranscript(entry.channelId, protocol)
  }

  // 通知统一由 chat-notify 插件基于 message:added / message:done 逐条发送，这里不再重复处理。

  /** 工具循环主路径 */
  async function runAgentTurn(conversationId, text, roleId, { skipUserAppend = false, images = [] } = {}) {
    const conv = sessions.get(conversationId)
    if (!conv) {
      // 渠道侧的“本轮结束”回调依赖 chat:request-done；会话不存在时也必须发一次，
      // 否则入站队列会一直等到超时，表现为“消息写进去了但机器人长时间不理人”。
      events.emit('chat:request-done', { conversationId, elapsed: 0, thinkingMs: 0, usage: null })
      return
    }
    const entry = createEntry(conversationId, roleId)
    running.set(conversationId, entry)
    const startedAt = Date.now()
    let channel = null
    try {
      channel = store.channelForConversation(conversationId)
    } catch (err) {
      ctx.logger?.warn?.(`[chat-flow] 准备渠道记录失败，将继续本轮：${err?.message || err}`)
    }
    const channelId = channel?.channelId || store?.novaChannelId?.(conversationId) || `nova:web:${conversationId}`
    entry.channelId = channelId
    entry.protocol = []
    entry.roundProtocol = []
    entry.finalWire = null
    entry.usage = null
    entry.thinkingMs = 0
    entry.lastRound = null
    let who = null
    try {
      const identity = ctx.registry.get('user-identity')?.get?.() || {}
      who = permissions?.contextFor(conversationId) || {
        userId: identity.userId || config.get('chat.userId', 'web-user'),
        userName: identity.userName || resolveUserNickname(config),
        identitySource: identity.source || 'local',
      }
    } catch (err) {
      ctx.logger?.warn?.(`[chat-flow] 读取用户身份失败，将使用默认身份：${err?.message || err}`)
      who = {
        userId: config.get('chat.userId', 'web-user'),
        userName: resolveUserNickname(config),
        identitySource: 'local',
      }
    }

    try {
      let userMessage = null
      if (!skipUserAppend) {
        const normalizedImages = (Array.isArray(images) ? images : [])
          .slice(0, 4)
          .map(image => (typeof image === 'string' ? { url: image } : image || {}))
          .filter(image => image.id || image.url || image.dataUrl)
          .map(image => ({
            id: String(image.id || ''),
            url: image.url || '',
            dataUrl: image.dataUrl || '',
            mime: image.mime || '',
            name: String(image.name || '').slice(0, 80),
          }))
        userMessage = store.append(conversationId, {
          role: 'user',
          content: text,
          sender_id: who.identityUserId || who.userId,
          sender_name: who.userName,
          status: 'sent',
          source: 'nova',
          meta: { via: 'composer', ...(normalizedImages.length ? { images: normalizedImages } : {}) },
        })
        scheduleStatus(conversationId, userMessage?.id)
        const userWire = builder.toModelMessage(userMessage, {
          roleId,
          channelId: userMessage?.channel_id || channelId,
          timezone: builder.timezone?.(),
        })
        if (userWire) entry.protocol.push(userWire)
      } else {
        // 渠道插件已先写入入站消息（skipUserAppend=true），这里必须补一份 user wire，
        // 否则工具协议轨迹只有 assistant/tool，下一轮构建上下文时会丢掉用户刚说的话。
        const sessionMessages = sessions.messages?.(conversationId) || []
        userMessage =
          (text
            ? [...sessionMessages].reverse().find(item => item?.role === 'user' && String(item.content || '') === String(text))
            : null) ||
          [...sessionMessages].reverse().find(item => item?.role === 'user') ||
          null
        const userWire = builder.toModelMessage(userMessage, {
          roleId,
          channelId: userMessage?.channel_id || channelId,
          timezone: builder.timezone?.(),
        })
        if (userWire) entry.protocol.push(userWire)
      }
      emitStatus(conversationId, 'thinking', { round: 0, label: '正在思考' })
      // 日志页据此展示“谁 / 哪个渠道 / 说了什么”，而不是只有一串 conversationId。
      const requestStartMessage =
        userMessage || [...(sessions.messages?.(conversationId) || [])].reverse().find(item => item?.role === 'user')
      const requestStartChannelType = String(conv.meta?.channelType || 'nova')
      events.emit('chat:request-start', {
        conversationId,
        messageId: requestStartMessage?.id || userMessage?.id || '',
        text: String(requestStartMessage?.content || text || '').slice(0, 160),
        senderName: String(requestStartMessage?.sender_name || who.userName || '').slice(0, 40),
        channelName: requestStartChannelType === 'nova' ? '' : String(conv.name || '').slice(0, 40),
        channelType: requestStartChannelType,
      })

      // 模型开始思考时先展示占位气泡（三点动画）；工具真正发出消息前会移除它，
      // 普通文本降级时则复用它继续流式输出。
      const thinking = messages.placeholder(conversationId)
      entry.draftId = thinking?.id || null

      const persona = String(conv.meta?.persona || '').trim()
      const imageService = ctx.registry.get('image-service')
      // 只有会话里真的存在“未预加载的 imageId”时才异步取图，避免给普通聊天增加额外 await
      // （否则停止生成等交互可能抢在 stream 创建之前，影响原有即时取消语义）。
      if (imageService?.needsHydration?.(conversationId) && imageService?.hydrateConversation) {
        await Promise.race([
          imageService.hydrateConversation(conversationId),
          new Promise(resolve => setTimeout(resolve, 8000)),
        ]).catch(() => {})
        if (entry.cancelled) throw abortError()
      }
      const base = builder.build({ conversationId, roleId, persona, channelId, currentMessageId: userMessage?.message_id || userMessage?.id || null })
      const options = toolOptions(conv)
      if (api?.configured?.() && typeof api.supports === 'function' && !api.supports('tools') && !warnedLegacyBackend) {
        warnedLegacyBackend = true
        ctx.logger.warn('[chat-flow] 后端未上报 tools 能力（可能是未重启的旧进程），将按文本工具协议兼容运行')
        ctx.inject('toast')?.warn?.('后端版本较旧，未包含工具调用支持：请用 stop / start 重启念风。当前会尝试文本协议兼容。')
      }
      const roundMessages = []
      const sentContents = new Map()
      const delivery = { count: 0 }
      const maxRounds = Math.max(1, Number(config.get('chat.maxToolRounds', 10)) || 10)

      let round = 0
      let ended = false
      let textualMode = false
      let toolRetries = 0
      // DeepSeek 官方适配器按 harness 约定不发 tool_choice，模型有时会直接输出正文。
      // 纠正次数由 chat.toolRetryLimit 控制（不再硬编码封顶为 1）；达到上限后走
      // “经过发送链处理”的正文兜底，而不是把裸 assistant 正文直接丢给渠道。
      const retryLimitRaw = Number(config.get('chat.toolRetryLimit', 1))
      const toolRetryLimit = Number.isFinite(retryLimitRaw) ? Math.max(0, Math.floor(retryLimitRaw)) : 1
      let emptyRetries = 0
      const emptyRetryLimit = Math.max(0, Number(config.get('chat.emptyRetryLimit', 2)) || 0)
      while (round < maxRounds && !entry.cancelled) {
        round += 1
        // 每一轮模型调用前恢复“思考中”占位；真正发消息或降级时会复用/移除它
        ensureDraft(entry, conversationId)
        emitStatus(conversationId, 'thinking', { round, label: '正在思考' })
        const roundStartedAt = Date.now()
        const roundOptions = textualMode ? { ...options, tools: undefined, toolChoice: undefined } : options
        // 原生工具调用模式下，模型有时会先流出一小段正文再给出 tool_call；
        // 这段正文只暂存、不上屏，最终由 chat_send 工具消息呈现，避免闪现后消失。
        entry.suppressStream =
          !textualMode &&
          Array.isArray(roundOptions.tools) &&
          roundOptions.tools.length > 0 &&
          roundOptions.toolChoice !== 'none' &&
          config.get('chat.requireToolCall', true) !== false &&
          !entry.toolUnsupported
        const result = await streamRound(entry, conversationId, [...base.messages, ...roundMessages], roundOptions)
        if (entry.cancelled) throw abortError()
        const roundThinkingMs = Date.now() - roundStartedAt
        entry.thinkingMs += roundThinkingMs
        entry.usage = mergeUsage(entry.usage, result.usage)
        entry.lastRound = {
          usage: result.usage || null,
          thinkingMs: roundThinkingMs,
          elapsedMs: Date.now() - startedAt,
          round,
        }
        ctx.logger.info(
          `[chat-flow] 第 ${round} 轮模型返回：${roundThinkingMs}ms · ` +
            `工具 ${(result.toolCalls || []).length} 个 · 正文 ${String(result.text || '').length} 字 · 推理 ${String(result.reasoning || '').length} 字` +
            `${result.reason ? ` · finish=${result.reason}` : ''}`,
        )
        let toolCalls = normalizeToolCalls(result.toolCalls)
        let roundTextual = false
        const reasoning = result.reasoning || ''

        if (!toolCalls.length && result.text) {
          const parsed = tools.parseTextCalls?.(result.text)
          if (parsed?.length) {
            roundTextual = true
            textualMode = true
            toolCalls = normalizeToolCalls(parsed)
            ctx.logger.warn(`[chat-flow] 模型返回文本形式的工具调用，已兼容解析：${toolCalls.map(call => call.function.name).join(', ')}`)
            if (entry.draftId) removeDraft(entry, conversationId)
          } else if (tools.looksLikeToolMarkup?.(result.text)) {
            // 绝不把模型自创的工具标记展示给用户
            if (entry.draftId) removeDraft(entry, conversationId)
            ctx.logger.warn('[chat-flow] 模型返回无法解析的工具标记，已拦截，不展示给用户')
            ctx.inject('toast')?.warn?.('模型返回了无法解析的工具调用格式，已拦截。请确认模型支持 function calling，并重启后端后再试。')
            const notice = '（模型返回了无法解析的工具调用格式，已停止本轮。）'
            entry.finalWire = { role: 'assistant', content: notice }
            store.append(conversationId, {
              role: 'assistant',
              content: notice,
              sender_id: `role_${conv.id}`,
              sender_name: conv.name,
              is_bot: true,
              source: 'nova',
              meta: { fallback: 'unparsed-tool-markup', ...(callMeta(entry.lastRound) || {}) },
            })
            ended = true
            break
          }
        }

        if (!toolCalls.length) {
          const hasText = String(result.text || '').trim().length > 0
          if (!hasText) {
            if (entry.draftId) removeDraft(entry, conversationId)
            if (emptyRetries < emptyRetryLimit) {
              emptyRetries += 1
              roundMessages.push({
                role: 'user',
                content:
                  `[系统纠正 ${emptyRetries}/${emptyRetryLimit}] 你刚才的回复为空：既没有正文也没有工具调用。\n` +
                  '当前是严格工具聊天模式，用户不会看到你的普通 assistant 正文，只有工具调用会被执行。\n' +
                  '必须调用回复工具：日常回复用 chat_send（messages 数组，结束本轮 end=true）；长文本 / 资料 / 大段代码用 send_document。\n' +
                  '不要只输出思考 / 解释 / 计划，也不要直接输出 assistant 正文。\n' +
                  '如果接口不支持原生 function calling，chat_send 请只输出这一种格式：<tool_call>{"name":"chat_send","arguments":{"messages":["要发送的内容"],"end":true}}</tool_call>',
              })
              ctx.logger.warn(`[chat-flow] 第 ${round} 轮为空回复，已发起第 ${emptyRetries}/${emptyRetryLimit} 次纠正`)
              continue
            }
            ctx.logger.warn('[chat-flow] 模型连续返回空回复，本轮终止')
            ctx.inject('toast')?.warn?.('模型连续返回空回复，本轮已停止。可重试、更换模型或查看运行日志。')
            const notice = '（模型连续返回空回复，本轮已停止。可重试、更换模型或查看运行日志。）'
            entry.finalWire = { role: 'assistant', content: notice }
            store.append(conversationId, {
              role: 'assistant',
              content: notice,
              sender_id: `role_${conv.id}`,
              sender_name: conv.name,
              is_bot: true,
              source: 'nova',
              meta: { fallback: 'empty-response', ...(callMeta(entry.lastRound) || {}) },
            })
            ended = true
            break
          }
          const strict = toolsEnabled() && config.get('chat.requireToolCall', true) !== false && !entry.toolUnsupported && options.toolChoice !== 'none'
          if (strict && toolRetries < toolRetryLimit) {
            // 严格模式：模型直接输出正文时不展示，但也不要用“普通状态”再问一遍。
            // 必须把“上一轮正文已被驳回、原因是没调工具”这条信息回传给模型，
            // 让它在明确的驳回上下文里重试；否则模型容易把纠正当成新用户话题，
            // 连续两次都继续直出正文。
            toolRetries += 1
            if (entry.draftId) removeDraft(entry, conversationId)
            const rejectedText = String(result.text || '').trim().slice(0, 1200)
            const rejectedAt = new Date().toLocaleTimeString()
            roundMessages.push({
              role: 'user',
              content:
                `[系统纠正 ${toolRetries}/${toolRetryLimit}] 系统消息：你上一轮的回复已被驳回，尚未发送给用户。\n` +
                `驳回时间：${rejectedAt}\n` +
                '驳回原因：当前是严格工具模式，只有工具调用（tool_calls）才会被投递给用户；你上一轮没有调用任何工具，只输出了普通 assistant 正文，因此无效。\n' +
                '请注意：无论是一句话还是长文本，你都必须调用回复工具进行回复；直接输出 assistant 正文永远会被驳回。\n' +
                '被驳回的正文（仅用于让你知道上一轮生成了什么；不要把它当成本轮最终回复，也不要原样直接返回）：\n' +
                `--- 被驳回正文开始 ---\n${rejectedText || '（空）'}\n--- 被驳回正文结束 ---\n` +
                '请重新处理本轮用户请求，按内容长度二选一：\n' +
                '1）日常短回复：必须调用回复工具 chat_send，参数为 {"messages":["要发送给用户的内容"],"end":true}；不支持原生工具时只输出 <tool_call>{"name":"chat_send","arguments":{"messages":["要发送给用户的内容"],"end":true}}</tool_call>\n' +
                '2）长文本 / 资料 / 大段代码 / 文章：必须调用资料工具 send_document（title + content，或 summary），由资料库保存原文，不要再硬塞进 chat_send 或直接输出正文。\n' +
                '无论哪种情况，都必须调用回复工具；不要输出解释、计划、心理活动或任何面向用户的 assistant 正文；工具调用的参数请一次给全。',
            })
            ctx.logger.warn(`[chat-flow] 严格工具模式：第 ${toolRetries} 次纠正模型直接输出正文（已回传驳回原因与原文）`)
            continue
          }
          if (strict && toolRetries >= toolRetryLimit) {
            // 纠错达到上限：正文兜底仍然保留，但不把裸 assistant 正文直接丢给渠道，
            // 而是复用 chat_send 的标准发送链处理（清理 / 去重 / 模拟输入 / 落库 / 外发）。
            const fallbackText = String(result.text || '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim()
            if (entry.draftId) removeDraft(entry, conversationId)
            const fallbackOutput = await fallbackViaChatSend(entry, conversationId, fallbackText, reasoning, {
              channelId,
              roleId,
              userId: who.userId,
              userName: who.userName,
              round,
              sentContents,
              delivery,
              entry,
            })
            if (fallbackOutput?.ok) {
              ctx.logger.warn(`[chat-flow] 严格工具模式：模型未调用工具，已通过 chat_send 发送链兜底（已纠正 ${toolRetries} 次）`)
              ctx.inject('toast')?.warn?.('模型未按工具协议返回，已按普通正文兜底发送。')
              entry.finalWire = {
                role: 'assistant',
                content: fallbackText,
                ...(reasoning ? { reasoning_content: reasoning } : {}),
              }
              ended = true
              break
            }
            // chat_send 服务 / 权限异常时，退回原来的 finalizeFallback；此时正文已做清理
            ctx.logger.warn(`[chat-flow] 严格工具模式：chat_send 兜底失败，退回普通正文（${fallbackOutput?.error || '未知错误'}）`)
            ctx.inject('toast')?.warn?.(`模型未按工具协议返回，兜底发送失败：${fallbackOutput?.error || '未知错误'}`)
            if (fallbackText) {
              entry.finalWire = {
                role: 'assistant',
                content: fallbackText,
                ...(reasoning ? { reasoning_content: reasoning } : {}),
              }
              await finalizeFallback(entry, conversationId, fallbackText, reasoning)
            }
            ended = true
            break
          }
          // 普通正文：兼容为普通流式回复（文档路径之外的降级）
          if (result.text) {
            entry.finalWire = {
              role: 'assistant',
              content: result.text,
              ...(reasoning ? { reasoning_content: reasoning } : {}),
            }
            await finalizeFallback(entry, conversationId, result.text, reasoning)
          }
          ended = true
          break
        }

        // 工具调用轮：assistant 正文按文档 §6.5 丢弃（文本协议模式下保留原文给模型）。
        // DeepSeek 思考模式要求带 tool_calls 的历史 assistant 必须回传
        // reasoning_content；即使本轮模型没有返回推理（例如关闭思考后的兼容
        // 网关），也显式写入空字符串，避免后续请求因字段缺失被 400。
        if (entry.draftId) removeDraft(entry, conversationId)
        const reasoningField = { reasoning_content: reasoning || '' }
        roundMessages.push(
          roundTextual
            ? { role: 'assistant', content: result.text || null, ...reasoningField }
            : { role: 'assistant', content: null, tool_calls: toolCalls, ...reasoningField },
        )

        let sendEnded = false
        for (const call of toolCalls) {
          if (entry.cancelled) throw abortError()
          const args = parseArgs(call.function.arguments)
          emitToolStatus(conversationId, call.function.name)
          const toolStartedAt = Date.now()
          ctx.logger.info(`[chat-flow] 调用工具 ${call.function.name}：${JSON.stringify(args).slice(0, 300)}`)
          const output = await Promise.race([
            tools.execute(call.function.name, args, {
              conversationId,
              channelId,
              roleId,
              userId: who.userId,
              userName: who.userName,
              round,
              sentContents,
              delivery,
              entry,
              reasoningContent: reasoning,
            }),
            entry.cancelPromise.then(() => {
              throw abortError()
            }),
          ])
          if (entry.cancelled) throw abortError()
          ctx.logger.info(
            `[chat-flow] 工具 ${call.function.name} 完成：${Date.now() - toolStartedAt}ms · ${output?.ok === false ? `失败 ${output.code || output.error || ''}` : '成功'}` +
              `${Array.isArray(output?.message_ids) && output.message_ids.length ? ` · 消息 ${output.message_ids.length} 条` : ''}`,
          )
          attachCallInfo(conversationId, output?.message_ids, entry.lastRound)
          // 工具结果本身只发文本：把 output.images 从 JSON 里剥离，避免 base64
          // 混进 role=tool 的 content；图片随后作为一条 user 多模态消息单独注入。
          const { images: toolImages, ...toolPayload } = output || {}
          const toolOutput = JSON.stringify({ ...toolPayload, ok: output?.ok ?? true })
          roundMessages.push(
            roundTextual
              ? { role: 'user', content: `[工具结果] ${call.function.name} => ${toolOutput}` }
              : { role: 'tool', tool_call_id: call.id, name: call.function.name, content: toolOutput },
          )
          // read_messages 的 include_images / image_message_ids 会把图片放在 output.images。
          // 工具结果本身只能是文本，这里补一条 user 多模态消息把原图带进下一轮。
          if (Array.isArray(toolImages) && toolImages.length) {
            const parts = [{ type: 'text', text: `[${call.function.name} 按需返回的图片]` }]
            for (const image of toolImages.slice(0, 4)) {
              const url = image?.image_url?.url || image?.url || ''
              if (url) parts.push({ type: 'image_url', image_url: { url: String(url) } })
            }
            if (parts.length > 1) roundMessages.push({ role: 'user', content: parts })
          }
          if ((call.function.name === 'chat_send' || call.function.name === 'send_document') && output?.ok && output.end === true) {
            sendEnded = true
            break
          }
        }
        if (sendEnded) {
          ended = true
          break
        }
      }

      // 记录本轮真实工具协议（过滤掉严格模式的内部纠错消息）
      entry.roundProtocol = roundMessages
        .filter(message => !(message.role === 'user' && String(message.content || '').startsWith('[系统纠正')))
        .map(message => ({ ...message, tool_calls: message.tool_calls ? message.tool_calls.map(call => ({ ...call })) : undefined }))

      if (!ended && !entry.cancelled) {
        ctx.inject('toast')?.warn?.(`工具调用达到 ${maxRounds} 轮上限，已停止本轮`)
        ctx.logger.warn(`[chat-flow] 工具调用达到上限（${maxRounds} 轮），强制结束`)
        entry.finalWire = { role: 'assistant', content: '（工具调用次数达到上限，本轮已停止。）' }
        store.append(conversationId, {
          role: 'assistant',
          content: '（工具调用次数达到上限，本轮已停止。）',
          sender_id: `role_${conv.id}`,
          sender_name: conv.name,
          is_bot: true,
          source: 'nova',
          meta: { fallback: 'max-tool-rounds', ...(callMeta(entry.lastRound) || {}) },
        })
      }
    } catch (error) {
      handleTurnError(entry, conversationId, error)
    } finally {
      finalizeTranscript(entry, conversationId)
      if (running.get(conversationId) === entry) running.delete(conversationId)
      emitStatus(conversationId, 'idle')
      const totalMs = Date.now() - startedAt
      ctx.logger.info(`[chat-flow] 本轮结束：总耗时 ${totalMs}ms · 模型思考 ${entry.thinkingMs || 0}ms`)
      events.emit('chat:request-done', {
        conversationId,
        elapsed: totalMs,
        thinkingMs: entry.thinkingMs || 0,
        usage: entry.usage || null,
      })
    }
  }

  /** 兼容路径：工具链路被禁用或服务缺失时，保持旧版“直接流式回复”行为 */
  async function runLegacy(conversationId, text, roleId, { skipUserAppend = false, images = [] } = {}) {
    const conv = sessions.get(conversationId)
    if (!conv) {
      events.emit('chat:request-done', { conversationId, elapsed: 0, thinkingMs: 0, usage: null })
      return
    }
    const entry = createEntry(conversationId, roleId)
    running.set(conversationId, entry)
    try {
      entry.channelId = store?.channelForConversation?.(conversationId)?.channelId || null
    } catch (err) {
      ctx.logger?.warn?.(`[chat-flow] 准备渠道记录失败，将继续本轮：${err?.message || err}`)
      entry.channelId = null
    }
    entry.protocol = []
    entry.roundProtocol = []
    entry.finalWire = null
    entry.usage = null
    entry.thinkingMs = 0
    entry.lastRound = null
    entry.suppressStream = false
    const startedAt = Date.now()
    try {
      const identity = ctx.registry.get('user-identity')?.get?.() || {}
      const who = permissions?.contextFor(conversationId) || {
        userId: identity.userId || config.get('chat.userId', 'web-user'),
        userName: identity.userName || resolveUserNickname(config),
        identitySource: identity.source || 'local',
      }
      let userMessage = null
      if (!skipUserAppend && store) {
        const legacyImages = (Array.isArray(images) ? images : []).slice(0, 4).filter(Boolean)
        userMessage = store.append(conversationId, {
          role: 'user',
          content: text,
          sender_id: who.identityUserId || who.userId,
          sender_name: who.userName,
          status: 'sent',
          source: 'nova',
          meta: { via: 'composer', ...(legacyImages.length ? { images: legacyImages } : {}) },
        })
        scheduleStatus(conversationId, userMessage?.id)
        const userWire = builder?.toModelMessage?.(userMessage) || { role: 'user', content: text }
        entry.protocol.push(userWire)
      } else if (!skipUserAppend) {
        userMessage = messages.send(conversationId, text, { meta: images.length ? { images } : undefined })
        entry.protocol.push({ role: 'user', content: text })
      } else {
        const sessionMessages = sessions.messages(conversationId)
        userMessage =
          (text
            ? [...sessionMessages].reverse().find(message => message.role === 'user' && String(message.content || '') === String(text))
            : null) ||
          [...sessionMessages].reverse().find(message => message.role === 'user') ||
          null
        // 渠道 / 重新生成等 skipUserAppend 路径：把已有用户消息补进协议轨迹，避免下一轮丢用户上下文。
        const userWire = builder?.toModelMessage?.(userMessage) || { role: 'user', content: text }
        if (userWire) entry.protocol.push(userWire)
      }
      emitStatus(conversationId, 'thinking', { round: 1, label: '正在思考' })
      const modelMessages = sessions.context(conversationId, 30)
      const persona = String(conv.meta?.persona || '').trim()
      if (persona) modelMessages.unshift({ role: 'system', content: persona })
      const placeholder = messages.placeholder(conversationId)
      entry.draftId = placeholder?.id || null
      const requestStartChannelType = String(conv.meta?.channelType || 'nova')
      events.emit('chat:request-start', {
        conversationId,
        messageId: userMessage?.id || placeholder?.id || '',
        text: String(userMessage?.content || text || '').slice(0, 160),
        senderName: String(userMessage?.sender_name || who.userName || '').slice(0, 40),
        channelName: requestStartChannelType === 'nova' ? '' : String(conv.name || '').slice(0, 40),
        channelType: requestStartChannelType,
      })
      const roundStartedAt = Date.now()
      const result = await attemptStream(entry, conversationId, modelMessages, generationOptions(conv))
      const roundThinkingMs = Date.now() - roundStartedAt
      entry.thinkingMs += roundThinkingMs
      entry.usage = mergeUsage(entry.usage, result.usage)
      entry.lastRound = {
        usage: result.usage || null,
        thinkingMs: roundThinkingMs,
        elapsedMs: Date.now() - startedAt,
        round: 1,
      }
      if (!entry.cancelled) {
        if (config.get('chat.stream', true) === false) messages.appendChunk(conversationId, placeholder.id, result.text)
        store?.stampMessage?.(conversationId, placeholder.id)
        entry.finalWire = { role: 'assistant', content: result.text || placeholder.content }
        messages.finish(conversationId, placeholder.id, {
          content: result.text || placeholder.content,
          meta: { ...(placeholder.meta || {}), elapsed: Date.now() - startedAt, ...(callMeta(entry.lastRound) || {}) },
        })
      }
    } catch (error) {
      handleTurnError(entry, conversationId, error)
    } finally {
      finalizeTranscript(entry, conversationId)
      if (running.get(conversationId) === entry) running.delete(conversationId)
      emitStatus(conversationId, 'idle')
      const totalMs = Date.now() - startedAt
      ctx.logger.info(`[chat-flow] 旧版链路结束：总耗时 ${totalMs}ms`)
      events.emit('chat:request-done', {
        conversationId,
        elapsed: totalMs,
        thinkingMs: entry.thinkingMs || 0,
        usage: entry.usage || null,
      })
    }
  }

  const onSend = payload => {
    const { conversationId, text } = payload || {}
    const images = Array.isArray(payload?.images) ? payload.images : []
    if (!conversationId || (!text && !images.length)) return
    if (payload.confirmHandled) return // 敏感确认已消费这次输入，不进入正常聊天
    const conv = sessions.get(conversationId)
    if (!conv) {
      // 渠道侧依赖 chat:request-done 结束本轮等待；即使会话已不存在也要通知，
      // 避免入站队列一直挂起到超时。
      events.emit('chat:request-done', { conversationId, elapsed: 0, thinkingMs: 0, usage: null })
      return
    }

    const roleId = roleOf(conv)
    const agent = toolsEnabled()
    // 渠道插件可以先把入站消息写入自己的渠道记录，再以 skipUserAppend=true
    // 触发模型轮次，避免 message:send 重复插入同一条用户消息。
    const turnOptions = { skipUserAppend: payload.skipUserAppend === true, images }
    if (agent) store.channelForConversation(conversationId)
    const task = () => (agent ? runAgentTurn(conversationId, text, roleId, turnOptions) : runLegacy(conversationId, text, roleId, turnOptions))

    if (queue) {
      queue.enqueue(roleId, task).catch(error => {
        if (error?.code === 'CHAT_ABORTED') return
        ctx.logger.error('[chat-flow] 队列任务失败', error)
      })
    } else {
      task().catch(error => ctx.logger.error('[chat-flow] 任务失败', error))
    }
  }

  const offSend = events.on('message:send', onSend, { owner: 'chat-flow', interceptor: true })

  const service = {
    name: 'chat-flow',
    mode: () => (toolsEnabled() ? 'tools' : 'legacy'),
    isRunning: conversationId => running.has(conversationId),

    /**
     * 重新生成最后一条助手回复：删除该回复、复用上一条用户消息，
     * 但不重复插入用户消息。只允许操作最后一条，避免误删后续对话。
     */
    regenerate(conversationId, messageId) {
      const conv = sessions.get(conversationId)
      if (!conv) return { ok: false, error: '会话不存在' }
      if (running.has(conversationId)) return { ok: false, error: '当前正在生成，请先停止再重新生成' }
      const list = conv.messages || []
      const index = list.findIndex(message => message.id === messageId)
      const target = index >= 0 ? list[index] : null
      if (!target || target.role !== 'assistant' || target.kind === 'divider') {
        return { ok: false, error: '只能重新生成助手回复' }
      }
      const later = list.slice(index + 1).filter(message => message.kind !== 'divider' && message.role !== 'system')
      if (later.length) return { ok: false, error: '目前仅支持重新生成最后一条助手回复' }
      const previousUser = [...list.slice(0, index)]
        .reverse()
        .find(message => message.role === 'user' && message.kind !== 'divider' && String(message.content || '').trim())
      if (!previousUser) return { ok: false, error: '这条回复之前没有用户消息，无法重新生成' }

      // 清掉本渠道的工具协议轨迹；可见消息仍完整，上下文会自动回退到可见历史。
      const channel = store?.channelForConversation?.(conversationId)
      if (store?.clearTranscript && channel?.channelId) store.clearTranscript(channel.channelId)
      messages.remove(conversationId, target.id)

      const roleId = roleOf(conv)
      const agent = toolsEnabled()
      const task = () =>
        agent
          ? runAgentTurn(conversationId, previousUser.content, roleId, { skipUserAppend: true })
          : runLegacy(conversationId, previousUser.content, roleId, { skipUserAppend: true })
      const run = () => (queue ? queue.enqueue(roleId, task) : task())
      Promise.resolve(run()).catch(error => {
        if (error?.code === 'CHAT_ABORTED') return
        ctx.logger.error('[chat-flow] 重新生成失败', error)
      })
      return { ok: true }
    },

    abort(conversationId) {
      const entry = running.get(conversationId)
      if (!entry) return false
      entry.cancel(abortError())
      return true
    },
    abortAll() {
      for (const conversationId of [...running.keys()]) service.abort(conversationId)
    },
  }

  /** 进程异常退出后可能残留 streaming 占位消息；启动与同步时把它们收尾，避免永远转圈 */
  const cleanupStaleDrafts = () => {
    try {
      for (const conv of sessions.list()) {
        for (const message of [...(conv.messages || [])]) {
          if (!message.streaming) continue
          if (String(message.content || '').trim()) {
            messages.finish(conv.id, message.id, {
              streaming: false,
              meta: { ...(message.meta || {}), interrupted: true },
            })
          } else {
            messages.fail(conv.id, message.id, new Error('生成已中断'))
          }
        }
      }
    } catch (err) {
      ctx.logger.warn(`清理残留流式消息失败：${err.message}`)
    }
  }
  cleanupStaleDrafts()
  ctx.effect(events.on('conversation:sync', cleanupStaleDrafts))
  const offRegenerate = events.on('message:regenerate', payload => {
    if (!payload?.conversationId || !payload?.messageId) return
    const result = service.regenerate(payload.conversationId, payload.messageId)
    if (result.ok === false) ctx.inject('toast')?.warn?.(result.error || '暂时无法重新生成')
  })

  ctx.provide('chat-flow', service, { type: 'singleton' })
  ctx.effect(offSend)
  ctx.effect(offRegenerate)
  ctx.logger.debug(`聊天流程就绪（${service.mode()} 模式 · ${tools?.names?.().length ?? 0} 个工具）`)
}
