/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * V16 · settings-container
 * 设置容器：维护"设置页注册表"，渲染左侧导航与右侧内容。
 * V17~V23 等设置项插件向它注册自己的页面（文档 §3 V16~V23 的依赖方向）。
 */
export const name = 'settings-container'
export const version = '1.0.0'
export const displayName = '设置容器'
export const description = '视觉内容 · 设置页注册表、导航渲染与页面调度。'
export const author = '念风内核'
export const icon = '🧱'
export const core = true
export const depends = { 'settings-view': '^1.0.0' }
export const inject = ['slots', 'event-bus']
export const provides = [{ name: 'settings-container', type: 'singleton' }]

import { useStyle } from '../../../src/util/style.mjs'
import { SETTINGS_CONTAINER_CSS } from './style.mjs'

export function apply(ctx) {
  const events = ctx.inject('event-bus')
  useStyle(ctx, SETTINGS_CONTAINER_CSS)

  /** id -> { id, group, label, icon, order, render } */
  const pages = new Map()
  const navHosts = new Map()
  let contentEl = null
  let activeId = null
  let cleanupCurrent = null

  const sorted = () =>
    [...pages.values()].sort((a, b) => (a.groupOrder ?? 0) - (b.groupOrder ?? 0) || a.order - b.order)

  const renderNav = () => {
    for (const host of navHosts.values()) {
      const groups = new Map()
      for (const page of sorted()) {
        if (!groups.has(page.group)) groups.set(page.group, [])
        groups.get(page.group).push(page)
      }
      host.innerHTML = [...groups.entries()]
        .map(
          ([group, list]) => `
          <div class="settings-nav-group">
            <div class="settings-nav-head">${group}</div>
            ${list
              .map(
                page => `<button class="settings-nav-item ${page.id === activeId ? 'active' : ''}" data-page="${page.id}">
                  ${page.icon || ''}<span class="nav-label">${page.label}</span>
                </button>`,
              )
              .join('')}
          </div>`,
        )
        .join('')
    }
  }

  const openPage = id => {
    const page = pages.get(id) || pages.get('account') || sorted()[0]
    if (!page) return
    activeId = page.id
    cleanupCurrent?.()
    cleanupCurrent = null
    if (contentEl) {
      contentEl.innerHTML = ''
      try {
        const cleanup = page.render(contentEl, ctx)
        cleanupCurrent = typeof cleanup === 'function' ? cleanup : null
      } catch (err) {
        ctx.logger.error(`设置页 ${page.id} 渲染失败`, err)
        contentEl.innerHTML = `<div class="settings-note">页面渲染失败：${err.message}</div>`
      }
    }
    renderNav()
    events.emit('settings:page-changed', { id: page.id })
  }

  const service = {
    name: 'settings-container',
    register(page) {
      if (pages.has(page.id)) throw new Error(`设置页已注册：${page.id}`)
      pages.set(page.id, {
        groupOrder: 0,
        order: 100,
        ...page,
      })
      const disposer = () => {
        pages.delete(page.id)
        if (activeId === page.id) openPage('account')
        else renderNav()
      }
      ctx.effect(disposer)
      renderNav()
      if (!activeId) openPage(page.id)
      events.emit('settings:page-registered', { id: page.id, label: page.label })
      return disposer
    },
    list: () => sorted(),
    open: openPage,
    active: () => activeId,
    async enablePlugin(id) {
      return ctx.registry.get('plugin-manager')?.enable?.(id)
    },
  }

  ctx.slots.register('settings:nav', container => {
    navHosts.set(container, container)
    container.classList.add('settings-nav-list')
    const onClick = e => {
      const btn = e.target.closest('.settings-nav-item')
      if (btn) openPage(btn.dataset.page)
    }
    container.addEventListener('click', onClick)
    renderNav()
    return () => {
      container.removeEventListener('click', onClick)
      navHosts.delete(container)
      container.innerHTML = ''
    }
  })

  ctx.slots.register('settings:main', container => {
    container.innerHTML = `<div class="settings-content" data-slot="settings:content"></div>`
    contentEl = container.querySelector('.settings-content')
    openPage(activeId || 'account')
    return () => {
      contentEl = null
      cleanupCurrent?.()
      cleanupCurrent = null
      container.innerHTML = ''
    }
  })

  const offPage = events.on('settings:page', payload => {
    // 兼容两种写法：{ page } 或直接传 page id；null / 空值视为"保持当前页"
    const pageId = payload && typeof payload === 'object' ? payload.page : payload
    if (pageId) openPage(pageId)
  })
  const offOpened = events.on('settings:opened', () => {
    if (!activeId) openPage('account')
    else openPage(activeId)
  })

  ctx.provide('settings-container', service, { type: 'singleton' })
  ctx.effect(() => {
    offPage()
    offOpened()
  })
  ctx.logger.debug('设置容器就绪')
}
