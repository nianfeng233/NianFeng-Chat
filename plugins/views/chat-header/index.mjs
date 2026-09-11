/**
 * V8 · chat-header
 * 会话头部：标题 / 模型实时运行状态 / 更多操作。
 * 去掉固定“在线”，改为展示 正在思考 / 正在调用 xx 工具 / 正在输入 等真实状态。
 */
export const name = 'chat-header'
export const version = '1.0.0'
export const displayName = '会话头部'
export const description = '视觉内容 · 会话标题、模型运行状态与操作区。'
export const author = '风语内核'
export const icon = '📌'
export const core = true
export const depends = { 'chat-view': '^1.0.0' }
export const inject = ['slots', 'session-service', 'event-bus', 'context-menu', 'toast', 'modal', 'i18n']

import { useStyle } from '../../../src/util/style.mjs'
import { CHAT_HEADER_CSS } from './style.mjs'
import { icons } from '../../../src/util/icons.mjs'

export function apply(ctx) {
  const sessions = ctx.inject('session-service')
  const events = ctx.inject('event-bus')
  const menu = ctx.inject('context-menu')
  const modal = ctx.inject('modal')
  const toast = ctx.inject('toast')

  useStyle(ctx, CHAT_HEADER_CSS)

  ctx.slots.register('chat:header', container => {
    container.innerHTML = `
      <header class="chat-header">
        <div class="slot-host" data-slot="chat:header:before-title"></div>
        <span class="chat-title" id="chatTitle">—</span>
        <span class="chat-sub" id="chatSub"></span>
        <div class="slot-host" data-slot="chat:header:after-title"></div>
        <div class="chat-actions" data-slot="chat:header:actions">
          <button class="icon-btn" id="chatMoreBtn" title="更多">${icons.more}</button>
        </div>
      </header>`

    const titleEl = container.querySelector('#chatTitle')
    const subEl = container.querySelector('#chatSub')
    const moreBtn = container.querySelector('#chatMoreBtn')

    /** conversationId -> { status:'thinking'|'tool'|'typing'|'idle', label, tool } */
    const liveStatus = new Map()

    const statusView = entry => {
      if (!entry) return { text: '空闲', className: 'idle' }
      if (entry.status === 'thinking') return { text: '正在思考…', className: 'thinking' }
      if (entry.status === 'typing') return { text: entry.label || '正在输入…', className: 'typing' }
      if (entry.status === 'tool') {
        return { text: entry.label || `正在调用 ${entry.tool || ''} 工具…`, className: 'tool' }
      }
      return { text: '空闲', className: 'idle' }
    }

    const render = () => {
      const conv = sessions.active()
      if (!conv) return
      titleEl.textContent = conv.name
      if (!conv.messages?.length) {
        subEl.textContent = ''
        subEl.className = 'chat-sub'
        subEl.dataset.live = '0'
        return
      }
      const view = statusView(liveStatus.get(conv.id))
      subEl.textContent = view.text
      subEl.className = `chat-sub ${view.className}`
      subEl.dataset.live = view.className === 'idle' ? '0' : '1'
    }

    const onMore = e => {
      const conv = sessions.active()
      if (!conv) return
      const rect = moreBtn.getBoundingClientRect()
      menu.open(rect.right - 178, rect.bottom + 6, [
        { header: '角色' },
        { label: '编辑角色 / 人格', action: () => ctx.registry.get('character-editor')?.openEdit(conv.id) },
        { separator: true },
        { header: '导出' },
        { label: 'Markdown', action: () => ctx.emit('export:conversation', { id: conv.id, format: 'markdown' }) },
        { label: 'HTML', action: () => ctx.emit('export:conversation', { id: conv.id, format: 'html' }) },
        { label: '纯文本 TXT', action: () => ctx.emit('export:conversation', { id: conv.id, format: 'txt' }) },
        { label: 'CSV', action: () => ctx.emit('export:conversation', { id: conv.id, format: 'csv' }) },
        { label: 'JSON', action: () => ctx.emit('export:conversation', { id: conv.id, format: 'json' }) },
        { label: '打印 / 另存为 PDF', action: () => ctx.emit('export:conversation', { id: conv.id, format: 'pdf' }) },
        { separator: true },
        { header: '会话' },
        {
          label: '重命名会话',
          action: async () => {
            const res = await modal.prompt({ title: '重命名会话', value: conv.name, placeholder: '新的会话名称', maxlength: 30 })
            if (res.ok && res.value) {
              sessions.rename(conv.id, res.value)
              toast.success('会话已重命名')
            }
          },
        },
        {
          label: '清空消息',
          action: async () => {
            const res = await modal.confirm('清空消息', `将清空「${conv.name}」的全部消息。`)
            if (res.ok) {
              sessions.clearMessages(conv.id)
              toast.info('消息已清空')
            }
          },
        },
        { separator: true },
        {
          label: '删除会话',
          danger: true,
          action: async () => {
            const res = await modal.confirm('删除会话', `将删除「${conv.name}」及其全部消息，且不可恢复。`)
            if (res.ok) {
              sessions.remove(conv.id)
              toast.success('会话已删除')
            }
          },
        },
      ], { target: conv })
    }
    moreBtn.addEventListener('click', onMore)

    const onStatus = payload => {
      if (!payload?.conversationId) return
      if (payload.status === 'idle') liveStatus.delete(payload.conversationId)
      else liveStatus.set(payload.conversationId, { ...payload, from: 'flow' })
      if (payload.conversationId === sessions.activeId()) render()
    }
    const onTyping = payload => {
      if (!payload?.conversationId) return
      const current = liveStatus.get(payload.conversationId)
      if (payload.typing) liveStatus.set(payload.conversationId, { status: 'typing', label: '正在输入…', from: 'typing-event' })
      else if (current?.from === 'typing-event') liveStatus.delete(payload.conversationId)
      if (payload.conversationId === sessions.activeId()) render()
    }

    const offs = [
      events.on('conversation:switch', render),
      events.on('conversation:update', render),
      events.on('message:added', render),
      events.on('message:done', render),
      events.on('chat:status', onStatus),
      events.on('chat:typing', onTyping),
    ]

    render()
    return () => {
      offs.forEach(off => off())
      moreBtn.removeEventListener('click', onMore)
      container.innerHTML = ''
    }
  })
}
