/**
 * S5 · bg-image
 * 可选中背景：使用用户在「外观 → 背景」上传的图片（压缩后保存在本机 config）。
 */
export const name = 'bg-image'
export const version = '1.0.0'
export const displayName = '自定义背景图'
export const description = '可选中背景 · 用户上传的图片，自动压缩后保存在本机。'
export const author = '风语内核'
export const icon = '🖼️'
export const core = false
export const depends = { 'bg-provider': '^1.0.0' }
export const inject = ['bg-provider', 'config']
export const provides = []

import { useStyle } from '../../../src/util/style.mjs'
import { BG_IMAGE_CSS } from './style.mjs'

export function apply(ctx) {
  const bg = ctx.inject('bg-provider')
  const config = ctx.inject('config')

  useStyle(ctx, BG_IMAGE_CSS)

  ctx.effect(
    bg.register(
      'bg-image',
      {
        id: 'bg-image',
        label: '自定义背景图',
        description: '使用「外观 → 自定义背景图片」上传的图片，可随窗口自适应',
        mount(layer) {
          const paint = () => {
            const src = String(config.get('ui.backgroundImage', '') || '')
            layer.innerHTML = src
              ? `<div class="bg-image-inner" style="background-image:url('${src.replace(/['"\\\r\n]/g, '')}')"></div>`
              : '<div class="bg-image-inner"></div>'
          }
          paint()
          const off = ctx.on('config:changed', ({ key }) => {
            if (key === 'ui.backgroundImage') paint()
          })
          return () => {
            off?.()
            layer.innerHTML = ''
          }
        },
      },
      { order: 30, label: '自定义背景图', description: '使用「外观 → 自定义背景图片」上传的图片，可随窗口自适应' },
    ),
  )

  ctx.logger.debug('自定义背景图已注册')
}
