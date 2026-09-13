/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * V3 · win-buttons
 * 顶层栏右侧：最小化 / 最大化 / 关闭。
 * 浏览器环境下是装饰性的，检测到 Electron 时可对接宿主窗口 API。
 */
export const name = 'win-buttons'
export const version = '1.0.0'
export const displayName = '窗口按钮'
export const description = '顶层栏内容 · 最小化 / 最大化 / 关闭。'
export const author = '念风内核'
export const icon = '🔲'
export const core = true
export const depends = {
  'slots': '*',
  'titlebar': '^1.0.0',
  'toast-host': '>=1.0.0',
}
export const optionalDepends = {}
export const inject = ['slots', 'toast']
export const enabled = true

import { icons } from '../../../src/util/icons.mjs'

export function apply(ctx) {
  const toast = ctx.inject('toast')
  const hasHost = typeof window !== 'undefined' && !!window.windHost?.window

  ctx.slots.register('titlebar:right', container => {
    container.innerHTML = `
      <div class="tb-winbtns">
        <button class="win-btn" data-win="min" title="最小化" aria-label="最小化">${icons.winMin}</button>
        <button class="win-btn" data-win="max" title="最大化" aria-label="最大化">${icons.winMax}</button>
        <button class="win-btn close" data-win="close" title="关闭" aria-label="关闭">${icons.winClose}</button>
      </div>`

    const onClick = e => {
      const btn = e.target.closest('[data-win]')
      if (!btn) return
      const action = btn.dataset.win
      if (hasHost) {
        window.windHost.window(action)
        return
      }
      if (action === 'max') {
        if (document.fullscreenElement) document.exitFullscreen?.()
        else document.documentElement.requestFullscreen?.().catch(() => {})
      } else if (action === 'close') {
        toast.info('浏览器环境无法直接关闭窗口；打包为桌面端后将调用宿主窗口 API。')
      } else {
        toast.info('最小化按钮在桌面端生效。')
      }
      ctx.emit('window:action', { action })
    }

    container.addEventListener('click', onClick)
    return () => {
      container.removeEventListener('click', onClick)
      container.innerHTML = ''
    }
  }, { order: 20 })
}
