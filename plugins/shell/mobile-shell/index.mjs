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
export const version = '1.1.0'
export const displayName = '手机界面'
export const description = '视觉框架 · 手机访问自动切换到单栏界面、底部导航与全屏设置。'
export const author = '念风内核'
export const icon = '📱'
export const core = true
export const depends = {
  'app-shell': '^1.0.0',
  'event-bus': '*',
  'session-service': '^2.0.0',
  'view-router': '^1.0.0',
}
export const optionalDepends = {
  'channel-registry': '>=1.0.0',
  'settings-view': '>=1.0.0',
}
export const inject = ['app-shell', 'view-router', 'session-service', 'event-bus', 'channel-registry?', 'settings-view?']
export const provides = [{ name: 'mobile-shell', type: 'singleton' }]

import { useStyle } from '../../../src/util/style.mjs'
import { icons } from '../../../src/util/icons.mjs'
import { MOBILE_SHELL_CSS } from './style.mjs'

export function apply(ctx) {
  const router = ctx.inject('view-router')
  const sessions = ctx.inject('session-service')
  const events = ctx.inject('event-bus')
  const channels = ctx.inject('channel-registry?')
  const settingsView = ctx.inject('settings-view?')

  let mounted = false
  let pane = 'list'
  let settingsOpen = false

  // 服务始终注册：桌面访问 / 非浏览器环境只是 enabled()=false，不能因为
  // “当前没启用手机布局”就让声明 provide 的插件在自检里被标黄。
  ctx.provide(
    'mobile-shell',
    {
      name: 'mobile-shell',
      enabled: () => mounted,
      pane: () => pane,
      showList: () => {
        if (mounted) setPane('list')
      },
      showMain: () => {
        if (mounted) setPane('main')
      },
    },
    { type: 'singleton' },
  )

  if (typeof window === 'undefined' || typeof document === 'undefined') return

  const query = new URLSearchParams(window.location.search || '')
  const forced = String(query.get('mobile') || query.get('layout') || '').toLowerCase()
  const ua = String(navigator.userAgent || '')
  const uaMobile = /Android|iPhone|iPod|iPad|Mobile|Windows Phone|HarmonyOS|MicroMessenger|Quark|UCBrowser/i.test(ua)
  const coarseSmall = typeof matchMedia === 'function' && matchMedia('(max-width: 760px) and (pointer: coarse)').matches
  const mobile = forced === '1' || forced === 'mobile' ? true : forced === '0' || forced === 'desktop' ? false : uaMobile || coarseSmall
  if (!mobile) return

  mounted = true
  settingsOpen = settingsView?.isOpen?.() === true
  document.documentElement.dataset.mobileLayout = '1'
  document.body.classList.add('mobile-layout')
  useStyle(ctx, MOBILE_SHELL_CSS)

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
    // 全宽视图（运行日志等）没有左侧列表，直接进入主内容区。
    if (router.isFullWidth?.(viewId)) return 'main'
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
    // 桌面侧栏有独立的「日志」按钮（rail=false）；手机端底部也要有，避免只剩会话 / 渠道 / 设置。
    const views = router.list().filter(item => item.rail !== false || item.id === 'logs')
    tabsEl.innerHTML =
      views
        .map(
          view => `<button class="mobile-tab ${!settingsOpen && router.active() === view.id ? 'active' : ''}" data-mobile-view="${view.id}">
            ${view.icon || icons.info}<span class="mobile-tab-label">${view.id === 'logs' ? '日志' : view.label}</span>
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

  /** 设置页横向导航：打开 / 切换页面时把当前项滚到可视区域中间。 */
  const syncSettingsNavScroll = () => {
    const active = document.querySelector('.settings-nav-item.active')
    try {
      active?.scrollIntoView?.({ block: 'nearest', inline: 'center' })
    } catch (_) {
      /* 老浏览器没有 scrollIntoView 选项时忽略 */
    }
  }

  function setPane(next) {
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
    if (router.isFullWidth?.(router.active())) {
      // 日志等全宽视图没有左侧列表，返回键回到会话视图。
      router.switch('chat')
      setPane(initialPaneFor('chat'))
      syncTitle()
      syncTabs()
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
      // 全宽视图永远保持 main，避免切到空列表。
      setPane(router.isFullWidth?.(view) ? 'main' : pane === 'main' ? 'list' : initialPaneFor(view))
    } else {
      router.switch(view)
      if (router.isFullWidth?.(view)) setPane('main')
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

  /**
   * 手机端滚动链兜底：
   *   内层列表（.allow-scroll-chain）仍保留自己的滚动条；当它已经在顶部 / 底部，
   *   继续向下 / 向上滚时，把这次手势余量交给最近的父级滚动容器（通常是
   *   .settings-content）。浏览器原生 overscroll-behavior:auto 也会做类似的事，
   *   这里针对部分 WebView / 触控环境补一个显式实现，保证内外层互不抢滚动。
   */
  const installScrollChaining = () => {
    const CHAIN_SELECTOR = '.allow-scroll-chain'
    const isVerticalScrollable = element => {
      if (!element || element.scrollHeight <= element.clientHeight + 1) return false
      if (typeof getComputedStyle !== 'function') return true
      try {
        const style = getComputedStyle(element)
        const overflowY = String(style.overflowY || style.overflow || '')
        return overflowY === 'auto' || overflowY === 'scroll'
      } catch (_) {
        return false
      }
    }
    const canScroll = (element, delta) => {
      if (!element || !Number.isFinite(delta) || delta === 0) return false
      if (delta > 0) return element.scrollTop + element.clientHeight < element.scrollHeight - 1
      return element.scrollTop > 1
    }
    const nearestScrollParent = element => {
      let parent = element?.parentElement || null
      while (parent) {
        if (isVerticalScrollable(parent)) return parent
        parent = parent.parentElement
      }
      return null
    }
    const chainScroll = (element, delta) => {
      const parent = nearestScrollParent(element)
      if (!parent || !canScroll(parent, delta)) return false
      parent.scrollTop += delta
      return true
    }
    const onWheel = event => {
      if (event.defaultPrevented || !event.deltaY) return
      const inner = event.target?.closest?.(CHAIN_SELECTOR)
      if (!inner || !isVerticalScrollable(inner) || canScroll(inner, event.deltaY)) return
      if (chainScroll(inner, event.deltaY)) event.preventDefault()
    }
    let touchState = null
    const onTouchStart = event => {
      const touch = event.touches?.[0]
      if (!touch) {
        touchState = null
        return
      }
      const inner = event.target?.closest?.(CHAIN_SELECTOR)
      touchState = inner ? { inner, lastY: touch.clientY } : null
    }
    const onTouchMove = event => {
      if (!touchState) return
      const touch = event.touches?.[0]
      if (!touch) return
      const delta = touchState.lastY - touch.clientY
      touchState.lastY = touch.clientY
      const inner = touchState.inner
      if (!inner?.isConnected || !isVerticalScrollable(inner) || canScroll(inner, delta)) return
      if (chainScroll(inner, delta) && event.cancelable) event.preventDefault()
    }
    const onTouchEnd = () => {
      touchState = null
    }
    document.addEventListener('wheel', onWheel, { passive: false, capture: true })
    document.addEventListener('touchstart', onTouchStart, { passive: true, capture: true })
    document.addEventListener('touchmove', onTouchMove, { passive: false, capture: true })
    document.addEventListener('touchend', onTouchEnd, { passive: true, capture: true })
    document.addEventListener('touchcancel', onTouchEnd, { passive: true, capture: true })
    return () => {
      document.removeEventListener('wheel', onWheel, true)
      document.removeEventListener('touchstart', onTouchStart, true)
      document.removeEventListener('touchmove', onTouchMove, true)
      document.removeEventListener('touchend', onTouchEnd, true)
      document.removeEventListener('touchcancel', onTouchEnd, true)
    }
  }
  const disposeScrollChaining = installScrollChaining()

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
    events.on('view:registered', ({ id } = {}) => {
      // 启动时 router.active() 可能来自上次持久化的视图（例如 logs / welcome），
      // 而该视图插件比 mobile-shell 更晚注册。此时 initialPaneFor() 还不知道它是
      // fullWidth，会先按 list 处理导致内容被 body.mobile-pane-list 隐藏；等它注册
      // 后必须按真实 fullWidth 重新计算一次，否则日志 / 欢迎页首次进入就是空白。
      if (id && id === router.active()) setPane(initialPaneFor(id))
      syncTitle()
      syncTabs()
    }),
    events.on('view:unregistered', ({ id } = {}) => {
      if (!id || id === router.active()) setPane(initialPaneFor(router.active()))
      syncTitle()
      syncTabs()
    }),
    events.on('settings:opened', () => {
      settingsOpen = true
      document.body.classList.add('mobile-settings-open')
      syncTitle()
      syncTabs()
      syncBack()
      syncSettingsNavScroll()
    }),
    events.on('settings:page-changed', () => {
      if (settingsOpen) syncSettingsNavScroll()
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
    disposeScrollChaining?.()
    backBtn?.removeEventListener('click', onBack)
    tabsEl?.removeEventListener('click', onTabsClick)
    document.removeEventListener('click', onCaptureClick, true)
    document.querySelector('.mobile-topbar')?.remove()
    document.querySelector('.mobile-tabbar')?.remove()
    document.documentElement.removeAttribute('data-mobile-layout')
    document.body.classList.remove('mobile-layout', 'mobile-pane-main', 'mobile-pane-list', 'mobile-settings-open')
  })

}
