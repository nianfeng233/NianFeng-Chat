/**
 * 后端 · sessions
 * 真实的会话/消息持久化（user_data/sessions.json），供 WebUI 与渠道共享。
 */
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export const name = 'sessions'
export const inject = []

const MAX_MESSAGES = 5000

export function apply(ctx, config = {}) {
  let dataDir = config.dataDir || join(process.cwd(), 'user_data')
  let file = join(dataDir, 'sessions.json')
  let data = { conversations: [], updatedAt: 0 }
  let saveTimer = null

  const readFrom = async target => {
    try {
      const raw = await readFile(target, 'utf8')
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed?.conversations)) return { conversations: parsed.conversations, updatedAt: parsed.updatedAt || 0 }
    } catch (err) {
      if (err.code !== 'ENOENT') ctx.logger.warn(`会话文件读取失败（${target}）：${err.message}`)
    }
    return null
  }

  const load = async () => {
    await mkdir(dataDir, { recursive: true })
    const parsed = await readFrom(file)
    if (parsed) data = parsed
    ctx.logger.info(`会话数据已加载：${data.conversations.length} 个会话`)
  }

  const flushTo = async (target, payload) => {
    payload.updatedAt = Date.now()
    await mkdir(dirname(target), { recursive: true })
    const tmp = `${target}.tmp`
    await writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8')
    await rename(tmp, target)
  }

  const flushNow = async () => {
    data.updatedAt = Date.now()
    await mkdir(dataDir, { recursive: true })
    const tmp = `${file}.tmp`
    await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
    await rename(tmp, file)
  }

  // 所有落盘串行化：避免防抖定时器与手动 flush 同时写同一个 .tmp
  let flushChain = Promise.resolve()
  const flush = () => {
    flushChain = flushChain.then(flushNow, flushNow)
    return flushChain
  }

  /**
   * 切换会话数据目录。
   * migrate=true 且目标没有 sessions.json 时，把当前会话写过去；
   * 否则加载目标已有数据（没有则从空开始）。
   */
  const rehome = async (nextDir, { migrate = true } = {}) => {
    await readyPromise
    if (saveTimer) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
    await flush().catch(() => {})
    await mkdir(nextDir, { recursive: true })
    const nextFile = join(nextDir, 'sessions.json')
    if (migrate) {
      const existing = await readFrom(nextFile)
      if (!existing) await flushTo(nextFile, structuredClone(data))
    }
    dataDir = nextDir
    file = nextFile
    const parsed = await readFrom(file)
    data = parsed || { conversations: [], updatedAt: 0 }
    await flush()
    ctx.logger.info(`会话目录已切换：${file}`)
    return { conversations: data.conversations.length }
  }

  const scheduleSave = () => {
    if (saveTimer) return
    saveTimer = setTimeout(() => {
      saveTimer = null
      flush().catch(err => ctx.logger.error(`会话保存失败：${err.message}`))
    }, 300)
  }

  const newId = () => `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const now = () => new Date().toISOString()

  const service = {
    get file() {
      return file
    },
    get dataDir() {
      return dataDir
    },
    rehome,
    list: () => structuredClone(data.conversations),
    get(id) {
      const conv = data.conversations.find(c => c.id === id)
      return conv ? structuredClone(conv) : null
    },
    find(id) {
      return data.conversations.find(c => c.id === id) || null
    },
    count: () => data.conversations.length,
    totalMessages: () => data.conversations.reduce((sum, c) => sum + (c.messages?.length || 0), 0),

    create(partial = {}) {
      const conv = {
        id: partial.id || newId(),
        name: partial.name || '新的会话',
        avatar: partial.avatar || (partial.name || '新').slice(0, 1),
        c1: partial.c1 || '#7fb2ff',
        c2: partial.c2 || '#4a7dff',
        preview: partial.preview || '',
        time: partial.time || '',
        updatedAt: Date.now(),
        createdAt: Date.now(),
        messages: partial.messages || [],
        meta: partial.meta || {},
      }
      const existing = data.conversations.findIndex(c => c.id === conv.id)
      if (existing >= 0) data.conversations[existing] = conv
      else data.conversations.unshift(conv)
      scheduleSave()
      ctx.emit('sessions/changed', { id: conv.id, action: 'create' })
      return structuredClone(conv)
    },

    update(id, patch = {}) {
      const conv = service.find(id)
      if (!conv) return null
      Object.assign(conv, patch, { id: conv.id, updatedAt: Date.now() })
      scheduleSave()
      ctx.emit('sessions/changed', { id, action: 'update' })
      return structuredClone(conv)
    },

    remove(id) {
      const index = data.conversations.findIndex(c => c.id === id)
      if (index < 0) return false
      data.conversations.splice(index, 1)
      scheduleSave()
      ctx.emit('sessions/changed', { id, action: 'remove' })
      return true
    },

    addMessage(id, message = {}) {
      const conv = service.find(id)
      if (!conv) return null
      const msg = {
        id: message.id || `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        role: message.role || 'user',
        content: String(message.content ?? ''),
        time: message.time || new Date().toTimeString().slice(0, 5),
        status: message.status,
        kind: message.kind || 'text',
        meta: message.meta || {},
        createdAt: now(),
      }
      conv.messages.push(msg)
      if (conv.messages.length > MAX_MESSAGES) conv.messages.splice(0, conv.messages.length - MAX_MESSAGES)
      if (msg.kind !== 'divider') {
        conv.preview = msg.content.replace(/\s+/g, ' ').slice(0, 80)
        conv.updatedAt = Date.now()
        conv.time = msg.time
      }
      scheduleSave()
      ctx.emit('sessions/changed', { id, action: 'message', message: structuredClone(msg) })
      return structuredClone(msg)
    },

    updateMessage(id, messageId, patch = {}) {
      const conv = service.find(id)
      const msg = conv?.messages.find(m => m.id === messageId)
      if (!msg) return null
      Object.assign(msg, patch, { id: messageId })
      conv.updatedAt = Date.now()
      scheduleSave()
      ctx.emit('sessions/changed', { id, action: 'message-update', message: structuredClone(msg) })
      return structuredClone(msg)
    },

    removeMessage(id, messageId) {
      const conv = service.find(id)
      if (!conv) return false
      const index = conv.messages.findIndex(m => m.id === messageId)
      if (index < 0) return false
      conv.messages.splice(index, 1)
      scheduleSave()
      ctx.emit('sessions/changed', { id, action: 'message-remove', messageId })
      return true
    },

    /** 渠道入站消息：按渠道找到（或创建）对应会话 */
    conversationForChannel({ channelId, channelName = '渠道', channelType = 'custom', color = '#8b919c' }) {
      let conv = data.conversations.find(c => c.meta?.channelId === channelId)
      if (!conv) {
        service.create({
          name: channelName,
          avatar: channelName.slice(0, 1),
          c1: color,
          c2: color,
          preview: `${channelName} 已接入`,
          meta: { channelId, channelType },
        })
        conv = data.conversations.find(c => c.meta?.channelId === channelId)
      }
      return conv ? structuredClone(conv) : null
    },

    exportAll: () => structuredClone(data),
    async flush() {
      if (saveTimer) {
        clearTimeout(saveTimer)
        saveTimer = null
      }
      await flush()
    },
  }

  const readyPromise = load().then(() => service)
  // ready 钩子：http 插件会等待
  service.ready = () => readyPromise
  ctx.provide('sessions', service)
  ctx.effect(
    () => () => {
      if (saveTimer) clearTimeout(saveTimer)
    },
  )
}

