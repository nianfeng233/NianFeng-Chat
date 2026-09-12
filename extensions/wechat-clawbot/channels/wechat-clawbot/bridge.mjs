/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目：念风 Chat（NianFeng-Chat）
 *
 * 微信 Clawbot 后端桥（参考 Tencent/openclaw-weixin 的 HTTP JSON API）。
 *
 * 职责：
 *   - 二维码登录：get_bot_qrcode / get_qrcode_status
 *   - 消息长轮询：getupdates（收到的消息通过 hub 的 clawbot:message 事件推给前端）
 *   - 发送消息与 typing：sendmessage / getconfig / sendtyping
 *
 * 该文件只被 Node 后端加载（server/index.mjs），浏览器端插件是
 * plugins/channels/wechat-clawbot/index.mjs。账号 token 使用与 .secret-key
 * 相同的 AES-256-GCM 密钥加密后写入 <数据目录>/clawbot.json。
 */
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createCipheriv, createDecipheriv, randomBytes, randomInt } from 'node:crypto'

export const name = 'wechat-clawbot-bridge'
export const version = '1.0.0'
export const displayName = '微信 Clawbot 后端桥'
export const description = '渠道后端 · Clawbot 登录、长轮询、发送消息与 typing 状态。'
export const core = false
export const inject = ['settings', 'hub', 'httpApi']
export const provides = [{ name: 'clawbot', type: 'singleton' }]

const DEFAULT_BASE_URL =
  process.env.NIANFENG_CLAWBOT_BASE_URL ||
  process.env.NIANFENG_CLAWBOT_BASE_URL ||
  'https://ilinkai.weixin.qq.com'
const DEFAULT_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c'
const ENC_PREFIX = 'enc:v1:'
const STATE_FILE = 'clawbot.json'
const BASE_INFO = { channel_version: '1.0.0', bot_agent: 'NianFeng-Chat/1.0.0 WeChatClawbot/1.0.0' }

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const trimSlash = value => String(value || '').replace(/\/+$/, '')

function randomUin() {
  return Buffer.from(String(randomInt(1, 2 ** 32 - 1))).toString('base64')
}

function jsonHeaders() {
  return {
    'Content-Type': 'application/json',
    'iLink-App-Id': '',
    'iLink-App-ClientVersion': '65536',
  }
}

function authHeaders(token) {
  return {
    ...jsonHeaders(),
    AuthorizationType: 'ilink_bot_token',
    Authorization: `Bearer ${String(token || '').trim()}`,
    'X-WECHAT-UIN': randomUin(),
  }
}

function apiErrorText(response) {
  if (!response || typeof response !== 'object') return String(response || '未知错误')
  if (response._error) return String(response._error).slice(0, 300)
  const httpStatus = Number(response._httpStatus)
  const code = response.errcode ?? response.ret
  const parts = []
  if (Number.isFinite(httpStatus) && httpStatus > 0) parts.push(`HTTP ${httpStatus}`)
  if (code !== undefined && code !== 0) parts.push(`code=${code}`)
  const message = response.errmsg || response.message || response.error || response.raw || ''
  if (message) parts.push(String(message).slice(0, 300))
  return parts.join(' ') || '接口返回了空数据（可能是网络超时或服务端未响应）'
}

function isSessionExpired(response) {
  if (!response || typeof response !== 'object') return false
  for (const field of ['ret', 'errcode']) {
    const value = Number(response[field])
    if (Number.isFinite(value) && value === -14) return true
  }
  const text = apiErrorText(response).toLowerCase()
  return /401|403|invalid token|token expired|session expired|登录.*(失效|过期)/i.test(text)
}

function isApiError(response) {
  if (!response || typeof response !== 'object') return true
  if (response._error) return true
  if (response._httpStatus && response._httpStatus >= 400) return true
  const ret = Number(response.ret)
  const errcode = Number(response.errcode)
  if (Number.isFinite(ret) && ret !== 0) return true
  if (Number.isFinite(errcode) && errcode !== 0) return true
  return false
}

function extractMessages(response) {
  if (!response || typeof response !== 'object') return []
  const candidates = [response.msgs, response.messages, response.updates, response.data?.msgs, response.data?.messages]
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate
  }
  if (response.msg && typeof response.msg === 'object') return [response.msg]
  return []
}

function isOwnMessage(raw) {
  const msg = raw?.msg || raw || {}
  const from = String(msg.from_user_id || msg.fromUserId || raw?.from_user_id || '')
  if (!from) return true
  const messageType = Number(msg.message_type ?? raw?.message_type)
  if (Number.isFinite(messageType) && messageType === 2) return true
  return false
}

function normalizeIncoming(raw) {
  const msg = raw?.msg || raw || {}
  const items = Array.isArray(msg.item_list) ? msg.item_list : Array.isArray(raw?.item_list) ? raw.item_list : []
  const texts = []
  let hasMedia = false
  for (const item of items) {
    const type = Number(item?.type)
    if (type === 1 && item?.text_item?.text) texts.push(String(item.text_item.text))
    else if ([2, 3, 4, 5].includes(type)) hasMedia = true
  }
  let text = texts.join('').trim()
  if (!text && hasMedia) text = '[微信侧媒体消息]'
  const fromUserId = String(msg.from_user_id || msg.fromUserId || raw?.from_user_id || raw?.sender || '')
  if (!fromUserId || !text) return null
  const contextToken = String(msg.context_token || raw?.context_token || '')
  const messageId = msg.message_id ?? msg.msg_id ?? msg.seq ?? msg.seq_id ?? null
  const id = messageId !== null && messageId !== undefined && String(messageId).trim()
    ? `wx-${messageId}`
    : `wx-${fromUserId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const timestamp = Number(msg.create_time_ms || raw?.create_time_ms || 0) || Date.now()
  return {
    id,
    fromUserId,
    contextToken,
    text,
    timestamp,
    kind: hasMedia && !texts.length ? 'media' : 'text',
    raw: {
      message_id: messageId,
      from_user_id: fromUserId,
      context_token: contextToken,
      message_type: Number(msg.message_type || 1),
      create_time_ms: timestamp,
    },
  }
}

export function apply(ctx) {
  // 后端是真实 cordis：inject 声明会先把服务放到 ctx 上，这里直接读取。
  const settings = ctx.settings
  const hub = ctx.hub
  const sessions = new Map()
  let state = { version: 1, accounts: {} }
  let secretKey = null
  let persistTimer = null
  let closed = false

  const statePath = () => join(settings.dataDir || process.cwd(), STATE_FILE)
  const keyPath = () => join(settings.dataDir || process.cwd(), '.secret-key')

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
    const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    return `${ENC_PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${data.toString('base64')}`
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
      ctx.logger.warn('Clawbot 账号凭据解密失败，请重新扫码登录')
      return ''
    }
  }

  const persist = async ({ force = false } = {}) => {
    if (closed && !force) return
    try {
      await mkdir(settings.dataDir, { recursive: true })
      const tmp = `${statePath()}.${process.pid}.tmp`
      await writeFile(tmp, JSON.stringify(state, null, 2), 'utf8')
      await rename(tmp, statePath())
      try {
        await chmod(statePath(), 0o600)
      } catch (_) {
        /* Windows 忽略 */
      }
    } catch (err) {
      ctx.logger.warn(`Clawbot 状态写入失败：${err.message}`)
    }
  }

  const schedulePersist = () => {
    if (persistTimer) return
    persistTimer = setTimeout(() => {
      persistTimer = null
      persist().catch(() => {})
    }, 500)
  }

  const getSession = channelId => {
    const key = String(channelId || '').trim()
    if (!key) return null
    let session = sessions.get(key)
    if (session) return session
    const saved = state.accounts[key] || {}
    session = {
      channelId: key,
      account: saved.account
        ? {
            ...saved.account,
            token: decrypt(saved.account.token || ''),
          }
        : null,
      buf: String(saved.updatesBuf || ''),
      inbox: Array.isArray(saved.inbox) ? saved.inbox : [],
      seen: Array.isArray(saved.seen) ? saved.seen : [],
      contextTokens: saved.contextTokens && typeof saved.contextTokens === 'object' ? { ...saved.contextTokens } : {},
      typingTickets: new Map(),
      qr: null,
      qrPolling: null,
      status: saved.account?.token ? 'offline' : 'idle',
      error: '',
      loop: null,
      loopEpoch: null,
      // 每次获取二维码 / 重新接入都会递增，旧的长轮询看到 epoch 不一致就退出，
      // 保证新连接不会和上一次扫码、上一条消息链路串线。
      epoch: 0,
      qrEpoch: null,
      loginId: '',
      startedNotified: false,
      closed: false,
    }
    sessions.set(key, session)
    return session
  }

  const toStateAccount = session => ({
    account: session.account
      ? {
          accountId: session.account.accountId || '',
          userId: session.account.userId || '',
          nickname: session.account.nickname || '',
          baseUrl: session.account.baseUrl || DEFAULT_BASE_URL,
          cdnBaseUrl: session.account.cdnBaseUrl || DEFAULT_CDN_BASE_URL,
          token: encrypt(session.account.token || ''),
        }
      : null,
    updatesBuf: session.buf || '',
    inbox: (session.inbox || []).slice(-100),
    seen: (session.seen || []).slice(-500),
    contextTokens: Object.fromEntries(Object.entries(session.contextTokens || {}).slice(-100)),
    updatedAt: new Date().toISOString(),
  })

  const saveSession = session => {
    state.accounts[session.channelId] = toStateAccount(session)
    schedulePersist()
  }

  const publicStatus = session => ({
    channelId: session.channelId,
    status: session.status,
    loggedIn: !!session.account?.token,
    loginId: session.loginId || '',
    accountId: session.account?.accountId || '',
    userId: session.account?.userId || '',
    nickname: session.account?.nickname || '',
    error: session.error || '',
    pending: (session.inbox || []).length,
    qr: session.qr
      ? {
          id: session.qr.id || '',
          content: session.qr.content || '',
          imageUrl: session.qr.imageUrl || '',
          status: session.qr.status || 'wait_scan',
          error: session.qr.error || '',
          startedAt: session.qr.startedAt || 0,
          expiresAt: session.qr.expiresAt || 0,
        }
      : null,
  })

  const broadcastStatus = (session, status, extra = {}) => {
    if (!session) return
    session.status = status
    if (extra.error !== undefined) session.error = String(extra.error || '')
    hub.broadcast('clawbot:status', { ...publicStatus(session), ...extra, status })
  }

  async function requestApi(session, path, { method = 'POST', body, token = '', baseUrl = '', timeoutMs = 20000 } = {}) {
    const base = trimSlash(baseUrl || session?.account?.baseUrl || DEFAULT_BASE_URL)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('请求超时')), Math.max(1000, Number(timeoutMs) || 20000))
    try {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: token ? authHeaders(token) : jsonHeaders(),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      })
      const text = await response.text()
      let data = {}
      try {
        data = text ? JSON.parse(text) : {}
      } catch (_) {
        data = { raw: text.slice(0, 500) }
      }
      if (!response.ok) data._httpStatus = response.status
      return data
    } catch (err) {
      return { _error: err?.name === 'AbortError' ? '请求超时' : err?.message || String(err) }
    } finally {
      clearTimeout(timer)
    }
  }

  async function notifyStart(session, epoch) {
    if (!session?.account?.token) return false
    if (session.startedNotified) return true
    const token = session.account.token
    const response = await requestApi(session, '/ilink/bot/msg/notifystart', {
      method: 'POST',
      token,
      body: { base_info: BASE_INFO },
      timeoutMs: 12000,
    })
    if (epoch !== undefined && session.epoch !== epoch) return false
    // notifystart 成功只认业务成功，不把 HTTP 200 里带错误码的响应当成已接入。
    const ok = !isApiError(response)
    if (ok) session.startedNotified = true
    return ok
  }

  function markSeen(session, id) {
    if (!id || session.seen.includes(id)) return false
    session.seen.push(id)
    if (session.seen.length > 500) session.seen.splice(0, session.seen.length - 500)
    return true
  }

  function enqueueIncoming(session, message) {
    if (!message || !markSeen(session, message.id)) return false
    session.inbox.push(message)
    if (session.inbox.length > 100) session.inbox.splice(0, session.inbox.length - 100)
    saveSession(session)
    hub.broadcast('clawbot:message', { channelId: session.channelId, message })
    return true
  }

  async function pollLoop(session, epoch) {
    if (session.epoch !== epoch) return
    if (!session.account?.token) {
      broadcastStatus(session, 'offline')
      return
    }
    // 有 token 只代表登录凭据存在，先标记“连接中”；notifystart 或首次 getupdates
    // 成功后才标记“已接入”，这样刷新状态显示的是真实链路结果而不是乐观值。
    broadcastStatus(session, 'connecting')
    const notifyOk = await notifyStart(session, epoch)
    if (session.epoch !== epoch || closed || session.closed) return
    if (notifyOk) broadcastStatus(session, 'online')
    while (!closed && !session.closed && session.epoch === epoch && session.account?.token) {
      const token = session.account.token
      try {
        const response = await requestApi(session, '/ilink/bot/getupdates', {
          method: 'POST',
          token,
          body: { get_updates_buf: session.buf || '', base_info: BASE_INFO },
          timeoutMs: 40000,
        })
        if (closed || session.closed || session.epoch !== epoch) return
        if (isSessionExpired(response)) {
          ctx.logger.warn(`[clawbot] ${session.channelId} 登录已过期，需要重新接入`)
          session.account = null
          session.buf = ''
          session.qr = null
          session.startedNotified = false
          session.epoch += 1
          saveSession(session)
          broadcastStatus(session, 'expired', { error: '微信登录已过期，请重新扫码接入' })
          return
        }
        if (isApiError(response)) {
          broadcastStatus(session, 'error', { error: apiErrorText(response) })
          await sleep(3000)
          continue
        }
        const nextBuf = response.get_updates_buf || response.next_get_updates_buf || response.update_buf
        if (typeof nextBuf === 'string' && nextBuf !== session.buf) {
          session.buf = nextBuf
          saveSession(session)
        }
        for (const raw of extractMessages(response)) {
          if (isOwnMessage(raw)) continue
          const message = normalizeIncoming(raw)
          if (!message) continue
          if (message.contextToken) {
            session.contextTokens[message.fromUserId] = message.contextToken
            saveSession(session)
          }
          enqueueIncoming(session, message)
        }
        if (session.status !== 'online') broadcastStatus(session, 'online')
      } catch (err) {
        if (closed || session.closed || session.epoch !== epoch) return
        broadcastStatus(session, 'error', { error: err?.message || String(err) })
        await sleep(3000)
      }
    }
  }

  function ensureLoop(session) {
    if (!session?.account?.token || closed || session.closed) return
    const epoch = session.epoch
    if (session.loop && session.loopEpoch === epoch) return
    const promise = pollLoop(session, epoch)
      .catch(err => ctx.logger.warn(`[clawbot] 轮询异常：${err?.message || err}`))
      .finally(() => {
        if (session.loop === promise) {
          session.loop = null
          session.loopEpoch = null
        }
      })
    session.loop = promise
    session.loopEpoch = epoch
  }

  /**
   * 扫码状态轮询。
   * 微信 get_qrcode_status 是长轮询接口（无变化时约 30s 才返回 wait）；
   * 因此不能在每次前端轮询时同步调用，否则前端会等超时。
   * 这里在后台维护一条长轮询，前端 /login/status 只读取后台最新状态。
   */
  function ensureQrPoll(session) {
    if (!session?.qr?.ticket || session.qr.done || closed || session.closed) return
    const epoch = session.qrEpoch
    if (session.qrPolling && session.qrPollingEpoch === epoch) return
    const promise = qrPollLoop(session, epoch)
      .catch(err => ctx.logger.warn(`[clawbot] 二维码轮询异常：${err?.message || err}`))
      .finally(() => {
        if (session.qrPolling === promise) {
          session.qrPolling = null
          session.qrPollingEpoch = null
        }
      })
    session.qrPolling = promise
    session.qrPollingEpoch = epoch
  }

  function handleQrConfirmed(session, response, epoch) {
    if (session.qrEpoch !== epoch) return false
    const token = String(response.bot_token || response.token || response.access_token || response.ilink_bot_token || '')
    const accountId = String(response.ilink_bot_id || response.bot_id || response.account_id || '')
    if (!token) {
      session.qr.status = 'error'
      session.qr.error = '扫码已确认，但微信未返回登录 token'
      broadcastStatus(session, 'error', { error: session.qr.error })
      return false
    }
    // 新的扫码确认结果属于一次全新连接：先让上一条消息长轮询退出，再切换到新 token。
    session.epoch += 1
    session.account = {
      token,
      accountId,
      userId: String(response.ilink_user_id || response.user_id || response.wxid || ''),
      nickname: String(response.nickname || response.ilink_nickname || response.wx_nickname || accountId.slice(0, 8) || '微信用户'),
      baseUrl: String(response.base_url || response.api_base_url || DEFAULT_BASE_URL),
      cdnBaseUrl: String(response.cdn_base_url || response.cdnBaseUrl || DEFAULT_CDN_BASE_URL),
    }
    session.buf = ''
    session.inbox = []
    session.seen = []
    session.contextTokens = {}
    session.typingTickets?.clear?.()
    session.startedNotified = false
    session.qr = null
    session.error = ''
    // 让当前二维码长轮询立即失效，避免旧 ticket 再次确认。
    session.qrEpoch += 1
    saveSession(session)
    // 新 token 是重新连接的关键凭据，立即强制落盘，降低关闭 exe 时丢登录态的概率。
    persist({ force: true }).catch(() => {})
    ensureLoop(session)
    // 扫码确认拿到 token 是真实登录结果，但“已接入”等 notifystart / 首次 getupdates 成功再亮；
    // ensureLoop 会先广播 connecting，成功后再广播 online。
    broadcastStatus(session, 'connecting', { message: '微信 Clawbot 已登录，正在建立消息链路', error: '' })
    return true
  }

  async function qrPollLoop(session, epoch) {
    while (!closed && !session.closed && session.qrEpoch === epoch && session.qr?.ticket && !session.qr.done) {
      if (session.qr.expiresAt && Date.now() > session.qr.expiresAt) {
        session.qr.status = 'expired'
        session.qr.done = true
        broadcastStatus(session, 'expired', { error: '二维码已过期，请重新获取' })
        return
      }
      let response
      try {
        response = await requestApi(session, `/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(session.qr.ticket)}`, {
          method: 'GET',
          timeoutMs: 45000,
        })
      } catch (_) {
        response = { _error: '请求超时' }
      }
      if (closed || session.closed || session.qrEpoch !== epoch || !session.qr?.ticket || session.qr.done) return
      if (isApiError(response)) {
        session.qr.status = 'wait_scan'
        session.qr.error = apiErrorText(response)
        broadcastStatus(session, 'connecting', { error: `查询二维码状态失败：${session.qr.error}` })
        await sleep(3000)
        continue
      }
      session.qr.error = ''
      const code = String(response.status || response.state || '').toLowerCase()
      if (code === 'confirmed') {
        if (handleQrConfirmed(session, response, epoch)) return
        await sleep(3000)
        continue
      }
      if (code === 'expired' || code === 'verify_code_blocked') {
        session.qr.status = code
        session.qr.done = true
        const expired = code === 'expired'
        broadcastStatus(session, expired ? 'expired' : 'error', {
          error: expired ? '二维码已过期，请重新获取' : '验证失败次数过多，请稍后再试',
        })
        return
      }
      if (code === 'scaned' || code === 'scaned_but_redirect' || code === 'binded_redirect') {
        session.qr.status = 'scanned'
        broadcastStatus(session, 'connecting', { error: '' })
        await sleep(300)
        continue
      }
      session.qr.status = 'wait_scan'
      broadcastStatus(session, 'connecting', { error: '' })
    }
  }

  async function getTypingTicket(session, toUserId, contextToken) {
    const cacheKey = `${toUserId}|${contextToken || ''}`
    const cached = session.typingTickets.get(cacheKey)
    if (cached && cached.expiresAt > Date.now()) return cached.ticket
    const response = await requestApi(session, '/ilink/bot/getconfig', {
      method: 'POST',
      token: session.account?.token,
      body: { ilink_user_id: toUserId, context_token: contextToken || undefined, base_info: BASE_INFO },
      timeoutMs: 12000,
    })
    if (isApiError(response) || !response.typing_ticket) return ''
    const ticket = String(response.typing_ticket)
    session.typingTickets.set(cacheKey, { ticket, expiresAt: Date.now() + 10 * 60 * 1000 })
    return ticket
  }

  const ready = (async () => {
    try {
      await settings.ready()
      secretKey = await readSecret()
      try {
        const raw = await readFile(statePath(), 'utf8')
        const parsed = JSON.parse(raw)
        if (parsed && typeof parsed === 'object' && parsed.accounts && typeof parsed.accounts === 'object') state = parsed
      } catch (_) {
        state = { version: 1, accounts: {} }
      }
      for (const channelId of Object.keys(state.accounts || {})) {
        const session = getSession(channelId)
        if (session.account?.token) {
          broadcastStatus(session, 'connecting')
          ensureLoop(session)
        } else if (session.status === 'connecting') {
          session.status = 'offline'
        }
      }
      ctx.logger.info(`微信 Clawbot 后端桥就绪（${Object.keys(state.accounts || {}).length} 个已保存渠道）`)
    } catch (err) {
      ctx.logger.warn(`微信 Clawbot 后端桥初始化失败：${err?.message || err}`)
    }
  })()

  const service = {
    name: 'clawbot',
    ready: () => ready,

    /** 二维码登录：每次调用都获取全新 ticket / 新连接，不复用旧 token。 */
    async startLogin({ channelId } = {}) {
      await ready
      const session = getSession(channelId)
      if (!session) throw Object.assign(new Error('缺少 channelId'), { status: 400 })

      // 重新接入时先作废旧消息轮询与旧二维码轮询：
      // 1) 不把已保存的 token 传给 get_bot_qrcode，避免微信把新扫码当成“复用旧连接”；
      // 2) 每次生成新的 loginId，二维码确认后直接替换为该渠道独立的新连接，多微信号可同时在线。
      session.epoch += 1
      session.loop = null
      session.loopEpoch = null
      session.qrEpoch = (session.qrEpoch || 0) + 1
      session.qrPolling = null
      session.qrPollingEpoch = null
      session.account = null
      session.buf = ''
      session.inbox = []
      session.seen = []
      session.contextTokens = {}
      session.typingTickets?.clear?.()
      session.startedNotified = false
      session.error = ''
      session.loginId = randomBytes(8).toString('hex')
      delete state.accounts[session.channelId]
      await persist({ force: true })

      session.qr = { id: session.loginId, status: 'getting_qr', startedAt: Date.now() }
      broadcastStatus(session, 'connecting')
      const response = await requestApi(session, '/ilink/bot/get_bot_qrcode?bot_type=3', {
        method: 'POST',
        token: '',
        // 每次扫码都必须是微信侧的全新连接：这里始终传空列表，不再带本机
        // 已保存 token；旧连接由用户在手机上按微信提示解除，而不是被程序默认复用。
        body: { local_token_list: [] },
        timeoutMs: 15000,
      })
      if (isApiError(response)) {
        session.qr = null
        broadcastStatus(session, 'error', { error: `获取二维码失败：${apiErrorText(response)}` })
        throw Object.assign(new Error(`获取二维码失败：${apiErrorText(response)}`), { status: 502 })
      }
      const ticket = String(response.qrcode || response.qrcode_ticket || '')
      const content = String(response.qrcode_img_content || response.qrcode_img_url || response.qrcodeUrl || response.qrcode_url || ticket || '')
      if (!ticket || !content) {
        session.qr = null
        broadcastStatus(session, 'error', { error: '微信未返回二维码内容' })
        throw Object.assign(new Error('微信未返回二维码内容'), { status: 502 })
      }
      session.qr = {
        id: session.loginId,
        ticket,
        content,
        imageUrl: /^https?:\/\//i.test(content) && /\.(png|jpe?g|gif|webp|bmp|avif)(\?|#|$)/i.test(content) ? content : '',
        status: 'wait_scan',
        error: '',
        startedAt: Date.now(),
        expiresAt: Date.now() + 5 * 60 * 1000,
      }
      // 后台长轮询 get_qrcode_status；前端每次轮询只读最新状态，不会卡在微信 30s 长轮询上。
      ensureQrPoll(session)
      broadcastStatus(session, 'connecting', { error: '' })
      return publicStatus(session)
    },

    /** 查询扫码状态；返回真实链路状态（connecting / online / error），不再统一覆盖成 logged_in。 */
    async loginStatus({ channelId } = {}) {
      await ready
      const session = getSession(channelId)
      if (!session) return { channelId, status: 'idle', loggedIn: false }
      if (session.account?.token) ensureLoop(session)
      if (session.qr?.ticket && !session.qr.done) ensureQrPoll(session)
      return publicStatus(session)
    },

    async status({ channelId, all = false } = {}) {
      await ready
      if (all) {
        return [...sessions.values()].map(publicStatus)
      }
      const session = getSession(channelId)
      if (!session) return null
      if (session.account?.token) ensureLoop(session)
      return publicStatus(session)
    },

    async logout({ channelId } = {}) {
      await ready
      const session = getSession(channelId)
      if (!session) return { ok: true }
      session.epoch += 1
      session.loop = null
      session.loopEpoch = null
      session.qrEpoch = (session.qrEpoch || 0) + 1
      session.qrPolling = null
      session.qrPollingEpoch = null
      session.account = null
      session.buf = ''
      session.inbox = []
      session.seen = []
      session.qr = null
      session.startedNotified = false
      session.loginId = ''
      delete state.accounts[session.channelId]
      await persist({ force: true })
      broadcastStatus(session, 'offline')
      return { ok: true }
    },

    async sendText({ channelId, toUserId, text, contextToken } = {}) {
      await ready
      const session = getSession(channelId)
      const content = String(text || '').trim()
      if (!session?.account?.token) throw Object.assign(new Error('微信 Clawbot 尚未登录'), { status: 409 })
      if (!toUserId || !content) throw Object.assign(new Error('缺少发送目标或内容'), { status: 400 })
      const response = await requestApi(session, '/ilink/bot/sendmessage', {
        method: 'POST',
        token: session.account.token,
        body: {
          msg: {
            from_user_id: '',
            to_user_id: String(toUserId),
            client_id: `nianfeng-wechat-clawbot-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
            message_type: 2,
            message_state: 2,
            item_list: [{ type: 1, text_item: { text: content } }],
            context_token: contextToken || undefined,
          },
          base_info: BASE_INFO,
        },
        timeoutMs: 20000,
      })
      if (isSessionExpired(response)) {
        session.account = null
        saveSession(session)
        broadcastStatus(session, 'expired', { error: '微信登录已过期，请重新扫码接入' })
        throw Object.assign(new Error('微信登录已过期，请重新扫码接入'), { status: 401 })
      }
      if (isApiError(response)) throw Object.assign(new Error(`微信发送失败：${apiErrorText(response)}`), { status: 502 })
      return { ok: true, response }
    },

    async startTyping({ channelId, toUserId, contextToken } = {}) {
      await ready
      const session = getSession(channelId)
      if (!session?.account?.token || !toUserId) return { ok: false, reason: 'not-ready' }
      const ticket = await getTypingTicket(session, toUserId, contextToken)
      if (!ticket) return { ok: false, reason: 'no-ticket' }
      const response = await requestApi(session, '/ilink/bot/sendtyping', {
        method: 'POST',
        token: session.account.token,
        body: {
          ilink_user_id: toUserId,
          typing_ticket: ticket,
          status: 1,
          context_token: contextToken || undefined,
          base_info: BASE_INFO,
        },
        timeoutMs: 12000,
      })
      return { ok: !isApiError(response), response }
    },

    async stopTyping({ channelId, toUserId, contextToken } = {}) {
      await ready
      const session = getSession(channelId)
      if (!session?.account?.token || !toUserId) return { ok: false, reason: 'not-ready' }
      const ticket = await getTypingTicket(session, toUserId, contextToken)
      if (!ticket) return { ok: false, reason: 'no-ticket' }
      const response = await requestApi(session, '/ilink/bot/sendtyping', {
        method: 'POST',
        token: session.account.token,
        body: {
          ilink_user_id: toUserId,
          typing_ticket: ticket,
          status: 2,
          context_token: contextToken || undefined,
          base_info: BASE_INFO,
        },
        timeoutMs: 12000,
      })
      return { ok: !isApiError(response), response }
    },

    async inbox({ channelId } = {}) {
      await ready
      const session = getSession(channelId)
      return session ? { channelId, messages: [...session.inbox] } : { channelId, messages: [] }
    },

    async ackInbox({ channelId, ids = [] } = {}) {
      await ready
      const session = getSession(channelId)
      if (!session) return { ok: true, removed: 0 }
      const set = new Set((Array.isArray(ids) ? ids : []).map(String))
      const before = session.inbox.length
      session.inbox = session.inbox.filter(message => !set.has(String(message.id)))
      saveSession(session)
      return { ok: true, removed: before - session.inbox.length }
    },

    /** 当前所有已保存渠道的登录状态（前端启动时同步用） */
    snapshot: async () => {
      await ready
      return [...sessions.values()].map(publicStatus)
    },

    contextTokenFor: (channelId, userId) => getSession(channelId)?.contextTokens?.[String(userId)] || '',
  }

  ctx.provide('clawbot', service)

  /**
   * 通过通用 httpApi 注册自己的 /api/clawbot/* 路由。
   * 这样 server/plugins/http.mjs 不需要包含任何 Clawbot 专用代码，
   * 后续渠道插件只要提供 bridge.mjs 并注入 httpApi 即可扩展后端接口。
   */
  const http = ctx.httpApi
  const safe = handler => async (req, res, params, url) => {
    try {
      await handler(req, res, params, url)
    } catch (err) {
      if (!res.headersSent) http.sendError(res, Number(err?.status) || 502, err?.message || String(err))
      else res.end()
    }
  }
  const routeDisposers = [
    http.route(
      'GET',
      '/api/clawbot/status',
      safe(async (req, res, params, url) => {
        const payload = url.searchParams.get('all') === 'true'
          ? await service.status({ all: true })
          : await service.status({ channelId: url.searchParams.get('channelId') || '' })
        http.sendJson(res, 200, payload)
      }),
    ),
    http.route(
      'POST',
      '/api/clawbot/login/start',
      safe(async (req, res) => {
        const body = await http.readBody(req)
        http.sendJson(res, 200, await service.startLogin({ channelId: body.channelId }))
      }),
    ),
    http.route(
      'GET',
      '/api/clawbot/login/status',
      safe(async (req, res, params, url) => {
        http.sendJson(res, 200, await service.loginStatus({ channelId: url.searchParams.get('channelId') || '' }))
      }),
    ),
    http.route(
      'POST',
      '/api/clawbot/logout',
      safe(async (req, res) => {
        const body = await http.readBody(req)
        http.sendJson(res, 200, await service.logout({ channelId: body.channelId }))
      }),
    ),
    http.route(
      'POST',
      '/api/clawbot/send',
      safe(async (req, res) => {
        const body = await http.readBody(req)
        http.sendJson(res, 200, await service.sendText({
          channelId: body.channelId,
          toUserId: body.toUserId,
          text: body.text,
          contextToken: body.contextToken,
        }))
      }),
    ),
    http.route(
      'POST',
      '/api/clawbot/typing/start',
      safe(async (req, res) => {
        const body = await http.readBody(req)
        http.sendJson(res, 200, await service.startTyping({ channelId: body.channelId, toUserId: body.toUserId, contextToken: body.contextToken }))
      }),
    ),
    http.route(
      'POST',
      '/api/clawbot/typing/stop',
      safe(async (req, res) => {
        const body = await http.readBody(req)
        http.sendJson(res, 200, await service.stopTyping({ channelId: body.channelId, toUserId: body.toUserId, contextToken: body.contextToken }))
      }),
    ),
    http.route(
      'GET',
      '/api/clawbot/inbox',
      safe(async (req, res, params, url) => {
        http.sendJson(res, 200, await service.inbox({ channelId: url.searchParams.get('channelId') || '' }))
      }),
    ),
    http.route(
      'POST',
      '/api/clawbot/inbox/ack',
      safe(async (req, res) => {
        const body = await http.readBody(req)
        http.sendJson(res, 200, await service.ackInbox({ channelId: body.channelId, ids: body.ids }))
      }),
    ),
  ]
  const removeCapability = http.registerCapability('wechat-clawbot')
  ctx.effect(() => () => {
    for (const dispose of routeDisposers) dispose?.()
    removeCapability?.()
  })

  ctx.effect(() => async () => {
    if (persistTimer) clearTimeout(persistTimer)
    for (const session of sessions.values()) session.closed = true
    // 关闭前强制落盘一次，确保 token / 同步游标 / 待处理消息不丢。
    await persist({ force: true })
    closed = true
  })
}