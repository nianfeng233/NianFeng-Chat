/**
 * D? · chat-queue
 * 角色级 FIFO 串行队列（文档 §8）：
 *   - 同一个角色同一时间只处理一轮完整调用
 *   - 多渠道同时发消息按到达顺序排队；处理期间用户插话进入队列，本轮结束后继续
 *   - cancelCurrent 只中断正在跑的一轮，不清空已经排队的插话（对应“停止生成”）
 */
export const name = 'chat-queue'
export const version = '1.0.0'
export const displayName = '聊天串行队列'
export const description = '业务服务 · 每个角色一条 FIFO 队列，保证同一角色同一时刻只跑一轮。'
export const author = '风语内核'
export const icon = '🚦'
export const core = true
export const depends = { 'event-bus': '^1.0.0' }
export const inject = ['event-bus']
export const provides = [{ name: 'chat-queue', type: 'singleton' }]

export function apply(ctx) {
  const events = ctx.inject('event-bus')
  const queues = new Map() // key -> { items: [], current: item|null }

  const getQueue = key => {
    let queue = queues.get(key)
    if (!queue) {
      queue = { key, items: [], current: null }
      queues.set(key, queue)
    }
    return queue
  }

  const abortError = () => {
    const err = new Error('请求已取消')
    err.code = 'CHAT_ABORTED'
    return err
  }

  const pump = key => {
    const queue = getQueue(key)
    if (queue.current || !queue.items.length) {
      if (!queue.current && !queue.items.length) queues.delete(key)
      return
    }
    const item = queue.items.shift()
    queue.current = item
    events.emit('chat-queue:start', { key, pending: queue.items.length })
    // 同步启动任务：让“开始生成”事件与发送调用发生在同一个 tick，
    // 前端停止按钮、占位消息等交互才能立即响应。
    let result
    try {
      result = item.task({ key, signal: item.controller.signal, cancelled: () => item.controller.signal.aborted })
    } catch (err) {
      result = Promise.reject(err)
    }
    Promise.resolve(result)
      .then(
        value => item.resolve(value),
        err => (item.controller.signal.aborted || err?.code === 'CHAT_ABORTED' ? item.reject(abortError()) : item.reject(err)),
      )
      .finally(() => {
        queue.current = null
        events.emit('chat-queue:finish', { key, pending: queue.items.length })
        pump(key)
      })
  }

  const service = {
    name: 'chat-queue',

    /**
     * 入队一个任务；任务签名 ({key, signal, cancelled}) => Promise。
     * 返回的 Promise 在任务执行完成后 settle。
     */
    enqueue(key, task) {
      if (typeof task !== 'function') return Promise.reject(new Error('队列任务必须是函数'))
      const controller = new AbortController()
      const queue = getQueue(key)
      return new Promise((resolve, reject) => {
        queue.items.push({ task, resolve, reject, controller })
        events.emit('chat-queue:enqueue', { key, pending: queue.items.length + (queue.current ? 1 : 0) })
        pump(key)
      })
    },

    busy: key => !!queues.get(key)?.current,
    pending: key => queues.get(key)?.items.length || 0,
    status(key) {
      const queue = queues.get(key)
      return { key, busy: !!queue?.current, pending: queue?.items.length || 0 }
    },

    /** 只中断当前正在执行的一轮；已排队的用户插话保留 */
    cancelCurrent(key, reason = '请求已取消') {
      const queue = queues.get(key)
      if (!queue?.current) return false
      queue.current.controller.abort(reason)
      events.emit('chat-queue:cancel', { key, mode: 'current' })
      return true
    },

    /** 中断当前并清空队列（用于会话删除 / 数据重置等场景） */
    cancelAll(key, reason = '队列已清空') {
      const queue = queues.get(key)
      if (!queue) return false
      if (queue.current) queue.current.controller.abort(reason)
      const items = queue.items.splice(0)
      for (const item of items) {
        item.controller.abort(reason)
        item.reject(abortError())
      }
      queues.delete(key)
      events.emit('chat-queue:cancel', { key, mode: 'all' })
      return true
    },

    all: () =>
      [...queues.values()].map(queue => ({
        key: queue.key,
        busy: !!queue.current,
        pending: queue.items.length,
      })),

    reset() {
      for (const key of [...queues.keys()]) service.cancelAll(key)
    },
  }

  ctx.provide('chat-queue', service, { type: 'singleton' })
  ctx.effect(() => service.reset())
  ctx.logger.debug('聊天串行队列就绪')
}
