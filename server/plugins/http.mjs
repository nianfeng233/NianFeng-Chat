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
import { extname, join, normalize, resolve } from 'node:path'

export const name = 'http'
export const inject = ['settings', 'sessions', 'models', 'hub', 'info', 'instance', 'pluginRegistry', 'clawbot']

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

  const port = config.port ?? 8788
  const host = config.host ?? '127.0.0.1'
  const staticDir = config.staticDir ? resolve(config.staticDir) : null
  const accessToken = String(config.accessToken || '').trim()
  const onRestart = typeof config.onRestart === 'function' ? config.onRestart : null
  const startedAt = Date.now()
  const requestLog = []

  /* ---------------- 请求工具 ---------------- */

  const sendJson = (res, status, data) => {
    const body = JSON.stringify(data)
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Cache-Control': 'no-store',
    })
    res.end(body)
  }

  const sendError = (res, status, message) => sendJson(res, status, { error: { status, message } })

  /* ---- WebUI 访问令牌（可选）：空 token 表示不校验 ---- */
  const cookieValue = (req, name) => {
    for (const part of String(req.headers.cookie || '').split(';')) {
      const [key, ...rest] = part.trim().split('=')
      if (key === name) return decodeURIComponent(rest.join('='))
    }
    return ''
  }
  const requestTokens = (req, url) => ({
    query: url.searchParams.get('token') || '',
    cookie: cookieValue(req, 'nianfeng_token') || '',
    header: String(req.headers['x-nianfeng-token'] || '') || String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''),
  })
  const openRoute = pathname => pathname === '/api/health' || pathname === '/api/version'
  const sendAuthPage = res => {
    const body = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>需要访问令牌</title>
<body style="font-family:system-ui,sans-serif;padding:48px;color:#1a1d21"><h2>需要访问令牌</h2>
<p>这是一个受保护的 WebUI。请在地址后加上访问令牌：</p><pre style="padding:12px;background:#f4f6f2;border-radius:8px">http://<主机>:<端口>/?token=你的令牌</pre>
<p>验证通过后会写入本机 Cookie，后续直接访问即可。</p></body></html>`
    res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(body)
  }

  const readBody = req =>
    new Promise((resolveBody, reject) => {
      let size = 0
      const chunks = []
      req.on('data', chunk => {
        size += chunk.length
        if (size > 2 * 1024 * 1024) {
          reject(Object.assign(new Error('请求体超过 2MB 限制'), { status: 413 }))
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => {
        if (!chunks.length) return resolveBody({})
        try {
          resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        } catch (_) {
          reject(Object.assign(new Error('请求体不是合法 JSON'), { status: 400 }))
        }
      })
      req.on('error', reject)
    })

  const sse = (res, handler) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'X-Accel-Buffering': 'no',
    })
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
    routes.push({ method, regex, keys, handler })
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

  /* ---------------- 基础 ---------------- */

  route('GET', '/api/health', async (req, res) => {
    const providerList = models.list()
    sendJson(res, 200, {
      ok: true,
      name: ctx.info.name,
      version: ctx.info.version,
      uptime: Date.now() - startedAt,
      time: new Date().toISOString(),
      // 前端用它判断后端进程是否加载了最新功能（旧进程会缺少这些能力）
      capabilities: ['builtin-models', 'provider-crud', 'model-crud', 'model-params', 'data-dir', 'proxy', 'tools', 'external-plugins', 'plugin-dirs', 'webui-auth', 'system-restart', 'wechat-clawbot'],
      dataDir: settings.dataDir,
      configFile: settings.file,
      providers: providerList.map(p => ({ id: p.id, type: p.type, configured: p.configured, status: p.status, models: p.models.length })),
      defaultProvider: settings.get().defaultProvider,
      defaultModel: settings.get().defaultModel,
      sessions: { count: sessions.count(), messages: sessions.totalMessages() },
      sseClients: hub.count(),
      runtime: 'cordis v4',
    })
  })

  route('GET', '/api/version', async (req, res) => sendJson(res, 200, { version: ctx.info.version, node: process.version }))

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
    const body = await readBody(req)
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

  route('GET', '/api/sessions', async (req, res) => {
    await sessions.ready()
    sendJson(res, 200, { conversations: sessions.list() })
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
    sendJson(res, 201, message)
  })

  route('PUT', '/api/sessions/:id/messages/:messageId', async (req, res, params) => {
    await sessions.ready()
    const body = await readBody(req)
    const message = sessions.updateMessage(params.id, params.messageId, body)
    if (!message) return sendError(res, 404, '消息不存在')
    sendJson(res, 200, message)
  })

  /* ---------------- 其他真实能力 ---------------- */

  route('GET', '/api/rss', async (req, res, params, url) => {
    const target = url.searchParams.get('url')
    if (!target) return sendError(res, 400, '缺少 url 参数')
    if (!/^https?:\/\//i.test(target)) return sendError(res, 400, '仅支持 http(s) 地址')
    try {
      const response = await fetch(target, {
        headers: { 'User-Agent': 'nianfeng-rss/1.0', Accept: 'application/rss+xml, application/xml, text/xml, */*' },
        signal: AbortSignal.timeout(15000),
      })
      if (!response.ok) return sendError(res, 502, `拉取失败：HTTP ${response.status}`)
      const text = await response.text()
      sendJson(res, 200, { ok: true, url: target, length: text.length, xml: text.slice(0, 500000) })
    } catch (err) {
      sendError(res, 502, `拉取失败：${err.message}`)
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

  /* ---------------- 微信 Clawbot 渠道后端桥 ---------------- */

  /**
   * 这些路由只做参数整理与错误包装，真实协议在同目录
   * server/plugins/../plugins/channels/wechat-clawbot/bridge.mjs 中实现。
   */
  const withClawbot = async (res, fn) => {
    try {
      const bridge = ctx.clawbot
      if (!bridge) return sendError(res, 503, '微信 Clawbot 后端桥未加载，请重启念风')
      return sendJson(res, 200, await fn(bridge))
    } catch (err) {
      return sendError(res, Number(err?.status) || 502, err?.message || String(err))
    }
  }

  route('GET', '/api/clawbot/status', async (req, res, params, url) =>
    withClawbot(res, bridge =>
      url.searchParams.get('all') === 'true'
        ? bridge.status({ all: true })
        : bridge.status({ channelId: url.searchParams.get('channelId') || '' }),
    ),
  )

  route('POST', '/api/clawbot/login/start', async (req, res) => {
    const body = await readBody(req)
    return withClawbot(res, bridge => bridge.startLogin({ channelId: body.channelId }))
  })

  route('GET', '/api/clawbot/login/status', async (req, res, params, url) =>
    withClawbot(res, bridge => bridge.loginStatus({ channelId: url.searchParams.get('channelId') || '' })),
  )

  route('POST', '/api/clawbot/logout', async (req, res) => {
    const body = await readBody(req)
    return withClawbot(res, bridge => bridge.logout({ channelId: body.channelId }))
  })

  route('POST', '/api/clawbot/send', async (req, res) => {
    const body = await readBody(req)
    return withClawbot(res, bridge =>
      bridge.sendText({
        channelId: body.channelId,
        toUserId: body.toUserId,
        text: body.text,
        contextToken: body.contextToken,
      }),
    )
  })

  route('POST', '/api/clawbot/typing/start', async (req, res) => {
    const body = await readBody(req)
    return withClawbot(res, bridge =>
      bridge.startTyping({ channelId: body.channelId, toUserId: body.toUserId, contextToken: body.contextToken }),
    )
  })

  route('POST', '/api/clawbot/typing/stop', async (req, res) => {
    const body = await readBody(req)
    return withClawbot(res, bridge =>
      bridge.stopTyping({ channelId: body.channelId, toUserId: body.toUserId, contextToken: body.contextToken }),
    )
  })

  route('GET', '/api/clawbot/inbox', async (req, res, params, url) =>
    withClawbot(res, bridge => bridge.inbox({ channelId: url.searchParams.get('channelId') || '' })),
  )

  route('POST', '/api/clawbot/inbox/ack', async (req, res) => {
    const body = await readBody(req)
    return withClawbot(res, bridge => bridge.ackInbox({ channelId: body.channelId, ids: body.ids }))
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
    let target = normalize(join(staticDir, pathname))
    if (!target.startsWith(staticDir)) return false
    try {
      const info = await stat(target)
      if (info.isDirectory()) target = join(target, 'index.html')
      const body = await readFile(target)
      res.writeHead(200, {
        'Content-Type': MIME[extname(target).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
      })
      res.end(body)
      return true
    } catch (_) {
      return false
    }
  }

  /* ---------------- 服务器 ---------------- */

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
    const rawPathname = url.pathname
    let pathname = rawPathname
    try {
      pathname = decodeURIComponent(rawPathname)
    } catch (_) {
      /* 非法编码时保持原样 */
    }
    const started = Date.now()

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Max-Age': '600',
      })
      res.end()
      return
    }

    try {
      /* WebUI 访问令牌：空 token 不启用；带 ?token= 的浏览器导航换 Cookie 后跳转；health/version 免校验 */
      if (accessToken && !openRoute(pathname)) {
        const tokens = requestTokens(req, url)
        const ok = tokens.query === accessToken || tokens.cookie === accessToken || tokens.header === accessToken
        if (!ok) return sendAuthPage(res)
        const wantsHtml = String(req.headers.accept || '').includes('text/html')
        if (tokens.query === accessToken && tokens.cookie !== accessToken && req.method === 'GET' && wantsHtml) {
          res.writeHead(302, {
            'Set-Cookie': `nianfeng_token=${encodeURIComponent(accessToken)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`,
            Location: pathname || '/',
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
        requestLog.push({ at: Date.now(), method: req.method, path: rawPathname, status: res.statusCode, ms: Date.now() - started })
        if (requestLog.length > 500) requestLog.shift()
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
          'Access-Control-Allow-Origin': '*',
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

  ctx.effect(
    () => () =>
      new Promise(resolve => {
        server.close(() => resolve())
        setTimeout(resolve, 1500)
      }),
  )
}
