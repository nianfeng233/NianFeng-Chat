/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * V? · settings-item-chat-records
 * 设置 → 聊天记录：
 *   - 图形视图：按一条一条的消息卡片查看 / 编辑，新手也能直接改
 *   - JSON 源码：高级用户可以直接编辑整段 JSON，实时校验格式
 *   - 所有修改先进入草稿；点“保存”才写回 chat-store
 *   - 单条编辑有“确认修改 / 取消”；整体有“保存 / 取消修改”
 *   - 保存前做结构校验，非法 JSON / 非法字段不会被写入
 */
export const name = 'settings-item-chat-records'
export const version = '2.0.0'
export const displayName = '设置项 · 聊天记录'
export const description = '设置页 · 图形化 / JSON 双模式查看与编辑聊天记录，草稿式保存。'
export const author = '念风内核'
export const icon = '🗂️'
export const core = true
export const depends = { 'settings-container': '^1.0.0', 'chat-store': '^1.0.0', 'session-service': '^2.0.0' }
export const inject = ['settings-container', 'chat-store', 'session-service', 'toast', 'modal?', 'event-bus']
export const provides = []

import { useStyle } from '../../../src/util/style.mjs'
import { page } from '../../../src/util/settings.mjs'
import { escapeHtml } from '../../../src/util/format.mjs'

const ROLES = ['user', 'assistant', 'system']
const VISIBILITIES = ['shareable', 'private', 'confidential']

const CSS = `
  .record-page{display:flex;gap:14px;min-height:560px;align-items:stretch}
  .record-list{
    flex:0 0 250px;min-width:210px;max-height:660px;overflow:auto;
    padding:10px;border-radius:14px;background:var(--glass-bg);border:1px solid var(--border);
  }
  .record-list-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px}
  .record-list-head strong{font-size:13px}
  .record-group{margin-bottom:10px}
  .record-group-title{padding:4px 6px;font-size:11.5px;color:var(--text-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .record-search-wrap{margin-bottom:8px}
  .record-search{width:100%;height:30px;padding:0 10px;border-radius:8px;border:1px solid var(--border);background:rgba(255,255,255,.55);color:var(--text);font-size:12px;outline:none;box-sizing:border-box}
  .record-search:focus{border-color:var(--accent)}
  .record-role{margin-bottom:6px;border-radius:10px;border:1px solid transparent;overflow:hidden}
  .record-role.expanded{border-color:var(--border);background:rgba(255,255,255,.35)}
  .record-role-head{display:flex;align-items:center;gap:7px;width:100%;padding:7px 8px;border:none;background:transparent;color:var(--text);font-size:12.5px;cursor:pointer;text-align:left}
  .record-role-head:hover{background:rgba(255,255,255,.55)}
  .record-role .chev{width:12px;flex:0 0 auto;color:var(--text-4)}
  .record-role-name{flex:1;min-width:0;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .record-role-count{flex:0 0 auto;font-size:10.5px;color:var(--text-4)}
  .record-role-body{padding:0 6px 6px 22px}
  .record-channel{display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;padding:7px 9px;margin-bottom:3px;border:none;border-radius:9px;background:transparent;color:var(--text);font-size:12px;cursor:pointer;text-align:left}
  .record-channel span{display:flex;flex-direction:column;gap:1px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .record-channel b{font-size:11.5px;color:var(--text-2);font-weight:600}
  .record-channel em{font-style:normal;font-size:10.5px;color:var(--text-4);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .record-channel small{flex:0 0 auto;color:var(--text-4);font-size:10.5px}
  .record-channel:hover{background:rgba(255,255,255,.55)}
  .record-channel.active{background:var(--accent-soft);color:var(--accent)}
  .record-empty{padding:16px 8px;color:var(--text-4);font-size:12px;text-align:center}
  .record-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:8px}
  .record-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
  .record-path{flex:1;min-width:160px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;color:var(--text-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .record-dirty{font-size:11.5px;color:#c98a2b;background:rgba(201,138,43,.12);border:1px solid rgba(201,138,43,.32);border-radius:999px;padding:2px 9px}
  .record-btn{height:30px;padding:0 12px;border-radius:8px;border:1px solid var(--border);background:rgba(255,255,255,.55);color:var(--text);font-size:12px;cursor:pointer}
  .record-btn:hover{background:rgba(255,255,255,.85)}
  .record-btn.primary{background:var(--accent);border-color:transparent;color:#fff}
  .record-btn.primary:hover{background:var(--accent-hover)}
  .record-btn.active{background:var(--accent-soft);color:var(--accent);border-color:transparent}
  .record-error{display:none;padding:8px 11px;border-radius:9px;background:rgba(198,91,91,.1);border:1px solid rgba(198,91,91,.3);color:#c65b5b;font-size:12px;line-height:1.6;white-space:pre-wrap}
  .record-error.show{display:block}
  .record-cards{flex:1;min-height:420px;max-height:660px;overflow:auto;display:flex;flex-direction:column;gap:8px;padding-right:2px}
  .record-card{padding:10px 12px;border-radius:12px;background:rgba(255,255,255,.58);border:1px solid var(--border);cursor:pointer;transition:border-color .12s ease, background .12s ease}
  .record-card:hover{border-color:var(--accent);background:rgba(255,255,255,.82)}
  .record-card.assistant{border-left:3px solid var(--accent)}
  .record-card.user{border-left:3px solid #7fb2a0}
  .record-card.system{border-left:3px solid #8b919c}
  .record-card-top{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:11.5px;color:var(--text-4)}
  .record-role{font-weight:600;color:var(--text-2);font-size:12px}
  .record-role.user{color:#3f8c6a}
  .record-role.assistant{color:var(--accent)}
  .record-card-content{margin-top:6px;font-size:12.5px;line-height:1.7;color:var(--text);white-space:pre-wrap;word-break:break-word}
  .record-card-doc{padding:6px 8px;border-radius:8px;background:rgba(90,120,180,.08);border:1px dashed rgba(90,120,180,.3);font-size:12px}
  .record-card-tag{margin-left:auto;color:var(--text-4);font-size:10.5px}
  .record-card-del{flex:0 0 auto;width:24px;height:24px;padding:0;border:none;border-radius:7px;background:transparent;color:var(--text-4);font-size:13px;line-height:1;cursor:pointer}
  .record-card-del:hover{background:rgba(198,91,91,.12);color:#c65b5b}
  .record-source{flex:1;min-height:440px;resize:vertical;padding:12px 14px;border-radius:12px;border:1px solid var(--border);background:rgba(255,255,255,.62);color:var(--text);font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12.5px;line-height:1.65;outline:none;white-space:pre;tab-size:2}
  .record-source:focus{border-color:var(--accent)}
  .record-source[hidden]{display:none}
  .record-editor-mask{position:fixed;inset:0;background:rgba(20,30,40,.35);display:none;align-items:center;justify-content:center;z-index:200}
  .record-editor-mask.show{display:flex}
  .record-editor{width:min(680px,92vw);max-height:86vh;overflow:auto;padding:16px;border-radius:16px;background:var(--panel-solid,#fff);box-shadow:0 20px 60px rgba(20,40,60,.28);display:flex;flex-direction:column;gap:10px}
  .record-editor h3{margin:0;font-size:15px}
  .record-editor label{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--text-3)}
  .record-editor input,.record-editor select,.record-editor textarea{padding:7px 9px;border-radius:8px;border:1px solid var(--border);background:rgba(255,255,255,.8);color:var(--text);font-size:12.5px;font-family:inherit;outline:none}
  .record-editor textarea{min-height:120px;resize:vertical;font-family:ui-monospace,Menlo,Consolas,monospace;line-height:1.6}
  .record-editor-row{display:flex;gap:10px;flex-wrap:wrap}
  .record-editor-row label{flex:1;min-width:140px}
  .record-editor-error{display:none;padding:7px 10px;border-radius:8px;background:rgba(198,91,91,.1);border:1px solid rgba(198,91,91,.3);color:#c65b5b;font-size:12px}
  .record-editor-error.show{display:block}
  .record-editor-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:2px}
`

export function apply(ctx) {
  const pages = ctx.inject('settings-container')
  const store = ctx.inject('chat-store')
  const sessions = ctx.inject('session-service')
  const toast = ctx.inject('toast')
  const modal = ctx.inject('modal')
  const events = ctx.inject('event-bus')

  useStyle(ctx, CSS)

  pages.register({
    id: 'chat-records',
    group: '系统',
    groupOrder: 40,
    label: '聊天记录',
    icon: '🗂️',
    order: 85,
    render(container) {
      container.innerHTML = page(
        '聊天记录',
        '图形化查看 / 编辑每个角色、每个渠道的聊天记录。所有修改先进入草稿，点「保存」才会应用；单条编辑支持「确认修改 / 取消」。',
        `
        <div class="record-page">
          <aside class="record-list">
            <div class="record-list-head"><strong>角色 / 渠道</strong><button class="record-btn" data-record-refresh-list>刷新</button></div>
              <div class="record-search-wrap">
                <input class="record-search" data-record-search placeholder="搜索角色名或渠道 ID" autocomplete="off" spellcheck="false" />
              </div>
            <div data-record-list></div>
          </aside>
          <section class="record-main">
            <div class="record-toolbar">
              <span class="record-path" data-record-path>未选择渠道</span>
              <span class="record-dirty" data-record-dirty hidden>有未保存修改</span>
              <button class="record-btn active" data-record-mode="cards">图形视图</button>
              <button class="record-btn" data-record-mode="json">JSON 源码</button>
              <button class="record-btn" data-record-add>新增消息</button>
              <button class="record-btn" data-record-reload>取消修改</button>
              <button class="record-btn" data-record-undo-save hidden>恢复上次保存前</button>
              <button class="record-btn primary" data-record-save>保存</button>
            </div>
            <div class="record-error" data-record-error></div>
            <div class="record-cards" data-record-cards></div>
            <textarea class="record-source" data-record-source spellcheck="false" hidden placeholder="[]"></textarea>
          </section>
        </div>
        <div class="record-editor-mask" data-record-editor-mask>
          <div class="record-editor" data-record-editor>
            <h3 data-editor-title>编辑消息</h3>
            <div class="record-editor-row">
              <label>role<select data-editor-field="role"><option value="user">user</option><option value="assistant">assistant</option><option value="system">system</option></select></label>
              <label>kind<select data-editor-field="kind"><option value="text">text</option><option value="document">document</option></select></label>
              <label>visibility<select data-editor-field="visibility"></select></label>
            </div>
            <label>content<textarea data-editor-field="content"></textarea></label>
            <div class="record-editor-row">
              <label>message_id<input data-editor-field="message_id" /></label>
              <label>seq<input data-editor-field="seq" type="number" min="1" step="1" /></label>
            </div>
            <div class="record-editor-row">
              <label>timestamp<input data-editor-field="timestamp" placeholder="2026-09-11T20:00:00+08:00" /></label>
              <label>sender_name<input data-editor-field="sender_name" /></label>
            </div>
            <label>meta（JSON 对象，可留空 {}）<textarea data-editor-field="meta" style="min-height:80px"></textarea></label>
            <div class="record-editor-error" data-editor-error></div>
            <div class="record-editor-actions">
              <button class="record-btn" data-editor-cancel>取消</button>
              <button class="record-btn primary" data-editor-confirm>确认修改</button>
            </div>
          </div>
        </div>`,
      )

      const listEl = container.querySelector('[data-record-list]')
      const listSearchEl = container.querySelector('[data-record-search]')
      const pathEl = container.querySelector('[data-record-path]')
      const dirtyEl = container.querySelector('[data-record-dirty]')
      const errorEl = container.querySelector('[data-record-error]')
      const cardsEl = container.querySelector('[data-record-cards]')
      const sourceEl = container.querySelector('[data-record-source]')
      const maskEl = container.querySelector('[data-record-editor-mask]')
      const editorEl = container.querySelector('[data-record-editor]')
      const editorError = container.querySelector('[data-editor-error]')
      const modeButtons = [...container.querySelectorAll('[data-record-mode]')]
      const undoLastSaveBtn = container.querySelector('[data-record-undo-save]')
      for (const select of container.querySelectorAll('[data-editor-field="visibility"]')) {
        select.innerHTML = VISIBILITIES.map(value => `<option value="${value}">${value}</option>`).join('')
      }

      const lastSavedSnapshots = new Map()
      let jsonRiskAccepted = false
      let activeChannel = null
      let draft = []
      let dirty = false
      let mode = 'cards'
      let editingIndex = -1
      let listKeyword = ''
      let listInitialized = false
      const expandedRoles = new Set()

      const setError = message => {
        if (!message) {
          errorEl.textContent = ''
          errorEl.classList.remove('show')
          return
        }
        errorEl.textContent = message
        errorEl.classList.add('show')
      }
      const setDirty = value => {
        dirty = value
        dirtyEl.hidden = !value
      }
      const labelOf = record => {
        const conv = sessions.get(record.conversationId)
        return `${conv?.name || record.roleId || '未知角色'} · ${record.channelId}`
      }
      const parseMeta = value => {
        const text = String(value || '').trim()
        if (!text) return {}
        const parsed = JSON.parse(text)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('meta 必须是 JSON 对象')
        return parsed
      }

      const validateMessages = list => {
        if (!Array.isArray(list)) return '聊天记录必须是 JSON 数组'
        const ids = new Set()
        for (let i = 0; i < list.length; i++) {
          const message = list[i]
          const prefix = `第 ${i + 1} 条消息：`
          if (!message || typeof message !== 'object' || Array.isArray(message)) return `${prefix}必须是对象`
          if (!ROLES.includes(message.role)) return `${prefix}role 必须是 user / assistant / system`
          if (message.content !== undefined && typeof message.content !== 'string') return `${prefix}content 必须是字符串`
          if (message.seq !== undefined && (!Number.isFinite(Number(message.seq)) || Number(message.seq) <= 0)) return `${prefix}seq 必须是正整数`
          if (message.timestamp && Number.isNaN(Date.parse(message.timestamp))) return `${prefix}timestamp 必须是合法时间`
          if (message.meta !== undefined && (!message.meta || typeof message.meta !== 'object' || Array.isArray(message.meta))) return `${prefix}meta 必须是对象`
          if (message.visibility !== undefined && !VISIBILITIES.includes(message.visibility)) return `${prefix}visibility 不合法`
          const id = message.message_id || message.id
          if (id) {
            if (ids.has(id)) return `${prefix}message_id 重复：${id}`
            ids.add(id)
          }
        }
        return null
      }

      const validateOne = message => validateMessages([message])

      const updateJsonSource = () => {
        sourceEl.value = JSON.stringify(draft, null, 2)
      }
      const syncUndoSaveButton = () => {
        if (!undoLastSaveBtn) return
        undoLastSaveBtn.hidden = !activeChannel || !lastSavedSnapshots.has(activeChannel)
      }

      const renderCards = () => {
        if (!draft.length) {
          cardsEl.innerHTML = '<div class="record-empty">这个渠道还没有消息，点「新增消息」开始</div>'
          return
        }
        cardsEl.innerHTML = draft
          .map((message, index) => {
            const content = message.kind === 'document'
              ? `<div class="record-card-doc">📄 ${escapeHtml(message.meta?.title || message.content || '资料')}${message.meta?.summary ? `<div>${escapeHtml(message.meta.summary)}</div>` : ''}</div>`
              : escapeHtml(String(message.content || ''))
            return `<div class="record-card ${escapeHtml(message.role || 'user')}" data-record-card="${index}">
              <div class="record-card-top">
                <span class="record-role ${escapeHtml(message.role || 'user')}">${escapeHtml(message.role || 'user')}</span>
                <span>#${escapeHtml(String(message.seq ?? index + 1))}</span>
                <span>${escapeHtml(message.time || String(message.timestamp || '').slice(11, 16) || '')}</span>
                <span>${escapeHtml(message.sender_name || '')}</span>
                <span class="record-card-tag">${escapeHtml(message.message_id || message.id || '')}</span>
                <button class="record-card-del" data-record-delete="${index}" type="button" title="删除这条消息（需点保存生效）">🗑</button>
              </div>
              <div class="record-card-content">${content}</div>
            </div>`
          })
          .join('')
        for (const card of cardsEl.querySelectorAll('[data-record-card]')) {
          card.addEventListener('click', () => openEditor(Number(card.dataset.recordCard)))
          card.querySelector('[data-record-delete]')?.addEventListener('click', event => {
            event.stopPropagation()
            const index = Number(event.currentTarget.dataset.recordDelete)
            if (!Number.isInteger(index) || index < 0 || index >= draft.length) return
            draft.splice(index, 1)
            setDirty(true)
            setError('')
            updateJsonSource()
            renderCards()
            renderList()
          })
        }
      }

      const channelKindLabel = channelId => {
        const kind = String(channelId || '').split(':')[0]
        return { nova: 'Nova 网页', 'wechat-clawbot': '微信clawbot' }[kind] || kind || '渠道'
      }

      const renderList = () => {
        const records = store.listChannels()
        if (!records.length) {
          listEl.innerHTML = '<div class="record-empty">还没有渠道记录</div>'
          return
        }
        const groups = new Map()
        for (const record of records) {
          const key = record.roleId || record.conversationId
          if (!groups.has(key)) groups.set(key, [])
          groups.get(key).push(record)
        }

        const keyword = listKeyword.trim().toLowerCase()
        const visible = []
        for (const [roleId, allItems] of groups) {
          const roleName = sessions.get(allItems[0]?.conversationId)?.name || roleId
          const roleHit = keyword && String(roleName).toLowerCase().includes(keyword)
          const matched = keyword
            ? (roleHit ? allItems : allItems.filter(record => String(record.channelId).toLowerCase().includes(keyword)))
            : allItems
          if (!matched.length) continue
          visible.push({ roleId, roleName, items: matched, allItems })
        }
        if (!visible.length) {
          listEl.innerHTML = '<div class="record-empty">没有匹配的角色或渠道</div>'
          return
        }

        if (!listInitialized) {
          listInitialized = true
          const activeOwner = visible.find(group => group.allItems.some(record => record.channelId === activeChannel))
          if (activeOwner) expandedRoles.add(activeOwner.roleId)
        }

        listEl.innerHTML = visible
          .map(({ roleId, roleName, items, allItems }) => {
            const expanded = keyword ? true : expandedRoles.has(roleId)
            const channels = items
              .map(record => {
                const count = store.messagesOf(record.channelId).length
                const label = channelKindLabel(record.channelId)
                return `<button class="record-channel ${record.channelId === activeChannel ? 'active' : ''}" data-channel="${escapeHtml(record.channelId)}">
                  <span title="${escapeHtml(record.channelId)}"><b>${escapeHtml(label)}</b><em>${escapeHtml(record.channelId)}</em></span>
                  <small>${count} 条</small>
                </button>`
              })
              .join('')
            return `<div class="record-role ${expanded ? 'expanded' : ''}">
              <button class="record-role-head" data-role-toggle="${escapeHtml(roleId)}">
                <span class="chev">${expanded ? '▾' : '▸'}</span>
                <span class="record-role-name" title="${escapeHtml(roleName)}">${escapeHtml(roleName)}</span>
                <span class="record-role-count">${allItems.length} 个渠道</span>
              </button>
              <div class="record-role-body" ${expanded ? '' : 'hidden'}>${channels}</div>
            </div>`
          })
          .join('')

        for (const button of listEl.querySelectorAll('[data-role-toggle]')) {
          button.addEventListener('click', () => {
            const id = button.dataset.roleToggle
            if (expandedRoles.has(id)) expandedRoles.delete(id)
            else expandedRoles.add(id)
            renderList()
          })
        }
        for (const button of listEl.querySelectorAll('[data-channel]')) {
          button.addEventListener('click', () => switchChannel(button.dataset.channel))
        }
      }

      const loadChannel = channelId => {
        activeChannel = channelId
        const record = store.channelRecord(channelId)
        draft = JSON.parse(JSON.stringify(store.messagesOf(channelId)))
        pathEl.textContent = record ? labelOf(record) : channelId
        setError('')
        setDirty(false)
        updateJsonSource()
        renderCards()
        renderList()
        syncUndoSaveButton()
      }

      const switchChannel = async channelId => {
        if (channelId === activeChannel) return
        if (dirty && modal) {
          const result = await modal.confirm('放弃未保存的修改？', '当前渠道还有未保存的修改，切换后这些修改会丢失。')
          if (!result?.ok) return
        }
        loadChannel(channelId)
      }

      const setMode = async next => {
        if (next === mode) return
        if (next === 'json' && !jsonRiskAccepted && modal) {
          const accepted = await modal.confirm(
            'JSON 源码为高风险编辑模式',
            '直接编辑内部字段仍可能破坏消息结构；校验通过不代表数据一定正确。建议先点「保存」留一份当前状态，改坏后可用「恢复上次保存前」找回。',
          )
          if (!accepted?.ok) return
          jsonRiskAccepted = true
        }
        if (next === 'cards') {
          let parsed
          try {
            parsed = JSON.parse(sourceEl.value)
            const invalid = validateMessages(parsed)
            if (invalid) throw new Error(invalid)
            draft = parsed
          } catch (err) {
            setError(`JSON 源码有错误，无法切回图形视图：${err.message}`)
            return
          }
        }
        mode = next
        for (const button of modeButtons) button.classList.toggle('active', button.dataset.recordMode === mode)
        cardsEl.hidden = mode !== 'cards'
        sourceEl.hidden = mode !== 'json'
        if (mode === 'cards') renderCards()
        else updateJsonSource()
      }

      const openEditor = index => {
        editingIndex = index
        const message = index >= 0 ? draft[index] : null
        editorEl.querySelector('[data-editor-title]').textContent = index >= 0 ? `编辑第 ${index + 1} 条消息` : '新增消息'
        editorEl.querySelector('[data-editor-field="role"]').value = message?.role || 'user'
        editorEl.querySelector('[data-editor-field="kind"]').value = message?.kind === 'document' ? 'document' : 'text'
        editorEl.querySelector('[data-editor-field="visibility"]').value = message?.visibility || 'shareable'
        editorEl.querySelector('[data-editor-field="content"]').value = String(message?.content ?? '')
        editorEl.querySelector('[data-editor-field="message_id"]').value = message?.message_id || message?.id || ''
        editorEl.querySelector('[data-editor-field="seq"]').value = message?.seq ?? draft.length + 1
        editorEl.querySelector('[data-editor-field="timestamp"]').value = message?.timestamp || ''
        editorEl.querySelector('[data-editor-field="sender_name"]').value = message?.sender_name || ''
        editorEl.querySelector('[data-editor-field="meta"]').value = message?.meta ? JSON.stringify(message.meta, null, 2) : '{}'
        editorError.textContent = ''
        editorError.classList.remove('show')
        maskEl.classList.add('show')
      }

      const closeEditor = () => {
        maskEl.classList.remove('show')
        editingIndex = -1
      }

      const confirmEditor = () => {
        try {
          const field = name => editorEl.querySelector(`[data-editor-field="${name}"]`)
          const message = {
            ...(editingIndex >= 0 ? draft[editingIndex] : {}),
            role: field('role').value,
            kind: field('kind').value === 'document' ? 'document' : 'text',
            visibility: field('visibility').value,
            content: field('content').value,
            message_id: field('message_id').value.trim(),
            seq: Number(field('seq').value),
            timestamp: field('timestamp').value.trim(),
            sender_name: field('sender_name').value.trim(),
            meta: parseMeta(field('meta').value),
          }
          message.id = message.message_id || message.id || ''
          if (!message.message_id) delete message.message_id
          if (!message.timestamp) delete message.timestamp
          if (!message.seq || !Number.isFinite(message.seq)) delete message.seq
          const invalid = validateOne(message)
          if (invalid) throw new Error(invalid)
          const id = message.message_id || message.id
          if (id && draft.some((item, i) => i !== editingIndex && (item.message_id || item.id) === id)) {
            throw new Error(`message_id 重复：${id}`)
          }
          if (editingIndex >= 0) draft[editingIndex] = message
          else draft.push(message)
          setDirty(true)
          setError('')
          updateJsonSource()
          renderCards()
          closeEditor()
        } catch (err) {
          editorError.textContent = err.message
          editorError.classList.add('show')
        }
      }

      const saveAll = () => {
        let parsed = draft
        if (mode === 'json') {
          try {
            parsed = JSON.parse(sourceEl.value)
          } catch (err) {
            setError(`JSON 格式错误，未保存：${err.message}`)
            return
          }
        }
        const invalid = validateMessages(parsed)
        if (invalid) {
          setError(`校验失败，未保存：${invalid}`)
          return
        }
        try {
          // 保存前把当前状态留档，供改坏后一键撤回。
          lastSavedSnapshots.set(activeChannel, JSON.parse(JSON.stringify(store.messagesOf(activeChannel))))
          const result = store.replaceMessages(activeChannel, parsed)
          toast.success(`已保存 ${result.count} 条消息；如需回退，可点「恢复上次保存前」`)
          loadChannel(activeChannel)
        } catch (err) {
          setError(`保存失败：${err.message}`)
        }
      }

      const undoLastSave = async () => {
        if (!activeChannel || !lastSavedSnapshots.has(activeChannel)) return
        if (modal) {
          const confirmed = await modal.confirm(
            '恢复上次保存前的状态？',
            '当前草稿会先被替换为上一次成功保存前的数据，你需要再点一次「保存」才会写回。',
          )
          if (!confirmed?.ok) return
        }
        draft = JSON.parse(JSON.stringify(lastSavedSnapshots.get(activeChannel)))
        setDirty(true)
        setError('')
        updateJsonSource()
        renderCards()
        toast.info('已载入上次保存前的状态，请点「保存」应用')
        undoLastSaveBtn.hidden = true
      }

      const reloadDraft = () => {
        if (!activeChannel) return
        draft = JSON.parse(JSON.stringify(store.messagesOf(activeChannel)))
        setDirty(false)
        setError('')
        updateJsonSource()
        renderCards()
        renderList()
        toast.info('已还原到上次保存的状态')
      }

      for (const button of modeButtons) button.addEventListener('click', () => setMode(button.dataset.recordMode))
      container.querySelector('[data-record-save]').addEventListener('click', saveAll)
      container.querySelector('[data-record-reload]').addEventListener('click', reloadDraft)
      container.querySelector('[data-record-undo-save]').addEventListener('click', undoLastSave)
      container.querySelector('[data-record-add]').addEventListener('click', () => openEditor(-1))
      container.querySelector('[data-record-refresh-list]').addEventListener('click', () => {
        listInitialized = false
        renderList()
        if (activeChannel) loadChannel(activeChannel)
      })
      listSearchEl?.addEventListener('input', () => {
        listKeyword = listSearchEl.value || ''
        renderList()
      })
      sourceEl.addEventListener('input', () => {
        try {
          const parsed = JSON.parse(sourceEl.value)
          const invalid = validateMessages(parsed)
          if (invalid) throw new Error(invalid)
          draft = parsed
          setDirty(true)
          setError('')
        } catch (err) {
          setError(`JSON 格式错误：${err.message}`)
        }
      })
      cardsEl.addEventListener('mousedown', event => event.stopPropagation())
      maskEl.addEventListener('click', event => {
        if (event.target === maskEl) closeEditor()
      })
      container.querySelector('[data-editor-cancel]').addEventListener('click', closeEditor)
      container.querySelector('[data-editor-confirm]').addEventListener('click', confirmEditor)

      const first = store.listChannels()[0]
      if (first) loadChannel(first.channelId)
      else {
        draft = []
        updateJsonSource()
        renderCards()
        renderList()
      }

      const offReplaced = events.on('chat:messages-replaced', payload => {
        if (payload?.channelId === activeChannel && !dirty) loadChannel(activeChannel)
        else renderList()
      })
      // 渠道详情点「打开聊天记录」时，定位到对应渠道而不是另开普通会话。
      const offDeleted = events.on('conversation:delete', () => {
        listInitialized = false
        if (activeChannel && !store.channelRecord(activeChannel)) {
          activeChannel = null
          draft = []
          pathEl.textContent = '未选择渠道'
          updateJsonSource()
          renderCards()
        }
        renderList()
      })
      const offSelect = events.on('chat-records:select', payload => {
        const channelId = String(payload?.channelId || '')
        const record = channelId ? store.channelRecord(channelId) : null
        if (!record) return
        listInitialized = true
        expandedRoles.add(record.roleId || record.conversationId)
        loadChannel(channelId)
      })

      return () => {
        offReplaced()
        offDeleted()
        offSelect()
        container.innerHTML = ''
      }
    },
  })

  ctx.logger.debug('聊天记录图形编辑器就绪')
}
