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
import { stat } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'
import { hostname as osHostname, networkInterfaces } from 'node:os'
import { timingSafeStringEqual, isInsideDir, isSensitiveStaticPath } from '../security-utils.mjs'
import {
  ACCESS_TOKEN_AGENT_HEADER,
  ACCESS_TOKEN_COOKIE,
  ACCESS_TOKEN_HEADER,
  ACCESS_TOKEN_INTERNAL_HEADER,
  accessTokenCookie,
  buildAuthPage,
  clearAccessTokenCookie,
  createAccessTokenMatcher,
  hostNameFromConfig,
  isSecureRequest,
  normalizeHostName,
  parseCookieValue,
} from '../web-security.mjs'
import { fetchPublicText } from '../net-guard.mjs'
import { MIME, readBody, sendError, sendJson } from '../http-io.mjs'
import { serveStaticFile, isVersionedRequest } from '../static-cache.mjs'

export const name = 'http'
export const inject = ['settings', 'sessions', 'models', 'hub', 'info', 'instance', 'pluginRegistry']

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

  /** SSE 增量事件带的消息体：体积小才带，避免图片 data URL 把事件通道撑爆。 */
  const eventMessagePayload = message => {
    if (!message || typeof message !== 'object') return null
    try {
      const textSize = String(message.content ?? '').length
      const metaSize = message.meta ? JSON.stringify(message.meta).length : 0
      return textSize + metaSize <= 256 * 1024 ? message : null
    } catch (_) {
      return null
    }
  }

  const port = config.port ?? 8788
  const host = config.host ?? '127.0.0.1'
  const staticDir = config.staticDir ? resolve(config.staticDir) : null
  const accessToken = String(config.accessToken || '').trim()
  const accessTokenHash = String(config.accessTokenHash || '').trim()
  /** 服务端代聊 Worker 的内部通道：只存在于同进程的内存随机串，不写配置。 */
  const internalAgentSecret = String(config.internalAgentSecret || '').trim()
  const internalAgentMatches = candidate => !!internalAgentSecret && timingSafeStringEqual(candidate, internalAgentSecret)
  /** 读取设置页刚保存的最新摘要：让运行中更换的令牌无需等待重启即可生效。 */
  const latestAccessTokenHash = () => {
    try {
      if (typeof settings.accessTokenHash === 'function') return String(settings.accessTokenHash() || '').trim()
      return String(settings.get()?.network?.webuiTokenHash || '').trim()
    } catch (_) {
      return ''
    }
  }
  const accessTokenVerifier = createAccessTokenMatcher({
    plainToken: accessToken,
    tokenHash: accessTokenHash,
    getLatestHash: latestAccessTokenHash,
  })
  /** 是否需要校验访问令牌：启动时有令牌，或本进程运行期间用户刚设置了令牌。 */
  const isAccessTokenRequired = () => accessTokenVerifier.required()
  const accessTokenMatches = candidate => accessTokenVerifier.matches(candidate)
  const onRestart = typeof config.onRestart === 'function' ? config.onRestart : null
  const startedAt = Date.now()
  const requestLog = []

  /* ---------------- 跨站 / DNS rebinding 防护 ---------------- */

  const originList = Array.isArray(config.allowedOrigins) ? config.allowedOrigins : []
  const extraHostList = Array.isArray(config.allowedHosts) ? config.allowedHosts : []
  const wildcardBind = !host || host === '0.0.0.0' || host === '::'

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
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
  }

  /** 只在来源明确合法时回 CORS 头；绝不使用 `*`，也不给未知 Origin 留任何响应头。 */
  const setCorsHeaders = (req, res) => {
    const origin = String(req.headers.origin || '')
    res.setHeader('Vary', 'Origin')
    res.setHeader('Access-Control-Allow-Headers', `Content-Type, Authorization, ${ACCESS_TOKEN_HEADER}, ${ACCESS_TOKEN_AGENT_HEADER}, ${ACCESS_TOKEN_INTERNAL_HEADER}`)
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
    res.setHeader('Access-Control-Max-Age', '600')
    if (!origin) return
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Access-Control-Allow-Credentials', 'true')
  }

  /* ---------------- 请求工具 ---------------- */

  /* ---- WebUI 访问令牌（可选）：空 token 表示不校验 ---- */
  const requestTokens = (req, url) => ({
    query: url.searchParams.get('token') || '',
    cookie: parseCookieValue(req.headers.cookie, ACCESS_TOKEN_COOKIE) || '',
    header: String(req.headers[ACCESS_TOKEN_HEADER] || '') || String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''),
    internal: String(req.headers[ACCESS_TOKEN_INTERNAL_HEADER] || ''),
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
    const headerOk = !!tokens.header && accessTokenMatches(tokens.header)
    const cookieOk = !!tokens.cookie && accessTokenMatches(tokens.cookie)
    const queryOk = !!tokens.query && canUseQueryToken(req, pathname) && accessTokenMatches(tokens.query)
    // 内部通道必须同时带 Agent 标记：避免代聊密钥被当成通用旁路凭证。
    const internalOk =
      !!tokens.internal &&
      internalAgentMatches(tokens.internal) &&
      String(req.headers[ACCESS_TOKEN_AGENT_HEADER] || '') === '1'
    return { tokens, headerOk, cookieOk, queryOk, internalOk, ok: headerOk || cookieOk || queryOk || internalOk }
  }

  const isAuthorizedRequest = (req, url, pathname) => {
    if (!isAccessTokenRequired()) return true
    return checkAccessToken(req, url, pathname).ok
  }

  const openRoute = pathname => pathname === '/api/health' || pathname === '/api/version'
  const sendAuthPage = res => {
    res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(buildAuthPage())
  }

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
    // 热重载同一插件的 bridge 时会重新注册相同 method + pattern：
    // 直接替换旧 entry 的 handler，避免旧 handler（已 close 的数据库等）
    // 继续命中请求，出现“读取正常、写入 database is not open”这类问题。
    const existing = routes.find(item => item.method === method && item.pattern === pattern)
    if (existing) {
      existing.handler = handler
      existing.version = (Number(existing.version) || 0) + 1
      return existing
    }
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
    const entry = { method, pattern, regex, keys, handler, version: 1 }
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
      const version = entry.version
      return () => {
        // 只有当前 entry 仍然是本次注册的 handler 时才移除；
        // 已被热重载新 bridge 替换过的旧 route，dispose 不能误删新 handler。
        if (!routes.includes(entry) || entry.handler !== handler || entry.version !== version) return
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
        'preferences-sync', 'cors-origin-guard', 'ssrf-guard', 'constant-time-token', 'hashed-access-token', 'health-detail-auth', 'provider-model-discover',
        'embeddings', 'memory', 'session-message-pagination',
        ...extraCapabilities,
      ],
      authRequired: isAccessTokenRequired(),
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
    sendJson(res, 200, { version: ctx.info.version, node: process.version, authRequired: isAccessTokenRequired() }),
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
    const hasTokenField = !!body && typeof body === 'object' && !!body.network && typeof body.network === 'object' && Object.prototype.hasOwnProperty.call(body.network, 'webuiToken')
    const nextToken = hasTokenField ? String(body.network.webuiToken || '').trim() : ''
    await settings.update(body)
    hub.broadcast('settings/updated', settings.redacted())
    const headers = {}
    if (hasTokenField) {
      // 保存新令牌时顺手更新当前浏览器的 HttpOnly Cookie，避免重启后原会话被锁在门外。
      const secure = isSecureRequest(req)
      headers['Set-Cookie'] = nextToken ? accessTokenCookie(nextToken, { secure }) : clearAccessTokenCookie({ secure })
    }
    sendJson(res, 200, settings.redacted(), headers)
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

  /** 获取远端模型候选（临时列表）：不写配置、不自动启用，用户点添加后才入库。 */
  route('GET', '/api/providers/:id/models/remote', async (req, res, params) => {
    const result = await models.discover(params.id)
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

  /* ---------------- 向量模型（embedding） ---------------- */

  /** 设置页「自动获取维度」与测试向量接口都走这里；API Key 只在后端使用。 */
  route('POST', '/api/embeddings', async (req, res) => {
    const body = await readBody(req)
    const { provider, model, input } = body || {}
    try {
      const result = await models.embed({ provider, model, input })
      sendJson(res, 200, {
        ok: true,
        provider: result.provider,
        model: result.model,
        dimension: result.dimension,
        count: result.embeddings.length,
        embeddings: result.embeddings,
      })
    } catch (err) {
      sendError(res, err?.status || 502, err?.message || 'embedding 请求失败')
    }
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

  /* ---------------- 服务端代聊：WebUI ↔ 后端终端 ---------------- */

  /**
   * WebUI 不再在浏览器里执行 chat-flow / 工具 / 记忆 / 上下文；
   * 所有消息统一通过这里交给后端常驻代聊 Worker 处理。
   */
  route('POST', '/api/agent/send', async (req, res) => {
    const body = await readBody(req, 256 * 1024)
    const conversationId = String(body?.conversationId || '').trim()
    const text = String(body?.text || '')
    const images = Array.isArray(body?.images)
      ? body.images
          .map(item => (typeof item === 'string' ? item : item?.id || item?.imageId || ''))
          .map(id => String(id || '').trim())
          .filter(Boolean)
          .slice(0, 4)
      : []
    if (!conversationId || (!text.trim() && !images.length)) {
      return sendError(res, 400, '缺少 conversationId 或消息内容')
    }
    const payload = {
      id: `agent-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      conversationId,
      clientId: String(body?.clientId || '').slice(0, 120),
      // WebUI 本地回显消息的 id。Worker 落库时复用它，SSE 回传后前端按 id 合并，
      // 避免“本地一条 + 服务端一条”的重复气泡。
      messageId: String(body?.clientMessageId || '').slice(0, 160),
      text: text.slice(0, 200000),
      images,
      userId: String(body?.userId || 'web-user').slice(0, 120),
      userName: String(body?.userName || '用户').slice(0, 120),
      at: Date.now(),
    }
    hub.broadcast('agent/send', payload)
    sendJson(res, 200, { ok: true, id: payload.id, queued: true })
  })

  /** 代聊 Worker 上报轮次状态，WebUI 据此同步输入框的“生成中 / 结束”。 */
  route('POST', '/api/agent/status', async (req, res) => {
    const body = await readBody(req, 64 * 1024)
    const conversationId = String(body?.conversationId || '').trim()
    if (!conversationId) return sendError(res, 400, '缺少 conversationId')
    const rawStatus = String(body?.status || 'done')
    const status = ['start', 'done', 'error'].includes(rawStatus) ? rawStatus : 'done'
    hub.broadcast('agent/status', {
      conversationId,
      clientId: String(body?.clientId || '').slice(0, 120),
      status,
      detail: String(body?.detail || '').slice(0, 500),
      at: Date.now(),
    })
    sendJson(res, 200, { ok: true })
  })

  /** WebUI 停止生成：转成 agent/cancel，由 Worker 终止对应会话。 */
  route('POST', '/api/agent/cancel', async (req, res) => {
    const body = await readBody(req, 16 * 1024)
    const conversationId = String(body?.conversationId || '').trim()
    if (!conversationId) return sendError(res, 400, '缺少 conversationId')
    hub.broadcast('agent/cancel', { conversationId, clientId: String(body?.clientId || '').slice(0, 120), at: Date.now() })
    sendJson(res, 200, { ok: true })
  })

  /* ---------------- 会话 ---------------- */

  route('GET', '/api/sessions', async (req, res, params, url) => {
    await sessions.ready()
    const compact = url?.searchParams?.get('compact') === '1'
    sendJson(res, 200, { conversations: compact && typeof sessions.listCompact === 'function' ? sessions.listCompact() : sessions.list(), compact })
  })

  /** 单会话读取：供 session-service 在收到 sessions/changed 时只拉变化的那一个会话，
   *  避免每次消息写入都全量拉取 /api/sessions 导致大对象序列化风暴和健康检查超时。
   *  compact=1 时只返回元数据 / messageCount，消息正文走分页接口。 */
  route('GET', '/api/sessions/:id', async (req, res, params, url) => {
    await sessions.ready()
    const compact = url?.searchParams?.get('compact') === '1'
    const conv = compact && typeof sessions.getCompact === 'function' ? sessions.getCompact(params.id) : sessions.get(params.id)
    if (!conv) return sendError(res, 404, '会话不存在')
    sendJson(res, 200, { conversation: conv, compact })
  })

  /**
   * 单会话消息分页：聊天记录页 / Web 聊天窗口懒加载只取当前可见的一小段。
   *   limit=20&beforeSeq=123   → 取 seq < 123 的更早一页
   *   limit=20               → 取最新一页
   *   all=1                  → 显式导出 / 搜索 / 保存编辑器时取完整原文
   */
  route('GET', '/api/sessions/:id/messages', async (req, res, params, url) => {
    await sessions.ready()
    const limit = Math.max(1, Math.min(500, Number(url?.searchParams?.get('limit')) || 20))
    const beforeSeq = url?.searchParams?.get('beforeSeq')
    const afterSeq = url?.searchParams?.get('afterSeq')
    const all = url?.searchParams?.get('all') === '1'
    const result = sessions.listMessages(params.id, { limit, beforeSeq, afterSeq, all })
    if (!result) return sendError(res, 404, '会话不存在')
    sendJson(res, 200, result)
  })

  route('POST', '/api/sessions', async (req, res) => {
    await sessions.ready()
    const body = await readBody(req)
    const conv = sessions.create(body)
    // 会话元数据（角色人格 / 使用模型 / 名称）也是实时状态的一部分：
    // 服务端代聊 Worker 必须收到通知才会刷新自己的会话缓存，否则会一直沿用旧模型。
    if (conv?.id) broadcastSessionChange(req, 'create', conv.id, { metaUpdatedAt: conv.metaUpdatedAt })
    sendJson(res, 201, conv)
  })

  route('PUT', '/api/sessions/:id', async (req, res, params) => {
    await sessions.ready()
    const body = await readBody(req)
    const conv = sessions.update(params.id, body)
    if (!conv) return sendError(res, 404, '会话不存在')
    broadcastSessionChange(req, 'update', conv.id, { metaUpdatedAt: conv.metaUpdatedAt })
    sendJson(res, 200, conv)
  })

  route('DELETE', '/api/sessions/:id', async (req, res, params) => {
    await sessions.ready()
    const ok = sessions.remove(params.id)
    if (!ok) return sendError(res, 404, '会话不存在')
    broadcastSessionChange(req, 'remove', params.id)
    sendJson(res, 200, { ok: true })
  })

  route('POST', '/api/sessions/:id/messages', async (req, res, params) => {
    await sessions.ready()
    const body = await readBody(req)
    const message = sessions.addMessage(params.id, body)
    if (!message) return sendError(res, 404, '会话不存在')
    broadcastSessionChange(req, 'message', params.id, { messageId: message.id, message: eventMessagePayload(message) })
    sendJson(res, 201, message)
  })

  route('PUT', '/api/sessions/:id/messages/:messageId', async (req, res, params) => {
    await sessions.ready()
    const body = await readBody(req)
    const message = sessions.updateMessage(params.id, params.messageId, body)
    if (!message) return sendError(res, 404, '消息不存在')
    broadcastSessionChange(req, 'message-update', params.id, { messageId: params.messageId, message: eventMessagePayload(message) })
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
      // index.html 永远 no-cache；带 ?v= 的插件 / 资源用 immutable；
      // 其它源码走 no-cache + ETag，命中 304 后不再重新传输整包。
      const html = extname(target).toLowerCase() === '.html'
      return await serveStaticFile(req, res, target, {
        mime: MIME,
        immutable: !html && isVersionedRequest(req),
        cacheControl: html ? 'no-cache, no-store, must-revalidate' : undefined,
      })
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
    const earlyTokenState = isAccessTokenRequired() ? checkAccessToken(req, url, rawPathname) : null
    const trustedPeer = !!earlyTokenState?.ok === true
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
      /* WebUI 访问令牌：未配置时保持旧行为；?token= 仅用于 HTML 首屏换 Cookie，API 只认头 / Cookie。 */
      if (isAccessTokenRequired() && !openRoute(pathname)) {
        const state = earlyTokenState || checkAccessToken(req, url, pathname)
        if (!state.ok) return sendAuthPage(res)
        // 只要本次导航带的是有效 ?token=，就跳转到去掉令牌的干净地址，
        // 即使浏览器早已有 Cookie，也不让令牌继续留在地址栏 / 历史记录里。
        if (state.queryOk) {
          const clean = new URL(req.url, 'http://localhost')
          clean.searchParams.delete('token')
          res.writeHead(302, {
            // 写入的是用户本次提交的明文令牌；哈希模式下同样如此，浏览器 Cookie 即凭证。
            'Set-Cookie': accessTokenCookie(state.tokens.query, { secure: isSecureRequest(req) }),
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
        // 外部插件 URL 本身带 ?v=mtime，可以长期强缓存；换版本时 URL 会变化。
        await serveStaticFile(req, res, hit.file, {
          mime: MIME,
          immutable: true,
          headers: { 'Cross-Origin-Resource-Policy': 'same-origin' },
        })
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
