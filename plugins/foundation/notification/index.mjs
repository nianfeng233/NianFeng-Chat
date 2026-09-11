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
 *   - 浏览器环境：Notification API（权限允许时），使用角色头像作为图标；
 *   - 桌面版：通过 window.windHost.notify 交给 Rust 宿主弹 Windows 通知，
 *     并把头像转成 64×64 PNG 交给宿主（Shell_NotifyIcon 大图标 / 操作中心头像）；
 *   - 无论系统级通道是否可用，右下角通知中心都会展示，保证用户能看到提醒。
 *
 * 提示音：
 *   - 内置音色（默认 / 清脆 / 柔和 / 双响）；
 *   - 支持上传自定义音频（data URL 存在 config，不依赖外部文件）。
 */
export const name = 'notification'
export const version = '2.1.0'
export const displayName = '消息通知'
export const description = '基础服务 · 右下角通知中心（系统通知 / 角色消息 / 其他）、系统通知头像、自定义提示音。'
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
const ICON_SIZE = 64

const BELL_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 8-3 8h18s-3-1-3-8"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>'

/** 内置提示音：不同音色/节奏，全部用 Web Audio 现场合成，不依赖音频文件 */
const SOUND_PRESETS = {
  default: {
    label: '默认',
    notes: [{ f: 880, type: 'sine', dur: 0.18, gain: 0.05 }],
  },
  clear: {
    label: '清脆',
    notes: [
      { f: 1320, type: 'triangle', dur: 0.12, gain: 0.045 },
      { f: 990, type: 'triangle', dur: 0.16, gain: 0.04, delay: 0.09 },
    ],
  },
  soft: {
    label: '柔和',
    notes: [{ f: 660, type: 'sine', dur: 0.3, gain: 0.032 }],
  },
  double: {
    label: '双响',
    notes: [
      { f: 980, type: 'sine', dur: 0.12, gain: 0.045 },
      { f: 980, type: 'sine', dur: 0.12, gain: 0.045, delay: 0.2 },
    ],
  },
}

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

  /* ---------------- 提示音 ---------------- */
  const getAudioContext = (() => {
    let audioCtx = null
    return () => {
      const Ctx = typeof window !== 'undefined' ? window.AudioContext || window.webkitAudioContext : null
      if (!Ctx) return null
      audioCtx = audioCtx || new Ctx()
      if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {})
      return audioCtx
    }
  })()

  const playPreset = presetId => {
    const preset = SOUND_PRESETS[presetId] || SOUND_PRESETS.default
    const audioCtx = getAudioContext()
    if (!audioCtx) return false
    try {
      const startAt = audioCtx.currentTime
      for (const note of preset.notes) {
        const osc = audioCtx.createOscillator()
        const gain = audioCtx.createGain()
        osc.type = note.type || 'sine'
        osc.frequency.value = note.f
        const at = startAt + (note.delay || 0)
        gain.gain.setValueAtTime(0.0001, at)
        gain.gain.exponentialRampToValueAtTime(note.gain || 0.04, at + 0.01)
        gain.gain.exponentialRampToValueAtTime(0.0001, at + note.dur)
        osc.connect(gain).connect(audioCtx.destination)
        osc.start(at)
        osc.stop(at + note.dur + 0.02)
      }
      return true
    } catch (_) {
      return false
    }
  }

  const playCustomSound = dataUrl => {
    try {
      const audio = new Audio(String(dataUrl))
      audio.volume = 1
      audio.play().catch(() => {})
      return true
    } catch (_) {
      return false
    }
  }

  const customSound = () => String(config.get('notify.soundData', '') || '').trim()

  const playSound = () => {
    if (config.get('notify.sound', true) === false) return false
    const custom = customSound()
    if (custom) return playCustomSound(custom)
    return playPreset(String(config.get('notify.soundPreset', 'default') || 'default'))
  }

  /* ---------------- 系统通知图标（头像） ---------------- */
  const iconCache = new Map()

  const imageToDataUrl = (src, { square = true } = {}) =>
    new Promise(resolve => {
      if (!src || typeof Image === 'undefined' || typeof document === 'undefined') return resolve('')
      const key = `img:${square}:${src}`
      if (iconCache.has(key)) return resolve(iconCache.get(key))
      const image = new Image()
      image.crossOrigin = 'anonymous'
      image.onload = () => {
        try {
          const canvas = document.createElement('canvas')
          canvas.width = ICON_SIZE
          canvas.height = ICON_SIZE
          const painter = canvas.getContext('2d')
          if (!painter) throw new Error('canvas')
          if (square) {
            const side = Math.min(image.width || ICON_SIZE, image.height || ICON_SIZE)
            painter.drawImage(
              image,
              ((image.width || side) - side) / 2,
              ((image.height || side) - side) / 2,
              side,
              side,
              0,
              0,
              ICON_SIZE,
              ICON_SIZE,
            )
          } else {
            painter.drawImage(image, 0, 0, ICON_SIZE, ICON_SIZE)
          }
          const dataUrl = canvas.toDataURL('image/png')
          iconCache.set(key, dataUrl)
          resolve(dataUrl)
        } catch (_) {
          resolve('')
        }
      }
      image.onerror = () => resolve('')
      image.src = src
    })

  /** 没有头像图片时，用角色首字 + 色板生成 64×64 头像（与聊天界面里的角色色块一致） */
  const textAvatarToDataUrl = ({ text, c1, c2 }) => {
    if (typeof document === 'undefined') return ''
    const key = `text:${text}:${c1}:${c2}`
    if (iconCache.has(key)) return iconCache.get(key)
    try {
      const canvas = document.createElement('canvas')
      canvas.width = ICON_SIZE
      canvas.height = ICON_SIZE
      const painter = canvas.getContext('2d')
      if (!painter) return ''
      const gradient = painter.createLinearGradient(0, 0, ICON_SIZE, ICON_SIZE)
      gradient.addColorStop(0, c1 || '#a8b6ff')
      gradient.addColorStop(1, c2 || '#5a8dff')
      painter.fillStyle = gradient
      painter.fillRect(0, 0, ICON_SIZE, ICON_SIZE)
      painter.fillStyle = '#ffffff'
      painter.font = 'bold 34px "Microsoft YaHei", sans-serif'
      painter.textAlign = 'center'
      painter.textBaseline = 'middle'
      painter.fillText(String(text || '?').slice(0, 1), ICON_SIZE / 2, ICON_SIZE / 2 + 2)
      const dataUrl = canvas.toDataURL('image/png')
      iconCache.set(key, dataUrl)
      return dataUrl
    } catch (_) {
      return ''
    }
  }

  const buildIcon = async options => {
    const kind = options.kind || 'system'
    const imageSource = kind === 'character' ? options.avatarImage || '' : ''
    if (imageSource) {
      const dataUrl = await imageToDataUrl(imageSource)
      if (dataUrl) return dataUrl
    }
    if (kind === 'character') {
      const text = options.avatarText || options.avatar || String(options.title || '').slice(0, 1)
      const dataUrl = textAvatarToDataUrl({ text, c1: options.c1, c2: options.c2 })
      if (dataUrl) return dataUrl
    }
    return imageToDataUrl(new URL(FENGYU_LOGO, typeof location !== 'undefined' && location.href ? location.href : 'http://127.0.0.1/').href)
  }

  /** 系统级通知：桌面宿主优先，其次浏览器 Notification */
  const nativeNotify = async ({ kind, title, body, avatarImage, avatarText, avatar, c1, c2, onClick }) => {
    const iconDataUrl = await buildIcon({ kind, title, avatarImage, avatarText, avatar, c1, c2 })
    if (hostNotify) {
      try {
        host.notify({
          kind,
          title,
          body,
          // 宿主只收纯 base64，避免超长 dataURL 前缀
          icon: iconDataUrl ? iconDataUrl.split(',')[1] || '' : '',
        })
        return true
      } catch (_) {
        return false
      }
    }
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      try {
        const n = new Notification(title, {
          body,
          icon: iconDataUrl || FENGYU_LOGO,
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

      if (system && config.get('notify.system', true)) {
        // 头像转换 + 宿主 IPC 是异步的；应用内卡片先同步显示，系统通知随后补上。
        nativeNotify({ ...options, kind, title, body, avatarImage, onClick }).catch(() => {})
      }
      renderCard({ ...options, kind, title, body, duration })
      if (sound) playSound()
      ctx.emit('notification:sent', { kind, title, body, level })
      return true
    },

    /** 播放提示音（设置页试听 / 插件调用） */
    playSound,
    /** 兼容旧调用名 */
    beep: playSound,

    soundPresets: () => Object.entries(SOUND_PRESETS).map(([id, preset]) => ({ id, label: preset.label })),
    previewSound: presetId => {
      if (presetId) return playPreset(presetId)
      return playSound()
    },
    hasCustomSound: () => !!customSound(),

    /** 清空通知中心（调试 / 测试用） */
    clear: () => {
      for (const card of [...cards]) closeCard(card)
    },
  }

  ctx.provide('notification', service, { type: 'singleton' })
  ctx.logger.debug(`通知服务就绪（系统通道：${hostNotify ? '桌面宿主' : '浏览器'}）`)
}
