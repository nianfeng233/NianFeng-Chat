/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * V9 · message-list
 * 消息滚动区容器：订阅消息事件，调用当前气泡实现渲染每一行。
 * 自己不认识任何气泡样式，只认识 bubble-styles 服务（文档 §8.3）。
 */
export const name = 'message-list'
export const version = '1.0.0'
export const displayName = '消息列表'
export const description = '视觉内容 · 消息滚动区容器与渲染调度。'
export const author = '念风内核'
export const icon = '📜'
export const core = true
export const depends = { 'chat-view': '^1.0.0', 'message-service': '^1.0.0' }
export const inject = ['slots', 'session-service', 'message-service', 'service-container', 'event-bus', 'context-menu', 'modal?', 'toast', 'config']
export const provides = [
  { name: 'message-list', type: 'singleton' },
  { name: 'bubble-styles', type: 'selectable' },
]

import { useStyle } from '../../../src/util/style.mjs'
import { MESSAGE_LIST_CSS } from './style.mjs'
import { escapeHtml } from '../../../src/util/format.mjs'
import { formatChatTimestamp, resolveMessageTimestamp, toDate } from '../../../src/util/time-format.mjs'
import { characterAvatarHtml, userAvatarHtml, USER_AVATAR_KEY } from '../../../src/util/identity.mjs'

export function apply(ctx) {
  const sessions = ctx.inject('session-service')
  const events = ctx.inject('event-bus')
  const menu = ctx.inject('context-menu')
  const modal = ctx.inject('modal?')
  const toast = ctx.inject('toast')
  const config = ctx.inject('config')

  // 气泡样式：可选中型服务。V10 / X1 / X2 都在这里注册实现。
  const bubbles = ctx.inject('service-container').createSelectable('bubble-styles', {
    displayName: '气泡样式',
    fallback: 'bubble-default',
  })
  ctx.provide('bubble-styles', bubbles, { type: 'selectable' })

  useStyle(ctx, MESSAGE_LIST_CSS)

  /** 时间戳分隔线：持久化的是绝对时间，展示文本按“今天 / 昨天 / 星期几 / 日期”动态计算 */
  const dividerHtml = message => {
    const date = toDate(resolveMessageTimestamp(message))
    const text = (date && formatChatTimestamp(date)) || message.content || ''
    return `<div class="time-divider"${date ? ` data-divider-at="${date.getTime()}"` : ''}>${escapeHtml(text)}</div>`
  }

  ctx.slots.register('chat:messages', container => {
    container.innerHTML = `<div class="msg-scroll" id="msgScroll"></div>`
    const scrollEl = container.querySelector('#msgScroll')

    let pending = false

    const renderNow = () => {
      pending = false
      const conv = sessions.active()
      if (!conv) {
        scrollEl.innerHTML = ''
        return
      }
      const bubbles = ctx.registry.get('bubble-styles')
      const renderer = bubbles?.getActive?.()
      const wasNearBottom = scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight < 120

      scrollEl.innerHTML = conv.messages
        .map(msg => {
          if (msg.kind === 'divider') return dividerHtml(msg)
          if (renderer?.renderRow) {
            try {
              return renderer.renderRow(msg, conv, { ctx })
            } catch (err) {
              ctx.logger.error('气泡渲染失败', err)
              return fallbackRow(msg, conv, config)
            }
          }
          return fallbackRow(msg, conv, config)
        })
        .join('')

      if (wasNearBottom) scrollEl.scrollTop = scrollEl.scrollHeight
      events.emit('message-list:rendered', { conversationId: conv.id, count: conv.messages.length })
    }

    const render = () => {
      if (pending) return
      pending = true
      requestAnimationFrame(renderNow)
    }

    /** 时间变化后（尤其是跨天）刷新所有时间戳文案，无需整表重绘 */
    const refreshDividers = () => {
      if (!scrollEl.isConnected) return
      const now = new Date()
      for (const el of scrollEl.querySelectorAll('[data-divider-at]')) {
        const at = Number(el.dataset.dividerAt)
        if (!Number.isFinite(at)) continue
        el.textContent = formatChatTimestamp(at, now)
      }
    }
    const dividerTimer = setInterval(refreshDividers, 15000)
    const onVisibility = () => {
      if (typeof document === 'undefined' || !document.hidden) refreshDividers()
    }
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility)
    if (typeof window !== 'undefined') window.addEventListener('focus', onVisibility)

    /* -------- 右键菜单：复制 / 删除 -------- */
    const onContextMenu = e => {
      const row = e.target.closest('.msg-row')
      if (!row) return
      e.preventDefault()
      const messageId = row.dataset.messageId
      const conv = sessions.active()
      const message = conv && sessions.message(conv.id, messageId)
      if (!message) return
      menu.open(e.clientX, e.clientY, [
        { label: '复制内容', action: () => copy(message.content) },
        { separator: true },
        { label: '删除这条消息', danger: true, action: async () => {
          const confirmed = modal ? (await modal.confirm('删除这条消息', '删除后不会进入模型上下文，且不可恢复。')).ok : true
          if (!confirmed) return
          ctx.inject('message-service').remove(conv.id, messageId)
        } },
      ], { target: message })
    }
    scrollEl.addEventListener('contextmenu', onContextMenu)

    const offs = [
      events.on('conversation:switch', render),
      events.on('conversation:update', payload => {
        const id = payload?.id || payload?.conversation?.id
        if (!id || id === sessions.activeId()) render()
      }),
      events.on('message:added', render),
      events.on('message:chunk', render),
      events.on('message:done', render),
      events.on('message:updated', render),
      events.on('message:error', render),
      events.on('message:delete', render),
      events.on('bubble-styles:changed', render),
      events.on('bubble-styles:registered', render),
      /* 用户更换头像后，消息里的“我”立即跟随统一头像源刷新 */
      ctx.on('config:changed', payload => {
        if (payload?.key === USER_AVATAR_KEY || payload?.key === '*') render()
      }),
    ]

    render()

    return () => {
      offs.forEach(off => off())
      clearInterval(dividerTimer)
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility)
      if (typeof window !== 'undefined') window.removeEventListener('focus', onVisibility)
      scrollEl.removeEventListener('contextmenu', onContextMenu)
      container.innerHTML = ''
    }
  })

  function copy(text) {
    navigator.clipboard?.writeText(String(text ?? '')).then(
      () => toast.success('已复制到剪贴板'),
      () => toast.warn('复制失败，请手动选择文本'),
    )
  }

  ctx.provide('message-list', { name: 'message-list' }, { type: 'singleton' })
}

/** 没有气泡样式可用时的兜底渲染（也应保证不崩） */
function fallbackRow(message, conv, config) {
  const isMe = message.role === 'user'
  // 用户头像统一走 identity（默认念风 logo，可在 user-widget 更换）；
  // 角色头像统一走 characterAvatarHtml（自定义图片 / 首字色块）。
  const avatar = isMe ? userAvatarHtml(config) : characterAvatarHtml(conv)
  return `<div class="msg-row ${isMe ? 'right' : ''}" data-message-id="${message.id}">${avatar}
    <div class="bubble"><span class="bubble-text">${escapeHtml(message.content)}</span></div></div>`
}
