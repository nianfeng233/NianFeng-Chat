/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * 后端 · runtime-logs
 * 参考 AstrBot 的日志做法：
 *   - 接入 backend cordis LoggerService 的 exporter，所有后端插件日志都进环形缓冲；
 *   - 实时通过 SSE（hub）广播给 WebUI 运行日志页；
 *   - 追加写入 <数据目录>/logs/runtime.log，超过 5MB 自动轮转为 runtime.log.1；
 *   - 提供 /api/logs/runtime 给日志页拉取历史。
 */
import { appendFile, mkdir, rename, stat } from 'node:fs/promises'
import { join } from 'node:path'

export const name = 'runtime-logs'
export const inject = ['settings', 'hub', 'httpApi']

const MAX_LINES = 2000
const MAX_FILE_BYTES = 5 * 1024 * 1024
const LEVEL_NAME = { 0: 'error', 1: 'warn', 2: 'info', 3: 'debug' }

const formatArg = value => {
  if (value instanceof Error) return `${value.message}${value.stack ? `\n${value.stack}` : ''}`
  if (value && typeof value === 'object') {
    try {
      return JSON.stringify(value)
    } catch (_) {
      return String(value)
    }
  }
  return String(value ?? '')
}

const pad = (value, len = 2) => String(value).padStart(len, '0')
const formatTime = at => {
  const date = new Date(Number(at) || Date.now())
  if (Number.isNaN(date.getTime())) return new Date().toISOString()
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
  )
}

export function apply(ctx) {
  const settings = ctx.settings
  const hub = ctx.hub
  const logsDir = join(settings.dataDir, 'logs')
  const logFile = join(logsDir, 'runtime.log')
  const lines = []

  let fileBytes = 0
  let writeChain = Promise.resolve()
  const ready = mkdir(logsDir, { recursive: true })
    .then(() => stat(logFile))
    .then(info => {
      fileBytes = Number(info.size) || 0
    })
    .catch(() => {
      fileBytes = 0
    })

  const appendLine = text => {
    writeChain = writeChain
      .then(async () => {
        await ready
        if (fileBytes > MAX_FILE_BYTES) {
          await rename(logFile, `${logFile}.1`).catch(() => {})
          fileBytes = 0
        }
        await appendFile(logFile, `${text}\n`, 'utf8')
        fileBytes += Buffer.byteLength(`${text}\n`, 'utf8')
      })
      .catch(() => {})
  }

  const record = ({ at, level, name, text }) => {
    const line = { at, level, name, text }
    lines.push(line)
    if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES)
    hub.broadcast('log/line', line)
  }

  const formatMessage = message => {
    const level = LEVEL_NAME[message?.level] || message?.type || 'info'
    const name = String(message?.name || 'backend')
    const text = (Array.isArray(message?.args) ? message.args : []).map(formatArg).join(' ')
    if (!text) return null
    const at = Number(message?.timestamp ?? message?.time ?? Date.now()) || Date.now()
    return {
      at,
      level,
      name,
      text,
      line: `${formatTime(at)} [${String(level).toUpperCase()}] [${name}] ${text}`,
    }
  }

  const dispose = ctx.root.logger.exporter({
    colors: 0,
    levels: { default: 3 },
    export(message) {
      const formatted = formatMessage(message)
      if (!formatted) return
      record({ at: formatted.at, level: formatted.level, name: formatted.name, text: formatted.text })
      appendLine(formatted.line)
    },
  })
  // 注意：backend 是原生 cordis ctx，effect(execute) 会立即执行；这里必须用
  // (() => () => dispose()) 的形态，才能在插件卸载时再把 exporter 移除。
  ctx.effect(() => () => dispose())

  const service = {
    name: 'runtime-logs',
    file: () => logFile,
    history: (limit = 200) => lines.slice(-Math.max(1, Number(limit) || 200)),
    clear: () => {
      lines.length = 0
    },
  }
  ctx.provide('runtimeLogs', service)

  ctx.httpApi.route('GET', '/api/logs/runtime', (req, res, params, url) => {
    const limit = Math.min(Math.max(Number(url?.searchParams?.get('limit') || 200), 1), MAX_LINES)
    ctx.httpApi.sendJson(res, 200, {
      file: logFile,
      lines: service.history(limit),
      total: lines.length,
    })
  })

  ctx.logger.info(`运行日志已接入：${logFile}`)
}
