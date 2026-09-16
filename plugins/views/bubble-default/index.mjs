/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * V10 · bubble-default
 * 默认气泡实现（Telegram 风格 · 双勾 / 时间戳智能摆放）。
 * 注册到可选中服务 bubble-styles，用户在设置里切换即换渲染器（文档 §8.3）。
 */
export const name = 'bubble-default'
export const version = '1.0.0'
export const displayName = '默认气泡'
export const description = '可选中气泡 · Telegram 风格，双勾 / 时间戳智能摆放。'
export const author = '念风内核'
export const icon = '💠'
export const core = true
export const depends = {
  'config': '>=1.1.0',
  'event-bus': '*',
  'i18n': '>=2.0.0',
  'message-list': '^1.0.0',
}
export const optionalDepends = {
  'image-service': '>=1.0.0',
}
export const inject = ['bubble-styles', 'event-bus', 'i18n', 'config', 'image-service?']

import { useStyle } from '../../../src/util/style.mjs'
import { BUBBLE_DEFAULT_CSS } from './style.mjs'
import { escapeHtml, renderRichText } from '../../../src/util/format.mjs'
import { icons } from '../../../src/util/icons.mjs'
import { looksLikeToolMarkup } from '../../../src/util/tool-text.mjs'
import { characterAvatarHtml, userAvatarHtml } from '../../../src/util/identity.mjs'

export function apply(ctx) {
  const bubbles = ctx.inject('bubble-styles')
  const imageService = ctx.inject('image-service?')
  const config = ctx.inject('config')
  useStyle(ctx, BUBBLE_DEFAULT_CSS)

  const renderRow = (message, conversation, view = {}) => {
    const isMe = message.role === 'user'
    // 头像统一走 identity：用户头像默认念风 logo 并可随 ui.avatarImage 更换；
    // 角色头像统一为自定义图片或“名字首字 + 调色板”色块。
    const avatar = isMe ? userAvatarHtml(config) : characterAvatarHtml(conversation)

    // 防御历史脏数据：旧版本可能把模型自创的工具标记存成 assistant 正文，
    // 这里在渲染层再次兜底，绝不把原始标记展示出来。
    const rawContent = String(message.content || '')
    let body =
      message.role === 'assistant' && looksLikeToolMarkup(rawContent)
        ? '<div class="bubble-tool-hidden">🛠️ 工具调用标记已隐藏</div>'
        : ctx.registry.get('markdown')?.render?.(message.content) ?? renderRichText(message.content)
    if (message.kind === 'document') {
      // 资料消息与聊天消息区分展示：标题 + 缩略 + doc_id 引用
      const title = escapeHtml(message.meta?.title || message.content || '资料')
      const summary = escapeHtml(message.meta?.summary || '')
      const docId = escapeHtml(message.meta?.docId || '')
      body = `<div class="bubble-doc">
        <div class="bubble-doc-head"><span class="bubble-doc-icon">📄</span><span class="bubble-doc-title">${title}</span></div>
        ${summary ? `<div class="bubble-doc-summary">${summary}</div>` : ''}
        ${docId ? `<div class="bubble-doc-id">${docId}</div>` : ''}
      </div>`
    }
    // 图片消息：dataUrl / 远程 URL 都可直接展示；超出 4 张只展示前 4 张并提示。
    const imageList = (Array.isArray(message.meta?.images) ? message.meta.images : []).filter(image => image?.dataUrl || image?.url)
    if (imageList.length) {
      const shown = imageList.slice(0, 4)
      const grid = shown
        .map(image => {
          const url = escapeHtml(String(imageService?.urlOf?.(image) || image.dataUrl || image.url))
          const name = escapeHtml(String(image.name || '图片').slice(0, 60))
          return `<figure class="bubble-image"><img src="${url}" alt="${name}" loading="lazy" /></figure>`
        })
        .join('')
      const more = imageList.length > shown.length ? `<div class="bubble-image-more">还有 ${imageList.length - shown.length} 张图片未显示</div>` : ''
      body = `${grid}${more}${String(message.content || '').trim() ? body : ''}`
    }
    if (message.streaming) {
      // 等待首个 token：三点思考动画；已有内容：末尾细光标
      if (!String(message.content || '').trim()) body = '<span class="thinking-dots" aria-label="思考中"><i></i><i></i><i></i></span>'
      else body += '<span class="stream-caret"></span>'
    }

    let translation = ''
    if (message.meta?.translation) {
      translation = `<div class="bubble-translation">${escapeHtml(message.meta.translation)}</div>`
    }

    let meta = `<span class="bubble-time">${escapeHtml(message.time || '')}</span>`
    if (isMe) meta += checkIcon(message.status)

    const error = message.error ? `<div class="bubble-error">发送失败：${escapeHtml(message.error)}</div>` : ''

    // 调用详情只在“一轮调用的最末尾那条消息”结尾展示，悬停时出现。
    // message-list 会预算好 round-end 集合并通过 view 传入，避免大量消息时每条都重扫整段历史。
    const isRoundEnd =
      typeof view.isRoundEnd === 'function' ? view.isRoundEnd(message) : isRoundEndByScan(conversation, message)
    const stats = isRoundEnd ? callStatsHtml(message) : ''

    return `
      <div class="msg-row ${isMe ? 'right' : ''}" data-message-id="${message.id}">
        ${avatar}
        <div class="bubble-cluster">
          <div class="bubble ${message.streaming ? 'streaming' : ''}">
            <span class="bubble-text">${body}</span>
            ${error}
            ${translation}
            <span class="bubble-meta">${meta}</span>
            ${stats}
          </div>
        </div>
      </div>`
  }

  const unregister = bubbles.register('bubble-default', {
    id: 'bubble-default',
    label: '默认气泡',
    description: 'Telegram 风格：双勾状态、时间戳智能摆放，适合大多数对话场景',
    renderRow,
  }, { order: 10, label: '默认气泡', description: 'Telegram 风格：双勾状态、时间戳智能摆放，适合大多数对话场景' })
  ctx.effect(unregister)

  ctx.emit('bubble-style:ready', { id: 'bubble-default' })
}

/**
 * 兼容第三方 / 旧调用方：没传 view.isRoundEnd 时按原来的 O(n) 逻辑兜底。
 * message-list 正常渲染时始终会传入预算好的 round-end 集合。
 */
function isRoundEndByScan(conversation, message) {
  const conversational = (conversation?.messages || []).filter(item => item.kind !== 'divider' && item.role !== 'system')
  const index = conversational.findIndex(item => item.id === message.id)
  if (index < 0) return false
  const nextUserIndex = conversational.findIndex((item, i) => i > index && item.role === 'user')
  const roundEndIndex = (nextUserIndex < 0 ? conversational.length : nextUserIndex) - 1
  return index === roundEndIndex
}

/** 本次模型调用的用量信息，渲染在气泡下方、按钮右侧 */
function callStatsHtml(message) {
  const raw = message?.meta?.call || message?.meta?.usage
  if (!raw || typeof raw !== 'object') return ''
  const number = value => (value === null || value === undefined || value === '' ? NaN : Number(value))
  const inputTokens = number(raw.inputTokens)
  const cachedTokens = number(raw.cachedTokens)
  const outputTokens = number(raw.outputTokens)
  const thinkingMs = number(message?.meta?.thinkingMs ?? raw.thinkingMs)
  const cost = number(raw.cost)

  const parts = []
  if (Number.isFinite(inputTokens)) parts.push(stat('input', '输入', `${formatTokens(inputTokens)} tokens`))
  if (Number.isFinite(cachedTokens)) parts.push(stat('cached', '命中缓存', `${formatTokens(cachedTokens)} tokens`))
  if (Number.isFinite(outputTokens)) parts.push(stat('output', '输出', `${formatTokens(outputTokens)} tokens`))
  if (Number.isFinite(thinkingMs) && thinkingMs > 0) parts.push(stat('thinking', '思考', formatDuration(thinkingMs)))
  if (Number.isFinite(inputTokens) && inputTokens > 0 && Number.isFinite(cachedTokens)) {
    const rate = Math.max(0, Math.min(100, (cachedTokens / inputTokens) * 100))
    parts.push(stat('cache-rate', '缓存命中率', `${rate >= 10 ? rate.toFixed(0) : rate.toFixed(1)}%`))
  }
  if (Number.isFinite(cost)) parts.push(stat('cost', '费用', formatCost(cost)))
  if (!parts.length) return ''
  return `<div class="bubble-call-stats">${parts.join('')}</div>`
}

function stat(key, label, value) {
  return `<span class="call-stat" data-stat="${key}">${label} ${escapeHtml(value)}</span>`
}

function formatTokens(value) {
  const num = Math.max(0, Math.round(Number(value) || 0))
  return String(num).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

function formatDuration(ms) {
  const seconds = Number(ms) / 1000
  if (seconds < 10) return `${seconds.toFixed(1)}s`
  return `${seconds.toFixed(0)}s`
}

function formatCost(value) {
  const num = Number(value)
  if (!Number.isFinite(num)) return '—'
  if (num === 0) return '¥0'
  if (num < 0.001) return `¥${num.toFixed(6)}`
  return `¥${num.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}`
}

function checkIcon(status) {
  if (status === 'sent') return icons.check
  if (status === 'read') return icons.checkDoubleRead
  if (status === 'delivered') return icons.checkDouble
  return ''
}
