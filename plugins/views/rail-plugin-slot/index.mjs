/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * V5 · rail-plugin-slot
 * 用户插件图标挂载点（文档 §3 V5）。
 * 自身不画任何东西，只是声明 rail:middle 的语义与容量提示。
 */
export const name = 'rail-plugin-slot'
export const version = '1.0.0'
export const displayName = '插件挂载点'
export const description = '侧边栏内容 · 用户插件图标挂载点（rail:middle）。'
export const author = '念风内核'
export const icon = '🪝'
export const core = true
export const depends = {
  'rail': '^1.0.0',
  'slots': '*',
}
export const optionalDepends = {}
export const inject = ['slots']
export const provides = [{ name: 'rail-plugin-slot', type: 'singleton' }]

export function apply(ctx) {
  ctx.slots.define('rail:middle', {
    description: '用户插件图标挂载点',
    capacity: 5,
  })

  ctx.provide('rail-plugin-slot', {
    name: 'rail-plugin-slot',
    slot: 'rail:middle',
    capacity: 5,
    usage: () => ctx.slots.find('rail:middle')?.entries.length ?? 0,
  }, { type: 'singleton' })
}
