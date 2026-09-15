/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * 渠道外网请求的小工具：
 *   - 对瞬时网络错误做有限重试；
 *   - 把 Node fetch 的 cause 链展开成可读原因，避免渠道界面只显示一句
 *     “fetch failed”，用户无法判断是 DNS、代理、IPv6 还是远端拒绝。
 */

const RETRYABLE_CODES = new Set([
  'EAI_AGAIN',
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETDOWN',
  'ENETUNREACH',
  'EPIPE',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
])

function errorChain(error) {
  const chain = []
  let current = error
  while (current && chain.length < 6) {
    chain.push(current)
    if (current.cause === current) break
    current = current.cause
  }
  return chain
}

function networkCodeOf(error) {
  for (const item of errorChain(error)) {
    const direct = item?.code || item?.errno
    if (direct) return String(direct)
    const nested = item?.errors?.[0]?.code
    if (nested) return String(nested)
  }
  return ''
}

function networkDetailOf(error) {
  for (const item of errorChain(error)) {
    const nested = item?.errors?.[0]?.message
    if (nested) return String(nested)
    if (item?.message && !/^fetch failed$/i.test(String(item.message))) return String(item.message)
  }
  return '远端服务器无响应'
}

export function isRetryableNetworkError(error) {
  if (!error) return false
  if (error.name === 'AbortError' || error.code === 'ABORT_ERR') return false
  const code = networkCodeOf(error).toUpperCase()
  if (RETRYABLE_CODES.has(code)) return true
  const text = `${code} ${networkDetailOf(error)} ${String(error.message || '')}`.toLowerCase()
  return /fetch failed|socket hang up|econnreset|etimedout|eai_again|network error|temporarily unavailable|连接被重置|连接超时/.test(text)
}

export function networkErrorText(error, fallback = '网络连接失败') {
  if (!error) return fallback
  if (error.name === 'AbortError' || error.code === 'ABORT_ERR') return '请求超时或已取消'
  const code = networkCodeOf(error)
  const detail = networkDetailOf(error)
  return `${fallback}${code ? `（${code}）` : ''}：${detail}`
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, Math.max(0, Number(ms) || 0)))

/**
 * fetch 包装：默认在瞬时网络错误时重试 2 次（共 3 次请求）。
 * 远端已返回 HTTP 状态码时不重试，避免重复提交副作用请求。
 */
export async function fetchWithNetworkRetry(input, init = {}, { retries = 2, delayMs = 350, onRetry } = {}) {
  const maxRetries = Math.max(0, Math.floor(Number(retries) || 0))
  let lastError = null
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await fetch(input, init)
    } catch (error) {
      lastError = error
      const canRetry = attempt < maxRetries && !init?.signal?.aborted && isRetryableNetworkError(error)
      if (!canRetry) break
      onRetry?.(attempt + 1, error)
      await sleep(Number(delayMs || 350) * (attempt + 1))
    }
  }
  const wrapped = new Error(networkErrorText(lastError))
  wrapped.cause = lastError
  throw wrapped
}
