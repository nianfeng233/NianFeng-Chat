/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * settings-item-model 的备用模型列表区块。
 *
 * 从主设置页拆出的原因：列表渲染、拖拽排序、增删逻辑与“当前生效”面板的
 * provider/model 表单没有耦合，独立后主文件更小，也便于单独测试 DOM 行为。
 */
import { escapeHtml } from '../../../src/util/format.mjs'

/** 从 config 读取备用模型有序列表；兼容尚未迁移完成的旧单值。 */
export function failoverKeysFromConfig(config) {
  const raw = config.get('model.failoverKeys', [])
  const list = (Array.isArray(raw) ? raw : []).map(value => String(value || '').trim()).filter(Boolean)
  if (!list.length) {
    const legacy = String(config.get('model.failoverKey', '') || '').trim()
    if (legacy) list.push(legacy)
  }
  return [...new Set(list)]
}

/** 生成备用模型列表区块 HTML；局部刷新与整页渲染共用，保证 DOM 结构一致。 */
export function buildFailoverBlockHtml({ config, registry }) {
  const modelList = registry.list()
  const keys = failoverKeysFromConfig(config)
  const modelByKey = new Map(modelList.map(item => [item.key, item]))
  const label = item => (item ? `${item.name || item.id}（${item.providerName || item.provider}）` : '')
  const rows = keys
    .map((key, index) => {
      const item = modelByKey.get(key)
      return `<tr class="model-failover-row${item ? '' : ' missing'}" draggable="true" data-failover-key="${escapeHtml(key)}" data-failover-index="${index}">
        <td class="model-failover-handle" title="按住拖动调整顺序">⋮⋮</td>
        <td class="model-failover-order">${index + 1}</td>
        <td class="model-failover-model">
          <div class="model-failover-name">${item ? escapeHtml(label(item)) : `${escapeHtml(key)}（已不可用）`}</div>
          <div class="model-failover-key">${escapeHtml(key)}</div>
        </td>
        <td class="model-failover-ops">
          <button class="outline-btn model-mini-btn" data-failover-up="${index}" title="上移" ${index === 0 ? 'disabled' : ''}>↑</button>
          <button class="outline-btn model-mini-btn" data-failover-down="${index}" title="下移" ${index === keys.length - 1 ? 'disabled' : ''}>↓</button>
          <button class="outline-btn model-mini-btn model-danger-text" data-failover-remove="${index}" title="从列表移除">移除</button>
        </td>
      </tr>`
    })
    .join('')
  const addOptions = modelList
    .filter(item => !keys.includes(item.key))
    .map(item => `<option value="${escapeHtml(item.key)}">${escapeHtml(label(item))}</option>`)
    .join('')
  return `<div class="model-failover-block" data-failover-host>
      <div class="model-failover-title">备用模型列表<span>拖动调整顺序；失败时从上到下逐个尝试（单个角色可在「编辑角色 → 备用模型」里覆盖）</span></div>
      <table class="model-failover-table">
        <thead><tr><th class="model-failover-handle"></th><th class="model-failover-order">#</th><th>模型</th><th class="model-failover-ops">操作</th></tr></thead>
        <tbody data-failover-list>${
          rows || '<tr class="model-failover-empty"><td colspan="4">还没有备用模型：从下方下拉框添加。</td></tr>'
        }</tbody>
      </table>
      <div class="model-failover-add">
        <select class="setting-select" data-failover-select style="min-width:230px" ${addOptions ? '' : 'disabled'}>${
          addOptions || '<option value="">（没有可添加的模型）</option>'
        }</select>
        <button class="outline-btn model-mini-btn primary-soft" data-failover-add ${addOptions ? '' : 'disabled'}>添加</button>
      </div>
      <div class="setting-help">与当前模型重复的条目会在调用时自动跳过；已不可用的模型会保留在列表中，以后恢复即可继续生效。</div>
    </div>`
}

/**
 * 绑定备用列表交互：HTML5 拖拽 + 上移 / 下移 / 移除 / 添加。
 * 写回 config 后调用 refreshBlock()，由调用方做“只刷新当前区块”的 DOM 更新。
 */
export function bindFailoverControls({ containerNode, config, refreshBlock }) {
  const listHost = containerNode.querySelector('[data-failover-list]')
  if (!listHost) return
  const readKeys = () => failoverKeysFromConfig(config)
  const writeKeys = keys => {
    const next = [...new Set(keys.map(value => String(value || '').trim()).filter(Boolean))]
    config.set('model.failoverKeys', next)
    refreshBlock()
  }
  const moveKey = (from, to, { byKey = false } = {}) => {
    const keys = readKeys()
    const fromIndex = byKey ? keys.indexOf(String(from)) : Number(from)
    const toIndex = byKey ? keys.indexOf(String(to)) : Number(to)
    if (!Number.isInteger(fromIndex) || !Number.isInteger(toIndex) || fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return null
    const [moved] = keys.splice(fromIndex, 1)
    keys.splice(toIndex, 0, moved)
    return keys
  }

  for (const button of listHost.querySelectorAll('[data-failover-up]')) {
    button.addEventListener('click', () => {
      const index = Number(button.dataset.failoverUp)
      if (!Number.isInteger(index) || index <= 0) return
      const next = moveKey(index, index - 1)
      if (next) writeKeys(next)
    })
  }
  for (const button of listHost.querySelectorAll('[data-failover-down]')) {
    button.addEventListener('click', () => {
      const index = Number(button.dataset.failoverDown)
      const keys = readKeys()
      if (!Number.isInteger(index) || index < 0 || index >= keys.length - 1) return
      const next = moveKey(index, index + 1)
      if (next) writeKeys(next)
    })
  }
  for (const button of listHost.querySelectorAll('[data-failover-remove]')) {
    button.addEventListener('click', () => {
      const index = Number(button.dataset.failoverRemove)
      const keys = readKeys()
      if (!Number.isInteger(index) || index < 0 || index >= keys.length) return
      keys.splice(index, 1)
      writeKeys(keys)
    })
  }

  let draggedKey = ''
  for (const row of listHost.querySelectorAll('tr[data-failover-key]')) {
    row.addEventListener('dragstart', event => {
      draggedKey = String(row.dataset.failoverKey || '')
      row.classList.add('dragging')
      try {
        event.dataTransfer.effectAllowed = 'move'
        event.dataTransfer.setData('text/plain', draggedKey)
      } catch (_) {
        /* 某些 WebView 不允许在非受信任事件里设置数据，仍可用 draggedKey 兜底 */
      }
    })
    row.addEventListener('dragend', () => {
      draggedKey = ''
      row.classList.remove('dragging')
      for (const item of listHost.querySelectorAll('.drag-over')) item.classList.remove('drag-over')
    })
    row.addEventListener('dragover', event => {
      event.preventDefault()
      try {
        event.dataTransfer.dropEffect = 'move'
      } catch (_) {
        /* ignore */
      }
      row.classList.add('drag-over')
    })
    row.addEventListener('dragleave', () => row.classList.remove('drag-over'))
    row.addEventListener('drop', event => {
      event.preventDefault()
      row.classList.remove('drag-over')
      let fromKey = draggedKey
      try {
        fromKey = event.dataTransfer.getData('text/plain') || fromKey
      } catch (_) {
        /* ignore */
      }
      const toKey = String(row.dataset.failoverKey || '')
      if (!fromKey || !toKey || fromKey === toKey) return
      const next = moveKey(fromKey, toKey, { byKey: true })
      if (next) writeKeys(next)
    })
  }

  const addButton = containerNode.querySelector('[data-failover-add]')
  const addSelect = containerNode.querySelector('[data-failover-select]')
  addButton?.addEventListener('click', () => {
    const key = String(addSelect?.value || '').trim()
    if (!key) return
    const keys = readKeys()
    if (keys.includes(key)) return
    keys.push(key)
    writeKeys(keys)
  })
}
