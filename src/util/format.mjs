/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/** 时间与文本格式化 */
export { escapeHtml } from './dom.mjs'

export function nowTime(date = new Date()) {
  const pad = n => String(n).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function formatFullTime(date = new Date()) {
  const pad = n => String(n).padStart(2, '0')
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function formatDateTime(date = new Date()) {
  const pad = n => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** 判断是否同一天 */
export function isSameDay(a, b) {
  const x = new Date(a)
  const y = new Date(b)
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate()
}

/** 会话列表用的相对时间：今天 HH:mm / 昨天 / 星期X / MM-DD */
export function listTime(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  const now = new Date()
  const pad = n => String(n).padStart(2, '0')
  if (isSameDay(d, now)) return `${pad(d.getHours())}:${pad(d.getMinutes())}`
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (isSameDay(d, yesterday)) return '昨天'
  const diffDays = Math.floor((now - d) / 86400000)
  if (diffDays < 7) return `星期${'日一二三四五六'[d.getDay()]}`
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function truncate(text, max = 60) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}

export function byteSize(n) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/** 简单的高亮：把 <code>...</code> 转成代码块，其余转义（与 demo 行为一致） */
export function renderRichText(text) {
  const escaped = String(text ?? '').replace(/[&<>"']/g, m => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[m])
  return escaped.replace(/&lt;code&gt;([\s\S]*?)&lt;\/code&gt;/g, (_, code) => `<span class="code">${code}</span>`)
}

/** 构造一个头像的 CSS 变量：--c1 / --c2 */
export function avatarStyle(c1, c2) {
  return `--c1:${c1 || '#8ab4ff'};--c2:${c2 || '#5a8dff'}`
}
