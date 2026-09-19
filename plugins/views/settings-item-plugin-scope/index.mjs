/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * V21b · settings-item-plugin-scope
 * 「设置 → 插件启用」：以「角色 → 渠道」为粒度控制每个外部插件的启用范围。
 *
 * 外部插件的工具会被 tool-registry 带上 owner id，这里保存的配置由
 * plugin-scope 服务统一解析；模型侧在未启用的角色 / 渠道里连工具定义都拿不到。
 */
export const name = 'settings-item-plugin-scope'
export const version = '1.1.0'
export const displayName = '设置项 · 插件启用'
export const description = '设置页 · 按角色 / 渠道控制外部插件的启用范围。'
export const author = '念风内核'
export const icon = '🎛️'
export const core = true
export const depends = {
  'plugin-manager': '^1.0.0',
  'plugin-scope': '^1.0.0',
  'settings-container': '^1.0.0',
  'toast-host': '>=1.0.0',
}
export const optionalDepends = {}
export const inject = ['settings-container', 'plugin-manager', 'plugin-scope', 'toast']
export const provides = []

import { page, section, card } from '../../../src/util/settings.mjs'
import { useStyle } from '../../../src/util/style.mjs'
import { escapeHtml } from '../../../src/util/format.mjs'
import { PLUGIN_SCOPE_CSS } from './style.mjs'

const modeOptions = (current, labels) =>
  Object.entries(labels)
    .map(([value, label]) => `<option value="${value}"${current === value ? ' selected' : ''}>${escapeHtml(label)}</option>`)
    .join('')

const hasKey = (object, key) => Object.prototype.hasOwnProperty.call(object || {}, key)

/** 角色 / 渠道的“当前绝对状态”：有显式配置看显式配置，否则看默认策略。 */
const roleEnabled = (entry, roleId) =>
  hasKey(entry.roles, roleId) ? entry.roles[roleId] !== false : entry.default !== 'none'
const channelEnabled = (entry, roleId, channelId) =>
  hasKey(entry.channels, channelId) ? entry.channels[channelId] !== false : roleEnabled(entry, roleId)

/** 业务级插件 = 外部插件 + 内置的功能 / 渠道 / 业务服务插件。 */
const BUSINESS_DIR_PREFIXES = ['plugins/features/', 'plugins/channels/', 'plugins/domain/']
const isBusinessPlugin = plugin => {
  const dir = String(plugin?.dir || '').replace(/\\/g, '/')
  return !!plugin && (plugin.external === true || BUSINESS_DIR_PREFIXES.some(prefix => dir.startsWith(prefix)))
}

export function apply(ctx) {
  const pages = ctx.inject('settings-container')
  const manager = ctx.inject('plugin-manager')
  const scope = ctx.inject('plugin-scope')
  const toast = ctx.inject('toast')

  useStyle(ctx, PLUGIN_SCOPE_CSS)

  let selectedId = ''

  const businessPlugins = () =>
    manager
      .list({ includeCore: false })
      .filter(plugin => !plugin.removed && isBusinessPlugin(plugin))

  const defaultSelect = (selected, current) =>
    `<select class="setting-select ps-select" data-ps-default="${escapeHtml(selected.id)}">${modeOptions(current, {
      all: '未单独设置的角色 / 渠道：默认启用',
      none: '未单独设置的角色 / 渠道：默认关闭',
    })}</select>`

  const roleRow = (selected, entry, role) => {
    const on = roleEnabled(entry, role.id)
    const channels = role.channels || []
    return `<div class="ps-role">
      <div class="ps-role-head">
        <span class="ps-role-name">${escapeHtml(role.name || role.id)}</span>
        ${role.missing ? '<span class="ps-badge warn">没有对应角色会话</span>' : ''}
        ${channels.length ? `<span class="ps-dim">${channels.length} 个渠道</span>` : ''}
        <span class="ps-spacer"></span>
        <span class="ps-dim">${escapeHtml(role.id)}</span>
        <button class="switch ${on ? 'on' : ''}" data-ps-role-switch="${escapeHtml(role.id)}" type="button" role="switch" aria-checked="${on ? 'true' : 'false'}" title="${on ? '点击关闭该角色' : '点击开启该角色'}"></button>
      </div>
      ${
        channels.length
          ? `<div class="ps-channels">${channels
              .map(channel => {
                const channelOn = channelEnabled(entry, role.id, channel.id)
                return `<div class="ps-channel">
                  <span class="ps-channel-name">${escapeHtml(channel.name || channel.id)}</span>
                  <span class="ps-badge">${escapeHtml(channel.type || '渠道')}</span>
                  <span class="ps-dim">${escapeHtml(channel.groupName || channel.tab || '')}</span>
                  <span class="ps-spacer"></span>
                  <button class="switch ${channelOn ? 'on' : ''}" data-ps-channel-switch="${escapeHtml(channel.id)}" type="button" role="switch" aria-checked="${channelOn ? 'true' : 'false'}" title="${channelOn ? '点击关闭该渠道' : '点击开启该渠道'}"></button>
                </div>`
              })
              .join('')}</div>`
          : '<div class="ps-dim ps-no-channel">该角色没有绑定外部渠道；这里只影响它的普通会话。</div>'
      }
    </div>`
  }

  const paint = container => {
    const plugins = businessPlugins()
    if (!selectedId || !plugins.some(plugin => plugin.id === selectedId)) selectedId = plugins[0]?.id || ''
    const current = plugins.find(plugin => plugin.id === selectedId) || null
    const tree = scope.roleTree()
    const entry = current ? scope.get(current.id) || { default: 'all', roles: {}, channels: {} } : null

    container.innerHTML = page(
      '插件启用',
      '按业务插件 → 角色直接开启 / 关闭，像开关一样一目了然；绑定的渠道默认跟随角色，也可以单独点开或关掉。核心插件和纯界面 / 设置项插件不在这里。',
      `
      ${
        plugins.length
          ? `<div class="ps-plugin-tabs">${plugins
              .map(
                plugin => `<button class="ps-plugin-tab ${plugin.id === selectedId ? 'active' : ''}" data-ps-plugin="${escapeHtml(plugin.id)}">
                  <span class="ps-dot"></span>${escapeHtml(plugin.icon || '🧩')} ${escapeHtml(plugin.name || plugin.id)}
                  ${plugin.enabled === false || plugin.status !== 'active' ? '<span class="ps-badge warn">全局禁用</span>' : ''}
                </button>`,
              )
              .join('')}</div>`
          : '<div class="ps-empty">还没有可控制的业务插件。安装外部插件，或启用内置功能插件后，这里会按角色出现对应的开关。</div>'
      }
      ${
        current
          ? section(
              `${current.icon || '🧩'} ${current.name || current.id} · 启用范围`,
              card(
                `<div class="ps-default-row">
                  <div class="ps-default-main">
                    <div class="ps-default-name">默认策略</div>
                    <div class="ps-help">没点过开关的角色 / 渠道按这里执行；一旦点过某个角色或渠道的开关，就以你点的显式状态为准。新安装插件会先问一次“全体启用 / 全体关闭”。</div>
                  </div>
                  ${defaultSelect(current, entry.default)}
                </div>
                <div class="ps-bulk">
                  <button class="outline-btn" data-ps-bulk="all" data-ps-plugin-bulk="${escapeHtml(current.id)}">全部角色启用</button>
                  <button class="outline-btn" data-ps-bulk="none" data-ps-plugin-bulk="${escapeHtml(current.id)}">全部角色关闭</button>
                  <button class="outline-btn" data-ps-bulk="reset" data-ps-plugin-bulk="${escapeHtml(current.id)}">恢复默认（不限制）</button>
                  <span class="ps-dim">打开角色开关后，渠道默认继承角色状态；单独点某个渠道开关会覆盖角色设置。</span>
                </div>
                <div class="ps-list">${tree.roles.map(role => roleRow(current, entry, role)).join('')}</div>
                ${
                  tree.unboundChannels.length
                    ? `<div class="ps-role" style="margin-top:8px">
                        <div class="ps-role-head"><span class="ps-role-name">未绑定角色的渠道</span><span class="ps-help">只能按渠道单独控制</span></div>
                        <div class="ps-channels">${tree.unboundChannels
                          .map(channel => {
                            const channelOn = hasKey(entry.channels, channel.id) ? entry.channels[channel.id] !== false : entry.default !== 'none'
                            return `<div class="ps-channel">
                              <span class="ps-channel-name">${escapeHtml(channel.name || channel.id)}</span>
                              <span class="ps-badge">${escapeHtml(channel.type || '渠道')}</span>
                              <span class="ps-spacer"></span>
                              <button class="switch ${channelOn ? 'on' : ''}" data-ps-channel-switch="${escapeHtml(channel.id)}" type="button" role="switch" aria-checked="${channelOn ? 'true' : 'false'}" title="${channelOn ? '点击关闭该渠道' : '点击开启该渠道'}"></button>
                            </div>`
                          })
                          .join('')}</div>
                      </div>`
                    : ''
                }`,
              ),
            )
          : ''
      }`,
    )

  }

  pages.register({
    id: 'plugin-scope',
    group: '核心',
    groupOrder: 20,
    label: '插件启用',
    icon: '🎛️',
    order: 31,
    render(container) {
      const currentPlugin = () => businessPlugins().find(item => item.id === selectedId) || null

      const onChange = event => {
        const target = event.target
        const plugin = currentPlugin()
        if (!target || !plugin) return
        if (!target.hasAttribute?.('data-ps-default')) return
        scope.setDefault(plugin.id, target.value)
        toast.success('已更新默认策略')
        paint(container)
      }

      const onClick = event => {
        const tab = event.target?.closest?.('[data-ps-plugin]')
        if (tab) {
          const next = String(tab.dataset.psPlugin || '')
          if (next && next !== selectedId) {
            selectedId = next
            paint(container)
          }
          return
        }

        const plugin = currentPlugin()
        if (!plugin) return

        const roleSwitch = event.target?.closest?.('[data-ps-role-switch]')
        if (roleSwitch) {
          const roleId = String(roleSwitch.dataset.psRoleSwitch || '')
          const nextMode = roleSwitch.classList.contains('on') ? 'none' : 'all'
          scope.setRole(plugin.id, roleId, nextMode)
          toast.success(`${nextMode === 'all' ? '已开启' : '已关闭'}角色「${roleId}」的插件`)
          paint(container)
          return
        }

        const channelSwitch = event.target?.closest?.('[data-ps-channel-switch]')
        if (channelSwitch) {
          const channelId = String(channelSwitch.dataset.psChannelSwitch || '')
          const nextMode = channelSwitch.classList.contains('on') ? 'none' : 'all'
          scope.setChannel(plugin.id, channelId, nextMode)
          toast.success(`${nextMode === 'all' ? '已开启' : '已关闭'}渠道「${channelId}」的插件`)
          paint(container)
          return
        }

        const bulk = event.target?.closest?.('[data-ps-bulk]')
        if (bulk) {
          const mode = String(bulk.dataset.psBulk || '')
          const tree = scope.roleTree()
          if (mode === 'reset') {
            scope.reset(plugin.id)
            toast.info('已恢复默认启用')
          } else {
            for (const role of tree.roles) scope.setRole(plugin.id, role.id, mode)
            for (const channel of tree.unboundChannels) scope.setChannel(plugin.id, channel.id, mode)
            for (const role of tree.roles) {
              for (const channel of role.channels || []) scope.setChannel(plugin.id, channel.id, mode)
            }
            toast.success(mode === 'all' ? '已对全部角色 / 渠道启用' : '已对全部角色 / 渠道关闭')
          }
          paint(container)
        }
      }
      const offScopeChanged = ctx.on('plugin-scope:changed', () => paint(container))
      container.addEventListener('change', onChange)
      container.addEventListener('click', onClick)
      paint(container)
      return () => {
        offScopeChanged?.()
        container.removeEventListener('change', onChange)
        container.removeEventListener('click', onClick)
      }
    },
  })

  ctx.logger.debug('插件启用设置页就绪')
}
