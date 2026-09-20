/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * EventSource 多路复用回归测试：相同 origin + pathname 只建立一条原生连接。
 */
import assert from 'node:assert/strict'

let passed = 0
let failed = 0
const check = (name, fn) => {
  try {
    fn()
    passed += 1
    console.log(`  ✔ ${name}`)
  } catch (err) {
    failed += 1
    console.log(`  ✗ ${name}  → ${err?.message || err}`)
  }
}

class MockEventSource {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSED = 2
  static instances = []

  constructor(url, options = {}) {
    this.url = url
    this.withCredentials = !!options.withCredentials
    this.readyState = MockEventSource.CONNECTING
    this._listeners = new Map()
    this.onopen = null
    this.onerror = null
    this.onmessage = null
    this.closed = false
    MockEventSource.instances.push(this)
  }

  addEventListener(type, listener) {
    const list = this._listeners.get(type) || new Set()
    list.add(listener)
    this._listeners.set(type, list)
  }

  removeEventListener(type, listener) {
    this._listeners.get(type)?.delete(listener)
  }

  emit(type, data) {
    const event = { type, data }
    this[`on${type}`]?.(event)
    for (const listener of this._listeners.get(type) || []) listener(event)
  }

  close() {
    this.closed = true
    this.readyState = MockEventSource.CLOSED
  }
}

globalThis.EventSource = MockEventSource
globalThis.__NIANFENG_SERVER_AGENT__ = false

const { installEventSourceMultiplexer } = await import('../src/util/event-source-multiplex.mjs')

check('安装多路复用器', () => {
  assert.equal(installEventSourceMultiplexer(), true)
  assert.equal(globalThis.EventSource.__nianfengMultiplexed, true)
})

check('相同 pathname 共享一条原生连接，query 不同也复用', () => {
  const a = new EventSource('/api/events')
  const b = new EventSource('/api/events?token=test')
  assert.equal(MockEventSource.instances.length, 1)
  assert.equal(a.readyState, 0)
  assert.equal(b.readyState, 0)
  a.close()
  b.close()
})

check('open / message / 自定义事件分发到所有虚拟实例', () => {
  const a = new EventSource('/api/events')
  const b = new EventSource('/api/events')
  const native = MockEventSource.instances.at(-1)
  let opened = 0
  let message = ''
  let custom = 0
  a.addEventListener('open', () => { opened += 1 })
  b.addEventListener('open', () => { opened += 1 })
  native.readyState = MockEventSource.OPEN
  native.emit('open')
  assert.equal(opened, 2)
  assert.equal(a.readyState, 1)

  a.onmessage = event => { message = event.data }
  native.emit('message', 'hello')
  assert.equal(message, 'hello')

  a.addEventListener('napcat:message', () => { custom += 1 })
  b.addEventListener('napcat:message', () => { custom += 1 })
  native.emit('napcat:message', { ok: true })
  assert.equal(custom, 2)
  a.close()
  b.close()
})

check('原生连接重建后，已有虚拟实例监听器仍会收到事件', () => {
  const a = new EventSource('/api/events')
  const b = new EventSource('/api/events')
  const oldNative = MockEventSource.instances.at(-1)
  let custom = 0
  a.addEventListener('qqbot:message', () => { custom += 1 })
  oldNative.readyState = MockEventSource.CLOSED
  // 新虚拟实例加入会触发原生连接重建。
  const c = new EventSource('/api/events')
  const newNative = MockEventSource.instances.at(-1)
  assert.notEqual(newNative, oldNative)
  newNative.emit('qqbot:message', { ok: true })
  assert.equal(custom, 1)
  a.close()
  b.close()
  c.close()
})


check('单个虚拟实例 close 不影响其它订阅者', () => {
  const a = new EventSource('/api/events')
  const b = new EventSource('/api/events')
  const native = MockEventSource.instances.at(-1)
  a.close()
  assert.equal(native.closed, false)
  assert.equal(b.readyState, 0)
  b.close()
  assert.equal(native.closed, true)
})

check('最后一个虚拟实例关闭后，新连接会创建新的原生 EventSource', () => {
  const before = MockEventSource.instances.length
  const a = new EventSource('/api/events')
  assert.equal(MockEventSource.instances.length, before + 1)
  a.close()
})

console.log(`\nEventSource 多路复用测试：${passed}/${passed + failed} 项通过`)
if (failed) process.exitCode = 1
