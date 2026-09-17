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
export const depends = {
  'config': '^1.0.0',
  'storage': '^1.0.0',
  'event-bus': '*',
}
export const optionalDepends = {
  'backend-client': '>=1.0.0',
}
export const inject = ['storage', 'config', 'event-bus', 'api?']
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
  const events = ctx.inject('event-bus')

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
  let syncRetryTimer = null
  let syncRetryCount = 0
  // 渠道插件在拿到后端会话列表前不要创建“同渠道新会话”，否则每次重启都会多出一个空容器。
  // 首次同步结束（成功或失败）后放行；没有后端时立即放行，走纯本地离线模式。
  let initialSyncSettled = !api
  let initialSyncResolved = false
  let markInitialSyncSettled = () => {}
  const initialSyncPromise = new Promise(resolve => {
    markInitialSyncSettled = () => {
      if (initialSyncResolved) return
      initialSyncResolved = true
      initialSyncSettled = true
      resolve()
    }
    if (initialSyncSettled) markInitialSyncSettled()
  })
  const pushTimers = new Map()
  const messagePushTimers = new Map()

  const messageCountOf = conv => {
    const explicit = Number(conv?.messageCount)
    const loaded = Array.isArray(conv?.messages) ? conv.messages.length : 0
    return Math.max(Number.isFinite(explicit) && explicit >= 0 ? explicit : 0, loaded)
  }
  /**
   * 会话对象上的内部懒加载字段，绝不能随 withoutMessages / 写盘发送给后端：
   *   - messagesComplete    内存里是否已包含完整原文
   *   - messagesLoading     正在请求分页（防重复请求）
   *   - pendingMessageIds   source=local 时新建、尚未写回后端的消息 id
   */
  const withoutMessages = conv => {
    if (!conv) return conv
    const { messages, localTruncated, messagesComplete, messagesLoading, pendingMessageIds, ...meta } = conv
    meta.messageCount = messageCountOf(conv)
    return meta
  }

  /** 消息稳定的合并标识：优先 message_id / id，其次 seq，最后退化为时间 + 角色 + 文本。 */
  const messageIdentity = message => {
    if (!message || typeof message !== 'object') return ''
    const id = String(message.message_id || message.id || '').trim()
    if (id) return `id:${id}`
    const seq = Number(message.seq)
    if (Number.isFinite(seq) && seq > 0) return `seq:${seq}`
    const at = Number(message.createdAt) || Date.parse(message.timestamp || '') || 0
    return `at:${at}:${String(message.role || '')}:${String(message.content || '').slice(0, 120)}`
  }

  const messageAtOf = message => {
    const createdAt = Number(message?.createdAt)
    if (Number.isFinite(createdAt) && createdAt > 0) return createdAt
    const parsed = Date.parse(message?.timestamp || '')
    return Number.isNaN(parsed) ? 0 : parsed
  }

  const maxSeqOf = list =>
    (Array.isArray(list) ? list : []).reduce((max, message) => Math.max(max, Number(message?.seq) || 0), 0)

  /** 渠道 seq 是权威顺序；没有 seq 的旧数据再按时间兜底。 */
  const sortConversationMessages = messages => {
    if (!Array.isArray(messages) || messages.length <= 1) return Array.isArray(messages) ? [...messages] : []
    return [...messages].sort((a, b) => {
      const sa = Number(a?.seq)
      const sb = Number(b?.seq)
      if (Number.isFinite(sa) && Number.isFinite(sb) && sa !== sb) return sa - sb
      const ta = messageAtOf(a)
      const tb = messageAtOf(b)
      if (ta !== tb) return ta - tb
      return String(messageIdentity(a)).localeCompare(String(messageIdentity(b)))
    })
  }

  /**
   * 合并本地缓存与后端消息。
   * 关键点：localStorage 只缓存最近 20 条，在线权威数据始终是后端 SQLite。
   * 不能整段二选一，否则本地截断缓存会在 updatedAt 较新时把后端全量历史“顶掉”。
   * 这里以某一侧为底稿做并集，并保留本地尚未写回的新消息。
   */
  const mergeMessageLists = (...lists) => {
    const seen = new Set()
    const messages = []
    for (const list of lists) {
      for (const message of Array.isArray(list) ? list : []) {
        const key = messageIdentity(message)
        if (key && seen.has(key)) continue
        if (key) seen.add(key)
        messages.push(message)
      }
    }
    return sortConversationMessages(messages)
  }

  const pendingMessagesOf = conv => {
    const ids = new Set((Array.isArray(conv?.pendingMessageIds) ? conv.pendingMessageIds : []).map(value => String(value || '')).filter(Boolean))
    if (!ids.size) return []
    return (Array.isArray(conv?.messages) ? conv.messages : []).filter(message => ids.has(String(message?.id || message?.message_id || '')))
  }

  /**
   * 合并本地缓存与后端会话。
   * compactRemote=true 表示后端只返回了元数据 / messageCount（分页接口未来会成为默认）：
   *   - 不能用本地滚动缓存补出假的 messageCount；
   *   - 本地已加载的一小段原文继续保留给离线兜底，等当前会话真正打开时再按页刷新；
   *   - source=local 时新建、尚未写回后端的 pending 消息永远不会被丢弃。
   */
  const mergeConversationMessages = (localConv, remoteConv, { compactRemote = false } = {}) => {
    const localMessages = Array.isArray(localConv?.messages) ? localConv.messages : []
    const remoteMessages = Array.isArray(remoteConv?.messages) ? remoteConv.messages : []
    if (compactRemote) {
      const remoteCount = Math.max(0, Number(remoteConv?.messageCount) || 0)
      const pending = pendingMessagesOf(localConv)
      if (!remoteCount && !pending.length) return { messages: [], messageCount: 0, localTruncated: false, messagesComplete: true }
      // 只有“已经完整加载过”的本地缓存才可以继续留用；滚动缓存里可能有上一版本的假消息，
      // 绝不能因为 localMessages.length <= remoteCount 就把它当成服务端原文保留。
      const cache =
        localConv?.messagesComplete === true && localMessages.length >= remoteCount && remoteCount > 0 ? localMessages : []
      const messages = mergeMessageLists(cache, pending)
      const messageCount = Math.max(remoteCount, messages.length)
      const localTruncated = messages.length < messageCount
      return { messages, messageCount, localTruncated, messagesComplete: !localTruncated }
    }
    // 后端只返回了元数据（compact / 分页接口）时，绝不能用本地滚动缓存整段覆盖。
    const remoteLooksMetadataOnly = !!remoteConv && remoteMessages.length === 0 && Number(remoteConv.messageCount) > 0
    const localTruncated =
      localConv?.localTruncated === true ||
      messageCountOf(localConv) > localMessages.length ||
      remoteLooksMetadataOnly ||
      // 本地消息比后端少，说明本地只是部分缓存 / 缺历史，不能作为 replace 的依据。
      localMessages.length < remoteMessages.length
    const useRemoteAsBase =
      !!remoteConv && (localTruncated || !isNewerConversation(localConv, remoteConv) || localMessages.length < remoteMessages.length)
    const base = useRemoteAsBase ? remoteMessages : localMessages
    const extra = useRemoteAsBase ? localMessages : remoteMessages
    const messages = mergeMessageLists(base, extra)
    return {
      messages,
      messageCount: messages.length,
      localTruncated,
      messagesComplete: !localTruncated && messages.length >= Number(remoteConv?.messageCount ?? messages.length),
    }
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
      // 判断截断必须看 messageCount，而不是当前数组长度：本地只剩 20 条但 messageCount=100 时，
      // 旧逻辑会误标为完整，下一次启动可能把截断缓存当成全量。
      const keep = messages.slice(-20)
      const total = messageCountOf(conv)
      return {
        ...conv,
        messages: keep,
        messageCount: total,
        localTruncated: total > keep.length,
        messagesComplete: keep.length >= total,
        messagesLoading: false,
        pendingMessageIds: Array.isArray(conv.pendingMessageIds) ? conv.pendingMessageIds : [],
      }
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
   * 元数据版本：消息写入只会刷新 updatedAt，而角色人格 / 模型这类 meta 改动
   * 会刷新 metaUpdatedAt。合并多端会话时必须按它对元数据做取舍，否则服务端代聊
   * 进程里“消息更新但 meta 还旧”的副本会一直压住用户在 WebUI 改的新模型，
   * 表现就是“切换角色模型后必须重启才生效”。
   */
  const shouldUseRemoteMeta = (localConv, remoteConv) => {
    const localMeta = Number(localConv?.metaUpdatedAt) || 0
    const remoteMeta = Number(remoteConv?.metaUpdatedAt) || 0
    // 显式元数据版本优先于带消息含义的 updatedAt：避免任一端的消息时间压住元数据修改。
    if (localMeta && remoteMeta) return remoteMeta >= localMeta
    if (localMeta) return false
    if (remoteMeta) return true
    return Number(remoteConv?.updatedAt || remoteConv?.createdAt || 0) >= Number(localConv?.updatedAt || localConv?.createdAt || 0)
  }
  const changedMetaPatch = (conv, patch) => {
    if (!conv || !patch || typeof patch !== 'object') return false
    for (const [key, value] of Object.entries(patch)) {
      if (key === 'messages' || key === 'updatedAt' || key === 'metaUpdatedAt' || key === 'localTruncated') continue
      try {
        if (JSON.stringify(value) !== JSON.stringify(conv[key])) return true
      } catch (_) {
        return true
      }
    }
    return false
  }

  /**
   * 后端会话与本地会话合并：
   *   - 删除墓碑中的 id 不参与合并（避免已删除会话复活）
   *   - 同一 id 的元数据取 updatedAt 更新的；消息记录做并集，本地截断缓存不能覆盖后端全量
   *   - 本地独有的会话保留，等待写回后端
   */
  /**
   * 同一个渠道（meta.channelId 稳定）出现多个会话容器时，只保留消息最多的一个：
   *   - 这是曾经“渠道里记录为 0、旧记录另起一个会话”的修复核心；
   *   - 选择消息多 / 较新的容器，并把其它容器的原文并进来；
   *   - 被合并掉的 id 交给 sync 删除后端，渠道插件之后用 findByChannelId 找到唯一容器。
   * 只处理外部渠道（nova:web 是每个角色唯一的普通会话，不参与去重）。
   */
  const dedupeChannelConversations = list => {
    const groups = new Map()
    const result = []
    const dedupedIds = []
    for (const conv of list) {
      const channelId = String(conv?.meta?.channelId || '')
      const key = channelId && !channelId.startsWith('nova:web:') ? channelId : ''
      if (!key) {
        result.push(conv)
        continue
      }
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(conv)
    }
    for (const items of groups.values()) {
      if (items.length <= 1) {
        result.push(items[0])
        continue
      }
      const canonical = items.reduce((best, item) => (messageCountOf(item) > messageCountOf(best) ? item : best), items[0])
      const messages = mergeMessageLists(...items.map(item => item.messages))
      const messageCount = Math.max(...items.map(messageCountOf), messages.length)
      const latest = items.reduce((best, item) => {
        const bestHasMessages = messageCountOf(best) > 0
        const itemHasMessages = messageCountOf(item) > 0
        if (bestHasMessages !== itemHasMessages) return itemHasMessages ? item : best
        return Number(item?.updatedAt || 0) > Number(best?.updatedAt || 0) ? item : best
      }, canonical)
      const complete = items.every(item => item?.messagesComplete === true || Array.isArray(item?.messages)) &&
        messages.length >= messageCount
      result.push({
        ...canonical,
        // 名称 / preview 取最近更新的容器，避免去重后回退到旧名字。
        name: latest?.name || canonical.name,
        preview: latest?.preview ?? canonical.preview,
        updatedAt: Math.max(...items.map(item => Number(item?.updatedAt || 0) || 0), Date.now()),
        messages,
        messageCount,
        lastSeq: Math.max(...items.map(item => Number(item?.lastSeq) || 0), maxSeqOf(messages)),
        localTruncated: !complete,
        messagesComplete: complete,
        pendingMessageIds: [...new Set(items.flatMap(item => item?.pendingMessageIds || []))],
      })
      for (const item of items) if (item.id !== canonical.id) dedupedIds.push(item.id)
    }
    return { conversations: result, dedupedIds }
  }

  const mergeServerConversations = (serverList = [], { compact = false } = {}) => {
    const all = (serverList || []).filter(conv => conv?.id)
    const tombstones = new Set(data.removedIds || [])
    const serverById = new Map(all.map(conv => [conv.id, conv]))
    const serverKept = all.filter(conv => !tombstones.has(conv.id))
    const localKept = data.conversations.filter(conv => !tombstones.has(conv.id))
    const merged = new Map()
    for (const localConv of localKept) {
      const remote = serverById.get(localConv.id)
      if (!remote) {
        merged.set(localConv.id, localConv)
        continue
      }
      const mergedMessages = mergeConversationMessages(localConv, remote, { compactRemote: compact })
      const metaSource = shouldUseRemoteMeta(localConv, remote) ? remote : localConv
      merged.set(localConv.id, {
        ...metaSource,
        messages: mergedMessages.messages,
        messageCount: mergedMessages.messageCount,
        // compact 远端带回来的 lastSeq 不能被“本地元数据更新”覆盖掉，否则 chat-store
        // 在消息未加载时会按 0 重新发号，导致新消息和旧记录撞 seq / 撞 id。
        lastSeq: Math.max(
          Number(localConv?.lastSeq) || 0,
          Number(remote?.lastSeq) || 0,
          maxSeqOf(mergedMessages.messages),
        ),
        updatedAt: Math.max(Number(localConv.updatedAt || 0) || 0, Number(remote.updatedAt || 0) || 0) || metaSource.updatedAt,
        // 保留“本地缓存原本是否只有一部分”的标记，供写回时决定 replace 还是逐条 upsert；
        // withoutMessages / 写盘都会剥掉这些内部字段，不会污染后端。
        localTruncated: mergedMessages.localTruncated,
        messagesComplete: mergedMessages.messagesComplete,
        pendingMessageIds: Array.isArray(localConv.pendingMessageIds) ? localConv.pendingMessageIds : [],
      })
    }
    for (const remote of serverKept) {
      if (merged.has(remote.id)) continue
      const remoteMessages = Array.isArray(remote.messages) ? remote.messages : []
      const remoteCount = Math.max(Number(remote.messageCount) || 0, remoteMessages.length)
      const complete = remoteMessages.length >= remoteCount
      merged.set(remote.id, {
        ...remote,
        messages: remoteMessages,
        messageCount: remoteCount,
        lastSeq: Math.max(Number(remote?.lastSeq) || 0, maxSeqOf(remoteMessages)),
        localTruncated: !complete,
        messagesComplete: complete,
        pendingMessageIds: [],
      })
    }
    const { conversations, dedupedIds } = dedupeChannelConversations([...merged.values()])
    conversations.sort((a, b) => Number(b?.updatedAt || b?.createdAt || 0) - Number(a?.updatedAt || a?.createdAt || 0))
    return {
      conversations,
      serverById,
      dedupedIds,
      removedIds: [...tombstones].filter(id => serverById.has(id)),
    }
  }

  /** 后端已关闭 / 离线时的请求失败不值得刷警告，页面会在重连后自动补写。 */
  const isTransientSyncError = err =>
    err?.status === 404 ||
    err?.name === 'AbortError' ||
    /aborted|The user aborted|fetch failed|Failed to fetch|NetworkError|ECONNREFUSED|连接|离线|timeout|超时/i.test(String(err?.message || err || ''))

  const clearSyncRetry = () => {
    if (syncRetryTimer) {
      clearTimeout(syncRetryTimer)
      syncRetryTimer = null
    }
  }

  /** 同步遇到网络抖动 / 页面刷新导致的 abort 时自动退避重试，避免永久停在 local。 */
  const scheduleSyncRetry = () => {
    if (syncRetryTimer) return
    if (!api || typeof api.sessions !== 'function') return
    const delay = Math.min(30_000, 2000 * 2 ** Math.min(syncRetryCount, 4))
    syncRetryCount += 1
    syncRetryTimer = setTimeout(() => {
      syncRetryTimer = null
      service.sync().catch(() => {})
    }, delay)
    syncRetryTimer.unref?.()
  }

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
      api
        .addMessage(conversationId, latest)
        .then(() => {
          const current = find(conversationId)
          if (!current) return
          const id = String(latest.id || latest.message_id || '')
          current.pendingMessageIds = (current.pendingMessageIds || []).filter(value => String(value) !== id)
          if (current.pendingMessageIds.length === 0) delete current.pendingMessageIds
        })
        .catch(err => { if (!isTransientSyncError(err)) ctx.logger.warn(`消息写回失败：${err.message}`) })
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
   *   - 本地原本只有截断缓存（localStorage 最近 20 条）时，只对后端没有的本地消息逐条 upsert，
   *     绝不能用截断列表 replace，否则会把后端完整历史覆盖掉；
   *   - 本地内存里有完整消息且确认比后端新时，才整段 replace。此时的 conv.messages 已经过
   *     mergeServerConversations 做并集，包含后端全量，因此不会造成截断。
   */
  const pushFullMessagesIfNeeded = async (conv, remote) => {
    if (!api || !conv || !Array.isArray(conv.messages) || !conv.messages.length) return
    const remoteMessages = Array.isArray(remote?.messages) ? remote.messages : []
    if (remote && conv.localTruncated === true) {
      const remoteKeys = new Set(remoteMessages.map(messageIdentity))
      for (const message of conv.messages) {
        const key = messageIdentity(message)
        if (key && remoteKeys.has(key)) continue
        await api.addMessage(conv.id, message).catch(() => {})
      }
      return
    }
    const remoteCount = remote ? Number(remote.messageCount ?? remoteMessages.length ?? 0) : 0
    if (remote && remoteCount === conv.messages.length && !isNewerConversation(conv, remote)) return
    await api.replaceMessages(conv.id, conv.messages).catch(() => {})
  }

  /**
   * 离线重连后只补写“本地新增 / 本地改动”的消息；compact 元数据下不再把整段滚动缓存
   * replace 回后端，最多逐条 upsert 本地缓存（20 条以内），不会覆盖后端历史。
   */
  const pushLocalMessages = async (conv, { all = false } = {}) => {
    if (!api || !conv || !Array.isArray(conv.messages) || !conv.messages.length) return
    const pendingIds = new Set((Array.isArray(conv.pendingMessageIds) ? conv.pendingMessageIds : []).map(value => String(value || '')))
    const targets = all
      ? conv.messages
      : conv.messages.filter(message => pendingIds.has(String(message?.id || message?.message_id || '')))
    for (const message of targets) {
      const id = String(message?.id || message?.message_id || '')
      if (!id) continue
      await api.addMessage(conv.id, message).catch(err => {
        if (!isTransientSyncError(err)) ctx.logger.warn(`离线消息补写失败：${err.message}`)
        throw err
      })
      conv.pendingMessageIds = (conv.pendingMessageIds || []).filter(value => String(value) !== id)
    }
    if (Array.isArray(conv.pendingMessageIds) && !conv.pendingMessageIds.length) conv.pendingMessageIds = []
  }

  const service = {
    name: 'session-service',

    /* -------- 数据来源 -------- */
    source: () => source,
    status: () => ({ source, error: lastSyncError, syncing, conversations: data.conversations.length }),

    /** 用后端数据插入/替换（渠道入站消息等场景） */
    adopt(conversation, { activate = false } = {}) {
      if (!conversation?.id) return null
      const messages = Array.isArray(conversation.messages) ? conversation.messages : []
      const total = messageCountOf({ ...conversation, messages })
      conversation = {
        ...conversation,
        messages,
        messageCount: total,
        lastSeq: Math.max(Number(conversation.lastSeq) || 0, maxSeqOf(messages)),
        localTruncated: messages.length < total,
        messagesComplete: messages.length >= total,
        pendingMessageIds: Array.isArray(conversation.pendingMessageIds) ? conversation.pendingMessageIds : [],
      }
      const index = data.conversations.findIndex(c => c.id === conversation.id)
      if (index >= 0) data.conversations[index] = conversation
      else data.conversations.unshift(conversation)
      data.removedIds = (data.removedIds || []).filter(removedId => removedId !== conversation.id)
      persistLocal()
      ctx.emit('conversation:update', conversation)
      if (activate) service.activate(conversation.id)
      return conversation
    },

    /**
     * 手动 / 启动后的整体同步。
     * 会话列表默认只拉 compact 元数据（名称 / preview / messageCount，不含 messages），
     * 当前打开页面的消息由 loadMessages / loadAllMessages 按需分页拉取。
     */
    async sync() {
      if (!api) throw new Error('后端未连接')
      if (syncing) throw new Error('正在同步中')
      const wasLocal = source !== 'server'
      syncing = true
      try {
        const payload = await api.sessions({ compact: true })
        const compact = payload?.compact === true
        const server = (payload.conversations || []).filter(conv => conv?.id)
        const { conversations, serverById, removedIds, dedupedIds = [] } = mergeServerConversations(server, { compact })
        const activeId = conversations.some(conv => conv.id === data.activeId) ? data.activeId : conversations[0]?.id || null
        data = { conversations, activeId, removedIds }
        source = 'server'
        persistLocal()

        // 只推本地独有新会话 / 元数据变化 / 未写回消息；消息正文永远不整段重发。
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
            // 本地元数据（角色模型 / 人格）比后端新时必须写回，不能只按 updatedAt 判断，
            // 否则“离线改完角色后恢复联网，服务端还在用旧模型”这一路径仍会残留。
            if (!shouldUseRemoteMeta(conv, remote) || isNewerConversation(conv, remote)) {
              queue.push(api.saveSession(withoutMessages(conv)))
            }
            // 只补真正待写回的消息；滚动缓存（可能是服务端旧页 / 假消息）绝不能 upload 回后端。
            queue.push(pushLocalMessages(conv, { all: false }).catch(() => {}))
          }
        }
        void dedupedIds
        void wasLocal
        for (const id of removedIds) queue.push(api.deleteSession(id).catch(() => {}))
        if (queue.length) await Promise.allSettled(queue)

        lastSyncError = ''
        clearSyncRetry()
        syncRetryCount = 0
        markInitialSyncSettled()
        persistLocal()
        ctx.emit('sessions:synced', { source, count: conversations.length })
        ctx.emit('conversation:sync', { conversations })
        return { ok: true, count: conversations.length }
      } catch (err) {
        source = 'local'
        lastSyncError = err.message
        persistLocal()
        ctx.emit('sessions:source', service.status())
        if (isTransientSyncError(err)) scheduleSyncRetry()
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
    /** 首次后端同步是否已经结束（渠道插件用它避免在空本地缓存上抢先建会话）。 */
    ready: () => initialSyncPromise,
    isInitialSyncSettled: () => initialSyncSettled,

    /**
     * 按稳定渠道 ID 查找已有会话容器；多个重复时优先消息最多的那个。
     * 渠道插件应先调用它，再决定是否 create，避免再次产生空容器。
     */
    findByChannelId(channelId) {
      const key = String(channelId || '').trim()
      if (!key) return null
      const matches = data.conversations.filter(conv => String(conv?.meta?.channelId || '') === key)
      if (!matches.length) return null
      return matches.reduce((best, item) => (messageCountOf(item) > messageCountOf(best) ? item : best), matches[0])
    },

    /** 渠道容器安全创建：首次同步结束后先按 channelId 找旧的，找不到才建新会话。 */
    async ensureChannelConversation(channelId, partial = {}) {
      const key = String(channelId || '').trim()
      if (!key) return null
      if (initialSyncSettled) {
        const existing = service.findByChannelId(key) || (partial?.conversationId ? find(partial.conversationId) : null)
        if (existing) {
          service.update(existing.id, {
            meta: { ...(existing.meta || {}), ...(partial?.meta || {}), channelId: key },
          })
          return existing
        }
        return service.create(partial)
      }
      // 同步最多等一小段；即便失败（后端离线）也继续走本地创建，保证离线可用。
      await Promise.race([initialSyncPromise, new Promise(resolve => setTimeout(resolve, 8000))])
      const existing = service.findByChannelId(key) || (partial?.conversationId ? find(partial.conversationId) : null)
      if (existing) return existing
      return service.create(partial)
    },

    messageCount(id) {
      const conv = find(id)
      return conv ? messageCountOf(conv) : 0
    },

    /**
     * 分页拉取消息（不传 beforeSeq 取最新一页）。
     * 返回当前页，同时把一页消息合并进会话内存缓存；UI 向上翻页传 beforeSeq=当前最早 seq。
     */
    async loadMessages(id, { limit = 20, beforeSeq = null, force = false } = {}) {
      const conv = find(id)
      if (!conv) return null
      const size = Math.max(1, Math.min(500, Math.floor(Number(limit) || 20)))
      if (!api || source !== 'server') {
        return { conversation: conv, messages: [], ...service.localPage(conv, { limit: size, beforeSeq }) }
      }
      if (!force && !beforeSeq && conv.messagesComplete === true && conv.messages.length) {
        const local = service.localPage(conv, { limit: size, beforeSeq })
        return { conversation: conv, ...local, hasMoreBefore: false }
      }
      if (conv.messagesLoading && !force) return null
      conv.messagesLoading = true
      try {
        const page = await api.sessionMessages(id, beforeSeq ? { limit: size, beforeSeq } : { limit: size })
        const incoming = Array.isArray(page?.messages) ? page.messages : []
        const pending = pendingMessagesOf(conv)
        if (beforeSeq) conv.messages = mergeMessageLists(conv.messages, incoming)
        else conv.messages = mergeMessageLists(incoming, pending)
        const total = Math.max(Number(page?.messageCount) || 0, conv.messages.length)
        conv.messageCount = total
        conv.lastSeq = Math.max(Number(conv.lastSeq) || 0, maxSeqOf(conv.messages))
        conv.localTruncated = conv.messages.length < total
        conv.messagesComplete = page?.hasMoreBefore !== true && conv.messages.length >= total
        persistLocal()
        ctx.emit('conversation:update', conv)
        return {
          conversation: conv,
          conversationId: id,
          messages: incoming,
          messageCount: total,
          total,
          hasMoreBefore: page?.hasMoreBefore === true,
          hasMoreAfter: page?.hasMoreAfter === true,
          oldestSeq: incoming.length ? Number(incoming[0]?.seq) || null : null,
          newestSeq: incoming.length ? Number(incoming[incoming.length - 1]?.seq) || null : null,
        }
      } finally {
        conv.messagesLoading = false
        persistLocal()
      }
    },

    /** 显式全量加载：导出 / 搜索 / 保存 JSON 编辑器等确实需要完整历史的场景。 */
    async loadAllMessages(id) {
      const conv = find(id)
      if (!conv) return null
      if (!api || source !== 'server') {
        const messages = conv.messages || []
        return { conversation: conv, messages, messageCount: messages.length, total: messages.length, hasMoreBefore: false, hasMoreAfter: false }
      }
      const page = api.allMessages ? await api.allMessages(id) : await api.sessionMessages(id, { all: true })
      const messages = Array.isArray(page?.messages) ? page.messages : []
      conv.messages = messages
      conv.messageCount = messages.length
      conv.lastSeq = Math.max(Number(conv.lastSeq) || 0, maxSeqOf(messages))
      conv.localTruncated = false
      conv.messagesComplete = true
      persistLocal()
      ctx.emit('conversation:update', conv)
      return { conversation: conv, messages, messageCount: messages.length, total: messages.length, hasMoreBefore: false, hasMoreAfter: false }
    },

    /**
     * 确保当前会话至少有 limit 条最近消息已加载；不完整时才走网络。
     * chat-flow / 导出 / 记忆概括在需要近期原文前调用它，避免分页优化把上下文打空。
     */
    async ensureMessages(id, { limit = 20, all = false } = {}) {
      const conv = find(id)
      if (!conv) return null
      if (!initialSyncSettled) await service.ready()
      if (all) return service.loadAllMessages(id)
      const total = messageCountOf(conv)
      if (total <= 0) return conv
      const need = Math.max(1, Math.min(total, Math.floor(Number(limit) || 20)))
      if (conv.messagesComplete === true || (Array.isArray(conv.messages) && conv.messages.length >= need)) return conv
      return service.loadMessages(id, { limit: need, force: true })
    },

    /** 本地无网络时按数组切片模拟分页，保证 UI 代码路径一致。 */
    localPage(conv, { limit = 20, beforeSeq = null } = {}) {
      const list = sortConversationMessages(conv?.messages || [])
      if (beforeSeq !== null && beforeSeq !== undefined && beforeSeq !== '') {
        const before = list.filter(message => (Number(message?.seq) || 0) < Number(beforeSeq))
        const messages = before.slice(-limit)
        return { messages, total: list.length, messageCount: list.length, hasMoreBefore: before.length > messages.length, hasMoreAfter: false }
      }
      const messages = list.slice(-limit)
      return { messages, total: list.length, messageCount: list.length, hasMoreBefore: list.length > messages.length, hasMoreAfter: false }
    },

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
      // 打开会话时补一页最近原文（异步、失败不影响切换），保证首轮上下文不空。
      if (next && typeof service.ensureMessages === 'function') service.ensureMessages(next, { limit: 40 }).catch(() => {})
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
        metaUpdatedAt: Date.now(),
        messages: partial.messages || [],
        messageCount: Array.isArray(partial.messages) ? partial.messages.length : Number(partial.messageCount) || 0,
        messagesComplete: true,
        localTruncated: false,
        pendingMessageIds: [],
        meta: partial.meta || {},
      }
      data.conversations.unshift(conv)
      data.removedIds = data.removedIds.filter(removedId => removedId !== conv.id)
      persistLocal()
      service.pushCreate(conv)
      ctx.emit('conversation:create', conv)
      return conv
    },

    remove(id, { remote = true } = {}) {
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
      if (remote && source === 'server' && api) {
        api.deleteSession(id).catch(err => { if (!isTransientSyncError(err)) ctx.logger.warn(`删除后端会话失败：${err.message}`) })
      }
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
        conv.messagesComplete = true
        conv.localTruncated = false
        conv.pendingMessageIds = []
        replacedMessages = true
        if (source === 'server' && api) api.replaceMessages(conv.id, patch.messages).catch(err => { if (!isTransientSyncError(err)) ctx.logger.warn(`整段聊天记录写回失败：${err.message}`) })
      }
      const metaPatch = { ...patch }
      delete metaPatch.messages
      if (changedMetaPatch(conv, metaPatch) && metaPatch.metaUpdatedAt === undefined) metaPatch.metaUpdatedAt = Date.now()
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
      const total = messageCountOf(conv)
      conv.messages.push(message)
      // 分页加载后本地只有最近一页，计数必须用 max/总数，不能让 push 后的数组长度把 messageCount 改小。
      conv.messageCount = Math.max(total, conv.messages.length)
      conv.lastSeq = Math.max(Number(conv.lastSeq) || 0, Number(message?.seq) || 0)
      conv.messagesComplete = conv.messages.length >= conv.messageCount
      conv.localTruncated = conv.messages.length < conv.messageCount
      const messageId = String(message?.id || message?.message_id || '')
      if (messageId) {
        const pending = new Set(Array.isArray(conv.pendingMessageIds) ? conv.pendingMessageIds : [])
        pending.add(messageId)
        conv.pendingMessageIds = [...pending]
      }
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
      if (conv) {
        conv.updatedAt = Date.now()
        const pending = new Set(Array.isArray(conv.pendingMessageIds) ? conv.pendingMessageIds : [])
        if (message.id || message.message_id) pending.add(String(message.id || message.message_id))
        conv.pendingMessageIds = [...pending]
      }
      persistLocal()
      scheduleMessagePush(id, message)
      return message
    },

    removeMessage(id, messageId) {
      const conv = find(id)
      if (!conv) return false
      const index = conv.messages.findIndex(msg => msg.id === messageId)
      if (index < 0) return false
      const previousCount = messageCountOf(conv)
      conv.messages.splice(index, 1)
      conv.messageCount = Math.max(0, previousCount - 1)
      conv.messagesComplete = conv.messages.length >= conv.messageCount
      conv.localTruncated = conv.messages.length < conv.messageCount
      conv.pendingMessageIds = (conv.pendingMessageIds || []).filter(value => String(value) !== String(messageId))
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
      conv.lastSeq = Math.max(Number(conv.lastSeq) || 0, maxSeqOf(conv.messages))
      conv.messagesComplete = true
      conv.localTruncated = false
      conv.pendingMessageIds = []
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
      conv.messagesComplete = true
      conv.localTruncated = false
      conv.pendingMessageIds = []
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
        api
          .saveSession(withoutMessages(current))
          .then(saved => {
            // 服务端可能因 metaUpdatedAt 更旧而拒绝本次元数据写回（旧副本覆盖新模型），
            // 但响应里会带当前正确的会话。这里立刻把本地元数据拉回服务端版本，
            // 避免服务端代聊 Worker 错过 sessions/changed 时一直停留在旧模型。
            const latest = find(conv.id)
            if (!latest || !saved?.meta) return
            const remoteMetaAt = Number(saved.metaUpdatedAt) || 0
            const localMetaAt = Number(latest.metaUpdatedAt) || 0
            if (!remoteMetaAt || remoteMetaAt < localMetaAt) return
            const metaChanged = JSON.stringify(latest.meta || {}) !== JSON.stringify(saved.meta)
            const changed = metaChanged || Number(latest.metaUpdatedAt) !== Number(saved.metaUpdatedAt)
            latest.meta = saved.meta
            latest.metaUpdatedAt = Number(saved.metaUpdatedAt) || saved.metaUpdatedAt
            if (!changed) return
            persistLocal()
            ctx.emit('conversation:update', latest)
            if (metaChanged) {
              ctx.logger.info(
                `[session-service] 已同步服务端会话元数据：${latest.id} · 模型 ${latest.meta?.model || '跟随全局'}`,
              )
            }
          })
          .catch(err => {
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


  // 服务端常驻代聊写回消息时，后端会广播 agent=true 的 sessions/changed。
  // 浏览器端只负责刷新对应会话，不重复处理入站消息。
  let agentRefreshTimer = null
  let agentRefreshChannel = ''

  /**
   * 增量事件直接合并到本地会话，能省掉“写一条消息->全量 GET /api/sessions”的同步风暴。
   * 事件里没带消息体（图片过大等）或本地还没有这个会话时，再退回拉单个会话。
   */
  const applyRemoteMessageChange = (conversationId, message) => {
    const conv = find(conversationId)
    if (!conv || !message) return false
    const identity = messageIdentity(message)
    if (!identity) return false
    const list = Array.isArray(conv.messages) ? conv.messages : []
    const index = list.findIndex(item => messageIdentity(item) === identity)
    if (index >= 0) list[index] = { ...list[index], ...message }
    else list.push(message)
    conv.messages = sortConversationMessages(list)
    conv.messageCount = Math.max(Number(conv.messageCount) || 0, conv.messages.length)
    conv.updatedAt = Math.max(Number(conv.updatedAt) || 0, messageAtOf(message) || 0, Date.now())
    persistLocal()
    ctx.emit('conversation:update', conv)
    return true
  }

  const applyRemoteMessageRemove = (conversationId, messageId) => {
    const conv = find(conversationId)
    if (!conv || !messageId) return false
    const target = String(messageId)
    const before = Array.isArray(conv.messages) ? conv.messages.length : 0
    const messages = (conv.messages || []).filter(
      message => String(message.message_id || message.id || '') !== target && String(message.id || '') !== target,
    )
    if (messages.length === before) return false
    conv.messages = messages
    conv.messageCount = Math.max(0, (Number(conv.messageCount) || before) - 1)
    conv.updatedAt = Date.now()
    persistLocal()
    ctx.emit('conversation:update', conv)
    return true
  }

  const refreshConversationFromBackend = async conversationId => {
    if (!api || source !== 'server') return
    try {
      const remote = api.session
        ? (await api.session(conversationId, { compact: true }))?.conversation
        : (await api.sessions({ compact: true }))?.conversations?.find(conv => conv.id === conversationId)
      if (!remote) return
      const local = find(conversationId)
      let next = remote
      if (local) {
        const compactRemote = !Array.isArray(remote.messages) || remote.messages.length === 0
        const merged = mergeConversationMessages(local, remote, { compactRemote })
        next = {
          ...(shouldUseRemoteMeta(local, remote) ? remote : local),
          messages: merged.messages,
          messageCount: merged.messageCount,
          updatedAt: Math.max(Number(local.updatedAt || 0) || 0, Number(remote.updatedAt || 0) || 0) || remote.updatedAt,
          localTruncated: merged.localTruncated,
          messagesComplete: merged.messagesComplete,
          pendingMessageIds: local.pendingMessageIds,
        }
      }
      service.adopt(next)
      if (local) await service.loadMessages(conversationId, { limit: 20, force: true }).catch(() => {})
    } catch (err) {
      if (!isTransientSyncError(err)) ctx.logger.warn(`同步服务端代聊消息失败：${err.message}`)
    }
  }

  /** 合并短时间内的同一会话刷新请求，避免连续 update 事件重复 GET 并互相覆盖。 */
  const refreshRequests = new Map()
  const refreshConversationSoon = conversationId => {
    const key = String(conversationId || '')
    if (!key) return Promise.resolve()
    const pending = refreshRequests.get(key)
    if (pending) return pending
    const task = refreshConversationFromBackend(key)
      .catch(() => {})
      .finally(() => refreshRequests.delete(key))
    refreshRequests.set(key, task)
    return task
  }
  if (events) {
    ctx.effect(
      events.on('backend:event', payload => {
        const data = payload?.data || {}
        if (payload?.event !== 'sessions/changed' || !data.id) return
        const action = String(data.action || '')
        // 只处理“另一边”的写入：浏览器处理服务端代聊的消息，代聊 runtime 处理浏览器写回的消息。
        const fromAgent = data.agent === true
        if (globalThis.__NIANFENG_SERVER_AGENT__ === true ? fromAgent : !fromAgent) return
        // 另一侧删除了会话：本地同步删除即可，绝不能再调 DELETE API，否则两端会互相回环广播。
        if (action === 'remove') {
          service.remove(String(data.id), { remote: false })
          return
        }
        // 有增量消息体时直接合并，避免每写一条消息就 GET 整个会话 / 全部会话。
        if ((action === 'message' || action === 'message-update') && data.message) {
          if (applyRemoteMessageChange(String(data.id), data.message)) return
        } else if (action === 'message-remove' && data.messageId) {
          if (applyRemoteMessageRemove(String(data.id), data.messageId)) return
        }
        // 角色模型 / 人格属于低频但必须尽快生效的元数据：收到会话 update / create
        // 立即刷新，不再等 350ms 批量窗口，避免下一条渠道消息仍用旧模型。
        if (action === 'create' || action === 'update') {
          refreshConversationSoon(String(data.id))
          return
        }
        agentRefreshChannel = String(data.id)
        if (agentRefreshTimer) return
        agentRefreshTimer = setTimeout(() => {
          agentRefreshTimer = null
          const id = agentRefreshChannel
          agentRefreshChannel = ''
          refreshConversationSoon(id)
        }, 350)
      }),
    )
    ctx.effect(() => () => {
      if (agentRefreshTimer) clearTimeout(agentRefreshTimer)
      agentRefreshTimer = null
    })
  }

  ctx.effect(() => {
    clearSyncRetry()
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
      syncing = true
      try {
        const wasLocal = source !== 'server'
        const payload = await api.sessions({ compact: true })
        const compact = payload?.compact === true
        const server = (payload.conversations || []).filter(conv => conv?.id)
        const { conversations, serverById, removedIds, dedupedIds = [] } = mergeServerConversations(server, { compact })
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
            if (!shouldUseRemoteMeta(conv, remote) || isNewerConversation(conv, remote)) {
              queue.push(api.saveSession(withoutMessages(conv)))
            }
            queue.push(pushLocalMessages(conv, { all: false }).catch(() => {}))
          }
        }
        void dedupedIds
        void wasLocal
        for (const id of removedIds) queue.push(api.deleteSession(id).catch(() => {}))
        if (queue.length) await Promise.allSettled(queue)

        lastSyncError = ''
        ctx.logger.info(`会话已与后端同步（${server.length} 个，合并后 ${conversations.length} 个）`)
      } catch (err) {
        source = 'local'
        lastSyncError = err.message
        ctx.logger.warn(`后端不可用，会话暂存本地：${err.message}`)
      } finally {
        syncing = false
        markInitialSyncSettled()
        persistLocal()
        ctx.emit('sessions:source', service.status())
      }
    }
    boot()
  } else {
    markInitialSyncSettled()
  }

  // 后端从离线恢复时自动重新拉取一次；否则 session-service 会在 boot 失败后
  // 永远停在本地缓存，导致聊天记录页看不到后端/服务端代聊写入的新消息。
  const offBackendStatus = events.on('backend:status', status => {
    if (status?.online !== true || source === 'server' || syncing) return
    service.sync().catch(err => ctx.logger.debug?.(`后端恢复后自动同步失败：${err?.message || err}`))
  })
  ctx.effect(() => offBackendStatus)

  ctx.logger.debug(`会话服务就绪（${data.conversations.length} 个会话 · ${source}）`)
}
