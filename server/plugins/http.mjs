/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * 后端 · http
 * 真实的 HTTP API（JSON + SSE 流式）+ 可选的 WebUI 静态托管。
 * 路由全部显式声明，不依赖任何 Web 框架。
 */
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'
import { hostname as osHostname, networkInterfaces } from 'node:os'
import { timingSafeStringEqual, isInsideDir, isSensitiveStaticPath } from '../security-utils.mjs'
import { fetchPublicText } from '../net-guard.mjs'

export const name = 'http'
export const inject = ['settings', 'sessions', 'models', 'hub', 'info', 'instance', 'pluginRegistry']

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
}

export function apply(ctx, config = {}) {
  const settings = ctx.settings
  const sessions = ctx.sessions
  const models = ctx.models
  const hub = ctx.hub
  /** 服务端常驻代聊请求会带这个头；浏览器收到 agent=true 的事件后刷新对应会话。 */
  const isAgentRequest = req => String(req?.headers?.['x-nianfeng-agent'] || '') === '1'
  const broadcastSessionChange = (req, action, id, extra = {}) => {
    try {
      hub.broadcast('sessions/changed', { action, id, agent: isAgentRequest(req), at: Date.now(), ...extra })
    } catch (_) {
      /* SSE 广播失败不影响写入 */
    }
  }

  const port = config.port ?? 8788
  const host = config.host ?? '127.0.0.1'
  const staticDir = config.staticDir ? resolve(config.staticDir) : null
  const accessToken = String(config.accessToken || '').trim()
  const onRestart = typeof config.onRestart === 'function' ? config.onRestart : null
  const startedAt = Date.now()
  const requestLog = []

  /* ---------------- 跨站 / DNS rebinding 防护 ---------------- */

  const originList = Array.isArray(config.allowedOrigins) ? config.allowedOrigins : []
  const extraHostList = Array.isArray(config.allowedHosts) ? config.allowedHosts : []
  const wildcardBind = !host || host === '0.0.0.0' || host === '::'

  const normalizeHostName = value => {
    let name = String(value || '').trim().toLowerCase()
    if (!name) return ''
    name = name.replace(/^\[|\]$/g, '')
    if (name === '::1') return '[::1]'
    return name
  }

  /** 允许配置项写成 `example.com`、`example.com:8788` 或完整 `http://example.com:8788`。 */
  const hostNameFromConfig = value => {
    const raw = String(value || '').trim()
    if (!raw) return ''
    try {
      const parsed = new URL(raw.includes('://') ? raw : `http://${raw}`)
      return normalizeHostName(parsed.hostname)
    } catch (_) {
      return normalizeHostName(raw)
    }
  }

  const configuredOrigins = new Set(
    originList
      .map(value => {
        try {
          const url = new URL(String(value))
          return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : ''
        } catch (_) {
          return ''
        }
      })
      .filter(Boolean),
  )

  const localAddresses = (() => {
    const out = new Set()
    try {
      for (const entries of Object.values(networkInterfaces())) {
        for (const entry of entries || []) {
          if (entry?.address) out.add(entry.address)
        }
      }
    } catch (_) {
      /* 取不到网卡信息时只依赖本机名称 */
    }
    return [...out]
  })()

  const allowedHostNames = new Set(
    ['localhost', '127.0.0.1', '[::1]', host, osHostname(), ...localAddresses, ...extraHostList]
      .map(hostNameFromConfig)
      .filter(Boolean),
  )

  /** Host 头校验：默认只接受本机名、监听地址与实际网卡地址；显式监听 0.0.0.0 时不限制。 */
  const isAllowedHost = rawHost => {
    if (!rawHost) return true
    if (wildcardBind) return true
    try {
      const parsed = new URL(`http://${String(rawHost).trim()}`)
      return allowedHostNames.has(normalizeHostName(parsed.hostname))
    } catch (_) {
      return false
    }
  }

  /** Origin 校验：同源本机地址、启动参数显式放行的 WebUI 地址之外一律拒绝。 */
  const isAllowedOrigin = rawOrigin => {
    const origin = String(rawOrigin || '').trim()
    if (!origin) return true
    if (origin === 'null') return false
    if (configuredOrigins.has(origin)) return true
    try {
      const parsed = new URL(origin)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
      if (!allowedHostNames.has(normalizeHostName(parsed.hostname))) return false
      const actualPort = String(server.address()?.port || '')
      const originPort = parsed.port || (parsed.protocol === 'https:' ? '443' : '80')
      return !!actualPort && originPort === actualPort
    } catch (_) {
      return false
    }
  }

  const setSecurityHeaders = res => {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('X-Frame-Options', 'DENY')
    res.setHeader('Referrer-Policy', 'no-referrer')
  }

  /** 只在来源明确合法时回 CORS 头；绝不使用 `*`，也不给未知 Origin 留任何响应头。 */
  const setCorsHeaders = (req, res) => {
    const origin = String(req.headers.origin || '')
    res.setHeader('Vary', 'Origin')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-NianFeng-Token')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
    res.setHeader('Access-Control-Max-Age', '600')
    if (!origin) return
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Access-Control-Allow-Credentials', 'true')
  }

  /* ---------------- 请求工具 ---------------- */

  const sendJson = (res, status, data) => {
    const body = JSON.stringify(data)
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
    })
    res.end(body)
  }

  const sendError = (res, status, message) => sendJson(res, status, { error: { status, message } })

  /* ---- WebUI 访问令牌（可选）：空 token 表示不校验 ---- */
  const cookieValue = (req, name) => {
    for (const part of String(req.headers.cookie || '').split(';')) {
      const [key, ...rest] = part.trim().split('=')
      if (key !== name) continue
      const raw = rest.join('=')
      try {
        return decodeURIComponent(raw)
      } catch (_) {
        return raw
      }
    }
    return ''
  }
  const requestTokens = (req, url) => ({
    query: url.searchParams.get('token') || '',
    cookie: cookieValue(req, 'nianfeng_token') || '',
    header: String(req.headers['x-nianfeng-token'] || '') || String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''),
  })

  /**
   * 查询串令牌只用于「浏览器首次打开首页」的 Cookie 引导：
   *   GET + Accept: text/html + 非 API / 插件资源路径。
   * API 请求只认 Cookie 或 X-NianFeng-Token / Authorization 头，
   * 避免令牌长期出现在 fetch URL、日志与浏览器历史里。
   */
  const canUseQueryToken = (req, pathname) => {
    if (String(req.method || '').toUpperCase() !== 'GET') return false
    if (pathname.startsWith('/api/') || pathname.startsWith('/user-plugins/')) return false
    return String(req.headers.accept || '').includes('text/html')
  }

  const checkAccessToken = (req, url, pathname) => {
    const tokens = requestTokens(req, url)
    const headerOk = !!tokens.header && timingSafeStringEqual(tokens.header, accessToken)
    const cookieOk = !!tokens.cookie && timingSafeStringEqual(tokens.cookie, accessToken)
    const queryOk = !!tokens.query && canUseQueryToken(req, pathname) && timingSafeStringEqual(tokens.query, accessToken)
    return { tokens, headerOk, cookieOk, queryOk, ok: headerOk || cookieOk || queryOk }
  }

  const isAuthorizedRequest = (req, url, pathname) => {
    if (!accessToken) return true
    return checkAccessToken(req, url, pathname).ok
  }

  const openRoute = pathname => pathname === '/api/health' || pathname === '/api/version'
  const sendAuthPage = res => {
    const body = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>需要访问令牌</title>
<body style="font-family:system-ui,sans-serif;padding:48px;color:#1a1d21"><h2>需要访问令牌</h2>
<p>这是一个受保护的 WebUI。请在地址后加上访问令牌完成首次引导：</p><pre style="padding:12px;background:#f4f6f2;border-radius:8px">http://&lt;主机&gt;:&lt;端口&gt;/?token=你的令牌</pre>
<p>验证通过后会写入本机 Cookie，随后地址栏会自动去掉令牌；后续 API 请使用 Cookie 或 <code>X-NianFeng-Token</code> 请求头。</p></body></html>`
    res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(body)
  }

  const readBody = (req, maxBytes = 2 * 1024 * 1024) =>
    new Promise((resolveBody, reject) => {
      let size = 0
      let settled = false
      let oversizeError = null
      const chunks = []
      const finishReject = error => {
        if (settled) return
        settled = true
        reject(error)
      }
      req.on('data', chunk => {
        if (settled) return
        size += chunk.length
        if (size > maxBytes) {
          // 超限时不要 destroy：继续把请求体读掉（最多 4 倍上限），
          // 这样 catch 里写回的 413 JSON 能完整到达客户端，而不是被连接重置成 502。
          if (!oversizeError) {
            oversizeError = Object.assign(new Error(`请求体超过 ${Math.round(maxBytes / 1024 / 1024)}MB 限制`), { status: 413 })
          }
          if (size > maxBytes * 4) {
            finishReject(oversizeError)
            req.destroy()
          }
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => {
        if (oversizeError) return finishReject(oversizeError)
        if (settled) return
        settled = true
        if (!chunks.length) return resolveBody({})
        try {
          resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        } catch (_) {
          reject(Object.assign(new Error('请求体不是合法 JSON'), { status: 400 }))
        }
      })
      req.on('error', error => finishReject(error))
      req.on('aborted', () => finishReject(Object.assign(new Error('请求已中断'), { status: 400 })))
    })

  /** 插件上传是 base64 JSON，单独放宽到 48MB（解码后的 zip 仍限制 32MB）。 */
  const readUploadBody = req => readBody(req, 48 * 1024 * 1024)

  /**
   * /api/chat 请求体上限：群聊上下文可能内联图片 data URL，2MB 很容易被顶爆。
   * 默认 32MB，可用 network.chatBodyLimitMB 调整（4–128MB）。
   * 图片本身另有“只保留最近 2 张 + 总字节预算”的约束，见 context-builder。
   */
  const chatBodyLimit = () => {
    const configured = Number(settings.get()?.network?.chatBodyLimitMB)
    const mb = Number.isFinite(configured) && configured > 0 ? configured : 32
    return Math.min(128, Math.max(4, mb)) * 1024 * 1024
  }

  const sse = (res, handler) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    // 反向代理 / Windows 云服务器上让 SSE 首包立即下发，避免日志流被缓冲。
    res.flushHeaders?.()
    res.socket?.setNoDelay?.(true)
    res.write(': connected\n\n')
    handler(res)
  }

  /* ---------------- 路由表 ---------------- */

  const routes = []
  const route = (method, pattern, handler) => {
    const keys = []
    const regex = new RegExp(
      '^' +
        pattern
          .replace(/\/:([A-Za-z_]+)/g, (_, key) => {
            keys.push(key)
            return '/([^/]+)'
          })
          .replace(/\//g, '\\/') +
        '$',
    )
    const entry = { method, regex, keys, handler }
    routes.push(entry)
    return entry
  }

  const match = (method, pathname) => {
    for (const r of routes) {
      if (r.method !== method && !(method === 'HEAD' && r.method === 'GET')) continue
      const m = r.regex.exec(pathname)
      if (!m) continue
      // 参数逐个解码：模型 ID 里可能带 /，客户端用 %2F 编码在单段里传入
      const params = Object.fromEntries(
        r.keys.map((key, i) => {
          try {
            return [key, decodeURIComponent(m[i + 1])]
          } catch (_) {
            return [key, m[i + 1]]
          }
        }),
      )
      return { route: r, params }
    }
    return null
  }

  /**
   * 后端插件通用 HTTP 扩展点：
   * 渠道 bridge.mjs 等后端插件可以注册自己的 /api/... 路由，无需修改本文件。
   *   const dispose = ctx.httpApi.route('GET', '/api/my-channel/status', handler)
   * handler(req, res, params, url)，返回值忽略；抛出的错误会按 err.status 返回。
   */
  const extraCapabilities = new Set()
  const register = route
  const httpApi = {
    route: (method, pattern, handler) => {
      const entry = register(method, pattern, handler)
      return () => {
        const index = routes.indexOf(entry)
        if (index >= 0) routes.splice(index, 1)
      }
    },
    readBody,
    sendJson,
    sendError,
    sse,
    registerCapability(name) {
      const key = String(name || '').trim()
      if (!key) return () => {}
      extraCapabilities.add(key)
      return () => extraCapabilities.delete(key)
    },
    capabilities: () => [...extraCapabilities],
  }

  /* ---------------- 基础 ---------------- */

  route('GET', '/api/health', async (req, res, params, url) => {
    const authenticated = isAuthorizedRequest(req, url, '/api/health')
    const base = {
      ok: true,
      name: ctx.info.name,
      version: ctx.info.version,
      uptime: Date.now() - startedAt,
      time: new Date().toISOString(),
      // 前端用它判断后端进程是否加载了最新功能（旧进程会缺少这些能力）
      capabilities: [
        'builtin-models', 'provider-crud', 'model-crud', 'model-params', 'data-dir', 'proxy', 'tools',
        'external-plugins', 'plugin-dirs', 'plugin-upload', 'webui-auth', 'system-restart', 'plugin-http-routes',
        'preferences-sync', 'cors-origin-guard', 'ssrf-guard', 'constant-time-token', 'health-detail-auth',
        ...extraCapabilities,
      ],
      authRequired: !!accessToken,
      authenticated,
      runtime: 'cordis v4',
    }
    // 配了访问令牌但当前请求未通过校验时，只返回存活探针所需的最小信息，
    // 不泄露数据目录、配置文件路径、提供商状态、会话数量等本机细节。
    if (!authenticated) return sendJson(res, 200, base)

    const providerList = models.list()
    sendJson(res, 200, {
      ...base,
      dataDir: settings.dataDir,
      configFile: settings.file,
      providers: providerList.map(p => ({ id: p.id, type: p.type, configured: p.configured, status: p.status, models: p.models.length })),
      defaultProvider: settings.get().defaultProvider,
      defaultModel: settings.get().defaultModel,
      sessions: { count: sessions.count(), messages: sessions.totalMessages() },
      sseClients: hub.count(),
    })
  })

  route('GET', '/api/version', async (req, res) =>
    sendJson(res, 200, { version: ctx.info.version, node: process.version, authRequired: !!accessToken }),
  )

  /** 重启：由宿主/启动脚本接管；桌面版请在设置页走 windHost.restart() */
  route('POST', '/api/system/restart', async (req, res) => {
    if (!onRestart) return sendError(res, 501, '当前运行方式不支持自动重启，请手动关闭后重新启动')
    sendJson(res, 200, { ok: true, message: '正在重启念风…' })
    setTimeout(() => {
      try {
        onRestart()
      } catch (err) {
        ctx.logger.error(`重启失败：${err.message}`)
      }
    }, 150)
  })

  /* ---------------- 配置 ---------------- */

  route('GET', '/api/config', async (req, res) => sendJson(res, 200, settings.redacted()))

  route('PUT', '/api/config', async (req, res) => {
    const body = await readBody(req)
    await settings.update(body)
    hub.broadcast('settings/updated', settings.redacted())
    sendJson(res, 200, settings.redacted())
  })

  /* ---------------- 实例数据目录 ---------------- */

  route('GET', '/api/data-dir', async (req, res) => {
    sendJson(res, 200, ctx.instance.info())
  })

  /** 调起系统目录选择器（Windows 文件夹对话框） */
  route('POST', '/api/data-dir/pick', async (req, res) => {
    const result = await ctx.instance.pickDirectory()
    sendJson(res, 200, { ok: true, path: result.path })
  })

  route('PUT', '/api/data-dir', async (req, res) => {
    const body = await readBody(req)
    // 空目录 = 全新空白实例；已有数据 = 加载目标。默认不复制当前数据。
    const info = await ctx.instance.setDataDir(body.dir, { migrate: body.migrate === true })
    // 配置与会话都换到了新目录，通知所有页面重新同步
    hub.broadcast('settings/updated', settings.redacted())
    hub.broadcast('sessions/changed', { action: 'reload', dataDir: info.dataDir })
    sendJson(res, 200, info)
  })

  /* ---------------- 外部插件目录与清单 ---------------- */

  /** 内置 + 外部插件的完整清单；前端 boot 从这里取，而不是只依赖打包时的 registry.mjs */
  route('GET', '/api/plugins', async (req, res) => {
    sendJson(res, 200, await ctx.pluginRegistry.list())
  })

  route('GET', '/api/plugins/dirs', async (req, res) => {
    sendJson(res, 200, await ctx.pluginRegistry.dirs())
  })

  /** 设置外部插件目录；空字符串 = 恢复默认（数据目录下的 plugins/） */
  route('PUT', '/api/plugins/dirs', async (req, res) => {
    const body = await readBody(req)
    const dirs = await ctx.pluginRegistry.setExternalDir(body.dir)
    sendJson(res, 200, dirs)
  })

  route('POST', '/api/plugins/rescan', async (req, res) => {
    sendJson(res, 200, await ctx.pluginRegistry.refresh())
  })

  /** 调起系统目录选择器，选择插件目录 */
  route('POST', '/api/plugins/pick-dir', async (req, res) => {
    const result = await ctx.pluginRegistry.pickDirectory()
    sendJson(res, 200, { ok: true, path: result.path })
  })

  /** 浏览器上传 zip 插件包并安装到外部插件目录（远程部署同样适用） */
  route('POST', '/api/plugins/upload', async (req, res) => {
    const body = await readUploadBody(req)
    const result = await ctx.pluginRegistry.installZip({
      base64: body.data,
      filename: body.filename,
      overwrite: body.overwrite === true || String(body.overwrite) === 'true',
    })
    if (!result.ok) return sendError(res, result.exists ? 409 : 400, result.error)
    sendJson(res, 200, result)
  })

  route('POST', '/api/plugins/open-dir', async (req, res) => {
    sendJson(res, 200, ctx.pluginRegistry.openExternalDir())
  })

  /** 删除外部插件目录（只允许删除外部目录内的插件；内置插件只能禁用） */
  route('DELETE', '/api/plugins/external/:id', async (req, res, params) => {
    const result = await ctx.pluginRegistry.removeExternal(params.id)
    if (!result.ok) return sendError(res, 404, result.error)
    sendJson(res, 200, result)
  })

  /* ---------------- 模型提供商 ---------------- */

  route('GET', '/api/providers', async (req, res) => {
    sendJson(res, 200, {
      providers: models.list(),
      adapters: models.adapters(),
      defaultProvider: settings.get().defaultProvider,
      defaultModel: settings.get().defaultModel,
    })
  })

  /** 内置模型：官方服务端尚未发布时如实返回空列表 */
  route('GET', '/api/builtin/models', async (req, res) => {
    sendJson(res, 200, models.builtin())
  })

  /** 新增自定义提供商 */
  route('POST', '/api/providers', async (req, res) => {
    const body = await readBody(req)
    const provider = await models.addProvider(body)
    hub.broadcast('settings/updated', settings.redacted())
    sendJson(res, 201, { ok: true, provider, providers: models.list() })
  })

  route('DELETE', '/api/providers/:id', async (req, res, params) => {
    await models.removeProvider(params.id)
    hub.broadcast('settings/updated', settings.redacted())
    sendJson(res, 200, { ok: true, providers: models.list() })
  })

  route('POST', '/api/providers/:id/refresh', async (req, res, params) => {
    const result = await models.refresh(params.id)
    sendJson(res, result.ok ? 200 : 502, result)
  })

  route('POST', '/api/providers/:id/test', async (req, res, params) => {
    const result = await models.test(params.id)
    sendJson(res, result.ok ? 200 : 502, result)
  })

  route('PUT', '/api/providers/:id', async (req, res, params) => {
    const body = await readBody(req)
    const provider = await models.updateProvider(params.id, body)
    hub.broadcast('settings/updated', settings.redacted())
    sendJson(res, 200, { ok: true, provider, providers: models.list() })
  })

  /* ---------------- 模型（提供商下的模型列表） ---------------- */

  route('POST', '/api/providers/:id/models', async (req, res, params) => {
    const body = await readBody(req)
    const model = await models.addModel(params.id, body)
    hub.broadcast('settings/updated', settings.redacted())
    sendJson(res, 201, { ok: true, model, providers: models.list() })
  })

  route('PUT', '/api/providers/:id/models/:modelId', async (req, res, params) => {
    const body = await readBody(req)
    const model = await models.updateModel(params.id, params.modelId, body)
    hub.broadcast('settings/updated', settings.redacted())
    sendJson(res, 200, { ok: true, model, providers: models.list() })
  })

  route('DELETE', '/api/providers/:id/models/:modelId', async (req, res, params) => {
    await models.removeModel(params.id, params.modelId)
    hub.broadcast('settings/updated', settings.redacted())
    sendJson(res, 200, { ok: true, providers: models.list() })
  })

  /* ---------------- 聊天（SSE） ---------------- */

  route('POST', '/api/chat', async (req, res) => {
    const body = await readBody(req, chatBodyLimit())
    const { provider, model, messages = [], temperature, maxTokens, reasoningEffort, extraBody: extraBodyPatch, tools, toolChoice } = body
    if (!provider) return sendError(res, 400, '缺少 provider 参数')

    const abort = new AbortController()
    req.on('close', () => abort.abort(new Error('客户端断开')))

    sse(res, out => {
      out.write(`event: start\ndata: ${JSON.stringify({ provider, model, time: Date.now() })}\n\n`)
      models
        .stream({
          provider,
          model,
          messages,
          options: { temperature, maxTokens, reasoningEffort, extraBody: extraBodyPatch, tools, toolChoice },
          signal: abort.signal,
          onChunk: delta => out.write(`event: chunk\ndata: ${JSON.stringify({ delta })}\n\n`),
          onReasoning: delta => out.write(`event: reasoning\ndata: ${JSON.stringify({ delta })}\n\n`),
          onToolCall: call => out.write(`event: tool_call\ndata: ${JSON.stringify(call)}\n\n`),
        })
        .then(result => {
          out.write(
            `event: done\ndata: ${JSON.stringify({ length: result.text.length, toolCalls: result.toolCalls || [], finishReason: result.finishReason || null, usage: result.usage || null })}\n\n`,
          )
          out.end()
        })
        .catch(err => {
          out.write(`event: error\ndata: ${JSON.stringify({ message: err.message, status: err.status || 502 })}\n\n`)
          out.end()
        })
    })
  })

  /* ---------------- 会话 ---------------- */

  route('GET', '/api/sessions', async (req, res, params, url) => {
    await sessions.ready()
    const compact = url?.searchParams?.get('compact') === '1'
    sendJson(res, 200, { conversations: compact && typeof sessions.listCompact === 'function' ? sessions.listCompact() : sessions.list(), compact })
  })

  route('POST', '/api/sessions', async (req, res) => {
    await sessions.ready()
    const body = await readBody(req)
    sendJson(res, 201, sessions.create(body))
  })

  route('PUT', '/api/sessions/:id', async (req, res, params) => {
    await sessions.ready()
    const body = await readBody(req)
    const conv = sessions.update(params.id, body)
    if (!conv) return sendError(res, 404, '会话不存在')
    sendJson(res, 200, conv)
  })

  route('DELETE', '/api/sessions/:id', async (req, res, params) => {
    await sessions.ready()
    const ok = sessions.remove(params.id)
    if (!ok) return sendError(res, 404, '会话不存在')
    sendJson(res, 200, { ok: true })
  })

  route('POST', '/api/sessions/:id/messages', async (req, res, params) => {
    await sessions.ready()
    const body = await readBody(req)
    const message = sessions.addMessage(params.id, body)
    if (!message) return sendError(res, 404, '会话不存在')
    broadcastSessionChange(req, 'message', params.id, { messageId: message.id })
    sendJson(res, 201, message)
  })

  route('PUT', '/api/sessions/:id/messages/:messageId', async (req, res, params) => {
    await sessions.ready()
    const body = await readBody(req)
    const message = sessions.updateMessage(params.id, params.messageId, body)
    if (!message) return sendError(res, 404, '消息不存在')
    broadcastSessionChange(req, 'message-update', params.id, { messageId: params.messageId })
    sendJson(res, 200, message)
  })

  /** 整段替换消息（聊天记录 JSON 编辑器保存时使用） */
  route('PUT', '/api/sessions/:id/messages', async (req, res, params) => {
    await sessions.ready()
    const body = await readBody(req)
    const list = Array.isArray(body?.messages) ? body.messages : body
    const conv = sessions.replaceMessages(params.id, Array.isArray(list) ? list : [])
    if (!conv) return sendError(res, 404, '会话不存在')
    broadcastSessionChange(req, 'messages-replace', params.id, { count: conv.messages.length })
    sendJson(res, 200, { ok: true, count: conv.messages.length })
  })

  route('DELETE', '/api/sessions/:id/messages', async (req, res, params) => {
    await sessions.ready()
    const conv = sessions.clearMessages(params.id)
    if (!conv) return sendError(res, 404, '会话不存在')
    broadcastSessionChange(req, 'messages-replace', params.id, { count: 0 })
    sendJson(res, 200, { ok: true })
  })

  route('DELETE', '/api/sessions/:id/messages/:messageId', async (req, res, params) => {
    await sessions.ready()
    const ok = sessions.removeMessage(params.id, params.messageId)
    if (!ok) return sendError(res, 404, '消息不存在')
    broadcastSessionChange(req, 'message-remove', params.id, { messageId: params.messageId })
    sendJson(res, 200, { ok: true })
  })

  /* ---------------- 其他真实能力 ---------------- */

  route('GET', '/api/rss', async (req, res, params, url) => {
    const target = url.searchParams.get('url')
    if (!target) return sendError(res, 400, '缺少 url 参数')
    try {
      // net-guard：拒绝内网 / 本机 / 云元数据地址，并手动校验每一跳重定向与 DNS 解析结果。
      const result = await fetchPublicText(target, {
        headers: { 'User-Agent': 'nianfeng-rss/1.0', Accept: 'application/rss+xml, application/xml, text/xml, */*' },
        timeoutMs: 15000,
        maxBytes: 500000,
        maxRedirects: 5,
      })
      sendJson(res, 200, { ok: true, url: result.url, length: result.length, truncated: result.truncated, xml: result.text })
    } catch (err) {
      sendError(res, err?.status || 502, `拉取失败：${err?.message || err}`)
    }
  })

  route('POST', '/api/translate', async (req, res) => {
    const { text, target = 'en', provider, model } = await readBody(req)
    if (!text) return sendError(res, 400, '缺少 text')
    const result = await models.translate({ text, target, provider, model })
    sendJson(res, 200, result)
  })

  route('GET', '/api/logs', async (req, res, params, url) => {
    const limit = Math.min(Number(url.searchParams.get('limit') || 100), 500)
    sendJson(res, 200, { requests: requestLog.slice(-limit), ...hub.snapshot() })
  })

  /* ---------------- SSE 事件通道 ---------------- */

  route('GET', '/api/events', async (req, res) => {
    sse(res, out => {
      hub.add(out)
      req.on('close', () => {
        hub.remove(out)
        out.end()
      })
    })
  })

  /* ---------------- 静态资源（单端口部署模式） ---------------- */

  const serveStatic = async (req, res, pathname) => {
    if (!staticDir) return false
    if (String(pathname).includes('\0') || isSensitiveStaticPath(pathname)) return false
    // path.resolve + 目录边界校验：`public2` / `public-backup` 这类兄弟目录
    // 不能再用 startsWith(staticDir) 之前缀绕过。
    let target = resolve(staticDir, `.${pathname}`)
    if (!isInsideDir(staticDir, target)) return false
    try {
      const info = await stat(target)
      if (info.isDirectory()) {
        target = join(target, 'index.html')
        if (!isInsideDir(staticDir, target)) return false
      }
      const fileInfo = await stat(target)
      if (!fileInfo.isFile()) return false
      const body = await readFile(target)
      res.writeHead(200, {
        'Content-Type': MIME[extname(target).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      })
      res.end(body)
      return true
    } catch (_) {
      return false
    }
  }

  /* ---------------- 服务器 ---------------- */

  const server = createServer(async (req, res) => {
    setSecurityHeaders(res)
    let url
    try {
      url = new URL(req.url, 'http://localhost')
    } catch (_) {
      sendError(res, 400, '非法请求地址')
      return
    }

    const rawPathname = url.pathname
    let pathname = rawPathname
    try {
      pathname = decodeURIComponent(rawPathname)
    } catch (_) {
      /* 非法编码时保持原样 */
    }
    const started = Date.now()

    // 先做一次纯令牌状态计算：配了访问令牌且本次请求令牌有效时，
    // Host / Origin 校验直接放行——远程部署（公网 IP / 域名 / 反向代理）
    // 本来就不在默认的本机 Host 白名单里，令牌才是真正的访问凭证；
    // DNS rebinding 的恶意网页拿不到这个令牌。
    const earlyTokenState = accessToken ? checkAccessToken(req, url, rawPathname) : null
    const trustedPeer = !!accessToken && earlyTokenState?.ok === true
    // Host / Origin 双重校验：DNS rebinding 的 Host 不是本机名，恶意网页的 Origin
    // 也不在放行列表里；两者都拒绝，不进入任何业务路由。
    if ((!isAllowedHost(req.headers.host) || !isAllowedOrigin(req.headers.origin)) && !trustedPeer) {
      sendError(res, 403, '请求来源校验失败：仅允许本机或已配置的 Host / Origin')
      return
    }
    setCorsHeaders(req, res)

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    try {
      /* WebUI 访问令牌：空 token 不启用；?token= 仅用于 HTML 首屏换 Cookie，API 只认头 / Cookie。 */
      if (accessToken && !openRoute(pathname)) {
        const state = earlyTokenState || checkAccessToken(req, url, pathname)
        if (!state.ok) return sendAuthPage(res)
        // 只要本次导航带的是有效 ?token=，就跳转到去掉令牌的干净地址，
        // 即使浏览器早已有 Cookie，也不让令牌继续留在地址栏 / 历史记录里。
        if (state.queryOk) {
          const clean = new URL(req.url, 'http://localhost')
          clean.searchParams.delete('token')
          res.writeHead(302, {
            'Set-Cookie': `nianfeng_token=${encodeURIComponent(accessToken)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`,
            Location: `${clean.pathname || '/'}${clean.search}`,
            'Cache-Control': 'no-store',
            'Referrer-Policy': 'no-referrer',
          })
          res.end()
          return
        }
      }

      if (pathname.startsWith('/api/')) {
        // API 路由用原始路径匹配，路由参数在 match() 里逐个解码
        const hit = match(req.method, rawPathname)
        if (!hit) return sendError(res, 404, `接口不存在：${req.method} ${rawPathname}`)
        await hit.route.handler(req, res, hit.params, url)
        const ms = Date.now() - started
        requestLog.push({ at: Date.now(), method: req.method, path: rawPathname, status: res.statusCode, ms })
        if (requestLog.length > 500) requestLog.shift()
        // 轮询类接口（健康检查 / SSE / 日志读取自身）不写入日志，避免刷屏。
        const noisy = /^\/api\/(health|events|logs)(\/|$)/.test(rawPathname)
        if (!noisy) {
          const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : rawPathname.startsWith('/api/chat') ? 'info' : 'debug'
          ctx.logger[level](`HTTP ${req.method} ${rawPathname} → ${res.statusCode} · ${ms}ms`)
        }
        return
      }

      // 外部插件模块与静态资源：由 plugin-registry 校验目录边界后按文件返回。
      // 只服务配置过的外部插件目录，路径穿越会在 readExternalFile 里被拒绝。
      if (rawPathname.startsWith('/user-plugins/')) {
        const hit = await ctx.pluginRegistry.readExternalFile(rawPathname.slice('/user-plugins/'.length))
        if (!hit) return sendError(res, 404, '插件资源不存在')
        const body = await readFile(hit.file)
        res.writeHead(200, {
          'Content-Type': MIME[hit.ext] || 'application/octet-stream',
          'Cache-Control': 'no-store',
        })
        res.end(body)
        return
      }

      if (await serveStatic(req, res, pathname)) return

      if (pathname === '/' || pathname === '/index.html') {
        sendJson(res, 200, { name: '念风后端', hint: 'WebUI 由 start.mjs 启动的 5173 端口提供；或用 npm run serve 单端口部署。', api: '/api/health' })
        return
      }
      sendError(res, 404, 'Not Found')
    } catch (err) {
      const status = err?.status || 500
      ctx.logger.error(`[http] ${req.method} ${pathname} → ${status}`, err)
      if (!res.headersSent) sendError(res, status, err?.message || '服务器内部错误')
      else res.end()
    }
  })

  const openSockets = new Set()
  server.on('connection', socket => {
    openSockets.add(socket)
    socket.on('close', () => openSockets.delete(socket))
  })

  server.on('error', err => {
    ctx.logger.error(`HTTP 服务错误：${err.message}`)
    ctx.emit('http/error', err)
  })

  server.listen(port, host, () => {
    const addr = server.address()
    const info = { host: addr.address === '::' ? '127.0.0.1' : addr.address, port: addr.port, url: `http://127.0.0.1:${addr.port}` }
    ctx.logger.info(`API 服务已启动：${info.url}/api/health`)
    ctx.emit('http/listening', info)
  })

  ctx.provide('http', {
    server,
    port: () => server.address()?.port,
    url: () => `http://127.0.0.1:${server.address()?.port}`,
    routes: () => routes.map(r => `${r.method} ${r.regex.source}`),
    requests: () => [...requestLog],
  })

  // 通用后端插件 HTTP 扩展点：渠道 bridge.mjs 等插件自行注册 /api/... 路由。
  ctx.provide('httpApi', httpApi)

  ctx.effect(
    () => () =>
      new Promise(resolve => {
        let done = false
        let hardTimer = null
        const finish = () => {
          if (done) return
          done = true
          clearTimeout(hardTimer)
          resolve()
        }
        // 先停止接收新连接与空闲 keep-alive；SSE / 长连接在很短的宽限期后强制断开，
        // 不再依赖 1.5s 兜底计时器，也不会让 close() 被 SSE 客户端拖住。
        const forceClose = () => {
          try {
            server.closeAllConnections?.()
          } catch (_) {
            /* 旧版 Node 没有该 API */
          }
          for (const socket of openSockets) {
            try {
              socket.destroy()
            } catch (_) {
              /* ignore */
            }
          }
          finish()
        }
        server.close(() => finish())
        try {
          server.closeIdleConnections?.()
        } catch (_) {
          /* ignore */
        }
        hardTimer = setTimeout(forceClose, 250)
        hardTimer.unref?.()
      }),
  )
}
