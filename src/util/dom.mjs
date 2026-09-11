/** 常用 DOM 工具（库，不是插件） */
export const $ = (sel, root = document) => root.querySelector(sel)
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel))

export function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v))
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, m => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[m])
}

/** 由 HTML 字符串创建一个元素 */
export function h(html) {
  const tpl = document.createElement('template')
  tpl.innerHTML = String(html).trim()
  return tpl.content.firstElementChild
}

/** 由 HTML 字符串创建 DocumentFragment（可含多个根节点） */
export function frag(html) {
  const tpl = document.createElement('template')
  tpl.innerHTML = String(html).trim()
  return tpl.content
}

/** 事件绑定，返回自动清理函数 */
export function on(target, type, handler, options) {
  if (!target) return () => {}
  target.addEventListener(type, handler, options)
  return () => target.removeEventListener(type, handler, options)
}

/** 事件委托，返回自动清理函数 */
export function delegate(root, type, selector, handler, options) {
  return on(
    root,
    type,
    e => {
      const target = e.target?.closest?.(selector)
      if (target && root.contains(target)) handler(e, target)
    },
    options,
  )
}

let UID = 0
export function uid(prefix = 'id') {
  return `${prefix}${++UID}`
}

/** 简易 requestAnimationFrame 节流 */
export function rafThrottle(fn) {
  let scheduled = false
  let lastArgs = []
  return (...args) => {
    lastArgs = args
    if (scheduled) return
    scheduled = true
    requestAnimationFrame(() => {
      scheduled = false
      fn(...lastArgs)
    })
  }
}
