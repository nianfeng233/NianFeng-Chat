/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * V? · library-view
 * 「记忆与知识库」独立视图：
 *   - 记忆库：读取 /api/memory/records，列出长期记忆概括，展开后显示该条目
 *     保存的消息原文快照（即记忆总结时对应的原始消息）；
 *   - 知识库：读取知识库扩展的 /api/knowledge/entries，浏览条目并展开全文、
 *     标签、目录与历史版本摘要。
 *
 * 页面只读，不提供编辑 / 删除入口；知识库未安装时给出安装提示。
 */
export const name = 'library-view'
export const version = '1.0.0'
export const displayName = '视图 · 记忆与知识库'
export const description = '独立视图：浏览长期记忆条目与对应消息原文，以及知识库条目全文与历史。'
export const author = '念风内核'
export const icon = '🧠'
export const core = false
export const enabled = true
export const depends = {
  'event-bus': '*',
  'view-router': '^1.0.0',
}
export const optionalDepends = {
  'backend-client': '>=1.0.0',
  'memory-store': '^1.0.0',
  'session-service': '>=2.0.0',
}
export const inject = ['view-router', 'event-bus', 'api?', 'memory-store?', 'session-service?']
export const provides = [{ name: 'library-view', type: 'singleton' }]

import { useStyle } from '../../../src/util/style.mjs'
import { LIBRARY_CSS } from './style.mjs'

const PAGE_SIZE = 20
const ROLE_LABEL = { user: '用户', assistant: '角色', system: '系统' }

const escapeHtml = value =>
  String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch])

const shortText = (value, max = 220) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max)}…` : text
}

const fmtTime = value => {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  const pad = n => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

const scopeLabel = scope => (scope === 'privacy' ? '隐私记忆' : scope === 'normal' ? '普通记忆' : String(scope || '记忆'))

const imageCountOf = message => Number(message?.image_count) || 0

export function apply(ctx) {
  const router = ctx.inject('view-router')
  useStyle(ctx, LIBRARY_CSS)

  const getService = name => ctx.registry.get(name) || null

  router.register('library', {
    label: '记忆与知识库',
    icon: '🧠',
    order: 25,
    rail: true,
    fullWidth: true,
    lazy: true,
    main(container) {
      const memoryService = () => getService('memory-store')
      const sessionService = () => getService('session-service')
      const client = () => getService('api')
      let disposed = false

      const state = {
        tab: 'memory',
        memory: {
          loading: false,
          error: '',
          roles: [],
          roleId: '',
          scope: '',
          q: '',
          records: [],
          total: 0,
          details: new Map(),
          detailLoading: new Set(),
          detailErrors: new Map(),
          expanded: new Set(),
        },
        knowledge: {
          loaded: false,
          /**
           * true = 知识库扩展未安装 / 后端桥未加载；此时页面给出安装说明，
           * 不再反复请求不存在的接口。
           */
          missing: false,
          loading: false,
          error: '',
          q: '',
          path: '',
          records: [],
          total: 0,
          details: new Map(),
          detailLoading: new Set(),
          detailErrors: new Map(),
          expanded: new Set(),
        },
      }

      container.innerHTML = `
        <div class="lib-page">
          <div class="lib-header">
            <div>
              <div class="lib-title">记忆与知识库</div>
              <div class="lib-sub">
                查看长期记忆总结出来的片段及其对应的消息原文，以及知识库里已经保存的条目。
                数据来自本机后端，页面只读。
              </div>
            </div>
            <div class="lib-tabs" role="tablist">
              <button class="lib-tab active" data-lib-tab="memory" role="tab">🧠 记忆库</button>
              <button class="lib-tab" data-lib-tab="knowledge" role="tab">📚 知识库</button>
            </div>
          </div>

          <section class="lib-panel" data-lib-panel="memory">
            <div class="lib-toolbar">
              <select data-lib-memory-role title="按角色筛选"><option value="">全部角色</option></select>
              <select data-lib-memory-scope title="按记忆范围筛选">
                <option value="">全部范围</option>
                <option value="normal">普通记忆</option>
                <option value="privacy">隐私记忆</option>
              </select>
              <input data-lib-memory-q type="search" placeholder="搜索记忆概括 / 关键词…" />
              <button class="outline-btn" data-lib-memory-search>搜索</button>
              <button class="outline-btn" data-lib-memory-refresh>刷新</button>
              <span class="lib-stats" data-lib-memory-stats></span>
            </div>
            <div class="lib-list" data-lib-memory-list>
              <div class="lib-loading"><i></i>正在读取记忆库…</div>
            </div>
            <div class="lib-more"><button class="outline-btn" data-lib-memory-more hidden>加载更多</button></div>
          </section>

          <section class="lib-panel" data-lib-panel="knowledge" hidden>
            <div class="lib-toolbar">
              <input data-lib-knowledge-q type="search" placeholder="搜索标题 / 正文 / 标签…" />
              <input data-lib-knowledge-path type="text" placeholder="目录前缀，如 个人资料/偏好" />
              <button class="outline-btn" data-lib-knowledge-search>搜索</button>
              <button class="outline-btn" data-lib-knowledge-refresh>刷新</button>
              <span class="lib-stats" data-lib-knowledge-stats></span>
            </div>
            <div class="lib-list" data-lib-knowledge-list>
              <div class="lib-loading"><i></i>正在读取知识库…</div>
            </div>
            <div class="lib-more"><button class="outline-btn" data-lib-knowledge-more hidden>加载更多</button></div>
          </section>
        </div>`

      const el = {
        tabs: [...container.querySelectorAll('[data-lib-tab]')],
        panels: {
          memory: container.querySelector('[data-lib-panel="memory"]'),
          knowledge: container.querySelector('[data-lib-panel="knowledge"]'),
        },
        memoryRole: container.querySelector('[data-lib-memory-role]'),
        memoryScope: container.querySelector('[data-lib-memory-scope]'),
        memoryQ: container.querySelector('[data-lib-memory-q]'),
        memoryList: container.querySelector('[data-lib-memory-list]'),
        memoryStats: container.querySelector('[data-lib-memory-stats]'),
        memoryMore: container.querySelector('[data-lib-memory-more]'),
        knowledgeQ: container.querySelector('[data-lib-knowledge-q]'),
        knowledgePath: container.querySelector('[data-lib-knowledge-path]'),
        knowledgeList: container.querySelector('[data-lib-knowledge-list]'),
        knowledgeStats: container.querySelector('[data-lib-knowledge-stats]'),
        knowledgeMore: container.querySelector('[data-lib-knowledge-more]'),
      }

      const setHidden = (element, hidden) => {
        if (!element) return
        if (hidden) element.setAttribute('hidden', '')
        else element.removeAttribute('hidden')
      }

      const valueOf = selector => String(container.querySelector(selector)?.value ?? '').trim()

      /* ---------------- 记忆库 ---------------- */

      const callMemoryRecords = async params => {
        const service = memoryService()
        if (service?.listRecords) return service.listRecords(params)
        const api = client()
        if (!api?.get) return { ok: false, code: 'NO_BACKEND', error: '后端连接不可用，无法读取记忆库。' }
        const query = new URLSearchParams()
        const put = (key, value) => {
          const text = String(value ?? '').trim()
          if (text) query.set(key, text)
        }
        put('roleId', params.roleId)
        put('scope', params.memoryScope)
        put('q', params.q)
        put('limit', params.limit)
        put('offset', params.offset)
        try {
          return await api.get(`/memory/records${query.toString() ? `?${query.toString()}` : ''}`, { timeoutMs: 60000 })
        } catch (err) {
          return { ok: false, code: 'MEMORY_RECORDS_FAILED', error: String(err?.message || err), status: err?.status }
        }
      }

      const callMemoryRecord = async id => {
        const service = memoryService()
        if (service?.getRecord) return service.getRecord(id)
        const api = client()
        if (!api?.get) return { ok: false, code: 'NO_BACKEND', error: '后端连接不可用，无法读取记忆原文。' }
        try {
          return await api.get(`/memory/records/${encodeURIComponent(id)}`, { timeoutMs: 60000 })
        } catch (err) {
          return { ok: false, code: 'MEMORY_RECORD_FAILED', error: String(err?.message || err) }
        }
      }

      const callMemoryRoles = async () => {
        const service = memoryService()
        if (service?.listRoles) return service.listRoles()
        const api = client()
        if (!api?.get) return { ok: false, code: 'NO_BACKEND', error: '后端连接不可用。' }
        try {
          return await api.get('/memory/roles', { timeoutMs: 30000 })
        } catch (err) {
          return { ok: false, code: 'MEMORY_ROLES_FAILED', error: String(err?.message || err) }
        }
      }

      const roleNameFromSession = roleId => {
        try {
          return String(sessionService()?.get?.(roleId)?.name || '')
        } catch (_) {
          return ''
        }
      }

      const renderMemoryRoles = () => {
        if (!el.memoryRole) return
        const selected = state.memory.roleId
        const options = state.memory.roles
          .map(role => {
            const id = String(role.roleId || '')
            if (!id) return ''
            const name = role.roleName || roleNameFromSession(id)
            return `<option value="${escapeHtml(id)}">${escapeHtml(name ? `${name}（${id}）` : id)}</option>`
          })
          .join('')
        el.memoryRole.innerHTML = `<option value="">全部角色</option>${options}`
        const ids = state.memory.roles.map(role => String(role.roleId || ''))
        if (selected && ids.includes(selected)) el.memoryRole.value = selected
        else {
          el.memoryRole.value = ''
          state.memory.roleId = ''
        }
      }

      const loadMemoryRoles = async () => {
        const result = await callMemoryRoles()
        if (disposed || result?.ok !== true) return
        const byRole = new Map()
        for (const row of result.roles || []) {
          const id = String(row.roleId || '').trim()
          if (!id) continue
          const item = byRole.get(id) || { roleId: id, roleName: '', count: 0 }
          item.count += Number(row.count) || 0
          if (row.roleName) item.roleName = String(row.roleName)
          byRole.set(id, item)
        }
        state.memory.roles = [...byRole.values()].sort((a, b) => b.count - a.count)
        renderMemoryRoles()
      }

      const loadMemory = async (append = false) => {
        const memory = state.memory
        if (memory.loading) return
        memory.loading = true
        memory.error = ''
        renderMemory()
        const offset = append ? memory.records.length : 0
        const result = await callMemoryRecords({
          roleId: memory.roleId,
          memoryScope: memory.scope,
          q: memory.q,
          limit: PAGE_SIZE,
          offset,
        })
        if (disposed) return
        memory.loading = false
        if (result?.ok !== true) {
          memory.error =
            result?.status === 404
              ? '后端还没有记忆条目接口：请重启念风后端后再点「刷新」。'
              : result?.error || '记忆库读取失败。'
          renderMemory()
          return
        }
        memory.records = append ? [...memory.records, ...(result.records || [])] : result.records || []
        memory.total = Number(result.total) || 0
        renderMemory()
      }

      const openMemoryDetail = async id => {
        const memory = state.memory
        if (!id || memory.details.has(id) || memory.detailLoading.has(id)) return
        memory.detailLoading.add(id)
        memory.detailErrors.delete(id)
        renderMemory()
        const result = await callMemoryRecord(id)
        if (disposed) return
        memory.detailLoading.delete(id)
        if (result?.ok === true && result.record) memory.details.set(id, result.record)
        else memory.detailErrors.set(id, result?.error || '记忆原文读取失败。')
        renderMemory()
      }

      const toggleMemory = id => {
        const memory = state.memory
        if (memory.expanded.has(id)) {
          memory.expanded.delete(id)
          renderMemory()
          return
        }
        memory.expanded.add(id)
        renderMemory()
        openMemoryDetail(id)
      }

      const renderMessage = (message, record) => {
        const role = ['user', 'assistant', 'system'].includes(message?.role) ? message.role : 'user'
        const roleName = role === 'assistant' ? String(record?.role_name || '').trim() : ''
        const sender = String(message?.sender_name || '').trim()
        const senderLabel = roleName && sender.startsWith(roleName) ? '' : sender
        const images = imageCountOf(message)
        const content = String(message?.content || '').trim() || (images ? `[图片×${images}]` : '（空消息）')
        return `<div class="lib-message lib-message-${role}">
          <div class="lib-message-head">
            <span>${escapeHtml(roleName || ROLE_LABEL[role])}${senderLabel ? ` · ${escapeHtml(senderLabel)}` : ''}</span>
            <span>${escapeHtml(fmtTime(message?.timestamp) || (message?.seq ? `#${message.seq}` : ''))}</span>
          </div>
          <div class="lib-message-body">${escapeHtml(content)}</div>
          ${
            images
              ? `<div class="lib-message-tags"><span class="lib-tag accent">图片 × ${images}</span></div>`
              : ''
          }
        </div>`
      }

      const renderMemoryDetail = record => {
        const messages = Array.isArray(record?.messages) ? record.messages : []
        const source = record?.source || {}
        const sourceText = [source.group, source.channel_id, source.conversation_id].filter(Boolean).join(' · ')
        return `
          <div class="lib-label">记忆概括</div>
          <div class="lib-summary-text">${escapeHtml(record?.summary || '（空概括）')}</div>
          <div class="lib-detail-grid">
            <div class="lib-ball"><b>角色</b><span>${escapeHtml(record?.role_id || '—')}</span></div>
            <div class="lib-ball"><b>范围</b><span>${escapeHtml(scopeLabel(record?.memory_scope))}</span></div>
            <div class="lib-ball"><b>来源</b><span>${escapeHtml(sourceText || '—')}</span></div>
            <div class="lib-ball"><b>时间</b><span>${escapeHtml(fmtTime(record?.updated_at || record?.created_at) || '—')}</span></div>
            <div class="lib-ball"><b>规模</b><span>${Number(record?.round_count) || 0} 轮 · ${Number(record?.message_count) || messages.length} 条消息</span></div>
            <div class="lib-ball"><b>向量</b><span>${record?.embedding?.enabled ? `已向量化（${record.embedding.dimension || '?'} 维）` : '仅关键词'}</span></div>
          </div>
          <div class="lib-label" style="margin-top:12px">对应消息原文（${messages.length} 条）</div>
          ${
            messages.length
              ? messages.map(message => renderMessage(message, record)).join('')
              : '<div class="lib-empty">这条记忆没有保存消息原文快照。</div>'
          }`
      }

      const renderMemory = () => {
        const memory = state.memory
        if (!el.memoryList) return
        if (el.memoryStats) {
          el.memoryStats.textContent = memory.loading
            ? '正在读取…'
            : `共 ${memory.total} 条记忆 · 已显示 ${memory.records.length} 条`
        }
        setHidden(el.memoryMore, memory.loading || memory.records.length >= memory.total || !memory.total)
        if (memory.error) {
          el.memoryList.innerHTML = `<div class="lib-error">${escapeHtml(memory.error)}</div>`
          return
        }
        if (memory.loading && !memory.records.length) {
          el.memoryList.innerHTML = '<div class="lib-loading"><i></i>正在读取记忆库…</div>'
          return
        }
        if (!memory.records.length) {
          el.memoryList.innerHTML = `
            <div class="lib-empty">
              还没有记忆条目。<br />
              长期记忆会在角色每完成若干轮对话后自动概括；也可以先在
              <b>设置 → 模型 → 记忆模型</b> 配置概括 / 向量模型。
            </div>`
          return
        }
        el.memoryList.innerHTML = memory.records
          .map(record => {
            const id = String(record.id || '')
            const open = memory.expanded.has(id)
            const detail = memory.details.get(id)
            const loading = memory.detailLoading.has(id)
            const error = memory.detailErrors.get(id)
            const detailHtml = !open
              ? ''
              : loading
                ? '<div class="lib-loading"><i></i>正在读取消息原文…</div>'
                : detail
                  ? renderMemoryDetail(detail)
                  : `<div class="lib-error">${escapeHtml(error || '记忆原文读取失败。')}</div>`
            return `<article class="lib-card${open ? ' open' : ''}" data-lib-memory-card="${escapeHtml(id)}">
              <div class="lib-card-head">
                <div class="lib-card-main">
                  <div class="lib-card-title">${escapeHtml(record.summary || '（空概括）')}</div>
                  <div class="lib-card-meta">
                    角色 ${escapeHtml(record.role_id || '—')} · ${escapeHtml(scopeLabel(record.memory_scope))}
                    · 来源 ${escapeHtml([record.source?.group, record.source?.channel_id].filter(Boolean).join(' / ') || '—')}
                    · ${escapeHtml(fmtTime(record.updated_at || record.created_at) || '—')}
                    · ${Number(record.round_count) || 0} 轮 / ${Number(record.message_count) || 0} 条
                  </div>
                </div>
                <div class="lib-card-actions">
                  <button class="outline-btn" data-lib-memory-toggle="${escapeHtml(id)}" ${loading ? 'disabled' : ''}>
                    ${open ? '收起原文' : '查看原文'}
                  </button>
                </div>
              </div>
              <div class="lib-card-detail"${open ? '' : ' hidden'}>${detailHtml}</div>
            </article>`
          })
          .join('')
      }

      /* ---------------- 知识库 ---------------- */

      const knowledgeMissingHtml = () => `
        <div class="lib-empty">
          还没有检测到知识库扩展。<br />
          请先安装 <b>knowledge-base</b> 扩展（v1.0.1+ 才带管理页读取接口），然后在
          「设置 → 插件」点一次「重新扫描」；若仍不显示，重启念风后端后再试。
        </div>
        <div class="lib-more"><button class="outline-btn" data-lib-knowledge-rescan>重新扫描插件</button></div>`

      const callKnowledgeList = async params => {
        const api = client()
        if (!api?.get) return { ok: false, code: 'NO_BACKEND', error: '后端连接不可用，无法读取知识库。' }
        const query = new URLSearchParams()
        if (params.q) query.set('q', params.q)
        if (params.path) query.set('path', params.path)
        query.set('limit', String(params.limit || PAGE_SIZE))
        query.set('offset', String(params.offset || 0))
        try {
          return await api.get(`/knowledge/entries?${query.toString()}`, { timeoutMs: 60000 })
        } catch (err) {
          return { ok: false, code: 'KNOWLEDGE_LIST_FAILED', error: String(err?.message || err), status: err?.status }
        }
      }

      const callKnowledgeDetail = async id => {
        const api = client()
        if (!api?.get) return { ok: false, code: 'NO_BACKEND', error: '后端连接不可用。' }
        try {
          return await api.get(`/knowledge/entries/${encodeURIComponent(id)}`, { timeoutMs: 60000 })
        } catch (err) {
          return { ok: false, code: 'KNOWLEDGE_READ_FAILED', error: String(err?.message || err), status: err?.status }
        }
      }

      const loadKnowledge = async (append = false) => {
        const knowledge = state.knowledge
        if (knowledge.loading || knowledge.missing) return
        knowledge.loading = true
        knowledge.error = ''
        renderKnowledge()
        const offset = append ? knowledge.records.length : 0
        const result = await callKnowledgeList({ q: knowledge.q, path: knowledge.path, limit: PAGE_SIZE, offset })
        if (disposed) return
        knowledge.loading = false
        knowledge.loaded = true
        if (result?.ok !== true || !Array.isArray(result.entries)) {
          if (result?.status === 404 || result?.raw) {
            knowledge.missing = true
            knowledge.error = ''
          } else {
            knowledge.error = result?.error || '知识库读取失败。'
          }
          renderKnowledge()
          return
        }
        knowledge.missing = false
        knowledge.records = append ? [...knowledge.records, ...result.entries] : result.entries
        knowledge.total = Number(result.total) || 0
        renderKnowledge()
      }

      const openKnowledgeDetail = async id => {
        const knowledge = state.knowledge
        if (!id || knowledge.details.has(id) || knowledge.detailLoading.has(id)) return
        knowledge.detailLoading.add(id)
        knowledge.detailErrors.delete(id)
        renderKnowledge()
        const result = await callKnowledgeDetail(id)
        if (disposed) return
        knowledge.detailLoading.delete(id)
        if (result?.ok === true && result.entry) knowledge.details.set(id, result.entry)
        else knowledge.detailErrors.set(id, result?.error || '知识条目读取失败。')
        renderKnowledge()
      }

      const toggleKnowledge = id => {
        const knowledge = state.knowledge
        if (knowledge.expanded.has(id)) {
          knowledge.expanded.delete(id)
          renderKnowledge()
          return
        }
        knowledge.expanded.add(id)
        renderKnowledge()
        openKnowledgeDetail(id)
      }

      const renderKnowledgeDetail = entry => {
        const tags = Array.isArray(entry.tags) ? entry.tags : []
        const history = Array.isArray(entry.history) ? entry.history : []
        const truncatedHint = entry.truncated
          ? `<div class="lib-error">内容较长，当前页只显示前 ${Number(entry.content_length) || ''} 字符中的一部分（已显示到 ${Number(entry.content?.length) || 0} 字符）。</div>`
          : ''
        return `
          <div class="lib-detail-grid">
            <div class="lib-ball"><b>目录</b><span>${escapeHtml(entry.path || '根目录')}</span></div>
            <div class="lib-ball"><b>版本</b><span>r${Number(entry.revision) || 1}</span></div>
            <div class="lib-ball"><b>更新时间</b><span>${escapeHtml(fmtTime(entry.updated_at) || '—')}</span></div>
            <div class="lib-ball"><b>字数</b><span>${Number(entry.content_length) || String(entry.content || '').length}</span></div>
          </div>
          <div class="lib-message-tags" style="margin-bottom:10px">
            ${tags.length ? tags.map(tag => `<span class="lib-tag">${escapeHtml(tag)}</span>`).join('') : '<span class="lib-tag">无标签</span>'}
          </div>
          ${truncatedHint}
          <div class="lib-label">全文</div>
          <div class="lib-content">${escapeHtml(entry.content || '（空内容）')}</div>
          ${
            history.length
              ? `<div class="lib-label" style="margin-top:12px">历史版本（${history.length}）</div>
                 <div class="lib-history">
                   ${history
                     .map(
                       item => `<div class="lib-history-item">
                         <span class="lib-tag accent">r${Number(item.revision) || 1}</span>
                         <span>${escapeHtml(item.title || '')}</span>
                         <span>${escapeHtml(fmtTime(item.updated_at) || '')}</span>
                         <span>${escapeHtml(item.reason || '')}</span>
                         <span>${Number(item.content_length) || 0} 字</span>
                       </div>`,
                     )
                     .join('')}
                 </div>`
              : ''
          }`
      }

      const renderKnowledge = () => {
        const knowledge = state.knowledge
        if (!el.knowledgeList) return
        if (el.knowledgeStats) {
          el.knowledgeStats.textContent = knowledge.loading
            ? '正在读取…'
            : knowledge.missing
              ? '知识库扩展未加载'
              : `共 ${knowledge.total} 条知识 · 已显示 ${knowledge.records.length} 条`
        }
        setHidden(el.knowledgeMore, knowledge.loading || knowledge.missing || knowledge.records.length >= knowledge.total || !knowledge.total)
        if (knowledge.missing) {
          el.knowledgeList.innerHTML = knowledgeMissingHtml()
          return
        }
        if (knowledge.error) {
          el.knowledgeList.innerHTML = `<div class="lib-error">${escapeHtml(knowledge.error)}</div>`
          return
        }
        if (knowledge.loading && !knowledge.records.length) {
          el.knowledgeList.innerHTML = '<div class="lib-loading"><i></i>正在读取知识库…</div>'
          return
        }
        if (!knowledge.records.length) {
          el.knowledgeList.innerHTML = `
            <div class="lib-empty">
              知识库还是空的。<br />
              让角色把值得长期保留的资料、设定或偏好写进知识库后，这里就会显示条目。
            </div>`
          return
        }
        el.knowledgeList.innerHTML = knowledge.records
          .map(entry => {
            const id = String(entry.id || '')
            const open = knowledge.expanded.has(id)
            const detail = knowledge.details.get(id)
            const loading = knowledge.detailLoading.has(id)
            const error = knowledge.detailErrors.get(id)
            const detailHtml = !open
              ? ''
              : loading
                ? '<div class="lib-loading"><i></i>正在读取全文…</div>'
                : detail
                  ? renderKnowledgeDetail(detail)
                  : `<div class="lib-error">${escapeHtml(error || '知识条目读取失败。')}</div>`
            return `<article class="lib-card${open ? ' open' : ''}" data-lib-knowledge-card="${escapeHtml(id)}">
              <div class="lib-card-head">
                <div class="lib-card-main">
                  <div class="lib-card-title">${escapeHtml(entry.title || '（无标题）')}</div>
                  <div class="lib-card-meta">
                    ${escapeHtml(entry.path || '根目录')}
                    · ${Number(entry.revision) || 1} 版
                    · ${escapeHtml(fmtTime(entry.updated_at) || '—')}
                    · ${Number(entry.content_length) || 0} 字
                  </div>
                  <div class="lib-card-title" style="margin-top:7px;color:var(--text-3);font-size:12px">${escapeHtml(shortText(entry.preview, 260))}</div>
                  ${
                    Array.isArray(entry.tags) && entry.tags.length
                      ? `<div class="lib-message-tags">${entry.tags.map(tag => `<span class="lib-tag">${escapeHtml(tag)}</span>`).join('')}</div>`
                      : ''
                  }
                </div>
                <div class="lib-card-actions">
                  <button class="outline-btn" data-lib-knowledge-toggle="${escapeHtml(id)}" ${loading ? 'disabled' : ''}>
                    ${open ? '收起全文' : '查看全文'}
                  </button>
                </div>
              </div>
              <div class="lib-card-detail"${open ? '' : ' hidden'}>${detailHtml}</div>
            </article>`
          })
          .join('')
      }

      /* ---------------- 标签切换与事件 ---------------- */

      const showTab = tab => {
        state.tab = tab === 'knowledge' ? 'knowledge' : 'memory'
        for (const button of el.tabs) {
          const active = button.dataset?.libTab === state.tab || button.getAttribute('data-lib-tab') === state.tab
          button.classList.toggle('active', active)
        }
        setHidden(el.panels.memory, state.tab !== 'memory')
        setHidden(el.panels.knowledge, state.tab !== 'knowledge')
        if (state.tab === 'knowledge' && !state.knowledge.loaded && !state.knowledge.loading && !state.knowledge.missing) {
          loadKnowledge()
        }
      }

      const refreshMemory = async () => {
        state.memory.roleId = valueOf('[data-lib-memory-role]')
        state.memory.scope = valueOf('[data-lib-memory-scope]')
        state.memory.q = valueOf('[data-lib-memory-q]')
        state.memory.records = []
        state.memory.total = 0
        state.memory.expanded.clear()
        await loadMemoryRoles()
        await loadMemory(false)
      }

      const searchMemory = () => {
        state.memory.q = valueOf('[data-lib-memory-q]')
        state.memory.records = []
        state.memory.total = 0
        state.memory.expanded.clear()
        loadMemory(false)
      }

      const refreshKnowledge = () => {
        if (state.knowledge.missing) {
          state.knowledge.missing = false
          state.knowledge.loaded = false
        }
        state.knowledge.q = valueOf('[data-lib-knowledge-q]')
        state.knowledge.path = valueOf('[data-lib-knowledge-path]')
        state.knowledge.records = []
        state.knowledge.total = 0
        state.knowledge.expanded.clear()
        loadKnowledge(false)
      }

      const onClick = event => {
        const target = event?.target
        if (!target || typeof target.closest !== 'function') return
        const tab = target.closest('[data-lib-tab]')
        if (tab) {
          showTab(tab.getAttribute('data-lib-tab') || tab.dataset?.libTab)
          return
        }
        const memoryToggle = target.closest('[data-lib-memory-toggle]')
        if (memoryToggle) {
          toggleMemory(memoryToggle.getAttribute('data-lib-memory-toggle'))
          return
        }
        const knowledgeToggle = target.closest('[data-lib-knowledge-toggle]')
        if (knowledgeToggle) {
          toggleKnowledge(knowledgeToggle.getAttribute('data-lib-knowledge-toggle'))
          return
        }
        if (target.closest('[data-lib-memory-refresh]') || target.closest('[data-lib-memory-search]')) {
          if (target.closest('[data-lib-memory-search]')) searchMemory()
          else refreshMemory()
          return
        }
        if (target.closest('[data-lib-memory-more]')) {
          state.memory.q = valueOf('[data-lib-memory-q]')
          loadMemory(true)
          return
        }
        if (target.closest('[data-lib-knowledge-refresh]') || target.closest('[data-lib-knowledge-search]')) {
          refreshKnowledge()
          return
        }
        if (target.closest('[data-lib-knowledge-more]')) {
          state.knowledge.q = valueOf('[data-lib-knowledge-q]')
          state.knowledge.path = valueOf('[data-lib-knowledge-path]')
          loadKnowledge(true)
          return
        }
        if (target.closest('[data-lib-knowledge-rescan]')) {
          const api = client()
          Promise.resolve(api?.rescanPlugins ? api.rescanPlugins() : api?.post?.('/plugins/rescan', {})).finally(() => {
            state.knowledge.missing = false
            state.knowledge.loaded = false
            loadKnowledge(false)
          })
        }
      }

      const onChange = event => {
        const target = event?.target
        if (!target || typeof target.closest !== 'function') return
        if (target.closest('[data-lib-memory-role]') || target.closest('[data-lib-memory-scope]')) {
          state.memory.roleId = valueOf('[data-lib-memory-role]')
          state.memory.scope = valueOf('[data-lib-memory-scope]')
          state.memory.records = []
          state.memory.total = 0
          state.memory.expanded.clear()
          loadMemory(false)
        }
      }

      const onKeyDown = event => {
        if (event?.key !== 'Enter') return
        const target = event?.target
        if (!target || typeof target.closest !== 'function') return
        if (target.closest('[data-lib-memory-q]')) searchMemory()
        else if (target.closest('[data-lib-knowledge-q]') || target.closest('[data-lib-knowledge-path]')) refreshKnowledge()
      }

      container.addEventListener('click', onClick)
      container.addEventListener('change', onChange)
      container.addEventListener('keydown', onKeyDown)

      showTab('memory')
      setHidden(el.panels.knowledge, true)
      loadMemoryRoles()
      loadMemory(false)

      return () => {
        disposed = true
        container.removeEventListener('click', onClick)
        container.removeEventListener('change', onChange)
        container.removeEventListener('keydown', onKeyDown)
        container.innerHTML = ''
      }
    },
  })

  ctx.logger.debug('记忆与知识库视图就绪')
}
