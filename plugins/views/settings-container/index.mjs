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
export const depends = {
  'event-bus': '*',
  'settings-view': '^1.0.0',
  'slots': '*',
}
export const optionalDepends = {
  'i18n': '>=2.0.0',
}
export const inject = ['slots', 'event-bus', 'i18n?']
export const provides = [{ name: 'settings-container', type: 'singleton' }]

import { useStyle } from '../../../src/util/style.mjs'
import { SETTINGS_CONTAINER_CSS } from './style.mjs'

export function apply(ctx) {
  const events = ctx.inject('event-bus')
  const i18n = ctx.inject('i18n?')
  useStyle(ctx, SETTINGS_CONTAINER_CSS)

  /** id -> { id, group, label, icon, order, render } */
  const pages = new Map()
  const navHosts = new Map()
  let contentEl = null
  let activeId = null
  let cleanupCurrent = null
  let navSearchQuery = ''
  let settingItems = null
  let searchResults = []

  const sorted = () =>
    [...pages.values()].sort((a, b) => (a.groupOrder ?? 0) - (b.groupOrder ?? 0) || a.order - b.order)

  /** 入口已独立到侧栏 / 其它位置的页面可标记 hidden：仍能 open(id)，但不占用设置导航。 */
  const navPages = () => sorted().filter(page => !page.hidden)
  // ------------------------------------------------------------------
  // 设置项搜索：设置页标签只够找到“页面”，这里进一步索引每一行设置项，
  // 支持直接输入“声音”“代理”“上下文”等关键词定位并跳转。
  // 索引通过把设置页渲染到离屏节点构建，渲染完立即 cleanup，不污染当前页面。
  // ------------------------------------------------------------------
  const stripHtml = value => String(value ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()

  const buildIndexForPage = page => {
    const host = document.createElement('div')
    let cleanup = null
    const items = []
    const previousSearchIndexing = ctx.__settingsSearchIndexing
    try {
      ctx.__settingsSearchIndexing = true
      cleanup = page.render(host, ctx)
      const rows = [...host.querySelectorAll('.setting-row')]
      rows.forEach((row, rowIndex) => {
        const name = stripHtml(row.querySelector('.setting-name')?.textContent || '')
        if (!name) return
        const help = stripHtml(row.querySelector('.setting-help')?.textContent || '')
        const section = stripHtml(row.closest('.settings-section')?.querySelector('.settings-section-title')?.textContent || '')
        items.push({
          pageId: page.id,
          group: page.group || '',
          pageLabel: page.label || page.id,
          section,
          name,
          help,
          rowIndex,
          haystack: `${page.group || ''} ${page.label || ''} ${section} ${name} ${help}`.toLowerCase(),
        })
      })
      if (!items.length) {
        items.push({
          pageId: page.id,
          group: page.group || '',
          pageLabel: page.label || page.id,
          section: '',
          name: page.label || page.id,
          help: page.description || '',
          rowIndex: -1,
          haystack: `${page.group || ''} ${page.label || ''} ${page.description || ''}`.toLowerCase(),
        })
      }
    } catch (err) {
      ctx.logger.warn?.(`构建设置搜索索引时跳过 ${page.id}：${err.message}`)
    } finally {
      try {
        ctx.__settingsSearchIndexing = previousSearchIndexing
          if (typeof cleanup === 'function') cleanup()
      } catch (_) {
        /* ignore */
      }
    }
    return items
  }

  const getSettingItems = () => {
    if (settingItems) return settingItems
    const list = []
    for (const page of navPages()) list.push(...buildIndexForPage(page))
    const seen = new Set()
    settingItems = list.filter(item => {
      const key = `${item.pageId}:${item.rowIndex}:${item.name}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    return settingItems
  }

  const searchSettingItems = query => {
    const terms = String(query || '').toLowerCase().split(/\s+/).filter(Boolean)
    if (!terms.length) return []
    return getSettingItems()
      .map(item => {
        const name = item.name.toLowerCase()
        let score = 0
        for (const term of terms) {
          if (!item.haystack.includes(term)) return null
          if (name === term) score += 100
          else if (name.startsWith(term)) score += 70
          else if (name.includes(term)) score += 45
          else score += 10
        }
        return { ...item, score }
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score || a.rowIndex - b.rowIndex)
      .slice(0, 30)
  }

  const iconOfPage = id => pages.get(id)?.icon || ''

  const escapeText = value =>
    String(value ?? '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]))

  const focusSettingItem = item => {
    if (!item || !contentEl) return
    const locate = () => {
      if (!contentEl) return
      const rows = [...contentEl.querySelectorAll('.setting-row')]
      const nameOf = row => stripHtml(row.querySelector('.setting-name')?.textContent || '')
      let target = item.rowIndex >= 0 ? rows[item.rowIndex] : null
      if (!target || nameOf(target) !== item.name) target = rows.find(row => nameOf(row) === item.name) || target
      if (!target) return
      try {
        target.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
      } catch (_) {
        try {
          target.scrollIntoView?.()
        } catch (_) {
          /* ignore */
        }
      }
      target.classList.add('settings-search-hit')
      setTimeout(() => target.classList.remove('settings-search-hit'), 2400)
    }
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(locate)
    else setTimeout(locate, 0)
  }


  const renderNav = () => {
    for (const host of navHosts.values()) {
      const searchQuery = navSearchQuery.trim()
      if (searchQuery) {
        const lower = searchQuery.toLowerCase()
        const pageMatches = navPages().filter(page =>
          `${page.group || ''} ${page.label || ''} ${page.description || ''}`.toLowerCase().includes(lower),
        )
        searchResults = searchSettingItems(searchQuery)
        const pageButtons = pageMatches
          .map(
            page => `<button class="settings-nav-item ${page.id === activeId ? 'active' : ''}" data-page="${page.id}">
              ${page.icon || ''}<span class="nav-label">${escapeText(page.label)}</span>
            </button>`,
          )
          .join('')
        const itemButtons = searchResults
          .map(
            (item, index) => `<button class="settings-nav-item settings-nav-result ${item.pageId === activeId ? 'active' : ''}" data-page="${item.pageId}" data-settings-item="${index}">
              ${iconOfPage(item.pageId)}<span class="nav-label">${escapeText(item.name)}</span>
              <span class="settings-result-hint">${escapeText(item.section || item.pageLabel)}</span>
            </button>`,
          )
          .join('')
        host.innerHTML = `
          <div class="settings-nav-group settings-nav-search-results">
            <div class="settings-nav-head">搜索结果</div>
            ${pageButtons}${itemButtons}
            ${!pageButtons && !itemButtons ? '<div class="settings-nav-empty">没有找到匹配的设置项</div>' : ''}
          </div>`
        continue
      }
      searchResults = []
      const groups = new Map()
      for (const page of navPages()) {
        if (!groups.has(page.group)) groups.set(page.group, [])
        groups.get(page.group).push(page)
      }
      const query = navSearchQuery.trim().toLowerCase()
      host.innerHTML = [...groups.entries()]
        .map(
          ([group, list]) => `
          <div class="settings-nav-group">
            <div class="settings-nav-head">${group}</div>
            ${list
              .map(
                page => `<button class="settings-nav-item ${page.id === activeId ? 'active' : ''}" data-page="${page.id}" data-settings-label="${escapeAttr(
                  `${group} ${page.label}`,
                )}">
                  ${page.icon || ''}<span class="nav-label">${page.label}</span>
                </button>`,
              )
              .join('')}
          </div>`,
        )
        .join('')
      if (!query) continue
      for (const groupEl of host.querySelectorAll('.settings-nav-group')) {
        let visible = 0
        for (const item of groupEl.querySelectorAll('.settings-nav-item')) {
          const match = String(item.dataset.settingsLabel || '').toLowerCase().includes(query)
          item.hidden = !match
          if (match) visible += 1
        }
        groupEl.hidden = visible === 0
      }
    }
  }

  const openPage = (id, options = {}) => {
    const page = pages.get(id) || pages.get('account') || navPages()[0] || sorted()[0]
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
    focusSettingItem(options?.item)
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
        settingItems = null
        searchResults = []
        if (activeId === page.id) openPage('account')
        else renderNav()
      }
      settingItems = null
      searchResults = []
      ctx.effect(disposer)
      renderNav()
      if (!activeId) openPage(page.hidden ? pages.get('account')?.id || navPages()[0]?.id : page.id)
      events.emit('settings:page-registered', { id: page.id, label: page.label })
      return disposer
    },
    list: () => sorted(),
    /** 设置项搜索：返回 { pageId, pageLabel, section, name, help, rowIndex }[]，供界面与测试使用。 */
    searchItems: query => searchSettingItems(query),
    open: openPage,
    active: () => activeId,
    async enablePlugin(id) {
      return ctx.registry.get('plugin-manager')?.enable?.(id)
    },
  }

  ctx.slots.register('settings:nav', container => {
    container.innerHTML = `
      <label class="settings-nav-search">
        <span>⌕</span>
        <input type="search" data-settings-search placeholder="${escapeAttr(i18n?.t?.('settings.search', '搜索设置…') || '搜索设置…')}" />
      </label>
      <div class="settings-nav-list" data-settings-nav-list></div>`
    const listEl = container.querySelector('[data-settings-nav-list]')
    navHosts.set(listEl, listEl)
    const searchInput = container.querySelector('[data-settings-search]')
    const onSearch = () => {
      navSearchQuery = searchInput.value
      renderNav()
    }
    const onClick = e => {
      const itemBtn = e.target.closest('[data-settings-item]')
      if (itemBtn) {
        const result = searchResults[Number(itemBtn.dataset.settingsItem)]
        if (result) openPage(result.pageId, { item: result })
        return
      }
      const btn = e.target.closest('.settings-nav-item')
      if (btn) openPage(btn.dataset.page)
    }
    searchInput.addEventListener('input', onSearch)
    container.addEventListener('click', onClick)
    renderNav()
    return () => {
      searchInput.removeEventListener('input', onSearch)
      container.removeEventListener('click', onClick)
      navHosts.delete(listEl)
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

function escapeAttr(value) {
  return String(value ?? '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[m])
}
