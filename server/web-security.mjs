/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * Web 层安全公共件。
 *
 * 背景：WebUI 代理（start.mjs）与后端 HTTP 插件（server/plugins/http.mjs）
 * 原先各自维护一份 Host/Origin、Cookie、访问令牌、401 页面逻辑。两份实现一旦
 * 漂移，就可能出现“一个入口放行、另一个入口拦住”的安全问题。这里把纯函数
 * 与少量渲染逻辑收敛到一处，两个入口只保留各自的路由/代理职责。
 */
import { timingSafeStringEqual, verifyAccessTokenHash } from './security-utils.mjs'

export const ACCESS_TOKEN_COOKIE = 'nianfeng_token'
export const ACCESS_TOKEN_HEADER = 'x-nianfeng-token'
export const ACCESS_TOKEN_AGENT_HEADER = 'x-nianfeng-agent'
export const ACCESS_TOKEN_INTERNAL_HEADER = 'x-nianfeng-internal'
export const ACCESS_TOKEN_MAX_AGE = 31536000

/** 主机名规范化：去空白 / 小写 / 去 IPv6 方括号，并保留 `[::1]` 的显式形式。 */
export function normalizeHostName(value) {
  let name = String(value || '').trim().toLowerCase()
  if (!name) return ''
  name = name.replace(/^\[|\]$/g, '')
  if (name === '::1') return '[::1]'
  return name
}

/** 允许配置项写成 `example.com`、`example.com:8788` 或完整 `http://example.com:8788`。 */
export function hostNameFromConfig(value) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  try {
    const parsed = new URL(raw.includes('://') ? raw : `http://${raw}`)
    return normalizeHostName(parsed.hostname)
  } catch (_) {
    return normalizeHostName(raw)
  }
}

/** 解析 Cookie 头里的指定字段；编码损坏时返回原始值。 */
export function parseCookieValue(cookieHeader, name) {
  for (const part of String(cookieHeader || '').split(';')) {
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

/** 判断监听地址是否只对本机可见。 */
export function isLoopbackHost(host) {
  const name = normalizeHostName(host)
  return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(name)
}

/** 请求是否来自 HTTPS（直连或反向代理）。用于按需给 Cookie 加 Secure。 */
export function isSecureRequest(req) {
  if (req?.socket?.encrypted === true) return true
  const proto = String(req?.headers?.['x-forwarded-proto'] || '')
    .split(',')[0]
    .trim()
    .toLowerCase()
  return proto === 'https'
}

/** 构造访问令牌 Cookie 响应头。 */
export function accessTokenCookie(token, { secure = false, maxAge = ACCESS_TOKEN_MAX_AGE } = {}) {
  const attrs = [`Path=/`, 'HttpOnly', 'SameSite=Lax', `Max-Age=${Number(maxAge) || 0}`]
  if (secure) attrs.push('Secure')
  return `${ACCESS_TOKEN_COOKIE}=${encodeURIComponent(token || '')}; ${attrs.join('; ')}`
}

/** 构造清除访问令牌 Cookie 的响应头。 */
export function clearAccessTokenCookie({ secure = false } = {}) {
  return accessTokenCookie('', { secure, maxAge: 0 })
}

/**
 * 访问令牌匹配器：兼容“进程内明文 + 配置摘要”，并允许调用方提供
 * 动态摘要读取（设置页运行中修改令牌后无需重启即可生效）。
 */
export function createAccessTokenMatcher({ plainToken = '', tokenHash = '', getLatestHash = null } = {}) {
  const plain = String(plainToken || '').trim()
  const startupHash = String(tokenHash || '').trim()
  const latestHash = () => {
    try {
      return String(getLatestHash?.() || '').trim()
    } catch (_) {
      return ''
    }
  }
  const required = () => !!(plain || startupHash || latestHash())
  const matches = candidate => {
    const value = String(candidate || '')
    if (!value) return false
    if (plain && timingSafeStringEqual(value, plain)) return true
    const storedHash = latestHash() || startupHash
    if (storedHash) return verifyAccessTokenHash(value, storedHash)
    return false
  }
  return { required, matches, latestHash }
}

/** Web 入口统一的 401 令牌输入页；两个入口共用，避免文案与表单行为漂移。 */
export function buildAuthPage() {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>需要访问令牌</title>
<body style="font-family:system-ui,sans-serif;padding:48px;color:#1a1d21"><h2>需要访问令牌</h2>
<p>首次启动时终端最上方会打印随机访问令牌；之后请使用你在「设置 → 网络」里设置的值。后端只保存摘要，不保存明文。</p>
<form method="get" action="/" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:18px 0">
  <input name="token" type="password" autocomplete="off" autofocus required placeholder="粘贴访问令牌"
    style="min-width:280px;padding:10px 12px;border:1px solid #d6dbd1;border-radius:8px;font:inherit" />
  <button type="submit" style="padding:10px 18px;border:0;border-radius:8px;background:#3f6f3a;color:#fff;font:inherit;cursor:pointer">进入</button>
</form>
<p style="color:#6b7468">验证通过后会写入本机 HttpOnly Cookie，随后地址栏会自动去掉令牌；API 请使用 Cookie 或 <code>X-NianFeng-Token</code> 请求头。</p>
<p style="color:#6b7468">也可以手动访问：<code>http://&lt;主机&gt;:&lt;端口&gt;/?token=你的令牌</code></p></body></html>`
}
