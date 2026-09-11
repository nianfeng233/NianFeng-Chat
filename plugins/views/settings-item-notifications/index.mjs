/**
 * 设置项 · 通知：通知开关、系统级通道与分类展示（F12 notification 的界面）。
 */
export const name = 'settings-item-notifications'
export const version = '2.0.0'
export const displayName = '设置项 · 通知'
export const description = '设置页 · 消息提醒、系统通知权限、通知分类与测试。'
export const author = '风语内核'
export const icon = '🔔'
export const core = false
export const depends = { 'settings-container': '^1.0.0', notification: '^1.0.0', permissions: '^1.0.0' }
export const inject = ['settings-container', 'notification', 'config', 'toast', 'event-bus']
export const permissions = ["notify"]

import { page, section, card, row, switchBtn, bindConfigControls } from '../../../src/util/settings.mjs'
import { icons } from '../../../src/util/icons.mjs'

export function apply(ctx) {
  const pages = ctx.inject('settings-container')
  const notification = ctx.inject('notification')
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

      container.innerHTML = page('通知', '收到角色消息、系统事件或插件提醒时，风语会在右下角弹出通知，并在系统允许时发送操作系统级通知。', `
        ${section('消息提醒', card(
          row('角色消息通知', '每收到一条角色消息就提醒一次；窗口在后台、或不在该消息所属会话时必定弹出', switchBtn('notify.messages', true)) +
          row('声音提示', '通知到达时播放提示音', switchBtn('notify.sound', true)) +
          row('后台活动', '页面不可见（切到其他程序或最小化）时仍然发送通知', switchBtn('notify.background', true)),
        ))}
        ${section('系统通知', card(
          row('通知权限', hosted ? '桌面版由外壳直接发送 Windows 系统通知，不再经过浏览器权限' : '浏览器系统通知需要授权后才能显示', permissionControl) +
          row('发送系统通知', '在右下角通知中心之外，同时发送操作系统级通知', switchBtn('notify.system', true)) +
          row('测试系统通知', '验证系统级通道；失败时仍会在右下角显示应用内通知', '<button class="outline-btn" data-action="test-system">发送</button>') +
          row('测试角色消息', '按“角色头像 + 角色名 + 消息预览”的样式发送一条示例', '<button class="outline-btn" data-action="test-character">发送</button>'),
        ))}
        ${section('通知样式', card(
          row('系统通知', '风语 logo + 标题 + 内容，用于程序状态与后台任务', '<span class="plugin-tag">样式一</span>') +
          row('角色消息', '最左侧角色头像，右侧角色名与消息内容预览', '<span class="plugin-tag">样式二</span>') +
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
        }
        if (action === 'test-system') {
          const sent = notification.notify({ kind: 'system', title: '风语', body: '这是一条系统通知测试。', level: 'success', sound: true, duration: 8000 })
          if (sent === false) toast.warn('系统通知已关闭：请打开「发送系统通知」后重试')
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
        }
        if (action === 'test') {
          const sent = notification.notify({ kind: 'other', title: '风语插件', body: '这是一条插件测试通知', level: 'success', sound: true, plugin: true, duration: 8000 })
          if (sent === false) toast.warn('插件通知已被「允许插件发送系统通知」关闭')
        }
      }
      container.addEventListener('click', onClick)
      const offs = [events.on('notification:permission', () => ctx.inject('settings-container').open('notifications'))]

      const unbind = bindConfigControls(container, ctx)
      return () => {
        offs.forEach(off => off())
        container.removeEventListener('click', onClick)
        unbind()
      }
    },
  })
}
