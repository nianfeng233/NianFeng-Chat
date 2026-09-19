/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * 点号路径对象工具。
 *
 * 后端 settings 与前端 config 原先各存一份实现；两边规则一旦不同，
 * 配置同步 / 迁移就会出现“同一路径一边写进对象、一边写进数组”的问题。
 * 这里只保留无状态纯函数，前后端共用。
 */
export function toPath(key) {
  return String(key).split('.').filter(Boolean)
}

export function hasPath(obj, key) {
  let cur = obj
  for (const part of toPath(key)) {
    if (cur === null || typeof cur !== 'object' || !(part in cur)) return false
    cur = cur[part]
  }
  return true
}

export function getPath(obj, key) {
  let cur = obj
  for (const part of toPath(key)) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = cur[part]
  }
  return cur
}

export function setPath(obj, key, value) {
  const parts = toPath(key)
  const last = parts.pop()
  let cur = obj
  for (const part of parts) {
    if (cur[part] === null || typeof cur[part] !== 'object') cur[part] = {}
    cur = cur[part]
  }
  cur[last] = value
}

export function removePath(obj, key) {
  const parts = toPath(key)
  const last = parts.pop()
  let cur = obj
  for (const part of parts) {
    cur = cur?.[part]
    if (cur === undefined) return
  }
  if (cur && typeof cur === 'object') delete cur[last]
}

export function flattenValues(target, prefix = '', out = new Map()) {
  for (const [key, value] of Object.entries(target || {})) {
    const path = prefix ? `${prefix}.${key}` : key
    if (value && typeof value === 'object' && !Array.isArray(value)) flattenValues(value, path, out)
    else out.set(path, value)
  }
  return out
}
