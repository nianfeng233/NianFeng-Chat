/**
 * D? · chat-permissions
 * 聊天链路权限与敏感确认（文档 §7）：
 *   - 权限来源是后端 / 本机真实用户身份，而不是消息正文里的伪装字段
 *   - 默认普通用户锁死当前渠道：跨渠道读写一律返回统一的“目标渠道不可用”
 *   - 高权限用户的跨渠道操作走权限表；敏感操作可要求用户在输入框输入“确认”
 *   - 每一条放行 / 拒绝 / 确认结果都写入审计日志（不进入聊天记录库）
 */
export const name = 'chat-permissions'
export const version = '1.0.0'
export const displayName = '聊天权限'
export const description = '业务服务 · 渠道读写权限表、跨渠道校验、敏感确认与审计。'
export const author = '风语内核'
export const icon = '🛡️'
export const core = true
export const depends = { 'chat-store': '^1.0.0', config: '^1.0.0', 'event-bus': '^1.0.0' }
export const inject = ['chat-store', 'session-service', 'config', 'event-bus', 'storage', 'toast?']
export const provides = [{ name: 'chat-permissions', type: 'singleton' }]

import { resolveUserNickname } from '../../../src/util/identity.mjs'

const NS = 'chat-permissions'
const KEY = 'data'
const CONFIRM_TIMEOUT = 120000

export function apply(ctx) {
  const store = ctx.inject('chat-store')
  const sessions = ctx.inject('session-service')
  const config = ctx.inject('config')
  const events = ctx.inject('event-bus')
  const storage = ctx.inject('storage')
  const toast = ctx.inject('toast')

  let data = storage.get(NS, KEY, null)
  if (!data || typeof data !== 'object' || !Array.isArray(data.grants) || !Array.isArray(data.audit)) {
    data = { grants: [], audit: [] }
  }
  const persist = () => storage.set(NS, KEY, data)

  /** confirmId -> { resolve, timer, ... } */
  const pending = new Map()
  let confirmSeq = 0

  const recordAudit = entry => {
    data.audit.push({ at: new Date().toISOString(), ...entry })
    if (data.audit.length > 500) data.audit.splice(0, data.audit.length - 500)
    persist()
    events.emit('chat:audit', entry)
  }

  const deny = (entry, reason = '目标渠道不可用') => {
    recordAudit({ result: 'denied', reason, ...entry })
    return { ok: false, code: 'CHANNEL_UNAVAILABLE', error: '目标渠道不可用' }
  }

  const contextFor = conversationId => {
    const conv = sessions.get(conversationId)
    const channel = store.channelForConversation(conversationId)
    if (!conv || !channel) return null
    const userId = String(config.get('chat.userId', 'web-user') || 'web-user')
    const userName = resolveUserNickname(config)
    return {
      conversationId,
      roleId: conv.meta?.roleId || conv.id,
      channelId: channel.channelId,
      userId,
      userName,
      channel,
    }
  }

  const findGrant = ({ roleId, userId, sourceChannel, targetChannel }) =>
    data.grants.find(
      grant =>
        (grant.roleId === '*' || grant.roleId === roleId) &&
        (grant.userId === '*' || grant.userId === userId) &&
        (grant.sourceChannel === '*' || grant.sourceChannel === sourceChannel) &&
        (grant.targetChannel === '*' || grant.targetChannel === targetChannel),
    ) || null

  const requestConfirm = ({ action, confirmTarget }) =>
    new Promise(resolve => {
      const id = `confirm_${Date.now().toString(36)}${(++confirmSeq).toString(36)}`
      const payload = {
        id,
        action,
        conversationId: confirmTarget.conversationId,
        sourceChannel: confirmTarget.channelId,
        targetChannel: confirmTarget.targetChannelId,
        targetName: confirmTarget.targetName || confirmTarget.targetChannelId,
        createdAt: Date.now(),
      }
      const finish = approved => {
        const record = pending.get(id)
        if (!record) return
        clearTimeout(record.timer)
        pending.delete(id)
        recordAudit({
          result: approved ? 'confirmed' : 'rejected-or-timeout',
          action,
          userId: confirmTarget.userId,
          sourceChannel: confirmTarget.channelId,
          targetChannel: confirmTarget.targetChannelId,
        })
        events.emit('chat:confirm-resolved', { id, approved })
        resolve(approved)
      }
      const timer = setTimeout(() => finish(false), CONFIRM_TIMEOUT)
      pending.set(id, { id, timer, finish, conversationId: confirmTarget.conversationId })
      toast?.warn?.(
        `敏感操作需要确认：向「${payload.targetName}」${action === 'read' ? '读取记录' : '发送消息'}。` +
          `请在输入框输入“确认”同意，输入其它内容视为拒绝。`,
      )
      events.emit('chat:confirm-request', payload)
    })

  /**
   * 校验一次工具操作。
   * 同渠道直接放行；跨渠道需要权限表中的 canCrossRead / canCrossSend；
   * 敏感操作还需要用户确认（chat.confirmSensitive 开关）。
   * @returns {Promise<{ok:boolean, code?:string, error?:string, channelId?:string, confirmed?:boolean}>}
   */
  const authorize = async ({ conversationId, action = 'read', channel = null, confirmed = false } = {}) => {
    const current = contextFor(conversationId)
    if (!current) return { ok: false, code: 'CHANNEL_UNAVAILABLE', error: '目标渠道不可用' }
    const target = channel ? store.resolveChannel(String(channel)) : current.channel
    if (!target) {
      recordAudit({ result: 'denied', reason: 'unknown-channel', userId: current.userId, sourceChannel: current.channelId, targetChannel: String(channel || '') })
      return { ok: false, code: 'CHANNEL_UNAVAILABLE', error: '目标渠道不可用' }
    }
    if (target.channelId === current.channelId) return { ok: true, channelId: target.channelId, confirmed: true }

    const crossFlag = action === 'read' ? 'canCrossRead' : 'canCrossSend'
    const grant = findGrant({
      roleId: current.roleId,
      userId: current.userId,
      sourceChannel: current.channelId,
      targetChannel: target.channelId,
    })
    const policyAllowed = action === 'read' ? target.crossReadable === true : target.crossSendable === true
    if (!grant || grant[crossFlag] !== true || !policyAllowed) {
      return deny({
        action,
        userId: current.userId,
        sourceChannel: current.channelId,
        targetChannel: target.channelId,
        reason: !grant ? 'no-grant' : !policyAllowed ? 'channel-policy' : `${crossFlag}=false`,
      })
    }

    if (!confirmed && config.get('chat.confirmSensitive', true)) {
      const approved = await requestConfirm({
        action,
        confirmTarget: {
          ...current,
          userId: current.userId,
          targetChannelId: target.channelId,
          targetName: target.conversationId ? sessions.get(target.conversationId)?.name || target.channelId : target.channelId,
        },
      })
      if (!approved) return { ok: false, code: 'CONFIRM_REJECTED', error: '用户拒绝了该敏感操作' }
      recordAudit({
        result: 'allowed',
        action,
        userId: current.userId,
        sourceChannel: current.channelId,
        targetChannel: target.channelId,
        confirmed: true,
      })
      return { ok: true, channelId: target.channelId, confirmed: true }
    }

    recordAudit({ result: 'allowed', action, userId: current.userId, sourceChannel: current.channelId, targetChannel: target.channelId })
    return { ok: true, channelId: target.channelId, confirmed: true }
  }

  const service = {
    name: 'chat-permissions',
    contextFor,
    authorize,
    can: authorize,

    hasPending: conversationId => [...pending.values()].some(item => item.conversationId === conversationId),

    /** 权限表：role_id / user_id / source_channel / target_channel / 四个标志（文档 §7.2） */
    grant(entry = {}) {
      const record = {
        roleId: entry.roleId ?? entry.role_id ?? '*',
        userId: entry.userId ?? entry.user_id ?? '*',
        sourceChannel: entry.sourceChannel ?? entry.source_channel ?? '*',
        targetChannel: entry.targetChannel ?? entry.target_channel ?? '*',
        canRead: entry.canRead ?? entry.can_read ?? false,
        canSend: entry.canSend ?? entry.can_send ?? false,
        canCrossRead: entry.canCrossRead ?? entry.can_cross_read ?? false,
        canCrossSend: entry.canCrossSend ?? entry.can_cross_send ?? false,
      }
      data.grants.push(record)
      persist()
      events.emit('chat:permission-changed', { grants: data.grants.length })
      return record
    },

    revoke(indexOrEntry) {
      let index = -1
      if (typeof indexOrEntry === 'number') index = indexOrEntry
      else index = data.grants.lastIndexOf(indexOrEntry)
      if (index < 0 || index >= data.grants.length) return false
      data.grants.splice(index, 1)
      persist()
      events.emit('chat:permission-changed', { grants: data.grants.length })
      return true
    },

    grants: () => structuredClone(data.grants),
    audit: (limit = 50) => structuredClone(data.audit.slice(-Math.max(1, Number(limit) || 50))),

    /** 用户输入“确认”/其它内容时由拦截器调用；返回是否消费了这条输入 */
    resolvePending(conversationId, text) {
      const item = [...pending.values()].find(record => record.conversationId === conversationId)
      if (!item) return { handled: false }
      const approved = String(text ?? '').trim() === '确认'
      item.finish(approved)
      return { handled: approved, approved }
    },
  }

  // 敏感确认通过输入框完成：输入“确认”同意，输入其它内容统一视为拒绝；
  // 两种情况下这条输入都会被消费，不会进入聊天记录。
  const offConfirm = events.on(
    'message:send',
    payload => {
      const text = payload?.text
      if (!text || !pending.size) return payload
      const item = [...pending.values()].find(record => record.conversationId === payload.conversationId)
      if (!item) return payload
      const result = service.resolvePending(payload.conversationId, text)
      return { ...payload, confirmHandled: true, confirmApproved: result.approved }
    },
    { owner: 'chat-permissions', interceptor: true },
  )

  ctx.provide('chat-permissions', service, { type: 'singleton' })
  ctx.effect(offConfirm)
  ctx.effect(() => {
    for (const item of pending.values()) clearTimeout(item.timer)
    pending.clear()
  })
  ctx.logger.debug('聊天权限与敏感确认就绪')
}
