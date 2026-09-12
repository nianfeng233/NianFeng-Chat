/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * V24 · global-search
 * 全局搜索浮层：侧栏搜索按钮或 Ctrl+Shift+F 打开，
 * 聚合 search-service 里的会话、消息、渠道、插件与设置页结果。
 *
 * 搜索本身是 D8 search-service 的职责；本插件只负责入口、键盘交互和呈现，
 * 点击结果通过 search-service.run() 派发到真正的业务服务。
 */
export const name = 'global-search'
export const version = '1.0.0'
export const displayName = '全局搜索'
export const description = '视觉内容 · 跨会话 / 消息 / 渠道 / 插件 / 设置的搜索浮层。'
export const author = '念风内核'
export const icon = '🔍'
export const core = false
export const depends = { 'search-service': '^1.0.0', rail: '^1.0.0' }
export const inject = ['slots', 'search-service', 'event-bus', 'shortcuts?', 'toast']
export const provides = [{ name: 'global-search', type: 'singleton' }]

import { useStyle } from '../../../src/util/style.mjs'
import { GLOBAL_SEARCH_CSS } from './style.mjs'
import { escapeHtml } from '../../../src/util/format.mjs'
import { icons } from '../../../src/util/icons.mjs'

const GROUP_META = {
  conversation: { label: '会话', icon: icons.chat },
  message: { label: '消息', icon: icons.search },
  channel: { label: '渠道', icon: icons.channel },
  plugin: { label: '插件', icon: icons.plugin },
  setting: { label: '设置', icon: icons.settings },
}
const GROUP_ORDER = ['conversation', 'message', 'channel', 'plugin', 'setting']

export function apply(ctx) {
  const search = ctx.inject('search-service')
  const shortcuts = ctx.inject('shortcuts')
  const toast = ctx.inject('toast')

  useStyle(ctx, GLOBAL_SEARCH_CSS)

  let root = null
  let input = null
  let bodyEl = null
  let footEl = null
  let items = []
  let activeIndex = -1
  let query = ''
  let timer = null

  const ensureRoot = () => {
    if (root) return root
    root = document.createElement('div')
    root.className = 'gsearch-mask'
    root.innerHTML = `
      <section class="gsearch-panel" role="dialog" aria-modal="true" aria-label="全局搜索">
        <div class="gsearch-head">
          <span class="gsearch-ico">${icons.search}</span>
          <input class="gsearch-input" id="globalSearchInput" type="text" autocomplete="off"
            placeholder="搜索会话、消息、渠道、插件和设置…" />
          <kbd class="gsearch-kbd">Esc</kbd>
        </div>
        <div class="gsearch-body" id="globalSearchBody"></div>
        <div class="gsearch-foot" id="globalSearchFoot"></div>
      </section>`
    document.body.appendChild(root)
    input = root.querySelector('#globalSearchInput')
    bodyEl = root.querySelector('#globalSearchBody')
    footEl = root.querySelector('#globalSearchFoot')

    const onMaskDown = event => {
      if (event.target === root) close()
    }
    input.addEventListener('input', onInput)
    input.addEventListener('keydown', onInputKey)
    root.addEventListener('mousedown', onMaskDown)
    root._cleanup = () => {
      input?.removeEventListener('input', onInput)
      input?.removeEventListener('keydown', onInputKey)
      root?.removeEventListener('mousedown', onMaskDown)
    }
    return root
  }

  /** 逐项直接绑定 click：真实浏览器与测试用的极简 DOM 垫片都没有可靠的冒泡委托 */
  const bindItemClicks = () => {
    if (!bodyEl) return
    bodyEl.querySelectorAll('.gsearch-item').forEach(button => {
      button.addEventListener('click', event => {
        event.stopPropagation?.()
        runResult(items[Number(button.dataset.gsearchIndex)])
      })
    })
  }

  const paintActive = () => {
    if (!bodyEl) return
    const buttons = bodyEl.querySelectorAll('.gsearch-item')
    buttons.forEach((button, index) => button.classList.toggle('active', index === activeIndex))
    bodyEl.querySelector('.gsearch-item.active')?.scrollIntoView?.({ block: 'nearest' })
  }

  const render = () => {
    if (!root || !bodyEl) return
    const q = String(query || '').trim()
    items = []
    activeIndex = -1
    if (!q) {
      bodyEl.innerHTML = '<div class="gsearch-empty">输入关键词，搜索会话、消息、渠道、插件和设置</div>'
      footEl.textContent = 'Enter 打开 · Esc 关闭'
      return
    }
    const result = search.search(q)
    const groups = result?.groups || {}
    const types = [...GROUP_ORDER, ...Object.keys(groups).filter(type => !GROUP_ORDER.includes(type))]
    let html = ''
    for (const type of types) {
      const list = groups[type]
      if (!list?.length) continue
      const meta = GROUP_META[type] || { label: type, icon: icons.search }
      html += `<div class="gsearch-group"><div class="gsearch-group-title"><span>${meta.label}</span><i>${list.length}</i></div>`
      for (const item of list) {
        const index = items.length
        items.push(item)
        html += `<button class="gsearch-item" type="button" data-gsearch-index="${index}">
          <span class="gsearch-item-title">${escapeHtml(item.title || '')}</span>
          <span class="gsearch-item-snippet">${escapeHtml(item.snippet || '')}</span>
        </button>`
      }
      html += '</div>'
    }
    bodyEl.innerHTML =
      html || `<div class="gsearch-empty">没有找到「${escapeHtml(q)}」相关的会话、消息、渠道、插件或设置</div>`
    bindItemClicks()
    footEl.textContent = items.length
      ? `${items.length} 个结果 · ↑↓ 选择 · Enter 打开 · Esc 关闭`
      : '换个关键词试试 · Esc 关闭'
  }

  const open = () => {
    ensureRoot()
    root.classList.add('show')
    input.value = query
    render()
    setTimeout(() => {
      input.focus()
      input.select?.()
    }, 20)
  }

  const close = () => {
    if (!root) return
    clearTimeout(timer)
    timer = null
    root.classList.remove('show')
  }

  const isOpen = () => !!root?.classList.contains('show')

  const runResult = result => {
    if (!result) return
    close()
    try {
      search.run(result)
    } catch (err) {
      toast.error(`打开搜索结果失败：${err.message}`)
    }
  }

  const onInput = () => {
    query = input.value
    clearTimeout(timer)
    timer = setTimeout(render, 110)
  }

  const onInputKey = event => {
    if (event.key === 'Escape') {
      event.preventDefault()
      close()
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!items.length) return
      event.preventDefault()
      const delta = event.key === 'ArrowDown' ? 1 : -1
      activeIndex = (activeIndex + delta + items.length) % items.length
      paintActive()
      return
    }
    if (event.key === 'Enter') {
      if (activeIndex < 0 || !items[activeIndex]) return
      event.preventDefault()
      runResult(items[activeIndex])
    }
  }

  /* ---------------- 侧栏入口 ---------------- */
  ctx.slots.register('rail:bottom', container => {
    const button = document.createElement('button')
    button.className = 'rail-btn'
    button.id = 'globalSearchBtn'
    button.title = '全局搜索 (Ctrl+Shift+F)'
    button.dataset.action = 'global-search'
    button.innerHTML = icons.search
    container.appendChild(button)
    const onClick = () => open()
    button.addEventListener('click', onClick)
    return () => {
      button.removeEventListener('click', onClick)
      button.remove()
    }
  }, { order: 9 })

  /* ---------------- 快捷键 / 服务 ---------------- */
  const offShortcut = shortcuts?.register('Ctrl+Shift+F', open, { label: '全局搜索', owner: ctx.id })

  ctx.provide('global-search', {
    name: 'global-search',
    open,
    close,
    isOpen,
  }, { type: 'singleton' })

  ctx.effect(() => {
    offShortcut?.()
    close()
    root?._cleanup?.()
    root?.remove()
    root = null
  })

  ctx.logger.debug('全局搜索浮层就绪')
}
