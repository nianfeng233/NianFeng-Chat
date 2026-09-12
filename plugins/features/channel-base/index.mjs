/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * B2 · channel-base
 * 渠道接入基座：渠道插件只需要声明类型 + 连接钩子，
 * 入站消息会被自动落到对应的会话里（channel:message → conversation）。
 */
export const name = 'channel-base'
export const version = '1.0.0'
export const displayName = '渠道基座'
export const description = '业务功能 · 渠道插件公共基座，负责连接状态与消息落库。'
export const author = '念风内核'
export const icon = '🛠️'
export const core = true
export const depends = { 'channel-registry': '^1.0.0', 'session-service': '^2.0.0', 'message-service': '^1.0.0' }
export const inject = ['channel-registry', 'session-service', 'message-service', 'event-bus', 'toast']
export const provides = [{ name: 'channel-base', type: 'singleton' }]

export function apply(ctx) {
  const registry = ctx.inject('channel-registry')
  const sessions = ctx.inject('session-service')
  const messages = ctx.inject('message-service')
  const events = ctx.inject('event-bus')
  const toast = ctx.inject('toast')

  /** channelType -> (payload) => Promise<{ok:boolean,error?:string}> */
  const outboundHandlers = new Map()
  /** conversationId -> 串行外发链，保证同一渠道的消息严格按入库顺序发送 */
  const outboundChains = new Map()
  /** conversationId:messageId -> true，避免 added / done 双事件重复发送同一条消息 */
  const outboundSeen = new Set()

  /** 通过 meta.conversationId 反查渠道记录；渠道插件创建会话时都会写入这个字段。 */
  const channelForConversation = conversationId => {
    const wanted = String(conversationId || '')
    if (!wanted) return null
    for (const tab of registry.tabs()) {
      for (const channel of registry.channels(tab)) {
        if (String(channel?.meta?.conversationId || '') === wanted) return { tab, channel }
      }
    }
    return null
  }

  const outboundIdle = conversationId => outboundChains.get(conversationId) || Promise.resolve()

  const enqueueOutbound = (conversationId, task) => {
    const previous = outboundChains.get(conversationId) || Promise.resolve()
    const next = previous.catch(() => {}).then(task)
    outboundChains.set(conversationId, next)
    Promise.resolve(next)
      .catch(() => {})
      .finally(() => {
        if (outboundChains.get(conversationId) === next) outboundChains.delete(conversationId)
      })
    return next
  }

  const deliverable = message => {
    if (!message || message.role !== 'assistant') return false
    if (message.streaming || message.error) return false
    if (message.meta?.direction === 'outbound') return false
    if (!String(message.content || '').trim() && !(Array.isArray(message.meta?.images) && message.meta.images.length)) return false
    return true
  }

  /**
   * 助手消息一旦写入某个渠道会话，就立即按入库顺序外发，而不是等整轮模型结束。
   * 跨渠道 chat_send / send_document 也会走到这里，因此目标渠道会真正收到消息。
   */
  const dispatchOutbound = (conversationId, message) => {
    if (!deliverable(message)) return false
    const found = channelForConversation(conversationId)
    if (!found?.channel) return false
    const channel = found.channel
    const handler = outboundHandlers.get(channel.type)
    if (typeof handler !== 'function') return false
    const messageId = String(message.id || message.message_id || '')
    const seenKey = `${conversationId}:${messageId}`
    if (outboundSeen.has(seenKey)) return false
    outboundSeen.add(seenKey)
    const base = {
      conversationId,
      channelId: channel.id,
      channelType: channel.type,
      messageId,
    }
    events.emit('channel:outbound', { ...base, status: 'pending' })
    Promise.resolve(
      enqueueOutbound(conversationId, async () => {
        const startedAt = Date.now()
        try {
          const result = await handler({ channel, conversationId, message })
          if (result?.ok === false) throw new Error(result.error || '外发失败')
          events.emit('channel:outbound', { ...base, status: 'sent', ms: Date.now() - startedAt })
          ctx.logger.debug(`[channel] ${channel.type} 外发成功：${String(message.content || '').slice(0, 40)}`)
          return result
        } catch (err) {
          const error = err?.message || String(err)
          events.emit('channel:outbound', { ...base, status: 'failed', error, ms: Date.now() - startedAt })
          ctx.logger.warn(`[channel] ${channel.type} 外发失败：${error}`)
          try {
            toast?.warn?.(`${channel.name || channel.type} 外发失败：${error}`)
          } catch (_) {
            /* toast 服务不可用时忽略 */
          }
          // 失败标记写在消息 meta 上：聊天记录 UI / 日志页能看到，后续可手动重试，
          // 同时避免同一条消息被事件重复外发。
          try {
            const current = sessions.message(conversationId, messageId)
            if (current && current.meta?.direction !== 'outbound') {
              messages.update(conversationId, current.id, {
                meta: { ...(current.meta || {}), outboundError: error, outboundFailedAt: Date.now() },
              })
            }
          } catch (_) {
            /* 消息可能已被删除 */
          }
          // 系统级失败提示回写到会话里：用户下次打开记录 / 对应渠道都能看到真实原因。
          try {
            messages.add(conversationId, {
              role: 'assistant',
              content: `【外发失败】${channel.name || channel.type}：${error}`,
              meta: { via: channel.type, direction: 'outbound', outboundError: error, errorNotice: true },
            })
          } catch (_) {
            /* ignore */
          }
          return { ok: false, error }
        }
      }),
    )
      .catch(() => {})
      .finally(() => outboundSeen.delete(seenKey))
    return true
  }

  const onOutboundMessage = payload => {
    const conversationId = payload?.conversationId
    const message = payload?.message
    if (!conversationId || !message) return
    dispatchOutbound(conversationId, message)
  }

  const service = {
    name: 'channel-base',
    version: '1.0.0',

    /**
     * 渠道插件声明入口。
     * @param {{
     *   type: string, name: string, color: string, icon?: string, description?: string,
     *   connect?: Function, disconnect?: Function, autoCreateConversation?: boolean
     * }} definition
     */
    defineChannel(definition) {
      if (!definition?.type) throw new Error('渠道类型必须声明 type')
      const def = {
        autoCreateConversation: definition.autoCreateConversation !== false,
        ...definition,
      }

      const dispose = registry.registerType(def.type, {
        name: def.name,
        color: def.color,
        icon: def.icon,
        description: def.description,
        meta: { plugin: ctx.id },
        // 渠道插件可以自定义“添加渠道”与“渠道详情”流程；
        // 未提供时 channel-list / channel-detail-host 走通用 UI。
        create: def.create,
        detail: def.detail,
        settingsSchema: def.settingsSchema,
        connect: async channel => {
          await def.connect?.(channel)
          return channel
        },
        disconnect: async channel => {
          await def.disconnect?.(channel)
          return channel
        },
      })

      const outbound = typeof def.outbound === 'function' ? def.outbound : null
      if (outbound) outboundHandlers.set(def.type, outbound)
      const disposeAll = () => {
        if (outbound && outboundHandlers.get(def.type) === outbound) outboundHandlers.delete(def.type)
        dispose()
      }
      ctx.effect(disposeAll)
      ctx.logger.debug(`渠道类型 ${def.type} 已注册${outbound ? '（支持即时外发）' : ''}`)

      return {
        type: def.type,
        /** 由渠道插件在收到外部消息时调用 */
        emitIncoming(channelId, payload = {}) {
          const channel = findChannel(registry, channelId)
          events.emit('channel:message', { channelId, channelType: def.type, message: payload, channel })
        },
        dispose: disposeAll,
      }
    },

    /** 渠道 → 会话：没有就创建，然后把消息写进去 */
    conversationFor(channel) {
      if (!channel) return null
      const existingId = channel.meta?.conversationId
      if (existingId && sessions.get(existingId)) return existingId
      const conv = sessions.create({
        name: channel.name,
        avatar: channel.name.slice(0, 1),
        c1: channel.color,
        c2: channel.color,
        preview: `${channel.name} 已接入`,
        meta: { channelId: channel.id, channelType: channel.type },
      })
      registry.updateChannel(findTab(registry, channel.id), channel.id, {
        meta: { ...(channel.meta || {}), conversationId: conv.id },
      })
      return conv.id
    },

    /** 渠道插件注册 / 检查外发实现；外发由 message:added / message:done 自动触发。 */
    hasOutbound: type => typeof outboundHandlers.get(type) === 'function',
    /** 等待某个会话当前排队的外发全部结算（渠道插件在整轮结束时使用）。 */
    outboundIdle,
  }

  /* 入站消息 → 会话消息 */
  const offIncoming = events.on('channel:message', ({ channelId, message, channel }) => {
    const target = channel || findChannel(registry, channelId)
    if (!target) return
    const convId = service.conversationFor(target)
    const role = message?.role === 'assistant' ? 'assistant' : 'user'
    const text = String(message?.content ?? message?.text ?? '').trim()
    if (!text) return
    messages.add(convId, { role, content: text })
    sessions.activate(convId)
    toast.info(`收到来自「${target.name}」的消息`)
    ctx.logger.info(`[channel] ${target.name}: ${text.slice(0, 40)}`)
  })

  // 助手消息一写入渠道会话就尝试外发：流式消息在 done 时触发，工具消息在 added 时触发。
  const offOutboundAdded = events.on('message:added', onOutboundMessage)
  const offOutboundDone = events.on('message:done', onOutboundMessage)

  ctx.provide('channel-base', service, { type: 'singleton' })
  ctx.effect(() => {
    offIncoming()
    offOutboundAdded()
    offOutboundDone()
  })
  ctx.logger.debug('渠道基座就绪')
}

function findChannel(registry, channelId) {
  for (const tab of registry.tabs()) {
    const found = registry.findChannel(tab, channelId)
    if (found) return found
  }
  return null
}

function findTab(registry, channelId) {
  for (const tab of registry.tabs()) {
    if (registry.findChannel(tab, channelId)) return tab
  }
  return 'private'
}
