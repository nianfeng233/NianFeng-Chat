/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * V19 · settings-item-theme
 * 外观设置：主题（theme-tokens）、背景（bg-provider）、界面细节。
 * 同时暴露 appearance-page 服务，供 V20 气泡设置插入自己的区块。
 */
export const name = 'settings-item-theme'
export const version = '1.0.0'
export const displayName = '设置项 · 外观'
export const description = '设置页 · 主题、背景与界面细节，支持插件继续追加区块。'
export const author = '念风内核'
export const icon = '🎨'
export const core = true
export const depends = { 'settings-container': '^1.0.0', 'theme-tokens': '^1.0.0', 'bg-provider': '^1.0.0' }
export const inject = ['settings-container', 'theme', 'bg-provider', 'theme-tokens', 'config', 'event-bus', 'toast']
export const provides = [{ name: 'appearance-page', type: 'singleton' }]

import { page, section, card, row, switchBtn, bindConfigControls } from '../../../src/util/settings.mjs'
import { icons } from '../../../src/util/icons.mjs'
import { escapeHtml } from '../../../src/util/format.mjs'
import { GLASS_PANELS, GLASS_PANEL_BY_ID, GLASS_PROPERTIES, glassConfigKey, glassVarName, clampGlassValue } from '../../../src/util/glass.mjs'

export function apply(ctx) {
  const pages = ctx.inject('settings-container')
  const theme = ctx.inject('theme')
  const bg = ctx.inject('bg-provider')
  const themeTokens = ctx.inject('theme-tokens')
  const config = ctx.inject('config')
  const events = ctx.inject('event-bus')
  const toast = ctx.inject('toast')

  /** 其他插件往外观页追加的区块：fn(container) => cleanup */
  const extraSections = []

  const glassControl = (panel, prop) => {
    const meta = GLASS_PROPERTIES[prop]
    const fallback = panel.defaults[prop] ?? meta.default
    const value = clampGlassValue(prop, config.get(glassConfigKey(panel, prop), fallback), fallback)
    const scale = meta.scale || 1
    const sliderValue = Number((value * scale).toFixed(2))
    return `<span class="glass-alpha-control">
      <input type="range" class="glass-alpha-range" min="${meta.min}" max="${meta.max}" step="${meta.step}" value="${sliderValue}"
        data-glass-panel="${panel.id}" data-glass-prop="${prop}" />
      <b data-glass-value="${panel.id}:${prop}">${sliderValue}${meta.unit || ''}</b>
    </span>`
  }

  const glassPanelBlock = panel => `
    <details class="glass-panel">
      <summary>
        <b>${panel.label}</b><span>${panel.help}</span>
        <button class="outline-btn glass-panel-reset" data-glass-reset="${panel.id}">恢复本面板</button>
      </summary>
      <div class="settings-card">
        ${Object.entries(GLASS_PROPERTIES)
          .map(([prop, meta]) => row(meta.label, meta.help, glassControl(panel, prop)))
          .join('')}
      </div>
    </details>`

  /** 拖动只预览，松手才写 config；theme-tokens 会同步更新所有面板变量。 */
  const bindGlassSliders = container => {
    const offs = []
    container.querySelectorAll('[data-glass-panel]').forEach(input => {
      const panel = GLASS_PANEL_BY_ID[input.dataset.glassPanel]
      const prop = input.dataset.glassProp
      const meta = GLASS_PROPERTIES[prop]
      if (!panel || !meta) return
      const key = glassConfigKey(panel, prop)
      const label = container.querySelector(`[data-glass-value="${panel.id}:${prop}"]`)
      const readValue = () => {
        const raw = Number(input.value) / (meta.scale || 1)
        return clampGlassValue(prop, raw, panel.defaults[prop] ?? meta.default)
      }
      const preview = () => {
        const value = readValue()
        if (label) label.textContent = `${input.value}${meta.unit || ''}`
        document.documentElement.style.setProperty(glassVarName(panel, prop), meta.css(value, meta))
      }
      const commit = () => {
        preview()
        config.set(key, readValue())
      }
      input.addEventListener('input', preview)
      input.addEventListener('change', commit)
      offs.push(() => {
        input.removeEventListener('input', preview)
        input.removeEventListener('change', commit)
      })
    })
    return () => offs.forEach(off => off())
  }

  /** 恢复一块或全部玻璃板的默认参数 */
  const resetGlass = (panelId = 'all') => {
    const panels = panelId === 'all' ? GLASS_PANELS : GLASS_PANELS.filter(panel => panel.id === panelId)
    for (const panel of panels) {
      for (const [prop, meta] of Object.entries(GLASS_PROPERTIES)) {
        config.set(glassConfigKey(panel, prop), panel.defaults[prop] ?? meta.default)
      }
    }
  }

  const bindGlassResets = (container, onDone) => {
    const offs = []
    container.querySelectorAll('[data-glass-reset]').forEach(button => {
      const onClick = event => {
        event.preventDefault?.()
        event.stopPropagation?.()
        resetGlass(button.dataset.glassReset)
        toast.success(button.dataset.glassReset === 'all' ? '已恢复全部玻璃板默认参数' : '已恢复该面板默认参数')
        onDone?.()
      }
      button.addEventListener('click', onClick)
      offs.push(() => button.removeEventListener('click', onClick))
    })
    return () => offs.forEach(off => off())
  }

  pages.register({
    id: 'appearance',
    group: '偏好',
    groupOrder: 30,
    label: '外观',
    icon: icons.palette,
    order: 40,
    render(container) {
      let previousCleanup = null
      const render = () => {
        previousCleanup?.()
        previousCleanup = null
        const themes = theme.list()
        const backgrounds = bg.list()
        const activeTheme = theme.getActiveId()
        const activeBg = bg.active()

        const hasBgImage = !!config.get('ui.backgroundImage', '')
        container.innerHTML = page('外观', '主题、背景、气泡都是可选中型服务，你可以在已安装的实现之间自由切换。', `
          ${section('主题', card(
            themes
              .map(t => row(
                escapeHtml(t.label || t.id),
                escapeHtml(t.description || ''),
                t.id === activeTheme ? '<span class="text-good">● 使用中</span>' : `<button class="outline-btn" data-theme="${t.id}">切换使用</button>`,
              ))
              .join('') +
            row('强调色', '按钮、选中状态、交互提示的颜色', `<input type="color" class="color-dot" data-accent value="${themeTokens.accent()}" />`),
          ))}
          ${section('背景', card(
            backgrounds
              .map(b => {
                if (b.id === activeBg) return row(escapeHtml(b.label || b.id), escapeHtml(b.description || ''), '<span class="text-good">● 使用中</span>')
                if (b.id === 'bg-image' && !hasBgImage) {
                  return row(escapeHtml(b.label || b.id), escapeHtml(b.description || ''), '<span class="plugin-tag disabled">未上传图片</span>')
                }
                return row(escapeHtml(b.label || b.id), escapeHtml(b.description || ''), `<button class="outline-btn" data-bg="${b.id}">切换使用</button>`)
              })
              .join('') +
            row(
              '自定义背景图片',
              '选择一张图片（本机自动压缩后保存），会自动切换到图片背景；清除后回到绿雾背景',
              `<label class="file-picker" title="选择一张本地图片">
                <input type="file" accept="image/*" data-bg-upload />
                <span class="file-picker-face">${hasBgImage ? '更换图片' : '选择图片'}</span>
                <span class="file-picker-name" data-bg-file-name>${hasBgImage ? '当前：自定义背景图' : '未选择图片'}</span>
              </label>
               ${hasBgImage ? '<button class="outline-btn danger-btn" data-action="clear-bg">清除</button>' : ''}
               ${hasBgImage ? `<span title="当前背景图" style="width:46px;height:28px;border-radius:6px;background-image:url('${escapeHtml(config.get('ui.backgroundImage', ''))}');background-size:cover;background-position:center;border:1px solid rgba(0,0,0,.08);display:inline-block"></span>` : ''}`,
            ),
          ))}
          <div data-appearance-extra></div>
          ${section('玻璃板属性', `
            <div class="glass-panel-toolbar">
              <button class="outline-btn danger-btn" data-glass-reset="all">恢复全部默认</button>
              <span>调乱时点这里；每块面板右侧也可以单独恢复。</span>
            </div>
            <div class="glass-panel-list">${GLASS_PANELS.map(glassPanelBlock).join('')}</div>
            <div class="settings-note" style="margin-top:10px">透明度 / 模糊度 / 饱和度 / 亮度 / 边框宽度可按面板单独调。模糊度调低、透明度调低，适合视频壁纸或需要“更清晰”的场景。</div>`)}
          ${section('界面细节', card(
            row('界面动画', '保留面板切换与按钮的细微过渡效果', switchBtn('ui.animation', true)) +
            row('紧凑模式', '减少列表项目与控件之间的间距', switchBtn('ui.compact', false)),
          ))}`)

        /* 主题切换 */
        container.querySelectorAll('[data-theme]').forEach(btn => {
          btn.addEventListener('click', () => {
            theme.select(btn.dataset.theme)
            toast.success(`已切换到「${btn.closest('.setting-row')?.querySelector('.setting-name')?.textContent || btn.dataset.theme}」`)
            render()
          })
        })

        /* 强调色 */
        const accent = container.querySelector('[data-accent]')
        const onAccent = () => {
          themeTokens.setAccent(accent.value)
          render()
        }
        accent.addEventListener('change', onAccent)

        /* 背景切换 */
        container.querySelectorAll('[data-bg]').forEach(btn => {
          btn.addEventListener('click', () => {
            bg.select(btn.dataset.bg)
            toast.success(`已切换到「${btn.closest('.setting-row')?.querySelector('.setting-name')?.textContent || btn.dataset.bg}」`)
            render()
          })
        })

        /* 自定义背景图：压缩后存 localStorage，并自动选中 bg-image */
        const applyBackgroundFile = file => {
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
          reader.onerror = () => toast.error('图片读取失败')
          reader.onload = () => {
            const image = new Image()
            image.onerror = () => toast.error('图片解析失败，请换一张试试')
            image.onload = () => {
              try {
                const maxSide = 1920
                const scale = Math.min(1, maxSide / Math.max(image.width || 1, image.height || 1))
                const canvas = document.createElement('canvas')
                canvas.width = Math.max(1, Math.round((image.width || 1) * scale))
                canvas.height = Math.max(1, Math.round((image.height || 1) * scale))
                const painter = canvas.getContext('2d')
                if (!painter) throw new Error('无法创建画布')
                painter.drawImage(image, 0, 0, canvas.width, canvas.height)
                const dataUrl = canvas.toDataURL('image/jpeg', 0.82)
                if (dataUrl.length > 3.6 * 1024 * 1024) throw new Error('图片压缩后仍然太大，请换一张更小的图片')
                config.set('ui.backgroundImage', dataUrl)
                bg.select('bg-image')
                toast.success('背景图片已应用')
                render()
              } catch (err) {
                toast.error(`图片处理失败：${err.message}`)
              }
            }
            image.src = String(reader.result)
          }
          reader.readAsDataURL(file)
        }
        const fileInput = container.querySelector('[data-bg-upload]')
        const fileLabel = container.querySelector('[data-bg-file-name]')
        fileInput?.addEventListener('change', event => {
          const file = event.target.files?.[0]
          if (file && fileLabel) fileLabel.textContent = file.name
          applyBackgroundFile(file)
          event.target.value = ''
        })
        container.querySelector('[data-action="clear-bg"]')?.addEventListener('click', () => {
          config.set('ui.backgroundImage', '')
          if (bg.active() === 'bg-image') bg.select('bg-aurora')
          toast.success('自定义背景图已清除')
          render()
        })

        const glassUnbind = bindGlassSliders(container)
        const glassResetUnbind = bindGlassResets(container, render)

        /* 插件追加区块 */
        const extra = container.querySelector('[data-appearance-extra]')
        const cleanups = extraSections.map(fn => fn(extra, ctx)).filter(fn => typeof fn === 'function')

        const unbind = bindConfigControls(container, ctx)
        previousCleanup = () => {
          glassUnbind()
          glassResetUnbind()
          cleanups.forEach(fn => fn())
          unbind()
        }
      }

      render()
      const offs = [
        events.on('theme:changed', render),
        events.on('bg:changed', render),
        events.on('appearance:section-added', render),
      ]
      return () => {
        previousCleanup?.()
        offs.forEach(off => off())
      }
    },
  })

  ctx.provide('appearance-page', {
    name: 'appearance-page',
    addSection(fn) {
      extraSections.push(fn)
      ctx.effect(() => {
        const i = extraSections.indexOf(fn)
        if (i >= 0) extraSections.splice(i, 1)
      })
      events.emit('appearance:section-added', {})
      return fn
    },
    sections: () => [...extraSections],
  }, { type: 'singleton' })
}
