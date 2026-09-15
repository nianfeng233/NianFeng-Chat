/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * 极简 DOM 垫片（仅供 Node 冒烟测试使用，不进入浏览器产物）。
 *
 * 目标：让应用在 Node 中也能完整启动，从而验证
 *  - 插件加载顺序 / 服务注入
 *  - 运行时错误（任何一个插件 apply() 抛错都会体现在诊断里）
 *  - 聊天闭环、视图切换、动态启停
 *
 * 它只实现项目实际用到的那部分 DOM API（innerHTML 解析、querySelector、
 * classList、dataset、事件、MutationObserver 等），不是通用 DOM 实现。
 */

/* ------------------------------------------------------------------ */
/* 基础工具                                                            */
/* ------------------------------------------------------------------ */

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'])

function camel(name) {
  return name.replace(/-([a-z])/g, (_, c) => c.toUpperCase())
}

function decodeEntities(text) {
  return String(text)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
}

function parseStyle(text, style) {
  for (const decl of String(text).split(';')) {
    const idx = decl.indexOf(':')
    if (idx < 0) continue
    const key = decl.slice(0, idx).trim()
    const value = decl.slice(idx + 1).trim()
    if (key) style.setProperty(key, value)
  }
}

/* ------------------------------------------------------------------ */
/* 事件 / observer                                                     */
/* ------------------------------------------------------------------ */

class EventTarget {
  constructor() {
    this._listeners = new Map()
  }
  addEventListener(type, fn, options) {
    if (!fn) return
    const list = this._listeners.get(type) || []
    list.push({ fn, options })
    this._listeners.set(type, list)
  }
  removeEventListener(type, fn) {
    const list = this._listeners.get(type)
    if (!list) return
    const i = list.findIndex(l => l.fn === fn)
    if (i >= 0) list.splice(i, 1)
  }
  dispatchEvent(event) {
    const list = this._listeners.get(event.type) || []
    for (const { fn } of [...list]) {
      if (typeof fn === 'function') fn.call(this, event)
      else fn.handleEvent?.(event)
    }
    return true
  }
  _fire(type, extra = {}) {
    const event = Object.assign({ type, target: this, currentTarget: this, preventDefault() {}, stopPropagation() {} }, extra)
    return this.dispatchEvent(event)
  }
}

const observers = new Set()
let flushQueued = false

function scheduleFlush() {
  if (flushQueued) return
  flushQueued = true
  queueMicrotask(() => {
    flushQueued = false
    for (const observer of [...observers]) {
      if (observer._disconnected) continue
      if (observer._type === 'childList') {
        try {
          observer._callback([], observer)
        } catch (err) {
          console.error('[dom-shim] MutationObserver callback 出错', err)
        }
      }
    }
  })
}

export class MutationObserverShim {
  constructor(callback) {
    this._callback = callback
    this._type = 'childList'
    this._disconnected = false
    observers.add(this)
  }
  observe() {}
  disconnect() {
    this._disconnected = true
    observers.delete(this)
  }
  takeRecords() {
    return []
  }
}

export class ResizeObserverShim {
  constructor(callback) {
    this._callback = callback
    this._targets = new Set()
    observers.add(this)
    this._type = 'resize'
  }
  observe(el) {
    this._targets.add(el)
    queueMicrotask(() => {
      if (this._type === 'resize') {
        try {
          this._callback([{ target: el, contentRect: { width: el.clientWidth, height: el.clientHeight } }], this)
        } catch (_) {
          /* ignore */
        }
      }
    })
  }
  unobserve(el) {
    this._targets.delete(el)
  }
  disconnect() {
    this._targets.clear()
    observers.delete(this)
  }
}

/* ------------------------------------------------------------------ */
/* 节点                                                                */
/* ------------------------------------------------------------------ */

export class TinyNode extends EventTarget {
  constructor(nodeType, name = '') {
    super()
    this.nodeType = nodeType // 1 元素 / 3 文本
    this.nodeName = String(name).toUpperCase()
    this.tagName = this.nodeName
    this.childNodes = []
    this.parentNode = null
    this.ownerDocument = null
    this._attrs = new Map()
    this._text = ''
    this._html = ''
    this._classes = new Set()
    this.style = new TinyStyle()
    this.dataset = new Proxy(
      {},
      {
        get: (_t, key) => this._datasetValue(key),
        set: (_t, key, value) => {
          this.setAttribute(`data-${String(key).replace(/[A-Z]/g, m => '-' + m.toLowerCase())}`, String(value))
          return true
        },
      },
    )
  }

  /* ---- 属性 ---- */
  setAttribute(name, value) {
    const n = String(name)
    this._attrs.set(n, String(value))
    if (n === 'class') {
      this._classes = new Set(String(value).split(/\s+/).filter(Boolean))
    }
    if (n === 'style') parseStyle(String(value), this.style)
    if (n === 'id') this.id = String(value)
    if (n.startsWith('data-')) this[`_data_${camel(n.slice(5))}`] = String(value)
    scheduleFlush()
  }
  getAttribute(name) {
    if (name === 'class') return [...this._classes].join(' ')
    const value = this._attrs.get(String(name))
    return value === undefined ? null : value
  }
  hasAttribute(name) {
    return this._attrs.has(String(name))
  }
  removeAttribute(name) {
    this._attrs.delete(String(name))
    if (name === 'class') this._classes.clear()
  }
  _datasetValue(key) {
    const kebab = `data-${String(key).replace(/[A-Z]/g, m => '-' + m.toLowerCase())}`
    const value = this._attrs.get(kebab)
    return value === undefined ? undefined : value
  }

  get classList() {
    const self = this
    return {
      add(...names) {
        names.filter(Boolean).forEach(n => self._classes.add(String(n)))
        scheduleFlush()
      },
      remove(...names) {
        names.forEach(n => self._classes.delete(String(n)))
        scheduleFlush()
      },
      toggle(name, force) {
        const has = self._classes.has(String(name))
        const next = force === undefined ? !has : !!force
        if (next) self._classes.add(String(name))
        else self._classes.delete(String(name))
        scheduleFlush()
        return next
      },
      contains(name) {
        return self._classes.has(String(name))
      },
      get length() {
        return self._classes.size
      },
      toString() {
        return [...self._classes].join(' ')
      },
    }
  }
  get className() {
    return [...this._classes].join(' ')
  }
  set className(v) {
    this._classes = new Set(String(v).split(/\s+/).filter(Boolean))
  }

  /* ---- 文本 / HTML ---- */
  get textContent() {
    if (this.nodeType === 3) return this._text
    return this.childNodes.map(n => n.textContent).join('')
  }
  set textContent(value) {
    this.childNodes = []
    if (value !== '' && value !== null && value !== undefined) {
      const text = new TinyNode(3, '#text')
      text._text = String(value)
      text.parentNode = this
      this.childNodes.push(text)
    }
    this._html = ''
    scheduleFlush()
  }

  get innerHTML() {
    return this._html
  }
  set innerHTML(value) {
    this.childNodes = []
    const fragment = parseHTML(String(value ?? ''), this.ownerDocument)
    for (const child of fragment.childNodes) {
      child.parentNode = this
      this.childNodes.push(child)
    }
    this._html = String(value ?? '')
    scheduleFlush()
  }

  get outerHTML() {
    return this.innerHTML
  }

  get children() {
    return this.childNodes.filter(n => n.nodeType === 1)
  }
  get firstChild() {
    return this.childNodes[0] || null
  }
  get firstElementChild() {
    return this.children[0] || null
  }
  get content() {
    // <template>.content：垫片里直接用自身承载子节点
    return this
  }
  get lastChild() {
    return this.childNodes[this.childNodes.length - 1] || null
  }
  get isConnected() {
    let node = this
    while (node.parentNode) node = node.parentNode
    return node === doc.documentElement || node === doc.body || node === doc
  }

  appendChild(child) {
    if (!child) return child
    if (child.parentNode) child.parentNode.removeChild(child)
    child.parentNode = this
    this.childNodes.push(child)
    this._html = ''
    propagateOwner(child, this.ownerDocument)
    scheduleFlush()
    return child
  }
  insertBefore(child, ref) {
    if (!ref) return this.appendChild(child)
    if (child.parentNode) child.parentNode.removeChild(child)
    const idx = this.childNodes.indexOf(ref)
    child.parentNode = this
    this.childNodes.splice(idx < 0 ? this.childNodes.length : idx, 0, child)
    propagateOwner(child, this.ownerDocument)
    scheduleFlush()
    return child
  }
  removeChild(child) {
    const idx = this.childNodes.indexOf(child)
    if (idx >= 0) this.childNodes.splice(idx, 1)
    child.parentNode = null
    scheduleFlush()
    return child
  }
  remove() {
    this.parentNode?.removeChild(this)
  }
  contains(node) {
    if (node === this) return true
    return this.childNodes.some(child => child.contains?.(node))
  }
  cloneNode() {
    const copy = new TinyNode(this.nodeType, this.nodeName)
    copy._text = this._text
    copy._html = this._html
    copy._attrs = new Map(this._attrs)
    copy._classes = new Set(this._classes)
    return copy
  }

  /* ---- 查询 ---- */
  querySelector(selector) {
    return queryAll(this, selector)[0] || null
  }
  querySelectorAll(selector) {
    return queryAll(this, selector)
  }
  getElementById(id) {
    return this.querySelector(`#${id}`)
  }
  closest(selector) {
    let node = this
    while (node && node.nodeType === 1) {
      if (matches(node, selector)) return node
      node = node.parentNode
    }
    return null
  }
  matches(selector) {
    return matches(this, selector)
  }

  /* ---- 表单 / 交互 ---- */
  get value() {
    return this._value !== undefined ? this._value : this.getAttribute('value') || ''
  }
  set value(v) {
    this._value = String(v)
  }
  get checked() {
    return !!this._checked
  }
  set checked(v) {
    this._checked = !!v
  }
  focus() {
    doc.activeElement = this
    this._fire('focus')
  }
  blur() {
    if (doc.activeElement === this) doc.activeElement = null
    this._fire('blur')
  }
  click() {
    this._fire('click', { clientX: 0, clientY: 0, button: 0, target: this })
  }
  select() {}
  getBoundingClientRect() {
    return { top: 0, left: 0, right: 100, bottom: 40, width: 100, height: 40, x: 0, y: 0 }
  }
  get offsetHeight() {
    return this._offsetHeight ?? 40
  }
  get clientWidth() {
    return this._clientWidth ?? 300
  }
  get clientHeight() {
    return this._clientHeight ?? 400
  }
  get scrollHeight() {
    return this._scrollHeight ?? 400
  }
  get scrollTop() {
    return this._scrollTop ?? 0
  }
  set scrollTop(v) {
    this._scrollTop = Number(v) || 0
  }
}

function propagateOwner(node, ownerDocument) {
  node.ownerDocument = ownerDocument
  for (const child of node.childNodes) propagateOwner(child, ownerDocument)
}

/* ------------------------------------------------------------------ */
/* style                                                               */
/* ------------------------------------------------------------------ */

export class TinyStyle {
  constructor() {
    this._props = new Map()
    this.cssText = ''
    this.display = ''
  }
  setProperty(name, value) {
    this._props.set(name, value)
    this[name] = value
  }
  getPropertyValue(name) {
    return this._props.get(name) || ''
  }
  removeProperty(name) {
    this._props.delete(name)
  }
}

/* ------------------------------------------------------------------ */
/* HTML 解析                                                           */
/* ------------------------------------------------------------------ */

const TAG_RE = /<\/?([a-zA-Z][\w:-]*)((?:\s+[a-zA-Z_:][\w:.-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*(\/?)>/g
const ATTR_RE = /([a-zA-Z_:][\w:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g

export function parseHTML(html, ownerDocument) {
  const root = new TinyNode(1, '#fragment')
  root.ownerDocument = ownerDocument
  const stack = [root]
  let lastIndex = 0
  let match

  TAG_RE.lastIndex = 0
  while ((match = TAG_RE.exec(html))) {
    const [full, tagName, attrsText, selfClose] = match
    const isClosing = full.startsWith('</')

    if (match.index > lastIndex) {
      const text = html.slice(lastIndex, match.index)
      if (text) {
        const node = new TinyNode(3, '#text')
        node._text = decodeEntities(text)
        node.ownerDocument = ownerDocument
        node.parentNode = stack[stack.length - 1]
        stack[stack.length - 1].childNodes.push(node)
      }
    }
    lastIndex = match.index + full.length

    const tag = tagName.toLowerCase()
    if (isClosing) {
      // 找到最近的同名节点
      for (let i = stack.length - 1; i >= 1; i--) {
        if (stack[i].nodeName === tagName.toUpperCase()) {
          stack.length = i
          break
        }
      }
      continue
    }

    const node = new TinyNode(1, tagName)
    node.ownerDocument = ownerDocument
    attrsText.replace(ATTR_RE, (_, name, v1, v2, v3) => {
      const value = v1 ?? v2 ?? v3 ?? ''
      node.setAttribute(name, decodeEntities(value))
      return ''
    })

    const parent = stack[stack.length - 1]
    node.parentNode = parent
    parent.childNodes.push(node)

    if (!VOID_TAGS.has(tag) && !selfClose) stack.push(node)
  }

  if (lastIndex < html.length) {
    const text = html.slice(lastIndex)
    if (text) {
      const node = new TinyNode(3, '#text')
      node._text = decodeEntities(text)
      node.ownerDocument = ownerDocument
      node.parentNode = stack[stack.length - 1]
      stack[stack.length - 1].childNodes.push(node)
    }
  }

  root._html = html
  return root
}

/* ------------------------------------------------------------------ */
/* 选择器                                                              */
/* ------------------------------------------------------------------ */

function matches(node, selector) {
  if (!node || node.nodeType !== 1) return false
  return String(selector)
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .some(part => matchesComplex(node, part))
}

function matchesComplex(node, selector) {
  const parts = selector.split(/\s+/).filter(p => p && p !== '>')
  if (!parts.length) return false
  if (!matchesSimple(node, parts[parts.length - 1])) return false
  let current = node.parentNode
  for (let i = parts.length - 2; i >= 0; i--) {
    while (current && current.nodeType === 1 && !matchesSimple(current, parts[i])) current = current.parentNode
    if (!current || current.nodeType !== 1) return false
    current = current.parentNode
  }
  return true
}

function matchesSimple(node, simple) {
  // 支持 tag / #id / .class / [attr] / [attr="v"] / tag.cls / :not(...)
  const source = String(simple)
  const notMatch = source.match(/:not\(([^)]+)\)/)
  if (notMatch) {
    const base = source.replace(notMatch[0], '')
    if (!matchesSimple(node, base)) return false
    return !matches(node, notMatch[1])
  }
  const re = /(^[a-zA-Z][\w-]*)|(#[a-zA-Z_][\w-]*)|(\.[a-zA-Z_][\w-]*)|(\[[^\]]+\])/g
  let m
  let matchedAny = false
  if (!source.match(re)) return false
  re.lastIndex = 0
  while ((m = re.exec(source))) {
    matchedAny = true
    const token = m[0]
    if (token.startsWith('#')) {
      if (node.id !== token.slice(1)) return false
    } else if (token.startsWith('.')) {
      if (!node._classes.has(token.slice(1))) return false
    } else if (token.startsWith('[')) {
      const inside = token.slice(1, -1)
      const eq = inside.indexOf('=')
      if (eq < 0) {
        if (!node.hasAttribute(inside)) return false
      } else {
        const name = inside.slice(0, eq).replace(/[*^$]$/, '')
        const value = inside.slice(eq + 1).replace(/^["']|["']$/g, '')
        const actual = node.getAttribute(name)
        if (actual === null || actual !== value) return false
      }
    } else {
      if (node.nodeName !== token.toUpperCase()) return false
    }
  }
  return matchedAny
}

function queryAll(root, selector) {
  const out = []
  const walk = node => {
    for (const child of node.childNodes) {
      if (child.nodeType === 1) {
        if (matches(child, selector)) out.push(child)
        walk(child)
      }
    }
  }
  walk(root)
  return out
}

/* ------------------------------------------------------------------ */
/* document / window                                                   */
/* ------------------------------------------------------------------ */

class TinyDocument extends TinyNode {
  constructor() {
    super(1, '#document')
    this.ownerDocument = this
    this.documentElement = new TinyNode(1, 'html')
    this.head = new TinyNode(1, 'head')
    this.body = new TinyNode(1, 'body')
    this.documentElement.ownerDocument = this
    this.head.ownerDocument = this
    this.body.ownerDocument = this
    this.documentElement.appendChild(this.head)
    this.documentElement.appendChild(this.body)
    this.appendChild(this.documentElement)
    this.activeElement = null
    this.hidden = false
    this.title = 'test'
  }

  createElement(tag) {
    const el = new TinyNode(1, tag)
    el.ownerDocument = this
    return el
  }
  createTextNode(text) {
    const node = new TinyNode(3, '#text')
    node._text = String(text)
    node.ownerDocument = this
    return node
  }
  createDocumentFragment() {
    const frag = new TinyNode(1, '#fragment')
    frag.ownerDocument = this
    return frag
  }
}

const doc = new TinyDocument()
const htmlEl = doc.documentElement

const windowShim = new EventTarget()
Object.assign(windowShim, {
  innerWidth: 1440,
  innerHeight: 900,
  devicePixelRatio: 1,
  document: doc,
  matchMedia: () => ({ matches: false, onchange: null, addEventListener() {}, removeEventListener() {} }),
  requestAnimationFrame: cb => setTimeout(() => cb(Date.now()), 0),
  cancelAnimationFrame: id => clearTimeout(id),
  getComputedStyle: () => ({ getPropertyValue: () => '' }),
  MutationObserver: MutationObserverShim,
  ResizeObserver: ResizeObserverShim,
  KeyboardEvent: class KeyboardEvent {
    constructor(type, init = {}) {
      Object.assign(this, { type, target: null, preventDefault() {}, stopPropagation() {} }, init)
    }
  },
  location: { href: 'http://localhost:5173/', reload() {} },
  AudioContext: class {
    constructor() {
      this.currentTime = 0
      this.destination = {}
    }
    createOscillator() {
      return { frequency: { value: 0 }, type: 'sine', connect() { return this }, start() {}, stop() {} }
    }
    createGain() {
      return { gain: { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() { return this } }
    }
    resume() {}
  },
  Notification: class {
    static permission = 'denied'
    static requestPermission() {
      return Promise.resolve('denied')
    }
    constructor() {}
    close() {}
  },
  speechSynthesis: {
    speak() {},
    cancel() {},
  },
  SpeechSynthesisUtterance: class {
    constructor(text) {
      this.text = text
    }
  },
  DOMParser: class {
    parseFromString() {
      return new TinyDocument()
    }
  },
  navigator: { userAgent: 'node-shim', clipboard: { writeText: () => Promise.resolve() }, onLine: true },
  localStorage: (() => {
    const map = new Map()
    return {
      getItem: k => (map.has(k) ? map.get(k) : null),
      setItem: (k, v) => map.set(k, String(v)),
      removeItem: k => map.delete(k),
      clear: () => map.clear(),
      key: i => [...map.keys()][i] ?? null,
      get length() {
        return map.size
      },
    }
  })(),
  console,
})

// Node 环境补两个导出用的静态方法
if (typeof URL.createObjectURL !== 'function') URL.createObjectURL = () => 'blob:shim'
if (typeof URL.revokeObjectURL !== 'function') URL.revokeObjectURL = () => {}

// 全局安装（仅测试进程）
function defineGlobal(name, value) {
  try {
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
  } catch (_) {
    globalThis[name] = value
  }
}

defineGlobal('window', windowShim)
defineGlobal('document', doc)
defineGlobal('MutationObserver', MutationObserverShim)
defineGlobal('ResizeObserver', ResizeObserverShim)
defineGlobal('KeyboardEvent', windowShim.KeyboardEvent)
defineGlobal('requestAnimationFrame', windowShim.requestAnimationFrame)
defineGlobal('cancelAnimationFrame', windowShim.cancelAnimationFrame)
defineGlobal('getComputedStyle', windowShim.getComputedStyle)
defineGlobal('AudioContext', windowShim.AudioContext)
defineGlobal('Notification', windowShim.Notification)
defineGlobal('speechSynthesis', windowShim.speechSynthesis)
defineGlobal('SpeechSynthesisUtterance', windowShim.SpeechSynthesisUtterance)
defineGlobal('DOMParser', windowShim.DOMParser)
defineGlobal('navigator', windowShim.navigator)
defineGlobal('localStorage', windowShim.localStorage)
defineGlobal('location', windowShim.location)

globalThis.Audio = class AudioShim {
  constructor() {
    this.volume = 1
    this.currentTime = 0
    this.duration = 180
    this.src = ''
    this.paused = true
    this.preload = ''
    this._listeners = new Map()
  }
  addEventListener(type, fn) {
    this._listeners.set(type, fn)
  }
  removeEventListener(type) {
    this._listeners.delete(type)
  }
  play() {
    this.paused = false
    this._listeners.get('play')?.()
    return Promise.resolve()
  }
  pause() {
    this.paused = true
    this._listeners.get('pause')?.()
  }
}

// document 常用方法与 html/body 快捷属性
doc.addEventListener = EventTarget.prototype.addEventListener.bind(doc)
doc.removeEventListener = EventTarget.prototype.removeEventListener.bind(doc)
htmlEl.style = new TinyStyle()
htmlEl.dataset = new Proxy(
  {},
  {
    get: (_t, key) => htmlEl._datasetValue(key),
    set: (_t, key, value) => {
      htmlEl.setAttribute(`data-${String(key).replace(/[A-Z]/g, m => '-' + m.toLowerCase())}`, String(value))
      return true
    },
  },
)

export { doc, windowShim }
export default windowShim
