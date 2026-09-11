/**
 * F9 · toast-host
 * 轻提示宿主。demo 里用 alert 的地方，在插件架构里统一改成 toast。
 */
export const name = 'toast-host'
export const version = '1.0.0'
export const displayName = '轻提示宿主'
export const description = '基础服务 · 右下角浮动提示（info / success / warn / error）。'
export const author = '风语内核'
export const icon = '💬'
export const core = true
export const inject = ['event-bus']
export const provides = [{ name: 'toast', type: 'singleton' }]

import { useStyle } from '../../../src/util/style.mjs'
import { TOAST_CSS } from './style.mjs'

export function apply(ctx) {
  const wrap = document.createElement('div')
  wrap.className = 'toast-wrap'
  document.body.appendChild(wrap)
  useStyle(ctx, TOAST_CSS)
  ctx.effect(() => wrap.remove())

  const service = {
    name: 'toast',
    show(message, options = {}) {
      const { type = 'info', duration = 2600, icon = '', action } = options
      const el = document.createElement('div')
      el.className = `toast toast-${type}`
      el.innerHTML = `
        <div class="toast-main">
          ${icon ? `<span class="toast-ico">${icon}</span>` : ''}
          <span class="toast-text"></span>
        </div>
        ${action ? `<button class="toast-action"></button>` : ''}`
      el.querySelector('.toast-text').textContent = String(message)
      if (action) {
        const btn = el.querySelector('.toast-action')
        btn.textContent = action.label || '查看'
        btn.addEventListener('click', () => {
          action.onClick?.()
          remove()
        })
      }
      wrap.appendChild(el)
      requestAnimationFrame(() => el.classList.add('show'))

      let timer = null
      const remove = () => {
        if (!el.isConnected) return
        clearTimeout(timer)
        el.classList.remove('show')
        setTimeout(() => el.remove(), 220)
      }
      if (duration > 0) timer = setTimeout(remove, duration)
      el.addEventListener('click', e => {
        if (e.target.closest('.toast-action')) return
        remove()
      })
      ctx.emit('toast:shown', { message, type })
      return remove
    },
    info: (m, o) => service.show(m, { ...o, type: 'info' }),
    success: (m, o) => service.show(m, { ...o, type: 'success' }),
    warn: (m, o) => service.show(m, { ...o, type: 'warn' }),
    error: (m, o) => service.show(m, { ...o, type: 'error', duration: 4200 }),
    clear: () => (wrap.innerHTML = ''),
  }

  ctx.provide('toast', service, { type: 'singleton' })
  ctx.logger.debug('轻提示宿主就绪')
}
