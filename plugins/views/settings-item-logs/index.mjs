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
            <div class="settings-desc">实时查看模型调用到哪一步、工具 / 权限确认 / 渠道外发是否成功；模型或后端超时会单独标红。</div>
          </div>
        </div>
        <section class="settings-section">
          <div class="logs-toolbar">
            <select data-logs-level title="最低级别">
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
            <span class="logs-stats" data-logs-stats></span>
          </div>
          <div class="logs-list" data-logs-list>
            <div class="logs-empty">正在读取日志…</div>
          </div>
          <div class="logs-note">
            时间线包含：模型请求开始 / 完成 / 错误、工具调用参数与耗时、敏感操作确认结果、渠道消息实际外发结果，
            以及后端 <code>/api/chat</code> 的请求耗时。模型长时间无响应时，看最后一条“开始”之后有没有“完成”即可判断是卡住还是超时。
            <span data-logs-backend-file></span>
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

      let entries = []
      let seq = 0
      let autoScroll = true
      let paused = false
      let renderTimer = null
      let backendTimer = null
      let backendFile = ''
      const backendSeen = new Set()
      let active = true

      const scheduleRender = () => {
        if (!active || paused || renderTimer) return
        renderTimer = setTimeout(() => {
          renderTimer = null
          render()
        }, 80)
      }

      const add = entry => {
        if (!active) return
        entries.push({
          id: ++seq,
          at: Date.now(),
          level: 'info',
          cat: '系统',
          source: '',
          text: '',
          timeout: false,
          ...entry,
        })
        if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES)
        scheduleRender()
      }

      const addRawLog = record => {
        const level = LEVELS[record?.type] ?? LEVELS[record?.level] ?? (typeof record?.level === 'number' ? record.level : 2)
        const args = Array.isArray(record?.args) ? record.args : []
        const text = args.map(formatArg).join(' ').slice(0, 4000)
        if (!text) return
        const source = String(record?.name || 'app')
        const cat = categoryOfSource(source)
        add({
          at: Number(record?.timestamp ?? record?.time ?? Date.now()) || Date.now(),
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
                  <span class="logs-src" title="${escapeHtml(item.source)}">${escapeHtml(item.source || item.cat)}</span>
                  <span class="logs-text">${escapeHtml(item.text)}</span>
                </div>`,
              )
              .join('')
          : '<div class="logs-empty">当前筛选条件下没有日志</div>'
        if (statsEl) statsEl.textContent = `${entries.length} 条 · 显示 ${visible.length} 条${paused ? ' · 已暂停' : ''}`
        if (autoScroll && !paused && listEl) listEl.scrollTop = listEl.scrollHeight
      }

      const pullBackend = async () => {
        if (!active || !api || paused) return
        try {
          const data = await api.logs(200)
          for (const request of data?.requests || []) addBackendRequest(request)
        } catch (_) {
          /* 后端离线时保持前端日志 */
        }
      }

      const runtimeSeen = new Set()
      const addRuntimeLine = line => {
        const key = `runtime|${line?.at || ''}|${line?.name || ''}|${line?.text || ''}`
        if (!line?.text || runtimeSeen.has(key)) return
        runtimeSeen.add(key)
        if (runtimeSeen.size > 4000) runtimeSeen.clear()
        const level = ['error', 'warn', 'info', 'debug'].includes(line.level) ? line.level : 'info'
        add({ at: Number(line.at) || Date.now(), level, cat: categoryOfSource(line.name), source: line.name || 'backend', text: line.text })
      }

      const pullBackendRuntime = async () => {
        if (!active || !api) return
        try {
          const data = await api.get('/logs/runtime?limit=500')
          backendFile = data?.file || backendFile
          for (const line of data?.lines || []) addRuntimeLine(line)
          if (backendFileEl && backendFile) backendFileEl.textContent = ` 后端日志文件：${backendFile}`
        } catch (_) {
          /* 旧后端没有该接口时忽略 */
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
          button.classList.toggle('on', autoScroll)
          if (autoScroll) render()
        } else if (button.dataset.logsPause !== undefined) {
          paused = !paused
          button.classList.toggle('on', paused)
          button.textContent = paused ? '继续' : '暂停'
          if (!paused) render()
          else if (statsEl) statsEl.textContent = `${entries.length} 条 · 已暂停`
        } else if (button.dataset.logsClear !== undefined) {
          entries = []
          logs?.clear?.()
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

      container.addEventListener('click', onClick)
      const onListScroll = () => {
        if (paused) return
        const atBottom = listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight < 28
        autoScroll = atBottom
        autoBtn?.classList.toggle('on', autoScroll)
      }
      listEl?.addEventListener('scroll', onListScroll)
      levelSelect?.addEventListener('change', render)
      catSelect?.addEventListener('change', render)
      searchInput?.addEventListener('input', render)
      backendTimer = setInterval(pullBackend, 5000)
      pullBackend()
      pullBackendRuntime()
      render()

      return () => {
        active = false
        if (renderTimer) clearTimeout(renderTimer)
        if (backendTimer) clearInterval(backendTimer)
        offRecord?.()
        offs.forEach(off => off?.())
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
