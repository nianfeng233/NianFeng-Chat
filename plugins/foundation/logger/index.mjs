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
export const inject = ['config?']
export const provides = [{ name: 'logs', type: 'singleton' }]

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 }

export function apply(ctx) {
  const history = []
  const listeners = new Set()
  const MAX = 1000
  const config = ctx.inject('config')
  let consoleLevel = config?.get?.('debug') ? 'debug' : 'info'
  // 即使启动时 config 服务还没就绪，只要之后切换 debug 也应立即生效。
  ctx.on('config:changed', ({ key, value } = {}) => {
    if (key === 'debug') consoleLevel = value ? 'debug' : 'info'
  })

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
      if (message.level > (LEVELS[consoleLevel] ?? LEVELS.info)) return
      const fn = message.type === 'error' ? console.error : message.type === 'warn' ? console.warn : console.log
      fn(`%c[${message.name || 'app'}]`, 'color:#8b919c', ...message.args.map(formatArg))
    },
  })
  ctx.effect(dispose)

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
