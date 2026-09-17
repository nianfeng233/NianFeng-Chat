/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * 渠道入站消息日志格式化。
 *
 * 日志页 / runtime.log 里不想只看到 `[channel] 渠道名: 前 40 个字`，
 * 而是像 AstrBot 一样能直接看出「谁、从哪个渠道、在群里还是私聊、正文是什么」。
 * 这里不依赖任何 DOM / 插件服务，WebUI 与 Node 代聊 Worker 都能复用。
 */

const clean = (value, max = 0) => {
  const text = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!max || text.length <= max) return text
  return `${text.slice(0, max)}…`
}

const firstText = (...values) => {
  for (const value of values) {
    const text = String(value ?? '').trim()
    if (text) return text
  }
  return ''
}

const isGroupScope = (value, groupId) => {
  const text = String(value || '').toLowerCase()
  if (text === 'group' || text === '群' || text === '群聊') return true
  if (text === 'private' || text === 'c2c' || text === '私聊') return false
  if (/group|guild|群/.test(text)) return true
  return !!groupId
}

/**
 * 生成一行可读的入站消息日志。
 *
 * @param {object} message 结构化消息（chat-store / message-service 均可）
 * @param {{ channelName?: string, channelType?: string, scope?: string, groupId?: string }} options
 * @returns {string}
 */
export function describeIncomingMessage(message = {}, options = {}) {
  const meta = message?.meta && typeof message.meta === 'object' ? message.meta : {}
  const channelName = clean(
    options.channelName || meta.channelName || meta.via || message.source || options.channelType || '渠道',
    40,
  )
  const channelType = clean(options.channelType || meta.via || message.source || '', 40)
  const typeText = `${channelType} ${meta.messageType || ''} ${meta.sessionType || ''}`.toLowerCase()

  const inferredGroupId = firstText(
    options.groupId,
    meta.groupId,
    /group|群/.test(typeText) ? meta.peerId : '',
  )
  const scopeText = clean(options.scope || meta.sessionType || meta.messageType || meta.chatType || meta.scene, 30)
  const group = isGroupScope(scopeText, inferredGroupId)

  const senderName =
    clean(
      firstText(
        meta.wxSenderName,
        meta.senderNickname,
        meta.senderCard,
        meta.senderName,
        meta.memberName,
        meta.nickname,
        message.sender_name,
      ),
      60,
    ) || '未知用户'
  const senderId = clean(
    firstText(meta.senderId, meta.fromUserId, meta.senderOpenid, message.sender_id, meta.sender_id),
    80,
  )
  const sourceText = `${channelType} ${message.source || ''}`.toLowerCase()
  const idLabel = /qqbot/.test(sourceText)
    ? 'openid'
    : /napcat|onebot/.test(sourceText)
      ? 'QQ'
      : /clawbot|wechat|weixin|微信/.test(sourceText) || meta.fromUserId
        ? '微信'
        : meta.senderOpenid
          ? 'openid'
          : meta.messageType
            ? 'QQ'
            : 'ID'
  const sender = senderId && !senderName.includes(senderId) ? `${senderName}（${idLabel} ${senderId}）` : senderName

  const imageCount = Array.isArray(meta.images) ? meta.images.length : 0
  const content = clean(message?.content ?? message?.text, 500)
  const body = content || (imageCount ? `[图片 ${imageCount} 张]` : '[非文本消息]')
  const extras = []
  if (imageCount && content) extras.push(`含图片 ${imageCount} 张`)
  if (meta.forward) extras.push('转发')
  if (meta.quote) extras.push('引用')
  const suffix = extras.length ? `（${extras.join(' · ')}）` : ''

  const where = group ? (inferredGroupId ? `群 ${clean(inferredGroupId, 40)}` : '群聊') : '私聊'
  return `[收到消息] ${channelName} · ${where} · ${sender}：${body}${suffix}`
}
