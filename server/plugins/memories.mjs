/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * 后端 · memories
 * 长期记忆库（参考 MemMachine 的 episodic memory 思路，按本项目的本地单机规模落地）：
 *   - 每 N 轮完整对话压缩成一段短概括；概括写入记忆库并做向量化；
 *   - 检索时做「向量语义 + BM25 关键词 + 时间过滤」的混合召回（RRF 融合）；
 *   - 每个角色一份长期记忆，不按渠道拆分；隐私渠道单独一个 memory_scope；
 *   - 存储优先使用 Node 内置 node:sqlite（Node 22.5+），旧 Node 自动回退 JSON 文件，
 *     对外接口与检索语义完全一致。
 *
 * 前端 domain/memory-store 负责在每轮结束后提交“逐步累积的完整轮次”，
 * 本插件负责去重、按每 N 轮切块、调用 LLM 概括、调用 embedding 模型向量化。
 */

import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const name = 'memories'
export const version = '1.0.0'
export const displayName = '长期记忆库'
export const description = '后端服务 · 每 N 轮概括、向量 + BM25 混合检索、角色级独立记忆存储。'
export const author = '念风内核'
export const icon = '🧠'
export const core = false
export const inject = ['httpApi', 'models', 'settings', 'hub', 'sessions']
export const provides = [{ name: 'memories', type: 'singleton' }]

/** Node 22.5+ 才有 node:sqlite；旧 Node 自动回退到 JSON 文件。 */
let DatabaseSyncClass = null
try {
  const sqlite = await import('node:sqlite')
  DatabaseSyncClass = sqlite.DatabaseSync || null
} catch (_) {
  DatabaseSyncClass = null
}

const DEFAULT_EVERY_ROUNDS = 10
const MAX_EVERY_ROUNDS = 50
const MAX_MESSAGES_PER_ROUND = 80
/** 群聊窗口概括：窗口内至少要有这么多条新消息（未出现在历史概括里）才值得总结。 */
const MIN_WINDOW_NEW_MESSAGES = 5
/** 群聊窗口最大消息数，与 normalizeRounds 的单轮上限保持一致。 */
const MAX_WINDOW_MESSAGES = 80
/** 单条原文快照保留上限：调大后在记忆详情里能回看更完整的原始消息。 */
const MAX_MESSAGE_CHARS = 12000
/** 概括正文安全上限：模型有 SUMMARY_MAX_TOKENS 输出上限，这里只兜底忽略参数的异常端点。 */
const MAX_SUMMARY_CHARS = 4000
/** 概括请求最多携带的提示字符数；超长窗口按每条消息均匀压缩，而不是整段丢掉后面的消息。 */
const MAX_PROMPT_CHARS = 32000
const MAX_PROMPT_MESSAGE_CHARS = 4000
const SUMMARY_MAX_TOKENS = 1200
const MAX_SEARCH_TOP_K = 20
const BM25_K1 = 1.5
const BM25_B = 0.75
const RRF_K = 60

const nowIso = () => new Date().toISOString()

const clampNumber = (value, min, max, fallback) => {
  const num = Number(value)
  if (!Number.isFinite(num)) return fallback
  return Math.max(min, Math.min(max, Math.floor(num)))
}

const asJsonArray = (value, fallback = []) => {
  if (Array.isArray(value)) return value
  if (typeof value !== 'string' || !value.trim()) return fallback
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : fallback
  } catch (_) {
    return fallback
  }
}

const asJsonObject = (value, fallback = {}) => {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value
  if (typeof value !== 'string' || !value.trim()) return fallback
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback
  } catch (_) {
    return fallback
  }
}

const hash = value => createHash('sha1').update(String(value ?? '')).digest('hex').slice(0, 16)

/** 中英文混合分词：优先 Intl.Segmenter，再补 CJK 二元组，保证中文同义词之外的精确子串也能召回。 */
function tokenize(text) {
  const raw = String(text ?? '').toLowerCase()
  const tokens = []
  try {
    const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' })
    for (const part of segmenter.segment(raw)) {
      const word = String(part.segment || '').trim()
      if (word && (part.isWordLike || /[\u3400-\u9fff]/.test(word))) tokens.push(word)
    }
  } catch (_) {
    /* Intl.Segmenter 不可用时走下面的退化逻辑 */
  }
  const cjk = [...raw].filter(ch => /[\u3400-\u9fff]/.test(ch))
  for (let i = 0; i < cjk.length - 1; i += 1) tokens.push(cjk[i] + cjk[i + 1])
  for (const word of raw.match(/[a-z0-9_]{2,}/g) || []) tokens.push(word)
  return [...new Set(tokens)].slice(0, 200)
}

function bm25Rank(docs, queryTokens) {
  const list = docs.map(doc => ({ doc, tokens: tokenize(`${doc.summary || ''} ${doc.keywords || ''}`) }))
  const docCount = list.length || 1
  const avgLen = list.reduce((sum, item) => sum + item.tokens.length, 0) / docCount || 1
  const df = new Map()
  for (const item of list) {
    for (const token of new Set(item.tokens)) df.set(token, (df.get(token) || 0) + 1)
  }
  const uniqueQuery = [...new Set(queryTokens || [])]
  const scored = list.map(({ doc, tokens }) => {
    const tf = new Map()
    for (const token of tokens) tf.set(token, (tf.get(token) || 0) + 1)
    let score = 0
    for (const term of uniqueQuery) {
      const freq = tf.get(term) || 0
      if (!freq) continue
      const n = df.get(term) || 0
      const idf = Math.log(1 + (docCount - n + 0.5) / (n + 0.5))
      score += idf * ((freq * (BM25_K1 + 1)) / (freq + BM25_K1 * (1 - BM25_B + BM25_B * (tokens.length / avgLen))))
    }
    return { doc, score }
  })
  return scored.sort((a, b) => b.score - a.score)
}

function cosineSimilarity(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || !left.length || left.length !== right.length) return null
  let dot = 0
  let normLeft = 0
  let normRight = 0
  for (let i = 0; i < left.length; i += 1) {
    const a = Number(left[i]) || 0
    const b = Number(right[i]) || 0
    dot += a * b
    normLeft += a * a
    normRight += b * b
  }
  if (!normLeft || !normRight) return 0
  return dot / (Math.sqrt(normLeft) * Math.sqrt(normRight))
}

/**
 * 混合检索：BM25 + 向量余弦，用 RRF（Reciprocal Rank Fusion）融合，
 * 与 MemMachine 默认的 rrf-hybrid reranker 思路一致。
 */
function hybridRank(records, queryText, queryEmbedding, queryTokens) {
  const keywordRanked = queryTokens.length ? bm25Rank(records, queryTokens) : records.map(doc => ({ doc, score: 0 }))
  const keywordRank = new Map(keywordRanked.map((item, index) => [item.doc.id, { score: item.score, rank: index }]))
  const vectorRank = new Map()
  if (queryEmbedding?.length) {
    const scored = records
      .map(doc => ({ doc, score: cosineSimilarity(doc.embedding, queryEmbedding) }))
      .filter(item => Number.isFinite(item.score))
      .sort((a, b) => b.score - a.score)
    for (let i = 0; i < scored.length; i += 1) vectorRank.set(scored[i].doc.id, { score: scored[i].score, rank: i })
  }
  const hasVector = vectorRank.size > 0
  const ids = new Set([...keywordRank.keys(), ...vectorRank.keys()])
  const fused = []
  for (const id of ids) {
    const kw = keywordRank.get(id)
    const vec = vectorRank.get(id)
    const score =
      (kw ? 1 / (RRF_K + kw.rank + 1) : 0) +
      (hasVector && vec ? 1 / (RRF_K + vec.rank + 1) : 0)
    const doc = records.find(item => item.id === id)
    if (!doc) continue
    fused.push({
      doc,
      score,
      keyword_score: kw?.score || 0,
      vector_score: vec?.score ?? null,
      keyword_rank: kw?.rank ?? null,
      vector_rank: vec?.rank ?? null,
    })
  }
  // 没有任何向量、且 BM25 全 0 时，按时间倒序兜底，避免 query 与摘要完全无词面交集时结果为空。
  const allZero = fused.every(item => !item.keyword_score && item.vector_score === null)
  if (allZero) {
    return [...records]
      .sort((a, b) => String(b.ended_at || '').localeCompare(String(a.ended_at || '')))
      .map((doc, index) => ({ doc, score: 0, keyword_score: 0, vector_score: null, keyword_rank: index, vector_rank: null }))
  }
  if (!hasVector) {
    return fused
      .map(item => ({ ...item, score: item.keyword_score }))
      .sort((a, b) => b.score - a.score)
  }
  return fused.sort((a, b) => b.score - a.score)
}

function timeToMs(value) {
  const parsed = Date.parse(String(value || ''))
  return Number.isNaN(parsed) ? 0 : parsed
}

function messageContentOf(message) {
  const content = message?.content
  if (Array.isArray(content)) {
    return content
      .map(part => (typeof part === 'string' ? part : part?.type === 'text' ? part.text || '' : '[图片]'))
      .filter(Boolean)
      .join('\n')
  }
  return String(content ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ')
}

function normalizeRoundMessage(message, index) {
  if (!message || typeof message !== 'object') return null
  const role = message.role === 'assistant' ? 'assistant' : message.role === 'system' ? 'system' : 'user'
  const content = messageContentOf(message).slice(0, MAX_MESSAGE_CHARS)
  if (!content && !message.has_images && !message.image_count) return null
  return {
    message_id: String(message.message_id || message.id || ''),
    seq: Number(message.seq) || index + 1,
    role,
    content: content || '[图片]',
    sender_id: String(message.sender_id || ''),
    sender_name: String(message.sender_name || ''),
    timestamp: String(message.timestamp || ''),
    content_type: String(message.content_type || 'text'),
    image_count: Array.isArray(message.meta?.images) ? message.meta.images.length : Number(message.image_count) || 0,
  }
}

function normalizeRounds(input = []) {
  const rounds = []
  for (const raw of Array.isArray(input) ? input : []) {
    if (!raw || typeof raw !== 'object') continue
    const messages = (Array.isArray(raw.messages) ? raw.messages : [])
      .map(normalizeRoundMessage)
      .filter(Boolean)
      .slice(0, MAX_MESSAGES_PER_ROUND)
    if (!messages.length) continue
    const firstUser = messages.find(message => message.role === 'user')
    const firstMessageId = messages[0]?.message_id || hash(JSON.stringify(messages[0]).slice(0, 200))
    const id = String(raw.id || raw.round_id || `rd:${firstUser?.message_id || firstMessageId}`)
    const times = messages.map(message => timeToMs(message.timestamp)).filter(Boolean)
    rounds.push({
      id,
      channel_id: String(raw.channel_id || raw.channelId || ''),
      conversation_id: String(raw.conversation_id || raw.conversationId || ''),
      source_group: String(raw.source_group || raw.sourceGroup || ''),
      started_at: times.length ? new Date(Math.min(...times)).toISOString() : '',
      ended_at: times.length ? new Date(Math.max(...times)).toISOString() : '',
      messages,
    })
  }
  const seen = new Set()
  return rounds.filter(round => {
    if (!round.id || seen.has(round.id)) return false
    seen.add(round.id)
    return true
  })
}

/** 说话人标签：助理固定用角色本名，用户用消息自带的发送者名；绝不使用应用名兜底。 */
function speakerLabelOf(message, { roleName = '' } = {}) {
  const clean = value =>
    String(value ?? '')
      .replace(/[\r\n]+/g, ' ')
      .replace(/[：:]\s*$/, '')
      .trim()
  if (message.role === 'assistant') return clean(roleName) || clean(message.sender_name) || '角色'
  if (message.role === 'user') return clean(message.sender_name) || '用户'
  return '系统'
}

/**
 * 单条消息进入概括 Prompt 前的压缩：把“超过预算的尾部”变成可解释的截断标记。
 * 与直接 slice 整个 Prompt 不同，这样不会无声丢掉窗口里更靠后的消息。
 */
function clipPromptText(value, limit) {
  const text = String(value ?? '')
  if (text.length <= limit) return text
  const keep = Math.max(0, Math.floor(limit) - 24)
  return `${text.slice(0, keep)}…[原文过长，已截断 ${text.length - keep} 字]`
}

function buildPromptLines(rounds, context, perMessageLimit) {
  const lines = []
  for (let i = 0; i < rounds.length; i += 1) {
    lines.push(context.mode === 'window' ? '【群聊消息窗口】' : `【第 ${i + 1} 轮】`)
    for (const message of rounds[i].messages || []) {
      const sender = speakerLabelOf(message, context)
      const time = String(message.timestamp || '').replace('T', ' ').replace(/\.\d+(?:[+-]\d\d:\d\d)?$/, '')
      lines.push(`- ${time ? `[${time}] ` : ''}${sender}：${clipPromptText(message.content, perMessageLimit)}`)
    }
  }
  return lines
}

function roundsToPromptContent(rounds, context = {}) {
  const messageCount = (rounds || []).reduce((sum, round) => sum + (round.messages || []).length, 0)
  let perMessageLimit = MAX_PROMPT_MESSAGE_CHARS
  let lines = buildPromptLines(rounds, context, perMessageLimit)
  if (messageCount > 0 && lines.join('\n').length > MAX_PROMPT_CHARS) {
    // 整段 Prompt 超预算时，仍保留全部消息，只按条数均匀降低每条消息的可见字数；
    // 每条都带截断标记，概括模型至少知道该条被压缩过，而不是以为对话就到这里。
    const overhead = messageCount * 64 + rounds.length * 4
    const available = Math.max(messageCount * 160, MAX_PROMPT_CHARS - overhead)
    perMessageLimit = Math.max(160, Math.floor(available / messageCount))
    lines = buildPromptLines(rounds, context, perMessageLimit)
  }
  return lines.join('\n')
}

/** 概括正文清洗：优先在完整句末截断，避免从句子中间硬切造成明显截断。 */
function normalizeSummaryText(raw) {
  const text = String(raw ?? '')
    .replace(/[\u200b-\u200d\ufeff]/gi, '')
    .replace(/^[\s"'“”]+|[\s"'“”]+$/g, '')
    .trim()
  if (!text) return ''
  if (text.length <= MAX_SUMMARY_CHARS) return text
  const sliced = text.slice(0, MAX_SUMMARY_CHARS)
  const boundary = Math.max(
    sliced.lastIndexOf('。'),
    sliced.lastIndexOf('！'),
    sliced.lastIndexOf('？'),
    sliced.lastIndexOf('!'),
    sliced.lastIndexOf('?'),
    sliced.lastIndexOf('\n'),
  )
  // 句末离安全上限太远时说明模型在单句里写了异常长的内容，退回字符截断。
  return (boundary >= sliced.length * 0.6 ? sliced.slice(0, boundary + 1) : sliced).trim()
}

function recordToDTO(record, extra = {}) {
  const messages = (record.rounds || []).flatMap(round => round.messages || [])
  return {
    id: record.id,
    role_id: record.role_id || '',
    role_name: record.meta?.role_name || '',
    memory_scope: record.memory_scope || '',
    summary: record.summary,
    keywords: record.keywords || '',
    score: extra.score ?? null,
    keyword_score: extra.keyword_score ?? null,
    vector_score: extra.vector_score ?? null,
    source: {
      channel_id: record.source_channel_id || '',
      conversation_id: record.source_conversation_id || '',
      group: record.source_group || '',
      started_at: record.started_at || '',
      ended_at: record.ended_at || '',
    },
    round_count: record.round_count || record.rounds?.length || 0,
    message_count: messages.length,
    message_ids: messages.map(message => message.message_id).filter(Boolean),
    // 列表接口默认不带 messages，详情接口才展开，避免一次返回过多原文。
    ...(extra.includeMessages === false ? {} : { messages }),
    created_at: record.created_at,
    updated_at: record.updated_at || record.created_at,
    embedding: {
      provider: record.embedding_provider || '',
      model: record.embedding_model || '',
      dimension: record.embedding_dim || 0,
      enabled: Array.isArray(record.embedding) && record.embedding.length > 0,
    },
  }
}

/** SQLite / JSON 双实现；对外只暴露统一接口。 */
class MemoryRepository {
  constructor(dataDir, logger) {
    this.logger = logger
    this.records = []
    this.roundIds = new Map() // round_id -> memory id
    // channel 基线：key = roleId|scopeKey|channelId，记录“从哪个 seq 之后才纳入概括”，
    // 用于升级后不回填庞大旧历史。
    this.state = new Map()
    mkdirSync(dataDir, { recursive: true })
    if (DatabaseSyncClass) {
      this.driver = 'sqlite'
      this.file = join(dataDir, 'memory.db')
      this.db = new DatabaseSyncClass(this.file)
      this.db.exec(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS memory_records (
          id TEXT PRIMARY KEY,
          role_id TEXT NOT NULL,
          memory_scope TEXT NOT NULL,
          summary TEXT NOT NULL,
          keywords TEXT,
          source_channel_id TEXT,
          source_conversation_id TEXT,
          source_group TEXT,
          round_count INTEGER,
          started_at TEXT,
          ended_at TEXT,
          embedding TEXT,
          embedding_provider TEXT,
          embedding_model TEXT,
          embedding_dim INTEGER,
          round_ids TEXT,
          rounds TEXT,
          created_at TEXT,
          updated_at TEXT,
          meta TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_memory_role_scope ON memory_records(role_id, memory_scope);
        CREATE INDEX IF NOT EXISTS idx_memory_source_channel ON memory_records(source_channel_id);
        CREATE TABLE IF NOT EXISTS memory_channel_state (
          state_key TEXT PRIMARY KEY,
          role_id TEXT NOT NULL,
          memory_scope TEXT NOT NULL,
          channel_id TEXT,
          baseline_seq INTEGER NOT NULL DEFAULT 0,
          baseline_round_id TEXT,
          created_at TEXT,
          updated_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_memory_state_channel ON memory_channel_state(channel_id);
      `)
      this.loadSqlite()
    } else {
      this.driver = 'json'
      this.file = join(dataDir, 'memory.json')
      if (existsSync(this.file)) {
        try {
          const data = JSON.parse(readFileSync(this.file, 'utf8'))
          this.records = Array.isArray(data?.records) ? data.records : []
          this.state = new Map(
            (Array.isArray(data?.state) ? data.state : [])
              .filter(item => item?.state_key)
              .map(item => [String(item.state_key), item]),
          )
        } catch (err) {
          this.logger?.warn?.(`[memories] memory.json 损坏，已重置：${err?.message || err}`)
          this.records = []
          this.state = new Map()
        }
      }
    }
    this.reindex()
  }

  loadSqlite() {
    const rows = this.db.prepare('SELECT * FROM memory_records').all()
    this.records = rows.map(row => ({
      id: row.id,
      role_id: row.role_id,
      memory_scope: row.memory_scope,
      summary: row.summary,
      keywords: row.keywords || '',
      source_channel_id: row.source_channel_id || '',
      source_conversation_id: row.source_conversation_id || '',
      source_group: row.source_group || '',
      round_count: Number(row.round_count) || 0,
      started_at: row.started_at || '',
      ended_at: row.ended_at || '',
      embedding: asJsonArray(row.embedding),
      embedding_provider: row.embedding_provider || '',
      embedding_model: row.embedding_model || '',
      embedding_dim: Number(row.embedding_dim) || 0,
      round_ids: asJsonArray(row.round_ids),
      rounds: asJsonArray(row.rounds),
      created_at: row.created_at || '',
      updated_at: row.updated_at || '',
      meta: asJsonObject(row.meta),
    }))
    this.state = new Map(
      this.db
        .prepare('SELECT * FROM memory_channel_state')
        .all()
        .map(row => [
          String(row.state_key),
          {
            state_key: String(row.state_key),
            role_id: row.role_id || '',
            memory_scope: row.memory_scope || 'normal',
            channel_id: row.channel_id || '',
            baseline_seq: Number(row.baseline_seq) || 0,
            baseline_round_id: row.baseline_round_id || '',
            created_at: row.created_at || '',
            updated_at: row.updated_at || '',
          },
        ]),
    )
  }

  reindex() {
    this.roundIds = new Map()
    for (const record of this.records) {
      for (const roundId of record.round_ids || []) this.roundIds.set(String(roundId), record.id)
    }
  }

  persistJson() {
    try {
      const tmp = `${this.file}.tmp`
      writeFileSync(
        tmp,
        JSON.stringify({ version: 1, records: this.records, state: [...this.state.values()] }, null, 2),
        'utf8',
      )
      renameSync(tmp, this.file)
    } catch (err) {
      this.logger?.warn?.(`[memories] 写入 memory.json 失败：${err?.message || err}`)
    }
  }

  save(record) {
    const index = this.records.findIndex(item => item.id === record.id)
    if (index >= 0) this.records[index] = record
    else this.records.push(record)
    if (this.driver === 'sqlite') {
      this.db
        .prepare(
          `INSERT OR REPLACE INTO memory_records (
            id, role_id, memory_scope, summary, keywords,
            source_channel_id, source_conversation_id, source_group,
            round_count, started_at, ended_at,
            embedding, embedding_provider, embedding_model, embedding_dim,
            round_ids, rounds, created_at, updated_at, meta
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.id,
          record.role_id,
          record.memory_scope,
          record.summary,
          record.keywords || '',
          record.source_channel_id || '',
          record.source_conversation_id || '',
          record.source_group || '',
          record.round_count || 0,
          record.started_at || '',
          record.ended_at || '',
          JSON.stringify(record.embedding || []),
          record.embedding_provider || '',
          record.embedding_model || '',
          record.embedding_dim || 0,
          JSON.stringify(record.round_ids || []),
          JSON.stringify(record.rounds || []),
          record.created_at || nowIso(),
          record.updated_at || nowIso(),
          JSON.stringify(record.meta || {}),
        )
    } else {
      this.persistJson()
    }
    for (const roundId of record.round_ids || []) this.roundIds.set(String(roundId), record.id)
  }

  getState(stateKey) {
    return this.state.get(String(stateKey)) || null
  }

  setState(state = {}) {
    const key = String(state.state_key || state.key || '').trim()
    if (!key) return null
    const item = {
      state_key: key,
      role_id: String(state.role_id || ''),
      memory_scope: String(state.memory_scope || 'normal'),
      channel_id: String(state.channel_id || ''),
      baseline_seq: Math.max(0, Number(state.baseline_seq) || 0),
      baseline_round_id: String(state.baseline_round_id || ''),
      created_at: state.created_at || nowIso(),
      updated_at: nowIso(),
    }
    this.state.set(key, item)
    if (this.driver === 'sqlite') {
      this.db
        .prepare(
          `INSERT OR REPLACE INTO memory_channel_state (
            state_key, role_id, memory_scope, channel_id, baseline_seq, baseline_round_id, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          item.state_key,
          item.role_id,
          item.memory_scope,
          item.channel_id,
          item.baseline_seq,
          item.baseline_round_id,
          item.created_at,
          item.updated_at,
        )
    } else {
      this.persistJson()
    }
    return item
  }

  list({ roleId, scope } = {}) {
    // 保持原有严格语义：必须同时匹配 roleId + scope（search / summaries 依赖）。
    return this.records.filter(record => record.role_id === roleId && record.memory_scope === scope)
  }

  /** 管理页筛选：roleId / scope 都可选；不传时返回全部记忆。 */
  find({ roleId, scope } = {}) {
    return this.records.filter(
      record => (!roleId || record.role_id === roleId) && (!scope || record.memory_scope === scope),
    )
  }

  hasRound(roundId) {
    return this.roundIds.has(String(roundId))
  }

  stats() {
    return {
      driver: this.driver,
      file: this.file,
      records: this.records.length,
      rounds: this.roundIds.size,
      channels: this.state.size,
    }
  }
}

export function apply(ctx, config = {}) {
  const httpApi = ctx.httpApi
  const models = ctx.models
  const settings = ctx.settings
  const hub = ctx.hub
  const sessions = ctx.sessions
  const dataDir = config.dataDir || settings.dataDir || process.cwd()
  let activeDataDir = dataDir
  let repo = new MemoryRepository(activeDataDir, ctx.logger)
  const ingestLocks = new Map()

  /** 用户切换数据目录后，旧 repo 跟着旧目录；下一次读写时自动切到新目录。 */
  const ensureRepository = () => {
    const next = String(config.dataDir || settings.dataDir || activeDataDir || '')
    if (next && next !== activeDataDir) {
      try {
        repo.db?.close?.()
      } catch (_) {
        /* ignore */
      }
      activeDataDir = next
      repo = new MemoryRepository(activeDataDir, ctx.logger)
      ctx.logger.info(`长期记忆库已切换数据目录：${activeDataDir}`)
      seedMemoryBaselines()
    }
    return repo
  }

  const scopeKeyFor = (channelId, group) =>
    group === 'privacy' ? `privacy:${String(channelId || 'unknown')}` : 'normal'
  const memoryStateKey = (roleId, scopeKey, channelId) => `${roleId}|${scopeKey}|${String(channelId || '')}`

  /**
   * 升级 / 重启后的概括基线：
   * 当前代码库已有大量旧聊天记录，首次启用长期记忆时只统计“基线之后”的新轮次，
   * 不回填整个历史仓库。基线在服务启动时按会话当前最后一条消息 seq 建立。
   */
  const seedMemoryBaselines = async () => {
    if (!sessions?.ready || typeof sessions.listCompact !== 'function') return
    try {
      await sessions.ready()
      let seeded = 0
      for (const conv of sessions.listCompact()) {
        const channelId = String(conv?.meta?.channelId || '')
        const lastSeq = Number(conv?.lastSeq) || 0
        if (!channelId || lastSeq <= 0) continue
        const roleId = String(conv?.meta?.roleId || conv?.id || '')
        if (!roleId) continue
        const scopeKey = scopeKeyFor(channelId, conv?.meta?.channelGroup)
        const stateKey = memoryStateKey(roleId, scopeKey, channelId)
        if (repo.getState(stateKey)) continue
        repo.setState({
          state_key: stateKey,
          role_id: roleId,
          memory_scope: scopeKey,
          channel_id: channelId,
          baseline_seq: lastSeq,
          baseline_round_id: '',
        })
        seeded += 1
      }
      if (seeded) ctx.logger.info(`长期记忆库已为 ${seeded} 个渠道建立概括基线：只统计之后的对话`)
    } catch (err) {
      ctx.logger.warn(`[memories] 建立概括基线失败：${err?.message || err}`)
    }
  }
  seedMemoryBaselines()

  const memoryPreferences = () => settings.get()?.preferences?.memory || {}
  const summaryConfig = override => {
    const prefs = memoryPreferences()
    const data = settings.get() || {}
    const provider = String(prefs.summaryProvider || override?.summaryProvider || data.defaultProvider || '').trim()
    // 只使用“同一个 provider”的全局默认模型兜底，避免把 A 提供商的默认模型发给 B 提供商。
    const globalFallback = String(data.defaultProvider || '') === provider ? data.defaultModel : ''
    const model = String(
      prefs.summaryModel ||
        override?.summaryModel ||
        data.providers?.[provider]?.defaultModel ||
        globalFallback ||
        '',
    ).trim()
    return provider && model ? { provider, model } : null
  }
  const isObjectValue = value => !!value && typeof value === 'object' && !Array.isArray(value)
  const truthyFlag = value => value === true || value === 'true'
  const channelIdVariants = channelId => {
    const id = String(channelId || '').trim()
    if (!id) return []
    const bare = id.includes(':') ? id.slice(id.indexOf(':') + 1) : id
    return [...new Set([id, bare].filter(Boolean))]
  }
  const lookupChannelFlag = (map, channelId) => {
    if (!isObjectValue(map)) return null
    const variants = channelIdVariants(channelId)
    if (!variants.length) return null
    for (const key of variants) {
      if (Object.prototype.hasOwnProperty.call(map, key)) return map[key]
    }
    for (const [key, value] of Object.entries(map)) {
      if (variants.some(variant => key === variant || key.endsWith(`:${variant}`) || variant.endsWith(`:${key}`))) return value
    }
    return null
  }

  /**
   * 群聊概括总开关 / 逐渠道显式开启在服务端也做一次兜底。
   * 新语义：总开关开启后，只有 groupChannelSummaryEnabled.<channelId>=true 的渠道才会生成；
   * 未显式开启的渠道默认不生成。旧 groupSummaryDisabled.<channelId> 继续兼容迁移期调用。
   */
  const groupSummaryDisabledByPreference = channelId => {
    const prefs = memoryPreferences()
    if (prefs.groupSummaryEnabled === false) return true
    const enabled = lookupChannelFlag(prefs.groupChannelSummaryEnabled, channelId)
    if (enabled !== null) return !truthyFlag(enabled)
    const legacy = lookupChannelFlag(prefs.groupSummaryDisabled, channelId)
    if (legacy !== null) return truthyFlag(legacy)
    // 新语义默认逐渠道关闭：必须显式开启才会总结。
    return true
  }
  const embeddingConfig = () => {
    const prefs = memoryPreferences()
    return {
      provider: String(prefs.embeddingProvider || '').trim(),
      model: String(prefs.embeddingModel || '').trim(),
      dimension: Math.max(0, Number(prefs.embeddingDimension) || 0),
    }
  }

  async function rememberEmbeddingDimension(dimension) {
    if (!dimension || dimension === embeddingConfig().dimension) return
    try {
      await settings.update?.({ preferences: { memory: { embeddingDimension: dimension } } })
      hub?.broadcast?.('settings/updated', settings.redacted?.() || settings.get?.())
    } catch (err) {
      ctx.logger?.debug?.(`[memories] 写入 embedding 维度失败：${err?.message || err}`)
    }
  }

  async function embedText(text) {
    const config = embeddingConfig()
    if (!config.provider || !config.model) return null
    const result = await models.embed({ provider: config.provider, model: config.model, input: [text] })
    await rememberEmbeddingDimension(result.dimension)
    return {
      vector: result.embeddings[0],
      dimension: result.dimension,
      provider: result.provider,
      model: result.model,
    }
  }

  async function summarizeRounds(rounds, modelConfig, everyRounds, context = {}) {
    const windowMode = context.mode === 'window'
    const windowSize = Math.max(1, Number(context.windowSize) || 0)
    const sizeHint = windowMode
      ? `；这次概括的是群聊最近 ${windowSize} 条消息的窗口，窗口里可能同时有多个说话人。`
      : `；这些对话每组固定是 ${everyRounds} 轮。`
    const systemPrompt = [
      '你是聊天记录压缩器，不是对话里的任何人物。',
      '你的任务是把连续几轮完整对话或一段群聊消息窗口压缩成一段很短的概括，用于以后按语义找回这段记忆。',
      '概括只保留关键信息：聊了什么话题、发生了什么事件、得出了什么结论、有什么偏好或情绪/风格；不要逐条复述，不要编造，不要输出标题、编号或解释。',
      '概括里的说话人以每行开头标注的真实名字为准；不同名字是不同的人，不要把应用名、模型名、压缩器名称或聊天记录里的系统字段当成对话人物，也不要给对话里没有出现的人起名。',
      `建议 1-3 句话、最多约 160 个汉字${sizeHint}`,
    ].join('\n')
    const userPrompt = [
      windowMode
        ? `请把下面这 ${windowSize} 条群聊消息压缩成一段简短概括。`
        : `请把下面这 ${rounds.length} 轮完整对话压缩成一段简短概括。`,
      '只输出概括正文。',
      '',
      roundsToPromptContent(rounds, context),
    ].join('\n')
    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ]
    // 概括任务不需要思考链：关闭推理既省 token，也避免思考内容挤占输出预算造成正文截断。
    const options = { temperature: 0.2, maxTokens: SUMMARY_MAX_TOKENS, reasoningEffort: 'off' }
    let text = ''
    let finishReason = ''
    if (typeof models.stream === 'function') {
      const chunks = []
      let doneInfo = null
      const result = await models.stream({
        provider: modelConfig.provider,
        model: modelConfig.model,
        messages,
        options,
        onChunk: delta => {
          if (delta) chunks.push(String(delta))
        },
        onDone: info => {
          doneInfo = info || null
        },
      })
      text = chunks.join('') || String(result?.text || '')
      finishReason = String(doneInfo?.reason || result?.finishReason || '')
    } else {
      text = await models.complete({ provider: modelConfig.provider, model: modelConfig.model, messages, options })
    }
    if (finishReason === 'length') {
      ctx.logger?.warn?.(
        `[memories] 概括模型输出达到上限（${SUMMARY_MAX_TOKENS} tokens），本次概括可能不完整；` +
          '可缩短群聊窗口 / 降低上下文条数，或在模型设置里提高该模型的输出上限。',
      )
    }
    const summary = normalizeSummaryText(text)
    if (!summary) throw new Error('概括模型返回了空内容')
    return summary
  }

  /** 群聊窗口已概括的 message_id 集合，用于判断当前窗口有多少条新消息。 */
  function summarizedMessageIds(roleId, scopeKey, channelId) {
    const ids = new Set()
    for (const record of repo.list({ roleId, scope: scopeKey })) {
      if (String(record.source_channel_id || '') !== String(channelId || '')) continue
      for (const round of record.rounds || []) {
        for (const message of round.messages || []) {
          const id = String(message?.message_id || '').trim()
          if (id) ids.add(id)
        }
      }
    }
    return ids
  }

  /**
   * 群聊窗口概括：每次模型轮结束后，以最近 N 条消息为一个窗口。
   * - 窗口不足 N 条：先不总结；
   * - 与历史概括重复的 message_id 超过 N-5 条：说明窗口基本没变化，跳过；
   * - 至少 5 条新消息：把整个窗口交给概括模型，生成一条记忆。
   */
  async function ingestWindow(input, { roleId, roleName, memoryScope, scopeKey, channelId, windowSize, minNewMessages, messages }) {
    const ids = [...new Set(messages.map(message => String(message?.message_id || '').trim()).filter(Boolean))]
    if (ids.length < windowSize) {
      return {
        ok: true,
        created: 0,
        pending: 0,
        ignored: 0,
        skipped: true,
        reason: 'window-not-full',
        window_size: windowSize,
        message_count: ids.length,
      }
    }
    const summarizedIds = summarizedMessageIds(roleId, scopeKey, channelId)
    const duplicateCount = ids.filter(id => summarizedIds.has(id)).length
    const duplicateLimit = Math.max(0, windowSize - Math.max(1, Math.min(windowSize, minNewMessages)))
    if (duplicateCount > duplicateLimit) {
      return {
        ok: true,
        created: 0,
        pending: 0,
        ignored: 0,
        skipped: true,
        reason: 'duplicate-window',
        window_size: windowSize,
        duplicate_count: duplicateCount,
        duplicate_limit: duplicateLimit,
      }
    }
    const modelConfig = summaryConfig(input)
    if (!modelConfig) {
      return {
        ok: false,
        code: 'NO_SUMMARY_MODEL',
        error: '尚未配置概括模型：请到「设置 → 模型 → 记忆模型」选择，或先选择可用的全局默认对话模型。',
        pending: 0,
        ignored: 0,
      }
    }
    const windowId = `window:${channelId}:${ids.at(-1)}`
    const lockKey = `${roleId}:${memoryScope}:${String(channelId || '')}`
    const previous = ingestLocks.get(lockKey) || Promise.resolve()
    const task = previous
      .catch(() => {})
      .then(async () => {
        const times = messages.map(message => timeToMs(message.timestamp)).filter(Boolean)
        const startedAt = times.length ? new Date(Math.min(...times)).toISOString() : ''
        const endedAt = times.length ? new Date(Math.max(...times)).toISOString() : ''
        const round = {
          id: windowId,
          channel_id: channelId,
          conversation_id: String(input.conversationId || ''),
          source_group: String(input.sourceGroup || 'group'),
          started_at: startedAt,
          ended_at: endedAt,
          messages,
        }
        const summary = await summarizeRounds([round], modelConfig, windowSize, {
          roleName,
          mode: 'window',
          windowSize,
        })
        const keywords = tokenize(summary).slice(0, 60).join(' ')
        let embedding = null
        try {
          embedding = await embedText(summary)
        } catch (err) {
          ctx.logger?.warn?.(`[memories] 群聊窗口向量化失败，先以关键词模式保存：${err?.message || err}`)
        }
        const record = {
          id: `mem_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`,
          role_id: roleId,
          memory_scope: scopeKey,
          summary,
          keywords,
          source_channel_id: String(channelId || ''),
          source_conversation_id: String(input.conversationId || ''),
          source_group: String(input.sourceGroup || 'group'),
          round_count: 1,
          started_at: startedAt,
          ended_at: endedAt,
          embedding: embedding?.vector || [],
          embedding_provider: embedding?.provider || '',
          embedding_model: embedding?.model || '',
          embedding_dim: embedding?.dimension || 0,
          round_ids: [windowId],
          rounds: [round],
          created_at: nowIso(),
          updated_at: nowIso(),
          meta: {
            mode: 'window',
            window_size: windowSize,
            duplicate_count: duplicateCount,
            duplicate_limit: duplicateLimit,
            new_message_count: Math.max(0, windowSize - duplicateCount),
            summary_provider: modelConfig.provider,
            summary_model: modelConfig.model,
            role_name: roleName,
            embedded: !!embedding,
          },
        }
        repo.save(record)
        hub?.broadcast?.('memory/updated', {
          roleId,
          memoryScope,
          channelId: String(channelId || ''),
          created: 1,
        })
        return {
          ok: true,
          created: 1,
          pending: 0,
          ignored: 0,
          skipped: false,
          mode: 'window',
          window_size: windowSize,
          duplicate_count: duplicateCount,
          duplicate_limit: duplicateLimit,
          new_message_count: Math.max(0, windowSize - duplicateCount),
          summaries: [recordToDTO(record)],
        }
      })
    ingestLocks.set(lockKey, task)
    try {
      return await task
    } finally {
      if (ingestLocks.get(lockKey) === task) ingestLocks.delete(lockKey)
    }
  }

  async function ingest(input = {}) {
    ensureRepository()
    const roleId = String(input.roleId || '').trim()
    if (!roleId) throw Object.assign(new Error('缺少 roleId'), { status: 400 })
    // 概括时必须用角色本名区分说话人；渠道会话名带平台后缀，不能直接拿来当人名。
    // 优先使用前端传入的名字，旧前端 / 直接 ingest 时回退到 sessions 里的角色名。
    let roleName = String(input.roleName || input.role_name || '').trim()
    if (!roleName) {
      try {
        const conv = sessions?.get?.(roleId)
        const boundRoleId = String(conv?.meta?.roleId || '').trim()
        const roleConv = boundRoleId && boundRoleId !== roleId ? sessions?.get?.(boundRoleId) : null
        roleName = String(roleConv?.name || conv?.name || '').trim()
      } catch (_) {
        roleName = ''
      }
    }
    const memoryScope = input.memoryScope === 'privacy' ? 'privacy' : 'normal'
    const scopeKey = memoryScope === 'privacy' ? `privacy:${String(input.channelId || 'unknown')}` : 'normal'
    const rounds = normalizeRounds(input.rounds)
    if (!rounds.length) return { ok: true, created: 0, pending: 0, ignored: 0 }
    const roundSeq = round => Math.max(0, ...(Array.isArray(round?.messages) ? round.messages : []).map(message => Number(message.seq) || 0))
    const seqs = rounds.map(roundSeq).filter(seq => seq > 0)
    const firstSeq = seqs.length ? Math.min(...seqs) : 0
    const latestSeq = seqs.length ? Math.max(...seqs) : 0
    const channelId = String(input.channelId || rounds.at(-1)?.channel_id || '')
    const sourceGroup = String(input.sourceGroup || input.source_group || rounds.at(-1)?.source_group || '')
    // 群聊关掉记忆总结的渠道，任何调用方都不再写入新概括；已存记忆仍可检索。
    if (sourceGroup === 'group' && groupSummaryDisabledByPreference(channelId)) {
      return { ok: true, created: 0, pending: 0, ignored: 0, skipped: true, reason: 'group-summary-disabled' }
    }
    // 私聊 / 隐私的总结轮次来自设置页「私聊总结轮次」；调用方显式传值时优先。
    const rawEveryRounds =
      input.everyRounds === undefined || input.everyRounds === null || input.everyRounds === ''
        ? memoryPreferences().summaryRounds
        : input.everyRounds
    const everyRounds = clampNumber(rawEveryRounds, 2, MAX_EVERY_ROUNDS, DEFAULT_EVERY_ROUNDS)
    // windowSize 只有 >0 才是群聊窗口模式；0 / 空 / 无效值必须保持“按轮次概括”，
    // 否则私聊会被错误地当成 windowSize=2 的群聊窗口，导致一轮一条概括 + “群里”措辞。
    const rawWindowSize = Number(input.windowSize ?? input.window_size ?? 0)
    const windowSize = Number.isFinite(rawWindowSize) && rawWindowSize > 0
      ? clampNumber(rawWindowSize, 2, MAX_WINDOW_MESSAGES, 0)
      : 0
    if (windowSize > 0) {
      const minNewMessages = Math.min(
        windowSize,
        clampNumber(input.minNewMessages ?? input.min_new_messages, 1, windowSize, MIN_WINDOW_NEW_MESSAGES),
      )
      const messages = rounds
        .flatMap(round => round.messages || [])
        .sort((a, b) => (Number(a.seq) || 0) - (Number(b.seq) || 0))
        .slice(-windowSize)
      return ingestWindow(input, { roleId, roleName, memoryScope, scopeKey, channelId, windowSize, minNewMessages, messages })
    }
    const stateKey = memoryStateKey(roleId, scopeKey, channelId)
    let state = repo.getState(stateKey)
    if (!state) {
      // 历史上没有基线：如果这批 round 已经是“大历史”里的最后几十轮，就只从当前最新位置开始计数；
      // 如果只是新渠道刚开始的 1~3 轮，则把基线放到第一轮之前，让新渠道正常从第一轮开始积累。
      // 升级前该渠道若已产生过群聊窗口概括，则从最新 seq 起算，避免旧的窗口内容被再次按轮概括。
      const hasWindowHistory =
        latestSeq > 0 &&
        repo
          .list({ roleId, scope: scopeKey })
          .some(
            record =>
              String(record.source_channel_id || '') === channelId &&
              (record.meta?.mode === 'window' || String(record.round_ids?.[0] || '').startsWith('window:')),
          )
      const baselineSeq = hasWindowHistory || rounds.length > 3 ? latestSeq : Math.max(0, firstSeq - 1)
      state = repo.setState({
        state_key: stateKey,
        role_id: roleId,
        memory_scope: scopeKey,
        channel_id: channelId,
        baseline_seq: baselineSeq,
        baseline_round_id: baselineSeq >= latestSeq ? rounds.at(-1)?.id || '' : '',
      })
    }
    const baselineSeq = Number(state?.baseline_seq) || 0
    const eligible = rounds.filter(round => roundSeq(round) > baselineSeq)
    const fresh = eligible.filter(round => !repo.hasRound(round.id))
    const ignored = rounds.length - fresh.length
    if (!fresh.length) return { ok: true, created: 0, pending: 0, ignored }
    const modelConfig = summaryConfig(input)
    if (!modelConfig) {
      return {
        ok: false,
        code: 'NO_SUMMARY_MODEL',
        error: '尚未配置概括模型：请到「设置 → 模型 → 记忆模型」选择，或先选择可用的全局默认对话模型。',
        pending: fresh.length,
        ignored,
      }
    }
    const lockKey = `${roleId}:${memoryScope}:${String(input.channelId || fresh[0]?.channel_id || '')}`
    const previous = ingestLocks.get(lockKey) || Promise.resolve()
    const task = previous
      .catch(() => {})
      .then(async () => {
        const created = []
        const pending = [...fresh]
        while (pending.length >= everyRounds) {
          const chunk = pending.splice(0, everyRounds)
          const summary = await summarizeRounds(chunk, modelConfig, everyRounds, { roleName })
          const keywords = tokenize(summary).slice(0, 60).join(' ')
          let embedding = null
          try {
            embedding = await embedText(summary)
          } catch (err) {
            ctx.logger?.warn?.(`[memories] 概括向量化失败，先以关键词模式保存：${err?.message || err}`)
          }
          const messages = chunk.flatMap(round => round.messages || [])
          const times = messages.map(message => timeToMs(message.timestamp)).filter(Boolean)
          const record = {
            id: `mem_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`,
            role_id: roleId,
            memory_scope: scopeKey,
            summary,
            keywords,
            source_channel_id: String(input.channelId || chunk[0]?.channel_id || ''),
            source_conversation_id: String(input.conversationId || chunk[0]?.conversation_id || ''),
            source_group: String(input.sourceGroup || chunk[0]?.source_group || 'private'),
            round_count: chunk.length,
            started_at: times.length ? new Date(Math.min(...times)).toISOString() : chunk[0]?.started_at || '',
            ended_at: times.length ? new Date(Math.max(...times)).toISOString() : chunk.at(-1)?.ended_at || '',
            embedding: embedding?.vector || [],
            embedding_provider: embedding?.provider || '',
            embedding_model: embedding?.model || '',
            embedding_dim: embedding?.dimension || 0,
            round_ids: chunk.map(round => round.id),
            rounds: chunk.map(round => ({
              id: round.id,
              channel_id: round.channel_id,
              conversation_id: round.conversation_id,
              source_group: round.source_group,
              started_at: round.started_at,
              ended_at: round.ended_at,
              messages: round.messages,
            })),
            created_at: nowIso(),
            updated_at: nowIso(),
            meta: {
              every_rounds: everyRounds,
              summary_provider: modelConfig.provider,
              summary_model: modelConfig.model,
              role_name: roleName,
              embedded: !!embedding,
            },
          }
          repo.save(record)
          created.push(record)
        }
        hub?.broadcast?.('memory/updated', {
          roleId,
          memoryScope,
          channelId: String(input.channelId || ''),
          created: created.length,
        })
        return {
          ok: true,
          created: created.length,
          pending: pending.length,
          ignored,
          summaries: created.map(record => recordToDTO(record)),
        }
      })
    ingestLocks.set(lockKey, task)
    try {
      return await task
    } finally {
      if (ingestLocks.get(lockKey) === task) ingestLocks.delete(lockKey)
    }
  }

  async function search(input = {}) {
    ensureRepository()
    const roleId = String(input.roleId || '').trim()
    if (!roleId) throw Object.assign(new Error('缺少 roleId'), { status: 400 })
    const memoryScope = input.memoryScope === 'privacy' ? 'privacy' : 'normal'
    const scopeKey = memoryScope === 'privacy' ? `privacy:${String(input.channelId || 'unknown')}` : 'normal'
    const query = String(input.semantic ?? input.query ?? '').trim()
    const keywords = String(input.keywords ?? '').trim()
    const combinedQuery = [query, keywords].filter(Boolean).join(' ')
    const timeStart = input.timeStart || input.time_start || ''
    const timeEnd = input.timeEnd || input.time_end || ''
    let records = repo.list({ roleId, scope: scopeKey })
    if (timeStart) {
      const from = timeToMs(timeStart)
      if (from) records = records.filter(record => timeToMs(record.ended_at) >= from || timeToMs(record.started_at) >= from)
    }
    if (timeEnd) {
      const to = timeToMs(timeEnd)
      if (to) records = records.filter(record => timeToMs(record.started_at) <= to || timeToMs(record.ended_at) <= to)
    }
    const queryTokens = tokenize(combinedQuery)
    let queryEmbedding = null
    let embeddingError = ''
    const config = embeddingConfig()
    if (combinedQuery && config.provider && config.model) {
      try {
        // 若早期概括是在没有向量模型时写入的，这里顺手补一次向量（每次最多 30 条），
        // 避免用户后来才配置 embedding 时旧记忆永远检索不到。
        const missing = records.filter(record => !Array.isArray(record.embedding) || !record.embedding.length).slice(0, 30)
        const result = await models.embed({
          provider: config.provider,
          model: config.model,
          input: [combinedQuery, ...missing.map(record => record.summary)],
        })
        queryEmbedding = result.embeddings[0]
        for (let i = 0; i < missing.length; i += 1) {
          const vector = result.embeddings[i + 1]
          if (!Array.isArray(vector) || !vector.length) continue
          const record = missing[i]
          record.embedding = vector
          record.embedding_provider = result.provider
          record.embedding_model = result.model
          record.embedding_dim = vector.length
          record.updated_at = nowIso()
          repo.save(record)
        }
        await rememberEmbeddingDimension(result.dimension)
      } catch (err) {
        embeddingError = String(err?.message || err)
        ctx.logger?.warn?.(`[memories] 查询向量化失败，本次降级为 BM25 关键词检索：${embeddingError}`)
      }
    }
    const ranked = hybridRank(records, combinedQuery, queryEmbedding, queryTokens)
    const topK = clampNumber(input.topSummaries ?? input.top_summaries ?? input.topK ?? input.top_k, 1, MAX_SEARCH_TOP_K, 3)
    const summaries = ranked.slice(0, topK).map(item => recordToDTO(item.doc, item))
    return {
      ok: true,
      role_id: roleId,
      memory_scope: memoryScope,
      query: combinedQuery,
      total: records.length,
      returned: summaries.length,
      embedding: {
        configured: !!(config.provider && config.model),
        applied: !!queryEmbedding,
        provider: config.provider,
        model: config.model,
        dimension: queryEmbedding?.length || config.dimension || 0,
        error: embeddingError || undefined,
      },
      summaries,
    }
  }

  /**
   * 记忆管理页：列出记忆条目。默认只返回摘要元数据，不返回原文 messages；
   * 详情接口 getRecord 才返回条目对应的消息原文快照。支持按角色 / 范围 /
   * 渠道 / 关键词 / 时间过滤，limit + offset 分页。
   */
  function listRecords(input = {}) {
    ensureRepository()
    const roleId = String(input.roleId || '').trim()
    const scopeRaw = String(input.memoryScope || input.scope || '').trim()
    const memoryScope = scopeRaw === 'privacy' ? 'privacy' : scopeRaw === 'all' || !scopeRaw ? '' : 'normal'
    const channelId = String(input.channelId || '').trim()
    const query = String(input.q || input.query || '').trim().toLowerCase()
    const timeStart = input.timeStart || input.time_start || ''
    const timeEnd = input.timeEnd || input.time_end || ''
    let records = repo.find({ roleId: roleId || undefined, scope: memoryScope === 'normal' ? 'normal' : undefined })
    // 隐私记忆按 `privacy:<channel>` 存储：未指定渠道时展示全部隐私记忆，
    // 指定渠道时只展示该渠道的隐私记忆。
    if (memoryScope === 'privacy') {
      records = records.filter(record => String(record.memory_scope || '').startsWith(channelId ? `privacy:${channelId}` : 'privacy:'))
    }
    if (channelId) records = records.filter(record => String(record.source_channel_id || '') === channelId)
    if (query) records = records.filter(record => `${record.summary || ''} ${record.keywords || ''}`.toLowerCase().includes(query))
    if (timeStart) {
      const from = timeToMs(timeStart)
      if (from) records = records.filter(record => timeToMs(record.ended_at) >= from || timeToMs(record.started_at) >= from)
    }
    if (timeEnd) {
      const to = timeToMs(timeEnd)
      if (to) records = records.filter(record => timeToMs(record.started_at) <= to || timeToMs(record.ended_at) <= to)
    }
    records = records.slice().sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
    const total = records.length
    const limit = clampNumber(Number(input.limit) || 30, 1, 200, 30)
    const offset = clampNumber(Number(input.offset) || 0, 0, 1000000, 0)
    const page = records.slice(offset, offset + limit)
    return {
      ok: true,
      total,
      offset,
      limit,
      returned: page.length,
      records: page.map(record =>
        recordToDTO(record, {
          includeMessages: input.includeMessages === true || input.include_messages === true,
        }),
      ),
    }
  }

  function getRecord(input = {}) {
    ensureRepository()
    const id = String(input.id || input.recordId || input.record_id || '').trim()
    if (!id) return { ok: false, code: 'MISSING_ID', error: '缺少记忆条目 id。' }
    const record = repo.records.find(item => String(item.id) === id)
    if (!record) return { ok: false, code: 'NOT_FOUND', error: '记忆条目不存在。' }
    return { ok: true, record: recordToDTO(record, { includeMessages: true }) }
  }

  /** 管理页筛选下拉：当前记忆库里出现过哪些角色 / 范围 / 渠道。 */
  function listRoles() {
    ensureRepository()
    const groups = new Map()
    for (const record of repo.records) {
      const roleId = String(record.role_id || '').trim()
      if (!roleId) continue
      const memoryScope = String(record.memory_scope || 'normal')
      const channelId = String(record.source_channel_id || '')
      const key = `${roleId}\u0000${memoryScope}\u0000${channelId}`
      let item = groups.get(key)
      if (!item) {
        item = { roleId, roleName: '', memoryScope, channelId, group: '', count: 0, lastAt: '' }
        groups.set(key, item)
      }
      item.count += 1
      const at = String(record.updated_at || record.created_at || '')
      if (at && at > item.lastAt) item.lastAt = at
      const group = String(record.source_group || '')
      if (group && !item.group) item.group = group
    }
    const roles = [...groups.values()]
      .map(item => {
        let roleName = ''
        try {
          const conv = sessions?.get?.(item.roleId)
          roleName = String(conv?.name || conv?.meta?.name || '')
        } catch (_) {
          /* 角色可能已被删除，保留 roleId 即可 */
        }
        return { ...item, roleName }
      })
      .sort((a, b) => String(b.lastAt).localeCompare(String(a.lastAt)))
    return { ok: true, roles }
  }

  const service = {
    name: 'memories',
    ingest,
    search,
    listRecords,
    getRecord,
    listRoles,
    stats: () => {
      ensureRepository()
      return repo.stats()
    },
    preferences: () => ({ ...memoryPreferences() }),
    reload: () => {
      ensureRepository()
      repo.records = []
      repo.roundIds = new Map()
      if (repo.driver === 'sqlite') repo.loadSqlite()
      else if (existsSync(repo.file)) {
        try {
          const data = JSON.parse(readFileSync(repo.file, 'utf8'))
          repo.records = Array.isArray(data?.records) ? data.records : []
        } catch (_) {
          repo.records = []
        }
      }
      repo.reindex()
      return repo.stats()
    },
  }

  ctx.provide('memories', service, { type: 'singleton' })
  ctx.effect(() => () => {
    try {
      repo.db?.close?.()
    } catch (_) {
      /* ignore */
    }
  })

  const readJsonBody = (req, limit) => httpApi.readBody(req, limit)

  httpApi.route('GET', '/api/memory/status', async (req, res) => {
    ensureRepository()
    const config = embeddingConfig()
    const summary = summaryConfig()
    const stats = repo.stats()
    httpApi.sendJson(res, 200, {
      ok: true,
      database: { driver: stats.driver, file: stats.file, records: stats.records, rounds: stats.rounds },
      embedding: {
        configured: !!(config.provider && config.model),
        provider: config.provider,
        model: config.model,
        dimension: config.dimension,
      },
      summary: {
        configured: !!summary,
        provider: summary?.provider || '',
        model: summary?.model || '',
        everyRounds: clampNumber(memoryPreferences().summaryRounds, 2, MAX_EVERY_ROUNDS, DEFAULT_EVERY_ROUNDS),
      },
    })
  })

  httpApi.route('POST', '/api/memory/ingest', async (req, res) => {
    try {
      const body = await readJsonBody(req, 16 * 1024 * 1024)
      const result = await service.ingest(body || {})
      if (result.ok === false) return httpApi.sendJson(res, 400, result)
      httpApi.sendJson(res, 200, result)
    } catch (err) {
      httpApi.sendError(res, err?.status || 502, err?.message || '记忆写入失败')
    }
  })

  httpApi.route('POST', '/api/memory/search', async (req, res) => {
    try {
      const body = await readJsonBody(req, 4 * 1024 * 1024)
      const result = await service.search(body || {})
      httpApi.sendJson(res, 200, result)
    } catch (err) {
      httpApi.sendError(res, err?.status || 502, err?.message || '记忆检索失败')
    }
  })

  /** 记忆管理页：条目列表（默认不含 messages，详情接口才展开原文快照）。 */
  httpApi.route('GET', '/api/memory/records', async (req, res, params, url) => {
    try {
      const query = url?.searchParams
      const result = service.listRecords({
        roleId: query?.get('roleId') || query?.get('role_id') || '',
        memoryScope: query?.get('scope') || query?.get('memoryScope') || '',
        channelId: query?.get('channelId') || query?.get('channel_id') || '',
        q: query?.get('q') || query?.get('query') || '',
        timeStart: query?.get('timeStart') || query?.get('time_start') || '',
        timeEnd: query?.get('timeEnd') || query?.get('time_end') || '',
        limit: query?.get('limit'),
        offset: query?.get('offset'),
        includeMessages: query?.get('includeMessages') === '1' || query?.get('include_messages') === '1',
      })
      httpApi.sendJson(res, 200, result)
    } catch (err) {
      httpApi.sendError(res, err?.status || 500, err?.message || '记忆条目读取失败')
    }
  })

  /** 记忆条目详情：包含该条目对应的消息原文快照。 */
  httpApi.route('GET', '/api/memory/records/:id', async (req, res, params) => {
    try {
      const result = service.getRecord({ id: params.id })
      if (result.ok === false) return httpApi.sendError(res, 404, result.error)
      httpApi.sendJson(res, 200, result)
    } catch (err) {
      httpApi.sendError(res, err?.status || 500, err?.message || '记忆条目读取失败')
    }
  })

  /** 记忆管理页筛选：有哪些角色 / 范围 / 渠道产生过记忆。 */
  httpApi.route('GET', '/api/memory/roles', async (req, res) => {
    try {
      httpApi.sendJson(res, 200, service.listRoles())
    } catch (err) {
      httpApi.sendError(res, err?.status || 500, err?.message || '记忆角色列表读取失败')
    }
  })

  httpApi.route('GET', '/api/memory/summaries', async (req, res, params, url) => {
    ensureRepository()
    const roleId = String(url?.searchParams?.get('roleId') || '')
    const memoryScope = url?.searchParams?.get('scope') === 'privacy' ? 'privacy' : 'normal'
    const channelId = String(url?.searchParams?.get('channelId') || '')
    const scopeKey = memoryScope === 'privacy' ? `privacy:${channelId || 'unknown'}` : 'normal'
    const records = repo
      .list({ roleId, scope: scopeKey })
      .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
      .map(record => {
        const { messages: _messages, ...rest } = recordToDTO(record)
        return rest
      })
    httpApi.sendJson(res, 200, { ok: true, role_id: roleId, memory_scope: memoryScope, total: records.length, summaries: records })
  })

  httpApi.registerCapability?.('memory-vector')
  ctx.logger.info(`长期记忆库就绪（${repo.driver} · ${service.stats().records} 条概括）`)
}
