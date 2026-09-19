/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 *
 * QQ 官方机器人后端桥（QQBot OpenAPI v2）。
 *
 * 协议入口：
 *   - access_token：POST https://bots.qq.com/app/getAppAccessToken { appId, clientSecret }
 *   - WebSocket 网关：GET /gateway/bot -> { url, shards }，op 2 Identify / op 1 Heartbeat / op 0 Dispatch
 *   - 发送消息：POST /v2/users/{openid}/messages（私聊）
 *                POST /v2/groups/{group_openid}/messages（群聊）
 *   - 富媒体上传：POST /v2/users/{openid}/files 或 /v2/groups/{group_openid}/files
 *                file_type=1 图片、3 SILK 语音；发送用 msg_type=7 + media.file_info
 *   - Webhook：POST <本机>/api/qqbot/webhook，op=13 回调校验（Ed25519），op=12 ACK
 *
 * 会话判定（官方事件类型，不是猜的）：
 *   C2C_MESSAGE_CREATE       私聊：author.user_openid / author.id
 *   GROUP_AT_MESSAGE_CREATE  群聊：group_openid + author.member_openid（@机器人 时触发；群昵称 best-effort）
 *   GROUP_MESSAGE_CREATE     群聊全量消息：群管理员开启「机器人可获取群内全部消息」后，未 @ 的消息也走这里
 *   AT_MESSAGE_CREATE        频道：channel_id + author.id
 *   DIRECT_MESSAGE_CREATE    频道私信：guild_id + author.id
 *   intents：1<<25 群/C2C、1<<30 公域频道消息、1<<12 频道私信
 *
 * 「扫码接入」说明：
 *   手机 QQ「联系人 -> 机器人 -> 机器人详情 -> 扫码」不是 QQBot OpenAPI 本身，
 *   而是参考实现（QClaw / hermes / openclaw）额外封装的授权流程。本桥把它抽象为
 *   qr 适配器：只要外部 link 服务在确认后返回 appId/appSecret（或 accessToken），
 *   就复用同一条 OpenAPI 链路。具体端点可在渠道里配置 baseUrl / createPath / pollPath；
 *   未配置时前端会明确提示，而不是假装可用。
 *
 * 该文件只被 Node 后端加载（server/index.mjs 自动扫描 plugins/channels/**\/bridge.mjs）。
 */
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { readImageBuffer, saveImageBuffer } from '../../domain/image-service/store.mjs'
import { fetchWithNetworkRetry, networkErrorText } from '../request-utils.mjs'
import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign as cryptoSign,
  verify as cryptoVerify,
} from 'node:crypto'

export const name = 'qqbot-bridge'
export const version = '1.5.0'
export const displayName = 'QQ 官方机器人后端桥'
export const description = '渠道后端 · QQ 官方机器人登录、WebSocket / Webhook 事件、私聊 / 群聊绑定过滤、群成员昵称、多机器人联动、SILK 语音与消息发送。'
export const core = false
export const inject = ['settings', 'hub', 'httpApi']
export const provides = [{ name: 'qqbot', type: 'singleton' }]

/* ------------------------------------------------------------------ */
/* 协议常量                                                             */
/* ------------------------------------------------------------------ */

// 官方文档当前口径：凭证与 OpenAPI 统一使用 api.bot.qq.com；旧域名 bots.qq.com /
// api.sgroup.qq.com 仍可用，作为失败时的回退，避免用户侧 DNS / 线路差异导致直接不可用。
const ENV_TOKEN_URL = String(process.env.NIANFENG_QQBOT_TOKEN_URL || '').trim()
const ENV_API_BASE = trimSlash(process.env.NIANFENG_QQBOT_API_BASE || '')
const ENV_SANDBOX_API_BASE = trimSlash(process.env.NIANFENG_QQBOT_SANDBOX_API_BASE || '')
const TOKEN_URLS = ENV_TOKEN_URL
  ? [ENV_TOKEN_URL]
  : ['https://api.bot.qq.com/app/getAppAccessToken', 'https://bots.qq.com/app/getAppAccessToken']
const API_BASES = ENV_API_BASE ? [ENV_API_BASE] : ['https://api.bot.qq.com', 'https://api.sgroup.qq.com']
const SANDBOX_API_BASES = ENV_SANDBOX_API_BASE ? [ENV_SANDBOX_API_BASE] : ['https://sandbox.api.sgroup.qq.com']
const DEFAULT_BIND_HOST = String(process.env.NIANFENG_QQBOT_BIND_HOST || 'q.qq.com').trim() || 'q.qq.com'

const INTENT_GROUP_AND_C2C = 1 << 25
const INTENT_PUBLIC_GUILD_MESSAGES = 1 << 30
const INTENT_DIRECT_MESSAGE = 1 << 12
const DEFAULT_INTENTS = INTENT_GROUP_AND_C2C

const SESSION_TYPES = ['c2c', 'group', 'guild', 'guild-dm']
const SESSION_LABEL = { c2c: '私聊', group: '群聊', guild: '频道', 'guild-dm': '频道私信' }
const EVENT_SESSION = {
  C2C_MESSAGE_CREATE: 'c2c',
  GROUP_AT_MESSAGE_CREATE: 'group',
  // 群聊全量消息事件：QQ 群开启「机器人可获取群内全部消息」后推送未 @ 的消息。
  GROUP_MESSAGE_CREATE: 'group',
  AT_MESSAGE_CREATE: 'guild',
  DIRECT_MESSAGE_CREATE: 'guild-dm',
}
/**
 * 事件类型 -> 会话类型。
 *
 * 优先用官方事件名；群聊全量消息在不同 SDK / 文档版本里可能叫
 * GROUP_MESSAGE_CREATE / GROUP_MESSAGE_CREATE_V2 等，先按前缀兜底；
 * 最后再用 payload 结构兜底，避免 QQ 改名后整类消息被直接丢弃。
 */
const sessionTypeForEvent = (eventType, payload) => {
  const type = String(eventType || '')
  if (EVENT_SESSION[type]) return EVENT_SESSION[type]
  if (/^GROUP_.*(?:MESSAGE|MSG).*CREATE$/.test(type)) return 'group'
  if (payload && typeof payload === 'object') {
    const data = payload.message && typeof payload.message === 'object' ? payload.message : payload
    const author = data.author || data.member || data.sender || payload.author || {}
    const hasId = data.id !== undefined || data.message_id !== undefined || payload.id !== undefined
    const groupId = data.group_openid || data.group_id || payload.group_openid
    if (hasId && groupId && (author.member_openid || author.user_openid || author.id)) return 'group'
  }
  return ''
}
const LIFECYCLE_EVENTS = new Set([
  'GROUP_ADD_ROBOT',
  'GROUP_DEL_ROBOT',
  'FRIEND_ADD',
  'FRIEND_DEL',
  'GROUP_MSG_RECEIVE',
  'GROUP_MSG_REJECT',
  'C2C_MSG_RECEIVE',
  'C2C_MSG_REJECT',
])

/** 被动回复窗口：官方文档口径为群 5 分钟；单聊在部分文档/实测中为 60 分钟，留成可配置。 */
const PASSIVE_TTL = { group: 5 * 60 * 1000, c2c: 60 * 60 * 1000, guild: 5 * 60 * 1000, 'guild-dm': 5 * 60 * 1000 }
const PASSIVE_MAX_REPLIES = 5
const MAX_MESSAGE_CHARS = 4000
const MAX_INBOX = 200
const MAX_SEEN = 500
const MAX_DISCOVER = 60
const MAX_IMAGES_PER_MESSAGE = 4
const MAX_MEDIA_BYTES = 4 * 1024 * 1024

const ENC_PREFIX = 'enc:v1:'
const STATE_FILE = 'qqbot.json'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
function trimSlash(value) {
  return String(value || '').replace(/\/+$/, '')
}
function nowIso() {
  return new Date().toISOString()
}
function safeString(value, max = 500) {
  return String(value ?? '').slice(0, max)
}

/** 事件里的 QQ openid 是稳定的；消息 id 用于去重与被动回复。 */
function messageKey(sessionType, peerId, qqMessageId, fallback) {
  const raw = qqMessageId || fallback
  return `qq-${sessionType}-${peerId}-${raw}`
}

function normalizeEventText(input, botName = '') {
  let text = String(input || '')
  // 频道/群聊事件里可能带 <@!123> / <@123> 这样的 mention
  text = text.replace(/<@!?[A-Za-z0-9_-]+>/g, '')
  const name = String(botName || '').trim()
  if (name) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    text = text.replace(new RegExp(`^\\s*@${escaped}\\s*`, 'u'), '')
  }
  return text.trim()
}

function parseEventTime(value) {
  if (!value) return Date.now()
  if (typeof value === 'number') return value < 1e12 ? value * 1000 : value
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? Date.now() : parsed
}

function publicInbound(message) {
  if (!message) return null
  return {
    id: message.id,
    channelId: message.channelId || '',
    sessionType: message.sessionType,
    peerId: message.peerId,
    peerName: message.peerName || '',
    senderId: message.senderId || '',
    senderName: message.senderName || '',
    senderNickname: message.senderName || '',
    senderNameResolved: message.senderNameResolved === true,
    senderOpenid: message.senderId || '',
    groupOpenid: message.sessionType === 'group' ? message.peerId : '',
    mentionedSelf: message.mentionedSelf === true,
    fullGroupMessage: message.fullGroupMessage === true,
    parseFallback: message.parseFallback === true,
    eventType: message.eventType || '',
    linkedBot: message.linkedBot === true,
    linkFromAccountId: message.linkFromAccountId || '',
    linkFromChannelId: message.linkFromChannelId || '',
    text: message.text || '',
    media: !!message.media,
    images: Array.isArray(message.images) ? message.images : [],
    qqMessageId: message.qqMessageId || '',
    eventId: message.eventId || '',
    timestamp: message.timestamp || Date.now(),
    receivedAt: message.receivedAt || Date.now(),
  }
}

/* ------------------------------------------------------------------ */
/* Webhook Ed25519（回调校验）                                          */
/* ------------------------------------------------------------------ */

/**
 * 官方口径：AppSecret 截断 / 补齐到 32 字节作为 Ed25519 种子；
 * 签名内容为 plain_token + event_ts（回调校验），
 * 普通回调签名为 timestamp + body。
 * 不同文档版本字节序 / 补位方式略有差异，这里集中在一处，便于按官方示例校准。
 */
function ed25519Seed(secret) {
  const bytes = Buffer.from(String(secret || ''), 'utf8')
  const seed = Buffer.alloc(32)
  bytes.copy(seed, 0, 0, Math.min(bytes.length, 32))
  return seed
}

function webhookPrivateKey(secret) {
  const der = Buffer.concat([
    Buffer.from('302e020100300506032b657004220420', 'hex'),
    ed25519Seed(secret),
  ])
  return createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })
}

export function signWebhook(secret, plainToken, eventTs) {
  const message = Buffer.from(`${String(plainToken || '')}${String(eventTs || '')}`, 'utf8')
  return cryptoSign(null, message, webhookPrivateKey(secret)).toString('hex')
}

export function verifyWebhook(secret, timestamp, body, signatureHex) {
  try {
    const publicKey = createPublicKey(webhookPrivateKey(secret))
    const message = Buffer.from(`${String(timestamp || '')}${String(body || '')}`, 'utf8')
    return cryptoVerify(null, message, publicKey, Buffer.from(String(signatureHex || ''), 'hex'))
  } catch (_) {
    return false
  }
}

/* ------------------------------------------------------------------ */
/* 插件                                                                 */
/* ------------------------------------------------------------------ */

export function apply(ctx) {
  const settings = ctx.settings
  const imageKeep = () => Number(settings.get?.()?.preferences?.chat?.imageStoreLimit) || undefined
  const hub = ctx.hub
  const httpApi = ctx.httpApi

  /** 持久状态：账号、绑定、发现、未处理入站。密钥字段 AES-256-GCM 加密。 */
  let data = { version: 1, accounts: {} }
  /** 运行时：WebSocket、长轮询、二维码轮询、派生路由表，不落盘。 */
  const runtime = new Map()
  let secretKey = null
  let persistTimer = null
  let closed = false

  const statePath = () => join(settings.dataDir || process.cwd(), STATE_FILE)
  const keyPath = () => join(settings.dataDir || process.cwd(), '.secret-key')

  /* ---------------- 凭据加解密（与 wechat-clawbot 相同口径） ---------------- */

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
      const [ivB64, tagB64, dataB64] = value.slice(ENC_PREFIX.length).split(':')
      const decipher = createDecipheriv('aes-256-gcm', secretKey, Buffer.from(ivB64, 'base64'))
      decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
      return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8')
    } catch (_) {
      ctx.logger.warn('[qqbot] 凭据解密失败，请重新登录 QQ 官方机器人')
      return ''
    }
  }

  const persist = async ({ force = false } = {}) => {
    if (closed && !force) return
    try {
      await mkdir(settings.dataDir, { recursive: true })
      const tmp = `${statePath()}.${process.pid}.${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.tmp`
      await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
      await rename(tmp, statePath())
      try {
        await chmod(statePath(), 0o600)
      } catch (_) {
        /* Windows 忽略 */
      }
    } catch (err) {
      ctx.logger.warn(`[qqbot] 状态写入失败：${err.message}`)
    }
  }

  const schedulePersist = () => {
    if (persistTimer || closed) return
    persistTimer = setTimeout(() => {
      persistTimer = null
      persist().catch(() => {})
    }, 500)
  }

  const loadState = async () => {
    secretKey = await readSecret()
    try {
      const raw = await readFile(statePath(), 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && parsed.accounts && typeof parsed.accounts === 'object') {
        data = { version: 1, accounts: parsed.accounts }
      }
    } catch (_) {
      data = { version: 1, accounts: {} }
    }
    for (const account of Object.values(data.accounts)) normalizeAccount(account)
    // 重启后二维码会话已失效：只保留账号凭据，不保留上一次的二维码状态。
    // 待扫码绑定任务保留，boot() 会恢复并继续轮询
  }

  /* ---------------- 账号 / 运行时 ---------------- */

  function normalizeAccount(account) {
    account.accountId = String(account.accountId || account.appId || '')
    account.channels = account.channels && typeof account.channels === 'object' ? account.channels : {}
    account.discovered = Array.isArray(account.discovered) ? account.discovered : []
  // 旧版本把群聊标记为“暂不支持群聊”；升级后群聊已支持，清掉这个历史标记，
  // 否则「发现会话」里的群会一直显示为禁用。
  for (const item of account.discovered) {
    if (item && item.sessionType === 'group' && typeof item.unsupported === 'string' && item.unsupported.includes('暂不支持群聊')) {
      delete item.unsupported
    }
  }
    account.inbox = Array.isArray(account.inbox) ? account.inbox : []
    account.seen = Array.isArray(account.seen) ? account.seen : []
    account.sent = account.sent && typeof account.sent === 'object' ? account.sent : {}
    account.lastInbound = account.lastInbound && typeof account.lastInbound === 'object' ? account.lastInbound : {}
    account.memberNames = account.memberNames && typeof account.memberNames === 'object' ? account.memberNames : {}
    account.bot = account.bot && typeof account.bot === 'object' ? account.bot : {}
    account.channelBindings = account.channelBindings && typeof account.channelBindings === 'object' ? account.channelBindings : {}
    account.transport = account.transport || 'ws'
    account.passiveTtl = account.passiveTtl && typeof account.passiveTtl === 'object' ? account.passiveTtl : {}
    // 扫码接入的账号允许在正式环境因未配 IP 白名单被拒时自动降级到沙箱环境；
    // 手动凭据账号保持显式选择，不静默切换。
    if (account.authMode !== 'qrcode' && account.authMode !== 'manual') {
      account.authMode = account.linkAuthorized === true && account.qr ? 'qrcode' : account.appId ? 'manual' : ''
    }
    account.sandbox = account.sandbox === true
    account.sandboxFallback = account.sandboxFallback === true
    account.unboundNoticeAt = account.unboundNoticeAt && typeof account.unboundNoticeAt === 'object' ? account.unboundNoticeAt : {}
    return account
  }

  function runtimeFor(accountId) {
    const key = String(accountId || '')
    let rt = runtime.get(key)
    if (!rt) {
      rt = {
        accountId: key,
        status: 'offline',
        error: '',
        routes: new Map(),
        conflicts: [],
        ws: null,
        wsTask: null,
        wsSessionId: '',
        wsLastSeq: 0,
        epoch: 0,
        stopping: false,
        qrPolling: null,
        qrEpoch: null,
        started: false,
      }
      runtime.set(key, rt)
    }
    return rt
  }

  function findAccountById(accountId) {
    const key = String(accountId || '')
    if (!key) return null
    return data.accounts[key] || null
  }

  function findAccountByAppId(appId) {
    const key = String(appId || '').trim()
    if (!key) return null
    for (const account of Object.values(data.accounts)) {
      if (String(account.appId || '') === key) return account
    }
    return null
  }

  function findAccountForChannel(channelId) {
    const key = String(channelId || '').trim()
    if (!key) return null
    for (const account of Object.values(data.accounts)) {
      if (account.channels?.[key]) return account
    }
    // 渠道尚未在桥里登记：尝试用运行时的 channel -> account 索引
    for (const rt of runtime.values()) {
      if (rt.channelAccounts?.get?.(key)) return findAccountById(rt.channelAccounts.get(key))
    }
    return null
  }

  function channelConfig(account, channelId, create = true) {
    const key = String(channelId || '').trim()
    if (!key) return null
    if (!account.channels[key] && create) {
      account.channels[key] = { autoBind: false, bindings: [], intents: 0, sessionType: '', updatedAt: Date.now() }
    }
    const cfg = account.channels[key]
    if (cfg) {
      cfg.bindings = Array.isArray(cfg.bindings) ? cfg.bindings : []
      cfg.intents = Number(cfg.intents) || 0
      cfg.sessionType = String(cfg.sessionType || '')
      cfg.trustedUserIds = Array.isArray(cfg.trustedUserIds) ? cfg.trustedUserIds.map(String).filter(Boolean) : []
      // disabled 只停用当前渠道的消息路由，不删除本机登录凭据；点「接入」重连时恢复。
      cfg.disabled = cfg.disabled === true
      // 同群多机器人联动。linkGroupId 由用户在两个渠道上填成同一个值；
      // sendMessage 会把群内出站消息镜像给同标识的其它机器人渠道。
      cfg.linkGroupId = String(cfg.linkGroupId || '').trim()
      cfg.channelName = String(cfg.channelName || '').slice(0, 80)
      cfg.linkAutoReply = cfg.linkAutoReply !== false
      const linkMax = Number(cfg.linkMaxTurns)
      cfg.linkMaxTurns = Number.isFinite(linkMax) && linkMax >= 0 ? Math.min(5, Math.floor(linkMax)) : 1
    }
    return cfg || null
  }

  /** 同一 (sessionType, peerId) 只能绑定到一个渠道，避免两个角色同时回复同一个人。 */
  function addBinding(account, channelId, sessionType, peerId, options = {}) {
    const key = String(channelId || '').trim()
    const peer = String(peerId || '').trim()
    if (!key || !SESSION_TYPES.includes(sessionType) || !peer) return ''
    for (const [otherId, cfg] of Object.entries(account.channels || {})) {
      if (otherId === key) continue
      const before = cfg.bindings.length
      cfg.bindings = cfg.bindings.filter(item => !(item.sessionType === sessionType && String(item.peerId) === peer))
      if (cfg.bindings.length !== before) cfg.updatedAt = Date.now()
    }
    const cfg = channelConfig(account, key)
    const existing = cfg.bindings.find(item => item.sessionType === sessionType && String(item.peerId) === peer)
    const alias = options.alias !== undefined ? String(options.alias || '') : ''
    const identityMode = options.identityMode || (sessionType === 'c2c' ? 'owner' : 'member')
    if (existing) {
      if (options.alias !== undefined) existing.alias = alias
      if (options.identityMode) existing.identityMode = identityMode
      if (options.auto) existing.auto = true
    } else {
      cfg.bindings.push({
        sessionType,
        peerId: peer,
        alias,
        identityMode,
        auto: options.auto === true,
        boundAt: Date.now(),
      })
    }
    cfg.updatedAt = Date.now()
    account.channelBindings = account.channelBindings || {}
    account.channelBindings[key] = sessionType
    if (options.channelSessionType) cfg.sessionType = String(options.channelSessionType)
    rebuildRoutes(account)
    const found = account.discovered.find(item => item.sessionType === sessionType && String(item.peerId) === peer)
    if (found) {
      found.channelId = key
      found.boundAt = Date.now()
    }
    schedulePersist()
    return key
  }

  function removeBinding(account, channelId, sessionType, peerId) {
    const cfg = channelConfig(account, channelId, false)
    if (!cfg) return false
    const before = cfg.bindings.length
    cfg.bindings = cfg.bindings.filter(item => !(item.sessionType === sessionType && String(item.peerId) === String(peerId)))
    if (cfg.bindings.length === before) return false
    cfg.updatedAt = Date.now()
    const found = account.discovered.find(item => item.sessionType === sessionType && String(item.peerId) === String(peerId))
    if (found) found.channelId = ''
    rebuildRoutes(account)
    schedulePersist()
    return true
  }

  function rebuildRoutes(account) {
    const rt = runtimeFor(account.accountId)
    rt.routes = new Map()
    rt.conflicts = []
    rt.channelAccounts = new Map()
    for (const channelId of Object.keys(account.channels || {}).sort()) {
      const cfg = account.channels[channelId]
      if (!cfg || cfg.disabled === true) continue
      rt.channelAccounts.set(channelId, account.accountId)
      for (const binding of cfg?.bindings || []) {
        const key = `${binding.sessionType}:${binding.peerId}`
        if (rt.routes.has(key)) {
          rt.conflicts.push({ key, channelId, otherChannelId: rt.routes.get(key) })
          continue
        }
        rt.routes.set(key, channelId)
      }
    }
  }

  function accountIntents(account) {
    let intents = 0
    for (const cfg of Object.values(account.channels || {})) {
      if (!cfg) continue
      if (Number(cfg.intents) & INTENT_PUBLIC_GUILD_MESSAGES) intents |= INTENT_PUBLIC_GUILD_MESSAGES
      if (Number(cfg.intents) & INTENT_DIRECT_MESSAGE) intents |= INTENT_DIRECT_MESSAGE
    }
    return intents | DEFAULT_INTENTS
  }

  function resolveAccountForPayload(body = {}) {
    const accountId = String(body.accountId || '').trim()
    if (accountId) return findAccountById(accountId)
    const appId = String(body.appId || '').trim()
    if (appId) return findAccountByAppId(appId)
    if (body.channelId) return findAccountForChannel(body.channelId)
    return null
  }

  function channelAccountId(account, channelId) {
    const key = String(channelId || '').trim()
    if (!key || !account?.channels?.[key]) return ''
    return account.accountId
  }

  function rekeyAccount(account, previousId) {
    const from = String(previousId || '')
    const to = String(account.accountId || '')
    if (!from || !to || from === to) return
    if (data.accounts[from] === account) delete data.accounts[from]
    data.accounts[to] = account
    const rtFrom = runtime.get(from)
    if (rtFrom && from !== to) {
      runtime.delete(from)
      runtime.set(to, { ...rtFrom, accountId: to })
    }
  }

  /* ---------------- 状态对外 ---------------- */

  function statusOf(account) {
    if (!account) return 'idle'
    const rt = runtimeFor(account.accountId)
    if (rt.status === 'online' || rt.status === 'connecting' || rt.status === 'error' || rt.status === 'offline') return rt.status
    return account.appId || account.accessToken ? 'offline' : 'idle'
  }

  function publicStatus(account, channelId = '') {
    const rt = account ? runtimeFor(account.accountId) : null
    const cfg = account && channelId ? channelConfig(account, channelId, false) : null
    const qrRaw = rt?.qr || account?.qr || null
    // 同一个机器人的多个渠道共用 account.qr；只把属于当前渠道的二维码暴露给该渠道。
    const qr =
      qrRaw && (!channelId || !qrRaw.channelId || String(qrRaw.channelId) === String(channelId))
        ? qrRaw
        : null
    const lastInbound = account?.lastInbound?.[channelId] || null
    const channelDisabled = cfg?.disabled === true
    const status = channelDisabled && account ? 'offline' : statusOf(account)
    const discovered = account
      ? [...account.discovered]
          .filter(item => {
            if (!channelId || !cfg) return true
            // 已绑定到其它渠道的会话不在这里展示；自己已绑定的会在 bindings 区域展示。
            if (item.channelId && item.channelId !== channelId) return false
            if (cfg.sessionType && item.sessionType !== cfg.sessionType && !item.unsupported) return false
            return true
          })
          .slice(-MAX_DISCOVER)
          .reverse()
      : []
    return {
      channelId: channelId || '',
      accountId: account?.accountId || '',
      status,
      channelDisabled,
      loggedIn: !!(account?.appId && (account?.secret || account?.accessToken)) || !!account?.linkAuthorized,
      transport: account?.transport || 'ws',
      sandbox: account?.sandbox === true,
      sandboxFallback: account?.sandboxFallback === true,
      authMode: account?.authMode || '',
      appId: account?.appId || '',
      bot: account?.bot || null,
      error: channelDisabled ? '' : rt?.error || '',
      bindings: cfg?.bindings || [],
      autoBind: cfg?.autoBind === true,
      conflicts: rt?.conflicts || [],
      pending: account?.inbox?.filter(item => !channelId || item.channelId === channelId).length || 0,
      lastInbound,
      bridgeVersion: version,
      lastGatewayEvent: account?.lastGatewayEvent || null,
      qr: qr
        ? {
            id: qr.id || '',
            content: qr.content || '',
            imageUrl: qr.imageUrl || '',
            status: qr.status || 'wait_scan',
            error: qr.error || '',
            startedAt: qr.startedAt || 0,
            expiresAt: qr.expiresAt || 0,
          }
        : null,
      discovered,
      webhookPath: '/api/qqbot/webhook',
      updatedAt: account?.updatedAt || 0,
    }
  }

  function setStatus(account, status, error = '') {
    const rt = runtimeFor(account.accountId)
    const changed = rt.status !== status || rt.error !== String(error || '')
    rt.status = status
    rt.error = String(error || '')
    if (changed) {
      hub.broadcast('qqbot:status', {
        channelId: '',
        accountId: account.accountId,
        status,
        error: rt.error,
        bot: account.bot || null,
      })
    }
  }

  /* ---------------- Token / OpenAPI ---------------- */

  async function requestRaw(url, { method = 'GET', headers = {}, body, timeoutMs = 20000 } = {}) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('请求超时')), Math.max(1500, Number(timeoutMs) || 20000))
    try {
      const response = await fetchWithNetworkRetry(url, {
        method,
        headers,
        body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
        signal: controller.signal,
      })
      const text = await response.text()
      let parsed = null
      try {
        parsed = text ? JSON.parse(text) : null
      } catch (_) {
        parsed = { raw: text.slice(0, 500) }
      }
      return { ok: response.ok, status: response.status, data: parsed, text }
    } catch (err) {
      return { ok: false, status: 0, data: null, text: '', error: err?.name === 'AbortError' ? '请求超时' : networkErrorText(err) }
    } finally {
      clearTimeout(timer)
    }
  }

  const IP_WHITELIST_CODES = new Set([11298, 40023002, 40023003])
  const IP_WHITELIST_HINT =
    'QQ 拒绝了本机公网 IP：接口访问源 IP 不在白名单（code=11298）。请把本机公网 IP 加入 QQ 开放平台 → 开发设置 → IP 白名单，保存后点「重新连接」。'

  function errorCodeOf(data) {
    const code = Number(data?.code ?? data?.errcode ?? data?.ret)
    return Number.isFinite(code) ? code : 0
  }
  function isIpWhitelistError(status, data) {
    const code = errorCodeOf(data)
    if (IP_WHITELIST_CODES.has(code)) return true
    const message = String(data?.message || data?.msg || data?.errmsg || data?.error || '')
    return /源?\s*IP.*白名单|白名单.*(?:IP|ip)|IP\s*(?:is\s*)?not\s*(?:in\s*)?(?:the\s*)?whitelist|not\s*(?:in\s*)?(?:the\s*)?whitelist/i.test(message)
  }
  function isInvalidCredentialError(data) {
    const code = errorCodeOf(data)
    if ([100007, 100016, 10004].includes(code)) return true
    return /appid\s*(?:or|或|和)?\s*(?:app\s*)?secret|invalid\s*app|机器人不存在|not\s*exist/i.test(
      String(data?.message || data?.msg || data?.errmsg || data?.error || ''),
    )
  }
  function describeFailure(result, data) {
    const payload = data && typeof data === 'object' ? data : {}
    if (isIpWhitelistError(result?.status, payload)) return IP_WHITELIST_HINT
    const code = errorCodeOf(payload)
    const message = String(payload.message || payload.msg || payload.errmsg || payload.error || '').trim()
    if (isInvalidCredentialError(payload)) {
      return `AppID / AppSecret 无效${message ? `：${message}` : ''}。请重新扫码绑定，或在接入弹窗手动填写正确凭据。`
    }
    const pieces = []
    if (result?.error) pieces.push(result.error)
    if (result?.status) pieces.push(`HTTP ${result.status}`)
    if (code) pieces.push(`code=${code}`)
    if (message) pieces.push(message)
    const status = Number(result?.status) || 0
    if (status === 400) pieces.push('QQ 400 常见原因：IP 白名单、接口权限或机器人状态异常')
    else if (status === 401) pieces.push('QQ 401 常见原因：IP 白名单未添加、AppID / AppSecret 失效或机器人被禁用')
    return pieces.filter(Boolean).join(' · ') || '未知错误'
  }

  /**
   * 扫码账号才允许自动沙箱降级：正式环境在要求把本机公网 IP 加白名单时，
   * 自动改用沙箱 OpenAPI（sandbox.api.sgroup.qq.com）。该域名实测无需白名单，
   * 也不需要 Webhook 公网回调；手动填写凭据的账号保持用户显式选择，不静默切换。
   */
  function canAutoSwitchSandbox(account) {
    return !!account && account.authMode === 'qrcode' && account.sandbox !== true
  }

  function switchToSandbox(account, cause = '') {
    if (!account) return false
    account.sandbox = true
    account.sandboxFallback = true
    account.sandboxFallbackAt = Date.now()
    account.sandboxFallbackReason = safeString(cause || '接口访问源IP不在白名单', 200)
    account.wsUrl = ''
    account.updatedAt = Date.now()
    schedulePersist()
    const notice = '检测到本机 IP 不在 QQ 开放平台白名单，已自动切换到沙箱环境（免白名单、无需公网）。'
    ctx.logger?.info?.(`[qqbot] 账号 ${account.accountId} 自动切换沙箱环境：${account.sandboxFallbackReason}`)
    hub.broadcast('qqbot:status', {
      channelId: '',
      accountId: account.accountId,
      status: statusOf(account),
      sandbox: true,
      sandboxFallback: true,
      notice,
    })
    return true
  }

  /** 主域名不可达 / 404 时回退备用域名；鉴权失败等业务错误不做静默回退，避免掩盖问题。 */
  async function requestRawWithFallback(urls, options) {
    const list = (Array.isArray(urls) ? urls : [urls]).filter(Boolean)
    let result = null
    for (let index = 0; index < list.length; index += 1) {
      result = await requestRaw(list[index], options)
      const isLast = index >= list.length - 1
      if (isLast) break
      // 只有网络不可达或路径不存在才换域名；HTTP 400/401 属于业务响应，直接返回给上层解析。
      if (result.status !== 0 && result.status !== 404) break
    }
    return result || { ok: false, status: 0, data: null, error: '没有可用请求地址' }
  }

  async function ensureAccessToken(account, { force = false } = {}) {
    const now = Date.now()
    const cached = decrypt(account.accessToken || '')
    if (!force && cached && now < Number(account.tokenExpiresAt || 0) - 120000) return cached
    const secret = decrypt(account.secret || '')
    if (cached && !secret) return cached // token-only：没有 secret 时过期后只能重新扫码
    if (!account.appId || !secret) throw new Error('未配置 AppID / AppSecret，请先点「接入」扫码或手动填写凭据')
    const result = await requestRawWithFallback(TOKEN_URLS, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: { appId: String(account.appId), clientSecret: secret },
    })
    const info = result.data || {}
    if (!result.ok || !info.access_token) {
      throw new Error(`获取 access_token 失败：${describeFailure(result, info)}`)
    }
    account.accessToken = encrypt(String(info.access_token))
    account.tokenExpiresAt = now + (Number(info.expires_in) || 7200) * 1000
    account.updatedAt = now
    schedulePersist()
    return String(info.access_token)
  }

  function isTokenExpiredResponse(status, data) {
    if (status === 401 || status === 403) return true
    const code = Number(data?.code ?? data?.errcode ?? data?.ret)
    if ([11244, 11245, 11246, 40001, 40014].includes(code)) return true
    return /token.*(invalid|expired)|access token.*(invalid|expired)|登录.*(失效|过期)/i.test(
      String(data?.message || data?.errmsg || data?._error || ''),
    )
  }

  async function apiRequest(account, path, { method = 'GET', body, query, timeoutMs = 20000, retry = true, sandboxRetry = true } = {}) {
    let token = ''
    try {
      token = await ensureAccessToken(account)
    } catch (err) {
      return { _error: err.message }
    }
    const bases = account.sandbox === true ? SANDBOX_API_BASES : API_BASES
    const search = query ? `?${new URLSearchParams(query).toString()}` : ''
    const headers = { 'Content-Type': 'application/json', Authorization: `QQBot ${token}` }
    if (account.appId) headers['X-Union-Appid'] = String(account.appId)
    let result = null
    let payload = {}
    for (let index = 0; index < bases.length; index += 1) {
      const base = bases[index]
      result = await requestRaw(`${base}${path}${search}`, { method, headers, body, timeoutMs })
      payload = result.data && typeof result.data === 'object' ? result.data : {}
      const isLast = index >= bases.length - 1
      if (isLast) break
      // 网络不可达 / 404 时切换官方统一域名重试；业务错误不再尝试，避免把真实错误吞掉。
      if (result.status !== 0 && result.status !== 404) break
    }
    if (!result.ok) {
      payload._httpStatus = result.status
      if (isIpWhitelistError(result.status, payload)) payload._error = IP_WHITELIST_HINT
      else if (!payload._error) payload._error = describeFailure(result, payload)
    }
    if (!isIpWhitelistError(result.status, payload) && isTokenExpiredResponse(result.status, payload) && retry && decrypt(account.secret || '')) {
      account.accessToken = ''
      account.tokenExpiresAt = 0
      return apiRequest(account, path, { method, body, query, timeoutMs, retry: false, sandboxRetry })
    }
    // 扫码接入：正式环境被 IP 白名单拦住时自动切换到沙箱域名并重试，避免把本地用户
    // 引向开放平台手动加白名单。只允许切换一次；沙箱仍失败时返回真实错误。
    if (sandboxRetry && isIpWhitelistError(result.status, payload) && canAutoSwitchSandbox(account)) {
      switchToSandbox(account, payload.message || payload.msg || '')
      return apiRequest(account, path, { method, body, query, timeoutMs, retry, sandboxRetry: false })
    }
    return payload
  }

  async function fetchBotProfile(account) {
    const profile = await apiRequest(account, '/users/@me')
    if (profile?._error || !profile?.id) return null
    account.bot = {
      id: String(profile.id || ''),
      username: String(profile.username || ''),
      avatar: String(profile.avatar || ''),
    }
    account.updatedAt = Date.now()
    schedulePersist()
    return account.bot
  }

  /* ---------------- 事件归一化 / 路由 ---------------- */

/**
 * 判断群聊全量消息是否 @ 了机器人。
 *
 * GROUP_AT_MESSAGE_CREATE 天然代表 @；GROUP_MESSAGE_CREATE 这类全量事件
 * 需要从 mentions / 正文里尽力判断。拿不准时按“未 @”处理——默认只静默写入
 * 本群上下文，不会误触发回复；用户可以在群规则里关闭“仅 @ 时回复”后按概率触发。
 */
function detectGroupMention(account, input) {
  const root = input || {}
  const d = root.message && typeof root.message === 'object' ? root.message : root
  const candidates = new Set(
    [account?.bot?.id, account?.appId, account?.bot?.username]
      .map(value => String(value || '').trim())
      .filter(Boolean),
  )
  if (!candidates.size) return false
  const flagSources = [d, root]
  const flags = flagSources.flatMap(source => [
    source?.mentioned,
    source?.mentioned_self,
    source?.mentionedSelf,
    source?.is_at,
    source?.at_me,
    source?.atMe,
    source?.at_bot,
  ])
  if (flags.some(value => value === true)) return true
  const mentions = Array.isArray(d?.mentions) ? d.mentions : Array.isArray(root?.mentions) ? root.mentions : []
  for (const item of mentions) {
    if (!item || typeof item !== 'object') continue
    // AstrBot / qq-botpy 的群消息 mentions 项带 is_you，最可靠。
    if (item.is_you === true || item.isYou === true) return true
    const values = [item.id, item.user_openid, item.member_openid, item.union_openid, item.openid, item.name, item.username]
    if (values.some(value => value !== undefined && value !== null && candidates.has(String(value)))) return true
  }
  const content = String(d?.content ?? d?.text ?? root?.content ?? '')
  for (const value of candidates) {
    if (content.includes(`<@!${value}>`) || content.includes(`<@${value}>`) || content.includes(`@${value}`)) return true
  }
  return false
}


  function normalizeInbound(account, eventType, sessionType, payload, raw) {
    const root = payload || {}
    // 不同版本 / 不同事件名可能把消息体放在 d 或 d.message 里，这里都兼容。
    const d = root.message && typeof root.message === 'object' ? root.message : root
    const author = d.author || d.member || d.sender || root.author || {}
    const timestamp = parseEventTime(d.timestamp ?? root.timestamp)
    const botName = account?.bot?.username || ''
    let peerId = ''
    let senderId = ''
    let senderName = ''
    let senderNameResolved = false
    let text = ''
    if (sessionType === 'c2c') {
      peerId = String(author.user_openid || author.openid || author.id || d.user_openid || '')
      senderId = peerId
      // 新版权消息事件会带 author.username；没有就继续用 openid 兜底。
      senderName = String(author.username || author.nickname || '')
    } else if (sessionType === 'group') {
      peerId = String(d.group_openid || d.group_id || d.openid || root.group_openid || '')
      // author.member_openid 是官方接口在群内给出的成员专属 id；没有它时回退 author.id。
      senderId = String(author.member_openid || author.user_openid || author.id || d.member_openid || '')
      // 群昵称：新版事件可能直接带 nickname / nick / member_name；否则用缓存，
      // 都没有时落库后由 routeInbound 调群成员信息接口补齐。
      const explicitGroupName = String(author.nick || author.nickname || author.member_name || d.member_name || '').trim()
      const cachedGroupName = memberNameFor(account, peerId, senderId)
      senderName = explicitGroupName || cachedGroupName || String(author.username || '').trim()
      senderNameResolved = !!(explicitGroupName || cachedGroupName)
    } else if (sessionType === 'guild') {
      peerId = String(d.channel_id || root.channel_id || '')
      senderId = String(author.id || '')
      senderName = String(author.username || '')
    } else if (sessionType === 'guild-dm') {
      peerId = String(d.guild_id || root.guild_id || '')
      senderId = String(author.id || '')
      senderName = String(author.username || '')
    }
    const rawContent = d.content ?? d.text ?? root.content ?? ''
    const rawAttachments = d.attachments || root.attachments || []
    text = normalizeEventText(rawContent, botName)
    const attachmentImages = extractAttachments(rawAttachments)
    const media = attachmentImages.length > 0 || (Array.isArray(rawAttachments) && rawAttachments.length > 0)
    // QQ 官方图片消息的 content 可能是空串，真实图片在 d.attachments 里；
    // 这里必须使用已抽取的 attachmentImages，不能引用未定义的 images（否则图片事件直接异常）。
    if (!text && attachmentImages.length) text = '[图片]'
    else if (!text && media) text = '[QQ 媒体消息]'
    if (!peerId) return null
    const qqMessageId = String(d.id || d.message_id || root.id || '')
    // 事件名 / payload 结构对，但正文和附件都解析不出来时，生成一条占位消息，
    // 保证它至少能路由到渠道并写入聊天记录，同时标记 parseFallback 便于排查。
    let parseFallback = false
    if (!text && !media) {
      const looksLikeMessage = /(?:MESSAGE|MSG).*CREATE|CREATE.*(?:MESSAGE|MSG)/i.test(String(eventType || ''))
      if (looksLikeMessage && (qqMessageId || senderId || author.member_openid || author.user_openid)) {
        text = '[QQ 消息：插件无法解析正文，请把 runtime 日志里的 payload keys 反馈]'
        parseFallback = true
      } else {
        return null
      }
    }
    const eventId = String(raw?.id || '')
    const atBotEvent = String(eventType || '') === 'GROUP_AT_MESSAGE_CREATE'
    const mentionedSelf = sessionType === 'group' ? atBotEvent || detectGroupMention(account, d) : false
    return {
      id: messageKey(sessionType, peerId, qqMessageId, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
      sessionType,
      peerId,
      senderId: senderId || peerId,
      senderName,
      senderNameResolved,
      mentionedSelf,
      fullGroupMessage: sessionType === 'group' && !atBotEvent,
      eventType: String(eventType || ''),
      parseFallback,
      memberOpenid: sessionType === 'group' ? senderId : '',
      unionOpenid: String(author.union_openid || author.unionOpenid || ''),
      groupOpenid: sessionType === 'group' ? peerId : '',
      text,
      media,
      images: [],
      _attachmentImages: attachmentImages,
      qqMessageId,
      eventId,
      timestamp,
      receivedAt: Date.now(),
    }
  }

  /** QQ 消息事件的附件（图片）直接给 HTTPS URL；URL 可能带签名有效期，读取时立即使用。 */
  function extractAttachments(input) {
    const list = Array.isArray(input) ? input : []
    const images = []
    for (const item of list) {
      if (images.length >= MAX_IMAGES_PER_MESSAGE) break
      const contentType = String(item?.content_type || item?.contentType || '').toLowerCase()
      const filename = String(item?.filename || item?.file_name || '').trim()
      const rawUrl = String(item?.url || item?.proxy_url || '').trim()
      if (!rawUrl) continue
      const looksImage =
        contentType.startsWith('image') ||
        (!contentType && /\.(png|jpe?g|gif|webp|bmp|avif)(\?|#|$)/i.test(rawUrl)) ||
        (!contentType && /\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(filename))
      if (!looksImage) continue
      images.push({
        url: /^https?:/i.test(rawUrl) ? rawUrl : `https://${rawUrl}`,
        // 具体 MIME 直接使用；只有通配 / 缺失时留空，交给 image-service 按文件头识别，
        // 避免存成 `image/*` 后拼出模型不接受的 data URL。
        mime: contentType.startsWith('image/') && contentType !== 'image/*' ? contentType.split(';')[0] : '',
        width: Number(item?.width) || 0,
        height: Number(item?.height) || 0,
      })
    }
    return images
  }

  function memberNameFor(account, groupId, memberId) {
    if (!account?.memberNames || !groupId || !memberId) return ''
    return account.memberNames[`group:${groupId}:${memberId}`]?.name || ''
  }

  /**
   * 群成员昵称（群昵称）：QQ 官方群消息事件通常只给 member_openid。
   * 这里做 best-effort：优先请求官方可能提供的群成员信息只读端点，
   * 兼容 nick / nickname / member_name 等常见字段；拿到后缓存并广播，
   * WebUI 会把「QQ成员·尾号」回填成真实群昵称。全部失败则沿用兜底称呼。
   */
  async function fetchMemberName(account, groupOpenid, memberOpenid) {
    if (!groupOpenid || !memberOpenid) return ''
    account.memberNames = account.memberNames || {}
    const key = `group:${groupOpenid}:${memberOpenid}`
    const cached = account.memberNames[key]
    if (cached?.name) return cached.name
    if (cached && Date.now() - (cached.at || 0) < 10 * 60 * 1000) return ''
    account.memberNames[key] = { name: '', at: Date.now() }
    const candidates = [
      `/v2/groups/${encodeURIComponent(groupOpenid)}/members/${encodeURIComponent(memberOpenid)}`,
      `/v2/groups/${encodeURIComponent(groupOpenid)}/members/${encodeURIComponent(memberOpenid)}/info`,
      `/v2/groups/${encodeURIComponent(groupOpenid)}/member/${encodeURIComponent(memberOpenid)}`,
      `/v2/users/${encodeURIComponent(memberOpenid)}`,
    ]
    for (const path of candidates) {
      const result = await apiRequest(account, path)
      if (!result || result._error || (result.code && Number(result.code) !== 0)) continue
      const body = result.data && typeof result.data === 'object' ? result.data : result
      const name = String(body.member_name || body.nick || body.nickname || body.name || body.username || body.memberName || '').trim()
      if (name) {
        account.memberNames[key] = { name, at: Date.now() }
        account.updatedAt = Date.now()
        schedulePersist()
        hub.broadcast('qqbot:member', {
          accountId: account.accountId,
          groupId: groupOpenid,
          memberId: memberOpenid,
          name,
        })
        return name
      }
    }
    schedulePersist()
    return ''
  }

  function touchSeen(account, id) {
    if (!id) return false
    if (account.seen.includes(id)) return true
    account.seen.push(id)
    if (account.seen.length > MAX_SEEN) account.seen.splice(0, account.seen.length - MAX_SEEN)
    return false
  }

  function pushInbox(account, message) {
    if (!message?.channelId) return
    if (account.inbox.some(item => item.id === message.id)) return
    account.inbox.push(publicInbound({ ...message, channelId: message.channelId }))
    if (account.inbox.length > MAX_INBOX) account.inbox.splice(0, account.inbox.length - MAX_INBOX)
  }

  function upsertDiscover(account, message) {
    const key = `${message.sessionType}:${message.peerId}`
    let found = account.discovered.find(item => item.key === key)
    if (!found) {
      found = {
        key,
        sessionType: message.sessionType,
        peerId: message.peerId,
        preview: '',
        count: 0,
        at: 0,
        channelId: '',
        aliases: [],
      }
      account.discovered.push(found)
    }
    found.preview = safeString(message.text || found.preview || '', 120)
    found.at = message.receivedAt || Date.now()
    found.count = (Number(found.count) || 0) + 1
    found.lastSenderId = message.senderId || ''
    found.lastSenderName = message.senderName || ''
    account.discovered.sort((a, b) => (a.at || 0) - (b.at || 0))
    if (account.discovered.length > MAX_DISCOVER) account.discovered.splice(0, account.discovered.length - MAX_DISCOVER)
    return found
  }

  /**
   * 未绑定 openid 的私聊提示：每个 openid 最多 10 分钟提醒一次，
   * 引导用户到 WebUI「渠道 → QQ官方机器人 → 发现会话」完成绑定。
   */
  async function notifyUnboundPeer(account, message) {
    if (!account || !message || message.sessionType !== 'c2c' || !message.peerId || !message.qqMessageId) return false
    const peerId = String(message.peerId)
    account.unboundNoticeAt = account.unboundNoticeAt && typeof account.unboundNoticeAt === 'object' ? account.unboundNoticeAt : {}
    const last = Number(account.unboundNoticeAt[peerId] || 0)
    if (Number.isFinite(last) && Date.now() - last < 10 * 60 * 1000) return false
    const target = { sessionType: 'c2c', peerId }
    const seqInfo = nextPassiveSeq(account, target, String(message.qqMessageId))
    if (!seqInfo.ok) return false
    account.unboundNoticeAt[peerId] = Date.now()
    const entries = Object.entries(account.unboundNoticeAt).sort((a, b) => Number(b[1]) - Number(a[1])).slice(0, 200)
    account.unboundNoticeAt = Object.fromEntries(entries)
    schedulePersist()
    const text = `这条 QQ 私聊还没有绑定到念风Chat渠道。请打开「渠道 → QQ官方机器人 → 发现会话」，复制 openid：${peerId}，点「绑定到本渠道」后再发消息。`
    const result = await apiRequest(account, `/v2/users/${encodeURIComponent(peerId)}/messages`, {
      method: 'POST',
      body: {
        content: text,
        msg_type: 0,
        msg_id: String(message.qqMessageId),
        msg_seq: seqInfo.seq,
        ...(message.eventId ? { event_id: String(message.eventId) } : {}),
      },
    })
    if (result?._error) ctx.logger?.warn?.(`[qqbot] 未绑定提示发送失败：${result._error}`)
    return !result?._error
  }

  function routeInbound(account, message) {
    if (!account || !message) return
    if (message.sessionType !== 'c2c' && message.sessionType !== 'group') return
    if (touchSeen(account, message.id)) return
    const rt = runtimeFor(account.accountId)
    const key = `${message.sessionType}:${message.peerId}`
    let channelId = rt.routes.get(key) || ''
    if (!channelId) {
      const candidates = Object.keys(account.channels || {}).filter(channelIdKey => {
        const cfg = account.channels[channelIdKey]
        if (!cfg || cfg.disabled === true) return false
        if (!cfg?.autoBind) return false
        // 渠道自身的会话类型（来自「渠道分类」）必须匹配，避免群聊渠道抢走私聊消息。
        // 群聊必须显式声明 group：旧数据没有 sessionType 时不能被群消息自动绑定。
        if (message.sessionType === 'group') {
          if (cfg.sessionType !== 'group') return false
        } else if (cfg.sessionType && cfg.sessionType !== message.sessionType) {
          return false
        }
        return !(cfg.bindings || []).some(binding => binding.sessionType === message.sessionType)
      })
      // 只有唯一候选时才自动绑定；多个未绑定渠道时交给用户在详情页显式选择，避免串线。
      if (candidates.length === 1) {
        channelId = addBinding(account, candidates[0], message.sessionType, message.peerId, {
          auto: true,
          identityMode: message.sessionType === 'c2c' ? 'owner' : 'member',
        })
      }
    }
    const discovery = upsertDiscover(account, message)
    if (channelId) {
      message.channelId = channelId
      ctx.logger.debug(`[qqbot] ${message.sessionType} 消息路由到渠道 ${channelId}（peer=${message.peerId}）`)
      pushInbox(account, message)
      account.lastInbound[channelId] = {
        sessionType: message.sessionType,
        peerId: message.peerId,
        senderId: message.senderId,
        qqMessageId: message.qqMessageId,
        eventId: message.eventId,
        at: message.receivedAt || Date.now(),
      }
      discovery.channelId = channelId
      account.updatedAt = Date.now()
      schedulePersist()
      hub.broadcast('qqbot:message', { channelId, message: publicInbound(message) })
      // 群昵称是 best-effort：事件带昵称 / 缓存命中时直接记下；否则请求群成员信息
      // 端点补齐，拉到后回填 inbox 并广播，WebUI 会把消息显示名更新成群昵称。
      if (message.sessionType === 'group' && message.senderId) {
        if (message.senderNameResolved && message.senderName) {
          account.memberNames[`group:${message.peerId}:${message.senderId}`] = { name: message.senderName, at: Date.now() }
          schedulePersist()
        } else {
          fetchMemberName(account, message.peerId, message.senderId)
            .then(name => {
              if (!name) return
              const item = account.inbox.find(entry => entry.id === message.id)
              if (item) {
                item.senderName = name
                item.senderNameResolved = true
              }
              schedulePersist()
              hub.broadcast('qqbot:member', {
                channelId,
                accountId: account.accountId,
                groupId: message.peerId,
                memberId: message.senderId,
                name,
              })
            })
            .catch(() => {})
        }
      }
    } else {
      ctx.logger.warn(
        `[qqbot] ${message.sessionType} 消息未匹配绑定：peer=${message.peerId}（已进入「发现会话」，请到渠道详情绑定正确会话）`,
      )
      account.updatedAt = Date.now()
      schedulePersist()
      hub.broadcast('qqbot:discover', { accountId: account.accountId, item: { ...discovery } })
      // 未绑定私聊时自动回一条提示，避免 QQ 用户发完消息后没有任何反馈；
      // 群聊不主动刷屏，只进入「发现会话」等待用户手动绑定群。
      if (message.sessionType === 'c2c') {
        notifyUnboundPeer(account, message).catch(err => ctx.logger?.warn?.(`[qqbot] 未绑定提示失败：${err?.message || err}`))
      }
    }
  }

  function routeLifecycleEvent(account, eventType, payload, raw) {
    const d = payload || {}
    const sessionType = eventType.startsWith('GROUP_') ? 'group' : 'c2c'
    const peerId = String(d.group_openid || d.openid || d.author?.member_openid || d.author?.user_openid || '')
    if (!peerId) return
    const message = {
      id: `qq-event-${eventType}-${raw?.id || peerId}`,
      sessionType,
      peerId,
      senderId: '',
      senderName: '',
      text: `[${eventType}]`,
      media: false,
      qqMessageId: String(raw?.id || ''),
      eventId: String(raw?.id || ''),
      timestamp: Date.now(),
      receivedAt: Date.now(),
    }
    const discovery = upsertDiscover(account, message)
    discovery.event = eventType
    account.updatedAt = Date.now()
    schedulePersist()
    hub.broadcast('qqbot:discover', {
      accountId: account.accountId,
      item: { ...discovery, event: eventType },
    })
  }

  async function handleGatewayEvent(account, eventType, payload, raw) {
    if (!account || closed) return
    account.lastGatewayEvent = {
      type: String(eventType || ''),
      at: Date.now(),
      keys: Object.keys(payload || {}).slice(0, 16),
    }
    const knownEvent = !!EVENT_SESSION[eventType]
    const sessionType = sessionTypeForEvent(eventType, payload)
    if (sessionType && !knownEvent) {
      ctx.logger.info(`[qqbot] 通过事件结构识别消息：${eventType} → ${sessionType}`)
    }
    if (sessionType) {
      const message = normalizeInbound(account, eventType, sessionType, payload, raw)
      if (!message) {
        if (sessionType === 'group') {
          ctx.logger.warn(`[qqbot] 群事件 ${eventType} 解析失败并丢弃：payload keys=${Object.keys(payload || {}).join(',')}`)
        }
        return
      }
      if (message.parseFallback) {
        ctx.logger.warn(
          `[qqbot] ${eventType} 正文解析失败，已生成占位消息：payload keys=${Object.keys(payload || {}).join(',')}`,
        )
      }
      // QQ 官方机器人渠道支持私聊（C2C）与群聊（GROUP_AT_MESSAGE_CREATE /
      // GROUP_MESSAGE_CREATE 全量消息）；频道 / 频道私信只进入「发现会话」并标注暂不支持。
      if (sessionType !== 'c2c' && sessionType !== 'group') {
        const discovery = upsertDiscover(account, message)
        discovery.unsupported = sessionType === 'guild' || sessionType === 'guild-dm' ? '频道消息暂不支持' : '暂不支持该会话类型'
        account.updatedAt = Date.now()
        schedulePersist()
        hub.broadcast('qqbot:discover', { accountId: account.accountId, item: { ...discovery } })
        return
      }
      if (sessionType === 'group') {
        // 便于用户在日志里确认群全量消息权限是否真的生效，以及事件名 / @ 判定结果。
        // 30 秒内只打一条 info，其余降到 debug，避免群消息刷屏又让用户看得见诊断信息。
        const now = Date.now()
        const line = `[qqbot] 群事件 ${eventType} group=${message.peerId} member=${message.senderId} mentioned=${message.mentionedSelf === true}`
        if (now - Number(account.lastGroupEventLogAt || 0) > 30 * 1000) {
          account.lastGroupEventLogAt = now
          ctx.logger.info(line)
        } else {
          ctx.logger.debug(line)
        }
      }
      await hydrateQqImages(account, message)
      routeInbound(account, message)
      return
    }
    if (eventType === 'READY' || eventType === 'RESUMED') {
      const user = payload?.user || {}
      if (eventType === 'READY' && user.id) {
        account.bot = {
          id: String(user.id || ''),
          username: String(user.username || ''),
          avatar: String(user.avatar || ''),
        }
        account.updatedAt = Date.now()
        schedulePersist()
      }
      setStatus(account, 'online')
      return
    }
    if (LIFECYCLE_EVENTS.has(eventType)) {
      routeLifecycleEvent(account, eventType, payload, raw)
      return
    }
    if (String(eventType).startsWith('GROUP_')) {
      ctx.logger.info(`[qqbot] 未处理群事件 ${eventType}，payload keys=${Object.keys(payload || {}).join(',')}`)
    } else {
      ctx.logger.debug(`[qqbot] 未处理事件 ${eventType}`)
    }
  }

  /* ---------------- WebSocket 网关 ---------------- */

  async function wsLoop(account) {
    const rt = runtimeFor(account.accountId)
    if (rt.wsTask && !rt.wsTask.done) return rt.wsTask
    const epoch = ++rt.epoch
    rt.stopping = false
    rt.started = true
    rt.wsTask = (async () => {
      let delay = 1000
      while (!closed && !rt.stopping && rt.epoch === epoch) {
        if (typeof WebSocket !== 'function') {
          setStatus(account, 'error', '当前 Node 不支持 WebSocket（需要 Node 22+）。可在接入方式里改用 Webhook 回调。')
          return
        }
        setStatus(account, 'connecting')
        let ws = null
        try {
          const gateway = await apiRequest(account, '/gateway/bot')
          if (gateway?._error) throw new Error(gateway._error)
          const gatewayUrl = String(gateway?.url || '')
          if (!gatewayUrl) throw new Error('网关未返回 WebSocket 地址（机器人可能未开通 WebSocket 接入）')
          account.wsUrl = gatewayUrl
          account.shards = Math.max(1, Number(gateway.shards) || 1)
          ws = new WebSocket(gatewayUrl)
          rt.ws = ws
          let heartbeat = null
          let lastSeq = Number(account.wsLastSeq) || 0
          let resolveClosed
          const closedPromise = new Promise(resolve => {
            resolveClosed = resolve
          })
          const sendJson = payload => {
            if (ws && ws.readyState === 1) ws.send(JSON.stringify(payload))
          }

          const hello = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
              cleanup()
              reject(new Error('等待网关 Hello 超时'))
            }, 15000)
            const cleanup = () => {
              clearTimeout(timer)
              ws.removeEventListener('message', onMessage)
              ws.removeEventListener('close', onClose)
              ws.removeEventListener('error', onError)
            }
            const onMessage = event => {
              let message = null
              try {
                message = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data))
              } catch (_) {
                return
              }
              if (message.op === 10) {
                cleanup()
                resolve(message)
              } else if (message.op === 9) {
                cleanup()
                reject(new Error('网关拒绝会话（Invalid Session）'))
              }
            }
            const onClose = () => {
              cleanup()
              reject(new Error('连接在 Hello 前关闭'))
            }
            const onError = () => {
              cleanup()
              reject(new Error('WebSocket 连接错误'))
            }
            ws.addEventListener('message', onMessage)
            ws.addEventListener('close', onClose)
            ws.addEventListener('error', onError)
          })
          if (closed || rt.stopping || rt.epoch !== epoch) {
            try {
              ws.close()
            } catch (_) {
              /* ignore */
            }
            return
          }
          const heartbeatMs = Math.max(10000, Math.round((Number(hello?.d?.heartbeat_interval) || 40000) * 0.8))
          const token = await ensureAccessToken(account)
          const intents = accountIntents(account)
          const sessionId = String(account.wsSessionId || '')
          if (sessionId) {
            sendJson({ op: 6, d: { token: `QQBot ${token}`, session_id: sessionId, seq: lastSeq } })
          } else {
            sendJson({ op: 2, d: { token: `QQBot ${token}`, intents, shard: [0, Math.max(1, Number(account.shards) || 1)] } })
          }
          heartbeat = setInterval(() => sendJson({ op: 1, d: lastSeq }), heartbeatMs)

          let readyResolve
          let readyReject
          const readyPromise = new Promise((resolve, reject) => {
            readyResolve = resolve
            readyReject = reject
          })
          const readyTimer = setTimeout(() => readyReject(new Error('网关未在 20 秒内 Ready')), 20000)

          const onMessage = event => {
            let message = null
            try {
              message = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data))
            } catch (_) {
              return
            }
            const op = Number(message?.op)
            if (Number.isFinite(Number(message?.s))) {
              lastSeq = Number(message.s) || lastSeq
              account.wsLastSeq = lastSeq
            }
            if (op === 0) {
              const eventType = String(message.t || '')
              if (eventType === 'READY') {
                account.wsSessionId = String(message?.d?.session_id || '')
                clearTimeout(readyTimer)
                readyResolve()
              } else if (eventType === 'RESUMED') {
                clearTimeout(readyTimer)
                readyResolve()
              }
              handleGatewayEvent(account, eventType, message.d || {}, message).catch(err => ctx.logger.warn(`[qqbot] 事件处理失败：${err?.message || err}`))
            } else if (op === 7) {
              try {
                ws.close(4000, 'reconnect')
              } catch (_) {
                /* ignore */
              }
            } else if (op === 9) {
              account.wsSessionId = ''
              account.wsLastSeq = 0
              rt.wsSessionId = ''
              rt.wsLastSeq = 0
              try {
                ws.close(4001, 'invalid session')
              } catch (_) {
                /* ignore */
              }
            }
          }
          const onClose = event => {
            clearTimeout(readyTimer)
            if (heartbeat) clearInterval(heartbeat)
            rt.ws = null
            const code = Number(event?.code)
            if (code === 4914 || code === 4915) {
              // intents 未授权：通常是机器人没有被开放群聊/频道事件权限。
              rt.stopping = true
              setStatus(account, 'error', `QQ 网关拒绝了当前 intents（关闭码 ${code}）：请确认机器人已开通对应的群聊/频道事件权限，或关闭高级里的频道选项。`)
            } else if (code === 4004) {
              rt.stopping = true
              account.accessToken = ''
              setStatus(account, 'error', 'QQ 网关鉴权失败（关闭码 4004）：请检查 AppID/AppSecret，或重新扫码登录。')
            }
            try {
              readyReject(new Error('连接在 Ready 前关闭'))
            } catch (_) {
              /* 已经 Ready 时 reject 无效 */
            }
            resolveClosed(event)
          }
          const onError = () => {
            /* close 事件会统一处理重连 */
          }
          ws.addEventListener('message', onMessage)
          ws.addEventListener('close', onClose)
          ws.addEventListener('error', onError)

          await Promise.race([
            readyPromise,
            sleep(20000).then(() => {
              throw new Error('网关未在 20 秒内 Ready')
            }),
          ])
          setStatus(account, 'online')
          delay = 1000
          await closedPromise
          clearInterval(heartbeat)
          ws.removeEventListener?.('message', onMessage)
          ws.removeEventListener?.('close', onClose)
          ws.removeEventListener?.('error', onError)
          if (closed || rt.stopping || rt.epoch !== epoch) break
          setStatus(account, 'connecting', '连接已断开，正在重连…')
        } catch (err) {
          try {
            ws?.close()
          } catch (_) {
            /* ignore */
          }
          if (closed || rt.stopping || rt.epoch !== epoch) break
          setStatus(account, 'error', err?.message || String(err))
          ctx.logger.warn(`[qqbot] 账号 ${account.accountId} 连接失败：${err?.message || err}`)
        }
        if (closed || rt.stopping || rt.epoch !== epoch) break
        await sleep(delay)
        delay = Math.min(delay * 2, 60000)
      }
      rt.wsTask = null
    })()
    return rt.wsTask
  }

  async function startWebhookAccount(account) {
    try {
      await ensureAccessToken(account)
      await fetchBotProfile(account)
      setStatus(account, 'online', '')
    } catch (err) {
      setStatus(account, 'error', err?.message || String(err))
    }
  }

  function startAccount(account) {
    if (!account || closed) return Promise.resolve()
    const rt = runtimeFor(account.accountId)
    rt.stopping = false
    // 进程重启后不要 RESUMED 旧会话：让网关重新 Identify 一次，
    // 确保 QQ 群刚授权的新权限 / 新事件类型立即生效（AstrBot 每次启动也是重新 Identify）。
    if (!rt.started) {
      account.wsSessionId = ''
      account.wsLastSeq = 0
    }
    if (account.transport === 'webhook') return startWebhookAccount(account)
    if (rt.wsTask && !rt.wsTask.done) return rt.wsTask
    return wsLoop(account).catch(err => {
      ctx.logger.warn(`[qqbot] WebSocket 任务异常：${err?.message || err}`)
      if (!closed) setStatus(account, 'error', err?.message || String(err))
    })
  }

  function stopAccount(account, { clearCredentials = false } = {}) {
    if (!account) return
    const rt = runtimeFor(account.accountId)
    rt.stopping = true
    rt.epoch += 1
    try {
      rt.ws?.close?.()
    } catch (_) {
      /* ignore */
    }
    rt.ws = null
    rt.wsTask = null
    if (rt.qrPolling) {
      rt.qrEpoch = null
      rt.qrPolling = null
    }
    account.wsSessionId = ''
    account.wsLastSeq = 0
    if (clearCredentials) {
      account.accessToken = ''
      account.tokenExpiresAt = 0
    }
    setStatus(account, 'offline')
    schedulePersist()
  }

  /* ---------------- 扫码适配器 ---------------- */

  function qqBindBase(host) {
    const raw = String(host ?? DEFAULT_BIND_HOST).trim() || DEFAULT_BIND_HOST
    return /^https?:\/\//i.test(raw) ? trimSlash(raw) : `https://${trimSlash(raw)}`
  }

  function qrConfigFor(account, channelId, body = {}) {
    const cfg = channelConfig(account, channelId, false)
    return { host: qqBindBase(body.bindHost || cfg?.bindHost || '') }
  }
  function pickFirst(object, keys) {
    for (const key of keys) {
      const value = object?.[key]
      if (value !== undefined && value !== null && String(value).trim() !== '') return value
    }
    return ''
  }

  function normalizeQrResponse(config, result) {
    const info = result?.data || {}
    let content = String(pickFirst(info, ['qrcode', 'qr_code', 'qrCode', 'ticket', 'code', 'url', 'qrcode_url', 'qrcodeUrl']) || '')
    const imageRaw = String(pickFirst(info, ['qrcode_img_content', 'image_url', 'imageUrl', 'image', 'img', 'qr_image', 'base64']) || '')
    let imageUrl = ''
    if (/^https?:\/\//i.test(imageRaw) || /^data:image\//i.test(imageRaw)) imageUrl = imageRaw
    // 有些实现直接把二维码 PNG 的 base64 放在 image 字段里：当作 content 交给前端渲染。
    else if (!content && /^[A-Za-z0-9+/=\s]{80,}$/.test(imageRaw)) content = imageRaw.replace(/\s+/g, '')
    const id = String(pickFirst(info, ['id', 'qrcode_id', 'ticket', 'code', 'login_id', 'loginId']) || content || '')
    return { id, content, imageUrl }
  }

  function normalizeQrStatus(result) {
    const info = result?.data || {}
    const status = String(pickFirst(info, ['status', 'state', 'qr_status', 'qrStatus']) || '').toLowerCase()
    const mapped =
      ['confirmed', 'confirm', 'success', 'authorized', 'ok', 'scanned_confirmed', 'login'].includes(status)
        ? 'confirmed'
        : ['scanned', 'scan', 'wait_confirm', 'waiting_confirm'].includes(status)
          ? 'scanned'
          : ['expired', 'timeout', 'invalid'].includes(status)
            ? 'expired'
            : ['error', 'failed', 'fail'].includes(status)
              ? 'error'
              : ['cancel', 'canceled', 'cancelled', 'reject', 'rejected'].includes(status)
                ? 'canceled'
                : status || 'wait_scan'
    const credentials = {}
    const appId = String(pickFirst(info, ['app_id', 'appId', 'bot_appid', 'botAppId', 'appid']) || '')
    const appSecret = String(pickFirst(info, ['app_secret', 'appSecret', 'bot_secret', 'botSecret', 'secret']) || '')
    const accessToken = String(pickFirst(info, ['access_token', 'accessToken', 'bot_token', 'botToken', 'token']) || '')
    const gatewayUrl = String(pickFirst(info, ['gateway_url', 'gatewayUrl', 'ws_url', 'wsUrl', 'websocket_url']) || '')
    const expiresIn = Number(pickFirst(info, ['expires_in', 'expiresIn']) || 0)
    if (appId) credentials.appId = appId
    if (appSecret) credentials.appSecret = appSecret
    if (accessToken) credentials.accessToken = accessToken
    if (gatewayUrl) credentials.gatewayUrl = gatewayUrl
    if (expiresIn) credentials.expiresIn = expiresIn
    return { status: mapped, credentials, message: String(info.message || info.error || info.errmsg || '') }
  }

  function findAccountByQrId(qrId) {
    for (const account of Object.values(data.accounts)) {
      if (account.qr?.id === qrId) return account
    }
    return null
  }

  /** 同一个机器人在本机只保留一份账号状态，合并渠道、绑定、发现与未读队列。 */
  function mergeAccountState(target, source) {
    if (!target || !source || target === source) return
    target.channels = { ...(source.channels || {}), ...(target.channels || {}) }
    const uniqueBy = (list, keyOf) => {
      const seen = new Set()
      const result = []
      for (const item of [...(list || [])].reverse()) {
        const key = keyOf(item)
        if (!key || seen.has(key)) continue
        seen.add(key)
        result.unshift(item)
      }
      return result
    }
    target.discovered = uniqueBy(
      [...(source.discovered || []), ...(target.discovered || [])],
      item => `${item?.sessionType || ''}:${item?.peerId || ''}`,
    ).slice(-MAX_DISCOVER)
    target.inbox = uniqueBy([...(source.inbox || []), ...(target.inbox || [])], item => String(item?.id || '')).slice(-MAX_INBOX)
    target.seen = [...new Set([...(source.seen || []), ...(target.seen || [])])].slice(-MAX_SEEN)
    target.lastInbound = { ...(source.lastInbound || {}), ...(target.lastInbound || {}) }
    target.memberNames = { ...(source.memberNames || {}), ...(target.memberNames || {}) }
    target.sent = { ...(source.sent || {}), ...(target.sent || {}) }
    target.passiveTtl = { ...(source.passiveTtl || {}), ...(target.passiveTtl || {}) }
    if (!target.bot || !Object.keys(target.bot).length) target.bot = source.bot || {}
    target.updatedAt = Date.now()
  }

  /** 扫码确认后把外部服务返回的凭据落到账号上，并复用 OpenAPI 链路。 */
  async function applyQrCredentials(account, credentials) {
    if (!account || !credentials) return false
    const previousId = account.accountId
    const qrChannelId = String(credentials.channelId || account.qr?.channelId || '').trim()
    let changed = false
    if (credentials.appId) {
      const appId = String(credentials.appId).trim()
      const nextId = `app:${appId}`
      const existing = data.accounts[nextId]
      if (existing && existing !== account) {
        // 用户重新扫码绑定了本机已经保存过的同一个机器人：合并旧状态，避免覆盖旧渠道/绑定。
        mergeAccountState(account, existing)
        delete data.accounts[nextId]
      }
      account.accountId = nextId
      account.appId = appId
      account.wsUrl = ''
      changed = true
    }
    if (credentials.appId || credentials.appSecret) {
      // AppID / Secret 变化后旧 access_token 一定失效，强制重新获取。
      account.accessToken = ''
      account.tokenExpiresAt = 0
    }
    if (credentials.appSecret) {
      account.secret = encrypt(String(credentials.appSecret).trim())
      changed = true
    }
    if (credentials.accessToken) {
      account.accessToken = encrypt(String(credentials.accessToken))
      account.tokenExpiresAt = Date.now() + (Number(credentials.expiresIn) || 7200) * 1000
      changed = true
    }
    if (credentials.gatewayUrl) {
      account.wsUrl = String(credentials.gatewayUrl)
      changed = true
    }
    if (!changed) return false
    account.linkAuthorized = true
    account.authMode = 'qrcode'
    account.transport = account.transport === 'webhook' ? 'webhook' : 'ws'
    const scannedUserOpenid = String(credentials.userOpenid || '').trim()
    if (scannedUserOpenid) {
      account.scannedUserOpenid = scannedUserOpenid
      account.updatedAt = Date.now()
      if (qrChannelId) {
        const cfg = channelConfig(account, qrChannelId, true)
        if (!SESSION_TYPES.includes(cfg.sessionType)) cfg.sessionType = 'c2c'
        // 扫码时 QQ 会返回扫码用户自己的 openid：本地自动接入场景下直接绑成默认会话，
        // 用户扫完码后第一条私聊即可进入本渠道；手动绑定模式则只加入信任列表。
        cfg.trustedUserIds = [...new Set([...(cfg.trustedUserIds || []), scannedUserOpenid])]
        if (cfg.autoBind === true && cfg.sessionType === 'c2c') {
          addBinding(account, qrChannelId, 'c2c', scannedUserOpenid, {
            alias: cfg.bindings?.find(item => String(item.peerId) === scannedUserOpenid)?.alias || '扫码用户',
            identityMode: 'owner',
            auto: true,
            channelSessionType: 'c2c',
          })
        }
      }
    }
    account.updatedAt = Date.now()
    rekeyAccount(account, previousId)
    rebuildRoutes(account)
    schedulePersist()
    startAccount(account)
    return true
  }

  /** 生成二维码：QQ 官方“扫码绑定机器人”（AstrBot 4.28 同款 /lite 协议）。 */
  async function qrCreate(account, channelId, config, body = {}) {
    const base = qqBindBase(config?.host)
    const bindKey = randomBytes(32).toString('base64')
    const result = await requestRaw(`${base}/lite/create_bind_task`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: { key: bindKey },
    })
    const info = result?.data || {}
    const retcode = Number(info.retcode ?? 0)
    if (!result.ok || result.error || (info.retcode !== undefined && retcode !== 0)) {
      const detail = [info.msg || info.message, info.retcode !== undefined ? `retcode=${info.retcode}` : "", result.status ? `HTTP ${result.status}` : "", result.error].filter(Boolean).join(" · ")
      throw new Error(`创建 QQ 绑定任务失败：${detail || "未知错误"}`)
    }
    const taskId = String(info?.data?.task_id || '').trim()
    if (!taskId) throw new Error('QQ 绑定接口没有返回 task_id')
    const rt = runtimeFor(account.accountId)
    const startedAt = Date.now()
    const content = `${base}/qqbot/openclaw/connect.html?task_id=${encodeURIComponent(taskId)}&_wv=2&source=nianfeng`
    rt.qr = {
      id: taskId,
      content,
      imageUrl: '',
      status: 'wait_scan',
      error: '',
      startedAt,
      expiresAt: startedAt + 5 * 60 * 1000,
      host: base,
      bindKey,
      config: { host: base },
      channelId,
    }
    account.qr = {
      id: taskId,
      content,
      imageUrl: '',
      status: 'wait_scan',
      error: '',
      host: base,
      bindKey: encrypt(bindKey),
      startedAt,
      channelId,
    }
    schedulePersist()
    // 立即落盘一次：用户在扫码完成前重启程序时，boot() 才能恢复这个任务。
    await persist().catch(() => {})
    return rt.qr
  }

  /** bot_encrypt_secret = base64(nonce[12] + ciphertext + tag[16])，AES-256-GCM。 */
  function decryptSecret(encrypted, bindKey) {
    const raw = Buffer.from(String(encrypted || ''), 'base64')
    const key = Buffer.from(String(bindKey || ''), 'base64')
    if (key.length !== 32 || raw.length <= 28) throw new Error('QQ 绑定凭据密文格式异常')
    const nonce = raw.subarray(0, 12)
    const tag = raw.subarray(raw.length - 16)
    const data = raw.subarray(12, raw.length - 16)
    const decipher = createDecipheriv('aes-256-gcm', key, nonce)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
  }

  /** 重启后恢复未完成的扫码任务（account.qr 已落盘），继续轮询，避免重复扫码。 */
  function restorePendingQr(account) {
    const saved = account?.qr
    if (!saved?.id || account?.appId) return false
    const startedAt = Number(saved.startedAt) || Date.now()
    if (startedAt && Date.now() - startedAt > 5 * 60 * 1000) {
      account.qr = { ...saved, status: 'expired', error: '二维码已过期，请重新获取' }
      return false
    }
    const bindKey = decrypt(saved.bindKey || '')
    if (!bindKey) return false
    const host = qqBindBase(saved.host || DEFAULT_BIND_HOST)
    const rt = runtimeFor(account.accountId)
    rt.qr = {
      id: String(saved.id),
      content: String(saved.content || '').trim() || `${host}/qqbot/openclaw/connect.html?task_id=${encodeURIComponent(saved.id)}&_wv=2&source=nianfeng`,
      imageUrl: String(saved.imageUrl || ''),
      status: 'wait_scan',
      error: String(saved.error || ''),
      startedAt,
      expiresAt: startedAt + 5 * 60 * 1000,
      host,
      bindKey,
      config: { host },
      channelId: String(saved.channelId || ''),
    }
    ensureQrPoll(account)
    return true
  }

  function ensureQrPoll(account) {
    const rt = runtimeFor(account.accountId)
    if (!rt.qr?.config?.host || rt.qr.status === 'confirmed') return
    if (rt.qrPolling && rt.qrEpoch === rt.qr.id) return
    const qrId = rt.qr.id
    const bindKey = rt.qr.bindKey
    const host = rt.qr.config.host
    const startedAt = Number(rt.qr.startedAt) || Date.now()
    const deadline = startedAt + 5 * 60 * 1000
    rt.qrEpoch = qrId
    rt.qrPolling = (async () => {
      let errorStreak = 0
      const syncSavedQr = () => {
        if (!account.qr || String(account.qr.id || '') !== String(qrId)) return
        account.qr.status = rt.qr?.status || account.qr.status
        account.qr.error = rt.qr?.error || ''
        account.qr.startedAt = startedAt
      }
      try {
        while (!closed && rt.qr && rt.qr.id === qrId && rt.qr.status !== 'confirmed') {
          if (Date.now() >= deadline) {
            rt.qr.status = 'expired'
            rt.qr.error = '二维码已过期，请重新获取'
            syncSavedQr()
            hub.broadcast('qqbot:status', { channelId: rt.qr.channelId || '', accountId: account.accountId, status: statusOf(account), qr: rt.qr })
            schedulePersist()
            break
          }
          await sleep(2000)
          if (closed || !rt.qr || rt.qr.id !== qrId || rt.qr.status === 'confirmed') break
          const result = await requestRaw(`${host}/lite/poll_bind_result`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: { task_id: qrId },
          })
          const info = result?.data || {}
          if (!result.ok || result.error) {
            errorStreak += 1
            rt.qr.error = `轮询扫码结果失败：${describeFailure(result, info) || '未知错误'}（连续 ${errorStreak} 次）`
            syncSavedQr()
            hub.broadcast('qqbot:status', { channelId: rt.qr.channelId || '', accountId: account.accountId, status: statusOf(account), qr: rt.qr })
            if (errorStreak >= 5) {
              rt.qr.status = 'error'
              rt.qr.error = `${rt.qr.error}。请检查本机网络 / 代理后重新获取二维码。`
              syncSavedQr()
              hub.broadcast('qqbot:status', { channelId: rt.qr.channelId || '', accountId: account.accountId, status: 'error', qr: rt.qr })
              schedulePersist()
              break
            }
            continue
          }
          const retcode = Number(info.retcode ?? 0)
          if (info.retcode !== undefined && retcode !== 0) {
            errorStreak += 1
            const message = info.msg || info.message || 'QQ 绑定轮询失败'
            rt.qr.error = `${message}（retcode=${retcode}，连续 ${errorStreak} 次）`
            syncSavedQr()
            hub.broadcast('qqbot:status', { channelId: rt.qr.channelId || '', accountId: account.accountId, status: statusOf(account), qr: rt.qr })
            if (errorStreak >= 5) {
              rt.qr.status = 'error'
              rt.qr.error = `${message}。请重新获取二维码。`
              syncSavedQr()
              hub.broadcast('qqbot:status', { channelId: rt.qr.channelId || '', accountId: account.accountId, status: 'error', qr: rt.qr })
              schedulePersist()
              break
            }
            continue
          }
          errorStreak = 0
          const payload = info.data || {}
          const status = Number(payload.status ?? 0)
          if (status === 2) {
            const appId = String(payload.bot_appid || '').trim()
            const encrypted = String(payload.bot_encrypt_secret || '').trim()
              // QQ Connector 1.2.0 起扫码结果里会带 user_openid：用于扫码后自动绑定首个私聊会话 / 加入信任列表。
              const userOpenid = String(payload.user_openid || payload.userOpenid || '').trim()
            if (!appId || !encrypted) {
              rt.qr.status = 'error'
              rt.qr.error = '扫码成功但未返回完整机器人凭证，请重新获取二维码'
            } else {
              try {
                const appSecret = decryptSecret(encrypted, bindKey)
                const applied = await applyQrCredentials(account, {
                  appId,
                  appSecret,
                  userOpenid,
                  channelId: rt.qr.channelId || '',
                })
                rt.qr.status = applied ? 'confirmed' : 'error'
                rt.qr.error = applied ? '' : '扫码凭据写入失败，请重试'
              } catch (err) {
                rt.qr.status = 'error'
                rt.qr.error = `QQ 绑定凭据解密失败：${err?.message || err}`
              }
            }
            syncSavedQr()
            hub.broadcast('qqbot:status', { channelId: rt.qr.channelId || '', accountId: account.accountId, status: statusOf(account), qr: rt.qr })
            schedulePersist()
            break
          }
          if (status === 3) {
            rt.qr.status = 'expired'
            rt.qr.error = '二维码已过期，请重新获取'
            syncSavedQr()
            hub.broadcast('qqbot:status', { channelId: rt.qr.channelId || '', accountId: account.accountId, status: statusOf(account), qr: rt.qr })
            schedulePersist()
            break
          }
          if (rt.qr.status !== 'wait_scan') rt.qr.status = 'wait_scan'
          if (rt.qr.error) {
            rt.qr.error = ''
            syncSavedQr()
            hub.broadcast('qqbot:status', { channelId: rt.qr.channelId || '', accountId: account.accountId, status: statusOf(account), qr: rt.qr })
          }
        }
      } catch (err) {
        if (rt.qr) rt.qr.error = err?.message || String(err)
        syncSavedQr()
        ctx.logger.warn(`[qqbot] 扫码轮询失败：${err?.message || err}`)
      } finally {
        if (rt.qrEpoch === qrId) {
          rt.qrEpoch = null
          rt.qrPolling = null
        }
      }
    })()
  }

  /* ---------------- 发送 ---------------- */

  /** 把 QQ 附件 URL 下载并转存到 image-service；消息里只留 imageId。 */
  async function hydrateQqImages(account, message) {
    const list = Array.isArray(message?._attachmentImages) ? message._attachmentImages.slice(0, MAX_IMAGES_PER_MESSAGE) : []
    delete message?._attachmentImages
    if (!list.length) return message
    const records = []
    let totalBytes = 0
    for (const item of list) {
      try {
        const buffer = await downloadBinary(item.url, { maxBytes: Math.min(MAX_MEDIA_BYTES, 3 * 1024 * 1024) })
        if (!buffer || totalBytes + buffer.length > 6 * 1024 * 1024) continue
        totalBytes += buffer.length
        const record = await saveImageBuffer(
          settings.dataDir,
          buffer,
          { mime: item.mime, width: item.width, height: item.height },
          { keep: imageKeep() },
        )
        records.push({ id: record.id, mime: record.mime, width: record.width, height: record.height, size: record.size })
      } catch (_) {
        /* 单张失败不影响文本消息 */
      }
    }
    message.images = records
    return message
  }

  function resolveSendTarget(account, channelId, body = {}) {
    const cfg = channelConfig(account, channelId, false)
    if (!cfg) return null
    let sessionType = String(body.sessionType || '')
    let peerId = String(body.peerId || '')
    if (!sessionType || !peerId) {
      const fallback = account.lastInbound?.[channelId]
      if (fallback) {
        sessionType = sessionType || fallback.sessionType
        peerId = peerId || fallback.peerId
      }
    }
    if (!sessionType || !peerId) {
      const binding = (cfg.bindings || [])[0]
      if (binding) {
        sessionType = sessionType || binding.sessionType
        peerId = peerId || String(binding.peerId)
      }
    }
    if (!sessionType || !peerId) return null
    const binding = (cfg.bindings || []).find(item => item.sessionType === sessionType && String(item.peerId) === peerId)
    return { sessionType, peerId, binding: binding || null }
  }

  function nextPassiveSeq(account, target, msgId) {
    const key = `${target.sessionType}:${target.peerId}:${msgId}`
    let record = account.sent[key]
    if (!record) record = { firstAt: Date.now(), nextSeq: 1, count: 0 }
    // 被动回复窗口官方口径不一致（单聊 60 分钟 / 群聊 5 分钟 vs SDK 的 5 分钟）。
    // 这里不预先按 TTL 拒绝：总是尝试带 msg_id 被动回复，由 QQ 接口返回真实原因；
    // 只有渠道显式配置 passiveTtlMs 时才做软过期。
    const softTtl = Number(account.passiveTtl?.[target.sessionType]) || 0
    if (softTtl > 0 && Date.now() - Number(record.firstAt || 0) > softTtl) {
      return { ok: false, code: 'PASSIVE_EXPIRED', error: '被动回复窗口已过期（渠道里配置了 softTtlMs）' }
    }
    if (record.nextSeq > PASSIVE_MAX_REPLIES) {
      return { ok: false, code: 'PASSIVE_LIMIT', error: `同一条 QQ 消息最多被动回复 ${PASSIVE_MAX_REPLIES} 次，本条已超过上限` }
    }
    const seq = record.nextSeq
    record.nextSeq += 1
    record.count = (record.count || 0) + 1
    record.lastAt = Date.now()
    account.sent[key] = record
    if (Object.keys(account.sent).length > 500) {
      const keys = Object.keys(account.sent).sort((a, b) => (account.sent[a].lastAt || 0) - (account.sent[b].lastAt || 0))
      for (const old of keys.slice(0, keys.length - 300)) delete account.sent[old]
    }
    return { ok: true, seq }
  }

  function messagePathFor(target) {
    if (target.sessionType === 'group') return `/v2/groups/${encodeURIComponent(target.peerId)}/messages`
    if (target.sessionType === 'c2c') return `/v2/users/${encodeURIComponent(target.peerId)}/messages`
    if (target.sessionType === 'guild') return `/channels/${encodeURIComponent(target.peerId)}/messages`
    return ''
  }

  function isPassiveExpired(result) {
    const code = String(result?.code ?? result?.errcode ?? result?._httpStatus ?? '')
    const message = String(result?.message || result?.errmsg || result?._error || '')
    return [11244, 11245, 11253, 40034].includes(Number(code)) || /msg_id|消息.*(过期|无效)|passive|expired/i.test(message)
  }

  /** image: { dataUrl | url | base64, mime?, name? } -> { base64, mime } */
  async function resolveImageBytes(image) {
    if (!image) return null
    if (typeof image === 'object' && image.id) {
      const found = await readImageBuffer(settings.dataDir, image.id)
      if (found) return { base64: found.buffer.toString('base64'), mime: found.record.mime || image.mime || 'image/jpeg' }
    }
    const source = typeof image === 'string' ? image : image.dataUrl || image.url || image.base64 || ''
    if (!source) return null
    if (/^data:/i.test(source)) {
      const match = source.match(/^data:([^;,]+)?(;base64)?,([\s\S]*)$/)
      if (!match) return null
      const mime = image.mime || match[1] || 'image/jpeg'
      const base64 = match[2] ? match[3].replace(/\s+/g, '') : Buffer.from(decodeURIComponent(match[3]), 'utf8').toString('base64')
      if (Buffer.byteLength(base64, 'base64') > MAX_MEDIA_BYTES) return null
      return { base64, mime }
    }
    if (/^https?:/i.test(source)) {
      const buffer = await downloadBinary(source)
      if (!buffer) return null
      return { base64: buffer.toString('base64'), mime: image.mime || 'image/jpeg' }
    }
    const base64 = String(source).replace(/\s+/g, '')
    if (Buffer.byteLength(base64, 'base64') > MAX_MEDIA_BYTES) return null
    return { base64, mime: image.mime || 'image/jpeg' }
  }

  async function downloadBinary(url, { timeoutMs = 30000, maxBytes = MAX_MEDIA_BYTES } = {}) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('请求超时')), Math.max(2000, Number(timeoutMs) || 30000))
    try {
      const response = await fetchWithNetworkRetry(url, { signal: controller.signal })
      if (!response.ok) return null
      const buffer = Buffer.from(await response.arrayBuffer())
      if (buffer.length > maxBytes) return null
      return buffer
    } catch (_) {
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  async function uploadQqImage(account, target, image) {
    const media = await resolveImageBytes(image)
    if (!media) return { ok: false, code: 'IMAGE_INVALID', error: '图片为空、超过大小限制或下载失败' }
    let path = ''
    const body = { file_data: media.base64, file_type: 1, srv_send_msg: false }
    if (target.sessionType === 'group') {
      path = `/v2/groups/${encodeURIComponent(target.peerId)}/files`
      body.group_openid = target.peerId
    } else if (target.sessionType === 'c2c') {
      path = `/v2/users/${encodeURIComponent(target.peerId)}/files`
      body.openid = target.peerId
    } else {
      return { ok: false, code: 'UNSUPPORTED', error: `会话类型 ${target.sessionType} 暂不支持图片` }
    }
    const result = await apiRequest(account, path, { method: 'POST', body })
    if (result?._error) return { ok: false, code: 'IMAGE_UPLOAD_FAILED', error: result._error }
    if (!result?.file_info) {
      return { ok: false, code: 'IMAGE_UPLOAD_FAILED', error: result?.message || result?.errmsg || 'QQ 文件上传接口没有返回 file_info', raw: result }
    }
    return { ok: true, media: { file_uuid: result.file_uuid || '', file_info: result.file_info, ttl: Number(result.ttl) || 0 } }
  }

  function looksLikeSilkBuffer(buffer) {
    if (!buffer || buffer.length < 8) return false
    const head = buffer.subarray(0, 16).toString('latin1')
    return head.includes('SILK')
  }

  /** voice: dataUrl / base64 / url / file；QQ 官方语音要求 SILK 格式。 */
  async function resolveVoiceBytes(voice) {
    if (!voice) return null
    const source = typeof voice === 'string' ? voice : voice.dataUrl || voice.url || voice.base64 || voice.file || ''
    if (!source) return null
    if (/^data:/i.test(source)) {
      const match = String(source).match(/^data:([^;,]+)?(;base64)?,([\s\S]*)$/)
      if (!match) return null
      const mime = voice.mime || match[1] || 'audio/silk'
      const base64 = match[2] ? match[3].replace(/\s+/g, '') : Buffer.from(decodeURIComponent(match[3]), 'utf8').toString('base64')
      if (Buffer.byteLength(base64, 'base64') > MAX_MEDIA_BYTES) return null
      return { base64, mime, bytes: Buffer.from(base64, 'base64') }
    }
    if (/^https?:/i.test(source)) {
      const buffer = await downloadBinary(source, { maxBytes: MAX_MEDIA_BYTES })
      if (!buffer) return null
      return { base64: buffer.toString('base64'), mime: voice.mime || 'audio/silk', bytes: buffer }
    }
    const base64 = String(source).replace(/\s+/g, '')
    if (Buffer.byteLength(base64, 'base64') > MAX_MEDIA_BYTES) return null
    return { base64, mime: voice.mime || 'audio/silk', bytes: Buffer.from(base64, 'base64') }
  }

  async function uploadQqVoice(account, target, voice) {
    const media = await resolveVoiceBytes(voice)
    if (!media) return { ok: false, code: 'VOICE_INVALID', error: '语音数据为空、超过大小限制或下载失败' }
    if (!looksLikeSilkBuffer(media.bytes)) {
      return {
        ok: false,
        code: 'VOICE_FORMAT_INVALID',
        error: 'QQ 官方机器人语音需要 SILK 格式；请先用 ffmpeg + silk-wasm 转码后再发送',
      }
    }
    const path =
      target.sessionType === 'group'
        ? `/v2/groups/${encodeURIComponent(target.peerId)}/files`
        : target.sessionType === 'c2c'
          ? `/v2/users/${encodeURIComponent(target.peerId)}/files`
          : ''
    if (!path) return { ok: false, code: 'UNSUPPORTED', error: `会话类型 ${target.sessionType} 暂不支持语音` }
    const body = { file_data: media.base64, file_type: 3, srv_send_msg: false }
    if (target.sessionType === 'group') body.group_openid = target.peerId
    else body.openid = target.peerId
    const result = await apiRequest(account, path, { method: 'POST', body })
    if (result?._error) return { ok: false, code: 'VOICE_UPLOAD_FAILED', error: result._error }
    if (!result?.file_info) {
      return { ok: false, code: 'VOICE_UPLOAD_FAILED', error: result?.message || result?.errmsg || 'QQ 文件上传接口没有返回 file_info', raw: result }
    }
    return { ok: true, media: { file_uuid: result.file_uuid || '', file_info: result.file_info, ttl: Number(result.ttl) || 0 } }
  }

  /** 只镜像 image-service 里的图片引用，避免把 base64 / data URL 写进对方聊天记录。 */
  function mirrorImageRefs(images) {
    const list = []
    for (const image of Array.isArray(images) ? images : []) {
      if (image && typeof image === 'object' && image.id) {
        list.push({
          id: String(image.id),
          mime: String(image.mime || ''),
          width: Number(image.width) || 0,
          height: Number(image.height) || 0,
          size: Number(image.size) || 0,
        })
      }
    }
    return list.slice(0, MAX_IMAGES_PER_MESSAGE)
  }

  /**
   * 同群多机器人联动：把本渠道刚发出的群消息镜像给填了同一个 linkGroupId 的其它
   * QQ 官方机器人渠道。镜像只写入对方本机 inbox / SSE，不调用 QQ 接口；对方前端
   * 按 message.linkedBot 决定只写入上下文，还是按联动规则自动接话。
   */
  function mirrorOutboundToLinkedChannels(account, channelId, target, payload = {}) {
    if (!account || target?.sessionType !== 'group') return 0
    const sourceCfg = channelConfig(account, channelId, false)
    const linkGroupId = String(sourceCfg?.linkGroupId || '').trim()
    if (!linkGroupId) return 0
    const text = String(payload.text || '').trim().slice(0, MAX_MESSAGE_CHARS)
    const images = mirrorImageRefs(payload.images)
    if (!text && !images.length) return 0
    const senderName = String(sourceCfg?.channelName || account.bot?.username || '另一个角色').trim() || '另一个角色'
    let mirrored = 0
    for (const [targetAccountId, targetAccount] of Object.entries(data.accounts || {})) {
      if (!targetAccount || targetAccount === account) continue
      for (const [targetChannelId, cfg] of Object.entries(targetAccount.channels || {})) {
        if (!cfg || cfg.disabled === true || cfg.sessionType !== 'group') continue
        if (String(cfg.linkGroupId || '').trim() !== linkGroupId) continue
        const binding = (cfg.bindings || []).find(item => item.sessionType === 'group' && String(item.peerId || '').trim())
        if (!binding) continue
        const message = {
          id: `qq-link-${channelId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
          channelId: targetChannelId,
          sessionType: 'group',
          peerId: String(binding.peerId),
          peerName: String(cfg.channelName || ''),
          senderId: `qqbot-bot:${account.accountId}`,
          senderName,
          senderNameResolved: true,
          text: text || '[图片]',
          media: false,
          images,
          mentionedSelf: false,
          linkedBot: true,
          linkFromAccountId: String(account.accountId || ''),
          linkFromChannelId: String(channelId || ''),
          qqMessageId: '',
          eventId: '',
          timestamp: Date.now(),
          receivedAt: Date.now(),
        }
        pushInbox(targetAccount, message)
        targetAccount.updatedAt = Date.now()
        schedulePersist()
        hub.broadcast('qqbot:message', { channelId: targetChannelId, message: publicInbound(message) })
        mirrored += 1
      }
    }
    if (mirrored) ctx.logger?.debug?.(`[qqbot] 联动镜像 ${channelId} → ${mirrored} 个渠道`)
    return mirrored
  }

  async function sendMessage(account, body = {}) {
    const channelId = String(body.channelId || '').trim()
    if (!channelId) return { ok: false, code: 'BAD_REQUEST', error: '缺少 channelId' }
    const target = resolveSendTarget(account, channelId, body)
    if (!target) return { ok: false, code: 'NO_BINDING', error: '该渠道还没有绑定 QQ 会话，请先在渠道详情里绑定一个私聊/群聊' }
    const text = String(body.text || '').trim().slice(0, MAX_MESSAGE_CHARS)
    const images = Array.isArray(body.images) ? body.images.slice(0, MAX_IMAGES_PER_MESSAGE) : []
    const voice = body.voice && typeof body.voice === 'object' ? body.voice : body.audio && typeof body.audio === 'object' ? body.audio : null
    if (!text && !images.length && !voice) return { ok: false, code: 'EMPTY', error: '回复内容为空' }
    if (!messagePathFor(target)) return { ok: false, code: 'UNSUPPORTED', error: `未知会话类型 ${target.sessionType}` }

    // 被动 vs 主动：默认总是带 msg_id 走被动；QQ 接口返回过期/无效时由前端决定是否改发主动。
    // quote === false 且是群聊时，允许调用方明确要求“不引用”，走主动消息。
    // 实际前端会同时传 active；这里兜底保证 QQ 官方服务接口也遵守同一语义。
    const quoteDisabled = body.quote === false && target.sessionType === 'group'
    const passive = body.active === true || quoteDisabled ? false : String(body.msgId || account.lastInbound?.[channelId]?.qqMessageId || '').trim()
    // 和 AstrBot 一致：被动回复只带 msg_id + msg_seq；主动消息不带 msg_id。
    // 是否引用由前端决定带不带 msg_id（群聊 quote 开关），不再额外塞 message_reference / event_id。
    const basePayload = { content: text, msg_type: 0 }
    if (passive) {
      const seqInfo = nextPassiveSeq(account, target, passive)
      if (!seqInfo.ok) return seqInfo
      basePayload.msg_id = passive
      basePayload.msg_seq = seqInfo.seq
    }
    const results = []
    const path = messagePathFor(target)
    if (text) {
      const result = await apiRequest(account, path, { method: 'POST', body: basePayload })
      const failed = result?._error || (result?.code && Number(result.code) !== 0 && !result.id)
      if (failed) {
        const code = result?._error ? 'API_ERROR' : isPassiveExpired(result) ? 'PASSIVE_EXPIRED' : String(result.code)
        return { ok: false, code, error: result?._error || result?.message || 'QQ 接口返回错误', raw: result }
      }
      results.push({ kind: 'text', id: String(result?.id || ''), mode: passive ? 'passive' : 'active', msgSeq: basePayload.msg_seq || 0 })
    }
    for (const image of images) {
      const uploaded = await uploadQqImage(account, target, image)
      if (!uploaded.ok) return { ok: false, ...uploaded, sent: results }
      const imagePassive = passive ? nextPassiveSeq(account, target, passive) : null
      if (passive && !imagePassive.ok) return { ok: false, ...imagePassive, sent: results }
      const payload = { content: '', msg_type: 7, media: uploaded.media }
      if (passive) {
        payload.msg_id = passive
        payload.msg_seq = imagePassive.seq
      }
      const result = await apiRequest(account, path, { method: 'POST', body: payload })
      const failed = result?._error || (result?.code && Number(result.code) !== 0 && !result.id)
      if (failed) {
        const code = result?._error ? 'API_ERROR' : isPassiveExpired(result) ? 'PASSIVE_EXPIRED' : String(result.code)
        return { ok: false, code, error: result?._error || result?.message || 'QQ 图片发送失败', raw: result, sent: results }
      }
      results.push({ kind: 'image', id: String(result?.id || ''), mode: passive ? 'passive' : 'active', msgSeq: payload.msg_seq || 0 })
    }
    if (voice) {
      const uploaded = await uploadQqVoice(account, target, voice)
      if (!uploaded.ok) return { ok: false, ...uploaded, sent: results }
      const voicePassive = passive ? nextPassiveSeq(account, target, passive) : null
      if (passive && !voicePassive.ok) return { ok: false, ...voicePassive, sent: results }
      const payload = { content: '', msg_type: 7, media: uploaded.media }
      if (passive) {
        payload.msg_id = passive
        payload.msg_seq = voicePassive.seq
      }
      const result = await apiRequest(account, path, { method: 'POST', body: payload })
      const failed = result?._error || (result?.code && Number(result.code) !== 0 && !result.id)
      if (failed) {
        const code = result?._error ? 'API_ERROR' : isPassiveExpired(result) ? 'PASSIVE_EXPIRED' : String(result.code)
        return { ok: false, code, error: result?._error || result?.message || 'QQ 语音发送失败', raw: result, sent: results }
      }
      results.push({
        kind: 'voice',
        // 不同 QQ 接口版本 / 消息类型回传的 id 字段可能不同，全部兜底，避免工具层把“没拿到 id”误判成发送失败。
        id: String(result?.id || result?.message_id || result?.messageId || result?.data?.id || ''),
        mode: passive ? 'passive' : 'active',
        msgSeq: payload.msg_seq || 0,
      })
    }
    // 同群多机器人联动：发送成功后，把消息镜像给填了同一个 linkGroupId 的其它机器人渠道。
    const mirroredImages = results.some(item => item.kind === 'image') ? images : []
    const mirroredText = results.some(item => item.kind === 'text')
      ? text
      : results.some(item => item.kind === 'voice')
        ? '[语音]'
        : mirroredImages.length
          ? '[图片]'
          : ''
    if (mirroredText || mirroredImages.length) {
      try {
        mirrorOutboundToLinkedChannels(account, channelId, target, { text: mirroredText, images: mirroredImages })
      } catch (err) {
        ctx.logger?.warn?.(`[qqbot] 联动镜像写入失败：${err?.message || err}`)
      }
    }
    account.updatedAt = Date.now()
    schedulePersist()
    const first = results[0] || {}
    return {
      ok: true,
      id: first.id || '',
      mode: first.mode || (passive ? 'passive' : 'active'),
      msgId: passive || '',
      msgSeq: first.msgSeq || 0,
      sent: results,
      channelId,
      sessionType: target.sessionType,
      peerId: target.peerId,
    }
  }

  /* ---------------- HTTP 路由 ---------------- */

  const readRawBody = req =>
    new Promise((resolve, reject) => {
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
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', reject)
    })

  const routes = []
  // boot() 里的 loadState 是异步的；所有请求先等它完成，避免刚登录的账号被随后
  // 载入的空状态覆盖（启动瞬间的竞态）。
  let markReady = () => {}
  const ready = new Promise(resolve => {
    markReady = resolve
  })
  const wrap = handler => async (req, res, params, url) => {
    try {
      await ready
      await handler(req, res, params, url)
    } catch (err) {
      ctx.logger.warn(`[qqbot] HTTP 处理失败：${err?.message || err}`)
      httpApi.sendJson(res, Number(err?.status) || 500, { ok: false, error: err?.message || String(err), code: err?.code || '' })
    }
  }

  routes.push(
    httpApi.route(
      'POST',
      '/api/qqbot/login/start',
      wrap(async (req, res) => {
        const body = await httpApi.readBody(req)
        const channelId = String(body.channelId || '').trim()
        const mode = String(body.mode || 'qrcode').toLowerCase()
        if (!channelId) return httpApi.sendJson(res, 400, { ok: false, error: '缺少 channelId' })

        // reconnect：使用本机已保存的凭据重连；也支持把一个已登录账号附加到新渠道。
        if (mode === 'reconnect') {
          const account =
            (body.accountId ? findAccountById(String(body.accountId)) : null) ||
            (body.appId ? findAccountByAppId(String(body.appId)) : null) ||
            findAccountForChannel(channelId)
          if (!account) {
            return httpApi.sendJson(res, 200, {
              ok: false,
              code: 'NO_ACCOUNT',
              error: '该渠道还没有登录信息，请先用手机 QQ 扫码接入或填写 AppID / AppSecret',
            })
          }
          if (['ws', 'webhook'].includes(body.transport)) account.transport = body.transport
          const cfg = channelConfig(account, channelId, true)
          if (SESSION_TYPES.includes(String(body.sessionType || ''))) cfg.sessionType = String(body.sessionType)
          if (body.autoBind !== undefined) cfg.autoBind = body.autoBind === true
          cfg.disabled = false
          account.updatedAt = Date.now()
          rebuildRoutes(account)
          schedulePersist()
          if (body.force === true) {
            // 群权限 / intents 变化后，QQ 有时要重新 Identify 才会开始推新事件。
            stopAccount(account)
            await sleep(120)
          }
          startAccount(account)
          return httpApi.sendJson(res, 200, { ok: true, ...publicStatus(account, channelId) })
        }

        // 手动 AppID + AppSecret
        if (mode === 'manual') {
          const appId = String(body.appId || '').trim()
          const appSecret = String(body.appSecret || '').trim()
          if (!appId || !appSecret) return httpApi.sendJson(res, 200, { ok: false, code: 'BAD_CREDENTIALS', error: '请填写 AppID 和 AppSecret' })
          const accountId = String(body.accountId || `app:${appId}`)
          let account = findAccountById(accountId)
          if (!account) {
            account = normalizeAccount({
              accountId,
              appId,
              secret: '',
              accessToken: '',
              tokenExpiresAt: 0,
              transport: ['ws', 'webhook'].includes(body.transport) ? body.transport : 'ws',
              sandbox: body.sandbox === true,
              channels: {},
              discovered: [],
              inbox: [],
              seen: [],
              sent: {},
              lastInbound: {},
              bot: {},
              updatedAt: Date.now(),
            })
            data.accounts[accountId] = account
          }
          account.appId = appId
          account.secret = encrypt(appSecret)
          account.accessToken = ''
          account.tokenExpiresAt = 0
          account.wsUrl = ''
          account.transport = ['ws', 'webhook'].includes(body.transport) ? body.transport : account.transport || 'ws'
          account.sandbox = body.sandbox === true
          account.authMode = 'manual'
          account.sandboxFallback = false
          account.sandboxFallbackReason = ''
          account.updatedAt = Date.now()
          const manualCfg = channelConfig(account, channelId, true)
          manualCfg.disabled = false
          if (SESSION_TYPES.includes(String(body.sessionType || ''))) manualCfg.sessionType = String(body.sessionType)
          if (body.autoBind !== undefined) manualCfg.autoBind = body.autoBind === true
          rebuildRoutes(account)
          schedulePersist()
          const started = startAccount(account)
          if (account.transport === 'webhook') await started.catch(() => {})
          else await sleep(80)
          return httpApi.sendJson(res, 200, { ok: true, ...publicStatus(account, channelId) })
        }

        // 扫码：QQ 官方 /lite 绑定协议。已有凭据时默认直接复用重连，不再生成新二维码，
        // 避免用户重复扫码时手机 QQ 提示“机器人已绑定”。
        const accountId = String(body.accountId || `qr:${channelId}`)
        const forceBind = body.forceBind === true
        let account = findAccountById(accountId) || findAccountForChannel(channelId)

        if (account && account.appId && (account.secret || account.accessToken) && !forceBind) {
          const cfg = channelConfig(account, channelId, true)
          cfg.disabled = false
          if (SESSION_TYPES.includes(String(body.sessionType || ''))) cfg.sessionType = String(body.sessionType)
          if (body.autoBind !== undefined) cfg.autoBind = body.autoBind === true
          account.updatedAt = Date.now()
          rebuildRoutes(account)
          schedulePersist()
          startAccount(account)
          return httpApi.sendJson(res, 200, { ok: true, reused: true, ...publicStatus(account, channelId) })
        }

        // 已有一个未完成 / 未过期的二维码任务：直接复用，避免用户连点「获取二维码」时
        // 在 QQ 侧创建一大堆任务。
        const pendingQrStatus = String(account?.qr?.status || 'wait_scan')
        const pendingQrForChannel = String(account?.qr?.channelId || '') === String(channelId)
        if (account && !forceBind && !account.appId && pendingQrForChannel && account?.qr?.id && ['wait_scan', 'pending', 'scanned'].includes(pendingQrStatus)) {
          const rt = runtimeFor(account.accountId)
          if (!rt.qr) restorePendingQr(account)
          if (rt.qr?.id) {
            const cfg = channelConfig(account, channelId, true)
            cfg.disabled = false
            if (SESSION_TYPES.includes(String(body.sessionType || ''))) cfg.sessionType = String(body.sessionType)
            if (body.autoBind !== undefined) cfg.autoBind = body.autoBind === true
            account.updatedAt = Date.now()
            rebuildRoutes(account)
            ensureQrPoll(account)
            schedulePersist()
            return httpApi.sendJson(res, 200, { ok: true, reused: true, ...publicStatus(account, channelId) })
          }
        }

        if (account && account.appId && forceBind) {
          // 重新扫码换机器人：先把当前渠道从旧账号摘出，绑定成功后新账号只接管本渠道，
          // 旧账号仍可服务其它渠道；若扫码返回的是同一个 AppID，applyQrCredentials 会合并状态。
          const previous = account
          const tempId = `qr:${channelId}`
          let temp = data.accounts[tempId]
          if (!temp || temp === previous) {
            temp = normalizeAccount({
              accountId: tempId,
              appId: '',
              secret: '',
              accessToken: '',
              tokenExpiresAt: 0,
              transport: previous.transport === 'webhook' ? 'webhook' : 'ws',
              sandbox: previous.sandbox === true,
              channels: {},
              discovered: [],
              inbox: [],
              seen: [],
              sent: {},
              lastInbound: {},
              bot: {},
              updatedAt: Date.now(),
            })
            data.accounts[tempId] = temp
          }
          if (previous.channels?.[channelId]) {
            delete previous.channels[channelId]
            delete previous.lastInbound?.[channelId]
            previous.inbox = (previous.inbox || []).filter(item => item.channelId !== channelId)
            delete previous.channelBindings?.[channelId]
            rebuildRoutes(previous)
          }
          account = temp
          account.appId = ''
          account.secret = ''
          account.accessToken = ''
          account.tokenExpiresAt = 0
          account.linkAuthorized = false
          account.updatedAt = Date.now()
        }

        if (!account) {
          account = normalizeAccount({
            accountId,
            appId: '',
            secret: '',
            accessToken: '',
            tokenExpiresAt: 0,
            transport: ['ws', 'webhook'].includes(body.transport) ? body.transport : 'ws',
            sandbox: body.sandbox === true,
            channels: {},
            discovered: [],
            inbox: [],
            seen: [],
            sent: {},
            lastInbound: {},
            bot: {},
            updatedAt: Date.now(),
          })
          data.accounts[account.accountId] = account
        }

        const config = qrConfigFor(account, channelId, body)
        const cfg = channelConfig(account, channelId, true)
        cfg.disabled = false
        if (SESSION_TYPES.includes(String(body.sessionType || ''))) cfg.sessionType = String(body.sessionType)
        if (body.autoBind !== undefined) cfg.autoBind = body.autoBind === true
        cfg.bindHost = config.host
        rebuildRoutes(account)
        const qr = await qrCreate(account, channelId, config, body)
        qr.channelId = channelId
        ensureQrPoll(account)
        schedulePersist()
        return httpApi.sendJson(res, 200, { ok: true, ...publicStatus(account, channelId) })
      }),
    ),
  )
  const statusHandler = wrap(async (req, res, params, url) => {
    const channelId = String(url?.searchParams?.get('channelId') || '').trim()
    const account = findAccountForChannel(channelId)
    return httpApi.sendJson(res, 200, { ok: true, ...publicStatus(account, channelId) })
  })
  routes.push(httpApi.route('GET', '/api/qqbot/login/status', statusHandler))
  routes.push(httpApi.route('GET', '/api/qqbot/status', statusHandler))

  // 供前端在「添加/接入渠道」时列出现有机器人账号；不返回 secret / access_token。
  routes.push(
    httpApi.route(
      'GET',
      '/api/qqbot/accounts',
      wrap(async (req, res) => {
        const accounts = Object.values(data.accounts)
          .filter(account => account?.appId)
          .map(account => ({
            accountId: account.accountId,
            appId: account.appId,
            bot: account.bot || null,
            status: statusOf(account),
            transport: account.transport || 'ws',
            channels: Object.keys(account.channels || {}).map(channelId => ({
              channelId,
              disabled: account.channels?.[channelId]?.disabled === true,
            })),
          }))
        return httpApi.sendJson(res, 200, { ok: true, accounts })
      }),
    ),
  )

  routes.push(
    httpApi.route(
      'POST',
      '/api/qqbot/bind',
      wrap(async (req, res) => {
        const body = await httpApi.readBody(req)
        const channelId = String(body.channelId || '').trim()
        if (!channelId) return httpApi.sendJson(res, 400, { ok: false, error: '缺少 channelId' })
        let account = resolveAccountForPayload(body)
        if (!account) {
          // 前端在启动/编辑时需要先把仅存在于渠道 meta 的绑定登记到桥里
          const appId = String(body.appId || '').trim()
          if (!appId) return httpApi.sendJson(res, 200, { ok: false, code: 'NO_ACCOUNT', error: '该渠道还没有登录信息，请先接入 QQ 机器人' })
          account = findAccountById(`app:${appId}`)
          if (!account) return httpApi.sendJson(res, 200, { ok: false, code: 'NO_ACCOUNT', error: '后端没有该 AppID 的登录信息' })
        }
        const intentsBefore = accountIntents(account)
        const transportBefore = account.transport
        const cfg = channelConfig(account, channelId, true)
        cfg.disabled = false
        // 渠道里选择的连接方式要同步到账号：否则从 Webhook 切回 WebSocket 不会真正生效。
        if (['ws', 'webhook'].includes(String(body.transport || ''))) account.transport = String(body.transport)
        if (body.autoBind !== undefined) cfg.autoBind = body.autoBind === true
        if (SESSION_TYPES.includes(String(body.sessionType || ''))) cfg.sessionType = String(body.sessionType)
        if (Number.isFinite(Number(body.intents))) cfg.intents = Number(body.intents)
        if (body.channelName !== undefined) cfg.channelName = String(body.channelName || '').trim().slice(0, 80)
        if (body.linkGroupId !== undefined) cfg.linkGroupId = String(body.linkGroupId || '').trim()
        if (body.linkAutoReply !== undefined) cfg.linkAutoReply = body.linkAutoReply !== false
        if (body.linkMaxTurns !== undefined) {
          const maxTurns = Number(body.linkMaxTurns)
          cfg.linkMaxTurns = Number.isFinite(maxTurns) && maxTurns >= 0 ? Math.min(5, Math.floor(maxTurns)) : 1
        }
        if (Array.isArray(body.trustedUserIds)) {
          cfg.trustedUserIds = body.trustedUserIds.map(item => String(item || '').trim()).filter(Boolean)
        }
        if (Array.isArray(body.bindings)) {
          cfg.bindings = []
          const claimed = new Set()
          for (const binding of body.bindings) {
            if (!SESSION_TYPES.includes(binding?.sessionType) || !String(binding?.peerId || '').trim()) continue
            const key = `${binding.sessionType}:${String(binding.peerId)}`
            cfg.bindings.push({
              sessionType: binding.sessionType,
              peerId: String(binding.peerId),
              alias: String(binding.alias || ''),
              identityMode: binding.identityMode || (binding.sessionType === 'c2c' ? 'owner' : 'member'),
              auto: binding.auto === true,
              boundAt: Number(binding.boundAt) || Date.now(),
            })
            claimed.add(key)
          }
          // 一个会话只允许属于一个渠道：前端保存哪个渠道，就从其它渠道移除同样的绑定，
          // 避免 route 被旧的重复绑定抢走或产生 conflicts。
          if (claimed.size) {
            for (const [otherId, otherCfg] of Object.entries(account.channels || {})) {
              if (otherId === channelId || !otherCfg) continue
              const before = Array.isArray(otherCfg.bindings) ? otherCfg.bindings.length : 0
              otherCfg.bindings = (Array.isArray(otherCfg.bindings) ? otherCfg.bindings : []).filter(
                item => !claimed.has(`${item.sessionType}:${String(item.peerId)}`),
              )
              if (otherCfg.bindings.length !== before) otherCfg.updatedAt = Date.now()
            }
          }
          cfg.updatedAt = Date.now()
        }
        if (body.add) {
          addBinding(account, channelId, body.add.sessionType, body.add.peerId, body.add)
        }
        if (body.remove) {
          removeBinding(account, channelId, body.remove.sessionType, body.remove.peerId)
        }
        rebuildRoutes(account)
        // 新增频道渠道会改变 intents；连接方式变化会改变网关形态。
        // 已连接时重启一次，确保新权限 / 新连接方式立即生效。
        const intentsAfter = accountIntents(account)
        const transportChanged = transportBefore !== account.transport
        const intentsChanged = intentsBefore !== intentsAfter
        if (transportChanged || (intentsChanged && account.transport !== 'webhook')) {
          stopAccount(account)
          startAccount(account)
        } else if (account.appId && (account.secret || account.accessToken)) {
          // 编辑渠道（例如从断开状态恢复）后确保连接重新建立。
          startAccount(account)
        }
        account.updatedAt = Date.now()
        schedulePersist()
        return httpApi.sendJson(res, 200, { ok: true, ...publicStatus(account, channelId) })
      }),
    ),
  )

    routes.push(
      httpApi.route(
        'POST',
        '/api/qqbot/channels/reconcile',
        wrap(async (req, res) => {
          const body = await httpApi.readBody(req)
          const keep = new Set(
            (Array.isArray(body.channelIds) ? body.channelIds : [])
              .map(value => String(value || '').trim())
              .filter(Boolean),
          )
          let removed = 0
          for (const account of Object.values(data.accounts || {})) {
            let accountChanged = false
            for (const channelId of Object.keys(account.channels || {})) {
              if (keep.has(channelId)) continue
              delete account.channels[channelId]
              if (account.lastInbound) delete account.lastInbound[channelId]
              account.inbox = (account.inbox || []).filter(item => item.channelId !== channelId)
              account.discovered = (account.discovered || []).map(item =>
                item.channelId === channelId ? { ...item, channelId: '' } : item,
              )
              if (account.channelBindings) delete account.channelBindings[channelId]
              removed += 1
              accountChanged = true
            }
            if (!accountChanged) continue
            rebuildRoutes(account)
            account.updatedAt = Date.now()
            schedulePersist()
            const hasActive = Object.values(account.channels || {}).some(cfg => cfg && cfg.disabled !== true)
            if (!hasActive) stopAccount(account)
          }
          return httpApi.sendJson(res, 200, { ok: true, removed })
        }),
      ),
    )


  routes.push(
    httpApi.route(
      'POST',
      '/api/qqbot/logout',
      wrap(async (req, res) => {
        const body = await httpApi.readBody(req)
        const channelId = String(body.channelId || '').trim()
        const account = findAccountForChannel(channelId)
        if (!account) return httpApi.sendJson(res, 200, { ok: true, status: 'idle' })

        const totalChannels = Object.keys(account.channels || {}).length
        const dispose = body.disposeAccount === true

        if (dispose && totalChannels > 1) {
          return httpApi.sendJson(res, 200, {
            ok: false,
            code: 'ACCOUNT_IN_USE',
            error: '该机器人还被其它渠道使用，无法清除本机凭据；请先删除其它同机器人渠道，或只断开当前渠道。',
          })
        }

        if (dispose) {
          delete account.channels[channelId]
          delete account.lastInbound?.[channelId]
          account.inbox = (account.inbox || []).filter(item => item.channelId !== channelId)
          account.discovered = (account.discovered || []).map(item => (item.channelId === channelId ? { ...item, channelId: '' } : item))
          if (String(account.qr?.channelId || '') === channelId) account.qr = null
          const rt = runtimeFor(account.accountId)
          if (rt.qr && String(rt.qr.channelId || '') === channelId) {
            rt.qrEpoch = null
            rt.qrPolling = null
            rt.qr = null
          }
          stopAccount(account, { clearCredentials: true })
          delete data.accounts[account.accountId]
          await persist().catch(() => {})
          return httpApi.sendJson(res, 200, { ok: true, disposed: true, status: 'idle' })
        }

        // 渠道从列表中被删除：移除该渠道配置，但保留本机凭据，之后可以在新渠道
        // 的接入弹窗里直接复用这个机器人，不必重新扫码。
        if (body.removeChannel === true) {
          delete account.channels[channelId]
          delete account.lastInbound?.[channelId]
          delete account.channelBindings?.[channelId]
          account.inbox = (account.inbox || []).filter(item => item.channelId !== channelId)
          account.discovered = (account.discovered || []).map(item => (item.channelId === channelId ? { ...item, channelId: '' } : item))
          if (String(account.qr?.channelId || '') === channelId) {
            const rt = runtimeFor(account.accountId)
            if (rt.qr && String(rt.qr.channelId || '') === channelId) {
              rt.qrEpoch = null
              rt.qrPolling = null
              rt.qr = null
            }
            account.qr = null
          }
          rebuildRoutes(account)
          if (!Object.keys(account.channels || {}).length) stopAccount(account)
          account.updatedAt = Date.now()
          schedulePersist()
          await persist().catch(() => {})
          return httpApi.sendJson(res, 200, { ok: true, disposed: false, removed: true, retained: true, status: 'idle' })
        }

        // 默认语义：只断开当前渠道，不删除本机 AppID / AppSecret。
        // 之后在渠道详情点「接入」时可以直接重连，不需要再次扫码，也不会再触发
        // 手机 QQ 的“机器人已绑定”提示。
        const cfg = channelConfig(account, channelId, false)
        if (cfg) cfg.disabled = true
        if (String(account.qr?.channelId || '') === channelId) {
          const rt = runtimeFor(account.accountId)
          if (rt.qr && String(rt.qr.channelId || '') === channelId) {
            rt.qrEpoch = null
            rt.qrPolling = null
            rt.qr = null
          }
          account.qr = null
        }
        rebuildRoutes(account)
        const activeChannels = Object.entries(account.channels || {}).filter(([, item]) => item?.disabled !== true)
        if (!activeChannels.length) stopAccount(account)
        account.updatedAt = Date.now()
        schedulePersist()
        await persist().catch(() => {})
        return httpApi.sendJson(res, 200, { ok: true, disposed: false, status: publicStatus(account, channelId).status })
      }),
    ),
  )
  routes.push(
    httpApi.route(
      'GET',
      '/api/qqbot/inbox',
      wrap(async (req, res, params, url) => {
        const channelId = String(url?.searchParams?.get('channelId') || '').trim()
        const account = findAccountForChannel(channelId)
        const messages = account?.inbox?.filter(item => item.channelId === channelId) || []
        return httpApi.sendJson(res, 200, { ok: true, messages })
      }),
    ),
  )

  routes.push(
    httpApi.route(
      'POST',
      '/api/qqbot/inbox/ack',
      wrap(async (req, res) => {
        const body = await httpApi.readBody(req)
        const channelId = String(body.channelId || '').trim()
        const ids = Array.isArray(body.ids) ? body.ids.map(String) : []
        const account = findAccountForChannel(channelId)
        if (account && ids.length) {
          const remove = new Set(ids)
          account.inbox = (account.inbox || []).filter(item => !(item.channelId === channelId && remove.has(String(item.id))))
          schedulePersist()
        }
        return httpApi.sendJson(res, 200, { ok: true })
      }),
    ),
  )

  routes.push(
    httpApi.route(
      'GET',
      '/api/qqbot/discover',
      wrap(async (req, res, params, url) => {
        const channelId = String(url?.searchParams?.get('channelId') || '').trim()
        const account = findAccountForChannel(channelId)
        if (!account) return httpApi.sendJson(res, 200, { ok: true, discovered: [] })
        const cfg = channelConfig(account, channelId, false)
        const preferred = String(cfg?.sessionType || '')
        const discovered = account.discovered
          .filter(item => {
            if (item.channelId && item.channelId !== channelId) return false
            if (preferred && item.sessionType !== preferred && !item.unsupported) return false
            return item.sessionType === 'c2c' || item.sessionType === 'group' || !!item.unsupported
          })
          .slice(-MAX_DISCOVER)
          .reverse()
        return httpApi.sendJson(res, 200, { ok: true, discovered })
      }),
    ),
  )

  routes.push(
    httpApi.route(
      'POST',
      '/api/qqbot/send',
      wrap(async (req, res) => {
        const body = await httpApi.readBody(req)
        const channelId = String(body.channelId || '').trim()
        if (!channelId) return httpApi.sendJson(res, 400, { ok: false, error: '缺少 channelId' })
        const account = findAccountForChannel(channelId)
        if (!account) return httpApi.sendJson(res, 200, { ok: false, code: 'NO_ACCOUNT', error: '该渠道还没有登录 QQ 官方机器人' })
        const result = await sendMessage(account, body)
        return httpApi.sendJson(res, 200, result)
      }),
    ),
  )

  /* ---------------- Webhook 回调（op=13 校验 / op=0 事件 / op=12 ACK） ---------------- */

  routes.push(
    httpApi.route(
      'POST',
      '/api/qqbot/webhook',
      wrap(async (req, res) => {
        const raw = await readRawBody(req)
        let payload = null
        try {
          payload = raw ? JSON.parse(raw) : {}
        } catch (_) {
          return httpApi.sendJson(res, 400, { message: '请求体不是合法 JSON' })
        }
        const appId = String(req.headers['x-bot-appid'] || payload?.d?.appid || '').trim()
        const account = appId ? findAccountByAppId(appId) : null
        const op = Number(payload?.op)

        if (op === 13) {
          if (!account) return httpApi.sendJson(res, 404, { message: `未知的机器人 AppID：${appId || '(空)'}` })
          const secret = decrypt(account.secret || '')
          if (!secret) return httpApi.sendJson(res, 503, { message: '该账号没有 AppSecret，无法完成回调签名校验' })
          const plainToken = String(payload?.d?.plain_token || '')
          const eventTs = String(payload?.d?.event_ts || '')
          return httpApi.sendJson(res, 200, { plain_token: plainToken, signature: signWebhook(secret, plainToken, eventTs) })
        }

        if (account && account.transport !== 'webhook') {
          // 允许 Webhook 与 WebSocket 同时配置：把回调事件也路由走，但不去重会重复；
          // 因此默认以账号 transport 为准，只有显式 transport=webhook 才处理 op=0。
          return httpApi.sendJson(res, 200, { op: 12, d: {} })
        }

        const signature = String(req.headers['x-signature-ed25519'] || '')
        const timestamp = String(req.headers['x-signature-timestamp'] || '')
        if (account && signature && timestamp) {
          const secret = decrypt(account.secret || '')
          if (secret && !verifyWebhook(secret, timestamp, raw, signature)) {
            return httpApi.sendJson(res, 401, { message: 'Ed25519 签名校验失败' })
          }
        }

        if (op === 0 && payload?.t) {
          try {
            await handleGatewayEvent(account, String(payload.t), payload.d || {}, payload)
          } catch (err) {
            ctx.logger.warn(`[qqbot] Webhook 事件处理失败：${err?.message || err}`)
          }
        }
        return httpApi.sendJson(res, 200, { op: 12, d: {} })
      }),
    ),
  )

  /* ---------------- 启动 / 清理 ---------------- */

  const boot = async () => {
    try {
      await loadState()
      for (const account of Object.values(data.accounts)) {
        normalizeAccount(account)
        rebuildRoutes(account)
        const hasActiveChannels = Object.values(account.channels || {}).some(cfg => cfg && cfg.disabled !== true)
        if (account.appId && (account.secret || account.accessToken)) {
          // 没有启用中的渠道时不建立连接；用户再次点「接入」会恢复。
          if (hasActiveChannels) startAccount(account)
        } else {
          // 重启时扫码尚未完成：账号 qr 已落盘，恢复任务并继续轮询。
          restorePendingQr(account)
        }
      }
      ctx.logger.info(`[qqbot] QQ 官方机器人后端桥就绪（${Object.keys(data.accounts).length} 个账号）`)
    } finally {
      markReady()
    }
  }

  ctx.effect(() => () => {
    closed = true
    if (persistTimer) clearTimeout(persistTimer)
    for (const rt of runtime.values()) {
      rt.stopping = true
      rt.qrEpoch = null
      rt.qrPolling = null
      try {
        rt.ws?.close?.()
      } catch (_) {
        /* ignore */
      }
    }
    persist({ force: true }).catch(() => {})
    for (const dispose of routes) {
      try {
        dispose?.()
      } catch (_) {
        /* ignore */
      }
    }
  })

  // 给其它后端插件（如点歌台 media-post）使用的稳定接口：
  // 查询渠道信息 / 直接发送文本、图片、语音。
  ctx.provide('qqbot', {
    name: 'qqbot',
    version,
    ready: () => ready,
    supportsVoice: () => true,
    voiceFormat: () => 'silk',
    channelInfo: channelId => {
      const raw = String(channelId || '').replace(/^qqbot:/, '')
      if (!raw) return null
      const account = findAccountForChannel(raw)
      const cfg = account ? channelConfig(account, raw, false) : null
      if (!account || !cfg) return null
      const binding = (cfg.bindings || [])[0] || null
      return {
        channelId: raw,
        accountId: account.accountId,
        sessionType: cfg.sessionType || binding?.sessionType || '',
        peerId: binding?.peerId || '',
        bindings: (cfg.bindings || []).map(item => ({ ...item })),
        disabled: cfg.disabled === true,
        transport: account.transport || 'ws',
        bot: account.bot || null,
      }
    },
    send: body =>
      ready.then(() => {
        const rawChannelId = String(body?.channelId || '').replace(/^qqbot:/, '')
        const account = resolveAccountForPayload({ ...body, channelId: rawChannelId }) || findAccountForChannel(rawChannelId)
        if (!account) return { ok: false, code: 'NO_ACCOUNT', error: '该渠道还没有绑定 QQ 官方机器人账号' }
        return sendMessage(account, { ...body, channelId: rawChannelId })
      }),
  })

  boot().catch(err => ctx.logger.error(`[qqbot] 初始化失败：${err?.message || err}`))
}
