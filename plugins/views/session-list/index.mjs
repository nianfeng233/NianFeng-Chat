/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * V7 · session-list
 * 会话列表：搜索、选中/取消、右键菜单（重命名 / 删除 / 清空）、紧凑模式搜索浮层。
 */
export const name = 'session-list'
export const version = '1.0.0'
export const displayName = '会话列表'
export const description = '视觉内容 · 会话列表与搜索。'
export const author = '念风内核'
export const icon = '📋'
export const core = true
export const depends = {
  'context-menu-host': '>=1.0.0',
  'event-bus': '*',
  'i18n': '>=2.0.0',
  'left-list-panel': '^1.0.0',
  'modal-host': '>=1.0.0',
  'session-service': '^2.0.0',
  'slots': '*',
  'toast-host': '>=1.0.0',
}
export const optionalDepends = {}
export const inject = ['slots', 'session-service', 'event-bus', 'modal', 'context-menu', 'toast', 'i18n']

import { useStyle } from '../../../src/util/style.mjs'
import { SESSION_LIST_CSS } from './style.mjs'
import { escapeHtml, listTime } from '../../../src/util/format.mjs'
import { icons } from '../../../src/util/icons.mjs'
import { characterAvatarHtml } from '../../../src/util/identity.mjs'

export function apply(ctx) {
  const sessions = ctx.inject('session-service')
  const events = ctx.inject('event-bus')
  const modal = ctx.inject('modal')
  const menu = ctx.inject('context-menu')
  const toast = ctx.inject('toast')
  const i18n = ctx.inject('i18n')

  useStyle(ctx, SESSION_LIST_CSS)

  ctx.slots.register('chat:list', container => {
    container.innerHTML = `
      <div class="pane-head">
        <div class="search-box" id="convSearchBox">
          <span class="search-ico">${icons.search}</span>
          <input type="text" id="convSearchInput" placeholder="${i18n.t('chat.searchConv', '搜索会话')}" autocomplete="off" />
        </div>
        <button class="icon-btn" id="batchBtn" title="批量管理">${icons.check}</button>
        <button class="icon-btn" id="newConvBtn" title="新建会话 (Ctrl+N)">${icons.plus}</button>
      </div>
      <div class="batch-bar" id="batchBar" hidden>
        <span data-batch-count>已选 0</span>
        <button type="button" data-batch-all>全选</button>
        <button type="button" data-batch-export>导出 JSON</button>
        <button type="button" data-batch-delete class="danger">删除选中</button>
        <button type="button" data-batch-exit>退出</button>
      </div>
      <div class="sync-banner" id="syncBanner" style="display:none">
        <span id="syncBannerText"></span>
        <button class="sync-retry" id="syncRetry">重试</button>
      </div>
      <div class="scroll" id="convList"></div>
      <div class="search-popover" id="convSearchPopover">
        <span class="search-ico">${icons.search}</span>
        <input type="text" id="convSearchPopoverInput" placeholder="${i18n.t('chat.searchConv', '搜索会话')}" autocomplete="off" />
      </div>`

    const listEl = container.querySelector('#convList')
    const syncBanner = container.querySelector('#syncBanner')
    const syncBannerText = container.querySelector('#syncBannerText')
    const syncRetry = container.querySelector('#syncRetry')
    const newConvBtn = container.querySelector('#newConvBtn')
    const batchBtn = container.querySelector('#batchBtn')
    const batchBar = container.querySelector('#batchBar')
    const batchCount = container.querySelector('[data-batch-count]')
    const searchBox = container.querySelector('#convSearchBox')
    const searchInput = container.querySelector('#convSearchInput')
    const popover = container.querySelector('#convSearchPopover')
    const popoverInput = container.querySelector('#convSearchPopoverInput')
    const paneEl = container.closest('.list-pane')

    let keyword = ''
    let batchMode = false
    const batchSelected = new Set()

    const syncBatchBar = () => {
      if (!batchBar) return
      batchBar.hidden = !batchMode
      batchBtn?.classList.toggle('active', batchMode)
      if (batchCount) batchCount.textContent = `已选 ${batchSelected.size}`
    }
    const exitBatch = () => {
      batchMode = false
      batchSelected.clear()
      syncBatchBar()
      render()
    }

    const syncBannerState = () => {
      const status = sessions.status?.() || { source: 'local' }
      const offline = status.source !== 'server'
      syncBanner.style.display = offline ? '' : 'none'
      if (offline) {
        syncBannerText.textContent = status.error ? `离线模式：${status.error}` : '离线模式：后端未连接，数据暂存本地'
      }
    }

    const render = () => {
      const activeId = sessions.activeId()
      const q = keyword.toLowerCase()
      const list = sessions
        .list()
        .slice()
        .sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0))
        // 渠道自己的会话记录（如微信clawbot）只在「渠道详情 / 设置→聊天记录」里维护，
        // 不再作为普通会话显示，避免同一个角色出现两个入口、收到两份消息。
        .filter(conv => !conv.meta?.hiddenFromSessionList)
        .filter(conv => {
          if (!keyword) return true
          return conv.name.toLowerCase().includes(q) || String(conv.preview || '').toLowerCase().includes(q)
        })
      listEl.innerHTML = list
        .map(conv => {
          // 角色头像统一走 identity：自定义图片或首字色块，避免每个视图各写一份。
          const avatar = characterAvatarHtml(conv)
          const checked = batchSelected.has(conv.id)
          return `
          <div class="conv-item ${conv.id === activeId && !batchMode ? 'active' : ''} ${checked ? 'batch-checked' : ''}" data-id="${conv.id}">
            ${batchMode ? `<span class="conv-check">${checked ? icons.check : ''}</span>` : ''}
            ${avatar}
            <div class="conv-main">
              <div class="conv-top">
                <span class="conv-name">${escapeHtml(conv.name)}</span>
                <span class="conv-time">${escapeHtml(listTime(conv.updatedAt || conv.createdAt) || conv.time || '')}</span>
              </div>
              <div class="conv-msg">${escapeHtml(conv.preview || '')}</div>
            </div>
            ${batchMode ? '' : `<button class="conv-del" data-conv-delete="${conv.id}" title="删除会话">${icons.trash}</button>`}
          </div>`
        })
        .join('')
      if (!list.length) {
        listEl.innerHTML = keyword
          ? `<div class="empty-hint">没有匹配的会话</div>`
          : `<div class="empty-hint">还没有会话，点击右上角 + 开始</div>`
      }
      syncBannerState()
    }

    /* -------- 交互 -------- */
    const onClick = e => {
      const del = e.target.closest('[data-conv-delete]')
      if (del) {
        e.stopPropagation?.()
        const conv = sessions.get(del.dataset.convDelete)
        if (conv) removeConversation(conv)
        return
      }
      const item = e.target.closest('.conv-item')
      if (!item) return
      if (batchMode) {
        if (batchSelected.has(item.dataset.id)) batchSelected.delete(item.dataset.id)
        else batchSelected.add(item.dataset.id)
        syncBatchBar()
        render()
        return
      }
      sessions.toggle(item.dataset.id) // 再次点击已选中会话可取消
    }
    const onContextMenu = e => {
      const item = e.target.closest('.conv-item')
      e.preventDefault()
      if (item) {
        const conv = sessions.get(item.dataset.id)
        menu.open(e.clientX, e.clientY, [
          { label: '重命名会话', action: () => renameConversation(conv) },
          { label: '清空消息', action: () => clearConversation(conv) },
          { separator: true },
          { label: '删除会话', danger: true, action: () => removeConversation(conv) },
        ], { target: conv })
      } else {
        menu.open(e.clientX, e.clientY, [{ label: '新建会话', action: () => createConversation() }])
      }
    }
    const onCreateShortcut = () => createConversation()

    listEl.addEventListener('click', onClick)
    listEl.addEventListener('contextmenu', onContextMenu)
    newConvBtn.addEventListener('click', onCreateShortcut)

    const onToggleBatch = () => {
      batchMode = !batchMode
      batchSelected.clear()
      syncBatchBar()
      render()
    }
    batchBtn?.addEventListener('click', onToggleBatch)
    const onBatchBarClick = async event => {
      const button = event.target.closest('button')
      if (!button) return
      if (button.dataset.batchAll !== undefined) {
        const list = sessions.list().filter(conv => !conv.meta?.hiddenFromSessionList)
        const allSelected = list.every(conv => batchSelected.has(conv.id))
        batchSelected.clear()
        if (!allSelected) for (const conv of list) batchSelected.add(conv.id)
        syncBatchBar()
        render()
      } else if (button.dataset.batchExport !== undefined) {
        if (!batchSelected.size) return toast.info('请先选择会话')
        const exportService = ctx.registry.get('export-service')
        if (!exportService?.exportMany) return toast.warn('导出服务未启用')
        Promise.resolve(exportService.exportMany([...batchSelected], 'json')).catch(err =>
          toast.error(`导出失败：${err?.message || err}`),
        )
      } else if (button.dataset.batchDelete !== undefined) {
        if (!batchSelected.size) return toast.info('请先选择会话')
        const confirmed = await modal.open({
          title: `删除选中的 ${batchSelected.size} 个会话`,
          description: '会话与消息将被删除，此操作不可撤销。',
          confirmText: '删除',
        })
        if (!confirmed?.ok) return
        let count = 0
        for (const id of [...batchSelected]) {
          if (sessions.remove(id)) count += 1
        }
        toast.warn(`已删除 ${count} 个会话`)
        exitBatch()
      } else if (button.dataset.batchExit !== undefined) {
        exitBatch()
      }
    }
    batchBar?.addEventListener('click', onBatchBarClick)
    syncRetry.addEventListener('click', async () => {
      syncRetry.disabled = true
      syncRetry.textContent = '同步中…'
      try {
        await sessions.sync()
        toast.success('已与后端同步')
      } catch (err) {
        toast.error(`同步失败：${err.message}`)
      } finally {
        syncRetry.disabled = false
        syncRetry.textContent = '重试'
        syncBannerState()
      }
    })
    const shortcuts = ctx.registry.get('shortcuts')
    const offShortcut = shortcuts?.register('Ctrl+N', onCreateShortcut, { label: '新建会话', owner: ctx.id })
    const offFocusSearch = shortcuts?.register('Ctrl+K', () => {
      if (ctx.registry.get('view-router')?.active() !== 'chat') ctx.registry.get('view-router')?.switch('chat')
      setTimeout(() => {
        if (paneEl?.classList.contains('compact')) {
          popover.classList.add('show')
          popoverInput.focus()
        } else searchInput.focus()
      }, 40)
    }, { label: '搜索会话', owner: ctx.id })

    /* -------- 搜索 -------- */
    const onSearch = () => {
      keyword = searchInput.value.trim()
      render()
    }
    searchInput.addEventListener('input', onSearch)
    popoverInput.addEventListener('input', () => {
      keyword = popoverInput.value.trim()
      render()
    })
    popoverInput.addEventListener('keydown', e => {
      if (e.key === 'Escape') hidePopover()
      if (e.key === 'Enter') {
        searchInput.value = popoverInput.value
        hidePopover()
      }
    })

    const onDocClick = e => {
      if (paneEl?.classList.contains('compact') && e.target.closest('#convSearchBox')) {
        if (!popover.classList.contains('show')) {
          placePopover()
          popover.classList.add('show')
          popoverInput.value = searchInput.value
          setTimeout(() => popoverInput.focus(), 20)
        }
      }
    }
    const placePopover = () => {
      if (!paneEl?.classList.contains('compact')) {
        if (popover.parentElement !== container) container.appendChild(popover)
        popover.style.position = ''
        popover.style.left = ''
        popover.style.top = ''
        popover.style.width = ''
        return
      }
      // 放进 body：父级玻璃板的 backdrop-filter 会成为 fixed 定位的包含块，
      // 留在窄面板里会被裁切。
      if (popover.parentElement !== document.body) document.body.appendChild(popover)
      const rect = searchBox.getBoundingClientRect()
      const width = Math.max(200, Math.min(300, (window.innerWidth || 1024) - rect.left - 12))
      popover.style.position = 'fixed'
      popover.style.left = `${Math.round(rect.left)}px`
      popover.style.top = `${Math.round(rect.bottom + 8)}px`
      popover.style.width = `${Math.round(width)}px`
    }
    const onWindowResize = () => {
      if (popover.classList.contains('show')) placePopover()
    }
    window.addEventListener('resize', onWindowResize)
    const onDocDown = e => {
      if (!popover.classList.contains('show')) return
      if (popover.contains(e.target)) return
      if (e.target.closest('#convSearchBox')) return
      hidePopover()
    }
    const hidePopover = () => {
      popover.classList.remove('show')
      if (!paneEl?.classList.contains('compact') && popover.parentElement !== container) container.appendChild(popover)
    }
    document.addEventListener('click', onDocClick)
    document.addEventListener('mousedown', onDocDown)

    /* -------- 事件订阅 -------- */
    const offs = [
      events.on('conversation:create', render),
      events.on('conversation:update', render),
      events.on('conversation:delete', render),
      events.on('conversation:switch', render),
      events.on('message:added', render),
      events.on('message:done', render),
      events.on('i18n:changed', () => {
        searchInput.placeholder = i18n.t('chat.searchConv', '搜索会话')
        popoverInput.placeholder = searchInput.placeholder
      }),
      events.on('list-panel:resized', ({ compact }) => {
        if (!compact) hidePopover()
        else if (popover.classList.contains('show')) placePopover()
      }),
      events.on('sessions:source', syncBannerState),
      events.on('sessions:synced', () => {
        syncBannerState()
        render()
      }),
      events.on('conversation:sync', render),
      events.on('backend:status', syncBannerState),
    ]

    render()
    return () => {
      offs.forEach(off => off())
      listEl.removeEventListener('click', onClick)
      listEl.removeEventListener('contextmenu', onContextMenu)
      newConvBtn.removeEventListener('click', onCreateShortcut)
      batchBtn?.removeEventListener('click', onToggleBatch)
      batchBar?.removeEventListener('click', onBatchBarClick)
      searchInput.removeEventListener('input', onSearch)
      document.removeEventListener('click', onDocClick)
      document.removeEventListener('mousedown', onDocDown)
      window.removeEventListener('resize', onWindowResize)
      offShortcut?.()
      offFocusSearch?.()
      popover.remove?.()
      container.innerHTML = ''
    }
  })

  /* -------- 会话操作 -------- */
  async function renameConversation(conv) {
    const result = await modal.prompt({ title: '重命名会话', value: conv.name, maxlength: 16 })
    if (!result.ok || !result.value.trim()) return
    sessions.rename(conv.id, result.value.trim())
    toast.success('已重命名')
  }

  async function removeConversation(conv) {
    const result = await modal.open({ title: `删除会话「${conv.name}」`, description: '会话与消息将被删除，此操作不可撤销。', confirmText: '删除' })
    if (!result.ok) return
    sessions.remove(conv.id)
    toast.warn('会话已删除')
  }

  async function clearConversation(conv) {
    const result = await modal.confirm('清空消息', `将清空「${conv.name}」的全部消息，设置与渠道不受影响。`)
    if (!result.ok) return
    sessions.clearMessages(conv.id)
    conv.preview = ''
    toast.info('消息已清空')
  }

  function createConversation() {
    // 新建会话先走「捏人窗口」：角色名 / 人格 / 模型 / 头像
    const editor = ctx.registry.get('character-editor')
    if (editor?.openCreate) {
      editor.openCreate()
      return
    }
    const conv = sessions.create({ name: '新的会话' })
    sessions.activate(conv.id)
    toast.success('已创建新会话')
  }
}
