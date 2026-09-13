/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * F14 · backend-client
 * WebUI 与本地后端之间的唯一通道：
 *   - REST 调用（配置 / 提供商 / 会话 / 翻译 / RSS）
 *   - SSE 聊天流（/api/chat）
 *   - /api/events 实时事件订阅 + 健康检查
 *
 * 默认地址是相对路径 /api（由 start.mjs 代理到后端），
 * 也可以在 config['backend.url'] 里指定绝对地址，例如 http://127.0.0.1:8788/api。
 */
export const name = 'backend-client'
export const version = '1.0.0'
export const displayName = '后端连接'
export const description = '基础服务 · WebUI ↔ 本地后端的 REST / SSE 通道与在线状态。'
export const author = '念风内核'
export const icon = '🔌'
export const core = true
export const depends = {
  'config': '>=1.1.0',
}
export const optionalDepends = {}
export const inject = ['config']
export const provides = [{ name: 'api', type: 'singleton' }]
export const permissions = ["network"]

export function apply(ctx) {
  const config = ctx.inject('config')

  let online = false
  let lastError = ''
  let lastHealth = null
  let latency = 0
  let eventSource = null
  let pollTimer = null

  const baseUrl = () => String(config.get('backend.url', '/api') || '/api').replace(/\/+$/, '')

  async function request(path, { method = 'GET', body, signal, timeoutMs = 20000 } = {}) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('请求超时')), timeoutMs)
    const onAbort = () => controller.abort(signal?.reason)
    signal?.addEventListener?.('abort', onAbort, { once: true })
    try {
      const res = await fetch(`${baseUrl()}${path}`, {
        method,
        headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
        // 允许部署时把后端地址配成绝对地址（如 http://127.0.0.1:8788/api）：
        // 跨源请求也需要带上 WebUI 访问令牌 Cookie。
        credentials: 'include',
        // 本地后端接口一律不走缓存：避免代理 / 浏览器把日志、会话等
        // 动态接口的旧响应当成新数据，导致界面看起来“刷新没反应”。
        cache: 'no-store',
      })
      const text = await res.text()
      let data = null
      try {
        data = text ? JSON.parse(text) : null
      } catch (_) {
        data = { raw: text }
      }
      if (!res.ok) {
        const message = data?.error?.message || data?.message || `HTTP ${res.status} ${res.statusText}`
        const err = new Error(message)
        err.status = res.status
        throw err
      }
      return data
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
    }
  }

  const service = {
    name: 'api',
    baseUrl,
    status: () => ({ online, latency, lastError, health: lastHealth, baseUrl: baseUrl() }),
    configured: () => online,
    /** 后端是否提供某项能力（用于识别没重启的旧后端进程） */
    supports: feature => !!lastHealth?.capabilities?.includes(feature),
    capabilities: () => lastHealth?.capabilities || [],

    get: (path, options) => request(path, options),
    post: (path, body, options) => request(path, { ...options, method: 'POST', body }),
    put: (path, body, options) => request(path, { ...options, method: 'PUT', body }),
    del: (path, options) => request(path, { ...options, method: 'DELETE' }),

    async health() {
      const started = Date.now()
      try {
        const data = await request('/health', { timeoutMs: 4000 })
        latency = Date.now() - started
        lastHealth = data
        setOnline(true, '')
        return data
      } catch (err) {
        lastError = err.message
        setOnline(false, err.message)
        throw err
      }
    },

    providers: () => request('/providers'),
    builtinModels: () => request('/builtin/models'),
    getConfig: () => request('/config'),
    setConfig: patch => request('/config', { method: 'PUT', body: patch }),
    getDataDir: () => request('/data-dir'),
    pickDataDir: () => request('/data-dir/pick', { method: 'POST', timeoutMs: 200000 }),
    setDataDir: (dir, migrate = false) => request('/data-dir', { method: 'PUT', body: { dir, migrate }, timeoutMs: 60000 }),
    addProvider: provider => request('/providers', { method: 'POST', body: provider }),
    removeProvider: id => request(`/providers/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    updateProvider: (id, patch) => request(`/providers/${encodeURIComponent(id)}`, { method: 'PUT', body: patch }),
    refreshProvider: id => request(`/providers/${encodeURIComponent(id)}/refresh`, { method: 'POST' }),
    testProvider: id => request(`/providers/${encodeURIComponent(id)}/test`, { method: 'POST' }),
    addModel: (providerId, model) => request(`/providers/${encodeURIComponent(providerId)}/models`, { method: 'POST', body: model }),
    updateModel: (providerId, modelId, patch) =>
      request(`/providers/${encodeURIComponent(providerId)}/models/${encodeURIComponent(modelId)}`, { method: 'PUT', body: patch }),
    removeModel: (providerId, modelId) =>
      request(`/providers/${encodeURIComponent(providerId)}/models/${encodeURIComponent(modelId)}`, { method: 'DELETE' }),
    logs: (limit = 100) => request(`/logs?limit=${limit}`),
    plugins: () => request('/plugins'),
    pluginDirs: () => request('/plugins/dirs'),
    setPluginsDir: dir => request('/plugins/dirs', { method: 'PUT', body: { dir }, timeoutMs: 60000 }),
    rescanPlugins: () => request('/plugins/rescan', { method: 'POST', timeoutMs: 60000 }),
    pickPluginsDir: () => request('/plugins/pick-dir', { method: 'POST', timeoutMs: 200000 }),
    openPluginsDir: () => request('/plugins/open-dir', { method: 'POST' }),
    removeExternalPlugin: id => request(`/plugins/external/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    restartSystem: () => request('/system/restart', { method: 'POST', timeoutMs: 8000 }),

    sessions: (options = {}) => request(`/sessions${options?.compact ? '?compact=1' : ''}`),
    createSession: conv => request('/sessions', { method: 'POST', body: conv }),
    saveSession: conv => request(`/sessions/${conv.id}`, { method: 'PUT', body: conv }),
    deleteSession: id => request(`/sessions/${id}`, { method: 'DELETE' }),
    addMessage: (id, message) => request(`/sessions/${id}/messages`, { method: 'POST', body: message }),
    updateMessage: (id, messageId, patch) => request(`/sessions/${id}/messages/${encodeURIComponent(messageId)}`, { method: 'PUT', body: patch }),
    removeMessage: (id, messageId) => request(`/sessions/${id}/messages/${encodeURIComponent(messageId)}`, { method: 'DELETE' }),
    replaceMessages: (id, messages) => request(`/sessions/${id}/messages`, { method: 'PUT', body: { messages } }),
    clearMessages: id => request(`/sessions/${id}/messages`, { method: 'DELETE' }),

    translate: (text, target = 'en', extra = {}) => request('/translate', { method: 'POST', body: { text, target, ...extra }, timeoutMs: 120000 }),
    rss: url => request(`/rss?url=${encodeURIComponent(url)}`, { timeoutMs: 25000 }),


    /**
     * 聊天流：直接消费后端 SSE。
     * events: start / chunk / tool_call / done / error
     */
    async streamChat({
      provider,
      model,
      messages,
      temperature,
      maxTokens,
      reasoningEffort,
      extraBody,
      tools,
      toolChoice,
      signal,
      onChunk,
      onReasoning,
      onToolCall,
      onDone,
      onError,
    }) {
      const controller = new AbortController()
      const onAbort = () => controller.abort(signal?.reason)
      signal?.addEventListener?.('abort', onAbort, { once: true })
      try {
        const res = await fetch(`${baseUrl()}/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            provider,
            model,
            messages,
            temperature,
            maxTokens,
            reasoningEffort,
            extraBody,
            ...(Array.isArray(tools) && tools.length ? { tools, toolChoice } : {}),
          }),
          signal: controller.signal,
          credentials: 'include',
        })
        if (!res.ok || !res.body) {
          const text = await res.text().catch(() => '')
          let message = `HTTP ${res.status}`
          try {
            message = JSON.parse(text)?.error?.message || message
          } catch (_) {
            /* ignore */
          }
          throw new Error(message)
        }

        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        let eventType = ''
        let dataLines = []

        const dispatch = () => {
          const payload = dataLines.join('\n')
          const type = eventType || 'message'
          eventType = ''
          dataLines = []
          let data = null
          try {
            data = payload ? JSON.parse(payload) : null
          } catch (_) {
            data = null
          }
          if (type === 'chunk' && data?.delta) onChunk?.(data.delta)
          else if (type === 'reasoning' && data?.delta) onReasoning?.(data.delta)
          else if (type === 'tool_call' && data) onToolCall?.(data)
          else if (type === 'done') onDone?.(data || {})
          else if (type === 'error') onError?.(new Error(data?.message || '后端返回错误'))
        }

        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() || ''
          for (const line of lines) {
            if (line.startsWith('event:')) eventType = line.slice(6).trim()
            else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
            else if (!line.trim() && (dataLines.length || eventType)) dispatch()
          }
        }
        if (dataLines.length || eventType) dispatch()
      } catch (err) {
        if (err?.name !== 'AbortError') onError?.(err)
      } finally {
        signal?.removeEventListener?.('abort', onAbort)
      }
    },

    /** 订阅后端实时事件（EventSource） */
    subscribe() {
      if (eventSource || typeof EventSource === 'undefined') return false
      try {
        eventSource = new EventSource(`${baseUrl()}/events`, { withCredentials: true })
        eventSource.onmessage = e => {
          try {
            ctx.emit('backend:event', { event: 'message', data: JSON.parse(e.data) })
          } catch (_) {
            /* ignore */
          }
        }
        const forward = type => e => {
          setOnline(true, '')
          let data = null
          try {
            data = e.data ? JSON.parse(e.data) : null
          } catch (_) {
            data = e.data
          }
          ctx.emit('backend:event', { event: type, data })
        }
        for (const type of ['hello', 'channel:message', 'clawbot:message', 'clawbot:status', 'provider/status', 'chat/start', 'chat/done', 'chat/error', 'sessions/changed', 'settings/updated', 'log/line']) {
          eventSource.addEventListener(type, forward(type))
        }
        eventSource.onerror = () => {
          setOnline(false, '实时通道断开，正在重连…')
        }
        ctx.effect(() => {
          eventSource?.close()
          eventSource = null
        })
        return true
      } catch (err) {
        ctx.logger.warn('无法订阅后端事件', err)
        return false
      }
    },

    /** 手动触发一次健康检查 */
    check: () => service.health().catch(() => service.status()),
  }

  function setOnline(next, error) {
    const changed = next !== online
    online = next
    lastError = error || ''
    if (changed) {
      ctx.emit('backend:status', service.status())
      ctx.logger[next ? 'info' : 'warn'](next ? '后端已连接' : `后端不可用：${error || '未知原因'}`)
    }
  }

  // 定时健康检查（10 秒）；页面重新可见时立即检查
  const tick = () => service.health().catch(() => {})
  pollTimer = setInterval(tick, 10000)
  ctx.effect(() => clearInterval(pollTimer))
  if (typeof document !== 'undefined') {
    const onVisible = () => {
      if (!document.hidden) tick()
    }
    document.addEventListener('visibilitychange', onVisible)
    ctx.effect(() => document.removeEventListener('visibilitychange', onVisible))
  }

  ctx.provide('api', service, { type: 'singleton' })
  service.subscribe()
  tick()

  ctx.logger.debug(`后端通道就绪：${baseUrl()}`)
}
