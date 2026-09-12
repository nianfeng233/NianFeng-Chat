/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * V6 · chat-view
 * 会话视图入口：注册 'chat' 视图，负责主面板骨架与"未选择会话"空状态。
 * 具体内容由 V7 session-list / V8 chat-header / V9 message-list / V11 composer 填充。
 */
export const name = 'chat-view'
export const version = '1.0.0'
export const displayName = '会话视图'
export const description = '视觉内容 · 会话视图入口与主面板骨架。'
export const author = '念风内核'
export const icon = '💬'
export const core = true
export const depends = { 'right-main-panel': '^1.0.0', 'left-list-panel': '^1.0.0', 'view-router': '^1.0.0' }
export const inject = ['slots', 'view-router', 'session-service', 'event-bus']
export const provides = [{ name: 'chat-view', type: 'singleton' }]

import { useStyle } from '../../../src/util/style.mjs'
import { CHAT_VIEW_CSS } from './style.mjs'
import { icons } from '../../../src/util/icons.mjs'

export function apply(ctx) {
  const router = ctx.inject('view-router')
  const sessions = ctx.inject('session-service')
  const events = ctx.inject('event-bus')

  useStyle(ctx, CHAT_VIEW_CSS)

  const refs = { main: null, empty: null, title: null, sub: null }
  const readyCallbacks = []

  ctx.slots.define('chat:list', { description: '会话列表' })
  ctx.slots.define('chat:header', { description: '会话头部' })
  ctx.slots.define('chat:messages', { description: '消息滚动区' })
  ctx.slots.define('chat:composer', { description: '输入区' })

  const toggleEmpty = () => {
    const conv = sessions.active()
    if (!refs.main || !refs.empty) return
    refs.main.style.display = conv ? '' : 'none'
    refs.empty.style.display = conv ? 'none' : ''
  }

  router.register('chat', {
    label: '会话',
    icon: icons.chat,
    order: 10,

    list(container) {
      container.innerHTML = `<div class="chat-list-slot" data-slot="chat:list"></div>`
      return () => {
        container.innerHTML = ''
      }
    },

    main(container) {
      container.innerHTML = `
        <div class="pane-view" data-pane="chat-main" id="chatMain">
          <div data-slot="chat:header"></div>
          <div class="chat-messages" data-slot="chat:messages"></div>
          <div data-slot="chat:composer"></div>
        </div>
        <div class="pane-view" data-pane="chat-empty" id="chatEmpty">
          <div class="empty-state">
            ${icons.chat}
            <div class="empty-title" id="chatEmptyTitle">选择一个会话开始聊天</div>
            <div class="empty-sub">再次点击已选中的会话可以取消选择</div>
          </div>
        </div>`
      refs.main = container.querySelector('#chatMain')
      refs.empty = container.querySelector('#chatEmpty')
      toggleEmpty()

      // 主题/文案变化时刷新空状态文案
      const offI18n = ctx.on('i18n:changed', () => {
        const title = container.querySelector('#chatEmptyTitle')
        if (title) title.textContent = ctx.registry.get('i18n')?.t('chat.empty', '选择一个会话开始聊天') || title.textContent
      })

      queueMicrotask(() => {
        for (const cb of readyCallbacks.splice(0)) cb(refs)
        events.emit('chat:view-mounted', refs)
      })

      return () => {
        offI18n()
        container.innerHTML = ''
        refs.main = refs.empty = null
      }
    },
  })

  ctx.on('conversation:switch', toggleEmpty)
  ctx.on('conversation:delete', toggleEmpty)

  ctx.provide('chat-view', {
    name: 'chat-view',
    refs,
    onReady(cb) {
      if (refs.main) cb(refs)
      else {
        readyCallbacks.push(cb)
        ctx.once('chat:view-mounted', cb)
      }
    },
  }, { type: 'singleton' })

  ctx.logger.debug('会话视图就绪')
}
