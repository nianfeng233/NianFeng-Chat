/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * V20 · settings-item-bubble
 * 气泡样式选择：把区块插入 V19 的外观页（文档 §8.3 的交互闭环）。
 */
export const name = 'settings-item-bubble'
export const version = '1.0.0'
export const displayName = '设置项 · 气泡'
export const description = '设置页 · 在已安装的气泡实现之间切换。'
export const author = '念风内核'
export const icon = '💠'
export const core = true
export const depends = {
  'event-bus': '*',
  'message-list': '^1.0.0',
  'settings-item-theme': '^1.0.0',
  'toast-host': '>=1.0.0',
}
export const optionalDepends = {}
export const inject = ['appearance-page', 'bubble-styles', 'event-bus', 'toast']

import { section, card, row } from '../../../src/util/settings.mjs'
import { escapeHtml } from '../../../src/util/format.mjs'

export function apply(ctx) {
  const appearance = ctx.inject('appearance-page')
  const bubbles = ctx.inject('bubble-styles')
  const events = ctx.inject('event-bus')
  const toast = ctx.inject('toast')

  appearance.addSection(container => {
    let host = container.querySelector('[data-bubble-section]')
    if (!host) {
      host = document.createElement('div')
      host.dataset.bubbleSection = '1'
      container.appendChild(host)
    }

    const render = () => {
      const active = bubbles.getActiveId()
      const list = bubbles.list()
      host.innerHTML = section('气泡样式', card(
        list
          .map(item => row(
            escapeHtml(item.label || item.id),
            escapeHtml(item.description || ''),
            item.id === active ? '<span class="text-good">● 使用中</span>' : `<button class="outline-btn" data-bubble="${item.id}">切换使用</button>`,
          ))
          .join('') || row('暂无气泡实现', '安装 bubble-* 插件后可选', ''),
      ))

      host.querySelectorAll('[data-bubble]').forEach(btn => {
        btn.addEventListener('click', () => {
          bubbles.select(btn.dataset.bubble)
          toast.success(`已切换气泡样式：${btn.closest('.setting-row')?.querySelector('.setting-name')?.textContent || btn.dataset.bubble}`)
          render()
        })
      })
    }

    render()
    const offs = [events.on('bubble-styles:registered', render), events.on('bubble-styles:changed', render)]
    return () => {
      offs.forEach(off => off())
      host.remove()
    }
  })
}
