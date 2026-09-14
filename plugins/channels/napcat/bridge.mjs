/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 *
 * NapCatQQ / OneBot 11 渠道后端桥。
 *
 * 设计目标：
 *   - 一个 NapCat 登录实例只维护一条 WebSocket 连接（forward / reverse 二选一），
 *     多个渠道可以复用同一条连接，避免向 NapCat 发起大量重复连接；
 *   - 渠道是轻量路由：instanceId + targetType(private/group) + targetId 命中后，
 *     把归一化后的 OneBot 事件直接投递给前端渠道插件；
 *   - 后端不处理“要不要回复”的聊天规则，只提供稳定的原始能力与 HTTP 扩展点，
 *     方便其它插件依赖 napcat 服务 / 监听 napcat:* SSE 事件做扩展。
 *
 * 支持协议：
 *   - forward WebSocket：念风主动连接 ws://<napcat-host>:<port>?access_token=...
 *   - reverse WebSocket：NapCat 反向连接到 ws://<念风后端>/api/napcat/ws?instance=<id>&access_token=...
 *
 * 该文件只被 Node 后端加载（server/index.mjs 自动扫描 plugins/channels/**／bridge.mjs）。
 */
import { chmod, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { createServer as createHttpServer } from 'node:http'
import { join } from 'node:path'
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto'
import { readImageBuffer, saveImageBuffer } from '../../domain/image-service/store.mjs'

export const name = 'napcat-bridge'
export const version = '1.0.0'
export const displayName = 'NapCat 后端桥'
export const description = '渠道后端 · NapCat / OneBot 11 连接池、私聊 / 群聊路由、消息发送与发现会话。'
export const core = false
export const inject = ['settings', 'hub', 'httpApi', 'http']
export const provides = [{ name: 'napcat', type: 'singleton' }]

const STATE_FILE = 'napcat.json'
const ENC_PREFIX = 'enc:v1:'
const WS_PATH = '/api/napcat/ws'
const MAX_SEEN = 1200
const MAX_INBOX = 400
const MAX_DISCOVER = 160
const MAX_IMAGES = 4
const MAX_MEDIA_BYTES = 4 * 1024 * 1024
const ACTION_TIMEOUT = 20000
const TEXT_CHUNK = 3600
// 应用层心跳：同机内网 WebSocket 也可能半开，readyState 无法发现“假在线”。
const HEARTBEAT_PROBE_AFTER = 30000
const HEARTBEAT_DEAD_AFTER = 90000
const HEARTBEAT_CHECK_INTERVAL = 10000
const HEARTBEAT_PROBE_TIMEOUT = 8000

const sleep = ms => new Promise(resolve => setTimeout(resolve, Math.max(0, Number(ms) || 0)))

/** 等待一个 promise，超时返回 fallback；用于不能阻塞消息投递太久的辅助查询。 */
const withTimeout = (promise, ms, fallback = null) =>
  new Promise(resolve => {
    const timer = setTimeout(() => resolve(fallback), Math.max(0, Number(ms) || 0))
    Promise.resolve(promise).then(
      value => {
        clearTimeout(timer)
        resolve(value)
      },
      () => {
        clearTimeout(timer)
        resolve(fallback)
      },
    )
  })

function safeString(value, max = 500) {
  return String(value ?? '').slice(0, Math.max(0, Number(max) || 500))
}

function trimSlash(value) {
  return String(value || '').replace(/\/+$/, '')
}

function nowIso() {
  return new Date().toISOString()
}

function randomId(prefix = 'napcat') {
  return `${prefix}-${randomUUID().replace(/-/g, '').slice(0, 12)}`
}

/** 把 ws://  /  wss://  /  http://  /  https:// 统一成 WebSocket 地址 */
function normalizeForwardUrl(input) {
  let value = String(input || '').trim()
  if (!value) return ''
  if (/^wss?:\/\//i.test(value)) return value.replace(/\/+$/, '')
  if (/^https:\/\//i.test(value)) return value.replace(/^https:/i, 'wss:').replace(/\/+$/, '')
  if (/^http:\/\//i.test(value)) return value.replace(/^http:/i, 'ws:').replace(/\/+$/, '')
  if (/^\/\//.test(value)) return `ws:${value}`.replace(/\/+$/, '')
  return `ws://${value.replace(/\/+$/, '')}`
}

/** Reverse 路径：默认 /ws，和 NapCat 常见「WebSocket 客户端」地址格式保持一致。 */
function normalizeReversePath(input) {
  let value = String(input || '/ws').trim() || '/ws'
  if (!value.startsWith('/')) value = `/${value}`
  return value.slice(0, 120)
}

function withAccessToken(url, token) {
  const value = String(url || '').trim()
  const key = String(token || '').trim()
  if (!value || !key) return value
  try {
    const parsed = new URL(value)
    if (!parsed.searchParams.has('access_token')) parsed.searchParams.set('access_token', key)
    return parsed.toString()
  } catch (_) {
    return `${value}${value.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(key)}`
  }
}

function toNumericId(value) {
  const text = String(value ?? '').trim()
  if (!/^\d{3,20}$/.test(text)) return null
  return text
}

function cqUnescape(value) {
  return String(value ?? '')
    .replace(/&amp;/g, '&')
    .replace(/&#44;/g, ',')
    .replace(/&#91;/g, '[')
    .replace(/&#93;/g, ']')
}

/** OneBot 11：消息既可能是 segment 数组，也可能是 CQ 码字符串 */
function normalizeSegments(input) {
  if (Array.isArray(input)) {
    return input
      .filter(Boolean)
      .map(segment => {
        const type = safeString(segment.type || 'text', 40)
        const data = segment.data && typeof segment.data === 'object' ? segment.data : {}
        return { type, data }
      })
  }
  const text = String(input ?? '')
  if (!text) return []
  const segments = []
  const regex = /\[CQ:([a-zA-Z0-9_]+)((?:,[^\]]*)?)\]/g
  let last = 0
  let match = null
  while ((match = regex.exec(text))) {
    if (match.index > last) segments.push({ type: 'text', data: { text: text.slice(last, match.index) } })
    const type = match[1]
    const data = {}
    const raw = match[2] || ''
    for (const pair of raw.split(',')) {
      if (!pair) continue
      const index = pair.indexOf('=')
      if (index < 0) continue
      const key = pair.slice(0, index)
      data[key] = cqUnescape(pair.slice(index + 1))
    }
    segments.push({ type, data })
    last = match.index + match[0].length
  }
  if (last < text.length) segments.push({ type: 'text', data: { text: text.slice(last) } })
  return segments
}

function segmentText(segments) {
  const parts = []
  for (const segment of Array.isArray(segments) ? segments : []) {
    const type = String(segment?.type || '')
    const data = segment?.data || {}
    if (type === 'text') parts.push(String(data.text ?? ''))
    else if (type === 'at') parts.push(String(data.qq) === 'all' ? '@全体成员' : `@${data.qq}`)
    else if (type === 'image') parts.push('[图片]')
    else if (type === 'face' || type === 'marketface') parts.push('[表情]')
    else if (type === 'record' || type === 'voice') parts.push('[语音]')
    else if (type === 'video') parts.push('[视频]')
    else if (type === 'file') parts.push(`[文件${data.name ? `：${data.name}` : ''}]`)
    else if (type === 'forward' || type === 'node') parts.push('[合并转发]')
    else if (type === 'json' || type === 'xml') parts.push('[卡片消息]')
    else if (type === 'reply') continue
    else if (type) parts.push(`[${type}]`)
  }
  return parts.join('').trim()
}

function segmentImages(segments) {
  const out = []
  for (const segment of Array.isArray(segments) ? segments : []) {
    if (segment?.type !== 'image') continue
    const data = segment.data || {}
    const url = String(data.url || data.file_url || '').trim()
    const file = String(data.file || data.file_id || '').trim()
    if (!url && !file) continue
    out.push({
      url,
      file,
      mime: String(data.mime || data.content_type || '').trim(),
      width: Number(data.width) || 0,
      height: Number(data.height) || 0,
      name: safeString(data.name || '', 80),
    })
    if (out.length >= MAX_IMAGES) break
  }
  return out
}

/** 群号 / QQ 号可能有字符串、数字、带前后空格等形态：统一成去除非数字后的结果再比较。 */
function normalizeQqId(value) {
  const text = String(value ?? '').trim()
  if (!text) return ''
  const digits = text.replace(/\D/g, '')
  return digits || text
}

function segmentMentionedSelf(segments, selfIds) {
  const ids = (Array.isArray(selfIds) ? selfIds : [selfIds])
    .map(normalizeQqId)
    .filter(Boolean)
  if (!ids.length) return false
  return (Array.isArray(segments) ? segments : []).some(segment => {
    if (segment?.type !== 'at') return false
    const qq = normalizeQqId(segment?.data?.qq)
    return qq && ids.includes(qq)
  })
}

function segmentQuote(segments) {
  const found = (Array.isArray(segments) ? segments : []).find(segment => segment?.type === 'reply')
  if (!found) return null
  return {
    id: String(found?.data?.id ?? found?.data?.message_id ?? ''),
    userId: String(found?.data?.user_id ?? found?.data?.qq ?? ''),
  }
}

/* ------------------------------------------------------------------ */
/* 入站富媒体：引用 / 合并转发 / QQ 卡片                                */
/* ------------------------------------------------------------------ */

const QUOTE_TIMEOUT = 6000
const FORWARD_TIMEOUT = 10000
const MAX_FORWARD_SOURCES = 3
const FORWARD_STORE_DIR = 'forwards'
const MAX_FORWARD_STORE_FILES = 200
const MAX_FORWARD_STORED_ITEMS = 1000
const FORWARD_PREVIEW_ITEMS = 5
const FORWARD_PREVIEW_IMAGES = 2
const FORWARD_IMAGE_TIMEOUT = 4000
const MAX_FORWARD_ITEM_CHARS = 50000
const FORWARD_PREVIEW_ITEM_CHARS = 1000
const MAX_FORWARD_TOOL_ITEM_CHARS = 20000
const MAX_CARD_RAW_CHARS = 4000

function decodeXmlEntities(value) {
  return String(value ?? '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function xmlTag(xml, name) {
  const match = String(xml || '').match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i'))
  return match ? decodeXmlEntities(match[1]).trim() : ''
}

const firstNonEmpty = (...values) => {
  for (const value of values) {
    const text = String(value ?? '').trim()
    if (text) return text
  }
  return ''
}

/** JSON / XML 卡片 -> 模型可读结构；群邀请卡片会额外标记 kind=group_invite。 */
function parseCardSegment(type, data = {}) {
  const rawSource = data.data ?? data.value ?? data.raw ?? ''
  const raw =
    typeof rawSource === 'string' ? rawSource.trim() : rawSource && typeof rawSource === 'object' ? JSON.stringify(rawSource) : String(rawSource || '').trim()
  let parsed = null
  if (type === 'json') {
    try {
      parsed = raw ? JSON.parse(raw) : null
    } catch (_) {
      parsed = null
    }
    if (parsed && typeof parsed === 'object' && !parsed.app && typeof parsed.data === 'string') {
      try {
        const inner = JSON.parse(parsed.data)
        if (inner && typeof inner === 'object') parsed = inner
      } catch (_) {
        /* 保持外层结构 */
      }
    }
  }
  const source = parsed && typeof parsed === 'object' ? parsed : {}
  const meta = source.meta && typeof source.meta === 'object' ? source.meta : {}
  const detail = meta.detail_1 && typeof meta.detail_1 === 'object' ? meta.detail_1 : meta.detail && typeof meta.detail === 'object' ? meta.detail : {}
  const news = meta.news && typeof meta.news === 'object' ? meta.news : {}
  const title = firstNonEmpty(source.title, detail.title, news.title, source.prompt, source.name)
  const summary = firstNonEmpty(
    detail.desc,
    detail.summary,
    news.desc,
    news.summary,
    source.desc,
    source.summary,
    source.prompt === title ? '' : source.prompt,
  )
  const url = firstNonEmpty(source.jumpUrl, source.jump_url, source.url, detail.jumpUrl, news.jumpUrl, source.qqdocurl, meta.qqdocurl)
  const app = firstNonEmpty(source.app, source.appid, source.appId, source.service_id, source.serviceId)
  const xmlTitle = xmlTag(raw, 'title')
  const xmlSummary = firstNonEmpty(xmlTag(raw, 'summary'), xmlTag(raw, 'descr'), xmlTag(raw, 'description'))
  const xmlUrl = firstNonEmpty(xmlTag(raw, 'url'), (String(raw).match(/\burl=["']([^"']+)["']/i) || [])[1])
  const xmlApp = firstNonEmpty((String(raw).match(/\bapp=["']([^"']+)["']/i) || [])[1], (String(raw).match(/\bserviceID=["']([^"']+)["']/i) || [])[1])
  const finalTitle = firstNonEmpty(title, xmlTitle)
  const finalSummary = firstNonEmpty(summary, xmlSummary)
  const finalUrl = firstNonEmpty(url, xmlUrl)
  const finalApp = firstNonEmpty(app, xmlApp)
  const haystack = `${finalApp} ${finalTitle} ${finalSummary} ${finalUrl} ${raw}`.toLowerCase()
  const groupInvite =
    /(join.?group|group.?join|group.?invite|add.?group|group.?add|群邀请|邀请你加入|加入群聊|群聊邀请|邀请函)/i.test(haystack) ||
    (/(group|群)/i.test(finalApp) && /(邀请|加入|invite|join)/i.test(haystack))
    const recommendCard = /(推荐|名片|联系人|friend|contact|recommend)/i.test(haystack)
    const bindingCard = /(绑定|关系|bind|relation)/i.test(haystack)
    const cardKind = groupInvite ? 'group_invite' : recommendCard ? 'contact_card' : bindingCard ? 'binding_card' : 'qq_card'

  return {
    type: type === 'xml' ? 'xml' : 'json',
    kind: cardKind,
    app: finalApp.slice(0, 120),
    title: finalTitle.slice(0, 200),
    summary: finalSummary.slice(0, 600),
    url: finalUrl.slice(0, 800),
    prompt: firstNonEmpty(source.prompt, xmlTag(raw, 'prompt')).slice(0, 300),
    raw: raw.slice(0, MAX_CARD_RAW_CHARS),
  }
}

function segmentCards(segments) {
  const out = []
  for (const segment of Array.isArray(segments) ? segments : []) {
    const type = String(segment?.type || '').toLowerCase()
    if (type !== 'json' && type !== 'xml') continue
    const card = parseCardSegment(type, segment?.data || {})
    if (card) out.push(card)
    if (out.length >= 2) break
  }
  return out
}

function segmentForwardSources(segments) {
  const out = []
  const pushSource = source => {
    if (!source) return
    if (!source.id && !(Array.isArray(source.inline) && source.inline.length)) return
    out.push(source)
  }
  for (const segment of Array.isArray(segments) ? segments : []) {
    const type = String(segment?.type || '').toLowerCase()
    if (type !== 'forward' && type !== 'node' && type !== 'nodes') continue
    const data = segment?.data && typeof segment.data === 'object' ? segment.data : {}
    const id = firstNonEmpty(data.id, data.message_id, data.messageId, data.res_id, data.resId, data.forward_id, data.forwardId)
    const title = firstNonEmpty(data.title, data.name, data.prompt, data.summary).slice(0, 160)
    let inline = null
    if (Array.isArray(data.content)) inline = data.content
    else if (Array.isArray(data.message)) inline = data.message
    else if (Array.isArray(data.messages)) inline = data.messages
    // 单条 node 内联：{ user_id, nickname, content: [segments] }
    if (!inline && (data.user_id || data.userId || data.nickname)) {
      const nested = Array.isArray(data.content) ? data.content : Array.isArray(data.message) ? data.message : null
      if (nested) inline = [{ user_id: data.user_id ?? data.userId, nickname: data.nickname, message: nested }]
    }
    pushSource({ id, title, inline })
    if (out.length >= MAX_FORWARD_SOURCES) break
  }
  return out
}

/** 消息段数组 -> 简短可读文本（引用原文 / 转发条目共用）。 */
function segmentsToReadable(segments, { maxChars = MAX_FORWARD_ITEM_CHARS } = {}) {
  const parts = []
  for (const segment of Array.isArray(segments) ? segments : []) {
    const type = String(segment?.type || '').toLowerCase()
    const data = segment?.data && typeof segment.data === 'object' ? segment.data : {}
    if (type === 'text') parts.push(String(data.text ?? ''))
    else if (type === 'at') parts.push(String(data.qq) === 'all' ? '@全体成员' : `@${data.qq ?? '某人'}`)
    else if (type === 'image') parts.push('[图片]')
    else if (type === 'face' || type === 'marketface') parts.push('[表情]')
    else if (type === 'record' || type === 'voice') parts.push('[语音]')
    else if (type === 'video') parts.push('[视频]')
    else if (type === 'file') parts.push(`[文件${data.name ? `：${data.name}` : ''}]`)
    else if (type === 'json' || type === 'xml') {
      const card = parseCardSegment(type, data)
      parts.push(card?.title ? `[卡片：${card.title}]` : '[卡片消息]')
    } else if (type === 'forward' || type === 'node' || type === 'nodes') parts.push('[合并转发]')
    else if (type === 'reply') continue
    else if (type) parts.push(`[${type}]`)
  }
  const text = parts.join('').replace(/\s+/g, ' ').trim()
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text
}

function forwardItemFromRaw(raw, index = 0) {
  if (!raw || typeof raw !== 'object') return null
  const segments = normalizeSegments(raw.message ?? raw.content ?? raw.message_segments ?? [])
  const imageSources = []
  for (const segment of segments) {
    if (String(segment?.type || '').toLowerCase() !== 'image') continue
    const data = segment.data && typeof segment.data === 'object' ? segment.data : {}
    const url = String(data.url || data.file_url || '').trim()
    const file = String(data.file || data.file_id || '').trim()
    if (!url && !file) continue
    imageSources.push({ url, file, mime: String(data.mime || data.content_type || '').trim(), width: Number(data.width) || 0, height: Number(data.height) || 0 })
    if (imageSources.length >= 20) break
  }
  const nestedSegment = segments.find(segment => ['forward', 'node', 'nodes'].includes(String(segment?.type || '').toLowerCase()))
  const nestedData = nestedSegment?.data && typeof nestedSegment.data === 'object' ? nestedSegment.data : {}
  const nestedId = firstNonEmpty(nestedData.id, nestedData.message_id, nestedData.messageId, nestedData.res_id, nestedData.resId, nestedData.forward_id, nestedData.forwardId)
  const nestedForward = nestedId
    ? { id: nestedId, title: firstNonEmpty(nestedData.title, nestedData.name, nestedData.prompt, nestedData.summary).slice(0, 160), count: Number(nestedData.count || nestedData.msg_count || 0) || 0 }
    : null
  const text = segmentsToReadable(segments)
  const sender = raw.sender && typeof raw.sender === 'object' ? raw.sender : {}
  const senderName = firstNonEmpty(sender.card, sender.nickname, raw.nickname, raw.sender_name, raw.user_name, raw.user_id ? `QQ${raw.user_id}` : '')
  const imageCount = imageSources.length
  const compactText = imageCount && /^(?:\[图片\])+$/.test(text.replace(/\s+/g, '')) ? `[图片×${imageCount}]` : text
  return {
    index: index + 1,
    sender_name: safeString(senderName || '未知成员', 80),
    user_id: String(firstNonEmpty(sender.user_id, raw.user_id, raw.sender_id, raw.from_user_id)).slice(0, 40),
    time: raw.time ? new Date(Number(raw.time) * 1000).toISOString() : '',
    text: compactText || (imageCount ? `[图片×${imageCount}]` : '[空消息]'),
    image_count: imageCount || undefined,
    image_sources: imageSources.length ? imageSources : undefined,
    nested_forward: nestedForward || undefined,
    message_id: String(firstNonEmpty(raw.message_id, raw.id)).slice(0, 80),
  }
}


/**
 * 出站 CQ 码支持（AI 直接输出 CQ 码 / `[at:qq]` 简写时转换为真实消息段）。
 *
 *  - `[at:123]`、`[at:all]` 是比 CQ 更短的写法，先统一展开成 `[CQ:at,qq=...]`；
 *  - 白名单之外的 CQ 类型（file / record / video / node 等）会被丢弃，
 *    避免模型通过直出 CQ 码让 NapCat 读取本机文件或转发任意内容；
 *  - image 只允许 http(s) / base64 / data 图片源，本地路径一律拒绝。
 */
const OUTBOUND_CQ_TYPES = new Set(['text', 'at', 'image', 'face', 'music', 'json', 'xml', 'reply'])

function expandAtShorthand(value) {
  return String(value ?? '').replace(/\[at:(all|\d{3,20})\]/gi, (_, qq) => `[CQ:at,qq=${String(qq).toLowerCase() === 'all' ? 'all' : qq}]`)
}

function hasCqMarkup(value) {
  return /\[CQ:[a-zA-Z0-9_]+(?=[,\]])/.test(expandAtShorthand(value))
}

function sanitizeOutboundSegments(segments) {
  const out = []
  for (const segment of Array.isArray(segments) ? segments : []) {
    const type = String(segment?.type || '').toLowerCase()
    if (!OUTBOUND_CQ_TYPES.has(type)) continue
    const data = segment?.data && typeof segment.data === 'object' ? segment.data : {}
    if (type === 'text') {
      const text = String(data.text ?? '')
      if (!text) continue
      out.push({ type: 'text', data: { text } })
      continue
    }
    if (type === 'at') {
      const qq = normalizeQqId(data.qq)
      if (!qq || (qq !== 'all' && !/^\d{3,20}$/.test(qq))) continue
      out.push({ type: 'at', data: { qq } })
      continue
    }
    if (type === 'image') {
      const file = String(data.file || data.url || '').trim()
      if (!/^(https?:\/\/|base64:\/\/|data:image\/)/i.test(file)) continue
      out.push({ type: 'image', data: { file, ...(data.summary ? { summary: String(data.summary).slice(0, 200) } : {}) } })
      continue
    }
    if (type === 'face') {
      const id = String(data.id ?? '').trim()
      if (!id) continue
      out.push({ type: 'face', data: { id } })
      continue
    }
    if (type === 'reply') {
      const id = String(data.id ?? data.message_id ?? '').trim()
      if (!id) continue
      out.push({ type: 'reply', data: { id } })
      continue
    }
    if (type === 'json' || type === 'xml') {
      const value = String(data.data ?? data.value ?? '').trim()
      if (!value) continue
      out.push({ type, data: { data: value.slice(0, 20000) } })
      continue
    }
    if (type === 'music') {
      out.push({ type: 'music', data: { ...data } })
    }
  }
  return out
}

/** 聊天正文 -> 出站 segment；不含 CQ 码时返回 null，走原来的纯文本分块逻辑。 */
function parseOutboundSegments(text) {
  const value = String(text ?? '')
  if (!hasCqMarkup(value)) return null
  return sanitizeOutboundSegments(normalizeSegments(expandAtShorthand(value)))
}

/** 与 splitText 相同，但保留首尾空格 / 换行（CQ 解析后的文本段需要保留 @ 后面的空格）。 */
function splitTextPreserve(text, max = TEXT_CHUNK) {
  const value = String(text ?? '')
  if (!value.trim()) return value ? [value] : []
  const parts = []
  let current = ''
  for (const line of value.split('\n')) {
    const next = current ? `${current}\n${line}` : line
    if (next.length <= max) {
      current = next
      continue
    }
    if (current) parts.push(current)
    let rest = line
    while (rest.length > max) {
      parts.push(rest.slice(0, max))
      rest = rest.slice(max)
    }
    current = rest
  }
  if (current) parts.push(current)
  return parts
}

/** 把出站 segment 列表打包成若干批次，每个批次文本总长不超过 TEXT_CHUNK。 */
function batchOutboundSegments(segments) {
  const batches = []
  let current = []
  let currentText = 0
  for (const segment of Array.isArray(segments) ? segments : []) {
    if (segment?.type === 'text') {
      for (const chunk of splitTextPreserve(segment.data?.text ?? '')) {
        if (current.length && currentText + chunk.length > TEXT_CHUNK) {
          batches.push(current)
          current = []
          currentText = 0
        }
        current.push({ type: 'text', data: { text: chunk } })
        currentText += chunk.length
      }
      continue
    }
    current.push(segment)
  }
  if (current.length) batches.push(current)
  return batches
}

/* ------------------------------------------------------------------ */
/* 极简 RFC6455 服务端（NapCat reverse WebSocket）                       */
/* ------------------------------------------------------------------ */

function encodeWsFrame(payload, opcode = 0x1) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload ?? ''), 'utf8')
  const length = data.length
  let header = null
  if (length < 126) {
    header = Buffer.alloc(2)
    header[1] = length
  } else if (length < 65536) {
    header = Buffer.alloc(4)
    header[1] = 126
    header.writeUInt16BE(length, 2)
  } else {
    header = Buffer.alloc(10)
    header[1] = 127
    header.writeBigUInt64BE(BigInt(length), 2)
  }
  header[0] = 0x80 | opcode
  return Buffer.concat([header, data])
}

function wsAccept(key) {
  return createHash('sha1')
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64')
}

function writeWsUpgrade(socket, key) {
  socket.write(
    [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${wsAccept(key)}`,
      '',
      '',
    ].join('\r\n'),
  )
}

function rejectUpgrade(socket, status = 400, message = 'Bad Request') {
  try {
    socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
  } catch (_) {
    /* ignore */
  }
  socket.destroy()
}

export function apply(ctx) {
  const settings = ctx.settings
  const imageKeep = () => Number(settings.get?.()?.preferences?.chat?.imageStoreLimit) || undefined
  const hub = ctx.hub
  const httpApi = ctx.httpApi
  const http = ctx.http
  const server = http?.server || null

  /** 持久状态：NapCat 连接实例 + 渠道路由配置 + 发现会话。 */
  let data = { version: 1, instances: {}, channels: {}, discover: {} }
  /** 运行时：连接、登录信息、pending action、去重、收件箱。 */
  const runtime = new Map()
  const inbox = []
  let secretKey = null
  let persistTimer = null
  let closed = false
  let actionSeq = 0
  let upgradeHandler = null
  let ready = null

  const statePath = () => join(settings.dataDir || process.cwd(), STATE_FILE)
  const keyPath = () => join(settings.dataDir || process.cwd(), '.secret-key')

  /* ---------------- 凭据加解密（与 qqbot / wechat-clawbot 相同口径） ---------------- */

  const readSecret = async () => {
    try {
      const raw = (await readFile(keyPath(), 'utf8')).trim()
      const key = Buffer.from(raw, 'base64')
      return key.length === 32 ? key : null
    } catch (_) {
      return null
    }
  }

  const encrypt = plain => {
    const value = String(plain || '')
    if (!value) return ''
    if (!secretKey) return value
    if (value.startsWith(ENC_PREFIX)) return value
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', secretKey, iv)
    const payload = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    return `${ENC_PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${payload.toString('base64')}`
  }

  const decrypt = stored => {
    const value = String(stored || '')
    if (!value || !value.startsWith(ENC_PREFIX)) return value
    if (!secretKey) return ''
    try {
      const [ivB64, tagB64, payloadB64] = value.slice(ENC_PREFIX.length).split(':')
      const decipher = createDecipheriv('aes-256-gcm', secretKey, Buffer.from(ivB64, 'base64'))
      decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
      return Buffer.concat([decipher.update(Buffer.from(payloadB64, 'base64')), decipher.final()]).toString('utf8')
    } catch (_) {
      ctx.logger.warn('[napcat] 连接令牌解密失败，请在插件设置里重新填写')
      return ''
    }
  }

  const persist = async ({ force = false } = {}) => {
    if (closed && !force) return
    try {
      await mkdir(settings.dataDir, { recursive: true })
      const copy = structuredClone(data)
      for (const instance of Object.values(copy.instances || {})) {
        if (instance.accessToken) instance.accessToken = encrypt(instance.accessToken)
      }
      const tmp = `${statePath()}.${process.pid}.${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.tmp`
      await writeFile(tmp, JSON.stringify(copy, null, 2), 'utf8')
      await rename(tmp, statePath())
      try {
        await chmod(statePath(), 0o600)
      } catch (_) {
        /* Windows 忽略 */
      }
    } catch (err) {
      ctx.logger.warn(`[napcat] 状态写入失败：${err.message}`)
    }
  }

  const schedulePersist = () => {
    if (persistTimer || closed) return
    persistTimer = setTimeout(() => {
      persistTimer = null
      persist().catch(() => {})
    }, 500)
  }

  function normalizeInstance(input = {}) {
    const mode = input.mode === 'reverse' ? 'reverse' : 'forward'
    const rawPort = Number(input.port)
    return {
      id: String(input.id || randomId()).trim() || randomId(),
      mode,
      remark: safeString(input.remark || '', 60),
      url: mode === 'forward' ? normalizeForwardUrl(input.url) : '',
      // Reverse 模式监听在独立端口上，字段与常见 OneBot / AstrBot / NapCat 配置对齐：
      // 反向 WebSocket 主机 / 端口 / 路径 / Token（Token 可为空，空则 NapCat 也不填）。
      host: mode === 'reverse' ? safeString(input.host || '127.0.0.1', 64) : '',
      port: mode === 'reverse' ? Math.max(0, Math.min(65535, Number.isFinite(rawPort) ? rawPort : 0)) : 0,
      path: mode === 'reverse' ? normalizeReversePath(input.path) : '',
      accessToken: safeString(input.accessToken || input.token || '', 300),
      enabled: input.enabled !== false,
      autoConnect: input.autoConnect !== false,
      createdAt: Number(input.createdAt) || Date.now(),
      updatedAt: Number(input.updatedAt) || Date.now(),
    }
  }

  function normalizeChannel(input = {}) {
    const targetType = input.targetType === 'group' ? 'group' : 'private'
    const categoryRaw = String(input.category || '')
    const category = ['private', 'group', 'privacy'].includes(categoryRaw) ? categoryRaw : targetType === 'group' ? 'group' : 'private'
    const rules = input.rules && typeof input.rules === 'object' ? input.rules : {}
    const permissions = input.permissions && typeof input.permissions === 'object' ? input.permissions : {}
    return {
      channelId: String(input.channelId || '').trim(),
      channelName: safeString(input.channelName || '', 80),
      roleId: safeString(input.roleId || '', 120),
      instanceId: String(input.instanceId || '').trim(),
      category,
      targetType,
      targetId: toNumericId(input.targetId) || String(input.targetId || '').trim().slice(0, 40),
      identityMode: input.identityMode === 'guest' ? 'guest' : 'owner',
      rules: {
        blacklist: (Array.isArray(rules.blacklist) ? rules.blacklist : [])
          .map(item => String(item || '').trim())
          .filter(Boolean)
          .slice(0, 200),
        whitelist: (Array.isArray(rules.whitelist) ? rules.whitelist : [])
          .map(item => String(item || '').trim())
          .filter(Boolean)
          .slice(0, 200),
        whitelistForAt: rules.whitelistForAt === true,
        whitelistForProbability: rules.whitelistForProbability === true,
        requireAt: rules.requireAt !== false,
        replyProbability: Math.max(0, Math.min(100, Number(rules.replyProbability) || 0)),
        quote: rules.quote !== false,
        mention: rules.mention !== false,
        silentContext: rules.silentContext !== false,
      },
      permissions,
      trustedUserIds: (Array.isArray(input.trustedUserIds) ? input.trustedUserIds : [])
        .map(item => String(item || '').trim())
        .filter(Boolean)
        .slice(0, 200),
      updatedAt: Number(input.updatedAt) || Date.now(),
    }
  }

  async function loadState() {
    secretKey = await readSecret()
    try {
      const raw = await readFile(statePath(), 'utf8')
      const parsed = JSON.parse(raw)
      data = {
        version: 1,
        instances: parsed?.instances && typeof parsed.instances === 'object' ? parsed.instances : {},
        channels: parsed?.channels && typeof parsed.channels === 'object' ? parsed.channels : {},
        discover: parsed?.discover && typeof parsed.discover === 'object' ? parsed.discover : {},
      }
      for (const instance of Object.values(data.instances)) {
        const normalized = normalizeInstance(instance)
        if (instance.accessToken) normalized.accessToken = decrypt(instance.accessToken)
        Object.assign(instance, normalized)
      }
      for (const channel of Object.values(data.channels)) Object.assign(channel, normalizeChannel(channel))
    } catch (_) {
      data = { version: 1, instances: {}, channels: {}, discover: {} }
    }
  }

  /* ---------------- 运行时 ---------------- */

  function runtimeFor(instanceId) {
    const key = String(instanceId || '')
    let rt = runtime.get(key)
    if (!rt) {
      rt = {
        id: key,
        status: 'offline',
        error: '',
        conn: null,
        reverseSocket: null,
        reverseServer: null,
        reverseServerPort: 0,
        reverseStarting: null,
        reconnectDelay: 1000,
        loopActive: false,
        stopping: false,
        epoch: 0,
        restartTimer: null,
        login: { userId: '', nickname: '' },
        loginPromise: null,
        pending: new Map(),
        seen: new Map(),
        lastEventAt: 0,
        // 当前连接真正进入 online 的时间。前端用它区分“连接前的历史积压”和
        // “连接后、前端重启期间漏收的实时消息”，避免把后者也静默掉。
        connectedAt: 0,
        heartbeatTimer: null,
        heartbeatOwner: null,
        heartbeatProbing: false,
        listsLoaded: false,
        versionInfo: '',
      }
      runtime.set(key, rt)
    }
    return rt
  }

  const connectionAlive = rt => !!rt?.conn && rt.conn.readyState === 1

  function channelIdsOf(instanceId) {
    return Object.values(data.channels)
      .filter(channel => channel.instanceId === String(instanceId || ''))
      .map(channel => channel.channelId)
  }

  function publicInstance(record, rt = null) {
    const run = rt || runtimeFor(record.id)
    const login = run?.login || {}
    return {
      id: record.id,
      mode: record.mode,
      remark: record.remark || '',
      url: record.url || '',
      host: record.mode === 'reverse' ? record.host || '127.0.0.1' : '',
      port: record.mode === 'reverse' ? Number(run?.reverseServerPort || record.port || 0) : 0,
      path: record.mode === 'reverse' ? normalizeReversePath(record.path) : '',
      listenActive: record.mode === 'reverse' ? !!run?.reverseServer : false,
      hasToken: !!record.accessToken,
      enabled: record.enabled !== false,
      autoConnect: record.autoConnect !== false,
      status: run?.status || (record.mode === 'reverse' ? 'waiting' : 'offline'),
      error: run?.error || '',
      login: { userId: String(login.userId || ''), nickname: String(login.nickname || '') },
      versionInfo: String(run?.versionInfo || ''),
      channelIds: channelIdsOf(record.id),
      lastEventAt: run?.lastEventAt || 0,
      connectedAt: Number(run?.connectedAt) || 0,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      endpoint: record.mode === 'reverse' ? `/api/napcat/ws?instance=${encodeURIComponent(record.id)}` : '',
    }
  }

  function listInstances() {
    return Object.values(data.instances)
      .map(record => publicInstance(record))
      .sort((a, b) => (b.lastEventAt || 0) - (a.lastEventAt || 0) || String(a.id).localeCompare(String(b.id)))
  }

  function broadcastInstances() {
    hub.broadcast('napcat:instances', { instances: listInstances(), time: Date.now() })
  }

  function setStatus(rt, status, error = '') {
    if (!rt) return
    const nextError = status === 'error' ? String(error || '连接异常') : ''
    if (rt.status === status && rt.error === nextError) {
      return
    }
    const wasOnline = rt.status === 'online'
    rt.status = status
    rt.error = nextError
    // 记录本次连接进入 online 的时间；断开时清空，重连时重新开始计时。
    if (status === 'online' && !wasOnline) rt.connectedAt = Date.now()
    else if (status !== 'online' && wasOnline) rt.connectedAt = 0
    const record = data.instances[rt.id]
    hub.broadcast('napcat:status', {
      instanceId: rt.id,
      status,
      error: nextError,
      login: { userId: rt.login?.userId || '', nickname: rt.login?.nickname || '' },
      record: record ? publicInstance(record, rt) : null,
      time: Date.now(),
    })
    broadcastInstances()
  }

  function stopHeartbeatWatchdog(rt, owner = null) {
    if (!rt) return
    if (owner && rt.heartbeatOwner && rt.heartbeatOwner !== owner) return
    if (rt.heartbeatTimer) {
      clearInterval(rt.heartbeatTimer)
      rt.heartbeatTimer = null
    }
    rt.heartbeatOwner = null
    rt.heartbeatProbing = false
  }

  /**
   * 内网连接也可能出现“假在线”：TCP/WS 的 readyState 仍是 OPEN，但 NapCat 已不再
   * 推任何事件，上层会一直以为连接正常。这个看门狗在长时间没有 payload 时主动发
   * get_status 探测；探测失败或沉默超时就关闭当前连接，交给原本的重连循环处理。
   */
  function startHeartbeatWatchdog(rt, close, owner) {
    stopHeartbeatWatchdog(rt)
    if (!rt || typeof close !== 'function') return
    rt.heartbeatOwner = owner
    rt.heartbeatTimer = setInterval(async () => {
      if (rt.heartbeatOwner !== owner || !connectionAlive(rt)) return
      if (rt.status !== 'online' || rt.heartbeatProbing) return
      const last = Number(rt.lastEventAt) || Date.now()
      const silent = Date.now() - last
      if (silent < HEARTBEAT_PROBE_AFTER) return
      if (silent >= HEARTBEAT_DEAD_AFTER) {
        ctx.logger.warn(`[napcat] ${rt.id} 已 ${Math.round(silent / 1000)} 秒没有任何事件，主动重连`)
        stopHeartbeatWatchdog(rt, owner)
        try { close() } catch (_) { /* ignore */ }
        return
      }
      rt.heartbeatProbing = true
      let result = null
      try {
        result = await sendAction(rt, 'get_status', {}, HEARTBEAT_PROBE_TIMEOUT)
      } catch (_) {
        result = null
      } finally {
        rt.heartbeatProbing = false
      }
      if (!result?.ok && rt.heartbeatOwner === owner) {
        ctx.logger.warn(`[napcat] ${rt.id} 心跳探测失败（${result?.error || '无响应'}），主动重连`)
        stopHeartbeatWatchdog(rt, owner)
        try { close() } catch (_) { /* ignore */ }
      }
    }, HEARTBEAT_CHECK_INTERVAL)
    rt.heartbeatTimer?.unref?.()
  }


  /* ---------------- OneBot action / 事件 ---------------- */

  const resolvePending = (rt, echo, payload) => {
    const waiter = rt.pending.get(String(echo))
    if (!waiter) return false
    rt.pending.delete(String(echo))
    clearTimeout(waiter.timer)
    const retcode = Number(payload?.retcode)
    const ok = String(payload?.status || '').toLowerCase() === 'ok' && (!Number.isFinite(retcode) || retcode === 0)
    waiter.resolve({
      ok,
      code: Number.isFinite(retcode) ? retcode : ok ? 0 : -1,
      data: payload?.data ?? null,
      message: payload?.message || payload?.msg || payload?.wording || '',
      raw: payload,
    })
    return true
  }

  async function sendAction(rt, action, params = {}, timeoutMs = ACTION_TIMEOUT) {
    if (!rt || !connectionAlive(rt)) {
      return { ok: false, code: 'OFFLINE', error: 'NapCat 连接未就绪', data: null }
    }
    const echo = `nf-${Date.now()}-${++actionSeq}`
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        rt.pending.delete(echo)
        resolve({ ok: false, code: 'TIMEOUT', error: `NapCat 在 ${timeoutMs}ms 内没有响应 ${action}`, data: null })
      }, Math.max(1000, Number(timeoutMs) || ACTION_TIMEOUT))
      rt.pending.set(echo, { resolve, timer, action })
      try {
        rt.conn.send(JSON.stringify({ action, params: params || {}, echo }))
      } catch (err) {
        rt.pending.delete(echo)
        clearTimeout(timer)
        resolve({ ok: false, code: 'SEND_FAILED', error: err?.message || '发送失败', data: null })
      }
    })
  }

  async function ensureLoginInfo(rt) {
    if (!connectionAlive(rt)) return null
    if (rt.loginPromise) return rt.loginPromise
    rt.loginPromise = (async () => {
      const result = await sendAction(rt, 'get_login_info', {}, 8000)
      if (result.ok && result.data) {
        rt.login = {
          userId: String(result.data.user_id ?? result.data.userId ?? '').trim(),
          nickname: safeString(result.data.nickname ?? result.data.nick_name ?? '', 60),
        }
        setStatus(rt, 'online')
        refreshInstanceLists(rt).catch(() => {})
        return rt.login
      }
      // 有些 NapCat 版本 get_login_info 返回较慢或被封；收到事件里的 self_id 也能补全账号。
      if (rt.login.userId) {
        setStatus(rt, 'online')
        return rt.login
      }
      return null
    })().finally(() => {
      rt.loginPromise = null
    })
    return rt.loginPromise
  }

  async function refreshInstanceLists(rt) {
    if (!connectionAlive(rt) || rt.listsLoaded) return
    rt.listsLoaded = true
    try {
      const [friends, groups, version] = await Promise.all([
        sendAction(rt, 'get_friend_list', {}, 10000),
        sendAction(rt, 'get_group_list', {}, 10000),
        sendAction(rt, 'get_version_info', {}, 8000),
      ])
      if (version.ok && version.data) {
        rt.versionInfo = safeString(version.data.app_name || version.data.app_full_name || version.data.version || '', 80)
      }
      if (friends.ok && Array.isArray(friends.data)) {
        for (const friend of friends.data) {
          upsertDiscover(rt.id, {
            type: 'private',
            peerId: String(friend.user_id ?? friend.userId ?? ''),
            name: safeString(friend.nickname || friend.remark || friend.nick || '', 60),
            source: 'friend-list',
          })
        }
      }
      if (groups.ok && Array.isArray(groups.data)) {
        for (const group of groups.data) {
          upsertDiscover(rt.id, {
            type: 'group',
            peerId: String(group.group_id ?? group.groupId ?? ''),
            name: safeString(group.group_name || group.groupName || '', 80),
            source: 'group-list',
          })
        }
      }
      broadcastDiscover(rt.id)
    } catch (_) {
      /* 发现列表只是 UX 增强，失败不影响收消息 */
    }
  }

  const actionFail = result => !result || result.ok !== true

  async function handlePayload(rt, payload) {
    if (!payload || typeof payload !== 'object') return
    // 任何 payload（包括 get_status 探测响应 / 心跳 / 消息）都算连接活跃。
    rt.lastEventAt = Date.now()
    if (payload.echo !== undefined && resolvePending(rt, payload.echo, payload)) return

    // 某些 NapCat 版本第一条业务事件早于 get_login_info / heartbeat，先记下连接时间，
    // 保证随后投递的消息带有 connectedAt，前端才能区分积压与实时消息。
    if (!rt.connectedAt) rt.connectedAt = Date.now()

    const selfId = String(payload.self_id ?? '').trim()
    if (selfId && !rt.login.userId) {
      rt.login.userId = selfId
      setStatus(rt, 'online')
      ensureLoginInfo(rt).catch(() => {})
    }
    if (payload.post_type === 'meta_event') {
      if (payload.meta_event_type === 'lifecycle') {
        const sub = String(payload.sub_type || '')
        if (sub === 'connect' || sub === 'enable') {
          ensureLoginInfo(rt).catch(() => {})
        } else if (sub === 'disable') {
          setStatus(rt, 'offline', '')
        }
      } else if (payload.meta_event_type === 'heartbeat') {
        // 某些 NapCat 版本 get_login_info 响应较慢；心跳里的 self_id 也足以判定在线。
        if (rt.login.userId && rt.status !== 'online') setStatus(rt, 'online')
      }
      return
    }

    if (payload.post_type === 'message') {
      const message = normalizeInbound(rt, payload)
      if (!message) return
      if (message.senderId && message.senderId === message.selfId) return
      const seenAt = rt.seen.get(message.key)
      if (seenAt && Date.now() - seenAt < 5 * 60 * 1000) return
      rt.seen.set(message.key, Date.now())
      if (rt.seen.size > MAX_SEEN) {
        for (const [key, at] of rt.seen) {
          if (Date.now() - at > 5 * 60 * 1000) rt.seen.delete(key)
          if (rt.seen.size <= MAX_SEEN) break
        }
      }
      hydrateInbound(rt, message)
        .then(() => deliverIncoming(rt, message))
        .catch(err => ctx.logger.warn(`[napcat] 处理消息失败：${err?.message || err}`))
      return
    }

    if (payload.post_type === 'notice') {
      const instanceId = rt.id
      hub.broadcast('napcat:notice', { instanceId, noticeType: payload.notice_type || '', raw: payload, time: Date.now() })
      handleNotice(rt, payload)
      return
    }

    if (payload.post_type === 'request') {
      hub.broadcast('napcat:request', { instanceId: rt.id, requestType: payload.request_type || '', raw: payload, time: Date.now() })
    }
  }

  function normalizeInbound(rt, payload) {
    const messageType = payload.message_type === 'group' ? 'group' : payload.message_type === 'private' ? 'private' : ''
    if (!messageType) return null
    const sender = payload.sender && typeof payload.sender === 'object' ? payload.sender : {}
    const groupId = String(payload.group_id ?? '')
    const senderId = String(payload.user_id ?? sender.user_id ?? '')
    const peerId = messageType === 'group' ? groupId : senderId
    if (!peerId) return null
    const payloadSelfId = String(payload.self_id ?? '').trim()
    const loginSelfId = String(rt.login?.userId ?? '').trim()
    // 某些 NapCat 版本 / 转发链路不会在每个消息事件里带 self_id；登录信息里的 userId
    // 同样可以作为 @ 检测的主体，避免“@ 了机器人但 mentionedSelf=false”。
    const selfId = payloadSelfId || loginSelfId
    const selfIds = [...new Set([payloadSelfId, loginSelfId].filter(Boolean))]
    const segments = normalizeSegments(payload.message)
    // 部分适配器在 message 数组里不带 at，只在 raw_message 的 CQ 码里带；两边都检测一次。
    const rawSegments = normalizeSegments(payload.raw_message || '')
    const atUserIds = [
      ...new Set(
        [...(Array.isArray(segments) ? segments : []), ...(Array.isArray(rawSegments) ? rawSegments : [])]
          .filter(segment => segment?.type === 'at')
          .map(segment => String(segment?.data?.qq ?? '').trim())
          .filter(qq => qq && qq !== 'all'),
      ),
    ]
    const text = segmentText(segments)
    const images = segmentImages(segments)
    const quoted = segmentQuote(segments)
    const cards = segmentCards(segments)
    const forwardSources = segmentForwardSources(segments)
    const messageId = String(payload.message_id ?? payload.message_seq ?? `${payload.time || Date.now()}-${senderId}`)
    return {
      key: `${messageType}:${peerId}:${messageId}`,
      id: `napcat-${messageType}-${peerId}-${messageId}`,
      messageId,
      messageType,
      peerId,
      groupId: messageType === 'group' ? groupId : '',
      senderId,
      senderName: safeString(sender.card && messageType === 'group' ? sender.card : sender.nickname || sender.card || '', 80),
      senderNickname: safeString(sender.nickname || '', 80),
      senderCard: safeString(messageType === 'group' ? sender.card || '' : '', 80),
      senderRole: safeString(sender.role || '', 20),
      selfId,
      mentionedSelf: segmentMentionedSelf(segments, selfIds) || segmentMentionedSelf(rawSegments, selfIds),
      atUserIds,
      mentionAll: [...(Array.isArray(segments) ? segments : []), ...(Array.isArray(rawSegments) ? rawSegments : [])].some(
        segment => segment?.type === 'at' && normalizeQqId(segment?.data?.qq) === 'all',
      ),
      text,
      images: [],
      rawImages: images,
      quote: quoted,
      cards,
      card: cards[0] || null,
      forwardSources,
      time: payload.time ? new Date(Number(payload.time) * 1000).toISOString() : nowIso(),
      receivedAt: Date.now(),
      subType: String(payload.sub_type || ''),
      rawSegments: segments,
    }
  }

  async function handleNotice(rt, payload) {
    try {
      const type = String(payload.notice_type || '')
      if (type === 'group_recall' || type === 'friend_recall') {
        const peerId = String(payload.group_id || payload.user_id || '')
        const senderId = String(payload.user_id || payload.operator_id || '')
        if (peerId) {
          hub.broadcast('napcat:recall', { instanceId: rt.id, messageType: payload.group_id ? 'group' : 'private', peerId, senderId, time: Date.now() })
        }
      }
    } catch (_) {
      /* ignore */
    }
  }

  async function hydrateImages(message) {
    const list = Array.isArray(message.rawImages) ? message.rawImages.slice(0, MAX_IMAGES) : []
    delete message.rawImages
    if (!list.length) return message
    const records = []
    let total = 0
    for (const item of list) {
      try {
        const buffer = await imageBufferOf(item)
        if (!buffer || total + buffer.length > 6 * 1024 * 1024) continue
        total += buffer.length
        const record = await saveImageBuffer(settings.dataDir, buffer, {
          mime: item.mime || '',
          width: item.width || undefined,
          height: item.height || undefined,
        }, { keep: imageKeep() })
        records.push({ id: record.id, mime: record.mime, width: record.width, height: record.height, size: record.size })
      } catch (_) {
        /* 单张失败不影响文字消息 */
      }
    }
    message.images = records
    return message
  }

  /** 引用消息：调用 OneBot get_msg 取回原文，挂到 message.quote 上。 */
  async function hydrateQuote(rt, message) {
    const quote = message?.quote
    if (!quote?.id) return
    let result = await withTimeout(sendAction(rt, 'get_msg', { message_id: quote.id }, QUOTE_TIMEOUT), QUOTE_TIMEOUT + 800)
    // 少数实现使用 message_id 作为数字/字符串有差异：第一次失败后按数字再试一次。
    if ((!result || result.ok !== true) && /^\d+$/.test(quote.id)) {
      result = await withTimeout(
        sendAction(rt, 'get_msg', { message_id: Number(quote.id) }, QUOTE_TIMEOUT),
        QUOTE_TIMEOUT + 800,
      )
    }
    const data = result?.ok === true ? result.data : null
    if (!data || typeof data !== 'object') {
      quote.available = false
      quote.error = result?.error || '引用消息原文读取失败'
      return
    }
    const segments = normalizeSegments(data.message ?? data.message_segments ?? [])
    const rawImages = segmentImages(segments)
    const quotedImages = []
    let quotedBytes = 0
    for (const item of rawImages) {
      if (quotedBytes >= 6 * 1024 * 1024) break
      try {
        const buffer = await withTimeout(imageBufferOf(item), FORWARD_IMAGE_TIMEOUT, null)
        if (!buffer || quotedBytes + buffer.length > 6 * 1024 * 1024) continue
        quotedBytes += buffer.length
        const record = await saveImageBuffer(settings.dataDir, buffer, {
          mime: item.mime || '',
          width: item.width || undefined,
          height: item.height || undefined,
        }, { keep: imageKeep() })
        quotedImages.push({ id: record.id, mime: record.mime, width: record.width, height: record.height, size: record.size })
      } catch (_) {
        /* 单张引用图片失败不影响引用文本 */
      }
    }
    const text = segmentsToReadable(segments, { maxChars: 1200 })
    const imageCount = quotedImages.length || rawImages.length
    const sender = data.sender && typeof data.sender === 'object' ? data.sender : {}
    quote.available = true
    quote.text = text || (imageCount ? `[图片×${imageCount}]` : '[空消息]')
    quote.image_count = imageCount || undefined
    quote.images = quotedImages.length ? quotedImages : undefined
    quote.senderId = String(firstNonEmpty(sender.user_id, data.user_id, quote.userId)).slice(0, 40)
    quote.senderName = safeString(
      firstNonEmpty(sender.card, sender.nickname, data.nickname, data.sender_name, quote.senderId ? `QQ${quote.senderId}` : '对方'),
      80,
    )
    quote.time = data.time ? new Date(Number(data.time) * 1000).toISOString() : ''
    quote.message_id = String(firstNonEmpty(data.message_id, quote.id)).slice(0, 80)
  }

  const forwardStoreDir = () => join(settings.dataDir || process.cwd(), FORWARD_STORE_DIR)
  const forwardStoreFile = id =>
    join(forwardStoreDir(), `fwd_${createHash('sha1').update(String(id)).digest('hex').slice(0, 16)}.json`)

  async function pruneForwardStore() {
    try {
      const dir = forwardStoreDir()
      const names = (await readdir(dir)).filter(name => name.endsWith('.json'))
      if (names.length <= MAX_FORWARD_STORE_FILES) return
      const infos = await Promise.all(
        names.map(async name => ({ name, at: Number((await stat(join(dir, name))).mtimeMs) || 0 })),
      )
      infos.sort((a, b) => a.at - b.at)
      for (const item of infos.slice(0, Math.max(0, infos.length - MAX_FORWARD_STORE_FILES))) {
        await unlink(join(dir, item.name)).catch(() => {})
      }
    } catch (_) {
      /* 清理失败不影响写入 */
    }
  }

  async function saveForwardRecord(record) {
    try {
      const dir = forwardStoreDir()
      await mkdir(dir, { recursive: true })
      const file = forwardStoreFile(record.id)
      const tmp = `${file}.${process.pid}.${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.tmp`
      await writeFile(tmp, JSON.stringify(record), 'utf8')
      await rename(tmp, file)
      pruneForwardStore().catch(() => {})
      return true
    } catch (err) {
      ctx.logger?.warn?.(`[napcat] 转发记录落盘失败（${record?.id}）：${err?.message || err}`)
      return false
    }
  }

  async function loadForwardRecord(id) {
    try {
      const raw = await readFile(forwardStoreFile(id), 'utf8')
      const parsed = JSON.parse(raw)
      return parsed && typeof parsed === 'object' ? parsed : null
    } catch (_) {
      return null
    }
  }

  function normalizeForwardMessages(messages) {
    const items = []
    for (const raw of Array.isArray(messages) ? messages : []) {
      const item = forwardItemFromRaw(raw, items.length)
      if (!item) continue
      items.push(item)
      if (items.length >= MAX_FORWARD_STORED_ITEMS) break
    }
    return items
  }

  async function fetchForwardItems(rt, source) {
    let raws = Array.isArray(source?.inline) ? source.inline : []
    let error = ''
    if (!raws.length && source?.id) {
      let result = await withTimeout(
        sendAction(rt, 'get_forward_msg', { id: source.id }, FORWARD_TIMEOUT),
        FORWARD_TIMEOUT + 800,
      )
      if ((!result || result.ok !== true) && /^\d+$/.test(String(source.id))) {
        result = await withTimeout(
          sendAction(rt, 'get_forward_msg', { id: Number(source.id) }, FORWARD_TIMEOUT),
          FORWARD_TIMEOUT + 800,
        )
      }
      const data = result?.ok === true ? result.data : null
      raws = Array.isArray(data?.messages)
        ? data.messages
        : Array.isArray(data?.message)
          ? data.message
          : Array.isArray(data)
            ? data
            : []
      if (!raws.length) error = result?.error || '合并转发内容读取失败'
    }
    return { items: normalizeForwardMessages(raws), error, total: Array.isArray(raws) ? raws.length : 0 }
  }

  async function attachForwardImages(items, limit = FORWARD_PREVIEW_IMAGES) {
    const max = Math.max(0, Number(limit) || 0)
    if (!max) return 0
    const slots = []
    for (const item of items) {
      if (!Array.isArray(item.image_sources) || !item.image_sources.length) continue
      for (const source of item.image_sources) {
        slots.push({ item, source })
        if (slots.length >= max) break
      }
      if (slots.length >= max) break
    }
    if (!slots.length) return 0
    // 并行下载，单张超时就走文字占位；不能因为转发里的图片下载把整条消息卡住。
    const records = await Promise.all(
      slots.map(async slot => {
        try {
          const buffer = await withTimeout(imageBufferOf(slot.source), FORWARD_IMAGE_TIMEOUT, null)
          if (!buffer) return null
          const record = await saveImageBuffer(settings.dataDir, buffer, {
            mime: slot.source.mime || '',
            width: slot.source.width || undefined,
            height: slot.source.height || undefined,
          }, { keep: imageKeep() })
          return { item: slot.item, record: { id: record.id, mime: record.mime, width: record.width, height: record.height, size: record.size } }
        } catch (_) {
          return null
        }
      }),
    )
    let shown = 0
    for (const entry of records) {
      if (!entry?.record) continue
      if (!Array.isArray(entry.item.preview_images)) entry.item.preview_images = []
      entry.item.preview_images.push(entry.record)
      shown += 1
    }
    return shown
  }

  function forwardItemBaseForTool(item) {
    return {
      index: item.index,
      sender_name: item.sender_name,
      user_id: item.user_id || undefined,
      time: item.time || undefined,
      image_count: item.image_count || undefined,
      preview_images: Array.isArray(item.preview_images) ? item.preview_images : undefined,
      nested_forward: item.nested_forward || undefined,
      message_id: item.message_id || undefined,
    }
  }

  function stripForwardItemForMeta(item) {
    const fullText = String(item.text || '')
    const previewText = fullText.length > FORWARD_PREVIEW_ITEM_CHARS ? `${fullText.slice(0, FORWARD_PREVIEW_ITEM_CHARS)}…` : fullText
    return {
      ...forwardItemBaseForTool(item),
      text: previewText,
      text_length: fullText.length || undefined,
      text_truncated: fullText.length > FORWARD_PREVIEW_ITEM_CHARS || undefined,
    }
  }
  /**
   * 合并转发：完整记录落盘到数据目录，消息 meta 只保留少量预览。
   * 模型默认只看前 FORWARD_PREVIEW_ITEMS 条 + 前 FORWARD_PREVIEW_IMAGES 张图；
   * 更多内容由 read_forward 工具按 offset / limit 分页读取，避免一次转发把上下文撑爆。
   */
  async function hydrateForward(rt, message) {
    const sources = Array.isArray(message?.forwardSources) ? message.forwardSources : []
    delete message.forwardSources
    if (!sources.length) return
    const allItems = []
    let rawTotal = 0
    const sourceErrors = []
    for (const source of sources) {
      const { items, error, total: sourceTotal } = await fetchForwardItems(rt, source)
      rawTotal += Number(sourceTotal) || items.length
      if (error) sourceErrors.push(error)
      for (const item of items) {
        item.index = allItems.length + 1
        allItems.push(item)
        if (allItems.length >= MAX_FORWARD_STORED_ITEMS) break
      }
      if (allItems.length >= MAX_FORWARD_STORED_ITEMS) break
    }
    const firstSource = sources[0] || {}
    const rootId = firstSource.id || `fwd_local_${String(message.messageId || message.id || Date.now())}`
    const title = firstNonEmpty(...sources.map(source => source.title), '聊天记录')
    const imageTotal = allItems.reduce((sum, item) => sum + (Number(item.image_count) || 0), 0)
    if (allItems.length) {
      await saveForwardRecord({
        version: 1,
        id: rootId,
        title,
        instanceId: rt.id,
        createdAt: Date.now(),
        total: Math.max(rawTotal, allItems.length),
        truncated: allItems.length < rawTotal || undefined,
        imageTotal,
        sourceIds: sources.map(source => source.id || '').filter(Boolean),
        items: allItems,
      })
    }
    const previewItems = allItems.slice(0, FORWARD_PREVIEW_ITEMS)
    const imagesShown = await attachForwardImages(previewItems, FORWARD_PREVIEW_IMAGES)
    message.forward = {
      id: rootId,
      title,
      total: Math.max(rawTotal, allItems.length),
      preview: previewItems.map(stripForwardItemForMeta),
      preview_count: previewItems.length,
      has_more: rawTotal > previewItems.length || allItems.length > previewItems.length,
        truncated: allItems.length < rawTotal || undefined,

      image_total: imageTotal,
      images_shown: imagesShown,
      error: allItems.length ? undefined : sourceErrors[0] || '转发内容为空',
      read_tool: 'read_forward',
    }
  }

  /** 入站消息统一处理：图片入库、引用原文、合并转发、卡片解析。 */
  async function hydrateInbound(rt, message) {
    await Promise.allSettled([hydrateImages(message), hydrateQuote(rt, message), hydrateForward(rt, message)])
    return message
  }


  async function imageBufferOf(item) {
    const source = String(item?.url || item?.file || '').trim()
    if (!source) return null
    if (/^base64:\/\//i.test(source)) {
      const base64 = source.slice('base64://'.length).replace(/\s+/g, '')
      const buffer = Buffer.from(base64, 'base64')
      return buffer.length <= MAX_MEDIA_BYTES ? buffer : null
    }
    if (/^data:/i.test(source)) {
      const match = source.match(/^data:([^;,]+)?(;base64)?,([\s\S]*)$/)
      if (!match) return null
      const buffer = match[2] ? Buffer.from(match[3].replace(/\s+/g, ''), 'base64') : Buffer.from(decodeURIComponent(match[3]), 'utf8')
      return buffer.length <= MAX_MEDIA_BYTES ? buffer : null
    }
    if (/^https?:\/\//i.test(source)) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(new Error('图片下载超时')), 15000)
      try {
        const response = await fetch(source, { signal: controller.signal })
        if (!response.ok) return null
        const buffer = Buffer.from(await response.arrayBuffer())
        return buffer.length <= MAX_MEDIA_BYTES ? buffer : null
      } catch (_) {
        return null
      } finally {
        clearTimeout(timer)
      }
    }
    // NapCat 的 file 可能是本地绝对路径，但后端不应替它读任意文件；拿不到 url 时就跳过。
    return null
  }

  /* ---------------- 路由与发现 ---------------- */

  function channelsFor(instanceId, message) {
    return Object.values(data.channels).filter(channel => {
      if (!channel || channel.instanceId !== String(instanceId)) return false
      if (channel.targetType !== message.messageType) return false
      return String(channel.targetId) === String(message.peerId)
    })
  }

  function deliverIncoming(rt, message) {
    const matches = channelsFor(rt.id, message)
    upsertDiscover(rt.id, {
      type: message.messageType,
      peerId: message.peerId,
      name:
        message.messageType === 'group'
          ? discoverName(rt.id, message.messageType, message.peerId) || `群 ${message.peerId}`
          : message.senderNickname || message.senderName || `QQ ${message.senderId}`,
      lastText: safeString(message.text || (message.images?.length ? '[图片]' : ''), 120),
      lastSenderId: message.senderId,
      lastSenderName: message.senderName,
      bound: matches.length > 0,
    })
    if (!matches.length) {
      broadcastDiscover(rt.id)
      return
    }
    for (const channel of matches) {
      const payloadMessage = {
        ...message,
        channelId: channel.channelId,
        channelTargetType: channel.targetType,
        channelTargetId: channel.targetId,
        // 连接建立时间由后端桥提供，前端据此判断是否属于“连接前积压”。
        connectedAt: Number(rt.connectedAt) || 0,
      }
      const record = {
        id: `${message.id}-${channel.channelId}`,
        channelId: channel.channelId,
        instanceId: rt.id,
        at: Date.now(),
        message: payloadMessage,
      }
      inbox.push(record)
      if (inbox.length > MAX_INBOX) inbox.splice(0, inbox.length - MAX_INBOX)
      hub.broadcast('napcat:message', { channelId: channel.channelId, instanceId: rt.id, message: payloadMessage })
    }
    broadcastDiscover(rt.id)
  }

  function discoverKey(type, peerId) {
    return `${type}:${peerId}`
  }

  function discoverName(instanceId, type, peerId) {
    const item = data.discover?.[String(instanceId)]?.[discoverKey(type, peerId)]
    return item?.name || ''
  }

  function upsertDiscover(instanceId, patch = {}) {
    const type = patch.type === 'group' ? 'group' : 'private'
    const peerId = String(patch.peerId || '').trim()
    if (!peerId) return null
    const key = String(instanceId || '')
    if (!data.discover[key]) data.discover[key] = {}
    const bag = data.discover[key]
    const itemKey = discoverKey(type, peerId)
    const previous = bag[itemKey] || { type, peerId }
    const next = {
      ...previous,
      type,
      peerId,
      name: safeString(patch.name || previous.name || '', 80),
      source: patch.source || previous.source || 'message',
      lastText: patch.lastText !== undefined ? safeString(patch.lastText, 120) : previous.lastText || '',
      lastSenderId: patch.lastSenderId !== undefined ? String(patch.lastSenderId || '') : previous.lastSenderId || '',
      lastSenderName: patch.lastSenderName !== undefined ? safeString(patch.lastSenderName, 80) : previous.lastSenderName || '',
      count: Number(previous.count || 0) + (patch.countDelta || (patch.lastText !== undefined ? 1 : 0)),
      bound: patch.bound !== undefined ? patch.bound === true : previous.bound === true,
      firstAt: previous.firstAt || Date.now(),
      lastAt: Date.now(),
    }
    bag[itemKey] = next
    const keys = Object.keys(bag)
    if (keys.length > MAX_DISCOVER) {
      keys
        .sort((a, b) => Number(bag[b]?.lastAt || 0) - Number(bag[a]?.lastAt || 0))
        .slice(MAX_DISCOVER)
        .forEach(old => delete bag[old])
    }
    return next
  }

  function discoverList(instanceId, type = '') {
    const bag = data.discover?.[String(instanceId)] || {}
    return Object.values(bag)
      .filter(item => item && (!type || item.type === type))
      .sort((a, b) => Number(b.lastAt || 0) - Number(a.lastAt || 0))
      .map(item => ({ ...item }))
  }

  function broadcastDiscover(instanceId) {
    hub.broadcast('napcat:discover', {
      instanceId,
      peers: discoverList(instanceId),
      time: Date.now(),
    })
  }

  /* ---------------- WebSocket 连接 ---------------- */

  function stopRuntime(rt, { status = 'offline' } = {}) {
    if (!rt) return
    stopHeartbeatWatchdog(rt)
    // epoch 让旧的重连循环在下一轮检查时主动退出，避免“断开后又被旧循环接回来”。
    rt.epoch = Number(rt.epoch || 0) + 1
    rt.stopping = true
    // 旧循环通过 epoch / stopping 感知退出；这里立即允许下一次 startInstance 建立新循环，
    // 避免“断开后无法再连接”。
    rt.loopActive = false
    rt.listsLoaded = false
    if (rt.restartTimer) {
      clearTimeout(rt.restartTimer)
      rt.restartTimer = null
    }
    const conn = rt.conn
    rt.conn = null
    rt.reverseSocket = null
    try {
      conn?.close?.()
    } catch (_) {
      /* ignore */
    }
    try {
      rt.reverseServer?.close?.()
    } catch (_) {
      /* ignore */
    }
    rt.reverseServer = null
    rt.reverseServerPort = 0
    rt.reverseStarting = null
    for (const waiter of rt.pending.values()) {
      clearTimeout(waiter.timer)
      waiter.resolve({ ok: false, code: 'CLOSED', error: 'NapCat 连接已关闭', data: null })
    }
    rt.pending.clear()
    const record = data.instances[rt.id]
    if (record) setStatus(rt, record.mode === 'reverse' ? 'waiting' : status)
  }

  function startInstance(record) {
    if (!record || closed) return
    const rt = runtimeFor(record.id)
    if (connectionAlive(rt) && record.mode === 'forward') return
    if (record.mode === 'reverse') {
      // reverse 模式由 NapCat 主动连入；念风在本机监听一个独立的反向 WebSocket 端口。
      startReverseServer(record).catch(err => {
        setStatus(rt, 'error', err?.message || String(err))
        ctx.logger.warn(`[napcat] 反向 WebSocket 监听失败：${err?.message || err}`)
      })
      if (rt.status !== 'connecting' && rt.status !== 'online') setStatus(rt, 'waiting')
      return
    }
    if (rt.loopActive) {
      // 旧的 forward 循环正在退出；稍后再启动新配置，避免重复连接。
      if (!rt.restartTimer) {
        rt.restartTimer = setTimeout(() => {
          rt.restartTimer = null
          startInstance(record)
        }, 250)
      }
      return
    }
    startForwardLoop(record)
  }

  function startForwardLoop(record) {
    const rt = runtimeFor(record.id)
    if (rt.loopActive) return
    if (typeof WebSocket !== 'function') {
      setStatus(rt, 'error', '当前 Node 运行时不支持 WebSocket（需要 Node 22+ / 原生 WebSocket），请改用反向 WebSocket 模式')
      return
    }
    rt.loopActive = true
    rt.stopping = false
    const epoch = Number(rt.epoch || 0) + 1
    rt.epoch = epoch
    ;(async () => {
      while (!closed && !rt.stopping && rt.epoch === epoch && data.instances[record.id]) {
        const url = withAccessToken(record.url, record.accessToken)
        if (!url) {
          setStatus(rt, 'error', 'forward 模式缺少 WebSocket 地址')
          break
        }
        setStatus(rt, 'connecting')
        let ws = null
        try {
          ws = new WebSocket(url)
          rt.conn = ws
          await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('连接 NapCat WebSocket 超时（12 秒）')), 12000)
            const onOpen = () => {
              clearTimeout(timer)
              cleanup()
              resolve()
            }
            const onError = () => {
              clearTimeout(timer)
              cleanup()
              reject(new Error('无法连接 NapCat WebSocket，请确认地址、端口和访问令牌'))
            }
            const onClose = () => {
              clearTimeout(timer)
              cleanup()
              reject(new Error('NapCat WebSocket 在握手前被关闭'))
            }
            const cleanup = () => {
              ws.removeEventListener?.('open', onOpen)
              ws.removeEventListener?.('error', onError)
              ws.removeEventListener?.('close', onClose)
            }
            ws.addEventListener('open', onOpen)
            ws.addEventListener('error', onError)
            ws.addEventListener('close', onClose)
          })
          const onMessage = event => {
            let payload = null
            try {
              payload = JSON.parse(typeof event?.data === 'string' ? event.data : String(event?.data ?? ''))
            } catch (_) {
              return
            }
            handlePayload(rt, payload).catch(err => ctx.logger.debug(`[napcat] payload 处理失败：${err?.message || err}`))
          }
          const onClose = () => {
            if (rt.conn === ws) rt.conn = null
          }
          const onError = () => {
            /* close 统一处理 */
          }
          ws.addEventListener('message', onMessage)
          ws.addEventListener('close', onClose)
          ws.addEventListener('error', onError)

          const login = await ensureLoginInfo(rt)
          if (!login) {
            // 有些 NapCat 版本打开后要先等 lifecycle 事件，给一次兜底机会。
            await sleep(800)
            await ensureLoginInfo(rt)
          }
          if (!connectionAlive(rt)) throw new Error('NapCat WebSocket 已断开')
          setStatus(rt, 'online')
          rt.reconnectDelay = 1000
          startHeartbeatWatchdog(rt, () => {
            stopHeartbeatWatchdog(rt, ws)
            try { ws.close(4000, 'heartbeat timeout') } catch (_) { /* ignore */ }
          }, ws)
          await new Promise(resolve => {
            const timer = setInterval(() => {
              if (!connectionAlive(rt)) {
                clearInterval(timer)
                resolve()
              }
            }, 1000)
            ws.addEventListener('close', () => {
              clearInterval(timer)
              resolve()
            }, { once: true })
          })
          stopHeartbeatWatchdog(rt, ws)
          ws.removeEventListener?.('message', onMessage)
          ws.removeEventListener?.('close', onClose)
          ws.removeEventListener?.('error', onError)
        } catch (err) {
          stopHeartbeatWatchdog(rt, ws)
          try {
            ws?.close()
          } catch (_) {
            /* ignore */
          }
          if (rt.conn === ws) rt.conn = null
          if (closed || rt.stopping) break
          setStatus(rt, 'error', err?.message || String(err))
        }
        if (closed || rt.stopping || rt.epoch !== epoch || !data.instances[record.id]) break
        await sleep(rt.reconnectDelay || 1000)
        rt.reconnectDelay = Math.min((rt.reconnectDelay || 1000) * 2, 30000)
      }
      if (rt.epoch === epoch) {
        rt.loopActive = false
        rt.stopping = false
      }
    })()
  }

  function attachReverseSocket(record, rt, socket) {
    const previous = rt.conn
    if (previous) {
      try {
        previous.close()
      } catch (_) {
        /* ignore */
      }
    }
    let closedSocket = false
    let buffer = Buffer.alloc(0)
    const fragments = []
    const conn = {
      readyState: 1,
      reverse: true,
      send(text) {
        if (closedSocket || socket.destroyed) throw new Error('反向 WebSocket 已关闭')
        socket.write(encodeWsFrame(String(text)))
      },
      close() {
        if (closedSocket) return
        stopHeartbeatWatchdog(rt, conn)
        closedSocket = true
        try {
          socket.write(encodeWsFrame(Buffer.alloc(0), 0x8))
        } catch (_) {
          /* ignore */
        }
        socket.destroy()
      },
    }
    rt.conn = conn
    rt.reverseSocket = socket
    rt.stopping = false
    rt.loginPromise = null
    setStatus(rt, 'connecting')

    const close = () => {
      if (closedSocket) return
      closedSocket = true
      const isCurrent = rt.conn === conn
      if (isCurrent) rt.conn = null
      if (rt.reverseSocket === socket) rt.reverseSocket = null
      for (const waiter of rt.pending.values()) {
        clearTimeout(waiter.timer)
        waiter.resolve({ ok: false, code: 'CLOSED', error: 'NapCat 反向连接已断开', data: null })
      }
      rt.pending.clear()
      // 旧连接被新连接替换时，不要覆盖新连接的状态。
      if (isCurrent) {
        if (data.instances[rt.id] && !closed) setStatus(rt, 'waiting', '')
        broadcastInstances()
      }
    }

    const parse = () => {
      while (!closedSocket) {
        if (buffer.length < 2) return
        const first = buffer[0]
        const second = buffer[1]
        const fin = (first & 0x80) !== 0
        const opcode = first & 0x0f
        const masked = (second & 0x80) !== 0
        let length = second & 0x7f
        let offset = 2
        if (length === 126) {
          if (buffer.length < 4) return
          length = buffer.readUInt16BE(2)
          offset = 4
        } else if (length === 127) {
          if (buffer.length < 10) return
          const big = buffer.readBigUInt64BE(2)
          if (big > 16n * 1024n * 1024n) return close()
          length = Number(big)
          offset = 10
        }
        if (!masked) return close()
        if (buffer.length < offset + 4 + length) return
        const mask = buffer.subarray(offset, offset + 4)
        offset += 4
        const payload = Buffer.from(buffer.subarray(offset, offset + length))
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4]
        buffer = buffer.subarray(offset + length)

        if (opcode === 0x8) return close()
        if (opcode === 0x9) {
          try {
            socket.write(encodeWsFrame(payload, 0xa))
          } catch (_) {
            /* ignore */
          }
          continue
        }
        if (opcode === 0xa) continue
        if (opcode === 0x0 || opcode === 0x1 || opcode === 0x2) {
          if (opcode !== 0x0) fragments.length = 0
          fragments.push(payload)
          if (!fin) continue
          const full = Buffer.concat(fragments)
          fragments.length = 0
          let parsed = null
          try {
            parsed = JSON.parse(full.toString('utf8'))
          } catch (_) {
            continue
          }
          handlePayload(rt, parsed).catch(err => ctx.logger.debug(`[napcat] reverse payload 处理失败：${err?.message || err}`))
        }
      }
    }

    const onData = chunk => {
      try {
        buffer = Buffer.concat([buffer, chunk])
        parse()
      } catch (err) {
        ctx.logger.warn(`[napcat] 反向 WebSocket 数据解析失败：${err?.message || err}`)
        close()
      }
    }
    const onError = () => close()
    const onClose = () => close()

    socket.on('data', onData)
    socket.on('error', onError)
    socket.on('close', onClose)

    // 主动询问登录信息并刷新好友 / 群列表，让渠道面板能立刻选择目标。
      startHeartbeatWatchdog(rt, () => {
        stopHeartbeatWatchdog(rt, conn)
        close()
      }, conn)
    ensureLoginInfo(rt).catch(() => {})
  }

  /**
   * 反向 WebSocket：为每个 reverse 实例启动独立监听端口，字段与 NapCat / AstrBot 常用配置对齐：
   *   反向 WebSocket 主机 127.0.0.1
   *   反向 WebSocket 端口 6199（0 = 自动从 6199 起选空闲端口并持久化）
   *   反向 WebSocket Token
   * NapCat 侧配置「WebSocket 客户端」地址：ws://<主机>:<端口>/onebot/v11/ws?access_token=<token>
   * 路径不做限制，/、/ws、/onebot/v11/ws 都能接入，减少不同实现之间的路径差异。
   */
  async function startReverseServer(record) {
    const rt = runtimeFor(record.id)
    if (rt.reverseServer) return rt.reverseServer
    if (rt.reverseStarting) return rt.reverseStarting
    rt.stopping = false
    rt.reverseStarting = startReverseServerInner(record)
    try {
      return await rt.reverseStarting
    } finally {
      rt.reverseStarting = null
    }
  }

  async function startReverseServerInner(record) {
    const rt = runtimeFor(record.id)
    if (rt.reverseServer) return rt.reverseServer
    const epoch = Number(rt.epoch || 0)
    const host = String(record.host || '127.0.0.1').trim() || '127.0.0.1'
    const preferred = Math.max(0, Math.min(65535, Number(record.port) || 0))
    const startPort = preferred > 0 ? preferred : 6199
    const candidates = []
    for (let offset = 0; offset < 80 && startPort + offset <= 65535; offset += 1) candidates.push(startPort + offset)
    let lastError = null
    for (const candidate of candidates) {
      const reverseServer = createHttpServer()
      const onUpgrade = (req, socket) => handleReverseUpgrade(record, rt, req, socket)
      reverseServer.on('upgrade', onUpgrade)
      try {
        await new Promise((resolve, reject) => {
          const onError = err => {
            reverseServer.off('listening', onListening)
            reject(err)
          }
          const onListening = () => {
            reverseServer.off('error', onError)
            resolve()
          }
          reverseServer.once('error', onError)
          reverseServer.once('listening', onListening)
          reverseServer.listen(candidate, host)
        })
        if (rt.stopping || Number(rt.epoch || 0) !== epoch) {
          try {
            reverseServer.close()
          } catch (_) {
            /* ignore */
          }
          throw new Error('NapCat 连接配置已变更，反向监听已取消')
        }
        rt.reverseServer = reverseServer
        rt.reverseServerPort = Number(reverseServer.address()?.port) || candidate
        rt.error = ''
        if (Number(record.port) !== rt.reverseServerPort) {
          record.port = rt.reverseServerPort
          record.updatedAt = Date.now()
          schedulePersist()
        }
        setStatus(rt, connectionAlive(rt) ? 'online' : 'waiting')
        broadcastInstances()
        ctx.logger.info(`[napcat] 反向 WebSocket 监听中：${host}:${rt.reverseServerPort}`)
        return reverseServer
      } catch (err) {
        lastError = err
        try {
          reverseServer.close()
        } catch (_) {
          /* ignore */
        }
      }
    }
    setStatus(rt, 'error', `反向 WebSocket 监听失败：${host}:${startPort} 起 80 个端口都不可用`)
    throw lastError || new Error('无法启动反向 WebSocket 监听端口')
  }

  function handleReverseUpgrade(record, rt, req, socket) {
    try {
      if (!record || record.enabled === false) return rejectUpgrade(socket, 404, 'NapCat instance disabled')
      const url = new URL(req.url || '/', 'http://localhost')
      const queryToken = String(url.searchParams.get('access_token') || url.searchParams.get('token') || '').trim()
      const headerToken = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim()
      const altToken = String(req.headers['x-napcat-token'] || req.headers['x-access-token'] || '').trim()
      const token = queryToken || headerToken || altToken
      if (record.accessToken && token !== record.accessToken) return rejectUpgrade(socket, 401, 'Unauthorized')
      const key = String(req.headers['sec-websocket-key'] || '').trim()
      if (!key) return rejectUpgrade(socket, 400, 'Missing Sec-WebSocket-Key')
      writeWsUpgrade(socket, key)
      socket.setNoDelay?.(true)
      attachReverseSocket(record, rt, socket)
    } catch (_) {
      rejectUpgrade(socket, 400, 'Bad Request')
    }
  }

  function setupReverseServer() {
    if (!server || upgradeHandler) return
    upgradeHandler = (req, socket) => {
      let url = null
      try {
        url = new URL(req.url || '/', 'http://localhost')
      } catch (_) {
        return rejectUpgrade(socket, 400, 'Bad Request')
      }
      if (url.pathname !== WS_PATH) {
        // 当前版本没有其它 WebSocket 端点；未知 upgrade 直接断开，避免连接悬挂。
        return rejectUpgrade(socket, 404, 'Not Found')
      }
      const instanceId = String(url.searchParams.get('instance') || '').trim()
      const queryToken = String(url.searchParams.get('access_token') || url.searchParams.get('token') || '').trim()
      const headerToken = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim()
      const altToken = String(req.headers['x-napcat-token'] || req.headers['x-access-token'] || '').trim()
      const token = queryToken || headerToken || altToken

      let record = instanceId ? data.instances[instanceId] : null
      if (!record && token) {
        record = Object.values(data.instances).find(item => item.mode === 'reverse' && item.accessToken && item.accessToken === token) || null
      }
      if (!record) {
        const reverseRecords = Object.values(data.instances).filter(item => item.mode === 'reverse')
        if (reverseRecords.length === 1 && !reverseRecords[0].accessToken) record = reverseRecords[0]
      }
      if (!record || record.mode !== 'reverse' || record.enabled === false) {
        return rejectUpgrade(socket, 404, 'NapCat instance not found or disabled')
      }
      if (record.accessToken && token !== record.accessToken) {
        return rejectUpgrade(socket, 401, 'Unauthorized')
      }
      const key = String(req.headers['sec-websocket-key'] || '').trim()
      if (!key) return rejectUpgrade(socket, 400, 'Missing Sec-WebSocket-Key')
      try {
        writeWsUpgrade(socket, key)
      } catch (_) {
        return socket.destroy()
      }
      socket.setNoDelay?.(true)
      attachReverseSocket(record, runtimeFor(record.id), socket)
    }
    server.on('upgrade', upgradeHandler)
  }

  /* ---------------- 发送 ---------------- */

  async function resolveImageBase64(image) {
    if (!image) return null
    if (typeof image === 'object' && image.id) {
      const found = await readImageBuffer(settings.dataDir, image.id)
      if (found?.buffer) return { base64: found.buffer.toString('base64'), mime: found.record?.mime || image.mime || 'image/jpeg' }
    }
    const source = typeof image === 'string' ? image : image.dataUrl || image.url || image.base64 || ''
    if (!source) return null
    if (/^data:/i.test(source)) {
      const match = source.match(/^data:([^;,]+)?(;base64)?,([\s\S]*)$/)
      if (!match) return null
      const base64 = match[2] ? match[3].replace(/\s+/g, '') : Buffer.from(decodeURIComponent(match[3]), 'utf8').toString('base64')
      if (Buffer.byteLength(base64, 'base64') > MAX_MEDIA_BYTES) return null
      return { base64, mime: image.mime || match[1] || 'image/jpeg' }
    }
    if (/^https?:\/\//i.test(source)) {
      const buffer = await imageBufferOf({ url: source })
      if (!buffer) return null
      return { base64: buffer.toString('base64'), mime: image.mime || 'image/jpeg' }
    }
    const base64 = String(source).replace(/\s+/g, '')
    if (Buffer.byteLength(base64, 'base64') > MAX_MEDIA_BYTES) return null
    return { base64, mime: image.mime || 'image/jpeg' }
  }

  function splitText(text, max = TEXT_CHUNK) {
    const value = String(text || '').trim()
    if (!value) return []
    const parts = []
    let current = ''
    for (const line of value.split('\n')) {
      const next = current ? `${current}\n${line}` : line
      if (next.length <= max) {
        current = next
        continue
      }
      if (current) parts.push(current)
      let rest = line
      while (rest.length > max) {
        parts.push(rest.slice(0, max))
        rest = rest.slice(max)
      }
      current = rest
    }
    if (current) parts.push(current)
    return parts
  }

  async function sendChannelMessage(body = {}) {
    const channelId = String(body.channelId || '').trim()
    const channel = channelId ? data.channels[channelId] : null
    const instanceId = String(body.instanceId || channel?.instanceId || '').trim()
    const record = data.instances[instanceId]
    if (!record) return { ok: false, code: 'NO_INSTANCE', error: '找不到对应的 NapCat 连接' }
    const rt = runtimeFor(record.id)
    if (!connectionAlive(rt)) return { ok: false, code: 'OFFLINE', error: 'NapCat 连接未就绪，请先在渠道详情里完成连接' }

    const targetType = body.targetType === 'group' || (!body.targetType && channel?.targetType === 'group') ? 'group' : 'private'
    const targetId = toNumericId(body.targetId ?? channel?.targetId)
    if (!targetId) return { ok: false, code: 'BAD_TARGET', error: '目标 QQ 号 / 群号不合法' }

    const text = String(body.text || '')
    const images = Array.isArray(body.images) ? body.images.slice(0, MAX_IMAGES) : []
    const quoteMsgId = String(body.quoteMsgId || '').trim()
    const mentionUserId = toNumericId(body.mentionUserId)
    // 含 CQ 码 / [at:qq] 时按消息段发送；纯文本保持原来的分块逻辑不变。
    const richSegments = parseOutboundSegments(text)
    if (richSegments === null && !splitText(text).length && !images.length) {
      return { ok: false, code: 'EMPTY', error: '消息内容为空' }
    }
    if (richSegments !== null && !richSegments.length && !images.length) {
      return { ok: false, code: 'EMPTY', error: '消息内容为空，或 CQ 类型不被允许' }
    }

    const batches = richSegments === null
      ? splitText(text).map(chunk => [{ type: 'text', data: { text: chunk } }])
      : batchOutboundSegments(richSegments)
    if (!batches.length) batches.push([])

    const sent = []
    for (let index = 0; index < batches.length; index += 1) {
      const segments = [...batches[index]]
      if (index === 0 && quoteMsgId && targetType === 'group' && !segments.some(segment => segment.type === 'reply')) {
        segments.unshift({ type: 'reply', data: { id: quoteMsgId } })
      }
      if (index === 0 && mentionUserId && targetType === 'group') {
        segments.splice(segments[0]?.type === 'reply' ? 1 : 0, 0, { type: 'at', data: { qq: mentionUserId } })
      }
      if (targetType !== 'group') {
        // 私聊没有 @ 语义：CQ at 降级成可读文本，避免部分 NapCat 版本直接报错。
        for (let i = 0; i < segments.length; i += 1) {
          if (segments[i].type !== 'at') continue
          const qq = String(segments[i].data?.qq || '')
          segments[i] = { type: 'text', data: { text: `@${qq === 'all' ? '全体成员' : qq} ` } }
        }
      }
      if (index === batches.length - 1) {
        for (const image of images) {
          const media = await resolveImageBase64(image)
          if (media) segments.push({ type: 'image', data: { file: `base64://${media.base64}` } })
        }
      }
      if (!segments.length) continue
      const action = targetType === 'group' ? 'send_group_msg' : 'send_private_msg'
      const params = targetType === 'group' ? { group_id: Number(targetId), message: segments } : { user_id: Number(targetId), message: segments }
      const result = await sendAction(rt, action, params)
      if (actionFail(result)) {
        return { ok: false, code: result?.code || 'SEND_FAILED', error: result?.error || result?.message || 'NapCat 发送失败', data: result?.data || null }
      }
      sent.push(result.data?.message_id ?? result.data?.messageId ?? null)
    }
    if (!sent.length) return { ok: false, code: 'EMPTY', error: '消息内容为空或全部被过滤' }
    return { ok: true, messageIds: sent, messageId: sent[0] ?? null, count: sent.length }
  }

  /* ---------------- HTTP API ---------------- */

  const resolveInstance = value => {
    const id = String(value || '').trim()
    return data.instances[id] || null
  }

  const routes = []

  const route = (method, path, handler) => {
    routes.push(httpApi.route(method, path, handler))
  }

  route('GET', '/api/napcat/instances', async (req, res) => {
    await ready
    httpApi.sendJson(res, 200, { ok: true, instances: listInstances() })
  })

  route('POST', '/api/napcat/instances', async (req, res) => {
    await ready
    const body = await httpApi.readBody(req)
    const mode = body.mode === 'reverse' ? 'reverse' : 'forward'
    const requestedId = String(body.id || '').trim()
    const url = mode === 'forward' ? normalizeForwardUrl(body.url) : ''
    const previous = requestedId ? data.instances[requestedId] || null : null
    const providedToken = body.accessToken ?? body.token
    // 编辑时留空表示“沿用原令牌”，而不是把令牌删掉；新建且留空则保持空，
    // 兼容已有 NapCat 反向 WebSocket（很多内网场景不配 Token，直接连即可）。
    const accessToken = providedToken !== undefined ? String(providedToken || '').trim() : String(previous?.accessToken || '').trim()
    if (mode === 'forward' && !url) return httpApi.sendError(res, 400, 'forward 模式需要 WebSocket 地址')

    // 避免同一台 NapCat 被创建出多条重复连接：地址与令牌相同的 forward 实例直接复用。
    if (!requestedId) {
      for (const existing of Object.values(data.instances)) {
        if (existing.mode !== 'forward' || mode !== 'forward') continue
        if (normalizeForwardUrl(existing.url) !== url) continue
        if (String(existing.accessToken || '') !== accessToken) continue
        if (body.remark !== undefined) existing.remark = safeString(body.remark, 60)
        existing.updatedAt = Date.now()
        schedulePersist()
        if (body.autoConnect !== false && existing.enabled !== false) startInstance(existing)
        return httpApi.sendJson(res, 200, { ok: true, reused: true, instance: publicInstance(existing) })
      }
    }

    const id = requestedId || randomId()
    const record = normalizeInstance({
      ...(previous || {}),
      ...body,
      id,
      mode,
      url,
      accessToken,
      createdAt: previous?.createdAt || Date.now(),
      updatedAt: Date.now(),
    })
    if (previous) {
      const changed =
        previous.mode !== record.mode ||
        normalizeForwardUrl(previous.url) !== record.url ||
        String(previous.accessToken || '') !== record.accessToken ||
        (record.mode === 'reverse' &&
          (String(previous.host || '') !== record.host || Number(previous.port || 0) !== record.port || normalizeReversePath(previous.path) !== record.path))
      if (changed) stopRuntime(runtimeFor(id))
    }
    data.instances[id] = record
    const rt = runtimeFor(id)
    rt.listsLoaded = false
    schedulePersist()
    if (record.enabled === false) {
      stopRuntime(rt, { status: 'offline' })
    } else if (record.autoConnect !== false) {
      startInstance(record)
    } else if (record.mode === 'reverse') {
      setStatus(rt, 'waiting')
    } else {
      setStatus(rt, 'offline')
    }
    httpApi.sendJson(res, 200, { ok: true, reused: false, instance: publicInstance(record) })
  })

  route('POST', '/api/napcat/instances/:id/connect', async (req, res, params) => {
    await ready
    const record = resolveInstance(params.id)
    if (!record) return httpApi.sendError(res, 404, '连接不存在')
    record.enabled = true
    record.autoConnect = true
    record.updatedAt = Date.now()
    schedulePersist()
    startInstance(record)
    httpApi.sendJson(res, 200, { ok: true, instance: publicInstance(record) })
  })

  route('POST', '/api/napcat/instances/:id/disconnect', async (req, res, params) => {
    await ready
    const record = resolveInstance(params.id)
    if (!record) return httpApi.sendError(res, 404, '连接不存在')
    const body = await httpApi.readBody(req)
    if (body.keepConfig !== false) record.autoConnect = false
    record.updatedAt = Date.now()
    stopRuntime(runtimeFor(record.id), { status: 'offline' })
    schedulePersist()
    httpApi.sendJson(res, 200, { ok: true, instance: publicInstance(record) })
  })

  route('DELETE', '/api/napcat/instances/:id', async (req, res, params) => {
    await ready
    const record = resolveInstance(params.id)
    if (!record) return httpApi.sendError(res, 404, '连接不存在')
    const used = channelIdsOf(record.id)
    if (used.length) {
      return httpApi.sendError(res, 400, `仍有 ${used.length} 个渠道在使用该连接，请先修改或删除这些渠道`)
    }
    stopRuntime(runtimeFor(record.id))
    runtime.delete(record.id)
    delete data.instances[record.id]
    delete data.discover[record.id]
    schedulePersist()
    broadcastInstances()
    httpApi.sendJson(res, 200, { ok: true })
  })

  route('POST', '/api/napcat/instances/:id/refresh', async (req, res, params) => {
    await ready
    const record = resolveInstance(params.id)
    if (!record) return httpApi.sendError(res, 404, '连接不存在')
    const rt = runtimeFor(record.id)
    if (!connectionAlive(rt)) {
      startInstance(record)
      return httpApi.sendJson(res, 200, { ok: true, status: publicInstance(record), login: rt.login, peers: discoverList(record.id) })
    }
    rt.listsLoaded = false
    await ensureLoginInfo(rt)
    await refreshInstanceLists(rt)
    httpApi.sendJson(res, 200, {
      ok: true,
      status: publicInstance(record),
      login: rt.login,
      peers: discoverList(record.id),
    })
  })

  route('GET', '/api/napcat/instances/:id/status', async (req, res, params) => {
    await ready
    const record = resolveInstance(params.id)
    if (!record) return httpApi.sendError(res, 404, '连接不存在')
    const rt = runtimeFor(record.id)
    httpApi.sendJson(res, 200, {
      ok: true,
      status: publicInstance(record, rt),
      login: rt.login,
      peers: discoverList(record.id),
    })
  })

  route('POST', '/api/napcat/instances/:id/endpoint', async (req, res, params) => {
    await ready
    const record = resolveInstance(params.id)
    if (!record) return httpApi.sendError(res, 404, '连接不存在')
    if (record.mode !== 'reverse') return httpApi.sendError(res, 400, '只有反向 WebSocket 模式需要连接地址')
    const body = await httpApi.readBody(req)
    try {
      await startReverseServer(record)
    } catch (err) {
      return httpApi.sendError(res, 503, `反向 WebSocket 监听启动失败：${err?.message || err}`)
    }
    const rt = runtimeFor(record.id)
    const rawHost = String(record.host || '127.0.0.1').trim() || '127.0.0.1'
    const host =
      rawHost === '0.0.0.0' || rawHost === '::'
        ? String(body.clientHost || '').trim() || '127.0.0.1'
        : rawHost
    const port = Number(rt.reverseServerPort || record.port) || 0
    const path = normalizeReversePath(record.path || body.path)
    const simpleUrl = `ws://${host}:${port}${path}`
    const token = String(record.accessToken || '')
    const url = token ? `${simpleUrl}?access_token=${encodeURIComponent(token)}` : simpleUrl
    httpApi.sendJson(res, 200, {
      ok: true,
      url,
      simpleUrl,
      host,
      port,
      path,
      token,
      hasToken: !!token,
      // 兼容旧版主 HTTP 服务上的 /api/napcat/ws 接入点，已经不用的话可以忽略。
      legacyUrl: `${trimSlash(String(body.baseUrl || `http://127.0.0.1:${http?.port?.() || 8788}`).replace(/^https:\/\//i, 'wss://').replace(/^http:\/\//i, 'ws://'))}${WS_PATH}?instance=${encodeURIComponent(record.id)}${token ? `&access_token=${encodeURIComponent(token)}` : ''}`,
    })
  })

  route('POST', '/api/napcat/instances/:id/action', async (req, res, params) => {
    await ready
    const record = resolveInstance(params.id)
    if (!record) return httpApi.sendError(res, 404, '连接不存在')
    const body = await httpApi.readBody(req)
    const action = String(body.action || '').trim()
    if (!action) return httpApi.sendError(res, 400, '缺少 action')
    const rt = runtimeFor(record.id)
    if (!connectionAlive(rt)) return httpApi.sendJson(res, 200, { ok: false, code: 'OFFLINE', error: 'NapCat 未连接', data: null })
    const result = await sendAction(rt, action, body.params || {})
    httpApi.sendJson(res, 200, result)
  })

  /** 转发聊天记录深读：只按 offset / limit 返回一小页，支持嵌套层按 id 继续读取。 */
  route('POST', '/api/napcat/forward/read', async (req, res) => {
    await ready
    const body = await httpApi.readBody(req, 256 * 1024)
    const forwardId = String(body.id || body.forward_id || body.forwardId || '').trim()
    if (!forwardId) return httpApi.sendError(res, 400, '缺少转发记录 id')
    let record = await loadForwardRecord(forwardId)
    if (!record || !Array.isArray(record.items)) {
      const requestedInstanceId = String(body.instanceId || '').trim()
      let instance = requestedInstanceId ? resolveInstance(requestedInstanceId) : null
      if (!instance) {
        instance = Object.values(data.instances).find(item => connectionAlive(runtimeFor(item.id))) || null
      }
      if (!instance) return httpApi.sendJson(res, 200, { ok: false, code: 'NO_INSTANCE', error: '转发记录不存在，且没有可用的 NapCat 连接回源读取', data: null })
      const { items, error } = await fetchForwardItems(runtimeFor(instance.id), { id: forwardId })
      if (!items.length) return httpApi.sendJson(res, 200, { ok: false, code: 'READ_FAILED', error: error || '转发内容为空', data: null })
      record = {
        version: 1,
        id: forwardId,
        title: '聊天记录',
        instanceId: instance.id,
        createdAt: Date.now(),
        total: items.length,
        imageTotal: items.reduce((sum, item) => sum + (Number(item.image_count) || 0), 0),
        items,
      }
      await saveForwardRecord(record)
    }
    const storedTotal = record.items.length
    const total = Math.max(storedTotal, Number(record.total) || 0)
    const offset = Math.max(0, Math.min(total, Number(body.offset) || 0))
    const limit = Math.max(1, Math.min(20, Number(body.limit) || 5))
    const textOffset = Math.max(0, Number(body.text_offset) || 0)
    const page = record.items.slice(offset, offset + limit)
    const includeImages = body.include_images === true || String(body.include_images) === 'true'
    const imageLimit = includeImages ? Math.max(0, Math.min(FORWARD_PREVIEW_IMAGES, Number(body.image_limit) || FORWARD_PREVIEW_IMAGES)) : 0
    const imagesShown = imageLimit > 0 ? await attachForwardImages(page, imageLimit) : 0
      const items = page.map((item, pageIndex) => {
        const fullText = String(item.text || "")
        const start = pageIndex === 0 ? Math.min(textOffset, fullText.length) : 0
        const text = fullText.slice(start, start + MAX_FORWARD_TOOL_ITEM_CHARS)
        return {
          ...forwardItemBaseForTool(item),
          text,
          text_offset: start || undefined,
          text_length: fullText.length || undefined,
          text_truncated: start + text.length < fullText.length || undefined,
          image_available: Array.isArray(item.image_sources) ? item.image_sources.length : Number(item.image_count) || 0,
        }
      })
      const firstFullText = String(page[0]?.text || "")
      const firstStart = page.length ? Math.min(textOffset, firstFullText.length) : 0
      const firstReturned = page.length ? Math.min(MAX_FORWARD_TOOL_ITEM_CHARS, Math.max(0, firstFullText.length - firstStart)) : 0
      const nextTextOffset = page.length && firstFullText.length > firstStart + firstReturned ? firstStart + firstReturned : null
    httpApi.sendJson(res, 200, {
      ok: true,
      id: String(record.id || forwardId),
      instance_id: String(record.instanceId || ''),
      title: record.title || '聊天记录',
      total,
      offset,
      limit,
      next_offset: offset + page.length < storedTotal ? offset + page.length : null,
      next_text_offset: nextTextOffset,
      has_more: offset + page.length < storedTotal,
      truncated: record.truncated || undefined,
      items,
      images_shown: imagesShown,
      hint: record.truncated
        ? '这段转发原始消息过多，服务端只缓存了前面一部分；继续按 next_offset 读取缓存内容，但更深的部分可能无法再取。'
        : '继续读取请带同一个 id 与 next_offset；如果 items[].text_truncated=true，说明单条文本很长，请带同一个 offset、limit=1、text_offset=next_text_offset 继续读取正文，直到 next_text_offset=null。items[].nested_forward.id 可作为新的 id 继续读取嵌套转发。图片默认不读，确需时 include_images=true 且 image_limit≤2，非必要不要读取。',
    })
  })


  route('GET', '/api/napcat/discover', async (req, res, params, url) => {
    await ready
    const instanceId = String(url.searchParams.get('instanceId') || '').trim()
    if (!instanceId || !data.instances[instanceId]) return httpApi.sendError(res, 404, '连接不存在')
    httpApi.sendJson(res, 200, { ok: true, peers: discoverList(instanceId, String(url.searchParams.get('type') || '')) })
  })

  route('POST', '/api/napcat/channels/sync', async (req, res) => {
    await ready
    const body = await httpApi.readBody(req)
    const channelId = String(body.channelId || '').trim()
    if (!channelId) return httpApi.sendError(res, 400, '缺少 channelId')
    const instanceId = String(body.instanceId || '').trim()
    if (!instanceId || !data.instances[instanceId]) return httpApi.sendError(res, 400, '请先选择 / 创建可用的 NapCat 连接')
    const targetType = body.targetType === 'group' ? 'group' : 'private'
    const targetId = toNumericId(body.targetId)
    if (!targetId) return httpApi.sendError(res, 400, targetType === 'group' ? '群号不合法' : '目标 QQ 号不合法')
    if (targetType === 'group' && body.category !== 'group') {
      return httpApi.sendError(res, 400, '群聊目标必须使用群聊分类')
    }
    const channel = normalizeChannel({
      ...(data.channels[channelId] || {}),
      ...body,
      channelId,
      instanceId,
      targetType,
      targetId,
      updatedAt: Date.now(),
    })
    data.channels[channelId] = channel
    upsertDiscover(instanceId, {
      type: targetType,
      peerId: targetId,
      name: discoverName(instanceId, targetType, targetId) || (targetType === 'group' ? `群 ${targetId}` : `QQ ${targetId}`),
      bound: true,
    })
    schedulePersist()
    broadcastDiscover(instanceId)
    httpApi.sendJson(res, 200, { ok: true, channel, instance: publicInstance(data.instances[instanceId]) })
  })

  route('POST', '/api/napcat/channels/remove', async (req, res) => {
    await ready
    const body = await httpApi.readBody(req)
    const channelId = String(body.channelId || '').trim()
    if (!channelId) return httpApi.sendError(res, 400, '缺少 channelId')
    const channel = data.channels[channelId]
    delete data.channels[channelId]
    for (let index = inbox.length - 1; index >= 0; index--) {
      if (inbox[index].channelId === channelId) inbox.splice(index, 1)
    }
    if (channel?.instanceId) {
      try {
        const key = discoverKey(channel.targetType, channel.targetId)
        if (data.discover[channel.instanceId]?.[key]) data.discover[channel.instanceId][key].bound = false
      } catch (_) {
        /* ignore */
      }
    }
    schedulePersist()
    httpApi.sendJson(res, 200, { ok: true })
  })

  route('POST', '/api/napcat/channels/prune', async (req, res) => {
    await ready
    const body = await httpApi.readBody(req)
    const keep = new Set((Array.isArray(body.channelIds) ? body.channelIds : []).map(item => String(item || '')))
    let removed = 0
    for (const channelId of Object.keys(data.channels)) {
      if (!keep.has(channelId)) {
        delete data.channels[channelId]
        removed += 1
      }
    }
    if (removed) {
      for (let index = inbox.length - 1; index >= 0; index--) {
        if (!keep.has(inbox[index].channelId)) inbox.splice(index, 1)
      }
      schedulePersist()
    }
    httpApi.sendJson(res, 200, { ok: true, removed })
  })

  route('GET', '/api/napcat/status', async (req, res, params, url) => {
    await ready
    const channelId = String(url.searchParams.get('channelId') || '').trim()
    const instanceId = String(url.searchParams.get('instanceId') || '').trim()
    const channel = channelId ? data.channels[channelId] : null
    const id = instanceId || channel?.instanceId || ''
    const record = data.instances[id]
    if (!record) return httpApi.sendJson(res, 200, { ok: false, code: 'NO_INSTANCE', status: 'offline', error: '' })
    httpApi.sendJson(res, 200, {
      ok: true,
      status: publicInstance(record),
      channel: channel || null,
      peers: discoverList(id),
    })
  })

  route('GET', '/api/napcat/inbox', async (req, res, params, url) => {
    await ready
    const channelId = String(url.searchParams.get('channelId') || '').trim()
    if (!channelId) return httpApi.sendError(res, 400, '缺少 channelId')
    const messages = inbox.filter(item => item.channelId === channelId).map(item => ({ id: item.id, message: item.message }))
    httpApi.sendJson(res, 200, { ok: true, messages })
  })

  route('POST', '/api/napcat/inbox/ack', async (req, res) => {
    await ready
    const body = await httpApi.readBody(req)
    const channelId = String(body.channelId || '').trim()
    const ids = new Set((Array.isArray(body.ids) ? body.ids : []).map(item => String(item || '')))
    if (!channelId) return httpApi.sendError(res, 400, '缺少 channelId')
    for (let index = inbox.length - 1; index >= 0; index--) {
      const item = inbox[index]
      if (item.channelId !== channelId) continue
      if (ids.has(String(item.id)) || ids.has(String(item.message?.id || ''))) inbox.splice(index, 1)
    }
    httpApi.sendJson(res, 200, { ok: true })
  })

  route('POST', '/api/napcat/send', async (req, res) => {
    await ready
    const body = await httpApi.readBody(req)
    const result = await sendChannelMessage(body)
    if (!result.ok) {
      const status = result.code === 'OFFLINE' || result.code === 'NO_INSTANCE' ? 503 : 400
      return httpApi.sendJson(res, status, result)
    }
    httpApi.sendJson(res, 200, result)
  })

  /* ---------------- 启动 / 清理 ---------------- */

  ready = loadState()
    .then(async () => {
      setupReverseServer()
      // 持久化一次，补上旧版本缺省字段 / 把明文 token 改为密文。
      await persist({ force: true })
      for (const record of Object.values(data.instances)) {
        if (record.enabled === false || record.autoConnect === false) continue
        try {
          startInstance(record)
        } catch (err) {
          ctx.logger.warn(`[napcat] 启动连接 ${record.id} 失败：${err?.message || err}`)
        }
      }
      broadcastInstances()
      ctx.logger.info(`[napcat] 后端桥就绪，共 ${Object.keys(data.instances).length} 个连接、${Object.keys(data.channels).length} 个渠道`)
    })
    .catch(err => {
      ctx.logger.error(`[napcat] 状态加载失败：${err?.message || err}`)
    })

  ctx.provide('napcat', {
    name: 'napcat',
    version,
    ready: () => ready,
    listInstances,
    instanceStatus: instanceId => {
      const record = resolveInstance(instanceId)
      return record ? publicInstance(record, runtimeFor(record.id)) : null
    },
    peers: instanceId => discoverList(instanceId),
    channels: () => Object.values(data.channels).map(channel => ({ ...channel })),
    send: body => ready.then(() => sendChannelMessage(body)),
    action: (instanceId, action, params) =>
      ready.then(() => {
        const record = resolveInstance(instanceId)
        if (!record) return { ok: false, code: 'NO_INSTANCE', error: '连接不存在', data: null }
        return sendAction(runtimeFor(record.id), String(action || ''), params || {})
      }),
  })

  ctx.effect(() => () => {
    closed = true
    if (persistTimer) clearTimeout(persistTimer)
    if (upgradeHandler && server) {
      try {
        server.off('upgrade', upgradeHandler)
      } catch (_) {
        /* ignore */
      }
      upgradeHandler = null
    }
    for (const rt of runtime.values()) {
      try {
        stopRuntime(rt)
      } catch (_) {
        /* ignore */
      }
    }
    runtime.clear()
    inbox.length = 0
  })
}
