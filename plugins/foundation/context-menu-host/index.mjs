/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * F8 · context-menu-host
 * 右键菜单宿主：渠道分组右键、消息右键等场景共用。
 */
export const name = 'context-menu-host'
export const version = '1.0.0'
export const displayName = '右键菜单宿主'
export const description = '基础服务 · 统一的右键上下文菜单。'
export const author = '念风内核'
export const icon = '🖱️'
export const core = true
export const depends = {
  'event-bus': '*',
}
export const optionalDepends = {}
export const inject = ['event-bus']
export const provides = [{ name: 'context-menu', type: 'singleton' }]

import { useStyle } from '../../../src/util/style.mjs'
import { CONTEXT_MENU_CSS } from './style.mjs'

const escapeHtml = value =>
  String(value ?? '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[m])

export function apply(ctx) {
  const el = document.createElement('div')
  el.className = 'context-menu'
  document.body.appendChild(el)
  useStyle(ctx, CONTEXT_MENU_CSS)
  ctx.effect(() => el.remove())

  let openItems = []
  let target = null

  const close = () => {
    el.classList.remove('show')
    openItems = []
    target = null
  }

  /* ---------------- 移动端长按 = 右键 ---------------- */
  const isTouchLayout = () =>
    document.documentElement?.dataset?.mobileLayout === '1' ||
    (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches)
  let pressTimer = null
  let pressPoint = null
  let suppressClickUntil = 0

  const cancelPress = () => {
    if (pressTimer) clearTimeout(pressTimer)
    pressTimer = null
    pressPoint = null
  }
  const onTouchStart = event => {
    if (!isTouchLayout()) return
    if (!event.touches || event.touches.length !== 1) return
    const touch = event.touches[0]
    pressPoint = { x: touch.clientX, y: touch.clientY }
    if (pressTimer) clearTimeout(pressTimer)
    pressTimer = setTimeout(() => {
      pressTimer = null
      const x = pressPoint?.x
      const y = pressPoint?.y
      pressPoint = null
      if (x === undefined || y === undefined || typeof document.elementFromPoint !== 'function') return
      const element = document.elementFromPoint(x, y)
      if (!element) return
      suppressClickUntil = Date.now() + 700
      const init = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 2, buttons: 2 }
      const synthetic = typeof MouseEvent === 'function' ? new MouseEvent('contextmenu', init) : Object.assign(new Event('contextmenu', init), init)
      element.dispatchEvent(synthetic)
    }, 520)
  }
  const onTouchMove = event => {
    if (!pressTimer || !pressPoint || !event.touches || event.touches.length !== 1) return
    const touch = event.touches[0]
    if (Math.hypot(touch.clientX - pressPoint.x, touch.clientY - pressPoint.y) > 10) cancelPress()
  }
  const onTouchEnd = () => {
    if (pressTimer) cancelPress()
  }
  const onCaptureClick = event => {
    if (Date.now() >= suppressClickUntil) return
    event.preventDefault?.()
    event.stopPropagation?.()
  }
  document.addEventListener('touchstart', onTouchStart, { passive: true })
  document.addEventListener('touchmove', onTouchMove, { passive: true })
  document.addEventListener('touchend', onTouchEnd, { passive: true })
  document.addEventListener('touchcancel', onTouchEnd, { passive: true })
  document.addEventListener('click', onCaptureClick, true)
  ctx.effect(() => {
    document.removeEventListener('touchstart', onTouchStart)
    document.removeEventListener('touchmove', onTouchMove)
    document.removeEventListener('touchend', onTouchEnd)
    document.removeEventListener('touchcancel', onTouchEnd)
    document.removeEventListener('click', onCaptureClick, true)
  })

  const activate = item => {
    if (!item || item.classList.contains('disabled')) return
    const index = Number(item.dataset.index)
    const entry = openItems[index]
    close()
    if (entry?.action) {
      try {
        entry.action(target)
      } catch (err) {
        ctx.logger.error('右键菜单动作失败', err)
      }
    }
  }

  el.addEventListener('click', e => {
    activate(e.target.closest('.menu-item'))
  })

  const onDocDown = e => {
    if (!el.classList.contains('show')) return
    if (el.contains(e.target)) return
    close()
  }
  const onKey = e => {
    if (e.key === 'Escape') close()
  }
  document.addEventListener('mousedown', onDocDown)
  document.addEventListener('keydown', onKey)
  window.addEventListener('resize', close)
  window.addEventListener('blur', close)
  ctx.effect(() => {
    document.removeEventListener('mousedown', onDocDown)
    document.removeEventListener('keydown', onKey)
    window.removeEventListener('resize', close)
    window.removeEventListener('blur', close)
  })

  const service = {
    name: 'context-menu',
    isOpen: () => el.classList.contains('show'),
    close,
    /** items: [{ label, action, disabled, danger, icon } | { separator: true }] */
    open(x, y, items = [], options = {}) {
      openItems = items
      target = options.target ?? null
      el.innerHTML = items
        .map((item, index) => {
          if (item.separator) return `<div class="menu-sep"></div>`
          if (item.header) return `<div class="menu-group">${escapeHtml(item.header)}</div>`
          const cls = ['menu-item', item.disabled ? 'disabled' : '', item.danger ? 'danger' : ''].filter(Boolean).join(' ')
          const ico = item.icon ? `<span class="menu-ico">${item.icon}</span>` : ''
          return `<div class="${cls}" data-index="${index}">${ico}${escapeHtml(item.label ?? '')}</div>`
        })
        .join('')
      el.classList.add('show')
      // 直接绑定菜单项：既能在 Node DOM 垫片（无冒泡）下工作，
      // 在真实浏览器里也用 stopPropagation 避免与容器委托重复触发。
      el.querySelectorAll('.menu-item').forEach(itemEl => {
        itemEl.addEventListener('click', event => {
          event.stopPropagation()
          activate(itemEl)
        })
      })

      const rect = el.getBoundingClientRect()
      const maxX = window.innerWidth - rect.width - 8
      const maxY = window.innerHeight - rect.height - 8
      el.style.left = `${Math.max(6, Math.min(x, maxX))}px`
      el.style.top = `${Math.max(6, Math.min(y, maxY))}px`
    },
  }

  ctx.provide('context-menu', service, { type: 'singleton' })
  ctx.logger.debug('右键菜单宿主就绪')
}
