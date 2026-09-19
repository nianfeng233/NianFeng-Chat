/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * 后端安全小工具（WebUI 令牌比较、静态目录边界校验）。
 *
 * 这两种判断在 http.mjs / start.mjs 两个入口都要用，放这里避免两份实现漂移。
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { isAbsolute, relative, resolve } from 'node:path'

/**
 * 常量时间比较两个字符串。
 *
 * 直接 `a === b` 会在首个不同字符处短路，理论上可被用于逐字节猜测令牌。
 * 先各自 SHA-256 再 timingSafeEqual，既隐藏内容也隐藏长度差异。
 */
export function timingSafeStringEqual(a, b) {
  const left = createHash('sha256').update(String(a ?? ''), 'utf8').digest()
  const right = createHash('sha256').update(String(b ?? ''), 'utf8').digest()
  return timingSafeEqual(left, right)
}

const TOKEN_HASH_PREFIX = 'nf1'

/**
 * 访问令牌落盘哈希：随机盐 + HMAC-SHA256。
 *
 * 不保存可逆密文，也不保存明文；每次校验用盐重算摘要再做常量时间比较。
 * 选 HMAC 而不是 scrypt 是因为每个携带 Cookie 的 API 请求都会触发校验，
 * scrypt 会让聊天接口明显变慢；令牌由启动脚本生成（24 字节随机）或由用户
 * 在设置页设置（强制至少 12 位），盐化 HMAC 已足够抵御彩虹表与离线穷举。
 */
export function createAccessTokenHash(token) {
  const value = String(token ?? '')
  if (!value) return ''
  const salt = randomBytes(16)
  const digest = createHmac('sha256', salt).update(value, 'utf8').digest()
  return `${TOKEN_HASH_PREFIX}$${salt.toString('base64url')}$${digest.toString('base64url')}`
}

/** 判断一个字符串是否是本模块生成的访问令牌哈希。 */
export function isAccessTokenHash(value) {
  return String(value ?? '').startsWith(`${TOKEN_HASH_PREFIX}$`)
}

/**
 * 校验访问令牌是否匹配落盘哈希。
 * 格式非法、空值或解码失败均返回 false，不抛出异常。
 */
export function verifyAccessTokenHash(token, stored) {
  const value = String(token ?? '')
  const record = String(stored ?? '')
  if (!value || !record.startsWith(`${TOKEN_HASH_PREFIX}$`)) return false
  const parts = record.split('$')
  if (parts.length !== 3) return false
  try {
    const salt = Buffer.from(parts[1], 'base64url')
    const expected = Buffer.from(parts[2], 'base64url')
    if (!salt.length || !expected.length) return false
    const actual = createHmac('sha256', salt).update(value, 'utf8').digest()
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  } catch (_) {
    return false
  }
}

/**
 * 路径是否位于 parent 目录内（含 parent 本身）。
 *
 * 不能用 `target.startsWith(parent)`：`public` 与 `public-backup` / `public2`
 * 这类“兄弟目录”会通过前缀判断绕过。这里用 path.relative 计算真实相对路径，
 * `..` 开头或跨盘符的一律拒绝。
 */
export function isInsideDir(parent, target) {
  if (!parent || !target) return false
  const root = resolve(parent)
  const full = resolve(target)
  const rel = relative(root, full)
  if (!rel) return true
  if (isAbsolute(rel)) return false
  return rel.split(/[\\/]+/)[0] !== '..'
}

const SENSITIVE_FIRST_SEGMENTS = new Set(['user_data', 'data', 'release', 'logs', '.git', '.tmp', '.local', '.cache'])
const SENSITIVE_BASENAMES = new Set(['config.json', 'sessions.json', 'chat.db', 'clawbot.json', 'qqbot.json', 'instance.json', '.secret-key', '.webui-token', '.webui-port'])

/**
 * 生产模式下的监听安全门禁。
 *
 * NODE_ENV=production 时，如果服务监听 0.0.0.0 / :: 却没有任何访问令牌，
 * 会直接拒绝启动——避免把本机聊天数据、模型配置和工具接口暴露到局域网 / 公网。
 * 仅开发调试才允许显式设置 NIANFENG_ALLOW_INSECURE_LISTEN=1 跳过。
 */
export function assertSafeProductionBinding({ host = '127.0.0.1', accessTokenRequired = false, env = process.env } = {}) {
  const isProduction = String(env.NODE_ENV || '').trim().toLowerCase() === 'production'
  if (!isProduction) return
  if (/^(1|true|yes|on)$/i.test(String(env.NIANFENG_ALLOW_INSECURE_LISTEN || '').trim())) return
  const wildcard = !host || host === '0.0.0.0' || host === '::'
  if (wildcard && !accessTokenRequired) {
    throw new Error(
      '生产模式安全校验未通过：监听 0.0.0.0/:: 时必须配置访问令牌。' +
        '请先在设置 → 网络中设置访问令牌，或使用 NIANFENG_WEBUI_TOKEN 环境变量提供一次；' +
        '如果确实要在无令牌情况下开放监听，请显式设置 NIANFENG_ALLOW_INSECURE_LISTEN=1。',
    )
  }
}

/**
 * 单端口 / 开发模式会把项目根目录或静态导出目录整个托管出去；
 * 这些路径不需要对 WebUI 暴露，命中时报 404 而不是把本机配置、聊天库、
 * 版本库目录直接当静态文件发出去。
 */
export function isSensitiveStaticPath(pathname) {
  const segments = String(pathname || '')
    .replace(/\\/g, '/')
    .split('/')
    .filter(segment => segment && segment !== '.')
  if (!segments.length) return false
  const first = segments[0].toLowerCase()
  if (first.startsWith('.')) return true
  if (SENSITIVE_FIRST_SEGMENTS.has(first)) return true
  const base = segments[segments.length - 1].toLowerCase()
  return SENSITIVE_BASENAMES.has(base)
}
