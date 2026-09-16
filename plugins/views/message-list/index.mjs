/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * V9 · message-list
 * 消息滚动区容器：订阅消息事件，调用当前气泡实现渲染每一行。
 * 自己不认识任何气泡样式，只认识 bubble-styles 服务（文档 §8.3）。
 *
 * 大历史性能：
 *   - 首屏只渲染最近 windowInitial 条，而不是 conv.messages 全量 innerHTML；
 *   - 滚动到顶部 / 底部附近时，按 windowStep 分批把更早 / 更新的消息补进 DOM；
 *   - DOM 中始终最多保留 windowMax 行，流式 chunk 只替换单行，不重绘整个会话。
 */
export const name = 'message-list'
export const version = '1.1.0'
export const displayName = '消息列表'
export const description = '视觉内容 · 消息滚动区容器、大历史窗口化与渲染调度。'
export const author = '念风内核'
export const icon = '📜'
export const core = true
export const depends = {
  'chat-view': '^1.0.0',
  'config': '>=1.1.0',
  'context-menu-host': '>=1.0.0',
  'event-bus': '*',
  'message-service': '^1.0.0',
  'service-container': '*',
  'session-service': '>=2.0.0',
  'slots': '*',
  'toast-host': '>=1.0.0',
}
export const optionalDepends = {
  'modal-host': '>=1.0.0',
}
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

    const readInt = (value, fallback, min, max) => {
      const num = Number(value)
      if (!Number.isFinite(num)) return fallback
      return Math.max(min, Math.min(max, Math.round(num)))
    }
    // 只限制 DOM 行数，消息数据仍完整保留在 conv.messages 中：
    // 首屏 windowInitial 条，滚动触发后每次 windowStep 条，DOM 上限 windowMax 条。
    const windowInitial = readInt(config.get('chat.messageWindowInitial', 80), 80, 20, 500)
    const windowStep = readInt(config.get('chat.messageWindowStep', 80), 80, 20, 500)
    const windowMax = Math.max(windowInitial, readInt(config.get('chat.messageWindowMax', 300), 300, windowInitial, 2000))

    let destroyed = false
    let renderFrame = 0
    let scrollFrame = 0
    let patchFrame = 0
    let pendingPatches = new Map()
    let pendingRenderOptions = null
    let windowStart = 0
    let windowEnd = 0
    let messageTotal = 0
    let boundConversationId = null
    let boundMessagesRef = null
    // round-end 集合按“当前消息数组 + 长度”缓存：流式 chunk 高频更新时不重复扫描历史。
    let roundEndCache = { source: null, length: -1, ids: new Set() }

    const currentRenderer = () => ctx.registry.get('bubble-styles')?.getActive?.()

    const getRoundEndIds = conv => {
      const list = Array.isArray(conv?.messages) ? conv.messages : []
      if (roundEndCache.source === list && roundEndCache.length === list.length) return roundEndCache.ids
      const ids = new Set()
      let previous = null
      for (const message of list) {
        if (!message || message.kind === 'divider' || message.role === 'system') continue
        if (previous && message.role === 'user') ids.add(previous.id)
        previous = message
      }
      if (previous?.id) ids.add(previous.id)
      roundEndCache = { source: list, length: list.length, ids }
      return ids
    }

    const renderRowHtml = (message, conv, view, renderer) => {
      if (message.kind === 'divider') return dividerHtml(message)
      if (renderer?.renderRow) {
        try {
          return renderer.renderRow(message, conv, view)
        } catch (err) {
          ctx.logger.error('气泡渲染失败', err)
          return fallbackRow(message, conv, config)
        }
      }
      return fallbackRow(message, conv, config)
    }

    const buildRowsHtml = (messages, conv, renderer) => {
      const roundEndIds = getRoundEndIds(conv)
      const view = {
        ctx,
        isRoundEnd: value => roundEndIds.has(typeof value === 'string' ? value : value?.id),
        roundEndIds,
      }
      return (messages || []).map(message => renderRowHtml(message, conv, view, renderer)).join('')
    }

    const appendHtml = html => {
      if (!html) return
      const holder = document.createElement('div')
      holder.innerHTML = html
      while (holder.firstChild) scrollEl.appendChild(holder.firstChild)
    }

    const prependHtml = html => {
      if (!html) return
      const holder = document.createElement('div')
      holder.innerHTML = html
      const ref = scrollEl.firstChild
      while (holder.firstChild) scrollEl.insertBefore(holder.firstChild, ref)
    }

    const replaceRowHtml = (row, html) => {
      const holder = document.createElement('div')
      holder.innerHTML = html
      const next = holder.firstElementChild
      if (!next || !row.parentNode) return false
      row.parentNode.insertBefore(next, row)
      row.remove()
      return true
    }

    const findMessageRow = messageId => {
      if (!messageId) return null
      for (const el of scrollEl.children) {
        if (el.dataset && el.dataset.messageId === messageId) return el
      }
      return null
    }

    const findDivider = at => {
      const key = String(at)
      for (const el of scrollEl.querySelectorAll('.time-divider')) {
        if (el.dataset && el.dataset.dividerAt === key) return el
      }
      return null
    }

    const lastElement = () => {
      const children = scrollEl.children
      return children.length ? children[children.length - 1] : null
    }

    const captureAnchor = () => {
      const base = scrollEl.getBoundingClientRect()
      for (const el of scrollEl.children) {
        const rect = el.getBoundingClientRect()
        if (rect.bottom > base.top + 1) {
          return {
            messageId: (el.dataset && el.dataset.messageId) || '',
            dividerAt: (el.dataset && el.dataset.dividerAt) || '',
            top: rect.top,
            scrollTop: scrollEl.scrollTop,
            scrollHeight: scrollEl.scrollHeight,
          }
        }
      }
      return { messageId: '', dividerAt: '', top: 0, scrollTop: scrollEl.scrollTop, scrollHeight: scrollEl.scrollHeight }
    }

    const restoreAnchor = anchor => {
      if (!anchor) return
      const target =
        (anchor.messageId && findMessageRow(anchor.messageId)) ||
        (anchor.dividerAt && findDivider(anchor.dividerAt)) ||
        null
      if (target) {
        scrollEl.scrollTop = Math.max(0, scrollEl.scrollTop + (target.getBoundingClientRect().top - anchor.top))
      } else {
        scrollEl.scrollTop = Math.max(0, anchor.scrollTop + (scrollEl.scrollHeight - anchor.scrollHeight))
      }
    }

    const trimTopOverflow = () => {
      let overflow = (windowEnd - windowStart) - windowMax
      while (overflow > 0 && scrollEl.firstElementChild) {
        scrollEl.removeChild(scrollEl.firstElementChild)
        windowStart += 1
        overflow -= 1
      }
    }

    const trimBottomOverflow = () => {
      let overflow = (windowEnd - windowStart) - windowMax
      while (overflow > 0 && lastElement()) {
        scrollEl.removeChild(lastElement())
        windowEnd -= 1
        overflow -= 1
      }
    }

    const emitRendered = conv => {
      if (!conv) return
      events.emit('message-list:rendered', {
        conversationId: conv.id,
        count: messageTotal,
        rendered: Math.max(0, windowEnd - windowStart),
        windowStart,
        windowEnd,
      })
    }

    const renderWindow = ({ anchor = null, stickBottom = false } = {}) => {
      if (destroyed) return
      const conv = sessions.active()
      if (!conv || conv.id !== boundConversationId) {
        scrollEl.innerHTML = ''
        if (conv) emitRendered(conv)
        return
      }
      messageTotal = Array.isArray(conv.messages) ? conv.messages.length : 0
      if (!messageTotal) {
        windowStart = 0
        windowEnd = 0
        scrollEl.innerHTML = ''
        emitRendered(conv)
        return
      }
      windowStart = Math.max(0, Math.min(windowStart, messageTotal - 1))
      windowEnd = Math.max(windowStart + 1, Math.min(windowEnd || messageTotal, messageTotal))
      if (windowEnd > messageTotal) {
        windowEnd = messageTotal
        windowStart = Math.max(0, Math.min(windowStart, windowEnd - 1))
      }
      if (!anchor && !stickBottom) anchor = captureAnchor()
      scrollEl.innerHTML = buildRowsHtml(conv.messages.slice(windowStart, windowEnd), conv, currentRenderer())
      if (stickBottom) scrollEl.scrollTop = scrollEl.scrollHeight
      else restoreAnchor(anchor)
      emitRendered(conv)
    }

    const scheduleRender = (options = {}) => {
      if (destroyed) return
      pendingRenderOptions = { ...(pendingRenderOptions || {}), ...options }
      if (renderFrame) return
      renderFrame = requestAnimationFrame(() => {
        renderFrame = 0
        if (destroyed) return
        const optionsNow = pendingRenderOptions || {}
        pendingRenderOptions = null
        const conv = sessions.active()
        if (!conv) {
          boundConversationId = null
          boundMessagesRef = null
          messageTotal = 0
          windowStart = 0
          windowEnd = 0
          roundEndCache = { source: null, length: -1, ids: new Set() }
          scrollEl.innerHTML = ''
          return
        }
        const replaced = conv.id !== boundConversationId || conv.messages !== boundMessagesRef
        messageTotal = Array.isArray(conv.messages) ? conv.messages.length : 0
        if (replaced || optionsNow.reset || optionsNow.tail) {
          if (replaced) {
            pendingPatches.clear()
            if (patchFrame) {
              cancelAnimationFrame(patchFrame)
              patchFrame = 0
            }
            boundConversationId = conv.id
            boundMessagesRef = conv.messages
            roundEndCache = { source: null, length: -1, ids: new Set() }
          }
          const anchor = optionsNow.stickBottom ? null : optionsNow.anchor || captureAnchor()
          // 后台代聊 / 同步替换 messages 时，用户可能正在翻旧记录：
          // 尽量把窗口移到原锚点附近，避免被新消息强行拉回底部。
          if (optionsNow.keepAnchor && anchor?.messageId && messageTotal) {
            const index = conv.messages.findIndex(item => item.id === anchor.messageId)
            if (index >= 0) {
              windowStart = Math.max(0, Math.min(index, Math.max(0, messageTotal - windowInitial)))
              windowEnd = Math.min(messageTotal, windowStart + windowInitial)
              renderWindow({ anchor, stickBottom: false })
              return
            }
          }
          windowStart = Math.max(0, messageTotal - windowInitial)
          windowEnd = messageTotal
          renderWindow({ stickBottom: optionsNow.stickBottom !== false })
          return
        }
        windowStart = Math.max(0, Math.min(windowStart, Math.max(0, messageTotal - 1)))
        windowEnd = Math.max(windowStart, Math.min(windowEnd, messageTotal))
        if (messageTotal > 0 && windowEnd === windowStart) windowEnd = Math.min(messageTotal, windowStart + 1)
        renderWindow({
          anchor: optionsNow.stickBottom ? null : captureAnchor(),
          stickBottom: !!optionsNow.stickBottom,
        })
      })
    }

    const loadOlderChunk = conv => {
      if (windowStart <= 0) return
      const start = Math.max(0, windowStart - windowStep)
      if (start >= windowStart) return
      const beforeHeight = scrollEl.scrollHeight
      prependHtml(buildRowsHtml(conv.messages.slice(start, windowStart), conv, currentRenderer()))
      windowStart = start
      scrollEl.scrollTop = Math.max(0, scrollEl.scrollTop + (scrollEl.scrollHeight - beforeHeight))
      trimBottomOverflow()
      emitRendered(conv)
    }

    const loadNewerChunk = conv => {
      if (windowEnd >= messageTotal) return
      const end = Math.min(messageTotal, windowEnd + windowStep)
      if (end <= windowEnd) return
      appendHtml(buildRowsHtml(conv.messages.slice(windowEnd, end), conv, currentRenderer()))
      windowEnd = end
      trimTopOverflow()
      scrollEl.scrollTop = scrollEl.scrollHeight
      emitRendered(conv)
    }

    const handleScroll = () => {
      if (destroyed) return
      const conv = sessions.active()
      if (!conv || conv.id !== boundConversationId) return
      messageTotal = Array.isArray(conv.messages) ? conv.messages.length : 0
      // 用户翻到当前 DOM 顶部：把更早的一段补进 DOM。
      if (scrollEl.scrollTop <= 80 && windowStart > 0) {
        loadOlderChunk(conv)
        return
      }
      // 用户回到当前 DOM 底部但后面还有未渲染的新消息：继续向后补。
      const nearBottom = scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight < 120
      if (nearBottom && windowEnd < messageTotal) loadNewerChunk(conv)
    }

    const onScroll = () => {
      if (destroyed || scrollFrame) return
      scrollFrame = requestAnimationFrame(() => {
        scrollFrame = 0
        handleScroll()
      })
    }

    scrollEl.addEventListener('scroll', onScroll, { passive: true })

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

    /* -------- 消息增量更新：流式 chunk 不整表重绘 -------- */
    const onMessageAdded = payload => {
      const conversationId = payload?.conversationId
      if (!conversationId || conversationId !== boundConversationId) return
      const conv = sessions.active()
      if (!conv) return
      if (conv.messages !== boundMessagesRef) {
        scheduleRender({ reset: true, stickBottom: true })
        return
      }
      messageTotal = Array.isArray(conv.messages) ? conv.messages.length : 0
      if (messageTotal <= windowEnd) return
      // 用户正在翻旧记录时不强行拉到底部；等用户滑回底部时再按块补上。
      const nearBottom = scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight < 120
      if (!nearBottom) return
      appendHtml(buildRowsHtml(conv.messages.slice(windowEnd, messageTotal), conv, currentRenderer()))
      windowEnd = messageTotal
      trimTopOverflow()
      scrollEl.scrollTop = scrollEl.scrollHeight
      emitRendered(conv)
    }

    /** 同一帧内多个 message:chunk / updated 只重绘一次对应行，避免流式高频 layout。 */
    const flushRowPatches = () => {
      patchFrame = 0
      if (destroyed || !pendingPatches.size) return
      const conv = sessions.active()
      if (!conv || conv.id !== boundConversationId) {
        pendingPatches.clear()
        return
      }
      const renderer = currentRenderer()
      const roundEndIds = getRoundEndIds(conv)
      const view = {
        ctx,
        isRoundEnd: value => roundEndIds.has(typeof value === 'string' ? value : value?.id),
        roundEndIds,
      }
      let touched = false
      for (const [messageId, fallbackMessage] of pendingPatches) {
        const row = findMessageRow(messageId)
        if (!row) continue
        const message = fallbackMessage || sessions.message(conv.id, messageId)
        if (!message) continue
        if (replaceRowHtml(row, renderRowHtml(message, conv, view, renderer))) touched = true
      }
      pendingPatches.clear()
      if (touched && scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight < 120) {
        scrollEl.scrollTop = scrollEl.scrollHeight
      }
    }

    const patchMessageRow = payload => {
      const conversationId = payload?.conversationId
      if (!conversationId || conversationId !== boundConversationId) return
      const messageId = payload?.id || payload?.message?.id
      if (!messageId) return
      pendingPatches.set(messageId, payload.message || null)
      if (patchFrame) return
      patchFrame = requestAnimationFrame(flushRowPatches)
    }

    const offs = [
      events.on('conversation:switch', () => scheduleRender({ reset: true, stickBottom: true })),
      events.on('conversation:update', payload => {
        const id = payload?.id || payload?.conversation?.id
        if (!id || id !== sessions.activeId()) return
        const conv = sessions.active()
        if (!conv) {
          scheduleRender({ reset: true })
          return
        }
        if (conv.messages !== boundMessagesRef) {
          const nearBottom = scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight < 120
          scheduleRender({
            reset: true,
            keepAnchor: !nearBottom,
            anchor: nearBottom ? null : captureAnchor(),
            stickBottom: nearBottom,
          })
          return
        }
        const total = Array.isArray(conv.messages) ? conv.messages.length : 0
        if (total !== messageTotal && total < windowEnd) scheduleRender({ anchor: captureAnchor() })
      }),
      events.on('message:added', onMessageAdded),
      events.on('message:chunk', patchMessageRow),
      events.on('message:done', patchMessageRow),
      events.on('message:updated', patchMessageRow),
      events.on('message:error', patchMessageRow),
      events.on('message:delete', payload => {
        if (payload?.conversationId !== boundConversationId) return
        scheduleRender({ anchor: captureAnchor() })
      }),
      events.on('bubble-styles:changed', () => scheduleRender({ stickBottom: false })),
      events.on('bubble-styles:registered', () => scheduleRender({ stickBottom: false })),
      /* 用户更换头像后，消息里的“我”立即跟随统一头像源刷新 */
      ctx.on('config:changed', payload => {
        if (payload?.key === USER_AVATAR_KEY || payload?.key === '*') scheduleRender({ stickBottom: false })
      }),
    ]

    scheduleRender({ reset: true, stickBottom: true })

    return () => {
      destroyed = true
      offs.forEach(off => off())
      clearInterval(dividerTimer)
      pendingPatches.clear()
      if (renderFrame) cancelAnimationFrame(renderFrame)
      if (scrollFrame) cancelAnimationFrame(scrollFrame)
      if (patchFrame) cancelAnimationFrame(patchFrame)
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility)
      if (typeof window !== 'undefined') window.removeEventListener('focus', onVisibility)
      scrollEl.removeEventListener('scroll', onScroll)
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
