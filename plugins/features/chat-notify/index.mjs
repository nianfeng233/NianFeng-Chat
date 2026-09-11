/**
 * B? · chat-notify
 * 角色消息通知桥：把“收到新消息”翻译成 notification 服务的三种通知之一。
 *
 * 触发条件（符合用户直觉）：
 *   - 程序 / 浏览器处于后台（document.hidden）时；
 *   - 或者当前不在收到消息的那个会话里时；
 *   - 角色每发来一条消息（普通流式回复结束、工具直接发送、资料消息）都会产生一条通知。
 *
 * 通知样式为 character：最左侧角色头像，右侧角色名 + 消息预览；
 * 点击通知会切回对应会话并尝试聚焦窗口。
 */
export const name = 'chat-notify'
export const version = '1.0.0'
export const displayName = '角色消息提醒'
export const description = '业务功能 · 后台或非当前会话收到角色消息时，发送带角色头像与预览的通知。'
export const author = '风语内核'
export const icon = '🔔'
export const core = false
export const depends = {
  'message-service': '^1.0.0',
  'session-service': '^1.0.0',
  notification: '^1.0.0',
  config: '^1.0.0',
}
export const inject = ['message-service', 'session-service', 'config', 'event-bus', 'notification?']
export const provides = []

const PREVIEW_LIMIT = 140
const SEEN_LIMIT = 800

export function apply(ctx) {
  const sessions = ctx.inject('session-service')
  const events = ctx.inject('event-bus')
  const config = ctx.inject('config')

  /** 已通知过的 message id，避免 message:added / message:done 双触发同一条消息 */
  const seen = new Set()
  const seenOrder = []

  const markSeen = id => {
    if (!id || seen.has(id)) return false
    seen.add(id)
    seenOrder.push(id)
    if (seenOrder.length > SEEN_LIMIT) seen.delete(seenOrder.shift())
    return true
  }

  const notifier = () => ctx.registry.get('notification')

  const shouldNotify = conversationId => {
    if (config.get('notify.messages', true) === false) return false
    const hidden = typeof document !== 'undefined' && !!document.hidden
    if (hidden) return true
    return sessions.activeId() !== conversationId
  }

  const previewOf = message => {
    const raw =
      message?.kind === 'document'
        ? `【资料】${message.meta?.title || message.content || '未命名资料'}${message.meta?.summary ? ` · ${message.meta.summary}` : ''}`
        : String(message?.content || '')
    return raw.replace(/\s+/g, ' ').trim().slice(0, PREVIEW_LIMIT)
  }

  /** 一条角色消息 → 一条 character 通知 */
  const notifyMessage = (conversationId, message) => {
    if (!message || message.kind === 'divider') return
    if (message.role !== 'assistant' || message.error) return
    if (message.streaming && !String(message.content || '').trim()) return
    const body = previewOf(message)
    if (!body) return
    if (!shouldNotify(conversationId)) return
    if (!markSeen(message.id || message.message_id)) return

    const conv = sessions.get(conversationId)
    const name = message.sender_name || conv?.name || '角色消息'
    notifier()?.notify?.({
      kind: 'character',
      title: name,
      body,
      avatarImage: conv?.meta?.avatarImage || '',
      avatarText: conv?.avatar || name.slice(0, 1),
      c1: conv?.c1,
      c2: conv?.c2,
      sound: true,
      // 只有页面不可见时才受「后台活动」开关约束
      background: typeof document !== 'undefined' && !!document.hidden,
      onClick: () => {
        try {
          sessions.activate(conversationId)
          window.focus?.()
        } catch (_) {
          /* 激活失败不影响通知 */
        }
      },
    })
  }

  const offAdded = events.on('message:added', ({ conversationId, message } = {}) => {
    // 工具直接发送 / 非流式消息：added 时内容已经完整
    if (message?.streaming) return
    notifyMessage(conversationId, message)
  })
  const offDone = events.on('message:done', ({ conversationId, message } = {}) => {
    // 普通流式回复：结束时才拿到完整内容
    notifyMessage(conversationId, message)
  })

  ctx.effect(() => {
    offAdded()
    offDone()
  })

  ctx.logger.debug('角色消息提醒已就绪')
}
