/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * 念风启动脚本：一条命令同时拉起「后端 + WebUI」，并自动打开浏览器。
 *
 *   node start.mjs              # 后端 8788 + WebUI 5173（/api 反向代理到后端）
 *   node start.mjs --serve      # 单端口模式：后端直接托管 WebUI（5173）
 *   node start.mjs --no-open    # 不自动打开浏览器
 *
 * 所有服务都跑在同一个 Node 进程里，Ctrl+C 一次性退出。
 */
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { Worker } from 'node:worker_threads'
import { extname, join, resolve } from 'node:path'
import { hostname as osHostname, networkInterfaces } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { startBackend } from './server/index.mjs'
import { resolveDataDir } from './server/data-dir.mjs'
import { resolveStartupAccessToken } from './server/access-token.mjs'
import { ensurePortsFree } from './server/port-utils.mjs'
import { isInsideDir, isSensitiveStaticPath, assertSafeProductionBinding } from './server/security-utils.mjs'
import {
  ACCESS_TOKEN_COOKIE,
  accessTokenCookie,
  buildAuthPage,
  createAccessTokenMatcher,
  hostNameFromConfig,
  isLoopbackHost,
  isSecureRequest,
  normalizeHostName,
  parseCookieValue,
} from './server/web-security.mjs'
import { MIME } from './server/http-io.mjs'
import { serveStaticFile, isVersionedRequest } from './server/static-cache.mjs'
import { printFreeSoftwareNotice } from './src/shared/project-info.mjs'

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)))
const args = new Set(process.argv.slice(2))
const singlePort = args.has('--serve') || args.has('--single-port')
const noOpenEnv = String(process.env.NIANFENG_NO_OPEN || process.env.FENGYU_NO_OPEN || '').trim()
const autoOpen = !args.has('--no-open') && !/^(1|true|yes|on)$/i.test(noOpenEnv)
// 服务端常驻代聊：默认开启（可用 --no-agent 或 NIANFENG_HEADLESS_AGENT=0 关闭）。
// 它用 Node DOM 垫片运行与浏览器相同的前端插件，保证关掉 WebUI 后消息仍会被处理。
const headlessAgentEnabled = !args.has('--no-agent') && !/^(0|false|no|off)$/i.test(String(process.env.NIANFENG_HEADLESS_AGENT || '').trim())

function banner(lines) {
  const width = Math.max(...lines.map(l => [...l].reduce((n, ch) => n + (ch.charCodeAt(0) > 255 ? 2 : 1), 0)))
  console.log('')
  console.log('  ╭' + '─'.repeat(width + 2) + '╮')
  for (const line of lines) {
    const visual = [...line].reduce((n, ch) => n + (ch.charCodeAt(0) > 255 ? 2 : 1), 0)
    console.log('  │ ' + line + ' '.repeat(Math.max(0, width - visual)) + ' │')
  }
  console.log('  ╰' + '─'.repeat(width + 2) + '╯')
  console.log('')
}

/** 供后端 Origin 放行：本机常见主机名 + 当前机器网卡地址 + hostname。 */
function webuiOriginList(host, port) {
  const names = new Set(['127.0.0.1', 'localhost', '[::1]'])
  if (host && host !== '0.0.0.0' && host !== '::') names.add(host)
  try {
    for (const entries of Object.values(networkInterfaces())) {
      for (const entry of entries || []) {
        if (entry?.address) names.add(entry.address.includes(':') ? `[${entry.address}]` : entry.address)
      }
    }
  } catch (_) {
    /* ignore */
  }
  const hostname = osHostname()
  if (hostname) names.add(hostname)
  return [...names]
    .filter(Boolean)
    .map(name => {
      const text = String(name)
      const formatted = text.includes(':') && !text.startsWith('[') ? `[${text}]` : text
      return `http://${formatted}:${port}`
    })
}

/** WebUI 静态服务器 + /api 反向代理（把 SSE 也原样透传） */
function createWebServer({ backendPort, accessToken = '', accessTokenHash = '', getAccessTokenHash = null, host = '127.0.0.1', allowedHosts = [] }) {
  const accessTokenVerifier = createAccessTokenMatcher({
    plainToken: accessToken,
    tokenHash: accessTokenHash,
    getLatestHash: getAccessTokenHash,
  })
  const isTokenRequired = () => accessTokenVerifier.required()
  const tokenMatches = candidate => accessTokenVerifier.matches(candidate)
  const wildcardBind = !host || host === '0.0.0.0' || host === '::'
  const hostNames = new Set(
    ['localhost', '127.0.0.1', '[::1]', host, osHostname(), ...allowedHosts]
      .map(hostNameFromConfig)
      .filter(Boolean),
  )
  try {
    for (const entries of Object.values(networkInterfaces())) {
      for (const entry of entries || []) {
        if (entry?.address) hostNames.add(hostNameFromConfig(entry.address))
      }
    }
  } catch (_) {
    /* ignore */
  }
  const isAllowedHost = rawHost => {
    if (!rawHost) return true
    if (wildcardBind) return true
    try {
      return hostNames.has(normalizeHostName(new URL(`http://${String(rawHost).trim()}`).hostname))
    } catch (_) {
      return false
    }
  }

  /**
   * WebUI 边缘 Origin 校验（代理转发前先拦一层）：
   *   - 没有 Origin（curl / 同源静态请求）放行；
   *   - Origin 与请求 Host 主机名一致（同源 / 反代同一域名）放行；
   *   - 其余跨站 Origin 一律拒绝，避免代理层替恶意页面绕过后端校验。
   * 注意：令牌只用于 Host 信任，不作为跨站 Origin 的放行条件。
   */
  const isAllowedOrigin = req => {
    const origin = String(req.headers.origin || '').trim()
    if (!origin) return true
    if (origin === 'null') return false
    try {
      const originHost = normalizeHostName(new URL(origin).hostname)
      const requestHost = normalizeHostName(new URL(`http://${String(req.headers.host || '')}`).hostname)
      return !!originHost && !!requestHost && originHost === requestHost
    } catch (_) {
      return false
    }
  }

  /**
   * 计算请求携带的令牌状态（纯计算，不写 Cookie / 不改响应）。
   * `?token=` 只允许用于首次 HTML 导航；API 只认 Cookie / 请求头。
   */
  const evaluateToken = (req, url, pathname) => {
    const queryToken = url.searchParams.get('token') || ''
    const cookieToken = parseCookieValue(req.headers.cookie, ACCESS_TOKEN_COOKIE)
    const headerToken =
      String(req.headers['x-nianfeng-token'] || '') || String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')
    const headerOk = !!headerToken && tokenMatches(headerToken)
    const cookieOk = !!cookieToken && tokenMatches(cookieToken)
    const canUseQuery =
      req.method === 'GET' &&
      !pathname.startsWith('/api/') &&
      !pathname.startsWith('/user-plugins/') &&
      String(req.headers.accept || '').includes('text/html')
    const queryOk = canUseQuery && !!queryToken && tokenMatches(queryToken)
    return { headerOk, cookieOk, queryOk, ok: headerOk || cookieOk || queryOk }
  }

  const setSecurityHeaders = res => {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('X-Frame-Options', 'DENY')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
  }

  return createServer(async (req, res) => {
    setSecurityHeaders(res)
    let url
    try {
      url = new URL(req.url, 'http://localhost')
    } catch (_) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('400 Bad Request')
      return
    }
    let pathname = url.pathname
    try {
      pathname = decodeURIComponent(pathname)
    } catch (_) {
      /* 非法编码时保持原样 */
    }

    // 配了访问令牌且令牌有效时，Host 校验放行：
    // 远程部署（公网 IP / 域名 / 反向代理）通常不在默认的本机 Host 列表里，
    // 但令牌本身已是可信凭证；DNS rebinding 的恶意网页拿不到这个令牌。
    const tokenState = isTokenRequired() ? evaluateToken(req, url, pathname) : null
    if (!isAllowedHost(req.headers.host) && !tokenState?.ok) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }).end('403 Forbidden')
      return
    }
    if (!isAllowedOrigin(req)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }).end('403 Forbidden')
      return
    }

    // 访问令牌：health / version 放行（供宿主探活）。
    // ?token= 只允许用于首次 HTML 导航换 Cookie；API 请求只认 Cookie / 请求头。
    if (isTokenRequired() && req.method !== 'OPTIONS' && pathname !== '/api/health' && pathname !== '/api/version') {
      const state = tokenState || evaluateToken(req, url, pathname)
      if (!state.ok) {
        res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(buildAuthPage())
        return
      }
      // 只要本次导航带的是有效 ?token=，就跳转到去掉令牌的干净地址：
      // 即使浏览器早已有 Cookie，也不能把令牌继续留在地址栏 / 历史记录里。
      if (state.queryOk) {
        const clean = new URL(req.url, 'http://localhost')
        clean.searchParams.delete('token')
        res.writeHead(302, {
          // 写入用户本次提交的明文令牌；Cookie 本身即后续凭证。
          'Set-Cookie': accessTokenCookie(url.searchParams.get('token') || '', { secure: isSecureRequest(req) }),
          Location: `${clean.pathname || '/'}${clean.search}`,
          'Cache-Control': 'no-store',
          'Referrer-Policy': 'no-referrer',
        })
        res.end()
        return
      }
    }

    // 1) API 代理（外部插件模块也由后端提供，避免开发模式下 5173 找不到）
    if (pathname.startsWith('/api/') || pathname.startsWith('/user-plugins/')) {
      const proxyReq = (await import('node:http')).request(
        {
          host: '127.0.0.1',
          port: backendPort,
          path: req.url,
          method: req.method,
          // WebUI 代理层已经完成 Host / Origin 校验，这里统一把 Origin 收敛到
          // 本机后端地址：后端只信任本机代理，否则远程 IP / 域名访问会因为
          // Origin 不在后端白名单里被 403（“请求来源校验失败”的根因）。
          headers: (() => {
            const headers = { ...req.headers, host: `127.0.0.1:${backendPort}` }
            if (headers.origin) headers.origin = `http://127.0.0.1:${backendPort}`
            delete headers.referer
            return headers
          })(),
        },
        proxyRes => {
          res.writeHead(proxyRes.statusCode || 502, proxyRes.headers)
          proxyRes.pipe(res)
        },
      )
      proxyReq.on('error', err => {
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: { status: 502, message: `后端不可用：${err.message}` } }))
        } else res.end()
      })
      req.pipe(proxyReq)
      return
    }

    // 2) 静态资源；resolve + 目录边界校验，阻止 `..` 与 `public-backup` 之类兄弟目录越界；
    //    同时不把 user_data / .git / config.json 等本机数据当静态文件发出去。
    if (String(pathname).includes('\0') || isSensitiveStaticPath(pathname)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found')
      return
    }
    let target = resolve(ROOT, `.${pathname}`)
    if (!isInsideDir(ROOT, target)) {
      res.writeHead(403).end('403 Forbidden')
      return
    }
    try {
      const info = await stat(target)
      if (info.isDirectory()) {
        target = join(target, 'index.html')
        if (!isInsideDir(ROOT, target)) {
          res.writeHead(403).end('403 Forbidden')
          return
        }
      }
      const fileInfo = await stat(target)
      if (!fileInfo.isFile()) throw Object.assign(new Error('not a file'), { code: 'ENOENT' })
      const html = extname(target).toLowerCase() === '.html'
      // 带 ?v= 的插件 / 资源强缓存；其它源码 ETag 304；index.html 永远回源。
      await serveStaticFile(req, res, target, {
        mime: MIME,
        immutable: !html && isVersionedRequest(req),
        cacheControl: html ? 'no-cache, no-store, must-revalidate' : undefined,
      })
    } catch (_) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found')
    }
  })
}

export { createWebServer, webuiOriginList }

function openBrowser(url) {
  if (!autoOpen) return
  const platform = process.platform
  try {
    const child =
      platform === 'win32'
        ? spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true })
        : platform === 'darwin'
          ? spawn('open', [url], { detached: true, stdio: 'ignore' })
          : spawn('xdg-open', [url], { detached: true, stdio: 'ignore' })
    child.on('error', () => {})
    child.unref()
  } catch (_) {
    // 打不开浏览器不是致命错误，打印地址即可
  }
}

/** 把崩溃信息写到 user_data/logs/error.log，便于排查偶发问题（而不是只弹一个系统窗口） */
async function logCrash(kind, error) {
  const line = `[${new Date().toISOString()}] ${kind}: ${error?.stack || error?.message || error}\n`
  try {
    const dir = join(resolve(fileURLToPath(new URL('.', import.meta.url))), 'user_data', 'logs')
    await (await import('node:fs/promises')).mkdir(dir, { recursive: true })
    await (await import('node:fs/promises')).appendFile(join(dir, 'error.log'), line, 'utf8')
  } catch (_) {
    /* 日志失败不影响主流程 */
  }
  console.error(line.trim())
}

async function main() {
  // 开源项目的免费声明：在终端输出最开头打印，先于端口 / 令牌 / 服务信息。
  printFreeSoftwareNotice()

  const backendPort = Number(process.env.BACKEND_PORT || 8788)

  // WebUI 监听地址/端口/访问令牌来自数据目录 config.json 的 network 段。
  // 优先级：环境变量 > config.json > 默认值；设置页保存后按提示重启生效。
  const dataDirEnv = process.env.NIANFENG_DATA_DIR || process.env.FENGYU_DATA_DIR
  const paths = dataDirEnv
    ? { dataDir: resolve(dataDirEnv) }
    : await resolveDataDir(ROOT)
  let network = {}
  try {
    network = JSON.parse(await readFile(join(paths.dataDir, 'config.json'), 'utf8'))?.network || {}
  } catch (_) {
    network = {}
  }
  const webuiHost = String(process.env.WEBUI_HOST || network.webuiHost || '127.0.0.1').trim() || '127.0.0.1'
  const webPort = Number(process.env.WEB_PORT || network.webuiPort || process.env.PORT || (singlePort ? 5173 : 5173))
  const homeEnv = process.env.NIANFENG_HOME_DIR || process.env.FENGYU_HOME_DIR
  const externalBind = !isLoopbackHost(webuiHost)
  // 访问令牌：首次运行生成随机值并只打印一次；后续只认 config.json 里的摘要。
  // 如果监听的是非本机地址但历史上一直没设过令牌，也必须补一个随机令牌，
  // 否则公网 IP / 局域网可以直接打开控制台。桌面壳没有可见终端，跳过自动生成，
  // 避免 WebView 拿不到明文而白屏；桌面版开放监听请自行设置令牌。
  const access = await resolveStartupAccessToken(paths.dataDir, {
    generateIfMissing: !homeEnv,
    generateIfUnset: !homeEnv && externalBind,
  })
  const accessToken = access.token
  const accessTokenHash = access.hash
  // 服务端代聊 Worker 与后端同进程启动，不知道摘要对应的明文；
  // 用只在内存里存在的随机 internal secret 给它开一条受控通道，绝不落盘。
  const agentInternalSecret = randomBytes(32).toString('base64url')
  // 生产环境门禁：NODE_ENV=production 且监听 0.0.0.0/:: 时必须已有访问令牌。
  assertSafeProductionBinding({ host: webuiHost, accessTokenRequired: access.required })

  if (access.generated) {
    banner([
      access.firstRun
        ? '首次运行 · 随机访问令牌（只显示这一次，请立即复制）'
        : '检测到开放监听但未配置令牌 · 已自动生成访问令牌（只显示这一次，请立即复制）',
      access.token,
      '后续可在「设置 → 网络」里改成自己的访问令牌（后端只保存摘要，不保存明文）',
    ])
  } else if (access.migrated) {
    console.log('  访问令牌已从旧版明文迁移为盐化摘要，明文已从配置文件移除。')
  } else if (access.required && !accessToken) {
    console.log('  访问令牌已启用（配置中只有摘要）：浏览器没有有效 Cookie 时会显示令牌输入页。')
  } else if (!access.required && externalBind) {
    console.warn('  警告：当前监听非本机地址且未配置访问令牌；建议到「设置 → 网络」设置访问令牌后再开放访问。')
  }

  banner(singlePort ? ['念风chat · 单端口模式', '后端同时托管 WebUI 与 API'] : ['念风chat · 开发模式', '后端 + WebUI 一起启动'])

  // 重复双击启动时：如果端口上是旧的念风实例，自动关掉再启动；是别的程序则明确报错
  await ensurePortsFree(singlePort ? [webPort] : [backendPort, webPort], { autoStop: true, log: console })

  let backend = null
  let web = null
  let restarting = false
  let agentWorker = null
  let agentCapabilityDispose = null
  let agentReady = false
  let agentLastHeartbeat = 0
  let agentWatchdogTimer = null
  let shuttingDown = false

  const closeWebServer = () =>
    new Promise(resolve => {
      if (!web) return resolve()
      let done = false
      let timer = null
      const finish = () => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve()
      }
      web.close(() => finish())
      try {
        web.closeIdleConnections?.()
      } catch (_) {
        /* ignore */
      }
      timer = setTimeout(() => {
        try {
          web.closeAllConnections?.()
        } catch (_) {
          /* 旧版 Node 没有该 API */
        }
        finish()
      }, 250)
      timer.unref?.()
    })

  /** 一键重启：关闭当前服务后以相同参数拉起新进程（设置页保存监听地址后使用） */
  const restart = async () => {
    if (restarting) return
    restarting = true
    shuttingDown = true
    stopHeadlessAgent()
    console.log('正在重启念风…')
    try {
      await closeWebServer()
    } catch (_) {
      /* ignore */
    }
    await backend?.close?.().catch(() => {})
    const child = spawn(process.execPath, process.argv.slice(1), {
      cwd: ROOT,
      detached: true,
      stdio: 'ignore',
      env: process.env,
    })
    child.unref()
    process.exit(0)
  }

  /** server-agent 能力只在 Worker 真正 ready 后才上报，避免 WebUI 误以为后端能处理入站。 */
  const setAgentCapability = () => {
    const registerCapability = backend?.ctx?.httpApi?.registerCapability
    if (typeof registerCapability !== 'function' || agentCapabilityDispose) return
    agentCapabilityDispose = registerCapability('server-agent')
  }

  const clearAgentCapability = () => {
    try {
      agentCapabilityDispose?.()
    } catch (_) {
      /* ignore */
    }
    agentCapabilityDispose = null
  }

  const stopAgentWatchdog = () => {
    if (agentWatchdogTimer) {
      clearInterval(agentWatchdogTimer)
      agentWatchdogTimer = null
    }
  }

  /**
   * Worker 心跳看门狗：ready 后每 15 秒应有一次 heartbeat；
   * 超过 45 秒没收到就撤销 server-agent，让 WebUI 重新接管入站消息。
   * 这样服务端代聊 Worker 卡死时，NapCat/QQ 消息不会只躺在后端 inbox 里没人写。
   */
  const startAgentWatchdog = () => {
    stopAgentWatchdog()
    agentLastHeartbeat = Date.now()
    agentWatchdogTimer = setInterval(() => {
      if (!agentWorker || !agentReady) return
      if (Date.now() - agentLastHeartbeat < 45_000) return
      console.warn('服务端代聊心跳超时，暂时撤销 server-agent 能力，让 WebUI 接管入站消息')
      clearAgentCapability()
      try {
        agentWorker.terminate()?.catch?.(() => {})
      } catch (_) {
        /* ignore */
      }
    }, 5_000)
    agentWatchdogTimer.unref?.()
  }

  /** 关闭服务端代聊 Worker；同时撤销 server-agent 能力，让 WebUI 可以接管。 */
  const stopHeadlessAgent = () => {
    clearAgentCapability()
    stopAgentWatchdog()
    agentReady = false
    agentLastHeartbeat = 0
    const worker = agentWorker
    agentWorker = null
    if (!worker) return
    try {
      const result = worker.terminate()
      result?.catch?.(() => {})
    } catch (_) {
      /* ignore */
    }
  }

  /** 启动服务端常驻代聊：隐藏的 Node 前端运行时，不依赖浏览器窗口。 */
  const startHeadlessAgent = () => {
    if (!headlessAgentEnabled || shuttingDown || agentWorker) return
    try {
      const worker = new Worker(new URL('./src/headless/runtime.mjs', import.meta.url), {
        workerData: {
          backendUrl: `${backend.url}/api`,
          accessToken,
          internalSecret: agentInternalSecret,
        },
      })
      agentWorker = worker
      agentReady = false
      worker.once('error', err => {
        console.error('服务端代聊 Worker 异常：', err?.stack || err?.message || err)
      })
      worker.on('message', message => {
        if (message?.type === 'ready') {
          agentReady = true
          agentLastHeartbeat = Date.now()
          setAgentCapability()
          startAgentWatchdog()
          console.log(
            `[headless] 服务端代聊已就绪 · 插件 ${message.plugins}/${message.total} · chat-flow=${message.flowMode} · sessions=${message.sessionsSource || 'unknown'}`,
          )
          if (message.sessionsSource && message.sessionsSource !== 'server') {
            console.warn(`[headless] 服务端代聊未同步到后端会话（source=${message.sessionsSource}）：${message.sessionsError || '未知原因'}`)
          }
        } else if (message?.type === 'heartbeat') {
          agentLastHeartbeat = Date.now()
        }
      })
      worker.once('exit', code => {
        // 被 stopHeadlessAgent / reloadHeadlessAgent 主动替换时直接返回：
        // 新 Worker 已经持有新的 capability，旧 Worker 不能再清理当前引用。
        if (agentWorker !== worker) return
        agentWorker = null
        agentReady = false
        agentLastHeartbeat = 0
        stopAgentWatchdog()
        clearAgentCapability()
        if (shuttingDown || !headlessAgentEnabled) return
        console.warn(`服务端代聊 Worker 退出（code=${code ?? 'null'}），2 秒后重启`)
        const timer = setTimeout(() => {
          if (!shuttingDown) startHeadlessAgent()
        }, 2000)
        timer.unref?.()
      })
    } catch (err) {
      console.error('无法启动服务端代聊：', err?.message || err)
      clearAgentCapability()
      stopAgentWatchdog()
      agentReady = false
    }
  }

  let agentReloadTimer = null
  /**
   * 外部插件清单变化时通知服务端代聊 Worker 热同步，而不是终止 / 重启它。
   * 旧实现会重启 Worker，导致 NapCat / QQ 等渠道在几秒内无法处理消息；
   * 现在 Worker 内部走 App.syncEntries()，工具与设置无中断更新。
   */
  const reloadHeadlessAgent = reason => {
    if (!headlessAgentEnabled || shuttingDown) return
    if (agentReloadTimer) clearTimeout(agentReloadTimer)
    agentReloadTimer = setTimeout(() => {
      agentReloadTimer = null
      if (shuttingDown) return
      if (!agentWorker) {
        startHeadlessAgent()
        return
      }
      try {
        agentWorker.postMessage({ type: 'plugins-changed', payload: { action: reason || 'changed' } })
        console.log(`[plugins] 插件变化（${reason || 'changed'}），已通知服务端代聊热同步`)
      } catch (err) {
        console.warn(`[plugins] 通知服务端代聊失败，改用重启兜底：${err?.message || err}`)
        stopHeadlessAgent()
        startHeadlessAgent()
      }
    }, 300)
    agentReloadTimer.unref?.()
  }

  /**
   * 桌面壳 / 部署宿主依赖 HOME/.webui-port 做导航。
   * 访问令牌明文不再写文件；旧版本遗留的 .webui-token 会在这里清理掉，
   * 避免升级后还在磁盘上留明文。
   */
  const writeRuntimeHints = async actualPort => {
    if (!homeEnv || !(Number(actualPort) > 0)) return
    try {
      const dir = resolve(homeEnv)
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, '.webui-port'), String(actualPort), 'utf8')
      await rm(join(dir, '.webui-token'), { force: true })
    } catch (err) {
      console.warn(`写入运行时端口文件 / 清理旧令牌文件失败：${err?.message || err}`)
    }
  }
  backend = await startBackend({
    port: singlePort ? webPort : backendPort,
    host: singlePort ? webuiHost : '127.0.0.1',
    dataDir: process.env.NIANFENG_DATA_DIR || process.env.FENGYU_DATA_DIR || undefined,
    staticDir: singlePort ? '.' : null,
    accessToken,
    accessTokenHash,
    internalAgentSecret: agentInternalSecret,
    onRestart: restart,
    onPluginsChanged: payload => reloadHeadlessAgent(payload?.action),
    // 开发模式下 WebUI 与 API 不同端口，需把 WebUI 的 Origin 显式放行给后端；
    // 单端口模式也会包含同一端口，便于本机 IP / hostname 访问。
    allowedOrigins: webuiOriginList(webuiHost, webPort),
  })
  startHeadlessAgent()
  if (singlePort) await writeRuntimeHints(backend.port)
  let webUrl = backend.url
  if (!singlePort) {
    web = createWebServer({
      backendPort: backend.port,
      accessToken,
      accessTokenHash,
      getAccessTokenHash: () => {
        try {
          if (typeof backend.ctx.settings.accessTokenHash === 'function') return backend.ctx.settings.accessTokenHash()
          return backend.ctx.settings.get().network.webuiTokenHash || ''
        } catch (_) {
          return ''
        }
      },
      host: webuiHost,
      allowedHosts: [
        ...String(process.env.NIANFENG_ALLOWED_HOSTS || '')
          .split(',')
          .map(value => value.trim())
          .filter(Boolean),
        ...String(process.env.FENGYU_ALLOWED_HOSTS || '')
          .split(',')
          .map(value => value.trim())
          .filter(Boolean),
      ],
    })
    await new Promise((resolve, reject) => {
      web.once('error', err =>
        reject(new Error(err?.code === 'EADDRINUSE' ? `WebUI 端口 ${webPort} 已被占用，请关闭占用程序或改用其他端口（WEB_PORT）` : err.message)),
      )
      web.listen(webPort, webuiHost, resolve)
    })
    await writeRuntimeHints(webPort)
    // 明文只存在于内存：生成 / 环境变量 / 旧配置迁移时可以带 token 自动登录；
    // 哈希模式没有明文，靠浏览器已有 Cookie，失效时走令牌输入页。
    webUrl = `http://${webuiHost === '0.0.0.0' ? '127.0.0.1' : webuiHost}:${webPort}` + (accessToken ? `/?token=${encodeURIComponent(accessToken)}` : '')
  }

  banner([
    `WebUI : ${webUrl}`,
    `API   : ${backend.url}/api/health`,
    `数据  : ${backend.dataDir}`,
    singlePort ? '模式  : 单端口（可直接分享给同机使用）' : `代理  : ${webUrl}/api → 127.0.0.1:${backend.port}`,
    headlessAgentEnabled ? '代聊  : 服务端常驻（关闭 WebUI 也会继续回复）' : '代聊  : 已关闭（仅 WebUI 运行时）',
    '停止  : 按 Ctrl+C',
  ])

  openBrowser(webUrl)

  const shutdown = async () => {
    shuttingDown = true
    stopHeadlessAgent()
    console.log('\n正在关闭念风…')
    try {
      await closeWebServer()
    } catch (_) {
      /* ignore */
    }
    await backend.close().catch(() => {})
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  // 崩溃兜底：写日志 + 友好退出，避免给用户一个无信息的系统弹窗
  process.on('uncaughtException', async err => {
    await logCrash('uncaughtException', err)
    console.error('\n念风遇到未预期错误，已写入 user_data/logs/error.log')
    await shutdown()
  })
  process.on('unhandledRejection', async reason => {
    await logCrash('unhandledRejection', reason)
    console.error('\n念风遇到未处理的异步错误，已写入 user_data/logs/error.log')
  })
}

const isDirectRun = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

if (isDirectRun) main().catch(err => {
  console.error('\n启动失败：', err)
  process.exit(1)
})


