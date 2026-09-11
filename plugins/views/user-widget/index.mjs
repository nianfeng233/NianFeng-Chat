/**
 * V2 · user-widget
 * 顶层栏右侧：用户头像 + 个性签名。
 *
 * 头像统一走 src/util/identity.mjs：
 *   - 默认使用风语 logo（FENGYU_LOGO）；
 *   - 点击头像可选择图片，压缩后写入 config 的 ui.avatarImage；
 *   - 右键头像可更换 / 恢复默认；
 *   - 所有读取同一 config 的头像位置（消息、通知等）都会一起更新。
 */
export const name = 'user-widget'
export const version = '1.1.0'
export const displayName = '用户信息'
export const description = '顶层栏内容 · 用户头像（可更换）与可编辑签名。'
export const author = '风语内核'
export const icon = '🙋'
export const core = true
export const depends = { titlebar: '^1.0.0', config: '^1.0.0' }
export const inject = ['slots', 'config']

import {
  DEFAULT_USER_SIGNATURE,
  USER_AVATAR_KEY,
  USER_SIGNATURE_KEY,
  resolveUserAvatar,
} from '../../../src/util/identity.mjs'

const SIG_MAX = 40
const AVATAR_MAX_SIDE = 128

export function apply(ctx) {
  const config = ctx.inject('config')

  ctx.slots.register('titlebar:center', container => {
    const saved = config.get(USER_SIGNATURE_KEY, '') || DEFAULT_USER_SIGNATURE
    const hasCustomAvatar = !!String(config.get(USER_AVATAR_KEY, '') || '').trim()
    container.innerHTML = `
      <span class="tb-divider"></span>
      <div class="tb-user">
        <button class="tb-avatar ${hasCustomAvatar ? '' : 'tb-avatar-logo'}" id="tbAvatar" type="button"
          title="点击更换头像；默认使用风语 logo（右键可恢复默认）">
          <img id="tbAvatarImg" src="${escapeAttr(resolveUserAvatar(config))}" alt="头像" draggable="false" />
        </button>
        <input type="file" id="tbAvatarFile" accept="image/*" hidden />
        <div class="tb-signature">
          <input class="sig-input" id="sigInput" type="text" maxlength="${SIG_MAX}"
                 placeholder="${DEFAULT_USER_SIGNATURE}"
                 autocomplete="off" spellcheck="false" value="${escapeAttr(saved)}" />
          <span class="sig-drag-zone" aria-hidden="true"></span>
        </div>
      </div>`

    const avatarButton = container.querySelector('#tbAvatar')
    const avatarImg = container.querySelector('#tbAvatarImg')
    const avatarFile = container.querySelector('#tbAvatarFile')
    const input = container.querySelector('#sigInput')

    /* -------- 签名 -------- */
    const commit = () => {
      let value = input.value.trim()
      if (!value) value = DEFAULT_USER_SIGNATURE
      value = value.slice(0, SIG_MAX)
      input.value = value
      config.set(USER_SIGNATURE_KEY, value)
    }
    let commitTimer = null
    const scheduleCommit = () => {
      if (commitTimer) clearTimeout(commitTimer)
      commitTimer = setTimeout(commit, 400)
    }
    const onInput = () => {
      if (input.value.length > SIG_MAX) input.value = input.value.slice(0, SIG_MAX)
      scheduleCommit()
    }
    const onKey = e => {
      if (e.key === 'Enter') {
        e.preventDefault()
        input.blur()
      }
    }

    /* -------- 头像 -------- */
    const paintAvatar = () => {
      if (!avatarImg) return
      const custom = !!String(config.get(USER_AVATAR_KEY, '') || '').trim()
      avatarButton?.classList.toggle('tb-avatar-logo', !custom)
      avatarImg.src = resolveUserAvatar(config)
    }
    const applyAvatarFile = file => {
      if (!file) return
      const toast = ctx.registry.get('toast')
      if (!/^image\//i.test(file.type || '')) {
        toast?.error?.('请选择图片文件')
        return
      }
      if (typeof FileReader === 'undefined' || typeof Image === 'undefined') {
        toast?.error?.('当前环境不支持读取图片')
        return
      }
      const reader = new FileReader()
      reader.onerror = () => toast?.error?.('头像读取失败')
      reader.onload = () => {
        const image = new Image()
        image.onerror = () => toast?.error?.('头像解析失败，请换一张试试')
        image.onload = () => {
          try {
            const scale = Math.min(1, AVATAR_MAX_SIDE / Math.max(image.width || 1, image.height || 1))
            const canvas = document.createElement('canvas')
            canvas.width = Math.max(1, Math.round((image.width || 1) * scale))
            canvas.height = Math.max(1, Math.round((image.height || 1) * scale))
            const painter = canvas.getContext('2d')
            if (!painter) throw new Error('无法创建画布')
            painter.drawImage(image, 0, 0, canvas.width, canvas.height)
            config.set(USER_AVATAR_KEY, canvas.toDataURL('image/jpeg', 0.86))
            toast?.success?.('头像已更新')
          } catch (err) {
            toast?.error?.(`头像处理失败：${err.message}`)
          }
        }
        image.src = String(reader.result)
      }
      reader.readAsDataURL(file)
    }
    const pickAvatar = () => avatarFile?.click()
    const resetAvatar = () => {
      if (!String(config.get(USER_AVATAR_KEY, '') || '')) {
        ctx.registry.get('toast')?.info?.('当前已经是默认头像')
        return
      }
      config.set(USER_AVATAR_KEY, '')
      ctx.registry.get('toast')?.success?.('已恢复默认头像')
    }
    const onAvatarClick = () => pickAvatar()
    const onAvatarContext = e => {
      e.preventDefault()
      const menu = ctx.registry.get('context-menu')
      if (!menu?.open) {
        resetAvatar()
        return
      }
      const hasCustom = !!String(config.get(USER_AVATAR_KEY, '') || '')
      menu.open(e.clientX, e.clientY, [
        { label: '更换头像', action: pickAvatar },
        { label: '恢复默认头像', action: resetAvatar, disabled: !hasCustom },
      ])
    }
    const onAvatarFileChange = event => {
      const file = event.target.files?.[0]
      applyAvatarFile(file)
      event.target.value = ''
    }

    /* -------- 配置变化：所有引用同一 config 的位置一起刷新 -------- */
    const onConfigChange = payload => {
      const key = payload?.key || ''
      if (key === '*' || key === USER_SIGNATURE_KEY) {
        const next = config.get(USER_SIGNATURE_KEY, '') || DEFAULT_USER_SIGNATURE
        if (document.activeElement !== input && input.value !== next) input.value = next
      }
      if (key === '*' || key === USER_AVATAR_KEY) paintAvatar()
    }
    const offConfig = ctx.on('config:changed', onConfigChange)

    avatarButton.addEventListener('click', onAvatarClick)
    avatarButton.addEventListener('contextmenu', onAvatarContext)
    avatarFile.addEventListener('change', onAvatarFileChange)
    input.addEventListener('blur', commit)
    input.addEventListener('input', onInput)
    input.addEventListener('keydown', onKey)

    return () => {
      if (commitTimer) clearTimeout(commitTimer)
      offConfig?.()
      avatarButton.removeEventListener('click', onAvatarClick)
      avatarButton.removeEventListener('contextmenu', onAvatarContext)
      avatarFile.removeEventListener('change', onAvatarFileChange)
      input.removeEventListener('blur', commit)
      input.removeEventListener('input', onInput)
      input.removeEventListener('keydown', onKey)
      container.innerHTML = ''
    }
  }, { order: 10 })
}

function escapeAttr(s) {
  return String(s).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[m])
}
