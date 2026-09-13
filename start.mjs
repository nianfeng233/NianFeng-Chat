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
import { readFile, stat } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { extname, join, resolve } from 'node:path'
import { hostname as osHostname, networkInterfaces } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { startBackend } from './server/index.mjs'
import { resolveDataDir } from './server/data-dir.mjs'
import { ensurePortsFree } from './server/port-utils.mjs'
import { timingSafeStringEqual, isInsideDir, isSensitiveStaticPath } from './server/security-utils.mjs'

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)))
const args = new Set(process.argv.slice(2))
const singlePort = args.has('--serve') || args.has('--single-port')
const noOpenEnv = String(process.env.NIANFENG_NO_OPEN || process.env.FENGYU_NO_OPEN || '').trim()
const autoOpen = !args.has('--no-open') && !/^(1|true|yes|on)$/i.test(noOpenEnv)

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
function createWebServer({ backendPort, accessToken = '', host = '127.0.0.1', allowedHosts = [] }) {
  const token = String(accessToken || '').trim()
  const wildcardBind = !host || host === '0.0.0.0' || host === '::'
  const normalizeHostName = value => {
    let name = String(value || '').trim().toLowerCase()
    if (!name) return ''
    name = name.replace(/^\[|\]$/g, '')
    if (name === '::1') return '[::1]'
    return name
  }
  const hostNameFromConfig = value => {
    const raw = String(value || '').trim()
    if (!raw) return ''
    try {
      return normalizeHostName(new URL(raw.includes('://') ? raw : `http://${raw}`).hostname)
    } catch (_) {
      return normalizeHostName(raw)
    }
  }
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
  const authPage = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>需要访问令牌</title>
<body style="font-family:system-ui,sans-serif;padding:48px;color:#1a1d21"><h2>需要访问令牌</h2>
<p>这是一个受保护的 WebUI。请在地址后加上访问令牌完成首次引导：</p><pre style="padding:12px;background:#f4f6f2;border-radius:8px">http://&lt;主机&gt;:&lt;端口&gt;/?token=你的令牌</pre>
<p>验证通过后会写入本机 Cookie，随后地址栏会自动去掉令牌。</p></body></html>`

  const setSecurityHeaders = res => {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('X-Frame-Options', 'DENY')
    res.setHeader('Referrer-Policy', 'no-referrer')
  }

  return createServer(async (req, res) => {
    setSecurityHeaders(res)
    if (!isAllowedHost(req.headers.host)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }).end('403 Forbidden')
      return
    }
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

    // 访问令牌：health / version 放行（供宿主探活）。
    // ?token= 只允许用于首次 HTML 导航换 Cookie；API 请求只认 Cookie / 请求头。
    if (token && req.method !== 'OPTIONS' && pathname !== '/api/health' && pathname !== '/api/version') {
      const queryToken = url.searchParams.get('token') || ''
      const cookieToken = cookieValue(req, 'nianfeng_token')
      const headerToken = String(req.headers['x-nianfeng-token'] || '') || String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')
      const headerOk = !!headerToken && timingSafeStringEqual(headerToken, token)
      const cookieOk = !!cookieToken && timingSafeStringEqual(cookieToken, token)
      const canUseQuery =
        req.method === 'GET' &&
        !pathname.startsWith('/api/') &&
        !pathname.startsWith('/user-plugins/') &&
        String(req.headers.accept || '').includes('text/html')
      const queryOk = canUseQuery && !!queryToken && timingSafeStringEqual(queryToken, token)
      if (!headerOk && !cookieOk && !queryOk) {
        res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(authPage)
        return
      }
      if (queryOk && !cookieOk) {
        const clean = new URL(req.url, 'http://localhost')
        clean.searchParams.delete('token')
        res.writeHead(302, {
          'Set-Cookie': `nianfeng_token=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`,
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
          headers: { ...req.headers, host: `127.0.0.1:${backendPort}` },
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
      const body = await readFile(target)
      res.writeHead(200, {
        'Content-Type': MIME[extname(target).toLowerCase()] || 'application/octet-stream',
        'Content-Length': body.length,
        'Cache-Control': 'no-store',
      })
      res.end(body)
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
  const webPort = Number(process.env.WEB_PORT || network.webuiPort || (singlePort ? 5173 : 5173))
  const accessToken = String(network.webuiToken || '').trim()

  banner(singlePort ? ['念风chat · 单端口模式', '后端同时托管 WebUI 与 API'] : ['念风chat · 开发模式', '后端 + WebUI 一起启动'])

  // 重复双击启动时：如果端口上是旧的念风实例，自动关掉再启动；是别的程序则明确报错
  await ensurePortsFree(singlePort ? [webPort] : [backendPort, webPort], { autoStop: true, log: console })

  let backend = null
  let web = null
  let restarting = false

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

  backend = await startBackend({
    port: singlePort ? webPort : backendPort,
    host: singlePort ? webuiHost : '127.0.0.1',
    dataDir: process.env.NIANFENG_DATA_DIR || process.env.FENGYU_DATA_DIR || undefined,
    staticDir: singlePort ? '.' : null,
    accessToken,
    onRestart: restart,
    // 开发模式下 WebUI 与 API 不同端口，需把 WebUI 的 Origin 显式放行给后端；
    // 单端口模式也会包含同一端口，便于本机 IP / hostname 访问。
    allowedOrigins: webuiOriginList(webuiHost, webPort),
  })
  let webUrl = backend.url
  if (!singlePort) {
    web = createWebServer({
      backendPort: backend.port,
      accessToken,
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
    webUrl = `http://${webuiHost === '0.0.0.0' ? '127.0.0.1' : webuiHost}:${webPort}` + (accessToken ? '/?token=你的访问令牌' : '')
  }

  banner([
    `WebUI : ${webUrl}`,
    `API   : ${backend.url}/api/health`,
    `数据  : ${backend.dataDir}`,
    singlePort ? '模式  : 单端口（可直接分享给同机使用）' : `代理  : ${webUrl}/api → 127.0.0.1:${backend.port}`,
    '停止  : 按 Ctrl+C',
  ])

  openBrowser(webUrl)

  const shutdown = async () => {
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


