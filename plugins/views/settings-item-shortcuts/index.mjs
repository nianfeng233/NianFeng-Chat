/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * V22 · settings-item-shortcuts
 * 快捷键设置：系统快捷键 + 插件注册的快捷键（来自 F11 服务）。
 */
export const name = 'settings-item-shortcuts'
export const version = '1.0.0'
export const displayName = '设置项 · 快捷键'
export const description = '设置页 · 快捷键列表与冲突提示。'
export const author = '念风内核'
export const icon = '⌨️'
export const core = true
export const depends = { 'settings-container': '^1.0.0', 'keyboard-shortcuts': '^1.0.0' }
export const inject = ['settings-container', 'shortcuts', 'event-bus']

import { page, section, card, row } from '../../../src/util/settings.mjs'
import { icons } from '../../../src/util/icons.mjs'
import { escapeHtml } from '../../../src/util/format.mjs'

const SYSTEM = [
  ['发送消息', ['Enter']],
  ['换行', ['Shift', 'Enter']],
  ['关闭当前面板', ['Esc']],
  ['新建会话', ['Ctrl', 'N']],
  ['切换视图', ['Ctrl', '1..9']],
]

export function apply(ctx) {
  const pages = ctx.inject('settings-container')
  const shortcuts = ctx.inject('shortcuts')
  const events = ctx.inject('event-bus')

  const keys = keys => keys.map(k => `<span class="shortcut-key">${escapeHtml(k)}</span>`).join('<span>+</span>')

  pages.register({
    id: 'shortcuts',
    group: '偏好',
    groupOrder: 30,
    label: '快捷键',
    icon: icons.keyboard,
    order: 60,
    render(container) {
      const render = () => {
        const registered = shortcuts.list()
        const byOwner = registered.reduce((acc, item) => {
          ;(acc[item.owner] = acc[item.owner] || []).push(item)
          return acc
        }, {})
        const duplicates = Object.values(
          registered.reduce((acc, item) => {
            ;(acc[item.combo] = acc[item.combo] || []).push(item)
            return acc
          }, {}),
        ).filter(list => list.length > 1)

        container.innerHTML = page('快捷键', '由 keyboard-shortcuts 插件统一管理，其他插件可以注册自己的快捷键。', `
          ${section('系统快捷键', card(SYSTEM.map(([name, combo]) => row(name, '', keys(combo))).join('')))}
          ${section('插件快捷键', card(
            Object.keys(byOwner).length
              ? Object.entries(byOwner)
                  .map(([owner, list]) =>
                    list
                      .map(item => row(`${owner} · ${escapeHtml(item.label)}`, '', keys(item.combo.split('+'))))
                      .join(''),
                  )
                  .join('')
              : row('暂无插件快捷键', '插件安装后可以声明自己的快捷键', ''),
          ))}
          ${duplicates.length
            ? `<div class="settings-section"><div class="settings-note" style="background:rgba(255,243,224,.8);color:#a5721a">
                检测到 ${duplicates.length} 组快捷键冲突：${duplicates.map(d => escapeHtml(d[0].combo)).join('、')}。冲突的组合只会触发先注册的插件。
              </div></div>`
            : `<div class="settings-note">插件安装后可以声明自己的快捷键，会自动出现在上方"插件快捷键"区域。</div>`}`)
      }

      const offs = [events.on('shortcut:triggered', render)]
      render()
      return () => offs.forEach(off => off())
    },
  })
}
