/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * D? · user-identity
 * 统一用户身份服务：目前从本机配置读取；未来联网账号 / 渠道插件可以通过
 * registerProvider() 注入真实用户信息（userId / userName / source），
 * 聊天链路、渠道身份、消息 sender 字段统一从这里取。
 */
export const name = 'user-identity'
export const version = '1.0.0'
export const displayName = '用户身份'
export const description = '业务服务 · 统一用户标识（本地配置默认值 + 未来联网账号提供者接口）。'
export const author = '念风内核'
export const icon = '🪪'
export const core = true
export const depends = { config: '^1.1.0' }
export const inject = ['config', 'event-bus']
export const provides = [{ name: 'user-identity', type: 'singleton' }]

import { resolveUserNickname } from '../../../src/util/identity.mjs'

export function apply(ctx) {
  const config = ctx.inject('config')
  const events = ctx.inject('event-bus')
  const providers = new Set()

  const localIdentity = () => ({
    userId: String(config.get('identity.userId', '') || config.get('chat.userId', 'web-user') || 'web-user').trim() || 'web-user',
    userName: String(config.get('identity.userName', '') || resolveUserNickname(config)).trim() || resolveUserNickname(config),
    source: 'local',
  })

  const service = {
    name: 'user-identity',

    /** 当前用户身份；未来联网插件注册 provider 后会自动优先使用 provider。 */
    get() {
      for (const provider of providers) {
        try {
          const value = typeof provider === 'function' ? provider() : provider?.get?.()
          if (!value || typeof value !== 'object') continue
          const local = localIdentity()
          const userId = String(value.userId || '').trim()
          const userName = String(value.userName || '').trim()
          if (!userId && !userName) continue
          return {
            userId: userId || local.userId,
            userName: userName || local.userName,
            source: String(value.source || 'provider'),
            avatarImage: String(value.avatarImage || ''),
          }
        } catch (err) {
          ctx.logger.warn(`用户身份提供者读取失败：${err.message}`)
        }
      }
      return localIdentity()
    },

    /**
     * 注册用户身份提供者（联网账号插件等）。
     * provider 可以是返回 { userId, userName, source? } 的函数，也可以是带 get() 的对象。
     */
    registerProvider(provider) {
      if (!provider) return () => {}
      providers.add(provider)
      events.emit('user-identity:changed', service.get())
      return () => {
        providers.delete(provider)
        events.emit('user-identity:changed', service.get())
      }
    },

    /** 配置或 provider 更新后主动广播一次 */
    refresh(reason = '') {
      const identity = service.get()
      events.emit('user-identity:changed', { ...identity, reason })
      return identity
    },
  }

  ctx.provide('user-identity', service, { type: 'singleton' })

  ctx.effect(
    ctx.on('config:changed', payload => {
      const key = String(payload?.key || '')
      if (key === '*' || key.startsWith('identity.') || key.startsWith('chat.userId') || key.startsWith('ui.nickname')) service.refresh('config')
    }),
  )

  ctx.logger.debug(`用户身份服务就绪（${JSON.stringify(service.get())}）`)
}
