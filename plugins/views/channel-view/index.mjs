/**
 * V12 · channel-view
 * 渠道视图入口：注册 'channel' 视图，提供列表与详情两个插槽。
 */
export const name = 'channel-view'
export const version = '1.0.0'
export const displayName = '渠道视图'
export const description = '视觉内容 · 渠道视图入口。'
export const author = '风语内核'
export const icon = '📡'
export const core = true
export const depends = { 'right-main-panel': '^1.0.0', 'left-list-panel': '^1.0.0', 'view-router': '^1.0.0' }
export const inject = ['slots', 'view-router', 'event-bus']
export const provides = [{ name: 'channel-view', type: 'singleton' }]

import { icons } from '../../../src/util/icons.mjs'
import { useStyle } from '../../../src/util/style.mjs'
import { CHANNEL_VIEW_CSS } from './style.mjs'

export function apply(ctx) {
  const router = ctx.inject('view-router')

  useStyle(ctx, CHANNEL_VIEW_CSS)

  ctx.slots.define('channel:list', { description: '渠道列表' })
  ctx.slots.define('channel:detail', { description: '渠道详情' })

  router.register('channel', {
    label: '渠道',
    icon: icons.channel,
    order: 20,

    list(container) {
      container.innerHTML = `<div class="channel-list-slot" data-slot="channel:list"></div>`
      return () => {
        container.innerHTML = ''
      }
    },

    main(container) {
      container.innerHTML = `<div class="channel-detail-slot" data-slot="channel:detail"></div>`
      return () => {
        container.innerHTML = ''
      }
    },
  })

  ctx.provide('channel-view', { name: 'channel-view' }, { type: 'singleton' })
  ctx.logger.debug('渠道视图就绪')
}
