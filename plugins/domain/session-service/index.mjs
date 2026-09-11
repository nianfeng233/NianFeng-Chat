/**
 * D1 · session-service
 * 会话 CRUD、当前激活会话、上下文组装（文档 §6.2）。
 *
 * 数据策略（真实、可预期）：
 *   - 后端在线：以后端当前数据目录的 sessions.json（默认 user_data/）为准，所有修改写回后端
 *   - 后端离线：降级到本地存储，并在界面标注"离线模式"
 *   - 首次启动：如果后端为空而本地有历史，则把本地会话迁移到后端
 */
export const name = 'session-service'
export const version = '2.0.0'
export const displayName = '会话服务'
export const description = '业务服务 · 会话管理、上下文组装、后端持久化与离线降级。'
export const author = '风语内核'
export const icon = '💬'
export const core = true
export const depends = { storage: '^1.0.0', config: '^1.0.0' }
export const inject = ['storage', 'config', 'api?']
export const provides = [{ name: 'session-service', type: 'singleton' }]

const NS = 'sessions'
const KEY = 'data'
const PALETTE = [
  ['#7fb2ff', '#4a7dff'], ['#a8b6ff', '#7c6cff'], ['#ffd08a', '#ff9f43'], ['#8de0c1', '#37b98a'],
  ['#ffb1c1', '#ff6b8b'], ['#c9b6ff', '#8b6bff'], ['#9fd8ff', '#3aa0ff'], ['#ffc9a3', '#ff8a4c'],
]

export function apply(ctx) {
  const storage = ctx.inject('storage')
  const config = ctx.inject('config')
  const api = ctx.inject('api')

  let data = storage.get(NS, KEY, null)
  if (!data || !Array.isArray(data.conversations)) data = { conversations: [], activeId: null }
  // 「启动时恢复上次状态」关闭时，启动后不自动选中上次的会话
  if (!config.get('general.restore', true)) data.activeId = null

  let source = 'local'
  let lastSyncError = ''
  let syncing = false
  const pushTimers = new Map()

  const persistLocal = () => storage.set(NS, KEY, data)
  const randomId = () => `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const find = id => data.conversations.find(c => c.id === id) || null

  const service = {
    name: 'session-service',

    /* -------- 数据来源 -------- */
    source: () => source,
    status: () => ({ source, error: lastSyncError, syncing, conversations: data.conversations.length }),

    /** 用后端数据插入/替换（渠道入站消息等场景） */
    adopt(conversation, { activate = false } = {}) {
      if (!conversation?.id) return null
      const index = data.conversations.findIndex(c => c.id === conversation.id)
      if (index >= 0) data.conversations[index] = conversation
      else data.conversations.unshift(conversation)
      persistLocal()
      ctx.emit('conversation:update', conversation)
      if (activate) service.activate(conversation.id)
      return conversation
    },

    /** 手动从后端整体拉取 */
    async sync() {
      if (!api) throw new Error('后端未连接')
      syncing = true
      try {
        const payload = await api.sessions()
        const server = payload.conversations || []
        data = {
          conversations: server,
          activeId: server.some(c => c.id === data.activeId) ? data.activeId : server[0]?.id || null,
        }
        persistLocal()
        source = 'server'
        lastSyncError = ''
        ctx.emit('sessions:synced', { source, count: server.length })
        ctx.emit('conversation:sync', { conversations: server })
        return { ok: true, count: server.length }
      } catch (err) {
        source = 'local'
        lastSyncError = err.message
        ctx.emit('sessions:source', service.status())
        throw err
      } finally {
        syncing = false
      }
    },

    /* -------- 查询 -------- */
    list: () => data.conversations,
    get: id => find(id),
    activeId: () => (find(data.activeId) ? data.activeId : null),
    active: () => find(data.activeId),
    messages: id => find(id)?.messages || [],
    message: (id, messageId) => service.messages(id).find(msg => msg.id === messageId) || null,
    count: () => data.conversations.length,

    /** 组装模型上下文：最近 limit 条可对话消息（文档 §8.1） */
    context(id, limit = 30) {
      const conv = find(id)
      if (!conv) return []
      return conv.messages
        .filter(msg => msg.kind !== 'divider' && msg.role !== 'system' && !msg.error)
        .slice(-limit)
        .map(msg => ({ role: msg.role === 'assistant' ? 'assistant' : 'user', content: msg.content }))
    },

    /* -------- 激活 -------- */
    activate(id) {
      const next = id && find(id) ? id : null
      data.activeId = next
      persistLocal()
      ctx.emit('conversation:switch', { id: next })
      return next
    },
    toggle(id) {
      return service.activate(data.activeId === id ? null : id)
    },

    /* -------- CRUD -------- */
    create(partial = {}) {
      const n = data.conversations.length
      const [c1, c2] = PALETTE[n % PALETTE.length]
      const conv = {
        id: partial.id || randomId(),
        name: partial.name || '新的会话',
        avatar: partial.avatar || (partial.name || '新').slice(0, 1),
        c1: partial.c1 || c1,
        c2: partial.c2 || c2,
        preview: partial.preview || '',
        time: partial.time || '',
        updatedAt: Date.now(),
        createdAt: Date.now(),
        messages: partial.messages || [],
        meta: partial.meta || {},
      }
      data.conversations.unshift(conv)
      persistLocal()
      service.pushCreate(conv)
      ctx.emit('conversation:create', conv)
      return conv
    },

    remove(id) {
      const index = data.conversations.findIndex(c => c.id === id)
      if (index < 0) return false
      const [conv] = data.conversations.splice(index, 1)
      if (data.activeId === id) data.activeId = data.conversations[0]?.id || null
      const pending = pushTimers.get(id)
      if (pending?.timer) clearTimeout(pending.timer)
      pushTimers.delete(id)
      persistLocal()
      if (source === 'server' && api) api.deleteSession(id).catch(err => ctx.logger.warn(`删除后端会话失败：${err.message}`))
      ctx.emit('conversation:delete', { id, conversation: conv })
      return true
    },

    update(id, patch, { push = true } = {}) {
      const conv = find(id)
      if (!conv) return null
      Object.assign(conv, patch)
      conv.updatedAt = patch.updatedAt || Date.now()
      persistLocal()
      if (push) service.push(conv)
      ctx.emit('conversation:update', conv)
      return conv
    },

    rename(id, name) {
      const conv = find(id)
      if (!conv) return null
      return service.update(id, { name, avatar: (name || conv.avatar).slice(0, 1) || conv.avatar })
    },

    touch(id, patch = {}) {
      const conv = find(id)
      if (!conv) return null
      if (patch.preview !== undefined) conv.preview = String(patch.preview).replace(/\n/g, ' ').slice(0, 80)
      conv.updatedAt = Date.now()
      persistLocal()
      ctx.emit('conversation:update', conv)
      return conv
    },

    /* -------- 消息容器（由 D2 调用） -------- */
    appendMessage(id, message) {
      const conv = find(id)
      if (!conv) return null
      conv.messages.push(message)
      if (message.kind !== 'divider') {
        conv.preview = String(message.content || '').replace(/\n/g, ' ').slice(0, 80)
        conv.updatedAt = Date.now()
        conv.time = message.time || conv.time
      }
      persistLocal()
      service.push(conv)
      return message
    },

    updateMessage(id, messageId, patch) {
      const message = service.message(id, messageId)
      if (!message) return null
      Object.assign(message, patch)
      persistLocal()
      service.push(find(id))
      return message
    },

    removeMessage(id, messageId) {
      const conv = find(id)
      if (!conv) return false
      const index = conv.messages.findIndex(msg => msg.id === messageId)
      if (index < 0) return false
      conv.messages.splice(index, 1)
      persistLocal()
      service.push(conv)
      return true
    },

    clearMessages(id) {
      const conv = find(id)
      if (!conv) return
      conv.messages = []
      persistLocal()
      service.push(conv)
      ctx.emit('conversation:update', conv)
    },

    /* -------- 与后端同步 -------- */
    pushCreate(conv) {
      if (source !== 'server' || !api) return
      api.createSession(conv).catch(err => ctx.logger.warn(`创建后端会话失败：${err.message}`))
    },

    /** 防抖写回：聊天流式输出时不会每 2 个字符就写一次盘 */
    push(conv) {
      if (source !== 'server' || !api || !conv) return
      const pending = pushTimers.get(conv.id) || { timer: null }
      if (pending.timer) clearTimeout(pending.timer)
      pending.timer = setTimeout(() => {
        pending.timer = null
        const current = find(conv.id)
        if (!current || source !== 'server' || !api) return
        api.saveSession(current).catch(err => {
          lastSyncError = err.message
          ctx.emit('sessions:source', service.status())
          ctx.logger.warn(`会话写回失败：${err.message}`)
        })
      }, 500)
      pushTimers.set(conv.id, pending)
    },

    stats() {
      const messages = data.conversations.reduce((sum, c) => sum + c.messages.length, 0)
      return { conversations: data.conversations.length, messages, source, error: lastSyncError }
    },

    reset() {
      data = { conversations: [], activeId: null }
      storage.remove(NS, KEY)
      ctx.emit('conversation:reset', null)
      ctx.emit('conversation:sync', { conversations: [] })
    },
  }

  ctx.effect(() => {
    for (const { timer } of pushTimers.values()) if (timer) clearTimeout(timer)
    pushTimers.clear()
  })

  ctx.provide('session-service', service, { type: 'singleton' })

  // 全局搜索 / 扩展插件想“打开某个会话”时走这个事件，
  // 而不是直接 emit conversation:switch（那只通知 UI，不改 activeId）。
  ctx.effect(
    ctx.on('search:open-conversation', payload => {
      const id = payload?.id
      if (id && service.get(id)) service.activate(id)
    }),
  )

  /* 启动时与后端对齐（不阻塞插件加载） */
  if (api) {
    const boot = async () => {
      try {
        const payload = await api.sessions()
        const server = payload.conversations || []
        const restoreLast = config.get('general.restore', true)
        if (server.length === 0 && data.conversations.length) {
          for (const conv of data.conversations) {
            await api.createSession(conv).catch(() => {})
          }
          if (!restoreLast) data.activeId = null
          persistLocal()
          ctx.logger.info(`已把 ${data.conversations.length} 个本地会话迁移到后端`)
        } else if (server.length) {
          data = {
            conversations: server,
            activeId: restoreLast ? (server.some(c => c.id === data.activeId) ? data.activeId : server[0]?.id || null) : null,
          }
          persistLocal()
          ctx.emit('conversation:sync', { conversations: server })
        }
        source = 'server'
        lastSyncError = ''
        ctx.emit('sessions:source', service.status())
        ctx.logger.info(`会话已与后端同步（${server.length} 个）`)
      } catch (err) {
        source = 'local'
        lastSyncError = err.message
        ctx.emit('sessions:source', service.status())
        ctx.logger.warn(`后端不可用，会话暂存本地：${err.message}`)
      }
    }
    boot()
  }

  ctx.logger.debug(`会话服务就绪（${data.conversations.length} 个会话 · ${source}）`)
}
