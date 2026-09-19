/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * A1 · agent-client（WebUI 远程代聊通道）
 *
 * 背景：
 *   本轮架构拆分后，浏览器 WebUI 不再加载 chat-flow / context-builder /
 *   chat-tools / memory-store 等业务执行插件；所有这些统一由后端终端的
 *   常驻代聊 Worker 执行。
 *
 * 本插件是 WebUI 唯一的“业务代理”：
 *   - 监听 composer 发出的 message:send；
 *   - 通过 POST /api/agent/send 交给后端 Worker；
 *   - 接收后端 agent/status 事件，把开始 / 结束状态映射回 chat:request-start/done，
 *     让输入框的“正在输入 / 停止生成”仍然正常。
 *
 * 如果检测到本运行时就加载了 chat-flow（例如测试模式 scope=all），本插件自动
 * 让位，不改变原有本地聊天链路。
 */
export const name = 'agent-client'
export const version = '1.0.0'
export const displayName = '远程代聊通道'
export const description = 'WebUI 代理 · 把浏览器消息转发给后端终端代聊 Worker，并同步轮次状态。'
export const author = '念风内核'
export const icon = '🛰️'
export const core = false
export const scope = 'webui'
export const depends = {
  'backend-client': '>=1.0.0',
  'event-bus': '*',
  'message-service': '^1.0.0',
}
export const optionalDepends = {
  'config': '>=1.1.0',
  'session-service': '>=2.0.0',
  'toast-host': '>=1.0.0',
}
export const inject = ['api', 'event-bus', 'message-service', 'config?', 'session-service?', 'toast?']
export const provides = [{ name: 'agent-client', type: 'singleton' }]

export function apply(ctx) {
  const api = ctx.inject('api')
  const events = ctx.inject('event-bus')
  const messages = ctx.inject('message-service')
  const config = ctx.inject('config?')
  const sessions = ctx.inject('session-service?')
  const toast = ctx.inject('toast?')

  const hasLocalFlow = () => {
    try {
      return !!ctx.registry.get('chat-flow')
    } catch (_) {
      return false
    }
  }

  const pending = new Map() // conversationId -> { clientId, timer, sentAt }
  let seq = 0
  const makeClientId = () => `web-${Date.now().toString(36)}-${(++seq).toString(36)}`

  const finish = (conversationId, reason = 'done') => {
    const id = String(conversationId || '')
    const item = pending.get(id)
    if (!item) return
    if (item.timer) ctx.clearTimeout(item.timer)
    pending.delete(id)
    events.emit('chat:request-done', {
      conversationId: id,
      clientId: item.clientId,
      elapsed: Date.now() - item.sentAt,
      reason,
      remote: true,
    })
  }

  const onSend = payload => {
    if (!payload || hasLocalFlow()) return
    if (payload.confirmHandled || payload.remoteHandled) return
    const conversationId = String(payload.conversationId || '')
    const text = String(payload.text || '')
    const images = Array.isArray(payload.images) ? payload.images : []
    if (!conversationId || (!text.trim() && !images.length)) return

    // WebUI 不执行本地 chat-flow，但仍要在发送瞬间本地回显用户消息：
    // 后端代聊 Worker 收到 agent/send 后还可能先补历史 / 预加载图片，随后才把
    // 用户消息写入聊天记录并回传。若只等后端 SSE，输入框已经变成“停止”，
    // 消息区却会空白一段时间——这正是本条 bug 的根因。
    const normalizedImages = images
      .slice(0, 4)
      .map(image => (typeof image === 'string' ? { url: image } : image || {}))
      .filter(image => image.id || image.url || image.dataUrl)
      .map(image => ({
        id: String(image.id || image.imageId || ''),
        url: image.url || '',
        dataUrl: image.dataUrl || '',
        mime: image.mime || '',
        name: String(image.name || '').slice(0, 80),
      }))
    const localMessage = messages.send(conversationId, text, {
      // optimistic 标记让 session-service 不要把这条件 <260ms 的本地回显直接写回后端；
      // 真正的落库完全由后端代聊 Worker 完成，浏览器只负责按同一 id 合并。
      meta: { ...(normalizedImages.length ? { images: normalizedImages } : {}), optimistic: true },
      // 时间戳分隔线由后端 Worker 落库时统一插入并通过 SSE 回传，本地不插，
      // 否则 Worker 再插一条会冒出两个一样的时间分隔线。
      withDivider: false,
    })
    const localMessageId = String(localMessage?.id || '')
    const failLocal = error => {
      if (!localMessageId) return
      try { messages.fail(conversationId, localMessageId, error) } catch (_) { /* ignore */ }
    }

    const conversation = sessions?.get?.(conversationId) || null
    if (!api?.supports?.('server-agent')) {
      const error = new Error('服务端代聊尚未就绪：请确认后端终端已启动，且没有使用 --no-agent 关闭代聊。')
      failLocal(error)
      toast?.warn?.(error.message)
      events.emit('chat:request-done', { conversationId, elapsed: 0, reason: 'agent-offline', remote: true })
      return
    }

    const clientId = makeClientId()
    const imageIds = normalizedImages
      .map(image => String(image.id || '').trim())
      .filter(Boolean)
      .slice(0, 4)

    const timer = ctx.setTimeout(() => finish(conversationId, 'timeout'), 180000)
    pending.set(conversationId, { clientId, timer, sentAt: Date.now() })

    // 让 composer 立即进入“生成中”状态；真正的轮次结束由后端 agent/status 同步。
    events.emit('chat:request-start', {
      conversationId,
      clientId,
      messageId: localMessageId,
      text: text.slice(0, 160),
      senderName: String(config?.get?.('ui.nickname', '') || '').trim() || '用户',
      channelName: conversation?.name || '',
      channelType: 'nova',
      remote: true,
    })

    api
      .post('/agent/send', {
        conversationId,
        clientId,
        clientMessageId: localMessageId,
        text,
        images: imageIds,
        userId: String(config?.get?.('chat.userId', 'web-user') || 'web-user'),
        userName: String(config?.get?.('ui.nickname', '') || '').trim() || '用户',
      })
      .then(result => {
        if (result?.ok === false) {
          failLocal(new Error(result?.error || '后端代聊拒绝了这条消息'))
          finish(conversationId, 'rejected')
        }
      })
      .catch(err => {
        const error = err instanceof Error ? err : new Error(String(err))
        failLocal(error)
        toast?.error?.(`发送到后端代聊失败：${error.message}`)
        finish(conversationId, 'error')
      })
  }

  const offSend = events.on('message:send', onSend, { owner: 'agent-client', interceptor: true })

  const offBackend = events.on('backend:event', payload => {
    if (payload?.event !== 'agent/status') return
    const data = payload.data || {}
    const conversationId = String(data.conversationId || '')
    if (!conversationId || !pending.has(conversationId)) return
    const clientId = String(data.clientId || '')
    const current = pending.get(conversationId)
    if (clientId && current?.clientId && clientId !== current.clientId) return
    if (data.status === 'done' || data.status === 'error') finish(conversationId, data.status)
  })

  ctx.effect(() => {
    offSend?.()
    offBackend?.()
    for (const item of pending.values()) {
      if (item.timer) ctx.clearTimeout(item.timer)
    }
    pending.clear()
  })

  const service = {
    name: 'agent-client',
    isRunning: conversationId => pending.has(String(conversationId || '')),
    abort(conversationId) {
      const id = String(conversationId || '')
      if (!pending.has(id)) return false
      api?.post?.('/agent/cancel', { conversationId: id, clientId: pending.get(id)?.clientId || '' }).catch(() => {})
      // 后端确认前先让 UI 解锁；worker 稍后返回的 agent/status done 会幂等清理。
      ctx.setTimeout(() => finish(id, 'aborted'), 1500)
      return true
    },
  }
  ctx.provide('agent-client', service, { type: 'singleton' })

  ctx.logger.debug('远程代聊通道就绪（WebUI 业务执行已交给后端终端）')
}
