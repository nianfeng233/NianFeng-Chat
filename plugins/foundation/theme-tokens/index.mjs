/**
 * F5 · theme-tokens
 * 全局 CSS 变量 + 可选中型主题服务（浅色 / 深色 / 跟随系统）。
 * 视觉基底取自 demo，其他插件只允许通过 var(--xxx) 使用颜色与尺寸（文档 §10.8）。
 */
export const name = 'theme-tokens'
export const version = '1.0.0'
export const displayName = '主题变量'
export const description = '基础服务 · 全局 CSS 变量管理，支持浅色 / 深色 / 跟随系统切换。'
export const author = '风语内核'
export const icon = '🎨'
export const core = true
export const depends = { config: '^1.0.0' }
export const inject = ['config', 'event-bus', 'service-container']
export const provides = [{ name: 'theme', type: 'selectable' }]

import { useStyle } from '../../../src/util/style.mjs'
import { THEME_CSS } from './style.mjs'
import { GLASS_PANELS, GLASS_PROPERTIES, glassConfigKey, glassVarName, clampGlassValue } from '../../../src/util/glass.mjs'

const THEMES = {
  light: {
    label: '浅色',
    description: '白底 + 绿雾玻璃，demo 的默认外观',
    tokens: { '--scheme': 'light' },
  },
  dark: {
    label: '深色',
    description: '低亮度背景，适合夜间使用',
    tokens: { '--scheme': 'dark' },
  },
  system: {
    label: '跟随系统',
    description: '随操作系统的浅色 / 深色偏好自动切换',
    tokens: {},
  },
}

export function apply(ctx) {
  const container = ctx.inject('service-container')
  const config = ctx.inject('config')
  useStyle(ctx, THEME_CSS)

  const theme = container.createSelectable('theme', { displayName: '主题', fallback: 'light' })

  const media = window.matchMedia?.('(prefers-color-scheme: dark)')

  const resolve = choice => {
    if (choice === 'system') return media?.matches ? 'dark' : 'light'
    return choice
  }

  const applyTheme = id => {
    const scheme = resolve(id)
    document.documentElement.dataset.theme = scheme
    document.documentElement.dataset.themeChoice = id
    document.documentElement.style.setProperty('--scheme', scheme)
    if (media) {
      media.onchange = () => {
        if (theme.getActiveId() === 'system') applyTheme('system')
      }
    }
    ctx.emit('theme:applied', { id, scheme })
  }

  for (const [id, item] of Object.entries(THEMES)) {
    const unregister = theme.register(id, { id, ...item, apply: () => applyTheme(id) }, { label: item.label, description: item.description })
    ctx.effect(unregister)
  }

  applyTheme(theme.getActiveId())
  theme.onChange(applyTheme)

  // 强调色 / 紧凑模式 / 动画开关
  const applyUI = () => {
    const accent = config.get('ui.accent', '#3b6cf6')
    const root = document.documentElement
    root.style.setProperty('--accent', accent)
    root.style.setProperty('--accent-hover', shade(accent, -12))
    root.style.setProperty('--accent-soft', hexA(accent, 0.1))
    root.style.setProperty('--accent-soft-2', hexA(accent, 0.22))
    for (const panel of GLASS_PANELS) {
      for (const [prop, meta] of Object.entries(GLASS_PROPERTIES)) {
        const fallback = panel.defaults[prop] ?? meta.default
        const value = clampGlassValue(prop, config.get(glassConfigKey(panel, prop), fallback), fallback)
        root.style.setProperty(glassVarName(panel, prop), meta.css(value, meta))
      }
    }
    root.classList.toggle('no-animation', config.get('ui.animation', true) === false)
    document.body?.classList.toggle('compact-ui', !!config.get('ui.compact'))
  }
  applyUI()
  ctx.on('config:changed', applyUI)

  ctx.provide('theme', theme, { type: 'selectable' })
  ctx.provide('theme-tokens', {
    name: 'theme-tokens',
    selectable: theme,
    setAccent: color => config.set('ui.accent', color),
    accent: () => config.get('ui.accent', '#3b6cf6'),
    scheme: () => document.documentElement.dataset.theme,
  }, { type: 'singleton' })

  ctx.logger.debug(`主题就绪：${theme.getActiveId()}`)
}

/* ---------------- 颜色小工具 ---------------- */
function hexA(hex, alpha) {
  const { r, g, b } = normalize(hex)
  return `rgba(${r},${g},${b},${alpha})`
}
function shade(hex, percent) {
  const { r, g, b } = normalize(hex)
  const f = v => Math.max(0, Math.min(255, Math.round(v + (255 * percent) / 100)))
  return `#${[f(r), f(g), f(b)].map(v => v.toString(16).padStart(2, '0')).join('')}`
}
function normalize(hex) {
  let h = String(hex).replace('#', '').trim()
  if (h.length === 3) h = h.split('').map(c => c + c).join('')
  const n = parseInt(h, 16)
  return Number.isNaN(n) ? { r: 59, g: 108, b: 246 } : { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
}
