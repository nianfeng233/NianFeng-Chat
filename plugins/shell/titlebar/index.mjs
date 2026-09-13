/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * S5 · titlebar
 * 顶层栏容器：品牌 / 用户 / 窗口按钮三块插槽（V1~V3 分别填充）。
 */
export const name = 'titlebar'
export const version = '1.0.0'
export const displayName = '顶层栏'
export const description = '视觉框架 · 顶层栏容器与三段插槽。'
export const author = '念风内核'
export const icon = '🔝'
export const core = true
export const depends = {
  'app-shell': '^1.0.0',
  'slots': '*',
}
export const optionalDepends = {}
export const inject = ['slots']
export const provides = [{ name: 'titlebar', type: 'singleton' }]

import { useStyle } from '../../../src/util/style.mjs'
import { TITLEBAR_CSS } from './style.mjs'

export function apply(ctx) {
  useStyle(ctx, TITLEBAR_CSS)

  ctx.slots.define('titlebar:left', { description: '品牌区' })
  ctx.slots.define('titlebar:center', { description: '中部自定义区' })
  ctx.slots.define('titlebar:right', { description: '用户区 + 窗口按钮' })

  ctx.slots.register('app:titlebar', container => {
    container.innerHTML = `
      <header class="titlebar">
        <div class="tb-left" data-slot="titlebar:left"></div>
        <div class="tb-center" data-slot="titlebar:center"></div>
        <div class="tb-right" data-slot="titlebar:right"></div>
      </header>`
    return () => {
      container.innerHTML = ''
    }
  })

  ctx.provide('titlebar', { name: 'titlebar' }, { type: 'singleton' })
  ctx.logger.debug('顶层栏就绪')
}
