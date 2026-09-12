/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * S? · mobile-shell
 * 手机访问时自动进入专门的单栏界面：
 *   - 隐藏桌面侧边栏 / 拖拽条，列表和内容一次只显示一个；
 *   - 顶部返回栏 + 底部 会话 / 渠道 / 设置 导航；
 *   - 设置页在手机上改为横向导航 + 全屏内容。
 *
 * 可用 ?mobile=1 / ?mobile=0 强制开关，方便桌面调试。
 */
export const name = 'mobile-shell'
export const version = '1.0.0'
export const displayName = '手机界面'
export const description = '视觉框架 · 手机访问自动切换到单栏界面、底部导航与全屏设置。'
export const author = '念风内核'
export const icon = '📱'
export const core = true
export const depends = { 'app-shell': '^1.0.0', 'view-router': '^1.0.0', 'session-service': '^2.0.0' }
export const inject = ['app-shell', 'view-router', 'session-service', 'event-bus', 'channel-registry?', 'settings-view?']

import { useStyle } from '../../../src/util/style.mjs'
import { icons } from '../../../src/util/icons.mjs'
import { MOBILE_SHELL_CSS } from './style.mjs'

export function apply(ctx) {
  if (typeof window === 'undefined' || typeof document === 'undefined') return
  const router = ctx.inject('view-router')
  const sessions = ctx.inject('session-service')
  const events = ctx.inject('event-bus')
  const channels = ctx.inject('channel-registry?')
  const settingsView = ctx.inject('settings-view?')

  const query = new URLSearchParams(window.location.search || '')
  const forced = String(query.get('mobile') || query.get('layout') || '').toLowerCase()
  const ua = String(navigator.userAgent || '')
  const uaMobile = /Android|iPhone|iPod|iPad|Mobile|Windows Phone|HarmonyOS|MicroMessenger|Quark|UCBrowser/i.test(ua)
  const coarseSmall = typeof matchMedia === 'function' && matchMedia('(max-width: 760px) and (pointer: coarse)').matches
  const mobile = forced === '1' || forced === 'mobile' ? true : forced === '0' || forced === 'desktop' ? false : uaMobile || coarseSmall
  if (!mobile) return

  document.documentElement.dataset.mobileLayout = '1'
  document.body.classList.add('mobile-layout')
  useStyle(ctx, MOBILE_SHELL_CSS)

  let settingsOpen = settingsView?.isOpen?.() === true
  let pane = 'list'

  document.body.insertAdjacentHTML(
    'beforeend',
    `<header class="mobile-topbar">
       <button class="mobile-topbar-btn mobile-topbar-back" data-mobile-back title="返回" hidden>‹</button>
       <div class="mobile-topbar-title" data-mobile-title>念风</div>
       <button class="mobile-topbar-btn" data-mobile-settings title="设置">${icons.settings}</button>
     </header>
     <nav class="mobile-tabbar" data-mobile-tabs></nav>`,
  )

  const backBtn = document.querySelector('[data-mobile-back]')
  const titleEl = document.querySelector('[data-mobile-title]')
  const tabsEl = document.querySelector('[data-mobile-tabs]')

  const activeChannel = () => {
    try {
      return channels?.active?.() || null
    } catch (_) {
      return null
    }
  }

  const initialPaneFor = viewId => {
    if (viewId === 'chat') return sessions.active() ? 'main' : 'list'
    if (viewId === 'channel') return activeChannel() ? 'main' : 'list'
    return 'list'
  }

  const syncTitle = () => {
    if (!titleEl) return
    if (settingsOpen) {
      titleEl.textContent = '设置'
      return
    }
    const view = router.active()
    if (view === 'chat') titleEl.textContent = sessions.active()?.name || '会话'
    else if (view === 'channel') titleEl.textContent = activeChannel()?.name || '渠道'
    else titleEl.textContent = router.get(view)?.label || '念风'
  }

  const syncTabs = () => {
    if (!tabsEl) return
    const views = router.list().filter(item => item.rail !== false)
    tabsEl.innerHTML =
      views
        .map(
          view => `<button class="mobile-tab ${!settingsOpen && router.active() === view.id ? 'active' : ''}" data-mobile-view="${view.id}">
            ${view.icon || icons.info}<span class="mobile-tab-label">${view.label}</span>
          </button>`,
        )
        .join('') +
      `<button class="mobile-tab ${settingsOpen ? 'active' : ''}" data-mobile-settings>
        ${icons.settings}<span class="mobile-tab-label">设置</span>
      </button>`
  }

  const syncBack = () => {
    if (!backBtn) return
    backBtn.hidden = !settingsOpen && pane !== 'main'
  }

  const setPane = next => {
    pane = next === 'main' ? 'main' : 'list'
    document.body.classList.toggle('mobile-pane-main', pane === 'main')
    document.body.classList.toggle('mobile-pane-list', pane === 'list')
    syncBack()
  }

  const onBack = () => {
    if (settingsOpen) {
      events.emit('settings:close', null)
      return
    }
    if (pane === 'main') setPane('list')
  }

  backBtn?.addEventListener('click', onBack)

  const onTabsClick = event => {
    if (event.target.closest('[data-mobile-settings]')) {
      events.emit('settings:toggle', null)
      return
    }
    const button = event.target.closest('[data-mobile-view]')
    if (!button) return
    const view = button.dataset.mobileView
    events.emit('settings:close', null)
    if (router.active() === view) {
      setPane(pane === 'main' ? 'list' : initialPaneFor(view))
    } else {
      router.switch(view)
    }
    syncTitle()
    syncTabs()
  }
  tabsEl?.addEventListener('click', onTabsClick)

  // 手机端在一个会话 / 渠道已经打开时，点列表里同一个条目应该“回到详情”，而不是被
  // 桌面逻辑 toggle 成取消选择。这里在捕获阶段拦住并保持原有选择。
  const onCaptureClick = event => {
    if (settingsOpen || pane !== 'list') return
    if (event.target.closest('button, input, textarea, select, [data-conv-delete]')) return
    const view = router.active()
    if (view === 'chat') {
      const item = event.target.closest('.conv-item')
      if (item?.dataset.id && sessions.activeId() === item.dataset.id) {
        event.preventDefault()
        event.stopPropagation()
        setPane('main')
      }
    } else if (view === 'channel') {
      const item = event.target.closest('.channel-item')
      const activeKey = String(channels?.activeKey?.() || '')
      if (item?.dataset.channelId && activeKey.endsWith(`:${item.dataset.channelId}`)) {
        event.preventDefault()
        event.stopPropagation()
        setPane('main')
      }
    }
  }
  document.addEventListener('click', onCaptureClick, true)

  const offs = [
    events.on('conversation:switch', ({ id } = {}) => {
      if (router.active() !== 'chat') return
      setPane(id ? 'main' : 'list')
      syncTitle()
    }),
    events.on('conversation:update', () => syncTitle()),
    events.on('channel:activated', ({ id } = {}) => {
      if (router.active() !== 'channel') return
      setPane(id ? 'main' : 'list')
      syncTitle()
    }),
    events.on('channel:updated', () => syncTitle()),
    events.on('view:changed', ({ view } = {}) => {
      setPane(initialPaneFor(view))
      syncTitle()
      syncTabs()
    }),
    events.on('view:registered', () => syncTabs()),
    events.on('view:unregistered', () => syncTabs()),
    events.on('settings:opened', () => {
      settingsOpen = true
      document.body.classList.add('mobile-settings-open')
      syncTitle()
      syncTabs()
      syncBack()
    }),
    events.on('settings:closed', () => {
      settingsOpen = false
      document.body.classList.remove('mobile-settings-open')
      syncTitle()
      syncTabs()
      syncBack()
    }),
  ]

  setPane(initialPaneFor(router.active()))
  syncTitle()
  syncTabs()
  ctx.logger.info(`手机界面已启用（${forced ? '调试强制' : uaMobile ? '移动 UA' : '小屏触控'}）`)

  ctx.effect(() => () => {
    offs.forEach(off => off?.())
    backBtn?.removeEventListener('click', onBack)
    tabsEl?.removeEventListener('click', onTabsClick)
    document.removeEventListener('click', onCaptureClick, true)
    document.querySelector('.mobile-topbar')?.remove()
    document.querySelector('.mobile-tabbar')?.remove()
    document.documentElement.removeAttribute('data-mobile-layout')
    document.body.classList.remove('mobile-layout', 'mobile-pane-main', 'mobile-pane-list', 'mobile-settings-open')
  })

  ctx.provide('mobile-shell', {
    name: 'mobile-shell',
    enabled: () => true,
    pane: () => pane,
    showList: () => setPane('list'),
    showMain: () => setPane('main'),
  }, { type: 'singleton' })
}
