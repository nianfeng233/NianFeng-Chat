/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * V15 · settings-view
 * 设置视图入口：覆盖在右侧主面板之上的整页视图。
 * 提供 settings:nav / settings:main 两个插槽，具体内容由 V16 之后填充。
 */
export const name = 'settings-view'
export const version = '1.0.0'
export const displayName = '设置视图'
export const description = '视觉内容 · 设置页外壳、导航槽与内容槽。'
export const author = '念风内核'
export const icon = '⚙️'
export const core = true
export const depends = { 'app-shell': '^1.0.0' }
export const inject = ['slots', 'event-bus']
export const provides = [{ name: 'settings-view', type: 'singleton' }]

import { useStyle } from '../../../src/util/style.mjs'
import { SETTINGS_VIEW_CSS } from './style.mjs'

export function apply(ctx) {
  const events = ctx.inject('event-bus')
  useStyle(ctx, SETTINGS_VIEW_CSS)

  ctx.slots.define('settings:nav', { description: '设置导航' })
  ctx.slots.define('settings:main', { description: '设置内容' })

  let open = false

  ctx.slots.register('app:overlay', container => {
    container.innerHTML = `
      <section class="settings-view" id="settingsView" aria-label="设置">
        <aside class="settings-nav" id="settingsNav" data-slot="settings:nav"></aside>
        <div class="settings-content-wrap" data-slot="settings:main"></div>
      </section>`

    const view = container.querySelector('#settingsView')

    const doOpen = payload => {
      open = true
      view.classList.add('show')
      events.emit('settings:opened', payload || {})
      ctx.emit('settings:page', { page: payload?.page || null })
      // 打开后让 rail 的设置按钮高亮
      document.querySelector('#railSettingsBtn')?.classList.add('active')
      for (const btn of document.querySelectorAll('.rail-btn[data-view]')) btn.classList.remove('active')
    }
    const doClose = () => {
      if (!open) return
      open = false
      view.classList.remove('show')
      events.emit('settings:closed', null)
      document.querySelector('#railSettingsBtn')?.classList.remove('active')
      const active = ctx.registry.get('view-router')?.active?.()
      document.querySelector(`.rail-btn[data-view="${active}"]`)?.classList.add('active')
    }

    const offToggle = events.on('settings:toggle', () => (open ? doClose() : doOpen()))
    const offOpen = events.on('settings:open', payload => {
      if (!open) doOpen(payload)
      else ctx.emit('settings:page', { page: payload?.page || null })
    })
    const offClose = events.on('settings:close', doClose)
    const offKey = events.on('config:changed', () => {})
    const onKeydown = e => {
      if (e.key === 'Escape' && open) doClose()
    }
    document.addEventListener('keydown', onKeydown)

    return () => {
      offToggle()
      offOpen()
      offClose()
      offKey()
      document.removeEventListener('keydown', onKeydown)
      container.innerHTML = ''
    }
  })

  ctx.provide('settings-view', {
    name: 'settings-view',
    isOpen: () => open,
    open: page => events.emit('settings:open', { page }),
    close: () => events.emit('settings:close', null),
    toggle: () => events.emit('settings:toggle', null),
  }, { type: 'singleton' })
}
