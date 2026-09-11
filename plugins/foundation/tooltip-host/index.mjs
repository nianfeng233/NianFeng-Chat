/**
 * F10 · tooltip-host
 * 轻量 Tooltip：任何元素带 data-tip="文案" 就会生效，无需手动挂载。
 */
export const name = 'tooltip-host'
export const version = '1.0.0'
export const displayName = 'Tooltip 宿主'
export const description = '基础服务 · data-tip 全局悬浮提示。'
export const author = '风语内核'
export const icon = '🔖'
export const core = false
export const inject = ['event-bus']
export const provides = [{ name: 'tooltip', type: 'singleton' }]

import { useStyle } from '../../../src/util/style.mjs'
import { TOOLTIP_CSS } from './style.mjs'

export function apply(ctx) {
  const el = document.createElement('div')
  el.className = 'wind-tooltip'
  document.body.appendChild(el)
  useStyle(ctx, TOOLTIP_CSS)
  ctx.effect(() => el.remove())

  let hideTimer = null

  const hide = () => {
    el.classList.remove('show')
    clearTimeout(hideTimer)
  }

  const show = (target, text, placement = 'top') => {
    if (!text) return
    el.textContent = text
    el.classList.add('show')
    const rect = target.getBoundingClientRect()
    const tipRect = el.getBoundingClientRect()
    let top = rect.top - tipRect.height - 8
    let left = rect.left + rect.width / 2 - tipRect.width / 2
    if (placement === 'bottom' || top < 6) top = rect.bottom + 8
    left = Math.max(8, Math.min(left, window.innerWidth - tipRect.width - 8))
    el.style.top = `${top}px`
    el.style.left = `${left}px`
  }

  const onOver = e => {
    const target = e.target.closest?.('[data-tip]')
    if (!target) return
    clearTimeout(hideTimer)
    show(target, target.dataset.tip, target.dataset.tipPlacement)
  }
  const onOut = e => {
    if (!e.target.closest?.('[data-tip]')) return
    hideTimer = setTimeout(hide, 80)
  }
  document.addEventListener('mouseover', onOver)
  document.addEventListener('mouseout', onOut)
  document.addEventListener('mousedown', hide, true)
  window.addEventListener('scroll', hide, true)
  ctx.effect(() => {
    document.removeEventListener('mouseover', onOver)
    document.removeEventListener('mouseout', onOut)
    document.removeEventListener('mousedown', hide, true)
    window.removeEventListener('scroll', hide, true)
  })

  ctx.provide('tooltip', { name: 'tooltip', show, hide }, { type: 'singleton' })
  ctx.logger.debug('Tooltip 宿主就绪')
}
