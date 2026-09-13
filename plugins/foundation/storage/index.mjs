/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * F1 · storage
 * KV + 结构化数据存储。浏览器环境用 localStorage，不可用时自动降级到内存，
 * 这样在打包成桌面端或隐私模式时也不会直接崩掉（文档 §10.7）。
 */
export const name = 'storage'
export const version = '1.0.0'
export const displayName = '数据存储'
export const description = '基础服务 · 会话与配置的本地持久化（localStorage + 内存降级）。'
export const author = '念风内核'
export const icon = '💾'
export const core = true
export const depends = {}
export const optionalDepends = {}
export const inject = []
export const provides = [{ name: 'storage', type: 'singleton' }]

const PREFIX = 'nianfeng:'

function detectBackend() {
  try {
    const k = `${PREFIX}__probe__`
    localStorage.setItem(k, '1')
    localStorage.removeItem(k)
    return localStorage
  } catch (_) {
    const mem = new Map()
    return {
      getItem: k => (mem.has(k) ? mem.get(k) : null),
      setItem: (k, v) => mem.set(k, v),
      removeItem: k => mem.delete(k),
      key: i => [...mem.keys()][i] ?? null,
      get length() {
        return mem.size
      },
    }
  }
}

export function apply(ctx) {
  const backend = detectBackend()
  const cache = new Map() // ns -> data

  const readNS = ns => {
    if (cache.has(ns)) return cache.get(ns)
    try {
      const raw = backend.getItem(PREFIX + ns)
      const data = raw ? JSON.parse(raw) : {}
      cache.set(ns, data)
      return data
    } catch (err) {
      ctx.logger.warn(`命名空间 ${ns} 数据损坏，已重置`, err)
      cache.set(ns, {})
      return cache.get(ns)
    }
  }

  const writeNS = ns => {
    try {
      backend.setItem(PREFIX + ns, JSON.stringify(readNS(ns)))
    } catch (err) {
      ctx.logger.error('写入存储失败', err)
    }
  }

  const service = {
    name: 'storage',
    backend: backend === localStorage ? 'localStorage' : 'memory',

    get(ns, key, fallback = undefined) {
      const data = readNS(ns)
      return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : fallback
    },

    set(ns, key, value) {
      const data = readNS(ns)
      if (value === undefined) delete data[key]
      else data[key] = value
      writeNS(ns)
      ctx.emit('storage:changed', { ns, key, value })
      return value
    },

    remove(ns, key) {
      return service.set(ns, key, undefined)
    },

    has(ns, key) {
      return Object.prototype.hasOwnProperty.call(readNS(ns), key)
    },

    keys(ns) {
      return Object.keys(readNS(ns))
    },

    clear(ns) {
      cache.set(ns, {})
      backend.removeItem(PREFIX + ns)
      ctx.emit('storage:cleared', { ns })
    },

    dump(ns) {
      return structuredClone(readNS(ns))
    },

    namespaces() {
      return [...cache.keys()]
    },

    /** 导出全部念风数据（D9 export-service 会用） */
    exportAll() {
      const out = {}
      for (let i = 0; i < backend.length; i++) {
        const key = backend.key(i)
        if (!key?.startsWith(PREFIX)) continue
        try {
          out[key.slice(PREFIX.length)] = JSON.parse(backend.getItem(key))
        } catch (_) {
          /* 跳过损坏数据 */
        }
      }
      return out
    },
  }

  ctx.provide('storage', service, { type: 'singleton' })
  ctx.logger.debug(`存储就绪（${service.backend}）`)
}
