/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * HTTP 读写与 MIME 公共件。
 *
 * `server/plugins/http.mjs` 与 `start.mjs` 的静态服务 / JSON 响应都需要
 * 相同的 MIME 表；请求体读取也只在 HTTP 插件里使用。抽到一处后，两个入口
 * 不再各写一份 MIME，413 语义也只保留一份实现。
 */

export const MIME = {
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

/** 统一 JSON 响应：默认 no-store，可选注入额外响应头（例如 Set-Cookie）。 */
export function sendJson(res, status, data, headers = {}) {
  const body = JSON.stringify(data)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...headers,
  })
  res.end(body)
}

export function sendError(res, status, message) {
  sendJson(res, status, { error: { status, message } })
}

/**
 * 读取并解析 JSON 请求体。
 * 超限时不立即 destroy：继续把请求体读掉（最多 4 倍上限），让上层能把
 * 413 JSON 完整写回，而不是被连接重置成 502。
 */
export function readBody(req, maxBytes = 2 * 1024 * 1024) {
  return new Promise((resolveBody, reject) => {
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
}
