/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * V13 · channel-list
 * 渠道列表：分组折叠、右键菜单、渠道拖拽跨组、添加渠道。
 * 数据全部来自 channel-registry（D6），渠道类型来自渠道插件注册表。
 */
export const name = 'channel-list'
export const version = '1.0.0'
export const displayName = '渠道列表'
export const description = '视觉内容 · 渠道分组列表、拖拽排序与添加渠道。'
export const author = '念风内核'
export const icon = '🗂️'
export const core = true
export const depends = { 'left-list-panel': '^1.0.0', 'channel-registry': '^1.0.0' }
export const inject = ['slots', 'channel-registry', 'event-bus', 'context-menu', 'modal', 'toast', 'i18n']
export const provides = [{ name: 'channel-list', type: 'singleton' }]

import { useStyle } from '../../../src/util/style.mjs'
import { CHANNEL_LIST_CSS } from './style.mjs'
import { escapeHtml } from '../../../src/util/format.mjs'
import { icons } from '../../../src/util/icons.mjs'

const STATUS_COLOR = { online: '#70a15a', connecting: '#c9a227', offline: '#b3b9c2', error: '#c65b5b' }

export function apply(ctx) {
  const channels = ctx.inject('channel-registry')
  const events = ctx.inject('event-bus')
  const menu = ctx.inject('context-menu')
  const modal = ctx.inject('modal')
  const toast = ctx.inject('toast')
  const i18n = ctx.inject('i18n')

  useStyle(ctx, CHANNEL_LIST_CSS)

  let tab = 'private'
  let keyword = ''

  ctx.slots.register('channel:list', container => {
    container.innerHTML = `
      <div class="pane-head">
        <div class="search-box" id="channelSearchBox">
          <span class="search-ico">${icons.search}</span>
          <input type="text" id="channelSearchInput" placeholder="${i18n.t('chat.searchChannel', '搜索渠道')}" autocomplete="off" />
        </div>
      </div>

      <button class="add-channel" id="addChannelBtn">
        ${icons.plus}
        <span class="btn-text">${i18n.t('channel.add', '添加渠道')}</span>
      </button>

      <div class="nav-row" id="notifyRow">
        <span class="nav-ico">${icons.bell}</span>
        <span class="nav-text">消息通知</span>
        <span class="chev">${icons.chevronRight}</span>
      </div>

      <div class="tabs" id="channelTabs">
        <button class="tab active" data-tab="private"><span class="tab-full">私聊</span><span class="tab-short">私</span></button>
        <button class="tab" data-tab="group"><span class="tab-full">群聊</span><span class="tab-short">群</span></button>
        <button class="tab" data-tab="privacy"><span class="tab-full">隐私</span><span class="tab-short">隐</span></button>
      </div>

      <div class="scroll" id="groupsContainer"></div>`

    const groupsEl = container.querySelector('#groupsContainer')
    const tabsEl = container.querySelector('#channelTabs')
    const searchInput = container.querySelector('#channelSearchInput')
    const addBtn = container.querySelector('#addChannelBtn')
    const notifyRow = container.querySelector('#notifyRow')

    /* ---------------- 渲染 ---------------- */
    const render = () => {
      const active = channels.activeKey()
      const groups = channels.groups(tab)
      const q = keyword.toLowerCase()

      groupsEl.innerHTML = groups
        .map(group => {
          const list = group.channels.filter(ch => !q || ch.name.toLowerCase().includes(q) || ch.type.toLowerCase().includes(q))
          if (q && !list.length) return ''
          const body = list.length
            ? list
                .map(ch => {
                  const key = `${tab}:${ch.id}`
                  const dotColor = STATUS_COLOR[ch.status] || STATUS_COLOR.offline
                  return `
                    <div class="channel-item ${key === active ? 'active' : ''}" data-group-id="${group.id}" data-channel-id="${ch.id}">
                      <span class="dot" style="background:${dotColor}"></span>
                      <span class="channel-name">${escapeHtml(ch.name)}</span>
                    </div>`
                })
                .join('')
            : `<div class="empty-hint">暂无渠道</div>`
          return `
            <div class="group" data-id="${group.id}">
              <div class="group-head ${group.expanded ? 'expanded' : ''}" data-id="${group.id}">
                <span class="chev">${icons.chevronRight}</span>
                <span class="group-name">${escapeHtml(group.name)}</span>
                <span class="group-count">${group.channels.length}</span>
              </div>
              <div class="group-body" ${group.expanded ? '' : 'style="display:none"'}>${body}</div>
            </div>`
        })
        .join('')
      if (!groupsEl.innerHTML) groupsEl.innerHTML = `<div class="empty-hint" style="padding:18px 12px;text-align:center">没有匹配的渠道</div>`
    }

    /* ---------------- 点击 / 右键 ---------------- */
    const onClick = e => {
      if (suppressClick) return
      const head = e.target.closest('.group-head')
      if (head) {
        channels.toggleGroup(tab, head.dataset.id)
        return
      }
      const item = e.target.closest('.channel-item')
      if (item) {
        channels.activate(tab, item.dataset.channelId)
      }
    }

    const onContextMenu = e => {
      const head = e.target.closest('.group-head')
      const item = e.target.closest('.channel-item')
      if (head) {
        e.preventDefault()
        const group = channels.group(tab, head.dataset.id)
        menu.open(e.clientX, e.clientY, [
          { label: '重命名该分组', action: () => renameGroup(group) },
          { label: '添加分组', action: () => addGroup() },
          { separator: true },
          { label: '删除分组', danger: true, disabled: channels.groups(tab).length <= 1, action: () => removeGroup(group) },
        ], { target: group })
        return
      }
      if (item) {
        e.preventDefault()
        const channel = channels.findChannel(tab, item.dataset.channelId)
        menu.open(e.clientX, e.clientY, [
          { label: '查看详情', action: () => channels.activate(tab, channel.id) },
          { label: channel.status === 'online' ? '断开连接' : '重新连接', action: async () => {
            const online = channel.status === 'online'
            try {
              if (online) {
                await channels.disconnect(tab, channel.id)
                toast.info(`「${channel.name}」已断开`)
              } else {
                await channels.connect(tab, channel.id)
                toast.success(`「${channel.name}」已连接`)
              }
            } catch (err) {
              toast.error(`「${channel.name}」连接失败：${err.message}`)
            }
          } },
          { separator: true },
          { label: '移除渠道', danger: true, action: () => {
            channels.removeChannel(tab, channel.id)
            toast.warn(`已移除「${channel.name}」`)
          } },
        ], { target: channel })
      }
    }

    /* ---------------- 拖拽（demo 交互） ---------------- */
    let suppressClick = false
    let drag = null

    const onPointerDown = e => {
      if (e.button !== 0) return
      const item = e.target.closest('.channel-item')
      if (!item) return
      const startX = e.clientX
      const startY = e.clientY
      drag = { item, startX, startY, active: false, ghost: null, channelId: item.dataset.channelId }
    }

    const onPointerMove = e => {
      if (!drag) return
      const dx = e.clientX - drag.startX
      const dy = e.clientY - drag.startY
      if (!drag.active && Math.hypot(dx, dy) < 5) return
      if (!drag.active) {
        drag.active = true
        suppressClick = true
        document.body.classList.add('dragging-channel')
        const channel = channels.findChannel(tab, drag.channelId)
        drag.ghost = makeGhost(channel, e.clientX, e.clientY)
      }
      updateGhost(drag.ghost, e.clientX, e.clientY)
      updateDropTarget(e.clientX, e.clientY)
      e.preventDefault()
    }

    const onPointerUp = e => {
      if (!drag) return
      const { active, channelId } = drag
      const targetGroupId = active ? currentDropTarget : null
      cleanupDrag()
      if (!active) {
        drag = null
        return
      }
      suppressClick = true
      setTimeout(() => (suppressClick = false), 60)
      if (targetGroupId) {
        channels.moveChannel(tab, channelId, targetGroupId)
        toast.success('渠道已移动')
      }
      drag = null
    }

    const cleanupDrag = () => {
      document.body.classList.remove('dragging-channel')
      drag?.ghost?.remove()
      for (const el of groupsEl.querySelectorAll('.group.drop-target')) el.classList.remove('drop-target')
      currentDropTarget = null
    }

    let currentDropTarget = null
    const updateDropTarget = (x, y) => {
      const el = document.elementFromPoint(x, y)
      const groupEl = el?.closest('.group')
      const gid = groupEl?.dataset.id || null
      if (gid === currentDropTarget) return
      currentDropTarget = gid
      for (const node of groupsEl.querySelectorAll('.group')) node.classList.toggle('drop-target', node.dataset.id === gid)
    }

    const makeGhost = (channel, x, y) => {
      const rect = groupsEl.querySelector(`[data-channel-id="${channel?.id}"]`)?.getBoundingClientRect()
      const ghost = document.createElement('div')
      ghost.className = 'channel-ghost'
      ghost.innerHTML = `<span class="dot" style="background:${STATUS_COLOR[channel?.status] || STATUS_COLOR.offline}"></span>${escapeHtml(channel?.name || '')}`
      ghost._offsetX = rect ? x - rect.left : 20
      ghost._offsetY = rect ? y - rect.top : 14
      ghost.style.position = 'fixed'
      updateGhost(ghost, x, y)
      document.body.appendChild(ghost)
      return ghost
    }
    const updateGhost = (ghost, x, y) => {
      if (!ghost) return
      ghost.style.left = `${x - ghost._offsetX}px`
      ghost.style.top = `${y - ghost._offsetY}px`
    }

    groupsEl.addEventListener('click', onClick)
    groupsEl.addEventListener('contextmenu', onContextMenu)
    groupsEl.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)

    /* ---------------- 顶部操作 ---------------- */
    const onTabClick = e => {
      const btn = e.target.closest('.tab')
      if (!btn || btn.dataset.tab === tab) return
      tab = btn.dataset.tab
      tabsEl.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b === btn))
      channels.activate(null)
      render()
    }
    const onSearch = () => {
      keyword = searchInput.value.trim()
      render()
    }
    const onAdd = e => {
      const types = channels.typeList()
      const planned = channels.plannedList()
      const rect = addBtn.getBoundingClientRect()
      const items = []
      if (types.length) {
        items.push(...types.map(type => ({ label: `${type.icon || '＋'} ${type.name}`, action: () => createChannel(type.id) })))
      }
      if (planned.length) {
        if (items.length) items.push({ separator: true })
        items.push(
          ...planned.map(item => ({
            label: `${item.name} · 未实现`,
            disabled: true,
            action: () => toast.info(item.reason),
          })),
        )
      }
      if (!items.length) items.push({ label: '暂无可用的渠道类型插件', disabled: true })
      menu.open(rect.left, rect.bottom + 4, items)
    }
    const onNotify = () => ctx.emit('settings:open', { page: 'notifications' })

    tabsEl.addEventListener('click', onTabClick)
    searchInput.addEventListener('input', onSearch)
    addBtn.addEventListener('click', onAdd)
    notifyRow.addEventListener('click', onNotify)

    /* ---------------- 增删改 ---------------- */
    async function createChannel(type) {
      const typeDef = channels.type(type)
      // 渠道类型可以自带配置窗口（例如微信 Clawbot：角色 / 分类 / 权限 / 扫码登录）
      if (typeof typeDef?.create === 'function') {
        return typeDef.create({ tab, typeDef })
      }
      const result = await modal.prompt({
        title: `添加${typeDef?.name || '渠道'}`,
        value: '',
        placeholder: `渠道名称，如：我的${typeDef?.name || '渠道'}`,
        maxlength: 16,
      })
      if (!result.ok || !result.value.trim()) return
      const group = channels.groups(tab)[0]
      if (!group) {
        toast.error('请先创建分组')
        return
      }
      const channel = channels.addChannel(tab, group.id, { type, name: result.value.trim() })
      toast.success('渠道已添加')
      return channel
    }
    async function renameGroup(group) {
      const result = await modal.prompt({ title: '重命名分组', value: group.name, maxlength: 10 })
      if (!result.ok || !result.value.trim()) return
      channels.renameGroup(tab, group.id, result.value.trim())
    }
    function addGroup() {
      modal.prompt({ title: '添加分组', value: '', placeholder: '填写分组', maxlength: 10 }).then(result => {
        if (!result.ok || !result.value.trim()) return
        channels.addGroup(tab, result.value.trim())
        toast.success('分组已添加')
      })
    }
    async function removeGroup(group) {
      const result = await modal.open({ title: `删除分组「${group.name}」`, description: '分组内的渠道会一并移除。', confirmText: '删除' })
      if (!result.ok) return
      channels.removeGroup(tab, group.id)
    }

    /* ---------------- 事件 ---------------- */
    const offs = [
      events.on('channel:group-updated', render),
      events.on('channel:group-added', render),
      events.on('channel:group-removed', render),
      events.on('channel:add', render),
      events.on('channel:removed', render),
      events.on('channel:moved', render),
      events.on('channel:activated', render),
      events.on('channel:status', render),
      events.on('channel:type-registered', render),
      events.on('i18n:changed', () => {
        searchInput.placeholder = i18n.t('chat.searchChannel', '搜索渠道')
        addBtn.querySelector('.btn-text').textContent = i18n.t('channel.add', '添加渠道')
      }),
    ]

    render()
    return () => {
      offs.forEach(off => off())
      groupsEl.removeEventListener('click', onClick)
      groupsEl.removeEventListener('contextmenu', onContextMenu)
      groupsEl.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      tabsEl.removeEventListener('click', onTabClick)
      searchInput.removeEventListener('input', onSearch)
      addBtn.removeEventListener('click', onAdd)
      notifyRow.removeEventListener('click', onNotify)
      container.innerHTML = ''
    }
  })

  ctx.provide('channel-list', { name: 'channel-list' }, { type: 'singleton' })
}
