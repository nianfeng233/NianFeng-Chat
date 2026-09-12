/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * S8 · right-main-panel
 * 右主面板玻璃板容器：按 view-router 的当前视图切换 main 内容。
 */
export const name = 'right-main-panel'
export const version = '1.0.0'
export const displayName = '右主面板'
export const description = '视觉框架 · 右主面板玻璃板容器与视图切换。'
export const author = '念风内核'
export const icon = '🗂️'
export const core = true
export const depends = { 'app-shell': '^1.0.0', 'view-router': '^1.0.0' }
export const inject = ['slots', 'view-router', 'event-bus']
export const provides = [{ name: 'right-main-panel', type: 'singleton' }]

import { useStyle } from '../../../src/util/style.mjs'
import { MAIN_PANEL_CSS } from './style.mjs'

export function apply(ctx) {
  const router = ctx.inject('view-router')
  const events = ctx.inject('event-bus')

  useStyle(ctx, MAIN_PANEL_CSS)

  const mounts = new Map()
  let root = null

  ctx.slots.register('app:main', container => {
    container.innerHTML = `<main class="content" id="mainPanel"></main>`
    root = container.querySelector('#mainPanel')

    const show = () => {
      for (const [id, mount] of mounts) mount.wrapper.style.display = id === router.active() ? '' : 'none'
      const active = router.activeView()
      if (active) router.ready(`main:${active.id}`)
    }

    const mountView = id => {
      if (mounts.has(id)) return
      const view = router.get(id)
      const wrapper = document.createElement('div')
      wrapper.className = 'pane-view main-view'
      wrapper.dataset.view = id
      wrapper.style.display = id === router.active() ? '' : 'none'
      root.appendChild(wrapper)
      let cleanup = null
      if (view?.main) {
        try {
          cleanup = view.main(wrapper, ctx) || null
        } catch (err) {
          ctx.logger.error(`主视图 ${id} 挂载失败`, err)
        }
      } else {
        wrapper.innerHTML = `<div class="empty-state"><div class="empty-title">${view?.label || id}</div></div>`
      }
      mounts.set(id, {
        wrapper,
        cleanup: () => {
          cleanup?.()
          wrapper.remove()
        },
      })
    }

    for (const view of router.list()) mountView(view.id)
    const offRegister = events.on('view:registered', ({ id }) => {
      mountView(id)
      show()
    })
    const offUnregister = events.on('view:unregistered', ({ id }) => {
      const mount = mounts.get(id)
      if (mount) {
        mount.cleanup()
        mounts.delete(id)
      }
      show()
    })
    const offSwitch = events.on('view:changed', show)

    show()
    ctx.emit('main-panel:ready', { root })

    return () => {
      offRegister()
      offUnregister()
      offSwitch()
      for (const mount of mounts.values()) mount.cleanup()
      mounts.clear()
      container.innerHTML = ''
    }
  })

  ctx.provide('right-main-panel', {
    name: 'right-main-panel',
    element: () => root,
    views: () => [...mounts.keys()],
  }, { type: 'singleton' })

  ctx.logger.debug('右主面板就绪')
}
