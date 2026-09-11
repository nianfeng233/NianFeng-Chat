/**
 * S4 · bg-solid
 * 纯色背景：极简纯白，无动画（demo 设置页里的备选背景）。
 */
export const name = 'bg-solid'
export const version = '1.0.0'
export const displayName = '纯色背景'
export const description = '可选中背景 · 极简纯色，无动画。'
export const author = '风语内核'
export const icon = '⬜'
export const core = false
export const depends = { 'bg-provider': '^1.0.0' }
export const inject = ['bg-provider']

import { useStyle } from '../../../src/util/style.mjs'
import { SOLID_CSS } from './style.mjs'

export function apply(ctx) {
  const bg = ctx.inject('bg-provider')
  useStyle(ctx, SOLID_CSS)

  ctx.effect(bg.register('bg-solid', {
    id: 'bg-solid',
    label: '纯色背景',
    description: '干净的纯白背景，无动画，适合偏好极简或需要降低性能开销的场景',
    mount(layer) {
      layer.innerHTML = '<div class="bg-solid-inner"></div>'
      return () => {
        layer.innerHTML = ''
      }
    },
  }, { order: 20, label: '纯色背景', description: '干净的纯白背景，无动画，适合偏好极简或需要降低性能开销的场景' }))

  ctx.logger.debug('纯色背景已注册')
}
