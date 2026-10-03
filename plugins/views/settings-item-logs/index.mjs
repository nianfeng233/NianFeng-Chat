/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * V? · settings-item-logs
 * 运行日志页（类似 AstrBot 的日志台）：
 *   - 只读后端 runtime.log：历史全量拉取 + 专用 SSE 实时流 + 轮询兜底
 *   - 前端插件日志统一回传后端，因此电脑端 / 手机端 / CLI 读的是同一份
 *   - 按后端 id 顺序展示，和终端刷出顺序一致，不再本地维护第二份日志
 */
export const name = 'settings-item-logs'
export const version = '1.2.0'
export const displayName = '视图 · 运行日志'
export const description = '独立运行日志视图：直接读取后端 runtime.log，统一展示模型 / 工具 / 渠道 / 权限与运行日志。'
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
export const inject = ['view-router', 'api?', 'event-bus', 'config?', 'toast?']

import { useStyle } from '../../../src/util/style.mjs'
import { LOGS_CSS } from './style.mjs'

const LEVEL_LABEL = { error: '错误', warn: '警告', info: '信息', debug: '调试' }
const LEVEL_ORDER = ['error', 'warn', 'info', 'debug']
// 与后端终端默认级别保持一致：终端默认打印 error / warn / info，页面也默认
// 显示这三种；debug 两边都只在用户显式打开后才展示。
const DEFAULT_LEVELS = ['error', 'warn', 'info']
const MAX_ENTRIES = 4000
const MAX_RENDER = 1200
// 首次进入 / 手动刷新时先拉最新一小段立刻上屏，再在后台分页回填更早的历史；
// 增量轮询仍然按大页拉取，减少请求次数。
const PAGE_LIMIT = 2000
const FIRST_PAGE_LIMIT = 400
const HISTORY_PAGE_LIMIT = 600
const MAX_BOOTSTRAP_PAGES = 12

const escapeHtml = value =>
  String(value ?? '')
    .replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[m])


const pad = (value, len = 2) => String(value).padStart(len, '0')
const formatTime = at => {
  const date = new Date(Number(at) || Date.now())
  if (Number.isNaN(date.getTime())) return '--:--:--'
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
}


const categoryOfSource = (name, text = '') => {
  const source = String(name || '')
  const content = String(text || '')
  // 前端插件日志统一带了 [收到消息] / [模型…] / [工具…] / [回复] 等标签；
  // 优先按标签分到“渠道 / 模型 / 工具 / 权限”，没有任何标签时再按来源名兜底。
  if (/^\s*\[收到消息\]/.test(content) || /^\s*\[(?:渠道|外发)/.test(content)) return '外发'
  if (/^\s*\[(?:模型|回复|请求|本轮)/.test(content)) return '模型'
  if (/^\s*\[工具/.test(content)) return '工具'
  if (/^\s*\[(?:权限|确认)/.test(content)) return '权限'
  if (source.includes('chat-flow') || source.includes('model')) return '模型'
  if (source.includes('chat-tools') || source.includes('tool')) return '工具'
  if (source.includes('chat-permissions') || source.includes('permission')) return '权限'
  if (source.includes('channel') || source.includes('napcat') || source.includes('qqbot') || source.includes('clawbot')) return '外发'
  if (source.includes('backend') || source.includes('http')) return '后端'
  return '系统'
}

export function apply(ctx) {
  const router = ctx.inject('view-router')
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
        // 旧版默认只勾选「信息」，导致终端里的警告 / 错误在日志页默认看不到。
        // 只迁移一次旧默认值；用户之后手动改回「只看信息」会被保留。
        const migrated = config?.get?.('logs.levelsTerminalAligned', false) === true
        const isLegacyInfoOnly = Array.isArray(list) && list.length === 1 && String(list[0] || '').trim() === 'info'
        if (config && !migrated) {
          if (isLegacyInfoOnly) config.set('logs.levels', [...DEFAULT_LEVELS])
          config.set('logs.levelsTerminalAligned', true)
        }
        if (isLegacyInfoOnly && !migrated) return new Set(DEFAULT_LEVELS)
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
            <div class="settings-desc">与后端终端 <code>runtime.log</code> 同源的日志时间线（实时 SSE + 轮询兜底）；终端默认显示什么，这里就默认显示什么。</div>
          </div>
        </div>
        <section class="settings-section">
          <div class="logs-toolbar">
            <div class="logs-levels" data-logs-levels role="group" aria-label="日志级别" title="按类型自由勾选；默认与终端一致：错误 / 警告 / 信息">
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
          <div class="logs-list allow-scroll-chain" data-logs-list>
            <div class="logs-empty">正在读取日志…</div>
          </div>
          <div class="logs-note">
            WebUI 直接读取后端终端日志（<code>logs/runtime.log</code>）：终端默认显示 <b>错误 / 警告 / 信息</b>，本页默认也显示这三类；
            需要调试级日志时再在上方勾选「调试」。模型请求、工具调用、敏感操作确认与渠道消息收发都会实时出现；
            页面刷新不会清空，重启后端也会回读最近历史。
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
      let backendConsoleLevel = 'info'
      let streamOnline = false
      let active = true

      /**
       * 自动到底 / 判断是否到底 / 恢复滚动位置都作用于当前真正的滚动宿主：
       * 桌面端优先 .logs-list 自身；手机端 .logs-list 随内容展开后，滚动宿主
       * 变成 .logs-page（桌面同一套 flex + overflow，只有布局高度不同）。
       */
      const scrollHosts = () => {
        const hosts = []
        const seen = new Set()
        const push = element => {
          if (!element || seen.has(element)) return
          seen.add(element)
          hosts.push(element)
        }
        push(listEl)
        let parent = listEl?.parentElement || null
        while (parent) {
          push(parent)
          if (String(parent.className || '').split(/\s+/).includes('pane-view')) break
          parent = parent.parentElement
        }
        return hosts
      }
      const activeScrollHost = () => {
        for (const host of scrollHosts()) {
          if (host.scrollHeight > host.clientHeight + 1) return host
        }
        return listEl || null
      }
      const currentScrollTop = () => Number(activeScrollHost()?.scrollTop) || 0
      const scrollToLatest = () => {
        const host = activeScrollHost()
        if (!host) return
        host.scrollTop = host.scrollHeight
      }
      const atScrollBottom = () => {
        const host = activeScrollHost()
        if (!host) return true
        return host.scrollHeight - host.scrollTop - host.clientHeight < 28
      }
      const restoreScrollTop = value => {
        const host = activeScrollHost()
        if (!host) return
        host.scrollTop = Math.min(Math.max(0, Number(value) || 0), Math.max(0, host.scrollHeight - host.clientHeight))
      }

      /** 日志顺序以来源为准：后端 runtime.log 的 id 顺序就是终端刷出顺序，
       *  页面不再按各自的时间戳重排，避免“收到消息”被自己算到模型调用之后。 */
      const compareEntries = (a, b) =>
        (Number(a.order) || 0) - (Number(b.order) || 0) ||
        a.id - b.id

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
        const clientId = String(entry?.clientId || '')
        if (clientId) return `client|${clientId}`
        // 后端 runtime.log 的 id 在同一次后端进程内唯一；没有 id 的旧接口兜底
        // 才退回内容指纹，避免同一行被 SSE + 轮询重复插进页面。
        const order = Number(entry?.order) || 0
        if (order > 0) return `runtime|${order}`
        const at = Number(entry?.at) || Date.now()
        const text = String(entry?.text || '').slice(0, 600)
        const source = String(entry?.source || '')
        return `${Math.round(at / 50)}|${source}|${text}`
      }

      const add = entry => {
        if (!active) return false
        const item = {
          id: ++seq,
          order: 0,
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
          // 按后端顺序截断；保留最新的一段，而不是把刚补进来的历史又裁掉。
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
        const keepScrollTop = currentScrollTop()
        const cat = catSelect?.value || ''
        const keyword = String(searchInput?.value || '').trim().toLowerCase()
        // 按后端 runtime.log 的 id 顺序排列；历史回填、SSE 与轮询混在一起时，仍与终端看到的先后顺序一致。
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
          const terminalText = `终端默认 ${LEVEL_LABEL[backendConsoleLevel] || backendConsoleLevel || '信息'}`
          statsEl.textContent = `${entries.length} 条 · 显示 ${visible.length} 条 · 页面 ${levelText || '未选级别'} · ${terminalText} · ${streamText}${
            paused ? ' · 已暂停' : ''
          }`
        }
        if (syncHintEl) {
          syncHintEl.textContent = runtimeAvailable
            ? streamOnline
              ? ' 实时流已连接；代理 / 断线时自动退化为 3 秒轮询，也可以点「刷新」立即重拉。'
              : ' 实时流未连接，正在用 3 秒轮询兜底；也可以点「刷新」立即重拉。'
            : ' 当前后端没有运行时日志接口（可能是旧进程或旧后端）：现在只能看到旧 /api/logs 请求日志；请重启后端后再打开日志页。'
        }
        // 重新 innerHTML 会丢失原滚动位置：自动滚动时直接到底；用户手动翻上去
        // 时保留原位置，并显示“有新日志”提示，避免刷新/实时更新看起来没反应。
        if (autoScroll) {
          unseen = 0
          if (!paused) scrollToLatest()
        } else {
          restoreScrollTop(keepScrollTop)
        }
        updateJumpBtn()
      }

      /** 首屏分页每拉回一段就立即上屏，不等 80ms debounce，避免大日志量时用户干等。 */
      const renderNow = () => {
        if (renderTimer) {
          clearTimeout(renderTimer)
          renderTimer = null
        }
        if (!active || paused) return
        render()
      }

      const pullBackend = async () => {
        // 新后端已经有 /api/logs/runtime 全量日志（HTTP 请求也会写进去），
        // 旧 /api/logs 请求日志只在没有 runtime 接口时兜底，避免两套数据混排。
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
        // 直接使用后端 runtime.log 里的原始级别 / 内容：终端默认打印什么，页面
        // 默认筛选（error / warn / info）就展示什么，不再单独吞掉 HTTP 访问行。
        const level = normalizeLevel(line.level)
        return add({
          order: id,
          at: Number(line.at) || Date.now(),
          level,
          cat: categoryOfSource(name, text),
          // 前端转发到后端的日志仍按原始 logger 名展示；clientId 用于精确去重。
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

        /** 后端实例切换（重启 / 换数据目录）时，旧 id 会复用；整页重来一遍。 */
        const resetLogEntries = () => {
          entries = []
          entryKeys.clear()
          clientIdKeys.clear()
          backendSeen.clear()
          unseen = 0
          updateJumpBtn()
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

            const readPage = async ({ limit, before = 0, after = 0 }) => {
              const params = new URLSearchParams()
              params.set('limit', String(limit))
              if (before > 0) params.set('before', String(before))
              if (after > 0) params.set('after', String(after))
              params.set('_', String(Date.now())) // 防止代理 / 浏览器缓存旧响应
              const data = await api.get(`/logs/runtime?${params.toString()}`)
              runtimeAvailable = true
              backendFile = data?.file || backendFile
              const instance = String(data?.instance || '')
              const instanceChanged = !!(instance && runtimeInstance && instance !== runtimeInstance)
              if (instance) runtimeInstance = instance
              if (data?.consoleLevel) backendConsoleLevel = normalizeLevel(data.consoleLevel)
              latest = Number(data?.latestId) || 0
              backendTotal = Number(data?.total) || 0
              if (backendFileEl && backendFile) backendFileEl.textContent = ` 后端日志文件：${backendFile}`
              const lines = Array.isArray(data?.lines) ? data.lines : []
              // 后端进程换了，或日志被清空后 id 回退：清掉增量游标，从头完整拉取。
              if (instanceChanged || (latest > 0 && latest < latestRuntimeId)) {
                latestRuntimeId = 0
                runtimeSeen = new Set()
                if (instanceChanged) {
                  resetLogEntries()
                  scheduleRuntimeReconnect(0)
                }
                const restart = new Error('后端日志实例已切换，请重试')
                restart.runtimeRestart = true
                throw restart
              }
              return lines
            }

            const applyLines = lines => {
              let count = 0
              for (const line of lines) {
                if (addRuntimeLine(line)) count += 1
              }
              added += count
              const pageLatest = lines.reduce((max, line) => Math.max(max, Number(line?.id) || 0), 0)
              // 只把游标推进到本轮真正拿到的最后一条，不能直接跳到后端 latestId：
              // after 分页返回的是“最早的一段”，若一次积压超过 limit，直接跳 latest
              // 会永久漏掉中间日志。
              if (pageLatest > latestRuntimeId) latestRuntimeId = pageLatest
              return count
            }

            const initial = force || latestRuntimeId <= 0
            if (initial) {
              // 首次 / 刷新先拉最新的一小段并立即显示；更早历史在后面的循环里分页回填。
              const newest = await readPage({ limit: FIRST_PAGE_LIMIT })
              applyLines(newest)
              renderNow()
              let oldestId = newest.reduce((min, line) => {
                const id = Number(line?.id) || 0
                return id > 0 && (min === 0 || id < min) ? id : min
              }, 0)
              let needOlder = newest.length >= FIRST_PAGE_LIMIT && oldestId > 1
              for (let page = 0; needOlder && page < MAX_BOOTSTRAP_PAGES; page += 1) {
                const older = await readPage({ limit: HISTORY_PAGE_LIMIT, before: oldestId })
                if (!older.length) break
                const pageOldestId = older.reduce((min, line) => {
                  const id = Number(line?.id) || 0
                  return id > 0 && (min === 0 || id < min) ? id : min
                }, 0)
                // 没有取得更早的 id 就停下，避免 before 分页原地打转。
                if (pageOldestId <= 0 || pageOldestId >= oldestId) break
                applyLines(older)
                oldestId = pageOldestId
                scheduleRender()
                needOlder = older.length >= HISTORY_PAGE_LIMIT && oldestId > 1
              }
            }

            // 从已知最大 id 向后追新。每页拿到就先调度渲染，积压很多也不会等全部拉完。
            let forwardCaughtUp = initial && latest > 0 && latestRuntimeId >= latest
            for (let page = 0; page < MAX_BOOTSTRAP_PAGES; page += 1) {
              if (latestRuntimeId <= 0 || forwardCaughtUp) break
              const cursor = latestRuntimeId
              const next = await readPage({ limit: PAGE_LIMIT, after: cursor })
              if (!next.length) break
              applyLines(next)
              scheduleRender()
              if (latestRuntimeId <= cursor) break
              forwardCaughtUp = latest > 0 && latestRuntimeId >= latest
            }

            // 自愈：后端返回的 total 大于本轮已见过的 id 数量，说明分页拉取不完整
            // （代理截断 / 请求中断 / 旧游标遗漏）。立即重新分页补一次。
            if (backendTotal > runtimeSeen.size && allowRetry) {
              return fetchRuntimeOnce({ force: true, allowRetry: false })
            }
            renderNow()
            return { ok: true, added, latest, total: backendTotal, seen: runtimeSeen.size, instance: runtimeInstance }
          } catch (err) {
            if (err?.runtimeRestart) {
              if (!allowRetry) return { ok: false, error: err.message || '后端日志实例已切换，请重试' }
              return fetchRuntimeOnce({ force: true, allowRetry: false })
            }
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
       * 手动 / 自动重同步：保留当前列表，把后端全量历史合并进来。
       * 不复位 entries / entryKeys，缺的历史会补上，已有的靠后端 id / clientId 去重；
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

      // 日志页只读后端 runtime.log：前端不再单独维护一份本地日志；SSE、
      // 轮询和历史回填都合并进同一个 addRuntimeLine 去重链，所有端看到同一份。
      const offs = [
        // 兼容旧后端：/api/events 的 log/line 也是运行时日志，接进同一份数据。
        events.on('backend:event', ({ event, data } = {}) => {
          if (event === 'log/line') addRuntimeLine(data)
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
          resetLogEntries()
          runtimeSeen = new Set()
          latestRuntimeId = 0
          // 同时清空后端内存 / 文件，否则刷新页面历史又会回来。
          Promise.resolve(api?.del?.('/logs/runtime')).catch(() => {})
          render()
        } else if (button.dataset.logsCopy !== undefined) {
          const visible = [...entries].sort(compareEntries).slice(-MAX_RENDER).map(item => `${formatTime(item.at)} [${item.level}] [${item.source}] ${item.text}`).join('\n')
          try {
            await navigator.clipboard.writeText(visible)
            toast?.success?.('日志已复制到剪贴板')
          } catch (_) {
            toast?.info?.(`已生成 ${entries.length} 条日志，可手动选择复制`)
          }
        } else if (button.dataset.logsExport !== undefined) {
          const text = [...entries].sort(compareEntries).map(item => `${formatTime(item.at)} [${item.level}] [${item.source}] ${item.text}`).join('\n')
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
        scrollToLatest()
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
        scrollToLatest()
      }
      jumpBtn?.addEventListener('click', onJump)
      container.addEventListener('click', onClick)

      const onListScroll = () => {
        if (paused) return
        const atBottom = atScrollBottom()
        autoScroll = atBottom
        if (autoScroll) unseen = 0
        autoBtn?.classList.toggle('on', autoScroll)
        updateJumpBtn()
      }
      for (const host of scrollHosts()) host.addEventListener('scroll', onListScroll)

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
        offLevelWatch?.()
        offs.forEach(off => off?.())
        refreshBtn?.removeEventListener('click', onRefresh)
        jumpBtn?.removeEventListener('click', onJump)
        container.removeEventListener('click', onClick)
        for (const input of levelInputs) input.removeEventListener('change', onLevelChange)
        for (const host of scrollHosts()) host.removeEventListener('scroll', onListScroll)
        catSelect?.removeEventListener('change', render)
        searchInput?.removeEventListener('input', render)
      }
    },
  })

  ctx.logger.debug('运行日志视图就绪')
}
