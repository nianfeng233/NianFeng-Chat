/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
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
export const author = '念风内核'
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
  // 删除墓碑：删除请求没来得及写回后端就退出程序时，下次启动用它
  // 防止后端的旧会话把本地已删除的会话“复活”。
  if (!Array.isArray(data.removedIds)) data.removedIds = []
  // 「启动时恢复上次状态」默认关闭；关闭时启动后不自动选中上次的会话。
  if (!config.get('general.restore', false)) data.activeId = null

  let source = 'local'
  let lastSyncError = ''
  let syncing = false
  const pushTimers = new Map()
  const messagePushTimers = new Map()

  const messageCountOf = conv => {
    const explicit = Number(conv?.messageCount)
    const loaded = Array.isArray(conv?.messages) ? conv.messages.length : 0
    return Math.max(Number.isFinite(explicit) && explicit >= 0 ? explicit : 0, loaded)
  }
  const withoutMessages = conv => {
    if (!conv) return conv
    const { messages, ...meta } = conv
    meta.messageCount = messageCountOf(conv)
    return meta
  }

  /**
   * 本地 localStorage 只做「离线滚动缓存」：
   *   - 后端在线时，完整历史在 SQLite（chat.db），localStorage 不再保存全量消息；
   *   - 离线时保留每个会话最近 20 条，保证还能继续聊、界面不空。
   *
   * 流式输出会高频改动消息，这里做节流写盘；页面隐藏 / 卸载时强制 flush，
   * 既避免每个 chunk 都写一次 localStorage，又不会丢数据。
   */
  let persistTimer = null
  const writeLocalNow = () => {
    const conversations = data.conversations.map(conv => {
      const messages = Array.isArray(conv.messages) ? conv.messages : []
      // 离线兜底只保留最近 20 条；完整历史以 SQLite / 后端为准，避免 localStorage 走旧版爆掉。
      const keep = messages.slice(-20)
      return { ...conv, messages: keep, messageCount: messageCountOf(conv), localTruncated: messages.length > keep.length }
    })
    storage.set(NS, KEY, { conversations, activeId: data.activeId, removedIds: data.removedIds || [] })
  }
  const persistLocal = () => {
    if (typeof window !== 'undefined' && persistTimer) return
    if (typeof window === 'undefined') {
      writeLocalNow()
      return
    }
    persistTimer = setTimeout(() => {
      persistTimer = null
      writeLocalNow()
    }, 350)
  }
  const flushLocalNow = () => {
    if (persistTimer) {
      clearTimeout(persistTimer)
      persistTimer = null
    }
    writeLocalNow()
  }

  if (typeof window !== 'undefined') {
    const onVisibility = () => {
      if (document.hidden) flushLocalNow()
    }
    window.addEventListener('beforeunload', flushLocalNow)
    document.addEventListener('visibilitychange', onVisibility)
    ctx.effect(() => {
      window.removeEventListener('beforeunload', flushLocalNow)
      document.removeEventListener('visibilitychange', onVisibility)
      flushLocalNow()
    })
  }
  const randomId = () => `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const find = id => data.conversations.find(c => c.id === id) || null
  const conversationRank = conv => [Number(conv?.updatedAt || conv?.createdAt || 0) || 0, messageCountOf(conv)]
  /** 判断 a 是否比 b 新（时间相同则消息更多的更新，全部相同则不算更新） */
  const isNewerConversation = (a, b) => {
    const [at, am] = conversationRank(a)
    const [bt, bm] = conversationRank(b)
    return at > bt || (at === bt && am > bm)
  }

  /**
   * 后端会话与本地会话合并：
   *   - 删除墓碑中的 id 不参与合并（避免已删除会话复活）
   *   - 同一 id 取 updatedAt 更新 / 消息更多的一份
   *   - 本地独有的会话保留，等待写回后端
   */
  const mergeServerConversations = (serverList = []) => {
    const all = (serverList || []).filter(conv => conv?.id)
    const tombstones = new Set(data.removedIds || [])
    const serverById = new Map(all.map(conv => [conv.id, conv]))
    const serverKept = all.filter(conv => !tombstones.has(conv.id))
    const localKept = data.conversations.filter(conv => !tombstones.has(conv.id))
    const merged = new Map()
    for (const localConv of localKept) {
      const remote = serverById.get(localConv.id)
      merged.set(localConv.id, !remote || isNewerConversation(localConv, remote) ? localConv : remote)
    }
    for (const remote of serverKept) if (!merged.has(remote.id)) merged.set(remote.id, remote)
    const conversations = [...merged.values()].sort(
      (a, b) => Number(b?.updatedAt || b?.createdAt || 0) - Number(a?.updatedAt || a?.createdAt || 0),
    )
    return {
      conversations,
      serverById,
      removedIds: [...tombstones].filter(id => serverById.has(id)),
    }
  }

  /** 后端已关闭 / 离线时的请求失败不值得刷警告，页面会在重连后自动补写。 */
  const isTransientSyncError = err =>
    err?.status === 404 || /fetch failed|Failed to fetch|NetworkError|ECONNREFUSED|连接|离线/i.test(String(err?.message || err || ''))

  /** 消息级写回：SQLite 后端每条消息独立 upsert，不再重写整个会话。 */
  const scheduleMessagePush = (conversationId, message, delay = 220) => {
    if (source !== 'server' || !api || !conversationId || !message?.id) return
    const key = `${conversationId}:${message.id}`
    const pending = messagePushTimers.get(key) || { timer: null }
    if (pending.timer) clearTimeout(pending.timer)
    pending.timer = setTimeout(() => {
      pending.timer = null
      const current = find(conversationId)
      const latest = current?.messages?.find(item => item.id === message.id)
      if (!latest || source !== 'server' || !api) return
      api.addMessage(conversationId, latest).catch(err => { if (!isTransientSyncError(err)) ctx.logger.warn(`消息写回失败：${err.message}`) })
    }, delay)
    messagePushTimers.set(key, pending)
  }

  const flushMessagePush = conversationId => {
    for (const [key, pending] of [...messagePushTimers.entries()]) {
      if (!key.startsWith(`${conversationId}:`)) continue
      if (pending.timer) clearTimeout(pending.timer)
      messagePushTimers.delete(key)
    }
  }

  /**
   * 离线重连后的补写：
   *   - 本地只有截断缓存（localStorage 最近 20 条）时，只对本地消息逐条 upsert，
   *     绝不能用截断列表 replace，否则会把后端完整历史覆盖掉；
   *   - 本地内存里有完整消息且确认比后端新时，才整段 replace。
   */
  const pushFullMessagesIfNeeded = async (conv, remote) => {
    if (!api || !conv || !Array.isArray(conv.messages) || !conv.messages.length) return
    if (remote && conv.localTruncated === true) {
      for (const message of conv.messages) {
        await api.addMessage(conv.id, message).catch(() => {})
      }
      return
    }
    const remoteCount = remote ? Number(remote.messageCount ?? remote.messages?.length ?? 0) : 0
    if (remote && remoteCount === conv.messages.length && !isNewerConversation(conv, remote)) return
    await api.replaceMessages(conv.id, conv.messages).catch(() => {})
  }

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
      data.removedIds = (data.removedIds || []).filter(removedId => removedId !== conversation.id)
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
        const server = (payload.conversations || []).filter(conv => conv?.id)
        const { conversations, serverById, removedIds } = mergeServerConversations(server)
        const activeId = conversations.some(conv => conv.id === data.activeId) ? data.activeId : conversations[0]?.id || null
        data = { conversations, activeId, removedIds }
        source = 'server'
        persistLocal()

        // 手动同步同样只推差异，不丢弃本地独有的新会话 / 未写回修改。
        // 消息本体按会话批量补写，元数据只发送 withoutMessages(conv)，避免大 JSON。
        const queue = []
        for (const conv of conversations) {
          const remote = serverById.get(conv.id)
          if (!remote) {
            queue.push(
              (async () => {
                await api.createSession(withoutMessages(conv))
                if (Array.isArray(conv.messages) && conv.messages.length) await api.replaceMessages(conv.id, conv.messages)
              })(),
            )
          } else {
            if (isNewerConversation(conv, remote)) queue.push(api.saveSession(withoutMessages(conv)))
            await pushFullMessagesIfNeeded(conv, remote)
          }
        }
        for (const id of removedIds) queue.push(api.deleteSession(id))
        if (queue.length) await Promise.allSettled(queue)

        source = 'server'
        lastSyncError = ''
        ctx.emit('sessions:synced', { source, count: conversations.length })
        ctx.emit('conversation:sync', { conversations })
        return { ok: true, count: conversations.length }
      } catch (err) {
        source = 'local'
        lastSyncError = err.message
        persistLocal()
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
      data.removedIds = data.removedIds.filter(removedId => removedId !== conv.id)
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
      flushMessagePush(id)
      data.removedIds = [...new Set([...(data.removedIds || []), id])].slice(-500)
      persistLocal()
      if (source === 'server' && api) api.deleteSession(id).catch(err => { if (!isTransientSyncError(err)) ctx.logger.warn(`删除后端会话失败：${err.message}`) })
      ctx.emit('conversation:delete', { id, conversation: conv })
      return true
    },

    update(id, patch, { push = true } = {}) {
      const conv = find(id)
      if (!conv) return null
      let replacedMessages = false
      if (Array.isArray(patch.messages)) {
        conv.messages = patch.messages
        conv.messageCount = patch.messages.length
        replacedMessages = true
        if (source === 'server' && api) api.replaceMessages(conv.id, patch.messages).catch(err => { if (!isTransientSyncError(err)) ctx.logger.warn(`整段聊天记录写回失败：${err.message}`) })
      }
      const metaPatch = { ...patch }
      delete metaPatch.messages
      Object.assign(conv, metaPatch)
      conv.updatedAt = patch.updatedAt || Date.now()
      persistLocal()
      if (push && !replacedMessages) service.push(conv)
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
      if (!Array.isArray(conv.messages)) conv.messages = []
      conv.messages.push(message)
      conv.messageCount = conv.messages.length
      if (message.kind !== 'divider') {
        conv.preview = String(message.content || '').replace(/\n/g, ' ').slice(0, 80)
        conv.updatedAt = Date.now()
        conv.time = message.time || conv.time
      }
      persistLocal()
      scheduleMessagePush(id, message)
      return message
    },

    updateMessage(id, messageId, patch) {
      const message = service.message(id, messageId)
      if (!message) return null
      Object.assign(message, patch)
      const conv = find(id)
      if (conv) conv.updatedAt = Date.now()
      persistLocal()
      scheduleMessagePush(id, message)
      return message
    },

    removeMessage(id, messageId) {
      const conv = find(id)
      if (!conv) return false
      const index = conv.messages.findIndex(msg => msg.id === messageId)
      if (index < 0) return false
      conv.messages.splice(index, 1)
      conv.messageCount = conv.messages.length
      conv.updatedAt = Date.now()
      persistLocal()
      if (source === 'server' && api) {
        api.removeMessage(id, messageId).catch(err => {
          // 流式占位消息可能只在前端存在，后端 404 属于正常情况。
          if (err?.status !== 404) ctx.logger.warn(`删除后端消息失败：${err.message}`)
        })
      }
      return true
    },

    replaceMessages(id, messages = []) {
      const conv = find(id)
      if (!conv) return null
      conv.messages = Array.isArray(messages) ? messages : []
      conv.messageCount = conv.messages.length
      conv.updatedAt = Date.now()
      persistLocal()
      if (source === 'server' && api) api.replaceMessages(id, conv.messages).catch(err => { if (!isTransientSyncError(err)) ctx.logger.warn(`替换后端聊天记录失败：${err.message}`) })
      ctx.emit('conversation:update', conv)
      return conv
    },

    clearMessages(id) {
      const conv = find(id)
      if (!conv) return
      conv.messages = []
      conv.messageCount = 0
      conv.updatedAt = Date.now()
      persistLocal()
      if (source === 'server' && api) api.clearMessages(id).catch(err => { if (!isTransientSyncError(err)) ctx.logger.warn(`清空后端聊天记录失败：${err.message}`) })
      ctx.emit('conversation:update', conv)
    },

    /* -------- 与后端同步 -------- */
    pushCreate(conv) {
      if (source !== 'server' || !api) return
      api.createSession(withoutMessages(conv)).catch(err => { if (!isTransientSyncError(err)) ctx.logger.warn(`创建后端会话失败：${err.message}`) })
    },

    /** 防抖写回会话元数据（名称 / 预览 / meta）；消息本体走消息级 API，不再发送整个 messages。 */
    push(conv) {
      if (source !== 'server' || !api || !conv) return
      const pending = pushTimers.get(conv.id) || { timer: null }
      if (pending.timer) clearTimeout(pending.timer)
      pending.timer = setTimeout(() => {
        pending.timer = null
        const current = find(conv.id)
        if (!current || source !== 'server' || !api) return
        api.saveSession(withoutMessages(current)).catch(err => {
          lastSyncError = err.message
          ctx.emit('sessions:source', service.status())
          if (!isTransientSyncError(err)) ctx.logger.warn(`会话写回失败：${err.message}`)
        })
      }, 500)
      pushTimers.set(conv.id, pending)
    },

    stats() {
      const messages = data.conversations.reduce((sum, c) => sum + c.messages.length, 0)
      return { conversations: data.conversations.length, messages, source, error: lastSyncError }
    },

    reset() {
      data = { conversations: [], activeId: null, removedIds: [] }
      storage.remove(NS, KEY)
      ctx.emit('conversation:reset', null)
      ctx.emit('conversation:sync', { conversations: [] })
    },
  }

  ctx.effect(() => {
    for (const { timer } of pushTimers.values()) if (timer) clearTimeout(timer)
    pushTimers.clear()
    for (const { timer } of messagePushTimers.values()) if (timer) clearTimeout(timer)
    messagePushTimers.clear()
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
        const server = (payload.conversations || []).filter(conv => conv?.id)
        const { conversations, serverById, removedIds } = mergeServerConversations(server)
        const restoreLast = config.get('general.restore', false)
        const isNormalSession = conv => conv && conv.meta?.hiddenFromSessionList !== true && conv.meta?.channelConversation !== true
        const remembered = conversations.find(conv => conv.id === data.activeId)
        const activeId = restoreLast ? (isNormalSession(remembered) ? remembered.id : conversations.find(isNormalSession)?.id || null) : null
        data = { conversations, activeId, removedIds }
        source = 'server'
        persistLocal()
        ctx.emit('conversation:sync', { conversations })

        const queue = []
        for (const conv of conversations) {
          const remote = serverById.get(conv.id)
          if (!remote) {
            queue.push(
              (async () => {
                await api.createSession(withoutMessages(conv))
                if (Array.isArray(conv.messages) && conv.messages.length) await api.replaceMessages(conv.id, conv.messages)
              })(),
            )
          } else {
            if (isNewerConversation(conv, remote)) queue.push(api.saveSession(withoutMessages(conv)))
            await pushFullMessagesIfNeeded(conv, remote)
          }
        }
        for (const id of removedIds) queue.push(api.deleteSession(id))
        if (queue.length) await Promise.allSettled(queue)

        lastSyncError = ''
        ctx.emit('sessions:source', service.status())
        ctx.logger.info(`会话已与后端同步（${server.length} 个，合并后 ${conversations.length} 个）`)
      } catch (err) {
        source = 'local'
        lastSyncError = err.message
        persistLocal()
        ctx.emit('sessions:source', service.status())
        ctx.logger.warn(`后端不可用，会话暂存本地：${err.message}`)
      }
    }
    boot()
  }

  ctx.logger.debug(`会话服务就绪（${data.conversations.length} 个会话 · ${source}）`)
}
