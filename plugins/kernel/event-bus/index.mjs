/**
 * K1 · event-bus
 * 提供 emit / on / off / once 的全局事件总线（内核 Context 的事件系统本体），
 * 并额外提供事件历史、监听者查询与追踪开关，供调试面板使用。
 */
export const name = 'event-bus'
export const version = '1.0.0'
export const displayName = '事件总线'
export const description = '内核层 · 插件间通信的基础设施，提供 emit / on / provide / inject。'
export const author = '风语内核'
export const icon = '⚡'
export const core = true
export const provides = [{ name: 'event-bus', type: 'singleton' }]

export function apply(ctx) {
  const history = []
  const MAX_HISTORY = 300

  // 订阅事件历史（由运行时 eventSinks 提供，替代旧内核的通配符监听）
  const offSink = ctx.events.addSink(entry => {
    history.push(entry)
    if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY)
  })
  ctx.effect(offSink)

  const service = {
    name: 'event-bus',
    on: (event, listener, options) => ctx.on(event, listener, options),
    once: (event, listener, options) => ctx.once(event, listener, options),
    off: (event, listener) => ctx.off(event, listener),
    emit: (event, payload, options) => ctx.emit(event, payload, options),
    /** 拦截型广播：允许监听器修改 payload（文档 §4.3 第 3 层） */
    intercept: (event, payload, onIntercept) => ctx.emit(event, payload, { interceptor: true, onIntercept, owner: 'event-bus' }),
    owners: event => ctx.events.owners(event),
    listeners: event => ctx.events.listeners(event),
    names: () => ctx.events.eventNames(),
    history: () => [...history],
    clearHistory: () => {
      history.length = 0
    },
    trace: (on = true, sink = console.log) => {
      ctx.events.trace = on ? (phase, event, payload, owner) => sink(`[trace] ${phase} ${event}`, owner, payload) : null
      return on
    },
  }

  ctx.provide('event-bus', service, { type: 'singleton' })
  ctx.logger.debug('事件总线就绪（cordis 原生事件系统）')
}

export function stop(ctx) {
  ctx.events.trace = null
}
