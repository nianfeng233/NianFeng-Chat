/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * V? · settings-item-logs
 * 运行日志页（类似 AstrBot 的日志台）：
 *   - 实时收集 cordis logger 历史 / 订阅
 *   - 把模型阶段、工具调用、权限确认、渠道外发转成可读时间线
 *   - 同步后端请求日志，便于判断是超时、排队还是压根没发出去
 */
export const name = 'settings-item-logs'
export const version = '1.0.0'
export const displayName = '视图 · 运行日志'
export const description = '独立运行日志视图：模型调用阶段、工具 / 渠道消息 / 权限确认与后端运行日志。'
export const author = '念风内核'
export const icon = '📝'
export const core = false
export const depends = {
  'event-bus': '*',
  'view-router': '^1.0.0',
}
export const optionalDepends = {
  'backend-client': '>=1.0.0',
  'config': '>=1.1.0',
  'logger': '^1.0.0',
  'toast-host': '>=1.0.0',
}
export const inject = ['view-router', 'logs?', 'api?', 'event-bus', 'config?', 'toast?']

import { useStyle } from '../../../src/util/style.mjs'
import { describeIncomingMessage } from '../../../src/util/message-log.mjs'
import { LOGS_CSS } from './style.mjs'

const LEVEL_LABEL = { error: '错误', warn: '警告', info: '信息', debug: '调试' }
const LEVEL_ORDER = ['error', 'warn', 'info', 'debug']
const DEFAULT_LEVELS = ['info']
const MAX_ENTRIES = 4000
const MAX_RENDER = 1200
const PAGE_LIMIT = 2000
const FULL_LIMIT = 4000

const escapeHtml = value =>
  String(value ?? '')
    .replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[m])

/** HTTP 访问日志（如 `HTTP POST /api/xxx → 200 · 3ms`）对普通用户没有意义，日志页默认不展示。 */
const isHttpAccessLog = text =>
  /^HTTP\s+(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+\S+\s*→\s*\d{3}\s*·\s*\d+ms/i.test(String(text || '').trim())

const pad = (value, len = 2) => String(value).padStart(len, '0')
const formatTime = at => {
  const date = new Date(Number(at) || Date.now())
  if (Number.isNaN(date.getTime())) return '--:--:--'
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
}

const formatArg = value => {
  if (value instanceof Error) return `${value.message}${value.stack ? `\n${value.stack}` : ''}`
  if (typeof value === 'object' && value !== null) {
    try {
      return JSON.stringify(value)
    } catch (_) {
      return String(value)
    }
  }
  return String(value)
}

const categoryOfSource = name => {
  const text = String(name || '')
  if (text.includes('chat-flow') || text.includes('model')) return '模型'
  if (text.includes('chat-tools') || text.includes('tool')) return '工具'
  if (text.includes('chat-permissions') || text.includes('permission')) return '权限'
  if (text.includes('channel') || text.includes('napcat') || text.includes('qqbot') || text.includes('clawbot')) return '外发'
  if (text.includes('backend') || text.includes('http')) return '后端'
  return '系统'
}

export function apply(ctx) {
  const router = ctx.inject('view-router')
  const logs = ctx.inject('logs?')
  const api = ctx.inject('api?')
  const events = ctx.inject('event-bus')
  const config = ctx.inject('config?')
  const toast = ctx.inject('toast?')

  useStyle(ctx, LOGS_CSS)

  router.register('logs', {
    label: '运行日志',
    icon: '📝',
    // 侧栏已有独立日志入口，不再出现在顶部视图导航里。
    rail: false,
    // 日志视图独占整个主面板，不显示左侧会话 / 渠道列表。
    fullWidth: true,
    // 第一次点开日志时才建立日志采集 / SSE / 轮询。
    lazy: true,
    order: 30,
    main(container) {
      const readLevels = () => {
        const saved = config?.get?.('logs.levels', undefined)
        const list = Array.isArray(saved) ? saved : typeof saved === 'string' ? saved.split(',') : null
        const normalized = (list || DEFAULT_LEVELS).map(level => String(level || '').trim()).filter(level => LEVEL_LABEL[level])
        return new Set(normalized.length ? normalized : list ? [] : DEFAULT_LEVELS)
      }
      let selectedLevels = readLevels()
      const levelOptions = LEVEL_ORDER.map(
        level => `<label class="logs-level-option"><input type="checkbox" data-logs-level="${level}"${
          selectedLevels.has(level) ? ' checked' : ''
        } />${LEVEL_LABEL[level]}</label>`,
      ).join('')

      container.innerHTML = `
        <div class="logs-page">
        <div class="settings-title-row">
          <div>
            <div class="settings-title">运行日志</div>
            <div class="settings-desc">模型、工具、权限确认与渠道消息时间线（实时 SSE + 轮询兜底）；页面刷新或重启后端后历史仍保留。</div>
          </div>
        </div>
        <section class="settings-section">
          <div class="logs-toolbar">
            <div class="logs-levels" data-logs-levels role="group" aria-label="日志级别" title="按类型自由勾选；默认只看信息">
              ${levelOptions}
            </div>
            <select data-logs-cat title="来源分类">
              <option value="">全部分类</option>
              <option value="模型">模型</option>
              <option value="工具">工具</option>
              <option value="权限">权限</option>
              <option value="外发">渠道</option>
              <option value="后端">后端</option>
              <option value="系统">系统</option>
            </select>
            <input data-logs-search type="search" placeholder="搜索 conversation / 工具名 / 错误关键词…" />
            <button class="outline-btn on" data-logs-autoscroll title="有新日志时自动滚到底部">自动滚动</button>
            <button class="outline-btn" data-logs-pause title="暂停刷新列表，日志仍会继续收集">暂停</button>
            <button class="outline-btn" data-logs-clear>清空</button>
            <button class="outline-btn" data-logs-copy>复制</button>
            <button class="outline-btn" data-logs-export>导出日志</button>
            <button class="outline-btn" data-logs-refresh title="重新从后端拉取完整日志并回到最新位置；SSE / 代理卡顿时可手动兜底">刷新</button>
            <button class="outline-btn" data-logs-jump hidden title="有新日志；点击回到底部">有新日志 ↓</button>
            <span class="logs-stats" data-logs-stats></span>
          </div>
          <div class="logs-list" data-logs-list>
            <div class="logs-empty">正在读取日志…</div>
          </div>
          <div class="logs-note">
            WebUI 直接读取后端终端日志（<code>logs/runtime.log</code>）：模型请求开始 / 完成 / 错误、工具调用与耗时、敏感操作确认、
            渠道消息收发都会实时出现；页面刷新不会清空，重启后端也会回读最近历史。
            <span data-logs-backend-file></span>
            <span data-logs-sync-hint></span>
          </div>
        </section>
        </div>`

      const listEl = container.querySelector('[data-logs-list]')
      const statsEl = container.querySelector('[data-logs-stats]')
      const levelInputs = [...container.querySelectorAll('[data-logs-level]')]
      // DOM 解析不会把 checked 属性同步到 property（测试环境 / 部分宿主），这里显式同步。
      for (const input of levelInputs) input.checked = selectedLevels.has(input.dataset.logsLevel)
      const catSelect = container.querySelector('[data-logs-cat]')
      const searchInput = container.querySelector('[data-logs-search]')
      const autoBtn = container.querySelector('[data-logs-autoscroll]')
      const pauseBtn = container.querySelector('[data-logs-pause]')
      const backendFileEl = container.querySelector('[data-logs-backend-file]')
      const syncHintEl = container.querySelector('[data-logs-sync-hint]')
      const jumpBtn = container.querySelector('[data-logs-jump]')

      let entries = []
      let seq = 0
      let autoScroll = true
      let paused = false
      // 用户手动向上翻日志时累计的新日志数量，用于“有新日志 ↓”提示。
      let unseen = 0
      let renderTimer = null
      let backendTimer = null
      let backendFile = ''
      const backendSeen = new Set()
      // 前端本地日志 + 后端运行时日志合并展示；内容指纹 + clientId 双重去重。
      const entryKeys = new Set()
      const clientIdKeys = new Set()
      // 后端 /api/logs/runtime/stream（SSE）状态；旧后端没有该接口时靠轮询兜底。
      let runtimeSource = null
      let streamRestartTimer = null
      let runtimeAvailable = false
      // 后端进程实例 ID：后端重启 / 换数据目录后即使日志 id 重新从 1 开始，
      // 前端也能识别并强制重拉全量，避免增量 after 永远卡在旧 id 上。
      let runtimeInstance = ''
      let latestRuntimeId = 0
      let backendTotal = 0
      let streamOnline = false
      let active = true
      // 本端落库产生的 message:added 与后端 sessions/changed 回放的是同一条消息；
      // 用消息 id 去重，避免 WebUI 既处理渠道消息又收到 SSE 回放时出现两条“收到消息”。
      const inboundLoggedKeys = new Set()
      const inboundKeyOf = (conversationId, message) => {
        if (!message) return ''
        const id = message.message_id || message.id || message.seq || ''
        const fallback = `${Number(message.createdAt) || 0}:${String(message.content || '').slice(0, 80)}`
        return `${String(conversationId || '')}:${id ? String(id) : fallback}`
      }
      const markInboundLogged = (conversationId, message) => {
        const key = inboundKeyOf(conversationId, message)
        if (!key || inboundLoggedKeys.has(key)) return false
        inboundLoggedKeys.add(key)
        if (inboundLoggedKeys.size > 800) {
          for (const value of [...inboundLoggedKeys].slice(0, 200)) inboundLoggedKeys.delete(value)
        }
        return true
      }

      /** 日志按时间排序；同一毫秒内保持进入列表的先后顺序。 */
      const compareEntries = (a, b) => (Number(a.at) || 0) - (Number(b.at) || 0) || a.id - b.id

      const scheduleRender = () => {
        if (!active || paused || renderTimer) return
        renderTimer = setTimeout(() => {
          renderTimer = null
          render()
        }, 80)
      }

      const updateJumpBtn = () => {
        if (!jumpBtn) return
        const show = unseen > 0 && !autoScroll
        jumpBtn.hidden = !show
        if (show) jumpBtn.textContent = `有新日志 ${unseen > 999 ? '999+' : unseen} ↓`
      }

      const syncLevelChecks = () => {
        for (const input of levelInputs) input.checked = selectedLevels.has(input.dataset.logsLevel)
      }

      const fingerprintOf = entry => {
        const at = Number(entry?.at) || Date.now()
        const text = String(entry?.text || '').slice(0, 600)
        const source = String(entry?.source || '')
        const clientId = String(entry?.clientId || '')
        // 时间按 50ms 分桶：前端本地记录与后端回传的同一行时间会略有差异，
        // 但内容 / 来源一致时应当合并成一条；clientId 相同则一定同源。
        return `${clientId}|${Math.round(at / 50)}|${source}|${text}`
      }

      const add = entry => {
        if (!active) return false
        const item = {
          id: ++seq,
          at: Date.now(),
          level: 'info',
          cat: '系统',
          source: '',
          text: '',
          clientId: '',
          timeout: false,
          ...entry,
        }
        const clientId = String(item.clientId || '')
        if (clientId && clientIdKeys.has(clientId)) return false
        const key = fingerprintOf(item)
        if (entryKeys.has(key)) return false
        entryKeys.add(key)
        if (clientId) clientIdKeys.add(clientId)
        if (entryKeys.size > MAX_ENTRIES * 2) {
          entryKeys.clear()
          clientIdKeys.clear()
          for (const existing of entries) {
            entryKeys.add(fingerprintOf(existing))
            if (existing.clientId) clientIdKeys.add(existing.clientId)
          }
        }
        entries.push(item)
        if (entries.length > MAX_ENTRIES) {
          // 历史回填可能晚于本地日志到达，按时间排序后再截断，避免把最新日志裁掉。
          entries.sort(compareEntries)
          entries.splice(0, entries.length - MAX_ENTRIES)
        }
        if (!autoScroll) {
          unseen += 1
          updateJumpBtn()
        }
        scheduleRender()
        return true
      }

      const normalizeLevel = value => {
        if (typeof value === 'number' && Number.isFinite(value)) return ['error', 'warn', 'info', 'debug'][value] || 'info'
        const text = String(value || '').trim().toLowerCase()
        if (text === 'warning') return 'warn'
        return LEVEL_LABEL[text] ? text : 'info'
      }

      const addRawLog = record => {
        const args = Array.isArray(record?.args) ? record.args : []
        const text = args.map(formatArg).join(' ').slice(0, 8000)
        if (!text) return false
        if (isHttpAccessLog(text)) return false
        const source = String(record?.name || 'app')
        const cat = categoryOfSource(source)
        return add({
          at: Number(record?.ts ?? record?.timestamp ?? record?.time ?? Date.now()) || Date.now(),
          level: normalizeLevel(record?.type ?? record?.level),
          cat,
          source,
          text,
          clientId: String(record?.nfId || record?.clientId || ''),
          timeout: /timeout|超时|ETIMEDOUT|timed out/i.test(text),
        })
      }

      const addBackendRequest = request => {
        if (!request) return false
        const status = Number(request.status) || 0
        // 只有失败请求值得展示；2xx/3xx 访问日志属于噪音。
        if (status < 400) return false
        const key = `${request?.at || ''}|${request?.method || ''}|${request?.path || ''}|${status}`
        if (backendSeen.has(key)) return false
        backendSeen.add(key)
        return add({
          at: Number(request.at) || Date.now(),
          level: status >= 500 ? 'error' : 'warn',
          cat: '后端',
          source: 'http',
          text: `${request.method || 'GET'} ${request.path || ''} → HTTP ${status || '-'} · ${Number(request.ms) || 0}ms`,
        })
      }

      const render = () => {
        if (!active || !listEl) return
        const keepScrollTop = listEl.scrollTop
        const cat = catSelect?.value || ''
        const keyword = String(searchInput?.value || '').trim().toLowerCase()
        // 先按时间排序再过滤 / 截断：历史回填、SSE 与轮询混在一起时顺序仍然稳定。
        const sortedEntries = [...entries].sort(compareEntries)
        const visible = sortedEntries
          .filter(item => selectedLevels.has(item.level))
          .filter(item => !cat || item.cat === cat)
          .filter(item => !keyword || `${item.source} ${item.text}`.toLowerCase().includes(keyword))
          .slice(-MAX_RENDER)
        listEl.innerHTML = visible.length
          ? visible
              .map(
                item => `<div class="logs-row level-${item.level}${item.timeout ? ' timeout' : ''}">
                  <span class="logs-time">${escapeHtml(formatTime(item.at))}</span>
                  <span class="logs-src" title="${escapeHtml(item.source)}">${escapeHtml(String(item.level || 'info').toUpperCase())} · ${escapeHtml(item.source || item.cat)}</span>
                  <span class="logs-text">${escapeHtml(item.text)}</span>
                </div>`,
              )
              .join('')
          : `<div class="logs-empty">${
              selectedLevels.size ? '当前筛选条件下没有日志' : '请至少勾选一种日志类型'
            }</div>`
        if (statsEl) {
          const streamText = streamOnline ? '实时流已连接' : runtimeAvailable ? '轮询更新中' : '后端未连接'
          const levelText = LEVEL_ORDER.filter(level => selectedLevels.has(level))
            .map(level => LEVEL_LABEL[level])
            .join('/')
          statsEl.textContent = `${entries.length} 条 · 显示 ${visible.length} 条 · ${levelText || '未选级别'} · ${streamText}${
            paused ? ' · 已暂停' : ''
          }`
        }
        if (syncHintEl) {
          syncHintEl.textContent = runtimeAvailable
            ? streamOnline
              ? ' 实时流已连接；代理 / 断线时自动退化为 3 秒轮询，也可以点「刷新」立即重拉。'
              : ' 实时流未连接，正在用 3 秒轮询兜底；也可以点「刷新」立即重拉。'
            : ' 当前后端没有运行时日志实时接口（可能是旧进程或旧后端）：请重启后端后再打开日志页；现在只能看到浏览器端日志与旧请求日志。'
        }
        // 重新 innerHTML 会丢失原滚动位置：自动滚动时直接到底；用户手动翻上去
        // 时保留原位置，并显示“有新日志”提示，避免刷新/实时更新看起来没反应。
        if (autoScroll) {
          unseen = 0
          if (!paused) listEl.scrollTop = listEl.scrollHeight
        } else {
          listEl.scrollTop = Math.min(keepScrollTop, Math.max(0, listEl.scrollHeight - listEl.clientHeight))
        }
        updateJumpBtn()
      }

      const pullBackend = async () => {
        // 新后端已经有 /api/logs/runtime 全量日志（HTTP 请求也会写进去），
        // 旧 /api/logs 请求日志只在没有 runtime 接口时兜底，避免重复刷屏。
        if (!active || !api || paused || runtimeAvailable) return
        try {
          const data = await api.logs(200)
          for (const request of data?.requests || []) addBackendRequest(request)
        } catch (_) {
          /* 后端离线时保持前端日志 */
        }
      }

      let runtimeSeen = new Set()
      const addRuntimeLine = line => {
        if (!line || typeof line !== 'object') return false
        const id = Number(line.id) || 0
        if (id) {
          if (runtimeSeen.has(id)) return false
          runtimeSeen.add(id)
          if (runtimeSeen.size > 12000) runtimeSeen = new Set()
          if (id > latestRuntimeId) latestRuntimeId = id
        } else {
          const key = `runtime|${line.at || ''}|${line.name || ''}|${line.text || ''}`
          if (runtimeSeen.has(key)) return false
          runtimeSeen.add(key)
        }
        const text = String(line.text || line.line || '').trim()
        if (!text) return false
        const name = String(line.name || 'backend')
        let level = normalizeLevel(line.level)
        if (isHttpAccessLog(text)) {
          const status = Number((text.match(/→\s*(\d{3})/) || [])[1]) || 0
          // 成功请求访问日志不展示；失败请求保留为告警 / 错误，便于排查接口异常。
          if (status < 400) return false
          level = status >= 500 ? 'error' : 'warn'
        }
        return add({
          at: Number(line.at) || Date.now(),
          level,
          cat: categoryOfSource(name),
          // 前端转发到后端的日志仍按原始 logger 名展示；clientId 用于和本地 history 精确去重。
          source: line.origin === 'web' || !line.tag ? name : `${line.tag}·${name}`,
          text,
          clientId: String(line.clientId || ''),
          timeout: /timeout|超时|ETIMEDOUT|timed out/i.test(text),
        })
      }

      const closeRuntimeStream = () => {
        streamOnline = false
        if (!runtimeSource) return
        const source = runtimeSource
        runtimeSource = null
        try {
          source.close?.()
        } catch (_) {
          /* ignore */
        }
      }

      /**
       * 后端重启后日志行 id 可能从 1 重新开始。EventSource 的自动重连会带上旧
       * Last-Event-ID，导致新流一直收不到事件；这里主动关掉、稍后新建一个不带
       * 旧游标的 EventSource，同时轮询会负责补历史。
       */
      const scheduleRuntimeReconnect = (delay = 3000) => {
        if (streamRestartTimer || !active) return
        streamRestartTimer = setTimeout(() => {
          streamRestartTimer = null
          if (active) openRuntimeStream()
        }, Math.max(0, Number(delay) || 0))
      }

      const openRuntimeStream = () => {
        if (!active || typeof EventSource === 'undefined' || !api) return
        closeRuntimeStream()
        try {
          const base = String(api.baseUrl?.() || '/api').replace(/\/+$/, '')
          const source = new EventSource(`${base}/logs/runtime/stream?_=${Date.now()}`)
          runtimeSource = source
          source.addEventListener('log', event => {
            streamOnline = true
            try {
              addRuntimeLine(JSON.parse(event.data))
              scheduleRender()
            } catch (_) {
              /* 忽略坏帧 */
            }
          })
          source.onopen = () => {
            streamOnline = true
            // 新流只负责后续实时日志；断线期间的历史由轮询 / 全量拉取补齐。
            queueRuntimePull().catch(() => {})
          }
          source.onerror = () => {
            streamOnline = false
            try {
              source.close?.()
            } catch (_) {
              /* ignore */
            }
            // 旧连接在新连接建立后才报错时直接忽略，避免无限重连风暴。
            if (runtimeSource !== source) return
            runtimeSource = null
            scheduleRuntimeReconnect(3000)
          }
        } catch (_) {
          runtimeSource = null
          scheduleRuntimeReconnect(3000)
        }
      }

      const fetchRuntimeOnce = async ({ force = false, allowRetry = true } = {}) => {
        if (!active || !api) return { ok: false, error: '后端未连接' }
        try {
          if (force) {
            latestRuntimeId = 0
            runtimeSeen = new Set()
          }
          let added = 0
          let latest = 0
          let full = force || latestRuntimeId <= 0
          // 一次接口最多 4000 行；如果刚好被 limit 截断，继续用 after 追下一段，
          // 避免一次爆发的大量日志把中间行漏掉。
          for (let page = 0; page < 6; page += 1) {
            const params = new URLSearchParams()
            params.set('limit', String(full ? FULL_LIMIT : PAGE_LIMIT))
            if (!full) params.set('after', String(latestRuntimeId))
            params.set('_', String(Date.now())) // 防止代理 / 浏览器缓存旧响应
            const data = await api.get(`/logs/runtime?${params.toString()}`)
            runtimeAvailable = true
            backendFile = data?.file || backendFile
            const instance = String(data?.instance || '')
            const instanceChanged = !!(instance && runtimeInstance && instance !== runtimeInstance)
            if (instance) runtimeInstance = instance
            latest = Number(data?.latestId) || 0
            backendTotal = Number(data?.total) || 0
            // 后端进程换了，或日志被清空后 id 回退：清掉增量游标，从头完整拉取。
            if (instanceChanged || (latest > 0 && latest < latestRuntimeId)) {
              if (!allowRetry) return { ok: false, error: '后端日志实例已切换，请重试' }
              latestRuntimeId = 0
              runtimeSeen = new Set()
              if (instanceChanged) scheduleRuntimeReconnect(0)
              return fetchRuntimeOnce({ force: true, allowRetry: false })
            }
            const dataLines = Array.isArray(data?.lines) ? data.lines : []
            for (const line of dataLines) {
              if (addRuntimeLine(line)) added += 1
            }
            const pageLatest = dataLines.reduce((max, line) => Math.max(max, Number(line?.id) || 0), 0)
            // 只把游标推进到本轮真正拿到的最后一条，不能直接跳到后端 latestId：
            // after 分页返回的是“最早的一段”，若一次积压超过 limit，直接跳 latest
            // 会永久漏掉中间日志。for 循环会继续用新的 after 追到 latestId 为止。
            if (pageLatest > latestRuntimeId) latestRuntimeId = pageLatest
            if (backendFileEl && backendFile) backendFileEl.textContent = ` 后端日志文件：${backendFile}`
            const limit = full ? FULL_LIMIT : PAGE_LIMIT
            // 拉满说明这段之后可能还有；若已经追平 latestId 则结束。
            if (dataLines.length < limit || latest <= 0 || latestRuntimeId >= latest) break
            full = false
          }
          // 自愈：后端返回的 total 大于本轮已见过的 id 数量，说明上次全量拉取不完整
          // （代理截断 / 请求中断 / 旧游标遗漏）。立即强制全量重拉一次，避免浏览器
          // 只显示一小段日志，点刷新才恢复。
          if (backendTotal > runtimeSeen.size && allowRetry) {
            return fetchRuntimeOnce({ force: true, allowRetry: false })
          }
          scheduleRender()
          return { ok: true, added, latest, total: backendTotal, seen: runtimeSeen.size, instance: runtimeInstance }
        } catch (err) {
          // 旧后端没有该接口时保留本地日志订阅兜底。
          runtimeAvailable = false
          scheduleRender()
          return { ok: false, error: err?.message || String(err) }
        }
      }

      // 把全部 fetch 串起来，避免手动刷新和 3 秒轮询并发时互相覆盖游标。
      let runtimePull = Promise.resolve()
      const queueRuntimePull = options => {
        const run = () => fetchRuntimeOnce(options)
        const next = runtimePull.then(run, run)
        runtimePull = next.then(
          () => {},
          () => {},
        )
        return next
      }
      const pullBackendRuntime = options => queueRuntimePull(options)

      /**
       * 手动 / 自动重同步：保留当前列表里的本地日志，把后端全量历史合并进来。
       * 不复位 entries / entryKeys，缺的历史会补上，已有的靠内容指纹去重；
       * 这样即使后端某次响应被代理截断，刷新也不会把新日志“洗掉”回到旧状态。
       */
      const resyncFromBackend = async () => {
        backendSeen.clear()
        // 游标复位交给队列里的 fetchRuntimeOnce({ force:true })，避免与仍在进行的
        // 增量轮询同时改 latestRuntimeId / runtimeSeen。
        const result = await pullBackendRuntime({ force: true })
        await pullBackend()
        if (!streamOnline) scheduleRuntimeReconnect(0)
        scheduleRender()
        return result
      }

      /** 渠道 ID / 会话记录 → 人类可读渠道名；日志页优先展示名称而不是内部 id。 */
      const resolveChannelName = (conversationId, meta = {}) => {
        const registry = ctx.registry.get('channel-registry')
        const wanted = [meta.napcatChannelId, meta.qqbotChannelId, meta.clawbotChannelId, meta.channelId]
          .map(value => String(value || ''))
          .filter(Boolean)
        if (registry?.tabs) {
          try {
            for (const tab of registry.tabs()) {
              for (const channelId of wanted) {
                const channel = registry.findChannel?.(tab, channelId)
                if (channel?.name) return String(channel.name)
              }
            }
          } catch (_) {
            /* 渠道注册表不可用时退回会话名 */
          }
        }
        const conversation = ctx.registry.get('session-service')?.get?.(conversationId)
        return String(conversation?.name || meta.via || '渠道')
      }

      // 先导入日志服务里已有的历史，再订阅后续记录。
      for (const record of logs?.history?.() || []) addRawLog(record)
      const offRecord = logs?.onRecord?.(addRawLog)

      const offs = [
        events.on('chat:request-start', payload => {
          const { conversationId, text, senderName, channelName } = payload || {}
          const from = channelName ? ` · 来自「${channelName}」${senderName ? `的 ${senderName}` : ''}` : ''
          const preview = String(text || '').replace(/\s+/g, ' ').slice(0, 140)
          add({
            level: 'info',
            cat: '模型',
            source: 'chat-flow',
            text: `开始处理请求${from}${preview ? `：${preview}` : ` · 会话 ${conversationId || '-'}`}`,
          })
        }),
        events.on('message:added', ({ conversationId, message } = {}) => {
          if (!message || message.role !== 'user') return
          const meta = message.meta || {}
          if (meta.direction !== 'inbound') return
          if (!markInboundLogged(conversationId, message)) return
          add({
            level: 'info',
            cat: '外发',
            source: message.source || meta.via || 'channel',
            text: describeIncomingMessage(message, {
              channelName: resolveChannelName(conversationId, meta),
              channelType: meta.via || message.source,
              scope: meta.sessionType || meta.messageType,
            }),
          })
        }),
        events.on('chat:status', payload => {
          const { status, round, tool, label, conversationId } = payload || {}
          if (status === 'idle') {
            add({ level: 'debug', cat: '模型', source: 'chat-flow', text: `空闲 · 会话 ${conversationId || '-'}` })
            return
          }
          if (status === 'thinking') add({ level: 'info', cat: '模型', source: 'chat-flow', text: `模型思考中 · 第 ${round || '?'} 轮` })
          else if (status === 'tool') add({ level: 'info', cat: '工具', source: 'chat-flow', text: `${label || `正在调用工具 ${tool || ''}`}` })
          else if (status === 'typing') add({ level: 'debug', cat: '外发', source: 'chat-flow', text: `正在准备输入（${tool || '消息'}）` })
        }),
        events.on('chat:request-done', ({ conversationId, elapsed, thinkingMs } = {}) =>
          add({
            level: 'info',
            cat: '模型',
            source: 'chat-flow',
            text: `本轮结束 · 总耗时 ${Number(elapsed) || 0}ms · 模型思考 ${Number(thinkingMs) || 0}ms · 会话 ${conversationId || '-'}`,
          }),
        ),
        events.on('model:start', payload =>
          add({
            level: 'info',
            cat: '模型',
            source: 'model-service',
            text: `模型请求开始 · ${payload?.model || payload?.key || '当前模型'}`,
          }),
        ),
        events.on('model:done', payload =>
          add({
            level: 'info',
            cat: '模型',
            source: 'model-service',
            text: `模型响应完成 · ${Number(payload?.elapsedMs) || 0}ms${payload?.finishReason ? ` · finish=${payload.finishReason}` : ''}`,
          }),
        ),
        events.on('model:error', payload => {
          const message = payload?.error?.message || payload?.error || '未知错误'
          add({
            level: 'error',
            cat: '模型',
            source: 'model-service',
            text: `模型调用错误 · ${Number(payload?.elapsedMs) || 0}ms：${message}`,
            timeout: /timeout|超时|ETIMEDOUT|timed out/i.test(String(message)),
          })
        }),
        events.on('model:fallback', payload => {
          const message = payload?.error?.message || payload?.error || '未知错误'
          add({
            level: 'warn',
            cat: '模型',
            source: 'model-service',
            text: `模型降级 · ${payload?.from || '当前模型'} → ${payload?.to || '备用模型'}（第 ${Number(payload?.attempt) || 1} 次）：${message}`,
            timeout: /timeout|超时|ETIMEDOUT|timed out/i.test(String(message)),
          })
        }),
        events.on('chat:confirm-request', payload =>
          add({
            level: 'warn',
            cat: '权限',
            source: 'chat-permissions',
            text: `等待敏感操作确认 · ${payload?.action === 'read' ? '读取' : '发送'} → ${payload?.targetName || payload?.targetChannel || '-'}`,
          }),
        ),
        events.on('chat:confirm-resolved', payload =>
          add({
            level: payload?.approved ? 'info' : 'warn',
            cat: '权限',
            source: 'chat-permissions',
            text: payload?.approved ? '敏感操作已确认，继续执行工具' : '敏感操作被拒绝或确认超时',
          }),
        ),
        events.on('channel:outbound', payload => {
          const { status, channelType, channelName, channelId, ms, error, text } = payload || {}
          const target = channelName || channelId || channelType || '渠道'
          const preview = String(text || '').replace(/\s+/g, ' ').slice(0, 120)
          if (status === 'pending') {
            add({ level: 'debug', cat: '外发', source: channelType || 'channel', text: `准备外发 · ${target}${preview ? `：${preview}` : ''}` })
          } else if (status === 'sent') {
            add({
              level: 'info',
              cat: '外发',
              source: channelType || 'channel',
              text: `已发送到「${target}」${preview ? `：${preview}` : ''} · ${Number(ms) || 0}ms`,
            })
          } else if (status === 'failed') {
            add({ level: 'error', cat: '外发', source: channelType || 'channel', text: `外发失败 · ${target}：${error || '未知错误'}` })
          }
        }),
        events.on('chat-queue:start', ({ key, pending } = {}) =>
          add({ level: 'debug', cat: '模型', source: 'chat-queue', text: `角色队列开始执行 · ${key || ''} · 排队 ${Number(pending) || 0}` }),
        ),
        events.on('chat-queue:finish', ({ key, pending } = {}) =>
          add({ level: 'debug', cat: '模型', source: 'chat-queue', text: `角色队列任务完成 · ${key || ''} · 剩余 ${Number(pending) || 0}` }),
        ),
        events.on('backend:status', status =>
          add({
            level: status?.online ? 'info' : 'warn',
            cat: '后端',
            source: 'backend-client',
            text: status?.online ? `后端已连接 · ${status.baseUrl || ''}` : `后端不可用：${status?.lastError || '未知原因'}`,
          }),
        ),
        events.on('backend:event', ({ event, data } = {}) => {
          if (event === 'chat/start') {
            add({
              level: 'info',
              cat: '模型',
              source: 'backend',
              text: `后端模型开始 · ${data?.provider || '-'} / ${data?.model || '-'} · 超时 ${Number(data?.timeoutMs) || 0}ms · 工具 ${Number(data?.toolCount) || 0}`,
            })
          } else if (event === 'chat/done') {
            add({
              level: 'info',
              cat: '模型',
              source: 'backend',
              text: `后端模型完成 · ${Number(data?.ms) || 0}ms · 输出 ${Number(data?.length) || 0} 字 · 工具 ${Number(data?.toolCalls) || 0}`,
            })
          } else if (event === 'chat/error') {
            add({
              level: 'error',
              cat: '模型',
              source: 'backend',
              text: `后端模型错误 · ${Number(data?.ms) || 0}ms${data?.timedOut ? '（超时）' : ''}：${data?.detail || '未知错误'}`,
              timeout: data?.timedOut === true || /timeout|超时|ETIMEDOUT|timed out/i.test(String(data?.detail || '')),
            })
          } else if (event === 'log/line') {
            addRuntimeLine(data)
          } else if (event === 'sessions/changed') {
            const message = data?.message
            const meta = message?.meta || {}
            if (data?.action === 'message' && message?.role === 'user' && meta.direction === 'inbound') {
              if (markInboundLogged(String(data.id || ''), message)) {
                add({
                  level: 'info',
                  cat: '外发',
                  source: message.source || meta.via || 'channel',
                  text: describeIncomingMessage(message, {
                    channelName: resolveChannelName(String(data.id || ''), meta),
                    channelType: meta.via || message.source,
                    scope: meta.sessionType || meta.messageType,
                  }),
                })
              }
            } else {
              add({ level: 'debug', cat: '后端', source: 'backend', text: '后端事件：sessions/changed' })
            }
          } else if (event === 'settings/updated') {
            add({ level: 'debug', cat: '后端', source: 'backend', text: `后端事件：${event}` })
          }
        }),
      ]

      const onClick = async event => {
        const button = event.target.closest('button')
        if (!button) return
        if (button.dataset.logsAutoscroll !== undefined) {
          autoScroll = !autoScroll
          if (autoScroll) unseen = 0
          button.classList.toggle('on', autoScroll)
          updateJumpBtn()
          if (autoScroll) render()
        } else if (button.dataset.logsPause !== undefined) {
          paused = !paused
          button.classList.toggle('on', paused)
          button.textContent = paused ? '继续' : '暂停'
          if (!paused) render()
          else if (statsEl) {
            const streamText = streamOnline ? '实时流已连接' : runtimeAvailable ? '轮询更新中' : '后端未连接'
            statsEl.textContent = `${entries.length} 条 · ${streamText} · 已暂停`
          }
        } else if (button.dataset.logsClear !== undefined) {
          entries = []
          entryKeys.clear()
          clientIdKeys.clear()
          backendSeen.clear()
          runtimeSeen = new Set()
          latestRuntimeId = 0
          logs?.clear?.()
          // 同时清空后端内存 / 文件，否则刷新页面历史又会回来。
          Promise.resolve(api?.del?.('/logs/runtime')).catch(() => {})
          render()
        } else if (button.dataset.logsCopy !== undefined) {
          const visible = entries.slice(-MAX_RENDER).map(item => `${formatTime(item.at)} [${item.level}] [${item.source}] ${item.text}`).join('\n')
          try {
            await navigator.clipboard.writeText(visible)
            toast?.success?.('日志已复制到剪贴板')
          } catch (_) {
            toast?.info?.(`已生成 ${entries.length} 条日志，可手动选择复制`)
          }
        } else if (button.dataset.logsExport !== undefined) {
          const text = entries.map(item => `${formatTime(item.at)} [${item.level}] [${item.source}] ${item.text}`).join('\n')
          try {
            const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
            const url = URL.createObjectURL(blob)
            const a = document.createElement('a')
            const stamp = new Date().toISOString().replace(/[:.]/g, '-')
            a.href = url
            a.download = `nianfeng-logs-${stamp}.log`
            a.click()
            setTimeout(() => URL.revokeObjectURL(url), 1000)
            toast?.success?.('日志已导出')
          } catch (err) {
            toast?.error?.(`导出失败：${err.message}`)
          }
        }
      }

      // 刷新按钮单独挂监听（不依赖容器的冒泡委托），SSE / 反代缓冲 / 旧后端
      // 导致列表没跟上时，一键重建列表并回拉后端全量日志。
      const onRefresh = async event => {
        event?.stopPropagation?.()
        // 手动刷新意味着“我现在就要看最新日志”：取消暂停并强制回到底部。
        paused = false
        pauseBtn?.classList.remove('on')
        if (pauseBtn) pauseBtn.textContent = '暂停'
        autoScroll = true
        unseen = 0
        updateJumpBtn()
        const result = await resyncFromBackend()
        render()
        listEl.scrollTop = listEl.scrollHeight
        if (result?.ok === false) toast?.error?.(`日志刷新失败：${result.error || '后端日志接口不可用'}`)
        else toast?.success?.(`日志已刷新 · 当前 ${entries.length} 条`)
      }
      const refreshBtn = container.querySelector('[data-logs-refresh]')
      refreshBtn?.addEventListener('click', onRefresh)
      const onJump = event => {
        event?.stopPropagation?.()
        autoScroll = true
        unseen = 0
        autoBtn?.classList.add('on')
        updateJumpBtn()
        render()
        listEl.scrollTop = listEl.scrollHeight
      }
      jumpBtn?.addEventListener('click', onJump)
      container.addEventListener('click', onClick)

      const onListScroll = () => {
        if (paused) return
        const atBottom = listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight < 28
        autoScroll = atBottom
        if (autoScroll) unseen = 0
        autoBtn?.classList.toggle('on', autoScroll)
        updateJumpBtn()
      }
      listEl?.addEventListener('scroll', onListScroll)

      // 级别勾选：可任意组合（例如只勾错误 + 调试），默认只有 info；改动持久化，
      // 下次打开 / 刷新页面（以及配置同步到其它端）后仍然保持。
      const applyLevels = value => {
        const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : null
        const normalized = (list || []).map(level => String(level || '').trim()).filter(level => LEVEL_LABEL[level])
        selectedLevels = new Set(normalized)
      }
      const onLevelChange = () => {
        selectedLevels = new Set(levelInputs.filter(input => input.checked).map(input => input.dataset.logsLevel))
        config?.set?.('logs.levels', [...selectedLevels])
        render()
      }
      for (const input of levelInputs) input.addEventListener('change', onLevelChange)
      const offLevelWatch = config?.watch?.('logs.levels', value => {
        applyLevels(value)
        syncLevelChecks()
        render()
      })

      catSelect?.addEventListener('change', render)
      searchInput?.addEventListener('input', render)

      // 切回日志页 / 窗口重新聚焦时补拉。后台标签页计时器会被浏览器节流，
      // 因此离开较久或实时流不在线时做一次完整重同步，避免“看起来没刷新”。
      let lastHiddenAt = 0
      const onVisible = () => {
        if (!active || document.hidden === true) return
        const awayFor = lastHiddenAt ? Date.now() - lastHiddenAt : 0
        lastHiddenAt = 0
        if (!streamOnline || awayFor > 15000) {
          void resyncFromBackend().catch(() => {})
        } else {
          void pullBackendRuntime()
          void pullBackend()
        }
      }
      const onVisibilityChange = () => {
        if (document.hidden === true) {
          lastHiddenAt = Date.now()
          return
        }
        onVisible()
      }
      document.addEventListener('visibilitychange', onVisibilityChange)
      window.addEventListener?.('focus', onVisible)

      // 实时优先：后端专用 SSE 推送；3 秒轮询作为代理 / 旧后端 / 断线兜底。
      backendTimer = setInterval(() => {
        if (!active) return
        pullBackend()
        pullBackendRuntime().catch(() => {})
      }, 3000)
      openRuntimeStream()
      // 首次进入日志页就直接全量重同步：即使某次历史请求被代理截断 / 请求中断，
      // fetchRuntimeOnce 的 total 自检也会再补一次，确保不是只显示当前会话的一小段。
      void resyncFromBackend().catch(() => {})
      render()

      return () => {
        active = false
        if (renderTimer) clearTimeout(renderTimer)
        if (backendTimer) clearInterval(backendTimer)
        if (streamRestartTimer) clearTimeout(streamRestartTimer)
        streamRestartTimer = null
        closeRuntimeStream()
        document.removeEventListener('visibilitychange', onVisibilityChange)
        window.removeEventListener?.('focus', onVisible)
        offRecord?.()
        offLevelWatch?.()
        offs.forEach(off => off?.())
        refreshBtn?.removeEventListener('click', onRefresh)
        jumpBtn?.removeEventListener('click', onJump)
        container.removeEventListener('click', onClick)
        for (const input of levelInputs) input.removeEventListener('change', onLevelChange)
        listEl?.removeEventListener('scroll', onListScroll)
        catSelect?.removeEventListener('change', render)
        searchInput?.removeEventListener('input', render)
      }
    },
  })

  ctx.logger.debug('运行日志视图就绪')
}
