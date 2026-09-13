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
export const displayName = '设置项 · 运行日志'
export const description = '设置页 · 模型调用阶段、工具 / 外发 / 权限确认与后端请求日志。'
export const author = '念风内核'
export const icon = '📝'
export const core = false
export const depends = { 'settings-container': '^1.0.0', logger: '^1.0.0' }
export const inject = ['settings-container', 'logs?', 'api?', 'event-bus', 'toast?']

import { useStyle } from '../../../src/util/style.mjs'
import { LOGS_CSS } from './style.mjs'

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 }
const LEVEL_LABEL = { error: '错误', warn: '警告', info: '信息', debug: '调试' }
const MAX_ENTRIES = 2000
const MAX_RENDER = 900

const escapeHtml = value =>
  String(value ?? '')
    .replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[m])

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
  const pages = ctx.inject('settings-container')
  const logs = ctx.inject('logs?')
  const api = ctx.inject('api?')
  const events = ctx.inject('event-bus')
  const toast = ctx.inject('toast?')

  useStyle(ctx, LOGS_CSS)

  pages.register({
    id: 'logs',
    group: '系统',
    groupOrder: 40,
    label: '运行日志',
    icon: '📝',
    order: 70,
    render(container) {
      container.innerHTML = `
        <div class="settings-title-row">
          <div>
            <div class="settings-title">运行日志</div>
            <div class="settings-desc">终端同款日志流（实时 SSE + 轮询兜底）：模型、工具、权限确认、渠道外发、HTTP 请求都在这里；刷新页面或重启后端后历史仍保留。</div>
          </div>
        </div>
        <section class="settings-section">
          <div class="logs-toolbar">
            <select data-logs-level title="最低级别">
              <!-- 默认信息及以上：普通人日常排查够用；需要逐帧细节时再手动切到全部。 -->
              <option value="debug">全部（含调试）</option>
              <option value="info" selected>信息及以上</option>
              <option value="warn">警告及以上</option>
              <option value="error">仅错误</option>
            </select>
            <select data-logs-cat title="来源分类">
              <option value="">全部分类</option>
              <option value="模型">模型</option>
              <option value="工具">工具</option>
              <option value="权限">权限</option>
              <option value="外发">外发</option>
              <option value="后端">后端</option>
              <option value="系统">系统</option>
            </select>
            <input data-logs-search type="search" placeholder="搜索 conversation / 工具名 / 错误关键词…" />
            <button class="outline-btn on" data-logs-autoscroll title="有新日志时自动滚到底部">自动滚动</button>
            <button class="outline-btn" data-logs-pause title="暂停刷新列表，日志仍会继续收集">暂停</button>
            <button class="outline-btn" data-logs-clear>清空</button>
            <button class="outline-btn" data-logs-copy>复制</button>
            <button class="outline-btn" data-logs-export>导出日志</button>
            <button class="outline-btn" data-logs-refresh title="立即重新拉取后端全部日志；SSE / 代理卡顿时可手动兜底">刷新</button>
            <button class="outline-btn" data-logs-jump hidden title="有新日志；点击回到底部">有新日志 ↓</button>
            <span class="logs-stats" data-logs-stats></span>
          </div>
          <div class="logs-list" data-logs-list>
            <div class="logs-empty">正在读取日志…</div>
          </div>
          <div class="logs-note">
            WebUI 直接读取后端终端日志（<code>logs/runtime.log</code>）：模型请求开始 / 完成 / 错误、工具调用与耗时、敏感操作确认、
            渠道消息外发、HTTP 请求都会实时出现；页面刷新不会清空，重启后端也会回读最近历史。
            <span data-logs-backend-file></span>
            <span data-logs-sync-hint></span>
          </div>
        </section>`

      const listEl = container.querySelector('[data-logs-list]')
      const statsEl = container.querySelector('[data-logs-stats]')
      const levelSelect = container.querySelector('[data-logs-level]')
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
      // 前端本地日志 + 后端运行时日志合并展示；用内容指纹去重，避免转发一份后重复。
      const entryKeys = new Set()
      // 后端 /api/logs/runtime/stream（SSE）状态；旧后端没有该接口时靠轮询兜底。
      let runtimeSource = null
      let runtimeAvailable = false
      let latestRuntimeId = 0
      let streamOnline = false
      let active = true

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

      const fingerprintOf = entry => {
        const at = Number(entry?.at) || Date.now()
        const text = String(entry?.text || '').slice(0, 600)
        const source = String(entry?.source || '')
        // 时间按 50ms 分桶：前端本地记录与后端回传的同一行时间会略有差异，
        // 但内容 / 来源一致时应当合并成一条。
        return `${Math.round(at / 50)}|${source}|${text}`
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
          timeout: false,
          ...entry,
        }
        const key = fingerprintOf(item)
        if (entryKeys.has(key)) return false
        entryKeys.add(key)
        if (entryKeys.size > MAX_ENTRIES * 2) {
          entryKeys.clear()
          for (const existing of entries) entryKeys.add(fingerprintOf(existing))
        }
        entries.push(item)
        if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES)
        if (!autoScroll) {
          unseen += 1
          updateJumpBtn()
        }
        scheduleRender()
        return true
      }

      const addRawLog = record => {
        const level = LEVELS[record?.type] ?? LEVELS[record?.level] ?? (typeof record?.level === 'number' ? record.level : 2)
        const args = Array.isArray(record?.args) ? record.args : []
        const text = args.map(formatArg).join(' ').slice(0, 8000)
        if (!text) return
        const source = String(record?.name || 'app')
        const cat = categoryOfSource(source)
        add({
          at: Number(record?.ts ?? record?.timestamp ?? record?.time ?? Date.now()) || Date.now(),
          level: level >= 3 ? 'debug' : level === 2 ? 'info' : level === 1 ? 'warn' : 'error',
          cat,
          source,
          text,
          timeout: /timeout|超时|ETIMEDOUT|timed out/i.test(text),
        })
      }

      const addBackendRequest = request => {
        const key = `${request?.at || ''}|${request?.method || ''}|${request?.path || ''}|${request?.status || ''}`
        if (!request || backendSeen.has(key)) return
        backendSeen.add(key)
        const level = Number(request.status) >= 500 ? 'error' : Number(request.status) >= 400 ? 'warn' : 'debug'
        add({
          at: Number(request.at) || Date.now(),
          level,
          cat: '后端',
          source: 'http',
          text: `${request.method || 'GET'} ${request.path || ''} · HTTP ${request.status || '-'} · ${Number(request.ms) || 0}ms`,
        })
      }

      const render = () => {
        if (!active || !listEl) return
        const keepScrollTop = listEl.scrollTop
        const minLevel = LEVELS[levelSelect?.value] ?? LEVELS.info
        const cat = catSelect?.value || ''
        const keyword = String(searchInput?.value || '').trim().toLowerCase()
        const visible = entries
          .filter(item => (LEVELS[item.level] ?? LEVELS.info) <= minLevel)
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
          : '<div class="logs-empty">当前筛选条件下没有日志</div>'
        if (statsEl) {
          const streamText = streamOnline ? '实时流已连接' : runtimeAvailable ? '轮询更新中' : '后端未连接'
          statsEl.textContent = `${entries.length} 条 · 显示 ${visible.length} 条 · ${streamText}${paused ? ' · 已暂停' : ''}`
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
        const level = ['error', 'warn', 'info', 'debug'].includes(line.level) ? line.level : 'info'
        const name = String(line.name || 'backend')
        return add({
          at: Number(line.at) || Date.now(),
          level,
          cat: categoryOfSource(name),
          // 前端转发到后端的日志仍按原始 logger 名展示，避免和本地订阅的同一行重复成两条。
          source: line.origin === 'web' || !line.tag ? name : `${line.tag}·${name}`,
          text,
          timeout: /timeout|超时|ETIMEDOUT|timed out/i.test(text),
        })
      }

      const pullBackendRuntime = async ({ force = false } = {}) => {
        if (!active || !api) return { ok: false, error: '后端未连接' }
        try {
          if (force) {
            latestRuntimeId = 0
            runtimeSeen = new Set()
          }
          const query = latestRuntimeId > 0 ? `?limit=800&after=${encodeURIComponent(latestRuntimeId)}` : '?limit=2000'
          const data = await api.get(`/logs/runtime${query}`)
          runtimeAvailable = true
          const latest = Number(data?.latestId) || 0
          // 后端重启 / 日志被清空后 latestId 会回退；此时重置本地偏移，重新拉全量。
          if (latest > 0 && latest < latestRuntimeId) {
            return pullBackendRuntime({ force: true })
          }
          backendFile = data?.file || backendFile
          let added = 0
          for (const line of data?.lines || []) {
            if (addRuntimeLine(line)) added += 1
          }
          if (latest > latestRuntimeId) latestRuntimeId = latest
          if (backendFileEl && backendFile) backendFileEl.textContent = ` 后端日志文件：${backendFile}`
          scheduleRender()
          return { ok: true, added, latest }
        } catch (err) {
          // 旧后端没有该接口时保留本地日志订阅兜底。
          runtimeAvailable = false
          scheduleRender()
          return { ok: false, error: err?.message || String(err) }
        }
      }

      const openRuntimeStream = () => {
        if (typeof EventSource === 'undefined' || !api) return
        try {
          const base = String(api.baseUrl?.() || '/api').replace(/\/+$/, '')
          runtimeSource = new EventSource(`${base}/logs/runtime/stream`)
          runtimeSource.addEventListener('log', event => {
            streamOnline = true
            try {
              addRuntimeLine(JSON.parse(event.data))
              scheduleRender()
            } catch (_) {
              /* 忽略坏帧 */
            }
          })
          runtimeSource.onopen = () => {
            streamOnline = true
            // 断线重连后补拉断连期间的历史，Last-Event-ID 由后端 SSE 补偿。
            pullBackendRuntime()
          }
          runtimeSource.onerror = () => {
            streamOnline = false
            // EventSource 会自动重连；同时由 3 秒轮询兜底。
          }
        } catch (_) {
          runtimeSource = null
        }
      }

      // 先导入日志服务里已有的历史，再订阅后续记录。
      for (const record of logs?.history?.() || []) addRawLog(record)
      const offRecord = logs?.onRecord?.(addRawLog)

      const offs = [
        events.on('chat:request-start', ({ conversationId } = {}) =>
          add({ level: 'info', cat: '模型', source: 'chat-flow', text: `开始处理请求 · 会话 ${conversationId || '-'}` }),
        ),
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
          const { status, channelType, channelId, ms, error } = payload || {}
          if (status === 'pending') {
            add({ level: 'debug', cat: '外发', source: channelType || 'channel', text: `排队外发 · ${channelId || ''}` })
          } else if (status === 'sent') {
            add({ level: 'info', cat: '外发', source: channelType || 'channel', text: `外发成功 · ${Number(ms) || 0}ms · ${channelId || ''}` })
          } else if (status === 'failed') {
            add({ level: 'error', cat: '外发', source: channelType || 'channel', text: `外发失败 · ${channelId || ''}：${error || '未知错误'}` })
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
          } else if (event === 'sessions/changed' || event === 'settings/updated') {
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
      // 导致列表没跟上时，一按就强制重新拉取后端日志全量。
      const onRefresh = async event => {
        event?.stopPropagation?.()
        // 手动刷新意味着“我现在就要看最新日志”：取消暂停并强制回到底部。
        paused = false
        pauseBtn?.classList.remove('on')
        if (pauseBtn) pauseBtn.textContent = '暂停'
        autoScroll = true
        unseen = 0
        updateJumpBtn()
        const result = await pullBackendRuntime({ force: true })
        await pullBackend()
        render()
        listEl.scrollTop = listEl.scrollHeight
        if (result?.ok === false) toast?.error?.(`日志刷新失败：${result.error || '后端日志接口不可用'}`)
        else if (Number(result?.added) > 0) toast?.success?.(`日志已刷新，新增 ${result.added} 条`)
        else toast?.info?.('日志已刷新，没有新日志')
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
      levelSelect?.addEventListener('change', render)
      catSelect?.addEventListener('change', render)
      searchInput?.addEventListener('input', render)
      // 切回日志页 / 窗口重新聚焦时立刻补拉一次，避免后台标签页节流后看起来“没刷新”。
      const onVisible = () => {
        if (document.hidden === true) return
        void pullBackendRuntime()
        void pullBackend()
      }
      document.addEventListener('visibilitychange', onVisible)
      window.addEventListener?.('focus', onVisible)
      // 实时优先：后端专用 SSE 推送；3 秒轮询作为代理 / 旧后端 / 断线兜底。
      backendTimer = setInterval(() => {
        pullBackend()
        pullBackendRuntime()
      }, 3000)
      pullBackendRuntime()
      openRuntimeStream()
      render()

      return () => {
        active = false
        if (renderTimer) clearTimeout(renderTimer)
        if (backendTimer) clearInterval(backendTimer)
        try {
          runtimeSource?.close?.()
        } catch (_) {
          /* ignore */
        }
        runtimeSource = null
        document.removeEventListener('visibilitychange', onVisible)
        window.removeEventListener?.('focus', onVisible)
        offRecord?.()
        offs.forEach(off => off?.())
        refreshBtn?.removeEventListener('click', onRefresh)
        jumpBtn?.removeEventListener('click', onJump)
        container.removeEventListener('click', onClick)
        listEl?.removeEventListener('scroll', onListScroll)
        levelSelect?.removeEventListener('change', render)
        catSelect?.removeEventListener('change', render)
        searchInput?.removeEventListener('input', render)
      }
    },
  })

  ctx.logger.debug('运行日志设置页就绪')
}
