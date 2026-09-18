/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * 后端 · runtime-logs
 * 参考 AstrBot 的日志做法，并做持久化增强：
 *
 *   - 尽早接入 backend cordis LoggerService，所有后端插件日志：
 *       终端彩色输出 + 环形缓冲 + 追加写入 <数据目录>/logs/runtime.log；
 *   - 文件在启动时回读到内存，所以刷新 WebUI / 重启后端后历史日志仍在；
 *   - 通过 /api/logs/runtime 提供分页历史；
 *   - 通过 /api/logs/runtime/stream 提供专用 SSE 实时日志流（支持 Last-Event-ID）；
 *   - 通过 hub 的 log/line 事件兼容旧日志页 / 其它消费者；
 *   - /api/logs/client 接收 WebUI 前端日志，统一落到终端、文件与 SSE，
 *     保证 chat-flow / 工具 / 权限 / 外发等前端链路日志刷新后也不丢。
 *
 * 终端格式对齐 AstrBot：`[时间] [Core|Plug|Web][来源] [LEVEL] 内容`
 */
import { appendFile, mkdir, readFile, rename, stat, truncate } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

export const name = 'runtime-logs'
export const inject = ['settings', 'hub', 'httpApi']

const MAX_LINES = 4000
const MAX_FILE_BYTES = 8 * 1024 * 1024
const MAX_CLIENT_BATCH = 500
const MAX_TEXT_CHARS = 24000

const LEVEL_BY_NUMBER = { 0: 'error', 1: 'warn', 2: 'info', 3: 'debug' }
const LEVEL_TAG = { error: 'ERROR', warn: 'WARN ', info: 'INFO ', debug: 'DEBUG' }
const LEVEL_RANK = { error: 0, warn: 1, info: 2, debug: 3 }

/** 进入日志页“系统”分类的核心后端 logger 名称。 */
const CORE_LOGGERS = new Set([
  'app',
  'root',
  'backend',
  'runtime-logs',
  'settings',
  'sessions',
  'hub',
  'models',
  'instance',
  'plugin-registry',
  'http',
  'server',
])

const ANSI = {
  reset: '\u001b[0m',
  gray: '\u001b[90m',
  red: '\u001b[31m',
  yellow: '\u001b[33m',
  cyan: '\u001b[36m',
  magenta: '\u001b[35m',
}

const USE_COLOR = (() => {
  try {
    return process.stdout.isTTY === true && !process.env.NO_COLOR
  } catch (_) {
    return false
  }
})()

const colorize = (value, color) => (USE_COLOR && color ? `${color}${value}${ANSI.reset}` : value)

const formatArg = value => {
  if (value instanceof Error) return `${value.message}${value.stack ? `\n${value.stack}` : ''}`
  if (value === undefined) return 'undefined'
  if (value === null) return 'null'
  if (typeof value === 'object') {
    try {
      const text = JSON.stringify(value)
      return text.length > 8000 ? `${text.slice(0, 8000)}…[truncated]` : text
    } catch (_) {
      return String(value)
    }
  }
  const text = String(value)
  return text.length > 8000 ? `${text.slice(0, 8000)}…[truncated]` : text
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

const normalizeLevel = value => {
  if (typeof value === 'number' && Number.isFinite(value)) return LEVEL_BY_NUMBER[value] || 'info'
  const text = String(value || '').trim().toLowerCase()
  if (text === 'warning') return 'warn'
  if (text === 'error' || text === 'warn' || text === 'info' || text === 'debug') return text
  if (/^\d+$/.test(text)) return LEVEL_BY_NUMBER[Number(text)] || 'info'
  return 'info'
}

const parseTime = value => {
  const text = String(value || '')
    .trim()
    .replace(/\//g, '-')
    .replace(' ', 'T')
  const parsed = Date.parse(text)
  return Number.isFinite(parsed) ? parsed : Date.now()
}

const clampText = value => {
  const text = String(value ?? '').replace(/\r\n/g, '\n')
  return text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}…[truncated]` : text
}

/** 新格式：`[时间] [Core][name] [LEVEL] 内容`；旧格式：`时间 [LEVEL] [name] 内容`。 */
const HEADER_RE = /^\[([^\]]+)\]\s+\[([^\]]+)\]\[([^\]]*)\]\s+\[([A-Za-z]+)\]\s?([\s\S]*)$/
const LEGACY_RE = /^(\d{4}[-/]\d{1,2}[-/]\d{1,2}[ T]\d{1,2}:\d{2}:\d{2}(?:\.\d{1,3})?)\s+\[([A-Za-z]+)\]\s+\[([^\]]+)\]\s?([\s\S]*)$/

const makeLine = (entry = {}) => {
  const at = Number(entry.at) || Date.now()
  const level = normalizeLevel(entry.level)
  const name = String(entry.name || 'app').slice(0, 160)
  const origin = entry.origin === 'web' ? 'web' : 'backend'
  const tag =
    entry.tag ||
    (origin === 'web' ? 'Web' : CORE_LOGGERS.has(name) ? 'Core' : 'Plug')
  const text = clampText(entry.text)
  if (!text.trim()) return null
  return {
    id: 0,
    at,
    time: formatTime(at),
    level,
    tag,
    name,
    origin,
    text,
    // 前端日志的客户端唯一 ID：日志页据此精确去重；后端日志 / 旧日志为空串。
    clientId: String(entry.clientId || entry.client_id || ''),
    line: '',
  }
}

const refreshLine = item => {
  item.line = `[${item.time}] [${item.tag}][${item.name}] [${LEVEL_TAG[item.level]}] ${item.text}`
  return item
}

const writeConsole = (item, consoleLevel = 'info') => {
  // 终端只输出当前级别及以上的日志：默认 info，debug（含每条 HTTP 访问）只落盘。
  if (LEVEL_RANK[item.level] > LEVEL_RANK[consoleLevel]) return
  const tagColor = item.tag === 'Web' ? ANSI.magenta : item.tag === 'Plug' ? ANSI.cyan : ANSI.gray
  const levelColor = item.level === 'error' ? ANSI.red : item.level === 'warn' ? ANSI.yellow : item.level === 'debug' ? ANSI.gray : ANSI.cyan
  const prefix =
    `${colorize(`[${item.time}]`, ANSI.gray)} ` +
    `${colorize(`[${item.tag}]`, tagColor)}` +
    `${colorize(`[${item.name}]`, tagColor)} ` +
    `${colorize(`[${LEVEL_TAG[item.level]}]`, levelColor)} `
  process.stdout.write(`${prefix}${item.text}\n`)
}

const parseLogFile = (raw, target) => {
  const rows = String(raw || '').split(/\r?\n/)
  for (const row of rows) {
    if (!row) continue
    let match = row.match(HEADER_RE)
    if (match) {
      const item = makeLine({
        at: parseTime(match[1]),
        tag: match[2],
        name: match[3],
        level: match[4],
        text: match[5],
      })
      if (item) target.push(item)
      continue
    }
    match = row.match(LEGACY_RE)
    if (match) {
      const item = makeLine({
        at: parseTime(match[1]),
        tag: 'Core',
        name: match[3],
        level: match[2],
        text: match[4],
      })
      if (item) target.push(item)
      continue
    }
    const last = target[target.length - 1]
    if (last) {
      last.text = clampText(`${last.text}\n${row}`)
      refreshLine(last)
    } else {
      const item = makeLine({ at: Date.now(), tag: 'Core', name: 'runtime-logs', level: 'info', text: row })
      if (item) target.push(item)
    }
  }
}

const nativeEffect = (ctx, cleanup) => {
  if (typeof ctx?.effect !== 'function') return
  // server/plugins 由 Node 原生 cordis 加载：effect(execute) 会立即执行 execute
  // 并注册其返回的 disposer，因此必须用两层函数形式。
  ctx.effect(() => () => cleanup())
}

export function createRuntimeLogStore(ctx, { dataDir = process.cwd(), version = '', consoleLevel = 'info' } = {}) {
  const logsDir = join(dataDir, 'logs')
  const logFile = join(logsDir, 'runtime.log')
  const rotatedFile = `${logFile}.1`
  // 内部 JSONL 索引：runtime.log 保持终端可读；JSONL 保证多行堆栈 / 特殊字符
  // 在重启后也能精确还原，不受人工阅读格式变化影响。
  const indexFile = join(logsDir, 'runtime.log.jsonl')
  const rotatedIndexFile = `${indexFile}.1`
  // 每次后端进程启动生成一个新实例 ID：前端据此识别「后端重启 / 日志文件被换掉」。
  // 单纯比较日志行 id 在重启后可能相等或复用，会让增量拉取永远漏日志。
  const instanceId = `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`

  const lines = []
  const listeners = new Set()
  const sseClients = new Set()
  let seq = 0
  let fileBytes = 0
  let activeConsoleLevel = normalizeLevel(consoleLevel)
  let writeChain = Promise.resolve()
  let readyResolve = () => {}
  const ready = new Promise(resolve => {
    readyResolve = resolve
  })

  const appendFiles = item => {
    writeChain = writeChain
      .then(async () => {
        await ready.catch(() => {})
        if (fileBytes >= MAX_FILE_BYTES) {
          await rename(logFile, rotatedFile).catch(() => {})
          await rename(indexFile, rotatedIndexFile).catch(() => {})
          fileBytes = 0
        }
        const lineChunk = `${item.line}\n`
        const indexChunk = `${JSON.stringify({
          at: item.at,
          level: item.level,
          tag: item.tag,
          name: item.name,
          origin: item.origin,
          text: item.text,
          clientId: item.clientId || '',
        })}\n`
        await appendFile(logFile, lineChunk, 'utf8')
        await appendFile(indexFile, indexChunk, 'utf8')
        fileBytes += Buffer.byteLength(lineChunk, 'utf8')
      })
      .catch(() => {})
  }

  const writeSse = item => {
    if (!sseClients.size) return
    const payload = `id: ${item.id}\nevent: log\ndata: ${JSON.stringify(item)}\n\n`
    for (const client of [...sseClients]) {
      try {
        client.write(payload)
      } catch (_) {
        sseClients.delete(client)
      }
    }
  }

  const record = (entry = {}, { persist = true, broadcast = true } = {}) => {
    const item = makeLine(entry)
    if (!item) return null
    item.id = ++seq
    refreshLine(item)
    lines.push(item)
    if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES)
    if (persist) appendFiles(item)
    writeConsole(item, activeConsoleLevel)
    if (broadcast) {
      for (const listener of [...listeners]) {
        try {
          listener(item)
        } catch (_) {
          /* 单个消费者异常不影响其它消费者 */
        }
      }
      writeSse(item)
    }
    return item
  }

  // 文件回读：优先读内部 JSONL 索引（精确还原多行堆栈），旧实例没有 JSONL 时
  // 再降级解析 runtime.log 这种人类可读格式。
  const loading = (async () => {
    try {
      await mkdir(logsDir, { recursive: true })
      const loaded = []
      for (const file of [rotatedIndexFile, indexFile]) {
        try {
          const raw = await readFile(file, 'utf8')
          for (const row of raw.split(/\r?\n/)) {
            if (!row) continue
            try {
              const entry = JSON.parse(row)
              const item = makeLine({
                at: entry.at,
                level: entry.level,
                tag: entry.tag,
                name: entry.name,
                origin: entry.origin,
                text: entry.text,
                  clientId: entry.clientId,
              })
              if (item) loaded.push(item)
            } catch (_) {
              /* 跳过损坏行 */
            }
          }
        } catch (_) {
          /* 索引不存在 */
        }
      }
      if (!loaded.length) {
        for (const file of [rotatedFile, logFile]) {
          try {
            const raw = await readFile(file, 'utf8')
            parseLogFile(raw, loaded)
          } catch (_) {
            /* 文件不存在或暂不可读 */
          }
        }
      }
      const current = lines.splice(0, lines.length)
      const merged = [...loaded, ...current]
      const start = Math.max(0, merged.length - MAX_LINES)
      for (let i = start; i < merged.length; i++) {
        const item = merged[i]
        item.id = ++seq
        refreshLine(item)
        lines.push(item)
      }
      try {
        const info = await stat(logFile)
        fileBytes = Number(info.size) || 0
      } catch (_) {
        fileBytes = 0
      }
    } catch (_) {
      /* 加载失败也不能影响后端启动 */
    } finally {
      readyResolve()
    }
  })()

  const store = {
    name: 'runtimeLogs',
    version,
    instanceId: () => instanceId,
    consoleLevel: () => activeConsoleLevel,
    setConsoleLevel(level) {
      activeConsoleLevel = normalizeLevel(level)
      return activeConsoleLevel
    },
    file: () => logFile,
    rotatedFile: () => rotatedFile,
    ready: () => ready,
    total: () => lines.length,
    latestId: () => (lines.length ? lines[lines.length - 1].id : 0),
    query: ({ limit = 500, before = 0, after = 0 } = {}) => {
      const max = Math.min(Math.max(Number(limit) || 500, 1), MAX_LINES)
      let list = lines
      const afterId = Number(after) || 0
      const beforeId = Number(before) || 0
      if (afterId > 0) list = list.filter(item => item.id > afterId)
      if (beforeId > 0) list = list.filter(item => item.id < beforeId)
      // after 用于从旧游标向前补日志：必须返回“最早的一段”，否则一次落后超过
      // limit 时会被 slice(-max) 直接跳到最新，把中间行永久漏掉。无 after 时
      // 保持原来的语义，返回最新一页。
      return afterId > 0 ? list.slice(0, max) : list.slice(-max)
    },
    onLine(callback) {
      listeners.add(callback)
      return () => listeners.delete(callback)
    },
    addSseClient(client, { lastEventId = 0 } = {}) {
      sseClients.add(client)
      try {
        client.write('retry: 3000\n\n')
        const since = Number(lastEventId) || 0
        if (since > 0) {
          for (const item of lines.filter(line => line.id > since)) {
            client.write(`id: ${item.id}\nevent: log\ndata: ${JSON.stringify(item)}\n\n`)
          }
        }
      } catch (_) {
        sseClients.delete(client)
      }
    },
    removeSseClient(client) {
      sseClients.delete(client)
      try {
        client.end?.()
      } catch (_) {
        /* ignore */
      }
    },
    ping() {
      for (const client of [...sseClients]) {
        try {
          client.write(`: ping ${Date.now()}\n\n`)
        } catch (_) {
          sseClients.delete(client)
        }
      }
    },
    addClientLines(list) {
      const batch = Array.isArray(list) ? list.slice(0, MAX_CLIENT_BATCH) : []
      let count = 0
      for (const raw of batch) {
        if (!raw || typeof raw !== 'object') continue
        const clientId = String(raw.clientId || raw.client_id || '').trim();
        if (clientId && lines.some(item => item.clientId && item.clientId === clientId)) continue;
        const item = record({
          at: raw.at ?? raw.ts ?? Date.now(),
          level: raw.level ?? raw.type,
          name: raw.name || 'frontend',
          text: raw.text ?? raw.data ?? '',
          origin: 'web',
          tag: raw.tag || 'Web',
          clientId,
        })
        if (item) count += 1
      }
      return count
    },
    async clear() {
      lines.splice(0, lines.length)
      try {
        await truncate(logFile, 0)
      } catch (_) {
        /* ignore */
      }
      try {
        await truncate(indexFile, 0)
      } catch (_) {
        /* ignore */
      }
      fileBytes = 0
      return true
    },
  }

  // 尽早注册 exporter：调用方可以在加载任何插件之前先 attach，
  // 这样设置 / 会话 / HTTP / 渠道桥的启动日志也能进入终端和 runtime.log。
  const disposeExporter = ctx.root.logger.exporter({
    colors: 0,
    levels: { default: 3 },
    export(message) {
      const args = Array.isArray(message?.args) ? message.args : []
      const text = args.map(formatArg).join(' ').trim()
      if (!text) return
      record({
        at: Number(message?.ts ?? message?.timestamp ?? Date.now()) || Date.now(),
        level: message?.type ?? message?.level,
        name: message?.name || 'app',
        text,
        origin: 'backend',
      })
    },
  })
  nativeEffect(ctx, disposeExporter)
  loading.catch(() => {})

  return store
}

let activeStore = null

/** 尽早 attach：由 server/index.mjs 在加载任何插件之前调用。 */
export function attachRuntimeLogStore(ctx, options = {}) {
  activeStore = createRuntimeLogStore(ctx, options)
  return activeStore
}

export function getRuntimeLogStore() {
  return activeStore
}

export function apply(ctx) {
  const settings = ctx.settings
  const hub = ctx.hub
  const httpApi = ctx.httpApi
  const store =
    getRuntimeLogStore() ||
    attachRuntimeLogStore(ctx, {
      dataDir: settings?.dataDir || process.cwd(),
      version: ctx.info?.version || '',
    })

  ctx.provide('runtimeLogs', store)

  // 后端终端默认只打印 info 及以上；debug 仍写入 runtime.log / 日志页，
  // 避免浏览器每次刷新产生的一串 HTTP 访问日志把终端刷屏。
  const configuredLogLevel = settings?.get?.()?.logLevel
  if (configuredLogLevel) store.setConsoleLevel(configuredLogLevel)
  const offLogLevel = ctx.on?.('config:changed', payload => {
    const key = String(payload?.key || '')
    if (key === '*' || key === 'logLevel') store.setConsoleLevel(settings?.get?.()?.logLevel)
  })
  if (typeof offLogLevel === 'function') ctx.effect(() => () => offLogLevel())

  // 兼容旧日志页 / 其它消费者：hub 上的 log/line 事件保持原样。
  const offHubLine = store.onLine(line => {
    try {
      hub.broadcast('log/line', line)
    } catch (_) {
      /* hub 不可用时忽略 */
    }
  })
  ctx.effect(() => () => offHubLine())

  const pingTimer = setInterval(() => store.ping(), 20000)
  ctx.effect(() => () => clearInterval(pingTimer))

  const disposeRoutes = []
  disposeRoutes.push(
    httpApi.route('GET', '/api/logs/runtime', async (req, res, params, url) => {
      await store.ready()
      const limit = Math.min(Math.max(Number(url?.searchParams?.get('limit') || 500), 1), MAX_LINES)
      const before = Number(url?.searchParams?.get('before') || 0) || 0
      const after = Number(url?.searchParams?.get('after') || 0) || 0
      httpApi.sendJson(res, 200, {
        file: store.file(),
        version: store.version,
        instance: store.instanceId(),
        lines: store.query({ limit, before, after }),
        total: store.total(),
        latestId: store.latestId(),
      })
    }),
  )
  disposeRoutes.push(
    httpApi.route('GET', '/api/logs/runtime/stream', async (req, res) => {
      await store.ready()
      const lastEventId = Number(req.headers['last-event-id']) || 0
      httpApi.sse(res, out => {
        store.addSseClient(out, { lastEventId })
        req.on('close', () => store.removeSseClient(out))
      })
    }),
  )
  disposeRoutes.push(
    httpApi.route('POST', '/api/logs/client', async (req, res) => {
      await store.ready()
      const body = await httpApi.readBody(req)
      const count = store.addClientLines(Array.isArray(body?.lines) ? body.lines : [])
      httpApi.sendJson(res, 200, { ok: true, count })
    }),
  )
  disposeRoutes.push(
    httpApi.route('DELETE', '/api/logs/runtime', async (req, res) => {
      await store.clear()
      httpApi.sendJson(res, 200, { ok: true })
    }),
  )
  ctx.effect(() => () => {
    for (const dispose of disposeRoutes) {
      try {
        dispose?.()
      } catch (_) {
        /* ignore */
      }
    }
  })
  httpApi.registerCapability?.('runtime-logs')

  ctx.logger.info(`运行日志已接入：${store.file()}（终端 + 文件 + SSE 实时，刷新不丢历史）`)
}
