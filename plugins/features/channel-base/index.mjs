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
export const depends = { 'channel-registry': '^1.0.0', 'session-service': '^1.0.0', 'message-service': '^1.0.0' }
export const inject = ['channel-registry', 'session-service', 'message-service', 'event-bus', 'toast']
export const provides = [{ name: 'channel-base', type: 'singleton' }]

export function apply(ctx) {
  const registry = ctx.inject('channel-registry')
  const sessions = ctx.inject('session-service')
  const messages = ctx.inject('message-service')
  const events = ctx.inject('event-bus')
  const toast = ctx.inject('toast')

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

      ctx.effect(dispose)
      ctx.logger.debug(`渠道类型 ${def.type} 已注册`)

      return {
        type: def.type,
        /** 由渠道插件在收到外部消息时调用 */
        emitIncoming(channelId, payload = {}) {
          const channel = findChannel(registry, channelId)
          events.emit('channel:message', { channelId, channelType: def.type, message: payload, channel })
        },
        dispose,
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

  ctx.provide('channel-base', service, { type: 'singleton' })
  ctx.effect(offIncoming)
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
