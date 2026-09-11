/**
 * F7 · modal-host
 * 弹窗宿主。所有插件共用同一个遮罩与动效，避免各写各的。
 */
export const name = 'modal-host'
export const version = '1.0.0'
export const displayName = '弹窗宿主'
export const description = '基础服务 · 统一的模态弹窗（确认 / 输入 / 提示）。'
export const author = '风语内核'
export const icon = '🪟'
export const core = true
export const inject = ['event-bus']
export const provides = [{ name: 'modal', type: 'singleton' }]

import { useStyle } from '../../../src/util/style.mjs'
import { MODAL_CSS } from './style.mjs'

export function apply(ctx) {
  const root = document.createElement('div')
  root.id = 'modalHost'
  root.innerHTML = `
    <div class="modal-mask" id="modalMask">
      <div class="modal" role="dialog" aria-modal="true">
        <div class="modal-title" id="modalTitle">提示</div>
        <div class="modal-desc" id="modalDesc" style="display:none"></div>
        <input class="modal-input" id="modalInput" type="text" maxlength="40" autocomplete="off" style="display:none" />
        <div class="modal-actions">
          <button class="btn primary" id="modalOk" disabled>确定</button>
          <button class="btn" id="modalCancel">取消</button>
        </div>
      </div>
    </div>`
  document.body.appendChild(root)
  useStyle(ctx, MODAL_CSS)
  ctx.effect(() => root.remove())

  const mask = root.querySelector('#modalMask')
  const titleEl = root.querySelector('#modalTitle')
  const descEl = root.querySelector('#modalDesc')
  const inputEl = root.querySelector('#modalInput')
  const okBtn = root.querySelector('#modalOk')
  const cancelBtn = root.querySelector('#modalCancel')

  let current = null

  const close = (result = { ok: false }) => {
    if (!current) return
    const done = current.resolve
    current = null
    mask.classList.remove('show')
    okBtn.disabled = true
    ctx.emit('modal:closed', result)
    done(result)
  }

  const syncDisabled = () => {
    if (!current) return
    okBtn.disabled = current.requireValue ? !inputEl.value.trim() : false
  }

  okBtn.addEventListener('click', () => {
    if (!current || okBtn.disabled) return
    close({ ok: true, value: inputEl.value })
  })
  cancelBtn.addEventListener('click', () => close({ ok: false }))
  mask.addEventListener('mousedown', e => {
    if (e.target === mask && current?.dismissible) close({ ok: false })
  })
  inputEl.addEventListener('input', syncDisabled)
  inputEl.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !okBtn.disabled) {
      e.preventDefault()
      close({ ok: true, value: inputEl.value })
    }
  })

  const onKeydown = e => {
    if (!current) return
    if (e.key === 'Escape' && current.dismissible) close({ ok: false })
  }
  document.addEventListener('keydown', onKeydown)
  ctx.effect(() => document.removeEventListener('keydown', onKeydown))

  const service = {
    name: 'modal',
    isOpen: () => !!current,
    /** 通用打开：{ title, description, input, value, requireValue, confirmText, cancelText, dismissible } */
    open(options = {}) {
      if (current) close({ ok: false, superseded: true })
      const {
        title = '提示',
        description = '',
        input = false,
        value = '',
        placeholder = '',
        requireValue = false,
        confirmText = '确定',
        cancelText = '取消',
        dismissible = true,
        autoFocus = true,
      } = options

      titleEl.textContent = title
      descEl.textContent = description
      descEl.style.display = description ? '' : 'none'
      inputEl.style.display = input ? '' : 'none'
      inputEl.value = value
      inputEl.placeholder = placeholder
      okBtn.textContent = confirmText
      cancelBtn.textContent = cancelText
      cancelBtn.style.display = options.hideCancel ? 'none' : ''
      okBtn.disabled = requireValue && !value.trim()

      mask.classList.add('show')
      ctx.emit('modal:opened', { title })

      if (input && autoFocus) setTimeout(() => { inputEl.focus(); inputEl.select?.() }, 30)

      return new Promise(resolve => {
        current = { resolve, requireValue, dismissible }
        syncDisabled()
      })
    },

    confirm(title, description = '') {
      return service.open({ title, description })
    },

    /** 输入框弹窗，对应 demo 的「添加分组 / 重命名」 */
    prompt({ title, value = '', placeholder = '填写内容', maxlength = 10, confirmText = '确定' } = {}) {
      inputEl.maxLength = maxlength
      return service.open({ title, value, input: true, requireValue: true, placeholder, confirmText })
    },

    close: () => close({ ok: false }),
  }

  ctx.provide('modal', service, { type: 'singleton' })
  ctx.logger.debug('弹窗宿主就绪')
}
