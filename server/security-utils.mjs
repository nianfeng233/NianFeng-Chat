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
import { createHash, timingSafeEqual } from 'node:crypto'
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
