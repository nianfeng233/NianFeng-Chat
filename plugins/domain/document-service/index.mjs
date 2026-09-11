/**
 * D? · document-service
 * 资料库（文档 §3.2 / §6.3）：
 *   - 长文本、文献、资料原文存在这里，聊天记录库只保存 doc_id + 标题 + 缩略
 *   - 模型通过 read_document 按需分段加载原文，加载结果放进 role=tool
 *   - 当前实现落在前端 storage 命名空间 documents（后端 session 持久化不受影响）；
 *     未来接入 QQ / 微信等后端渠道时，只需把本服务换成调用后端文档 API 的实现
 */
export const name = 'document-service'
export const version = '1.0.0'
export const displayName = '资料库'
export const description = '业务服务 · 长资料原文存储与分段读取，聊天记录只存引用。'
export const author = '风语内核'
export const icon = '📚'
export const core = true
export const depends = { storage: '^1.0.0' }
export const inject = ['storage', 'event-bus', 'config']
export const provides = [{ name: 'document-service', type: 'singleton' }]

const NS = 'documents'
const KEY = 'data'
const MAX_DOC_CHARS = 2 * 1024 * 1024

export function apply(ctx) {
  const storage = ctx.inject('storage')
  const events = ctx.inject('event-bus')
  const config = ctx.inject('config')

  let data = storage.get(NS, KEY, null)
  if (!data || typeof data !== 'object' || typeof data.docs !== 'object') data = { docs: {}, seq: 0 }
  const persist = () => storage.set(NS, KEY, data)

  const estimateTokens = text => Math.ceil(String(text ?? '').length / 2)

  const service = {
    name: 'document-service',
    estimateTokens,

    /**
     * 存一条资料，返回只含元数据的引用。
     * @param {{title?:string, summary?:string, content?:string, content_type?:string, channelId?:string, source?:string}} input
     */
    put(input = {}) {
      const content = String(input.content ?? '')
      if (!content.trim()) throw new Error('资料内容不能为空')
      const id = input.doc_id || input.docId || `doc_${Date.now().toString(36)}${(++data.seq).toString(36)}`
      const doc = {
        doc_id: id,
        title: String(input.title || '未命名资料').slice(0, 200),
        summary: String(input.summary || content.replace(/\s+/g, ' ').trim().slice(0, 120)).slice(0, 500),
        content_type: input.content_type || 'text/plain',
        content: content.slice(0, MAX_DOC_CHARS),
        channel_id: input.channelId || null,
        source: input.source || 'nova',
        tokens: estimateTokens(content),
        length: content.length,
        created_at: new Date().toISOString(),
      }
      data.docs[id] = doc
      persist()
      events.emit('document:stored', { doc_id: id, channelId: doc.channel_id, title: doc.title })
      ctx.logger.debug(`资料已入库：${id}（${doc.length} 字）`)
      return service.reference(id)
    },

    get(docId) {
      const doc = data.docs[docId]
      return doc ? structuredClone(doc) : null
    },

    reference(docId) {
      const doc = data.docs[docId]
      if (!doc) return null
      return {
        doc_id: doc.doc_id,
        title: doc.title,
        summary: doc.summary,
        content_type: doc.content_type,
        channel_id: doc.channel_id,
        tokens: doc.tokens,
        length: doc.length,
      }
    },

    list() {
      return Object.values(data.docs).map(doc => service.reference(doc.doc_id))
    },

    /**
     * 分段读取原文，单次受 maxTokens 限制（文档 §6.5：资料加载单次限制 token）。
     * @returns {{ok:boolean, doc_id:string, title?:string, text?:string, offset?:number,
     *   next_offset?:number, total?:number, truncated?:boolean, hint?:string, error?:string}}
     */
    read(docId, { offset = 0, maxTokens = null } = {}) {
      const doc = data.docs[docId]
      if (!doc) return { ok: false, error: '资料不存在或已被清理' }
      const budget = Math.max(100, Number(maxTokens) || Number(config.get('chat.readTokens', 1500)) || 1500)
      // 中文场景约 2 字符 / token，按字符窗口切段，保证返回部分结果
      const windowChars = Math.max(200, Math.floor(budget * 2))
      const start = Math.max(0, Math.min(Number(offset) || 0, doc.content.length))
      const text = doc.content.slice(start, start + windowChars)
      const next = start + text.length
      const truncated = next < doc.content.length
      return {
        ok: true,
        doc_id: doc.doc_id,
        title: doc.title,
        content_type: doc.content_type,
        text,
        offset: start,
        next_offset: truncated ? next : null,
        total: doc.content.length,
        truncated,
        hint: truncated ? '资料较长，已返回分段；需要后续内容时带上 offset=next_offset 继续读取。' : undefined,
      }
    },

    remove(docId) {
      if (!data.docs[docId]) return false
      delete data.docs[docId]
      persist()
      return true
    },

    stats: () => ({ documents: Object.keys(data.docs).length, chars: Object.values(data.docs).reduce((sum, doc) => sum + doc.length, 0) }),
  }

  ctx.provide('document-service', service, { type: 'singleton' })
  ctx.logger.debug(`资料库就绪（${service.stats().documents} 份资料）`)
}
