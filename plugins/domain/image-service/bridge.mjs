/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目：念风 Chat（NianFeng-Chat）
 *
 * 图片服务后端：
 *   POST /api/images          保存 data URL / base64 图片，返回元信息
 *   GET  /api/images/:id      读取图片原文件
 *   POST /api/images/prune    按数量裁剪旧图片
 * 文件与索引实现见同目录 store.mjs。
 */
import {
  MAX_IMAGE_BYTES,
  getImageRecord,
  imagePublicRecord,
  pruneImages,
  readImageBuffer,
  saveImageBuffer,
} from './store.mjs'

export const name = 'image-service-bridge'
export const version = '1.0.0'
export const displayName = '图片服务后端'
export const description = '基础服务 · 图片文件存储与 /api/images 路由（消息里只存 imageId）。'
export const core = false
export const inject = ['settings', 'httpApi']
export const provides = [{ name: 'imageStore', type: 'singleton' }]

function decodeImageBody(body = {}) {
  const dataUrl = String(body.dataUrl || '')
  if (/^data:image\//i.test(dataUrl)) {
    const match = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/.exec(dataUrl)
    if (!match) throw Object.assign(new Error('dataUrl 格式非法'), { status: 400 })
    const mime = body.mime || match[1] || 'image/jpeg'
    const buffer = match[2] ? Buffer.from(match[3].replace(/\s+/g, ''), 'base64') : Buffer.from(decodeURIComponent(match[3]), 'utf8')
    return { buffer, mime }
  }
  const base64 = String(body.base64 || '')
  if (base64) return { buffer: Buffer.from(base64.replace(/\s+/g, ''), 'base64'), mime: body.mime || '' }
  return null
}

export function apply(ctx) {
  const settings = ctx.settings
  const http = ctx.httpApi

  const safe = handler => async (req, res, params, url) => {
    try {
      await handler(req, res, params, url)
    } catch (err) {
      if (!res.headersSent) http.sendError(res, Number(err?.status) || 500, err?.message || String(err))
      else res.end()
    }
  }

  const routes = [
    http.route(
      'POST',
      '/api/images',
      safe(async (req, res) => {
        const body = await http.readBody(req)
        const decoded = decodeImageBody(body)
        if (!decoded?.buffer?.length) throw Object.assign(new Error('缺少图片内容'), { status: 400 })
        const record = await saveImageBuffer(settings.dataDir, decoded.buffer, {
          mime: decoded.mime,
          name: body.name,
          width: body.width,
          height: body.height,
        })
        http.sendJson(res, 200, { ok: true, image: imagePublicRecord(record) })
      }),
    ),
    http.route(
      'GET',
      '/api/images/:id',
      safe(async (req, res, params) => {
        const result = await readImageBuffer(settings.dataDir, params.id)
        if (!result?.record) return http.sendError(res, 404, '图片不存在')
        res.writeHead(200, {
          'Content-Type': result.record.mime || 'application/octet-stream',
          'Content-Length': result.buffer.length,
          'Cache-Control': 'public, max-age=31536000, immutable',
        })
        res.end(result.buffer)
      }),
    ),
    http.route(
      'POST',
      '/api/images/prune',
      safe(async (req, res) => {
        const body = await http.readBody(req)
        const result = await pruneImages(settings.dataDir, { keep: Math.max(1, Number(body.keep) || 2000) })
        http.sendJson(res, 200, { ok: true, ...result, maxBytes: MAX_IMAGE_BYTES })
      }),
    ),
  ]

  ctx.provide(
    'imageStore',
    {
      name: 'imageStore',
      save: (buffer, meta) => saveImageBuffer(settings.dataDir, buffer, meta),
      get: id => getImageRecord(settings.dataDir, id),
      read: id => readImageBuffer(settings.dataDir, id),
      prune: options => pruneImages(settings.dataDir, options),
      publicRecord: imagePublicRecord,
    },
    { type: 'singleton' },
  )

  ctx.effect(() => () => {
    for (const dispose of routes) {
      try {
        dispose?.()
      } catch (_) {
        /* ignore */
      }
    }
  })
  ctx.logger.info('图片文件服务就绪（/api/images）')
}
