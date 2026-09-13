/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * F3 · logger
 * 不自己造日志系统，而是接入 cordis 原生 LoggerService：
 *  - 注册一个 exporter：控制台输出 + 环形历史 + 订阅
 *  - 暴露 `logs` 服务给调试面板 / 设置页（等级过滤只影响控制台输出）
 *
 * 说明：插件代码里的 `ctx.logger` 就是 cordis 的 logger（带插件名），
 * 本插件只负责"把它接到用户看得见的地方"。
 */
export const name = 'logger'
export const version = '1.0.0'
export const displayName = '日志'
export const description = '基础服务 · cordis 日志导出器：控制台输出、历史记录与订阅。'
export const author = '念风内核'
export const icon = '📝'
export const core = true
export const depends = {}
export const optionalDepends = {
  'config': '>=1.1.0',
}
export const inject = ['config?']
export const provides = [{ name: 'logs', type: 'singleton' }]

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 }

export function apply(ctx) {
  const history = []
  const listeners = new Set()
  const MAX = 1000
  const config = ctx.inject('config')
  // 控制台固定输出 info 及以上；debug 级仍会转发到运行日志页，由用户在日志页按需勾选查看。
  let consoleLevel = 'info'

  const formatArg = value => {
    if (value instanceof Error) return `${value.message}\n${value.stack || ''}`
    if (typeof value === 'object' && value !== null) {
      try {
        return JSON.stringify(value)
      } catch (_) {
        return String(value)
      }
    }
    return value
  }

  /* ---------- WebUI 终端日志：把前端日志批量转发给后端统一落盘 ---------- */
  const FORWARD_LEVEL = { 0: 'error', 1: 'warn', 2: 'info', 3: 'debug' }
  const MAX_FORWARD_QUEUE = 800
  const forwardQueue = []
  let forwardTimer = null
  let forwarding = false

  const canForward = () => {
    try {
      return (
        typeof window !== 'undefined' &&
        typeof document !== 'undefined' &&
        typeof fetch === 'function' &&
        typeof EventSource !== 'undefined'
      )
    } catch (_) {
      return false
    }
  }

  const backendBase = () => {
    try {
      return String(config?.get?.('backend.url', '/api') || '/api').replace(/\/+$/, '')
    } catch (_) {
      return '/api'
    }
  }

  const normalizeForwardLevel = value => {
    if (typeof value === 'number' && Number.isFinite(value)) return FORWARD_LEVEL[value] || 'info'
    const text = String(value || '').trim().toLowerCase()
    if (text === 'warning') return 'warn'
    return ['error', 'warn', 'info', 'debug'].includes(text) ? text : 'info'
  }

  const scheduleForward = () => {
    if (forwardTimer || !canForward()) return
    forwardTimer = setTimeout(() => {
      forwardTimer = null
      flushForwardQueue()
    }, 250)
  }

  const flushForwardQueue = async () => {
    if (forwarding || !forwardQueue.length || !canForward()) return
    const batch = forwardQueue.splice(0, 200)
    forwarding = true
    try {
      const res = await fetch(`${backendBase()}/logs/client`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lines: batch }),
        credentials: 'same-origin',
        keepalive: true,
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
    } catch (_) {
      // 后端还没起来 / 暂时离线：放回队列稍后重试，最多保留最近 800 条。
      forwardQueue.unshift(...batch)
      if (forwardQueue.length > MAX_FORWARD_QUEUE) forwardQueue.splice(0, forwardQueue.length - MAX_FORWARD_QUEUE)
    } finally {
      forwarding = false
      if (forwardQueue.length) scheduleForward()
    }
  }

  const enqueueForward = message => {
    if (!canForward()) return
    const args = Array.isArray(message?.args) ? message.args : []
    const text = args.map(formatArg).join(' ').trim()
    if (!text) return
    forwardQueue.push({
      at: Number(message?.ts ?? message?.timestamp ?? Date.now()) || Date.now(),
      level: normalizeForwardLevel(message?.type ?? message?.level),
      name: String(message?.name || 'frontend').slice(0, 120),
      text: text.slice(0, 8000),
    })
    if (forwardQueue.length > MAX_FORWARD_QUEUE) forwardQueue.splice(0, forwardQueue.length - MAX_FORWARD_QUEUE)
    scheduleForward()
  }

  // 真实接入 cordis：所有 ctx.logger 的输出都会经过这里
  // 注意 ctx.logger 是带名字的 Logger 实例，exporter 方法在 LoggerService 上（root.logger）
  const dispose = ctx.root.logger.exporter({
    colors: 3,
    // default: 3 表示接收 debug 级在内的全部消息（是否打印由下面的 consoleLevel 决定）
    levels: { default: 3 },
    export(message) {
      history.push(message)
      if (history.length > MAX) history.splice(0, history.length - MAX)
      for (const listener of [...listeners]) {
        try {
          listener(message)
        } catch (_) {
          /* ignore */
        }
      }
      enqueueForward(message)
      if (message.level > (LEVELS[consoleLevel] ?? LEVELS.info)) return
      const fn = message.type === 'error' ? console.error : message.type === 'warn' ? console.warn : console.log
      fn(`%c[${message.name || 'app'}]`, 'color:#8b919c', ...message.args.map(formatArg))
    },
  })
  ctx.effect(dispose)
  ctx.effect(() => {
    if (forwardTimer) clearTimeout(forwardTimer)
    forwardTimer = null
    // 卸载 / 刷新前尽量把最后一批前端日志送到后端；失败也不阻塞页面。
    void flushForwardQueue()
  })

  const service = {
    name: 'logs',
    levels: Object.keys(LEVELS),
    history: () => [...history],
    clear: () => {
      history.length = 0
    },
    onRecord(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    setLevel(level) {
      if (LEVELS[level] === undefined) return
      consoleLevel = level
      ctx.emit('logger:level', level)
    },
    level: () => consoleLevel,
    count: () => history.length,
  }

  ctx.provide('logs', service, { type: 'singleton' })
  ctx.logger.info('日志已接入 cordis LoggerService（历史缓冲 + 控制台导出）')
}
