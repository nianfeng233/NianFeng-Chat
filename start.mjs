/**
 * 风语启动脚本：一条命令同时拉起「后端 + WebUI」，并自动打开浏览器。
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
import { extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { startBackend } from './server/index.mjs'
import { ensurePortsFree } from './server/port-utils.mjs'

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)))
const args = new Set(process.argv.slice(2))
const singlePort = args.has('--serve') || args.has('--single-port')
const autoOpen = !args.has('--no-open')

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

/** WebUI 静态服务器 + /api 反向代理（把 SSE 也原样透传） */
function createWebServer({ backendPort }) {
  return createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
    const pathname = decodeURIComponent(url.pathname)

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

    // 2) 静态资源
    let target = normalize(join(ROOT, pathname))
    if (!target.startsWith(ROOT)) {
      res.writeHead(403).end('403 Forbidden')
      return
    }
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
    } catch (_) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found')
    }
  })
}

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
  const webPort = Number(process.env.WEB_PORT || (singlePort ? 5173 : 5173))

  banner(singlePort ? ['风语 · 单端口模式', '后端同时托管 WebUI 与 API'] : ['风语 · 开发模式', '后端 + WebUI 一起启动'])

  // 重复双击启动时：如果端口上是旧的风语实例，自动关掉再启动；是别的程序则明确报错
  await ensurePortsFree(singlePort ? [webPort] : [backendPort, webPort], { autoStop: true, log: console })

  const backend = await startBackend({
    port: singlePort ? webPort : backendPort,
    host: '127.0.0.1',
    dataDir: process.env.FENGYU_DATA_DIR || undefined,
    staticDir: singlePort ? '.' : null,
  })

  let web = null
  let webUrl = backend.url
  if (!singlePort) {
    web = createWebServer({ backendPort: backend.port })
    await new Promise((resolve, reject) => {
      web.once('error', err =>
        reject(new Error(err?.code === 'EADDRINUSE' ? `WebUI 端口 ${webPort} 已被占用，请关闭占用程序或改用其他端口（WEB_PORT）` : err.message)),
      )
      web.listen(webPort, '127.0.0.1', resolve)
    })
    webUrl = `http://127.0.0.1:${webPort}`
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
    console.log('\n正在关闭风语…')
    try {
      if (web) await new Promise(resolve => web.close(resolve))
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
    console.error('\n风语遇到未预期错误，已写入 user_data/logs/error.log')
    await shutdown()
  })
  process.on('unhandledRejection', async reason => {
    await logCrash('unhandledRejection', reason)
    console.error('\n风语遇到未处理的异步错误，已写入 user_data/logs/error.log')
  })
}

const isDirectRun = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

if (isDirectRun) main().catch(err => {
  console.error('\n启动失败：', err)
  process.exit(1)
})


