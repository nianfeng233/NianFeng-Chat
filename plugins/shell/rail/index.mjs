/**
 * S6 · rail
 * 侧边栏容器：上 / 中 / 下三段插槽。
 * 上段由 V4 rail-nav-buttons 填视图切换按钮，中段留给用户插件（V5），
 * 下段放设置按钮。
 */
export const name = 'rail'
export const version = '1.0.0'
export const displayName = '侧边栏'
export const description = '视觉框架 · 侧边栏容器与三段插槽。'
export const author = '风语内核'
export const icon = '📎'
export const core = true
export const depends = { 'app-shell': '^1.0.0' }
export const inject = ['slots']
export const provides = [{ name: 'rail', type: 'singleton' }]

import { useStyle } from '../../../src/util/style.mjs'
import { RAIL_CSS } from './style.mjs'

export function apply(ctx) {
  useStyle(ctx, RAIL_CSS)

  ctx.slots.define('rail:top', { description: '内置视图入口' })
  ctx.slots.define('rail:middle', { description: '用户插件图标区' })
  ctx.slots.define('rail:bottom', { description: '设置等常用入口' })

  ctx.slots.register('app:rail', container => {
    container.innerHTML = `
      <aside class="rail">
        <div class="rail-top" data-slot="rail:top"></div>
        <div class="rail-middle" data-slot="rail:middle"></div>
        <div class="rail-bottom" data-slot="rail:bottom"></div>
      </aside>`
    return () => {
      container.innerHTML = ''
    }
  })

  ctx.provide('rail', { name: 'rail' }, { type: 'singleton' })
  ctx.logger.debug('侧边栏就绪')
}
