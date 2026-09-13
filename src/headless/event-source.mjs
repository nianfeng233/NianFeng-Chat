/*
 * 念风chat · 服务端常驻代聊运行时专用 EventSource（Node fetch 流实现）。
 * 浏览器不加载这个文件；只有 start.mjs 拉起的隐藏 frontend runtime 会使用，
 * 让 NapCat / QQ / 微信渠道插件在无 WebUI 窗口时也能持续接收后端 SSE 事件。
 */

class NodeEventSource {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSED = 2
  static CLOSED_CODE = 2

  constructor(url, options = {}) {
    this.url = String(url || '')
    this.withCredentials = options?.withCredentials !== false
    this.readyState = NodeEventSource.CONNECTING
    this.onopen = null
    this.onmessage = null
    this.onerror = null
    this._listeners = new Map()
    this._controller = null
    this._closed = false
    this._retryMs = 3000
    this._lastEventId = ''
    this._connect().catch(() => {})
  }

  addEventListener(type, listener) {
    if (typeof listener !== 'function') return
    const key = String(type || 'message')
    const list = this._listeners.get(key) || []
    list.push(listener)
    this._listeners.set(key, list)
  }

  removeEventListener(type, listener) {
    const key = String(type || 'message')
    const list = this._listeners.get(key) || []
    this._listeners.set(
      key,
      list.filter(item => item !== listener),
    )
  }

  _emit(type, data = null) {
    const event = { type, data, lastEventId: this._lastEventId, target: this, currentTarget: this }
    for (const listener of this._listeners.get(type) || []) {
      try {
        listener.call(this, event)
      } catch (_) {
        /* 单个监听器异常不应拖垮 SSE 连接 */
      }
    }
    const handler = this[`on${type}`]
    if (typeof handler === 'function') {
      try {
        handler.call(this, event)
      } catch (_) {
        /* ignore */
      }
    }
  }

  _scheduleReconnect() {
    if (this._closed) return
    this.readyState = NodeEventSource.CONNECTING
    const timer = setTimeout(() => {
      this._connect().catch(() => {})
    }, this._retryMs)
    timer?.unref?.()
  }

  async _connect() {
    if (this._closed) return
    const controller = new AbortController()
    this._controller = controller
    this.readyState = NodeEventSource.CONNECTING
    let response = null
    try {
      response = await fetch(this.url, {
        method: 'GET',
        headers: { Accept: 'text/event-stream' },
        credentials: this.withCredentials ? 'include' : 'omit',
        cache: 'no-store',
        signal: controller.signal,
      })
    } catch (err) {
      if (this._closed) return
      this._emit('error', err)
      this._scheduleReconnect()
      return
    }
    if (!response.ok || !response.body) {
      if (this._closed) return
      this._emit('error', new Error(`SSE ${response.status} ${response.statusText}`))
      this._scheduleReconnect()
      return
    }

    this.readyState = NodeEventSource.OPEN
    this._emit('open', null)

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let eventName = ''
    let dataLines = []

    const dispatch = () => {
      if (!eventName && !dataLines.length) return
      const type = eventName || 'message'
      const data = dataLines.join('\n')
      eventName = ''
      dataLines = []
      this._emit(type, data)
    }

    try {
      while (!this._closed) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let newline = buffer.indexOf('\n')
        while (newline >= 0) {
          let line = buffer.slice(0, newline)
          buffer = buffer.slice(newline + 1)
          if (line.endsWith('\r')) line = line.slice(0, -1)
          if (line === '') {
            dispatch()
          } else if (!line.startsWith(':')) {
            const colon = line.indexOf(':')
            const field = colon >= 0 ? line.slice(0, colon) : line
            let val = colon >= 0 ? line.slice(colon + 1) : ''
            if (val.startsWith(' ')) val = val.slice(1)
            if (field === 'event') eventName = val
            else if (field === 'data') dataLines.push(val)
            else if (field === 'id' && !val.includes('\0')) this._lastEventId = val
            else if (field === 'retry' && /^\d+$/.test(val)) this._retryMs = Math.max(1000, Number(val) || 3000)
          }
          newline = buffer.indexOf('\n')
        }
      }
    } catch (err) {
      if (!this._closed) {
        this._emit('error', err)
        this._scheduleReconnect()
        return
      }
    }

    if (!this._closed) {
      this._emit('error', new Error('SSE connection closed'))
      this._scheduleReconnect()
    }
  }

  close() {
    this._closed = true
    this.readyState = NodeEventSource.CLOSED
    try {
      this._controller?.abort()
    } catch (_) {
      /* ignore */
    }
    this._controller = null
  }
}

export { NodeEventSource }
