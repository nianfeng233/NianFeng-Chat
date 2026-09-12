/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
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
export const author = '念风内核'
export const icon = '🛡️'
export const core = true
export const depends = { 'chat-store': '^1.0.0', config: '^1.0.0', 'event-bus': '^1.0.0' }
export const inject = ['chat-store', 'session-service', 'config', 'event-bus', 'storage', 'toast?', 'user-identity?']
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
    const identity = ctx.registry.get('user-identity')?.get?.() || {}
    // userId 继续作为“权限主体”稳定标识（沿用历史 chat.userId，保证已有授权不失效）；
    // identityUserId 才是展示 / 模型上下文里的用户标识，暂时等于用户名，未来由联网插件提供真实账号 ID。
    const userId = String(config.get('chat.userId', 'web-user') || 'web-user')
    const identityUserId = String(identity.userId || userId)
    const userName = String(identity.userName || resolveUserNickname(config))
    return {
      conversationId,
      roleId: conv.meta?.roleId || conv.id,
      channelId: channel.channelId,
      userId,
      identityUserId,
      userName,
      identitySource: identity.source || 'local',
      channel,
      channelGroup: channel.group || 'private',
      // 渠道插件在会话 meta 上声明的策略（clawbot 的“跨渠道读取 / 发送”开关）。
      // 这些是真正随会话持久化的来源侧授权，不再依赖另外手工写入 grants 表。
      crossReadable: conv.meta?.crossReadable === true,
      crossSendable: conv.meta?.crossSendable === true,
      sensitiveConfirm: conv.meta?.sensitiveConfirm !== false,
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

  /** 给确认弹窗 / 微信提示用的渠道描述：区分网页渠道和微信clawbot，而不是只抛角色名。 */
  const describeChannel = target => {
    const channelId = String(target?.channelId || '')
    const kind = channelId.split(':')[0]
    const kindLabel =
      kind === 'wechat-clawbot' ? '微信clawbot' : kind === 'nova' || target?.source === 'nova' ? '网页' : target?.source || '其它'
    const conv = target?.conversationId ? sessions.get(target.conversationId) : null
    const name = conv?.name || target?.conversationId || channelId || '未命名渠道'
    return `${kindLabel}渠道「${name}」（${channelId || 'unknown'}）`
  }

  const requestConfirm = ({ action, confirmTarget, allowedUserIds = null }) =>
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
      // 允许确认的主体：默认是网页端主人（userId / identityUserId）；群聊等多人渠道
      // 可以由渠道插件显式传入 trusted openid 列表；空数组表示“谁都不能确认”。
      const allowed =
        allowedUserIds === null
          ? [confirmTarget.userId, confirmTarget.identityUserId].map(item => String(item || '').trim()).filter(Boolean)
          : Array.isArray(allowedUserIds)
            ? allowedUserIds.map(item => String(item || '').trim()).filter(Boolean)
            : null
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
      pending.set(id, { id, timer, finish, conversationId: confirmTarget.conversationId, allowedUserIds: allowed })
      toast?.warn?.(
        `敏感操作需要确认：${action === 'read' ? '读取' : '向'} ${payload.targetName} ${action === 'read' ? '的聊天记录' : '发送消息'}。` +
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

    // 隐私渠道完全隔离：既不能读/发其它渠道，其它渠道也不能读/发它。
    if (target.channelId !== current.channelId && (current.channelGroup === 'privacy' || target.group === 'privacy')) {
      return deny(
        {
          action,
          userId: current.userId,
          sourceChannel: current.channelId,
          targetChannel: target.channelId,
          reason: 'privacy-isolated',
        },
        '隐私渠道只能单会话交互，不能与其他渠道互读 / 互发',
      )
    }

    const crossFlag = action === 'read' ? 'canCrossRead' : 'canCrossSend'
    const grant = findGrant({
      roleId: current.roleId,
      userId: current.userId,
      sourceChannel: current.channelId,
      targetChannel: target.channelId,
    })
    // 来源侧策略（渠道设置里勾选“跨渠道读取 / 发送”）和授权表二选一即可；
    // 授权表仍需目标渠道声明可被跨渠道访问，避免旧 grants 绕过目标侧开关。
    const sourceAllowed = action === 'read' ? current.crossReadable : current.crossSendable
    const targetAllowed = action === 'read' ? target.crossReadable : target.crossSendable
    const grantAllowed = !!grant && grant[crossFlag] === true
    const permissionAllowed = sourceAllowed || (grantAllowed && targetAllowed)
    if (!permissionAllowed) {
      return deny({
        action,
        userId: current.userId,
        sourceChannel: current.channelId,
        targetChannel: target.channelId,
        reason: !sourceAllowed && !grantAllowed ? 'no-grant' : !targetAllowed ? 'channel-policy' : `${crossFlag}=false`,
      })
    }

    const mustConfirm = config.get('chat.confirmSensitive', true) && current.sensitiveConfirm !== false
    if (!confirmed && mustConfirm) {
      const approved = await requestConfirm({
        action,
        confirmTarget: {
          ...current,
          userId: current.userId,
          targetChannelId: target.channelId,
          targetName: describeChannel(target),
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

    /**
     * 用户输入“确认”/其它内容时由拦截器或渠道插件调用；返回是否消费了这条输入。
     * options.senderId：消息发送者标识（群聊里是成员 openid / 渠道内稳定 ID）。
     * options.allowedUserIds：显式覆盖待确认请求允许的 senderId 列表；
     *   不传时使用请求创建时的默认列表（网页端主人）。
     * 非授权发送者的“确认”会被无视（handled=false），既不消耗请求也不改变状态。
     */
    resolvePending(conversationId, text, options = {}) {
      const item = [...pending.values()].find(record => record.conversationId === conversationId)
      if (!item) return { handled: false }
      const senderId = String(options.senderId || '').trim()
      const allowed = Array.isArray(options.allowedUserIds)
        ? options.allowedUserIds.map(value => String(value || '').trim()).filter(Boolean)
        : item.allowedUserIds
      if (senderId && Array.isArray(allowed) && !allowed.includes(senderId)) {
        return { handled: false, ignored: true }
      }
      const approved = String(text ?? '').trim() === '确认'
      item.finish(approved)
      // handled=true 表示这条输入已被确认流程消费（无论同意还是拒绝）；
      // approved 才表示是否放行。非授权发送者在上面的分支里返回 ignored。
      return { handled: true, approved }
    },
  }

  // 敏感确认通过输入框完成：输入“确认”同意，输入其它内容统一视为拒绝；
  // 两种情况下这条输入都会被消费，不会进入聊天记录。多人渠道的授权由渠道插件
  // 通过 payload.senderId / allowedUserIds 传入。
  const offConfirm = events.on(
    'message:send',
    payload => {
      const text = payload?.text
      if (!text || !pending.size) return payload
      const item = [...pending.values()].find(record => record.conversationId === payload.conversationId)
      if (!item) return payload
      const result = service.resolvePending(payload.conversationId, text, {
        senderId: payload.senderId || payload.sender_id || '',
        allowedUserIds: payload.allowedUserIds,
      })
      if (!result.handled) return payload
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
