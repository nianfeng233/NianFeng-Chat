/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目：念风 Chat（NianFeng-Chat）
 *
 * 浏览器同源 HTTP/1.1 连接池通常只有 6 条；每个插件各自 new EventSource('/api/events')
 * 时，多个渠道插件 + 外部插件 + 日志页会把连接池占满，后续 /api 请求只能排队，
 * 表现为刷新后 WebUI 长时间加载不出来、“通信不顺畅”。
 *
 * 这里在入口统一包装 EventSource：相同 origin + pathname 的请求复用同一条原生连接，
 * 按事件类型分发给各个虚拟实例。插件本身不需要改代码，热加载的外部插件也会一起受益。
 */

const groups = new Map()

function groupKeyOf(input) {
  const raw = String(input || '')
  try {
    const base = typeof location !== 'undefined' && location.href ? location.href : 'http://localhost/'
    const url = new URL(raw, base)
    // 忽略 query：/api/events?a=1 与 /api/events 应该共享同一条后端事件流。
    return `${url.origin}${url.pathname}`
  } catch (_) {
    return raw
  }
}

function dispatchListeners(source, type, event) {
  const listeners = source._listeners.get(type)
  if (!listeners?.size) return
  for (const listener of [...listeners]) {
    try {
      listener.call(source, event)
    } catch (err) {
      // 与浏览器 EventTarget 一致：单个监听器异常不阻断其它监听器。
      setTimeout(() => {
        throw err
      }, 0)
    }
  }
}

function dispatchSourceEvent(source, type, event) {
  if (type === 'open') {
    source._readyState = source._openState
    try {
      source.onopen?.call(source, event)
    } catch (err) {
      setTimeout(() => {
        throw err
      }, 0)
    }
  } else if (type === 'error') {
    // 原生 EventSource 大多数错误会自动重连（readyState=CONNECTING）；
    // 如果原生已经彻底关闭，同步成 CLOSED，让插件侧的“重建 EventSource”
    // 兜底逻辑能识别并重新建立连接。
    const nativeState = source._group?.native?.readyState
    source._readyState = nativeState === source._closedState ? source._closedState : source._connectingState
    try {
      source.onerror?.call(source, event)
    } catch (err) {
      setTimeout(() => {
        throw err
      }, 0)
    }
  } else if (type === 'message') {
    try {
      source.onmessage?.call(source, event)
    } catch (err) {
      setTimeout(() => {
        throw err
      }, 0)
    }
  }
  dispatchListeners(source, type, event)
}

export function installEventSourceMultiplexer() {
  const Native = globalThis.EventSource
  if (typeof Native !== 'function' || Native.__nianfengMultiplexed === true) return false
  // 服务端代聊 Worker 用的是 Node fetch 版 EventSource，没有浏览器 6 连接限制，
  // 也不需要这层复用；保持原样，避免影响代聊运行时。
  if (globalThis.__NIANFENG_SERVER_AGENT__ === true) return false

  const CONNECTING = Number.isFinite(Number(Native.CONNECTING)) ? Number(Native.CONNECTING) : 0
  const OPEN = Number.isFinite(Number(Native.OPEN)) ? Number(Native.OPEN) : 1
  const CLOSED = Number.isFinite(Number(Native.CLOSED)) ? Number(Native.CLOSED) : 2

  function handleGroupEvent(group, type, event) {
    for (const source of [...group.virtuals]) {
      if (source._closed) continue
      dispatchSourceEvent(source, type, event)
    }
  }

  function bindNative(group) {
    const native = group.native
    if (!native) return
    native.onopen = event => handleGroupEvent(group, 'open', event)
    native.onmessage = event => handleGroupEvent(group, 'message', event)
    native.onerror = event => handleGroupEvent(group, 'error', event)
  }

  function createNative(url, withCredentials) {
    const options = {}
    if (withCredentials !== undefined) options.withCredentials = withCredentials === true
    return new Native(url, options)
  }

  function groupFor(url, withCredentials) {
    const key = groupKeyOf(url)
    let group = groups.get(key)
    if (!group) {
      group = { key, url, virtuals: new Set(), nativeTypes: new Map(), native: null }
      groups.set(key, group)
    }
    if (!group.native || group.native.readyState === CLOSED) {
      try {
        group.native?.close?.()
      } catch (_) {
        /* ignore */
      }
      group.native = createNative(url, withCredentials)
      group.nativeTypes.clear()
      bindNative(group)
      // 原生连接重建后，已有虚拟实例重新回到连接中状态，并把它们注册过的
      // 自定义事件类型重新挂到新连接上。
      for (const source of group.virtuals) {
        if (source._closed) continue
        source._readyState = CONNECTING
        for (const type of source._listeners.keys()) ensureNativeTypeListener(group, type)
      }
    }
    return group
  }

  const ensureNativeTypeListener = (group, type) => {
    if (!type || group.nativeTypes.has(type)) return
    if (type === 'open' || type === 'error' || type === 'message') return
    const handler = event => handleGroupEvent(group, type, event)
    group.nativeTypes.set(type, handler)
    group.native?.addEventListener(type, handler)
  }

  class SharedEventSource {
    constructor(url, options = {}) {
      this._url = String(url)
      this._withCredentials = options?.withCredentials === true
      this._listeners = new Map()
      this._closed = false
      this._group = null
      this._connectingState = CONNECTING
      this._openState = OPEN
      this._closedState = CLOSED
      this._readyState = CONNECTING
      this.onopen = null
      this.onmessage = null
      this.onerror = null

      const group = groupFor(this._url, this._withCredentials)
      this._group = group
      group.virtuals.add(this)
      this._readyState = group.native?.readyState === OPEN ? OPEN : CONNECTING
      // 第二个及之后的虚拟实例加入时，原生 open 事件早已过去；延后一拍补发，
      // 让插件在同步代码里注册的 open 监听器不会漏掉。
      if (this._readyState === OPEN) {
        queueMicrotask(() => {
          if (!this._closed && this._group === group && group.native?.readyState === OPEN) {
            dispatchSourceEvent(this, 'open', { type: 'open', target: this })
          }
        })
      }
    }

    get url() {
      return this._url
    }

    get withCredentials() {
      return this._withCredentials
    }

    get readyState() {
      return this._readyState
    }

    addEventListener(type, listener) {
      if (!listener || !this._group) return
      const key = String(type || '')
      let list = this._listeners.get(key)
      if (!list) {
        list = new Set()
        this._listeners.set(key, list)
      }
      list.add(listener)
      ensureNativeTypeListener(this._group, key)
    }

    removeEventListener(type, listener) {
      this._listeners.get(String(type || ''))?.delete(listener)
    }

    close() {
      if (this._closed) return
      this._closed = true
      this._readyState = CLOSED
      this._listeners.clear()
      const group = this._group
      this._group = null
      if (!group) return
      group.virtuals.delete(this)
      if (group.virtuals.size) return
      for (const [type, handler] of group.nativeTypes) {
        try {
          group.native?.removeEventListener(type, handler)
        } catch (_) {
          /* ignore */
        }
      }
      group.nativeTypes.clear()
      try {
        group.native?.close?.()
      } catch (_) {
        /* ignore */
      }
      group.native = null
      groups.delete(group.key)
    }
  }

  try {
    SharedEventSource.CONNECTING = CONNECTING
    SharedEventSource.OPEN = OPEN
    SharedEventSource.CLOSED = CLOSED
    SharedEventSource.__nianfengMultiplexed = true
    globalThis.EventSource = SharedEventSource
  } catch (_) {
    // 某些 WebView 可能不允许替换全局构造器；替换失败时保持原生实现。
    return false
  }
  return true
}
