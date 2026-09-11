/**
 * V1 · brand-widget
 * 顶层栏左侧：logo + 名称。
 */
export const name = 'brand-widget'
export const version = '1.0.0'
export const displayName = '品牌标识'
export const description = '顶层栏内容 · logo + 名称。'
export const author = '风语内核'
export const icon = '🌬️'
export const core = true
export const depends = { titlebar: '^1.0.0' }
export const inject = ['slots']
export const order = 10

import { FENGYU_LOGO } from '../../../src/util/identity.mjs'

export function apply(ctx) {
  ctx.slots.register('titlebar:left', container => {
    container.innerHTML = `
      <div class="tb-brand">
        <img class="tb-logo" src="${FENGYU_LOGO}" alt="风语" onerror="this.style.display='none'" />
        <span class="tb-name">风语</span>
      </div>`
    return () => {
      container.innerHTML = ''
    }
  }, { order: 10 })
}
