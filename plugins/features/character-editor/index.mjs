/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * 角色编辑（捏人窗口）
 *
 * 新建会话时先填写「角色名 / 人格设定 / 使用模型 / 头像颜色」，
 * 会话头部「更多 → 编辑角色」可以随时再打开修改。
 *
 * 数据落在会话对象的 name / avatar / c1 / c2 / meta.persona / meta.model / meta.backupMode / meta.backupModels：
 *   - meta.persona 由 chat-flow 作为 system 段落注入模型上下文
 *   - meta.model 是 `${providerId}/${modelId}`，为空则跟随全局模型
 *   - meta.backupMode 是 'global'（跟随全局）/ 'off'（不启用）/ 'custom'（角色级列表）
 *   - meta.backupModels 是角色级备用模型有序列表；同时写 meta.backupModel 兼容旧版读取
 */
export const name = 'character-editor'
export const version = '1.2.0'
export const displayName = '角色编辑'
export const description = '功能插件 · 新建 / 编辑会话角色（人格、主模型、备用模型、头像）。'
export const author = '念风内核'
export const icon = '🎭'
export const core = true
export const depends = {
  'model-registry': '^1.0.0',
  'session-service': '^2.0.0',
  'toast-host': '>=1.0.0',
}
export const optionalDepends = {}
export const inject = ['session-service', 'model-registry', 'toast']
export const provides = [{ name: 'character-editor', type: 'singleton' }]

import { useStyle } from '../../../src/util/style.mjs'
import { escapeHtml } from '../../../src/util/format.mjs'
import { CHARACTER_CSS } from './style.mjs'

const PALETTE = [
  ['#7fb2ff', '#4a7dff'],
  ['#8de0c1', '#37b98a'],
  ['#ffd08a', '#ff9f43'],
  ['#ffb1c1', '#ff6b8b'],
  ['#c9b6ff', '#8b6bff'],
  ['#9fd8ff', '#3aa0ff'],
  ['#bfe8a8', '#6fbf5a'],
  ['#e0c9a6', '#b58a52'],
]

export function apply(ctx) {
  const sessions = ctx.inject('session-service')
  const registry = ctx.inject('model-registry')
  const toast = ctx.inject('toast')

  useStyle(ctx, CHARACTER_CSS)

  let overlay = null
  let closeCurrent = null

  const modelKeyOf = item => item?.key || `${item?.provider || ''}/${item?.id || ''}`.replace(/^\/+/, '')
  const modelLabelOf = item => `${item?.name || item?.id || ''}（${item?.providerName || item?.provider || ''}）`
  const normalizeBackupKeys = raw => {
    const out = []
    for (const value of Array.isArray(raw) ? raw : []) {
      const key = String(value || '').trim()
      if (key && !out.includes(key)) out.push(key)
    }
    return out
  }

  const close = () => {
    closeCurrent?.()
    closeCurrent = null
    overlay?.remove()
    overlay = null
  }

  const open = ({ conversation = null, onDone } = {}) => {
    close()
    const editing = !!conversation
    const source = editing ? sessions.get(conversation.id) || conversation : null
    const meta = source?.meta || {}
    let [c1, c2] = [source?.c1 || PALETTE[0][0], source?.c2 || PALETTE[0][1]]
    let avatarImage = meta.avatarImage || ''
    const modelList = registry.list()
    const modelByKey = new Map(modelList.map(item => [modelKeyOf(item), item]))
    const legacyBackup = String(meta.backupModel || '').trim()
    const hasBackupList = Array.isArray(meta.backupModels)
    let backupMode = hasBackupList || String(meta.backupMode || '').trim() === 'custom'
      ? 'custom'
      : legacyBackup === 'off'
        ? 'off'
        : legacyBackup && legacyBackup !== 'global'
          ? 'custom'
          : 'global'
    let backupModels = []
    if (backupMode === 'custom') {
      backupModels = normalizeBackupKeys(
        hasBackupList
          ? meta.backupModels
          : legacyBackup && legacyBackup !== 'global' && legacyBackup !== 'off'
            ? [legacyBackup]
            : [],
      )
    }

    overlay = document.createElement('div')
    overlay.className = 'char-mask'
    overlay.innerHTML = `
      <div class="char-dialog" role="dialog" aria-modal="true">
        <div class="char-head">
          <div>
            <div class="char-title">${editing ? '编辑角色' : '创建角色'}</div>
            <div class="char-sub">${editing ? '修改后会立即应用于这个会话' : '先捏一个角色，再开始聊天'}</div>
          </div>
          <button class="char-close" data-char-close title="关闭">✕</button>
        </div>
        <div class="char-body">
          <div class="char-avatar-row">
            <div class="char-avatar" data-char-preview role="button" tabindex="0" title="点击选择头像图片" style="--c1:${c1};--c2:${c2}">${escapeHtml((source?.avatar || '新').slice(0, 1))}</div>
            <input type="file" accept="image/*" data-char-avatar-file style="display:none" />
            <div class="char-avatar-side">
              <label class="char-field">
                <span>角色名</span>
                <input class="setting-input char-name" data-char-name maxlength="20" placeholder="例如：小明 / 猫娘 / 严谨助手" value="${escapeHtml(source?.name || '')}" />
              </label>
              <div class="char-colors" data-char-colors>
                ${PALETTE.map(
                  ([a, b], index) =>
                    `<button class="char-color" data-char-color="${index}" style="--c1:${a};--c2:${b}" title="头像配色 ${index + 1}"></button>`,
                ).join('')}
                <button class="char-color-clear" data-char-avatar-clear title="清除自定义头像">清除头像</button>
              </div>
            </div>
          </div>
          <label class="char-field">
            <span>人格设定 <em>会作为 system 提示词注入每次对话</em></span>
            <textarea class="char-persona" data-char-persona placeholder="例如：你是一只沉稳的猫娘助手，说话简短、偶尔用「喵」，不知道就直说不知道。">${escapeHtml(meta.persona || '')}</textarea>
          </label>
          <label class="char-field">
            <span>使用模型 <em>留空则跟随全局当前模型</em></span>
            <select class="setting-select char-model" data-char-model>
              <option value="">跟随全局模型</option>
              ${modelList
                .map(item => {
                  const key = item.key || `${item.provider}/${item.id}`
                  const label = `${item.name || item.id}（${item.providerName || item.provider}）`
                  return `<option value="${escapeHtml(key)}" ${meta.model === key ? 'selected' : ''}>${escapeHtml(label)}</option>`
                })
                .join('')}
            </select>
          </label>
          <div class="char-field">
            <span>备用模型 <em>主模型失败时自动切换；角色级设置优先于全局</em></span>
            <select class="setting-select char-backup" data-char-backup>
              <option value="global" ${backupMode === 'global' ? 'selected' : ''}>跟随全局模型设置（默认）</option>
              <option value="off" ${backupMode === 'off' ? 'selected' : ''}>不启用备用模型</option>
              <option value="custom" ${backupMode === 'custom' ? 'selected' : ''}>自定义备用模型列表</option>
            </select>
            <div class="char-backup-panel" data-char-backup-panel>
              <div class="char-backup-list" data-char-backup-list></div>
              <div class="char-backup-add">
                <select class="setting-select" data-char-backup-add></select>
                <button type="button" class="outline-btn char-backup-add-btn" data-char-backup-add-btn>添加</button>
              </div>
            </div>
            <div class="char-note char-backup-hint" data-char-backup-hint></div>
          </div>
          <div class="char-note">人格与模型只保存在本机会话数据里；角色级备用模型优先于全局失败转移设置。</div>
        </div>
        <div class="char-foot">
          <button class="outline-btn" data-char-cancel>取消</button>
          <button class="outline-btn primary-soft" data-char-save>${editing ? '保存角色' : '创建并开始聊天'}</button>
        </div>
      </div>`

    document.body.appendChild(overlay)

    const nameInput = overlay.querySelector('[data-char-name]')
    const personaInput = overlay.querySelector('[data-char-persona]')
    const modelSelect = overlay.querySelector('[data-char-model]')
    const backupSelect = overlay.querySelector('[data-char-backup]')
    const preview = overlay.querySelector('[data-char-preview]')

    const syncPreview = () => {
      const value = String(nameInput.value || '').trim()
      preview.style.setProperty('--c1', c1)
      preview.style.setProperty('--c2', c2)
      if (avatarImage) {
        preview.textContent = ''
        preview.style.backgroundImage = `url('${avatarImage}')`
        preview.style.backgroundSize = 'cover'
        preview.style.backgroundPosition = 'center'
        preview.classList.add('has-image')
      } else {
        preview.textContent = value ? value.slice(0, 1) : '新'
        preview.style.backgroundImage = ''
        preview.classList.remove('has-image')
      }
    }
    const onName = () => syncPreview()

    /* ---------------- 备用模型列表（与设置页同一套增删排序语义） ---------------- */
    const backupPanel = overlay.querySelector('[data-char-backup-panel]')
    const backupListHost = overlay.querySelector('[data-char-backup-list]')
    const backupAddSelect = overlay.querySelector('[data-char-backup-add]')
    const backupAddButton = overlay.querySelector('[data-char-backup-add-btn]')
    const backupHint = overlay.querySelector('[data-char-backup-hint]')

    const moveBackup = (from, to) => {
      if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0 || from >= backupModels.length || to >= backupModels.length) return
      const [moved] = backupModels.splice(from, 1)
      backupModels.splice(to, 0, moved)
      renderBackupPanel()
    }

    const renderBackupPanel = () => {
      const custom = backupSelect?.value === 'custom'
      if (backupPanel) backupPanel.style.display = custom ? 'flex' : 'none'
      if (backupHint) {
        backupHint.textContent =
          backupSelect?.value === 'off'
            ? '主模型失败时不再自动切换，直接按错误处理。'
            : backupSelect?.value === 'custom'
              ? '按下面列表从上到下逐个尝试，每个模型只尝试一轮；可用 ↑ ↓ 调整顺序。'
              : '跟随「设置 → 模型 → 备用模型列表」与列表循环轮数；如需角色单独配置，请选择“自定义备用模型列表”。'
      }
      if (!custom) return

      if (backupListHost) {
        const rows = backupModels
          .map((key, index) => {
            const item = modelByKey.get(key)
            const label = item ? modelLabelOf(item) : `${key}（当前不可用）`
            return `<div class="char-backup-row">
              <span class="char-backup-order">${index + 1}</span>
              <span class="char-backup-name" title="${escapeHtml(key)}">${escapeHtml(label)}</span>
              <span class="char-backup-ops">
                <button type="button" class="char-backup-op" data-backup-up="${index}" ${index === 0 ? 'disabled' : ''} title="上移">↑</button>
                <button type="button" class="char-backup-op" data-backup-down="${index}" ${index === backupModels.length - 1 ? 'disabled' : ''} title="下移">↓</button>
                <button type="button" class="char-backup-op danger" data-backup-remove="${index}" title="移除">移除</button>
              </span>
            </div>`
          })
          .join('')
        backupListHost.innerHTML =
          rows || '<div class="char-backup-empty">还没有备用模型：从下方下拉框选择后点「添加」。</div>'
        backupListHost.querySelectorAll('[data-backup-up]').forEach(button => {
          button.addEventListener('click', () => moveBackup(Number(button.dataset.backupUp), Number(button.dataset.backupUp) - 1))
        })
        backupListHost.querySelectorAll('[data-backup-down]').forEach(button => {
          button.addEventListener('click', () => moveBackup(Number(button.dataset.backupDown), Number(button.dataset.backupDown) + 1))
        })
        backupListHost.querySelectorAll('[data-backup-remove]').forEach(button => {
          button.addEventListener('click', () => {
            const index = Number(button.dataset.backupRemove)
            if (index < 0 || index >= backupModels.length) return
            backupModels.splice(index, 1)
            renderBackupPanel()
          })
        })
      }

      const candidates = modelList.filter(item => !backupModels.includes(modelKeyOf(item)))
      if (backupAddSelect) {
        backupAddSelect.innerHTML = candidates.length
          ? candidates.map(item => `<option value="${escapeHtml(modelKeyOf(item))}">${escapeHtml(modelLabelOf(item))}</option>`).join('')
          : '<option value="">（没有可添加的模型）</option>'
      }
      if (backupAddButton) backupAddButton.disabled = !candidates.length
    }

    backupAddButton?.addEventListener('click', () => {
      const key = String(backupAddSelect?.value || '').trim()
      if (!key || backupModels.includes(key)) return
      backupModels.push(key)
      renderBackupPanel()
    })
    backupSelect?.addEventListener('change', renderBackupPanel)

    /* 头像图片：本机压缩成 128×128 后存进会话 meta.avatarImage */
    const pickAvatar = () => overlay.querySelector('[data-char-avatar-file]')?.click()
    const avatarFile = overlay.querySelector('[data-char-avatar-file]')
    const applyAvatarFile = file => {
      if (!file) return
      if (!/^image\//i.test(file.type || '')) {
        toast.error('请选择图片文件')
        return
      }
      if (typeof FileReader === 'undefined' || typeof Image === 'undefined') {
        toast.error('当前环境不支持读取图片')
        return
      }
      const reader = new FileReader()
      reader.onerror = () => toast.error('头像读取失败')
      reader.onload = () => {
        const image = new Image()
        image.onerror = () => toast.error('头像解析失败，请换一张图片')
        image.onload = () => {
          try {
            const size = 128
            const canvas = document.createElement('canvas')
            canvas.width = size
            canvas.height = size
            const painter = canvas.getContext('2d')
            if (!painter) throw new Error('无法创建画布')
            const scale = Math.max(size / (image.width || 1), size / (image.height || 1))
            const width = (image.width || 1) * scale
            const height = (image.height || 1) * scale
            // JPEG 没有透明通道；先铺白底，避免透明 PNG 裁成黑块。
            painter.fillStyle = '#ffffff'
            painter.fillRect(0, 0, size, size)
            painter.drawImage(image, (size - width) / 2, (size - height) / 2, width, height)
            avatarImage = canvas.toDataURL('image/jpeg', 0.86)
            syncPreview()
            toast.success('头像已选择')
          } catch (err) {
            toast.error(`头像处理失败：${err.message}`)
          }
        }
        image.src = String(reader.result)
      }
      reader.readAsDataURL(file)
    }
    preview.addEventListener('click', pickAvatar)
    preview.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        pickAvatar()
      }
    })
    avatarFile?.addEventListener('change', event => {
      applyAvatarFile(event.target.files?.[0])
      event.target.value = ''
    })
    overlay.querySelector('[data-char-avatar-clear]')?.addEventListener('click', () => {
      avatarImage = ''
      syncPreview()
    })

    overlay.querySelectorAll('[data-char-color]').forEach(button => {
      button.classList.toggle('active', Number(button.dataset.charColor) === PALETTE.findIndex(([a, b]) => a === c1 && b === c2))
      button.addEventListener('click', () => {
        const index = Number(button.dataset.charColor) || 0
        ;[c1, c2] = PALETTE[index] || PALETTE[0]
        overlay.querySelectorAll('[data-char-color]').forEach(item => item.classList.toggle('active', item === button))
        syncPreview()
      })
    })

    const save = () => {
      const name = String(nameInput.value || '').trim() || '新的角色'
      const persona = String(personaInput.value || '').trim()
      const model = modelSelect ? modelSelect.value : ''
      const nextBackupMode = backupSelect ? backupSelect.value || 'global' : 'global'
      const nextBackupModels = nextBackupMode === 'custom' ? normalizeBackupKeys(backupModels) : []
      const nextBackupModel =
        nextBackupMode === 'off' || (nextBackupMode === 'custom' && !nextBackupModels.length)
          ? 'off'
          : nextBackupMode === 'custom'
            ? nextBackupModels[0]
            : 'global'
      const modelMeta = {
        model,
        backupMode: nextBackupMode,
        backupModels: nextBackupModels,
        // 兼容旧版本 / 旧服务端读取单一 backupModel 字段。
        backupModel: nextBackupModel,
      }
      if (editing) {
        sessions.update(conversation.id, {
          name,
          avatar: name.slice(0, 1),
          c1,
          c2,
          meta: { ...(source?.meta || {}), persona, ...modelMeta, avatarImage },
        })
        toast.success(`角色「${name}」已更新`)
      } else {
        const conv = sessions.create({
          name,
          avatar: name.slice(0, 1),
          c1,
          c2,
          preview: persona ? `${persona.slice(0, 40)}` : '',
          meta: { persona, ...modelMeta, avatarImage },
        })
        sessions.activate(conv.id)
        toast.success(`已创建角色「${name}」，开始聊天吧`)
      }
      onDone?.()
      close()
    }

    const onKeydown = event => {
      if (event.key === 'Escape') close()
    }
    const onMaskClick = event => {
      if (event.target === overlay) close()
    }

    overlay.querySelector('[data-char-save]')?.addEventListener('click', save)
    overlay.querySelector('[data-char-cancel]')?.addEventListener('click', close)
    overlay.querySelector('[data-char-close]')?.addEventListener('click', close)
    overlay.addEventListener('mousedown', onMaskClick)
    window.addEventListener('keydown', onKeydown)
    nameInput?.addEventListener('input', onName)

    closeCurrent = () => {
      window.removeEventListener('keydown', onKeydown)
      nameInput?.removeEventListener('input', onName)
    }
    setTimeout(() => nameInput?.focus(), 30)
    syncPreview()
    renderBackupPanel()
  }

  const service = {
    name: 'character-editor',
    openCreate: options => open({ ...options }),
    openEdit: (idOrConv, options = {}) => {
      const conv = typeof idOrConv === 'string' ? sessions.get(idOrConv) : idOrConv
      if (!conv) {
        toast.warn('找不到要编辑的会话')
        return
      }
      open({ conversation: conv, ...options })
    },
    close,
    isOpen: () => !!overlay,
  }

  ctx.provide('character-editor', service, { type: 'singleton' })
  ctx.effect(() => close)
  ctx.logger.debug('角色编辑器就绪')
}
