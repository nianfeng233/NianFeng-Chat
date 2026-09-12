/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * 设置项 · 通知：通知开关、系统级通道、提示音与分类展示（F12 notification 的界面）。
 */
export const name = 'settings-item-notifications'
export const version = '2.1.0'
export const displayName = '设置项 · 通知'
export const description = '设置页 · 消息提醒、系统通知权限、提示音与测试。'
export const author = '念风内核'
export const icon = '🔔'
export const core = false
export const depends = { 'settings-container': '^1.0.0', notification: '^2.1.0', permissions: '^1.0.0' }
export const inject = ['settings-container', 'notification', 'config', 'toast', 'event-bus']
export const permissions = ["notify"]

import { page, section, card, row, switchBtn, select, bindConfigControls } from '../../../src/util/settings.mjs'
import { icons } from '../../../src/util/icons.mjs'

const MAX_SOUND_BYTES = 1024 * 1024

export function apply(ctx) {
  const pages = ctx.inject('settings-container')
  const notification = ctx.inject('notification')
  const config = ctx.inject('config')
  const toast = ctx.inject('toast')
  const events = ctx.inject('event-bus')

  pages.register({
    id: 'notifications',
    group: '偏好',
    groupOrder: 30,
    label: '通知',
    icon: icons.bell,
    order: 50,
    render(container) {
      const hosted = notification.isHosted()
      const permission = notification.permission()
      const permissionText = {
        granted: hosted ? '桌面宿主托管（无需授权）' : '已授权',
        denied: '已拒绝',
        default: '未授权',
        unsupported: '浏览器不支持',
      }[permission] || permission
      const permissionColor = permission === 'granted' ? 'text-good' : permission === 'denied' ? 'text-bad' : 'text-warn'
      const permissionControl = hosted
        ? `<span class="${permissionColor}">● ${permissionText}</span>`
        : `<span class="${permissionColor}">● ${permissionText}</span>
           <button class="outline-btn" data-action="permission">请求授权</button>`

      const soundPresets = notification.soundPresets?.() || []
      const customSound = !!String(config.get('notify.soundData', '') || '').trim()
      const soundName = customSound ? '已使用自定义铃声' : '未选择（使用上方内置音色）'

      container.innerHTML = page('通知', '收到角色消息、系统事件或插件提醒时，念风会在右下角弹出通知，并在系统允许时发送操作系统级通知。', `
        ${section('消息提醒', card(
          row('角色消息通知', '每收到一条角色消息就提醒一次；窗口在后台、或不在该消息所属会话时必定弹出', switchBtn('notify.messages', true)) +
          row('声音提示', '通知到达时播放提示音', switchBtn('notify.sound', true)) +
          row('后台活动', '页面不可见（切到其他程序或最小化）时仍然发送通知', switchBtn('notify.background', true)),
        ))}
        ${section('提示音', card(
          row('内置音色', '通知到达时播放的音色；选择后可以点右侧试听',
            `${select('notify.soundPreset', soundPresets.map(item => ({ value: item.id, label: item.label })), config.get('notify.soundPreset', 'default'))}
             <button class="outline-btn" data-action="preview-sound">试听</button>`) +
          row('自定义铃声', `支持 mp3 / wav / ogg，建议不超过 ${Math.round(MAX_SOUND_BYTES / 1024)}KB；保存在本机配置中`,
            `<input type="file" accept="audio/*" data-sound-file hidden />
             <button class="outline-btn" data-action="pick-sound">选择文件</button>
             <span class="plugin-tag${customSound ? '' : ' disabled'}" data-sound-name>${soundName}</span>
             ${customSound ? '<button class="outline-btn danger-btn" data-action="clear-sound">清除</button>' : ''}`),
        ))}
        ${section('系统通知', card(
          row('通知权限', hosted ? '桌面版由外壳直接发送 Windows 系统通知，不再经过浏览器权限' : '浏览器系统通知需要授权后才能显示', permissionControl) +
          row('发送系统通知', '在右下角通知中心之外，同时发送操作系统级通知；角色消息会带上角色头像', switchBtn('notify.system', true)) +
          row('测试系统通知', '验证系统级通道；失败时仍会在右下角显示应用内通知', '<button class="outline-btn" data-action="test-system">发送</button>') +
          row('测试角色消息', '按“角色头像 + 角色名 + 消息预览”的样式发送一条示例', '<button class="outline-btn" data-action="test-character">发送</button>'),
        ))}
        ${section('通知样式', card(
          row('系统通知', '念风 logo + 标题 + 内容，用于程序状态与后台任务', '<span class="plugin-tag">样式一</span>') +
          row('角色消息', '最左侧角色头像，右侧角色名与消息内容预览；系统通知里同样带头像', '<span class="plugin-tag">样式二</span>') +
          row('其他通知', '通用提示图标 + 标题 + 内容，用于插件与扩展', '<span class="plugin-tag">样式三</span>'),
        ))}
        ${section('插件通知', card(
          row('允许插件发送系统通知', '插件调用 notification.notify({ plugin: true }) 时受此开关约束', switchBtn('notify.pluginAllowed', true)) +
          row('发送插件测试通知', '以插件身份发送一条“其他通知”，验证通知链路与权限开关', '<button class="outline-btn" data-action="test">发送</button>'),
        ))}`)

      const onClick = async e => {
        const action = e.target.closest('[data-action]')?.dataset.action
        if (action === 'permission') {
          const result = await notification.requestPermission()
          toast.info(`通知权限：${result}`)
          ctx.inject('settings-container').open('notifications')
          return
        }
        if (action === 'preview-sound') {
          const preset = container.querySelector('[data-config-select="notify.soundPreset"]')?.value || 'default'
          notification.previewSound?.(preset)
          return
        }
        if (action === 'pick-sound') {
          container.querySelector('[data-sound-file]')?.click()
          return
        }
        if (action === 'clear-sound') {
          config.set('notify.soundData', '')
          toast.info('已清除自定义铃声')
          ctx.inject('settings-container').open('notifications')
          return
        }
        if (action === 'test-system') {
          const sent = notification.notify({ kind: 'system', title: '念风', body: '这是一条系统通知测试。', level: 'success', sound: true, duration: 8000 })
          if (sent === false) toast.warn('系统通知已关闭：请打开「发送系统通知」后重试')
          return
        }
        if (action === 'test-character') {
          const sent = notification.notify({
            kind: 'character',
            title: '测试角色',
            body: '这是一条角色消息通知预览：角色头像、角色名和消息内容会显示在这里。',
            avatarText: '测',
            c1: '#7fb2ff',
            c2: '#4a7dff',
            sound: false,
            duration: 8000,
          })
          if (sent === false) toast.warn('角色消息通知已关闭：请打开「角色消息通知」后重试')
          return
        }
        if (action === 'test') {
          const sent = notification.notify({ kind: 'other', title: '念风插件', body: '这是一条插件测试通知', level: 'success', sound: true, plugin: true, duration: 8000 })
          if (sent === false) toast.warn('插件通知已被「允许插件发送系统通知」关闭')
        }
      }

      const onSoundFileChange = event => {
        const input = event.target.closest?.('[data-sound-file]')
        if (!input) return
        const file = input.files?.[0]
        if (!file) return
        if (!/^audio\//i.test(file.type || '') && !/\.(mp3|wav|ogg|m4a|aac|flac)$/i.test(file.name || '')) {
          toast.error('请选择音频文件（mp3 / wav / ogg 等）')
          return
        }
        if (file.size > MAX_SOUND_BYTES) {
          toast.error(`音频文件太大：${Math.round(file.size / 1024)}KB，建议不超过 ${Math.round(MAX_SOUND_BYTES / 1024)}KB`)
          return
        }
        const reader = new FileReader()
        reader.onerror = () => toast.error('音频读取失败')
        reader.onload = () => {
          config.set('notify.soundData', String(reader.result || ''))
          toast.success('自定义铃声已保存，正在试听…')
          setTimeout(() => notification.previewSound?.(), 120)
          ctx.inject('settings-container').open('notifications')
        }
        reader.readAsDataURL(file)
      }

      const previewOnChange = event => {
        const el = event.target.closest?.('[data-config-select="notify.soundPreset"]')
        if (el) notification.previewSound?.(el.value)
      }

      container.addEventListener('click', onClick)
      container.addEventListener('change', onSoundFileChange)
      container.addEventListener('change', previewOnChange)
      const offs = [events.on('notification:permission', () => ctx.inject('settings-container').open('notifications'))]

      const unbind = bindConfigControls(container, ctx)
      return () => {
        offs.forEach(off => off())
        container.removeEventListener('click', onClick)
        container.removeEventListener('change', onSoundFileChange)
        container.removeEventListener('change', previewOnChange)
        unbind()
      }
    },
  })
}
