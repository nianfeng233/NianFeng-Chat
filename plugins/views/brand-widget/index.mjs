/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * V1 · brand-widget
 * 顶层栏左侧：logo + 名称。
 */
export const name = 'brand-widget'
export const version = '1.0.0'
export const displayName = '品牌标识'
export const description = '顶层栏内容 · logo + 名称。'
export const author = '念风内核'
export const icon = '🌬️'
export const core = true
export const depends = {
  'slots': '*',
  'titlebar': '^1.0.0',
}
export const optionalDepends = {}
export const inject = ['slots']
export const order = 10

import { BRAND_LOGO } from '../../../src/util/identity.mjs'

export function apply(ctx) {
  ctx.slots.register('titlebar:left', container => {
    container.innerHTML = `
      <div class="tb-brand">
        <img class="tb-logo" src="${BRAND_LOGO}" alt="念风chat" onerror="this.style.display='none'" />
        <span class="tb-name">念风chat</span>
      </div>`
    return () => {
      container.innerHTML = ''
    }
  }, { order: 10 })
}
