/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * 静态资源缓存 / 压缩 / 条件请求工具。
 *
 * 解决的问题：
 *   - 旧实现给所有静态资源发 `Cache-Control: no-store`，远程部署时每次刷新
 *     WebUI 都要重新下载 100+ 个 JS/插件模块，RTT 叠加后动辄半分钟；
 *   - 没有 gzip / brotli，1.5MB+ 的源码在慢速上行链路上传输很慢；
 *   - 有 `?v=` / `/__nfv/<build>/` 版本号的模块可以长期缓存，没有版本号的
 *     源码至少应该走 ETag / Last-Modified 条件请求，命中后返回 304。
 *
 * 版本化路径前缀：
 *   WebUI 入口根据后端 build 号把整棵模块图放到 `/__nfv/<build>/...` 下加载，
 *   静态服务只把前缀剥掉再按原路径找文件。相对 import 会继承前缀，因此一次
 *   更新后模块图中所有文件都会换成新 URL，不再命中浏览器 / 代理的旧缓存。
 */
import { readFile, stat } from 'node:fs/promises'
import { extname } from 'node:path'
import { gzipSync } from 'node:zlib'

const MAX_CACHE_ENTRIES = 256
const MAX_CACHE_BYTES = 24 * 1024 * 1024
const COMPRESS_MIN_BYTES = 1024

/** `/__nfv/<build>/...` 构建版本前缀：build 段只允许安全字符。 */
const BUILD_PREFIX_RE = /^\/__nfv\/([A-Za-z0-9._+-]{1,160})(?=\/|$)/

/**
 * 拆出 `/__nfv/<build>` 前缀。
 * @returns {{ pathname: string, build: string, versioned: boolean }}
 */
export function stripBuildPrefix(pathname) {
  const value = String(pathname || '')
  const match = BUILD_PREFIX_RE.exec(value)
  if (!match) return { pathname: value, build: '', versioned: false }
  const rest = value.slice(match[0].length)
  return { pathname: rest || '/', build: match[1], versioned: true }
}

const COMPRESSIBLE_TYPES = [
  'text/',
  'application/javascript',
  'application/json',
  'application/xml',
  'application/xhtml+xml',
  'image/svg+xml',
  'application/wasm',
]

/** filePath -> { key, body, gzip, etag, lastModified, size } */
const fileCache = new Map()
let cachedBytes = 0

function remember(filePath, entry) {
  const previous = fileCache.get(filePath)
  if (previous) cachedBytes -= previous.body.length
  fileCache.set(filePath, entry)
  cachedBytes += entry.body.length
  while (fileCache.size > MAX_CACHE_ENTRIES || cachedBytes > MAX_CACHE_BYTES) {
    const oldest = fileCache.keys().next().value
    if (oldest === undefined || oldest === filePath) break
    const removed = fileCache.get(oldest)
    fileCache.delete(oldest)
    cachedBytes -= removed?.body?.length || 0
  }
}

const toHex = value => Number(value).toString(16)

/** 与 Express 的 freshness 语义一致：按秒比较 Last-Modified。 */
function isNotModified(req, etag, mtimeMs) {
  const inm = String(req.headers['if-none-match'] || '').trim()
  if (inm) {
    if (inm === '*') return true
    return inm.split(',').some(item => item.trim().replace(/^W\//, '') === etag.replace(/^W\//, ''))
  }
  const ims = Date.parse(String(req.headers['if-modified-since'] || ''))
  if (Number.isFinite(ims)) {
    return Math.floor(mtimeMs / 1000) <= Math.floor(ims / 1000)
  }
  return false
}

/** 浏览器 / 代理是否接受 gzip。 */
function acceptsGzip(req) {
  const value = String(req?.headers?.['accept-encoding'] || '')
  if (!value) return false
  if (/\bgzip\b/i.test(value)) return true
  return /\b\*\b/.test(value)
}

function isCompressible(contentType) {
  const type = String(contentType || '').toLowerCase()
  return COMPRESSIBLE_TYPES.some(prefix => type.startsWith(prefix))
}

/**
 * 发送一个静态文件并处理缓存协商 / gzip。
 * @returns {Promise<boolean>} 是否已成功响应
 */
export async function serveStaticFile(req, res, filePath, {
  mime = {},
  immutable = false,
  cacheControl = '',
  status = 200,
  headers: extraHeaders = {},
} = {}) {
  let info
  try {
    info = await stat(filePath)
    if (!info.isFile()) return false
  } catch (_) {
    return false
  }

  const ext = extname(filePath).toLowerCase()
  const contentType = mime[ext] || 'application/octet-stream'
  const mtimeMs = Number(info.mtimeMs) || Date.now()
  const size = Number(info.size) || 0
  const cacheKey = `${filePath}:${mtimeMs}:${size}`
  const etag = `"${toHex(size)}-${toHex(Math.floor(mtimeMs))}"`
  const lastModified = new Date(mtimeMs).toUTCString()

  if (status === 200 && isNotModified(req, etag, mtimeMs)) {
    res.writeHead(304, {
      ETag: etag,
      'Last-Modified': lastModified,
      'Cache-Control': cacheControl || (immutable ? 'private, max-age=31536000, immutable' : 'private, no-cache'),
      Vary: 'Accept-Encoding',
      ...extraHeaders,
    })
    res.end()
    return true
  }

  let cached = fileCache.get(filePath)
  if (!cached || cached.key !== cacheKey) {
    const body = await readFile(filePath)
    cached = {
      key: cacheKey,
      body,
      gzip: null,
      etag,
      lastModified,
      size: body.length,
    }
    remember(filePath, cached)
  }

  const compressible = isCompressible(contentType) && cached.body.length >= COMPRESS_MIN_BYTES
  let body = cached.body
  let encoding = ''
  if (compressible && acceptsGzip(req)) {
    if (!cached.gzip) cached.gzip = gzipSync(cached.body)
    body = cached.gzip
    encoding = 'gzip'
  }

  const outHeaders = {
    'Content-Type': contentType,
    'Content-Length': body.length,
    ETag: etag,
    'Last-Modified': lastModified,
    // 带版本号（?v= / ?__nfv=）的插件模块可以长期强缓存；
    // 其它源码走 no-cache + ETag，每次请求都是 304，不会再整包重下。
    'Cache-Control': cacheControl || (immutable ? 'private, max-age=31536000, immutable' : 'private, no-cache'),
    Vary: 'Accept-Encoding',
    ...(encoding ? { 'Content-Encoding': encoding } : {}),
    ...extraHeaders,
  }
  res.writeHead(status, outHeaders)
  if (req?.method === 'HEAD') res.end()
  else res.end(body)
  return true
}

/**
 * 根据请求 URL 是否带版本号判断能否 immutable。
 * 同时识别：
 *   - 查询串 `?v= / ?__nfv= / ?version= / ?rev=`
 *   - WebUI 构建路径 `/__nfv/<build>/...`
 *   - 外部插件版本路径 `/user-plugins/__nfv/<revision>/...`
 */
export function isVersionedRequest(req) {
  const url = String(req?.url || '')
  if (/[?&](v|__nfv|version|rev)=/i.test(url)) return true
  try {
    const pathname = new URL(url, 'http://localhost').pathname
    if (BUILD_PREFIX_RE.test(pathname)) return true
    return /^\/user-plugins\/__nfv\/[A-Za-z0-9._+-]{1,160}(?=\/|$)/.test(pathname)
  } catch (_) {
    return false
  }
}

/**
 * 清理旧版本文件缓存；插件 / 源码文件被替换后可调用，
 * 避免内存里长期保留旧版本内容（实际请求也会因 key 不匹配自动刷新）。
 */
export function clearStaticCache() {
  fileCache.clear()
  cachedBytes = 0
}
