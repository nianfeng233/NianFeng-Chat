/**
 * S3 · bg-aurora
 * 绿雾背景：白底 + 8 个漂浮膨胀收缩的浅绿光团（demo 的默认背景）。
 */
export const name = 'bg-aurora'
export const version = '1.0.0'
export const displayName = '绿雾背景'
export const description = '可选中背景 · 漂浮渐变光团 · 呼吸式动态效果。'
export const author = '风语内核'
export const icon = '🫧'
export const core = false
export const depends = { 'bg-provider': '^1.0.0' }
export const inject = ['bg-provider']

import { useStyle } from '../../../src/util/style.mjs'
import { AURORA_CSS } from './style.mjs'

const BLOBS = 8

export function apply(ctx) {
  const bg = ctx.inject('bg-provider')
  useStyle(ctx, AURORA_CSS)

  ctx.effect(bg.register('bg-aurora', {
    id: 'bg-aurora',
    label: '绿雾背景',
    description: '缓慢漂浮的渐变光团，带轻微呼吸动画，是风语的默认背景',
    mount(layer) {
      layer.innerHTML = `<div class="bg-aurora" aria-hidden="true">${Array.from(
        { length: BLOBS },
        (_, i) => `<span class="blob b${i + 1}"></span>`,
      ).join('')}</div>`
      return () => {
        layer.innerHTML = ''
      }
    },
  }, { order: 10, label: '绿雾背景', description: '缓慢漂浮的渐变光团，带轻微呼吸动画，是风语的默认背景' }))

  ctx.logger.debug('绿雾背景已注册')
}
