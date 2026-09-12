/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * 后端 · sessions
 *
 * 存储分层（默认使用内置 SQLite）：
 *   - user_data/sessions.json：只保存会话元数据（名称 / 预览 / 渠道 meta / messageCount），
 *     保持旧接口与旧数据可读；文件不会随着聊天记录增长。
 *   - user_data/chat.db：聊天记录原文（每条消息一行 JSON），支持全量长期保存、按会话查询。
 *
 * 设计动机：
 *   - 旧版把所有消息塞进一个 sessions.json，每来一条消息就要重写整个文件，
 *     聊天记录越长越容易“爆”；SQLite 可以单条 O(1) 写入、按会话读取。
 *   - 对前端 API 保持兼容：list()/get() 仍返回带 messages 的完整会话对象，
 *     原有 UI / 插件无需改变展示方式；同时提供 listCompact() 供未来分页/懒加载使用。
 *   - 如果运行环境没有 node:sqlite（Node 20 等旧版本），自动回退到旧 JSON 行为，
 *     不会阻塞启动。
 */
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export const name = 'sessions'
export const inject = []

export function apply(ctx, config = {}) {
  let dataDir = config.dataDir || join(process.cwd(), 'user_data')
  let file = join(dataDir, 'sessions.json')
  let dbFile = join(dataDir, 'chat.db')
  let data = { conversations: [], updatedAt: 0 }
  let db = null
  let sqliteAvailable = false
  let saveTimer = null
  let metadataTimer = null

  const newId = () => `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const now = () => new Date().toISOString()
  const clone = value => (value === undefined ? value : structuredClone(value))

  const metaOf = conv => {
    if (!conv) return conv
    const { messages, ...meta } = conv
    meta.messageCount = Array.isArray(messages) ? messages.length : Number(meta.messageCount) || 0
    return meta
  }

  const compactSnapshot = () => ({
    version: 2,
    updatedAt: data.updatedAt,
    conversations: data.conversations.map(metaOf),
  })

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

  const writeJsonAtomic = async (target, payload) => {
    await mkdir(dirname(target), { recursive: true })
    const tmp = `${target}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8')
    await rename(tmp, target)
  }

  const persistMetadata = async () => {
    data.updatedAt = Date.now()
    await writeJsonAtomic(file, compactSnapshot())
  }

  const scheduleMetadataSave = () => {
    if (metadataTimer) return
    metadataTimer = setTimeout(() => {
      metadataTimer = null
      persistMetadata().catch(err => ctx.logger.error(`会话元数据保存失败：${err.message}`))
    }, 400)
  }

  /* ---------------- SQLite ---------------- */

  const openDatabase = async () => {
    if (db) return true
    try {
      const mod = await import('node:sqlite')
      if (typeof mod?.DatabaseSync !== 'function') return false
      db = new mod.DatabaseSync(dbFile)
      db.exec('PRAGMA journal_mode = WAL;')
      db.exec(`
        CREATE TABLE IF NOT EXISTS conversations (
          id TEXT PRIMARY KEY,
          data TEXT NOT NULL,
          created_at INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS messages (
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL,
          seq INTEGER NOT NULL DEFAULT 0,
          data TEXT NOT NULL,
          created_at INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_messages_conversation_seq ON messages(conversation_id, seq);
      `)
      sqliteAvailable = true
      return true
    } catch (err) {
      db = null
      sqliteAvailable = false
      ctx.logger.warn(`SQLite 不可用，聊天记录回退到 sessions.json：${err.message}`)
      return false
    }
  }

  const dbConversationCount = () => {
    try {
      return Number(db.prepare('SELECT COUNT(*) AS n FROM conversations').get()?.n || 0)
    } catch (_) {
      return 0
    }
  }

  const dbSaveConversationMeta = conv => {
    if (!db) return
    const meta = metaOf(conv)
    db.prepare(
      'INSERT INTO conversations(id, data, created_at, updated_at) VALUES(?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at',
    ).run(String(conv.id), JSON.stringify(meta), Number(conv.createdAt) || Date.now(), Number(conv.updatedAt) || Date.now())
  }

  const dbDeleteConversation = id => {
    if (!db) return
    db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(String(id))
    db.prepare('DELETE FROM conversations WHERE id = ?').run(String(id))
  }

  const dbLoadMessages = conversationId => {
    if (!db) return []
    try {
      return db
        .prepare('SELECT data FROM messages WHERE conversation_id = ? ORDER BY seq ASC, created_at ASC')
        .all(String(conversationId))
        .map(row => JSON.parse(row.data))
        .filter(Boolean)
    } catch (err) {
      ctx.logger.warn(`聊天记录读取失败：${err.message}`)
      return []
    }
  }

  const dbNextSeq = conversationId => {
    if (!db) return 0
    try {
      return Number(db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM messages WHERE conversation_id = ?').get(String(conversationId))?.seq || 0) + 1
    } catch (_) {
      return 0
    }
  }

  const dbUpsertMessage = (conversationId, message) => {
    if (!db) return
    let seq = Number.isFinite(Number(message.seq)) && Number(message.seq) > 0 ? Number(message.seq) : 0
    if (!seq) {
      try {
        seq = Number(db.prepare('SELECT seq FROM messages WHERE id = ?').get(String(message.id))?.seq || 0)
      } catch (_) {
        seq = 0
      }
    }
    if (!seq) seq = dbNextSeq(conversationId)
    const createdAt = Number(message.createdAt) || Date.now()
    db.prepare(
      'INSERT INTO messages(id, conversation_id, seq, data, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET conversation_id = excluded.conversation_id, seq = excluded.seq, data = excluded.data, updated_at = excluded.updated_at',
    ).run(String(message.id), String(conversationId), seq, JSON.stringify(message), createdAt, Date.now())
  }

  const dbRemoveMessage = (conversationId, messageId) => {
    if (!db) return
    db.prepare('DELETE FROM messages WHERE id = ? AND conversation_id = ?').run(String(messageId), String(conversationId))
  }

  const dbReplaceMessages = (conversationId, messages) => {
    if (!db) return
    db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(String(conversationId))
    const clean = Array.isArray(messages) ? messages : []
    let seq = 1
    for (const message of clean) {
      if (!message) continue
      const item = { ...message, id: message.id || `m${Date.now().toString(36)}${seq}`, seq: seq++ }
      item.createdAt = Number(item.createdAt) || Date.now()
      dbUpsertMessage(conversationId, item)
    }
  }

  const loadConversationFromDb = meta => {
    const conv = { ...meta, messages: dbLoadMessages(meta.id) }
    conv.messageCount = conv.messages.length
    return conv
  }

  const importLegacy = async legacy => {
    const conversations = Array.isArray(legacy?.conversations) ? legacy.conversations : []
    if (!conversations.length) return
    ctx.logger.info(`检测到旧版 sessions.json，正在迁移 ${conversations.length} 个会话到 SQLite…`)
    try {
      await writeJsonAtomic(`${file}.full.bak`, legacy)
    } catch (_) {
      /* 备份失败不影响迁移 */
    }
    for (const conv of conversations) {
      if (!conv?.id) continue
      dbSaveConversationMeta(conv)
      dbReplaceMessages(conv.id, Array.isArray(conv.messages) ? conv.messages : [])
    }
    await persistMetadata()
  }

  const load = async () => {
    await mkdir(dataDir, { recursive: true })
    const parsed = await readFrom(file)
    const opened = await openDatabase()
    if (!opened) {
      data = parsed || { conversations: [], updatedAt: 0 }
      ctx.logger.info(`会话数据已加载（JSON 回退模式）：${data.conversations.length} 个会话`)
      return
    }

    if (dbConversationCount() === 0 && parsed?.conversations?.length) {
      const hasFullMessages = parsed.conversations.some(conv => Array.isArray(conv.messages) && conv.messages.length > 0)
      if (hasFullMessages) {
        await importLegacy(parsed)
      } else {
        // 只有元数据（例如 chat.db 被手动删除）：保留会话列表，消息历史无法恢复。
        for (const conv of parsed.conversations) if (conv?.id) dbSaveConversationMeta({ ...conv, messages: [] })
        await persistMetadata()
      }
    }
    const rows = db.prepare('SELECT data FROM conversations ORDER BY updated_at DESC').all()
    data = {
      conversations: rows
        .map(row => {
          try {
            return loadConversationFromDb(JSON.parse(row.data))
          } catch (_) {
            return null
          }
        })
        .filter(Boolean),
      updatedAt: Date.now(),
    }
    await persistMetadata()
    ctx.logger.info(`会话数据已加载（SQLite 模式）：${data.conversations.length} 个会话 / ${service.totalMessages()} 条消息`)
  }

  /* ---------------- 旧 JSON 回退写盘 ---------------- */

  let flushChain = Promise.resolve()
  const legacyFlushNow = async () => {
    data.updatedAt = Date.now()
    await mkdir(dataDir, { recursive: true })
    await writeJsonAtomic(file, data)
  }
  const legacyFlush = () => {
    flushChain = flushChain.then(legacyFlushNow, legacyFlushNow)
    return flushChain
  }

  const scheduleSave = () => {
    if (sqliteAvailable || saveTimer) return
    saveTimer = setTimeout(() => {
      saveTimer = null
      legacyFlush().catch(err => ctx.logger.error(`会话保存失败：${err.message}`))
    }, 300)
  }

  /* ---------------- 会话写入 ---------------- */

  const touchConversation = (conv, message) => {
    if (message.kind === 'divider') return
    conv.preview = String(message.content || '').replace(/\s+/g, ' ').slice(0, 80)
    conv.updatedAt = Date.now()
    conv.time = message.time || conv.time
  }

  const afterConversationChange = conv => {
    if (sqliteAvailable) {
      dbSaveConversationMeta(conv)
      scheduleMetadataSave()
    } else {
      scheduleSave()
    }
  }

  const afterMessageChange = conv => {
    if (sqliteAvailable && conv) {
      dbSaveConversationMeta(conv)
      scheduleMetadataSave()
    } else {
      scheduleSave()
    }
  }

  /* ---------------- service ---------------- */

  const service = {
    get file() {
      return file
    },
    get dbFile() {
      return dbFile
    },
    get storageMode() {
      return sqliteAvailable ? 'sqlite' : 'json'
    },
    get dataDir() {
      return dataDir
    },

    async rehome(nextDir, { migrate = true } = {}) {
      await readyPromise
      if (saveTimer) {
        clearTimeout(saveTimer)
        saveTimer = null
      }
      if (metadataTimer) {
        clearTimeout(metadataTimer)
        metadataTimer = null
      }
      await persistMetadata().catch(() => {})
      if (!sqliteAvailable) await legacyFlush().catch(() => {})
      try {
        db?.close?.()
      } catch (_) {
        /* ignore */
      }
      db = null
      sqliteAvailable = false

      const previousData = data
      dataDir = nextDir
      file = join(dataDir, 'sessions.json')
      dbFile = join(dataDir, 'chat.db')
      await mkdir(dataDir, { recursive: true })

      const targetHasFile = await readFile(file, 'utf8').then(() => true).catch(() => false)
      const targetHasDb = await readFile(dbFile, 'utf8').then(() => true).catch(() => false)
      const shouldMigrate = migrate && !targetHasFile && !targetHasDb

      if (shouldMigrate) {
        const opened = await openDatabase()
        if (opened) {
          for (const conv of previousData.conversations) {
            dbSaveConversationMeta(conv)
            dbReplaceMessages(conv.id, conv.messages || [])
          }
          data = previousData
          await persistMetadata()
        } else {
          // JSON 回退模式：整体复制历史数据。
          data = previousData
          await writeJsonAtomic(file, data)
        }
      } else {
        await load()
      }
      ctx.logger.info(`会话目录已切换：${file}（${service.storageMode}）`)
      return { conversations: data.conversations.length, mode: service.storageMode }
    },

    list: () => data.conversations.map(clone),
    listCompact: () => data.conversations.map(metaOf).map(clone),

    get(id) {
      const conv = data.conversations.find(c => c.id === id)
      return conv ? clone(conv) : null
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
      if (sqliteAvailable && conv.messages.length) dbReplaceMessages(conv.id, conv.messages)
      afterConversationChange(conv)
      ctx.emit('sessions/changed', { id: conv.id, action: 'create' })
      return clone(conv)
    },

    update(id, patch = {}) {
      const conv = service.find(id)
      if (!conv) return null
      if (Array.isArray(patch.messages)) {
        conv.messages = patch.messages
        if (sqliteAvailable) dbReplaceMessages(conv.id, patch.messages)
        else scheduleSave()
      }
      const metaPatch = { ...patch }
      delete metaPatch.messages
      Object.assign(conv, metaPatch, { id: conv.id, updatedAt: Date.now() })
      afterConversationChange(conv)
      ctx.emit('sessions/changed', { id, action: 'update' })
      return clone(conv)
    },

    remove(id) {
      const index = data.conversations.findIndex(c => c.id === id)
      if (index < 0) return false
      data.conversations.splice(index, 1)
      if (sqliteAvailable) {
        dbDeleteConversation(id)
        scheduleMetadataSave()
      } else {
        scheduleSave()
      }
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
        ...message,
      }
      msg.id = message.id || msg.id
      const existingIndex = conv.messages.findIndex(item => item.id === msg.id)
      if (existingIndex >= 0) conv.messages[existingIndex] = msg
      else conv.messages.push(msg)
      touchConversation(conv, msg)
      if (sqliteAvailable) dbUpsertMessage(conv.id, msg)
      afterMessageChange(conv)
      scheduleSave()
      ctx.emit('sessions/changed', { id, action: 'message', message: clone(msg) })
      return clone(msg)
    },

    updateMessage(id, messageId, patch = {}) {
      const conv = service.find(id)
      const msg = conv?.messages.find(m => m.id === messageId)
      if (!msg) return null
      Object.assign(msg, patch, { id: messageId })
      conv.updatedAt = Date.now()
      if (sqliteAvailable) dbUpsertMessage(conv.id, msg)
      afterMessageChange(conv)
      scheduleSave()
      ctx.emit('sessions/changed', { id, action: 'message-update', message: clone(msg) })
      return clone(msg)
    },

    removeMessage(id, messageId) {
      const conv = service.find(id)
      if (!conv) return false
      const index = conv.messages.findIndex(m => m.id === messageId)
      if (index < 0) return false
      conv.messages.splice(index, 1)
      conv.updatedAt = Date.now()
      if (sqliteAvailable) dbRemoveMessage(conv.id, messageId)
      afterMessageChange(conv)
      scheduleSave()
      ctx.emit('sessions/changed', { id, action: 'message-remove', messageId })
      return true
    },

    replaceMessages(id, messages = []) {
      const conv = service.find(id)
      if (!conv) return null
      conv.messages = Array.isArray(messages) ? messages : []
      conv.updatedAt = Date.now()
      if (sqliteAvailable) dbReplaceMessages(conv.id, conv.messages)
      afterMessageChange(conv)
      scheduleSave()
      ctx.emit('sessions/changed', { id, action: 'messages-replace', count: conv.messages.length })
      return clone(conv)
    },

    clearMessages(id) {
      return service.replaceMessages(id, [])
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
      return conv ? clone(conv) : null
    },

    exportAll: () => data.conversations.map(clone),

    async flush() {
      if (saveTimer) {
        clearTimeout(saveTimer)
        saveTimer = null
      }
      if (metadataTimer) {
        clearTimeout(metadataTimer)
        metadataTimer = null
      }
      if (!sqliteAvailable) await legacyFlush()
      else await persistMetadata()
    },
  }

  const readyPromise = load().then(() => service)
  service.ready = () => readyPromise
  ctx.provide('sessions', service)
  ctx.effect(
    () => () => {
      if (saveTimer) clearTimeout(saveTimer)
      if (metadataTimer) clearTimeout(metadataTimer)
      try {
        db?.close?.()
      } catch (_) {
        /* ignore */
      }
    },
  )
}
