/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * 出网安全网（SSRF 防护）。
 *
 * `/api/rss` 允许传任意 URL。如果直接 fetch，调用方就能借本机后端访问：
 *   - 127.0.0.1 / localhost 上的其它本地服务；
 *   - 10/172.16/192.168 内网主机；
 *   - 169.254.169.254 云元数据；
 *   - 通过 3xx 重定向、DNS 重新绑定绕过第一层字符串检查。
 *
 * 这里做三件事：
 *   1. 只允许 http(s)，拒绝 user:pass@、localhost、.local/.internal 等主机名；
 *   2. 解析域名并检查所有 A / AAAA 记录，任一命中内网段就整体拒绝；
 *   3. 请求时把 DNS 结果固定为已校验地址（自定义 lookup），并手动跟随重定向，
 *      每一跳都重新走 1、2，避免 DNS rebinding 与重定向绕过。
 */
import http from 'node:http'
import https from 'node:https'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

const BLOCKED_IPV4_RANGES = [
  ['0.0.0.0', 8], // 本网络
  ['10.0.0.0', 8], // 私有
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8], // 环回
  ['169.254.0.0', 16], // 链路本地 / 云元数据 169.254.169.254
  ['172.16.0.0', 12], // 私有
  ['192.0.0.0', 24], // IETF Protocol Assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.88.99.0', 24], // 6to4 relay anycast
  ['192.168.0.0', 16], // 私有
  ['198.18.0.0', 15], // 基准测试
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // 组播
  ['240.0.0.0', 4], // 保留
]

function ipv4ToInt(address) {
  const parts = String(address).split('.')
  if (parts.length !== 4) return null
  let value = 0
  for (const part of parts) {
    const octet = Number(part)
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null
    value = value * 256 + octet
  }
  return value >>> 0
}

function ipv4BaseToInt(address) {
  return ipv4ToInt(address) >>> 0
}

function inCidrV4(value, base, prefix) {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
  return (value & mask) >>> 0 === (base & mask) >>> 0
}

function isPrivateIPv4(address) {
  const value = ipv4ToInt(address)
  if (value === null) return true
  return BLOCKED_IPV4_RANGES.some(([base, prefix]) => inCidrV4(value, ipv4BaseToInt(base), prefix))
}

/** 把 IPv6 展开成 8 个 16 位分组；返回 null 表示无法解析。 */
function expandIPv6(address) {
  let input = String(address).split('%')[0].toLowerCase()
  let ipv4Tail = null
  const v4match = input.match(/(\d+\.\d+\.\d+\.\d+)$/)
  if (v4match) {
    const parts = v4match[1].split('.').map(Number)
    if (parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return null
    ipv4Tail = [((parts[0] << 8) | parts[1]) >>> 0, ((parts[2] << 8) | parts[3]) >>> 0]
    input = input.slice(0, v4match.index).replace(/:$/, '')
  }
  const halves = input.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':').filter(Boolean) : []
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':').filter(Boolean) : []
  const missing = 8 - head.length - tail.length - (ipv4Tail ? 2 : 0)
  if (missing < 0) return null
  const groups = [
    ...head.map(part => parseInt(part, 16)),
    ...Array(missing).fill(0),
    ...tail.map(part => parseInt(part, 16)),
    ...(ipv4Tail || []),
  ]
  if (groups.length !== 8 || groups.some(part => !Number.isInteger(part) || part < 0 || part > 0xffff)) return null
  return groups
}

function isPrivateIPv6(address) {
  const groups = expandIPv6(address)
  if (!groups) return true
  if (groups.every(part => part === 0)) return true // ::
  if (groups.slice(0, 7).every(part => part === 0) && groups[7] === 1) return true // ::1

  // IPv4-mapped ::ffff:a.b.c.d
  if (groups.slice(0, 5).every(part => part === 0) && groups[5] === 0xffff) {
    return isPrivateIPv4(`${(groups[6] >> 8) & 0xff}.${groups[6] & 0xff}.${(groups[7] >> 8) & 0xff}.${groups[7] & 0xff}`)
  }
  if ((groups[0] & 0xfe00) === 0xfc00) return true // fc00::/7
  if ((groups[0] & 0xffc0) === 0xfe80) return true // fe80::/10
  if ((groups[0] & 0xff00) === 0xff00) return true // ff00::/8
  if (groups[0] === 0x2001 && groups[1] === 0x0db8) return true // 2001:db8::/32
  if (groups[0] === 0x0100 && groups[1] === 0 && groups[2] === 0 && groups[3] === 0) return true // 100::/64
  if (groups[0] === 0x2001 && groups[1] === 0x0000) return true // Teredo，可封装内网 IPv4
  if (groups[0] === 0x2002) return true // 6to4，同样可封装内网 IPv4
  if (groups[0] === 0x0064 && groups[1] === 0xff9b) {
    // NAT64。本地使用前缀 64:ff9b:1::/48 直接拒绝；
    // well-known 前缀 64:ff9b::/96 则检查内嵌 IPv4。
    if (groups[2] === 0x0001) return true
    return isPrivateIPv4(`${(groups[6] >> 8) & 0xff}.${groups[6] & 0xff}.${(groups[7] >> 8) & 0xff}.${groups[7] & 0xff}`)
  }
  return false
}

/** 是否属于禁止出网访问的内网 / 本机 / 保留地址。未知格式按不安全处理。 */
export function isPrivateAddress(address) {
  const value = String(address || '').split('%')[0]
  const family = isIP(value)
  if (family === 4) return isPrivateIPv4(value)
  if (family === 6) return isPrivateIPv6(value)
  return true
}

function isPrivateHostname(hostname) {
  const host = String(hostname || '').trim().toLowerCase().replace(/\.$/, '')
  if (!host) return true
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (['metadata', 'metadata.google.internal', 'instance-data'].includes(host)) return true
  return ['.local', '.internal', '.home.arpa', '.lan', '.intranet', '.test', '.invalid'].some(suffix => host.endsWith(suffix))
}

function requestError(message, status = 502) {
  return Object.assign(new Error(message), { status })
}

/**
 * 校验 URL 并解析出所有目标地址；任一地址在禁止网段即抛 400。
 * 返回固定后的 addresses，交给 requestPinned 使用，避免二次解析被 DNS rebinding。
 */
export async function resolvePublicHttpUrl(raw) {
  let url
  try {
    url = new URL(String(raw))
  } catch (_) {
    throw requestError('URL 格式不正确', 400)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw requestError('仅支持 http(s) 地址', 400)
  if (url.username || url.password) throw requestError('URL 不允许携带用户名 / 密码', 400)

  const hostname = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname
  if (isPrivateHostname(hostname)) throw requestError('禁止访问本机 / 内网地址', 400)

  let addresses
  if (isIP(hostname)) {
    addresses = [{ address: hostname, family: isIP(hostname) }]
  } else {
    try {
      addresses = await lookup(hostname, { all: true, verbatim: true })
    } catch (err) {
      throw requestError(`域名解析失败：${err?.message || '未知错误'}`, 502)
    }
  }
  if (!Array.isArray(addresses) || !addresses.length) throw requestError('域名没有可用地址', 502)
  if (addresses.some(item => isPrivateAddress(item.address))) throw requestError('禁止访问内网 / 本机地址', 400)
  return { url, addresses: addresses.map(item => ({ address: item.address, family: Number(item.family) || 0 })) }
}

/**
 * 使用已校验地址发起单次请求（不自动跟随重定向）。
 * 导出用于安全自测；业务入口只应使用 fetchPublicText。
 */
export function requestPinned(input, { addresses, method = 'GET', headers = {}, timeoutMs = 15000 } = {}) {
  const url = input instanceof URL ? input : new URL(String(input))
  if (!Array.isArray(addresses) || !addresses.length) return Promise.reject(requestError('缺少已校验的目标地址'))
  const servername = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname
  return new Promise((resolve, reject) => {
    let settled = false
    const lib = url.protocol === 'https:' ? https : http
    const request = lib.request(
      url,
      {
        method,
        headers,
        timeout: timeoutMs,
        signal: AbortSignal.timeout(timeoutMs),
        lookup(hostname, options, callback) {
          const wanted = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '')
          if (wanted !== servername.toLowerCase()) {
            return callback(Object.assign(new Error(`DNS 校验失败：${hostname}`), { code: 'ENOTFOUND' }))
          }
          const family = typeof options === 'number' ? options : Number(options?.family) || 0
          const list = family ? addresses.filter(item => Number(item.family) === family) : addresses
          if (!list.length) return callback(Object.assign(new Error('没有可用的目标地址'), { code: 'ENOTFOUND' }))
          if (typeof options === 'object' && options?.all) return callback(null, list)
          return callback(null, list[0].address, Number(list[0].family))
        },
      },
      res => {
        settled = true
        resolve(res)
      },
    )
    request.on('timeout', () => request.destroy(Object.assign(new Error('请求超时'), { code: 'ETIMEDOUT' })))
    request.on('error', err => {
      if (settled) return
      settled = true
      reject(err)
    })
    request.end()
  })
}

function networkErrorMessage(err) {
  if (err?.name === 'AbortError' || err?.code === 'ABORT_ERR' || err?.code === 'ETIMEDOUT') return '请求超时'
  return err?.message || String(err)
}

/**
 * 拉取受信任程度未知的远程文本：先校验 URL，再固定 DNS 请求，并手动处理每一跳重定向。
 */
export async function fetchPublicText(raw, { headers = {}, timeoutMs = 15000, maxRedirects = 5, maxBytes = 500000 } = {}) {
  const limit = Math.max(1024, Number(maxBytes) || 500000)
  const redirects = Math.min(Math.max(Number(maxRedirects) || 0, 0), 8)
  let current = String(raw)

  for (let hop = 0; hop <= redirects; hop += 1) {
    const { url, addresses } = await resolvePublicHttpUrl(current)
    let response
    try {
      response = await requestPinned(url, { addresses, headers, timeoutMs })
    } catch (err) {
      throw requestError(`请求失败：${networkErrorMessage(err)}`)
    }

    const status = Number(response.statusCode) || 0
    const location = response.headers?.location
    if (status >= 300 && status < 400) {
      response.resume()
      if (!location) throw requestError(`目标返回 HTTP ${status} 且没有 Location`)
      if (hop === redirects) throw requestError('重定向次数过多')
      current = new URL(String(location), url).href
      continue
    }
    if (status < 200 || status >= 300) {
      response.resume()
      throw requestError(`目标返回 HTTP ${status}`)
    }

    const chunks = []
    let size = 0
    let truncated = false
    try {
      for await (const chunk of response) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        if (size + buffer.length >= limit) {
          chunks.push(buffer.subarray(0, limit - size))
          size = limit
          truncated = true
          response.destroy()
          break
        }
        chunks.push(buffer)
        size += buffer.length
      }
    } catch (err) {
      if (!truncated) throw requestError(`读取响应失败：${networkErrorMessage(err)}`)
    }
    return { url: url.href, status, text: Buffer.concat(chunks).toString('utf8'), length: size, truncated }
  }

  throw requestError('重定向次数过多')
}
