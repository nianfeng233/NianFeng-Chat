/*
 * 念风chat · 服务端常驻代聊运行时。
 *
 * 背景：
 *   聊天主链路（chat-flow / context-builder / chat-tools / session-service）目前是
 *   前端插件。传统启动方式必须保持 WebUI 页面打开，否则 NapCat 消息只会在后端
 *   收件箱里排队，直到再次打开页面才被处理。
 *
 * 这个模块由 start.mjs 以 worker_threads 形式拉起：
 *   - 用 Node 版 DOM 垫片加载与浏览器完全相同的前端插件；
 *   - 补齐 Node 环境没有的 EventSource；
 *   - 标记 __NIANFENG_SERVER_AGENT__，让浏览器端渠道插件让出消息处理权；
 *   - 所有 API 请求带 X-NianFeng-Agent，后端据此广播 sessions/changed 给浏览器。
 *
 * 直接 node src/headless/runtime.mjs 也可以运行；作为普通模块 import 时只导出
 * startHeadlessRuntime()，不会产生副作用，便于 `npm run check:kernels` 做语法检查。
 */
import './dom-shim.mjs'
import { NodeEventSource } from './event-source.mjs'
import { isMainThread, parentPort, workerData } from 'node:worker_threads'
import { pathToFileURL } from 'node:url'

const trimSlash = value => String(value || '').replace(/\/+$/, '')

export async function startHeadlessRuntime(options = {}) {
  const backendUrl = trimSlash(options.backendUrl || process.env.NIANFENG_BACKEND_URL || process.env.FENGYU_BACKEND_URL || '')
  const accessToken = String(options.accessToken || process.env.NIANFENG_WEBUI_TOKEN || process.env.FENGYU_WEBUI_TOKEN || '').trim()
  // 只有哈希落盘时父进程也拿不到明文；用同进程内存随机串走受控内部通道。
  const internalSecret = String(options.internalSecret || '').trim()
  if (!backendUrl) throw new Error('缺少服务端代聊所需的后端地址（NIANFENG_BACKEND_URL）')

  globalThis.__NIANFENG_SERVER_AGENT__ = true
  globalThis.EventSource = NodeEventSource

  // 给所有访问念风后端的请求统一补上内部令牌与 Agent 标记。
  // 标记只影响后端消息写回时的 SSE 广播，浏览器收到 agent 事件后刷新对应会话。
  const nativeFetch = globalThis.fetch.bind(globalThis)
  globalThis.fetch = (input, init = {}) => {
    let url = ''
    try {
      url = typeof input === 'string' ? input : input instanceof URL ? input.href : String(input?.url || '')
    } catch (_) {
      url = ''
    }
    if (!url || !url.startsWith(backendUrl)) return nativeFetch(input, init)
    const headers = new Headers(init?.headers || (typeof Request !== 'undefined' && input instanceof Request ? input.headers : undefined))
    if (accessToken) headers.set('X-NianFeng-Token', accessToken)
    if (internalSecret) headers.set('X-NianFeng-Internal', internalSecret)
    headers.set('X-NianFeng-Agent', '1')
    return nativeFetch(input, { ...init, headers })
  }

  localStorage.clear()
  localStorage.setItem(
    'nianfeng:config',
    JSON.stringify({
      data: {
        backend: { url: backendUrl },
        general: { restore: false },
      },
    }),
  )

  let appRef = null
  const shutdown = () => {
    try {
      appRef?.cordis?.stop?.()
    } catch (_) {
      /* ignore */
    }
  }

  const mainModule = await import('../main.mjs')
  const { app, ctx } = await mainModule.boot({ awaitRemote: true })
  appRef = app
  // 父进程（start.mjs）在插件清单变化时只发消息，不再重启 Worker：
  // 这里直接走运行期热同步，QQ / NapCat 代聊不中断。
  parentPort?.on('message', message => {
    if (message?.type !== 'plugins-changed') return
    Promise.resolve(mainModule.scheduleRemotePluginSync(app, { delay: 60, reason: message.payload?.action || 'parent' })).catch(err =>
      console.warn('[headless] 插件热同步失败：', err?.message || err),
    )
  })
  const api = ctx.inject('api')
  if (api?.health) await api.health().catch(() => {})
  const flow = ctx.inject('chat-flow')
  const flowMode = flow?.mode?.() || 'unknown'

  /**
   * WebUI → 后端终端代聊的桥：
   *   - 浏览器 POST /api/agent/send 后，后端广播 agent/send；
   *   - 这里把它转成 Worker 内部的 message:send，由 chat-flow 正常执行；
   *   - chat-flow 的 request-start / request-done 再上报 /agent/status，
   *     让浏览器输入框同步“生成中 / 完成”。
   */
  const agentEvents = ctx.inject('event-bus')
  const pendingClientIds = new Map()
  const reportAgentStatus = (conversationId, status, detail = '') => {
    const id = String(conversationId || '')
    if (!id) return
    const clientId = pendingClientIds.get(id) || ''
    fetch(`${backendUrl}/agent/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: id, clientId, status, detail }),
    })
      .then(() => {
        if (status === 'done' || status === 'error') pendingClientIds.delete(id)
      })
      .catch(() => {})
  }
  if (agentEvents?.on) {
    agentEvents.on('backend:event', payload => {
      const { event, data } = payload || {}
      if (event === 'agent/send' && data?.conversationId) {
        const conversationId = String(data.conversationId)
        if (data.clientId) pendingClientIds.set(conversationId, String(data.clientId))
        agentEvents.emit('message:send', {
          conversationId,
          text: String(data.text || ''),
          images: (Array.isArray(data.images) ? data.images : []).map(id => ({ id: String(id || '') })).filter(item => item.id),
          senderId: data.userId || 'web-user',
          senderName: data.userName || '用户',
          remoteHandled: true,
        })
        return
      }
      if (event === 'agent/cancel' && data?.conversationId) {
        const conversationId = String(data.conversationId)
        try {
          flow?.abort?.(conversationId)
        } catch (_) {
          /* ignore */
        }
        reportAgentStatus(conversationId, 'done', '用户已停止生成')
        return
      }
      if (event === 'chat/error' && pendingClientIds.size) {
        for (const conversationId of [...pendingClientIds.keys()]) {
          reportAgentStatus(conversationId, 'error', String(data?.detail || '模型调用失败').slice(0, 300))
        }
      }
    })
    agentEvents.on('chat:request-start', payload => reportAgentStatus(payload?.conversationId, 'start'))
    agentEvents.on('chat:request-done', payload => reportAgentStatus(payload?.conversationId, 'done'))
  }

  let sessionStatus = ctx.inject('session-service')?.status?.() || null
  // 后台代聊 Worker 的会话同步如果第一次没成功，这里在 ready 前再补一次；
  // 避免代聊运行在本地空会话上，导致 NapCat 新消息没有写进后端聊天记录。
  if (sessionStatus && sessionStatus.source !== 'server') {
    // 先等 session-service 的首次 compact 同步结束，避免再起一次并发全量同步；
    // 如果首次就是离线失败，才尝试补一次，ready 时会把 sessions=local 一起上报。
    try {
      await ctx.inject('session-service')?.ready?.()
    } catch (_) {
      /* ignore */
    }
    sessionStatus = ctx.inject('session-service')?.status?.() || sessionStatus
    if (sessionStatus?.source !== 'server') {
      try {
        await ctx.inject('session-service')?.sync?.()
      } catch (_) {
        /* ready 时会把 sessions=local 一起上报，start.mjs 记日志 */
      }
      sessionStatus = ctx.inject('session-service')?.status?.() || sessionStatus
    }
  }
  console.log(
    `[headless] 服务端代聊已就绪 · 后端 ${backendUrl} · chat-flow=${flowMode} · sessions=${sessionStatus?.source || 'unknown'}`,
  )
  parentPort?.postMessage({
    type: 'ready',
    backendUrl,
    flowMode,
    plugins: app.activeCount,
    total: app.list?.().length || 0,
    sessionsSource: sessionStatus?.source || '',
    sessionsError: sessionStatus?.error || '',
    at: Date.now(),
  })
  const heartbeat = setInterval(() => {
    parentPort?.postMessage({ type: 'heartbeat', at: Date.now() })
  }, 15_000)
  heartbeat.unref?.()

  if (isMainThread) {
    process.on('SIGINT', () => {
      shutdown()
      process.exit(0)
    })
    process.on('SIGTERM', () => {
      shutdown()
      process.exit(0)
    })
  }
  // 保持常驻。真正的句柄来自 SSE / 定时轮询，这里的 interval 只兜底避免提前退出。
  const keepAlive = setInterval(() => {}, 60_000)
  keepAlive.unref?.()
  return { app, ctx, flowMode }
}

const isDirectRun = (() => {
  try {
    return !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
  } catch (_) {
    return false
  }
})()

if (!isMainThread || isDirectRun) {
  const runOptions = workerData && typeof workerData === 'object' ? workerData : {}
  startHeadlessRuntime(runOptions).catch(err => {
    console.error('[headless] 服务端代聊启动失败：', err?.stack || err?.message || err)
    if (isMainThread) process.exit(1)
  })
}
