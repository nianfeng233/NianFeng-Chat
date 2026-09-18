/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * V23 · settings-item-about
 * 关于：版本、内核、插件与服务统计、调试面板入口。
 */
export const name = 'settings-item-about'
export const version = '1.0.0'
export const displayName = '设置项 · 关于'
export const description = '设置页 · 版本与插件系统信息。'
export const author = '念风内核'
export const icon = 'ℹ️'
export const core = true
export const depends = {
  'event-bus': '*',
  'plugin-manager': '^1.0.0',
  'settings-container': '^1.0.0',
  'toast-host': '>=1.0.0',
}
export const optionalDepends = {}
export const inject = ['settings-container', 'plugin-manager', 'event-bus', 'toast']

import { page, section, card, row } from '../../../src/util/settings.mjs'
import { escapeHtml } from '../../../src/util/format.mjs'

export function apply(ctx) {
  const pages = ctx.inject('settings-container')
  const manager = ctx.inject('plugin-manager')
  const toast = ctx.inject('toast')

  pages.register({
    id: 'about',
    group: '其他',
    groupOrder: 50,
    label: '关于',
    icon: 'ⓘ',
    order: 110,
    render(container) {
      const render = () => {
        const stats = manager.stats()
        const appVersion = ctx.registry.get('app')?.version || '2.0.2'
        const uptime = Math.round((Date.now() - (ctx.registry.get('lifecycle')?.startedAt() || Date.now())) / 1000)
        container.innerHTML = page('关于', '念风：本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）。', `
          ${section('', `<div class="settings-card" style="padding:22px">
              <div class="about-head">
                <div class="about-mark">念</div>
                <div>
                  <div class="setting-name" style="font-size:15px">念风chat</div>
                  <div class="about-version">NianFeng-Chat · Version ${escapeHtml(appVersion)} · 插件化架构</div>
                    <div class="about-version">后端终端为业务本体；WebUI 加载视觉与操作插件，业务执行由后端常驻代聊处理。</div>
                    <div class="about-version">本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）</div>
                </div>
              </div>
            </div>`)}
          ${section('系统信息', card(
            row('内核版本', 'cordis v4 · event-bus + plugin-loader', '<span class="text-good">● 正常</span>') +
            row('已加载插件', `核心 ${stats.core} 个 · 第三方 ${stats.thirdParty} 个 · 共 ${stats.total} 个`,
              '<button class="outline-btn" data-action="goto-plugins">查看</button>') +
            row('已注册服务', Object.entries(stats.servicesByType).map(([k, v]) => `${k} ${v}`).join(' · '),
              '<button class="outline-btn" data-action="dump-services">查看</button>') +
            row('运行时长', '本次启动至今', `<span class="text-good">${uptime} 秒</span>`),
          ))}
          ${section('其他', card(
            row('调试面板', '打开浏览器控制台后可使用 window.__wind_debug', '<button class="outline-btn" data-action="debug">说明</button>'),
          ))}`)

        const onClick = e => {
          const action = e.target.closest('[data-action]')?.dataset.action
          if (action === 'goto-plugins') ctx.inject('settings-container').open('plugins')
          if (action === 'dump-services') {
            console.table(ctx.registry.list())
            toast.info(`已把 ${stats.services} 个服务打印到控制台`)
          }
          if (action === 'debug') {
            toast.info('在控制台执行 __wind_debug.status() / services() / trace(true) 查看插件状态。')
            console.log('__wind_debug ·', window.__wind_debug)
          }
        }
        container.addEventListener('click', onClick)
      }

      const offs = [ctx.on('plugin:loaded', render), ctx.on('plugin:enabled', render), ctx.on('plugin:disabled', render)]
      render()
      return () => offs.forEach(off => off())
    },
  })
}
