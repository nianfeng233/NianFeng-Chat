/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * S7 · left-list-panel
 * 左列表玻璃板容器（文档 §8.2）：
 *  - 根据 view-router 的当前视图，显示对应视图注册的 list 面板
 *  - 处理拖拽调宽、紧凑模式、圆角衰减
 */
export const name = 'left-list-panel'
export const version = '1.0.0'
export const displayName = '左列表容器'
export const description = '视觉框架 · 左列表玻璃板容器，负责视图列表切换与宽度记忆。'
export const author = '念风内核'
export const icon = '📋'
export const core = true
export const depends = {
  'app-shell': '^1.0.0',
  'event-bus': '*',
  'slots': '*',
  'view-router': '^1.0.0',
}
export const optionalDepends = {}
export const inject = ['slots', 'view-router', 'app-shell', 'event-bus']
export const provides = [{ name: 'left-list-panel', type: 'singleton' }]

import { useStyle } from '../../../src/util/style.mjs'
import { LIST_PANEL_CSS } from './style.mjs'

const MARGIN_LEFT = 6

export function apply(ctx) {
  const router = ctx.inject('view-router')
  const shell = ctx.inject('app-shell')
  const events = ctx.inject('event-bus')

  useStyle(ctx, LIST_PANEL_CSS)

  /** viewId -> { wrapper, cleanup } */
  const mounts = new Map()
  let root = null

  ctx.slots.register('app:list', container => {
    container.innerHTML = `<aside class="list-pane glass" id="listPane"><div class="list-views" id="listViews"></div></aside>`
    root = container.querySelector('#listPane')
    const viewsHost = container.querySelector('#listViews')

    const show = () => {
      for (const [id, mount] of mounts) {
        const active = id === router.active()
        mount.wrapper.style.display = active ? '' : 'none'
      }
      events.emit('list-panel:changed', { view: router.active() })
    }

    const mountView = id => {
      if (mounts.has(id)) return
      const view = router.get(id)
      const wrapper = document.createElement('div')
      wrapper.className = 'pane-view list-view'
      wrapper.dataset.view = id
      wrapper.style.display = id === router.active() ? '' : 'none'
      viewsHost.appendChild(wrapper)
      let cleanup = null
      if (view?.list) {
        try {
          cleanup = view.list(wrapper, ctx) || null
        } catch (err) {
          ctx.logger.error(`列表视图 ${id} 挂载失败`, err)
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

    // 已有视图 + 后续注册 / 切换
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
    shell.onReady(refs => {
      attachResize(refs)
      applyPerView(refs)
    })

    show()
    router.ready('list')

    return () => {
      offRegister()
      offUnregister()
      offSwitch()
      for (const mount of mounts.values()) mount.cleanup()
      mounts.clear()
      container.innerHTML = ''
    }
  })

  /* ---------------- 拖拽调宽（demo 交互） ---------------- */
  function attachResize(refs) {
    const { resizer, bodyEl } = refs
    let dragging = false

    const onDown = e => {
      dragging = true
      resizer.classList.add('dragging')
      shell.setDragging('v', true)
      e.preventDefault()
    }
    const onMove = e => {
      if (!dragging) return
      const view = router.active()
      const cfg = router.widthConfig(view)
      const left = bodyEl.getBoundingClientRect().left
      router.setWidth(view, Math.max(cfg.min, Math.min(cfg.max, e.clientX - left - MARGIN_LEFT)))
    }
    const onUp = () => {
      if (!dragging) return
      dragging = false
      resizer.classList.remove('dragging')
      shell.setDragging('v', false)
      events.emit('list-panel:width-committed', { view: router.active(), width: router.getWidth() })
    }

    resizer.addEventListener('mousedown', onDown)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    ctx.effect(() => {
      resizer.removeEventListener('mousedown', onDown)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    })
  }

  /* ---------------- 紧凑模式与圆角 ---------------- */
  function applyPerView(refs) {
    if (!root) return
    const ro = new ResizeObserver(() => {
      const w = root.clientWidth
      const isChat = router.active() === 'chat'
      root.classList.toggle('compact', isChat && w < 110)
      let r = 16
      if (w < 240) r = 14
      if (w < 180) r = 12
      if (w < 120) r = 10
      if (w < 90) r = 8
      root.style.setProperty('--pane-radius', `${r}px`)
      events.emit('list-panel:resized', { width: w, compact: root.classList.contains('compact') })
    })
    ro.observe(root)
    ctx.effect(() => ro.disconnect())
  }

  ctx.provide('left-list-panel', {
    name: 'left-list-panel',
    element: () => root,
    isCompact: () => !!root?.classList.contains('compact'),
    views: () => [...mounts.keys()],
  }, { type: 'singleton' })

  router.ready('list-host')
  ctx.logger.debug('左列表容器就绪')
}
