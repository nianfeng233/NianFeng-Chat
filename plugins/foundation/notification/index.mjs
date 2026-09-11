/**
 * F12 · notification
 * 消息通知：右下角通知中心 + 系统级通知 + 提示音。
 *
 * 三种通知样式：
 *   - system    系统通知：风语 logo + 标题 + 内容；
 *   - character 角色消息：左侧角色头像，右侧角色名 + 消息预览；
 *   - other     其他通知：通用图标 + 标题 + 内容。
 *
 * 系统级通道：
 *   - 浏览器环境：Notification API（权限允许时）；
 *   - 桌面版：通过 window.windHost.notify 交给 Rust 宿主弹 Windows 通知，
 *     不再依赖 WebView2 的 Notification 权限，因此 exe 里不会出现“已拒绝”；
 *   - 无论系统级通道是否可用，右下角通知中心都会展示，保证用户能看到提醒。
 */
export const name = 'notification'
export const version = '2.0.0'
export const displayName = '消息通知'
export const description = '基础服务 · 右下角通知中心（系统通知 / 角色消息 / 其他）、桌面通知与提示音。'
export const author = '风语内核'
export const icon = '🔔'
export const core = false
export const depends = { config: '^1.0.0' }
export const inject = ['config', 'event-bus']
export const provides = [{ name: 'notification', type: 'singleton' }]

import { useStyle } from '../../../src/util/style.mjs'
import { NOTIFICATION_CSS } from './style.mjs'
import { FENGYU_LOGO, avatarHtmlFromInfo } from '../../../src/util/identity.mjs'

const MAX_CARDS = 5
const CARD_DURATION = 6200

const BELL_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 8-3 8h18s-3-1-3-8"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>'

export function apply(ctx) {
  const config = ctx.inject('config')

  // 旧版「后台活动」默认关闭，升级后默认开启；只迁移一次，之后尊重用户选择。
  if (!config.get('notify.backgroundDefaultMigrated', false)) {
    if (config.get('notify.background') === false) config.set('notify.background', true)
    config.set('notify.backgroundDefaultMigrated', true)
  }

  /** 桌面宿主桥（exe 版）：存在时系统通知交给 Rust，权限不再是问题 */
  const host = typeof window !== 'undefined' ? window.windHost : null
  const hostNotify = typeof host?.notify === 'function'

  const center = document.createElement('div')
  center.className = 'notify-center'
  center.dataset.notifyCenter = '1'
  document.body.appendChild(center)
  useStyle(ctx, NOTIFICATION_CSS)
  ctx.effect(() => center.remove())

  const cards = []

  const closeCard = card => {
    const index = cards.indexOf(card)
    if (index >= 0) cards.splice(index, 1)
    clearTimeout(card.timer)
    card.el.classList.remove('show')
    setTimeout(() => card.el.remove(), 240)
  }

  const renderCard = options => {
    const kind = ['system', 'character', 'other'].includes(options.kind) ? options.kind : 'system'
    const el = document.createElement('div')
    el.className = `notify-card notify-kind-${kind}`

    let iconHtml
    if (kind === 'character') {
      iconHtml = avatarHtmlFromInfo(
        {
          avatarImage: options.avatarImage,
          avatarText: options.avatarText,
          avatar: options.avatar,
          name: options.title,
          c1: options.c1,
          c2: options.c2,
        },
        { className: 'notify-avatar', title: options.title },
      )
    } else if (kind === 'system') {
      iconHtml = `<div class="notify-logo"><img src="${FENGYU_LOGO}" alt="风语" /></div>`
    } else {
      iconHtml = `<div class="notify-emoji">${BELL_ICON}</div>`
    }

    el.innerHTML = `
      ${iconHtml}
      <div class="notify-body">
        <div class="notify-title"></div>
        <div class="notify-desc"></div>
      </div>
      <button class="notify-close" type="button" title="关闭" aria-label="关闭">×</button>`
    el.querySelector('.notify-title').textContent = String(options.title || '风语')
    el.querySelector('.notify-desc').textContent = String(options.body || '')
    el.querySelector('.notify-close').addEventListener('click', event => {
      event.stopPropagation()
      closeCard(card)
    })
    if (typeof options.onClick === 'function') {
      el.addEventListener('click', () => {
        try {
          options.onClick()
        } catch (err) {
          ctx.logger.warn('通知点击回调失败', err)
        }
        closeCard(card)
      })
    }

    const card = { el, timer: null, duration: Number.isFinite(options.duration) ? options.duration : CARD_DURATION }
    const startTimer = () => {
      if (card.duration <= 0) return
      clearTimeout(card.timer)
      card.timer = setTimeout(() => closeCard(card), card.duration)
    }
    const stopTimer = () => clearTimeout(card.timer)
    el.addEventListener('mouseenter', stopTimer)
    el.addEventListener('mouseleave', startTimer)

    center.appendChild(el)
    requestAnimationFrame(() => el.classList.add('show'))
    startTimer()
    cards.push(card)
    while (cards.length > MAX_CARDS) closeCard(cards[0])
    return card
  }

  const beep = (() => {
    let audioCtx = null
    return () => {
      try {
        const Ctx = window.AudioContext || window.webkitAudioContext
        if (!Ctx) return
        audioCtx = audioCtx || new Ctx()
        const osc = audioCtx.createOscillator()
        const gain = audioCtx.createGain()
        osc.type = 'sine'
        osc.frequency.value = 880
        gain.gain.setValueAtTime(0.0001, audioCtx.currentTime)
        gain.gain.exponentialRampToValueAtTime(0.05, audioCtx.currentTime + 0.01)
        gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.18)
        osc.connect(gain).connect(audioCtx.destination)
        osc.start()
        osc.stop(audioCtx.currentTime + 0.2)
      } catch (_) {
        /* 音频不可用就算了 */
      }
    }
  })()

  /** 系统级通知：桌面宿主优先，其次浏览器 Notification */
  const nativeNotify = ({ kind, title, body, avatarImage, onClick }) => {
    if (hostNotify) {
      try {
        host.notify({ kind, title, body })
        return true
      } catch (_) {
        return false
      }
    }
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      try {
        const n = new Notification(title, {
          body,
          icon: kind === 'character' && avatarImage ? avatarImage : FENGYU_LOGO,
          silent: true,
        })
        n.onclick = () => {
          try {
            window.focus()
          } catch (_) {
            /* ignore */
          }
          n.close()
          onClick?.()
        }
        return true
      } catch (_) {
        /* 某些环境构造 Notification 会抛错 */
      }
    }
    return false
  }

  const service = {
    name: 'notification',

    /** 是否由桌面宿主接管系统通知（exe 版） */
    isHosted: () => hostNotify,

    permission() {
      if (hostNotify) return 'granted'
      return typeof Notification !== 'undefined' ? Notification.permission : 'unsupported'
    },

    async requestPermission() {
      if (hostNotify) {
        ctx.emit('notification:permission', 'granted')
        return 'granted'
      }
      if (typeof Notification === 'undefined') return 'unsupported'
      const result = await Notification.requestPermission()
      ctx.emit('notification:permission', result)
      return result
    },

    /**
     * 发一条通知。
     * @param {{
     *   kind?: 'system'|'character'|'other',
     *   title?: string, body?: string, level?: string,
     *   system?: boolean, sound?: boolean, plugin?: boolean, background?: boolean,
     *   avatarImage?: string, avatarText?: string, avatar?: string, c1?: string, c2?: string,
     *   onClick?: Function, duration?: number,
     * }} options
     */
    notify(options = {}) {
      const {
        kind = 'system',
        title = '风语',
        body = '',
        level = 'info',
        system = true,
        sound = false,
        plugin = false,
        background = false,
        avatarImage = '',
        onClick,
        duration,
      } = options

      // 插件通知：插件必须显式声明 plugin:true，才受「允许插件发送系统通知」约束
      if (plugin && !config.get('notify.pluginAllowed', true)) return false
      // 后台通知：只在用户允许「后台活动」时才发送（默认开启）
      if (background && !config.get('notify.background', true)) return false
      // 角色消息与系统 / 其他通知分别受各自开关控制
      const gateKey = kind === 'character' ? 'notify.messages' : 'notify.system'
      if (config.get(gateKey, true) === false) return false

      let native = false
      if (system && config.get('notify.system', true)) {
        native = nativeNotify({ kind, title, body, avatarImage, onClick })
      }
      renderCard({ ...options, kind, title, body, duration })
      if (sound && config.get('notify.sound', true)) beep()
      ctx.emit('notification:sent', { kind, title, body, level, native })
      return native || true
    },

    beep,

    /** 清空通知中心（调试 / 测试用） */
    clear: () => {
      for (const card of [...cards]) closeCard(card)
    },
  }

  ctx.provide('notification', service, { type: 'singleton' })
  ctx.logger.debug(`通知服务就绪（系统通道：${hostNotify ? '桌面宿主' : '浏览器'}）`)
}
