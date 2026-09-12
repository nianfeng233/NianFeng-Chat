/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * V4 · rail-nav-buttons
 * 侧边栏导航：从 view-router 动态生成视图按钮，不写死 chat / channel。
 * 下方额外提供「设置」入口。
 */
export const name = 'rail-nav-buttons'
export const version = '1.0.0'
export const displayName = '侧栏导航'
export const description = '侧边栏内容 · 会话 / 渠道 / 设置切换。'
export const author = '念风内核'
export const icon = '🧭'
export const core = true
export const depends = { rail: '^1.0.0', 'view-router': '^1.0.0' }
export const inject = ['slots', 'view-router', 'shortcuts']

import { icons } from '../../../src/util/icons.mjs'

export function apply(ctx) {
  const router = ctx.inject('view-router')
  const shortcuts = ctx.inject('shortcuts')
  let navHost = null

  const renderNav = () => {
    if (!navHost) return
    const views = router.list().filter(v => v.rail)
    navHost.innerHTML = views
      .map(
        (view, i) => `
        <button class="rail-btn ${view.id === router.active() ? 'active' : ''}" data-view="${view.id}" title="${view.label}${i < 9 ? ` (Ctrl+${i + 1})` : ''}">
          ${view.icon || icons.info}
        </button>`,
      )
      .join('')
  }

  ctx.slots.register('rail:top', container => {
    navHost = document.createElement('div')
    navHost.className = 'rail-nav-group'
    navHost.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:6px;width:100%'
    container.appendChild(navHost)
    renderNav()

    const onClick = e => {
      const btn = e.target.closest('.rail-btn[data-view]')
      if (!btn) return
      ctx.emit('settings:close', null)
      router.switch(btn.dataset.view)
    }
    navHost.addEventListener('click', onClick)

    const offChange = ctx.on('view:changed', renderNav)

    // Ctrl+1..9 快速切换视图。视图是运行时注册的，这里在每次 view:registered
    // 时整体重算，避免 rail-nav-buttons 加载过早导致后面的视图没有快捷键。
    let shortcutDisposers = []
    const syncShortcuts = () => {
      shortcutDisposers.forEach(dispose => dispose())
      shortcutDisposers = router
        .list()
        .filter(v => v.rail)
        .slice(0, 9)
        .map((view, i) =>
          shortcuts.register(`Ctrl+${i + 1}`, () => {
            ctx.emit('settings:close', null)
            router.switch(view.id)
          }, { label: `切换到「${view.label}」`, owner: ctx.id }),
        )
    }

    const offRegister = ctx.on('view:registered', () => {
      renderNav()
      syncShortcuts()
    })
    const offUnregister = ctx.on('view:unregistered', () => {
      renderNav()
      syncShortcuts()
    })
    syncShortcuts()

    return () => {
      navHost.removeEventListener('click', onClick)
      offChange()
      offRegister()
      offUnregister()
      shortcutDisposers.forEach(d => d())
      container.innerHTML = ''
    }
  }, { order: 10 })

  ctx.slots.register('rail:bottom', container => {
    container.innerHTML = `
      <button class="rail-btn" id="railSettingsBtn" title="设置" data-action="settings">
        ${icons.settings}
      </button>`
    const onClick = e => {
      if (!e.target.closest('[data-action="settings"]')) return
      ctx.emit('settings:toggle', null)
    }
    container.addEventListener('click', onClick)
    const off = ctx.on('settings:opened', () => container.querySelector('#railSettingsBtn')?.classList.add('active'))
    const off2 = ctx.on('settings:closed', () => container.querySelector('#railSettingsBtn')?.classList.remove('active'))
    return () => {
      container.removeEventListener('click', onClick)
      off()
      off2()
      container.innerHTML = ''
    }
  }, { order: 10 })

  ctx.logger.debug('侧栏导航就绪')
}
