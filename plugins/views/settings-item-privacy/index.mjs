/**
 * 设置项 · 隐私与权限
 * 对标 deepseek-harness 的 permission presets：
 *   - 只读 / 标准 / 完全权限 三种预设
 *   - 每个声明了权限的插件可以单独放行或拒绝
 *   - 权限在服务访问层真实生效（api / storage / notification）
 */
export const name = 'settings-item-privacy'
export const version = '3.0.0'
export const displayName = '设置项 · 隐私'
export const description = '设置页 · 插件权限预设、按插件授权与本地数据说明。'
export const author = '风语内核'
export const icon = '🛡️'
export const core = false
export const depends = { 'settings-container': '^1.0.0', permissions: '^1.0.0' }
export const inject = ['settings-container', 'permissions', 'toast']

import { page, section, card, row } from '../../../src/util/settings.mjs'
import { escapeHtml } from '../../../src/util/format.mjs'
import { icons } from '../../../src/util/icons.mjs'

export function apply(ctx) {
  const pages = ctx.inject('settings-container')
  const permissions = ctx.inject('permissions')
  const toast = ctx.inject('toast')

  pages.register({
    id: 'privacy',
    group: '系统',
    groupOrder: 40,
    label: '隐私',
    icon: icons.shield,
    order: 90,
    render(container) {
      const render = () => {
        const preset = permissions.preset()
        const presetList = permissions.presets()
        const plugins = permissions.list()
        container.innerHTML = page('隐私', '风语是本地应用：这里管理插件能做什么，以及数据与密钥放在哪里。', `
          ${section('权限预设', card(
            row(
              '默认权限',
              '按预设决定插件默认拥有的能力；「完全权限」只会放宽声明过权限的插件。',
              `<div class="segmented">${presetList
                .map(
                  item =>
                    `<button class="${item.id === preset ? 'active' : ''}" data-perm-preset="${item.id}" title="${escapeHtml(item.description)}">${escapeHtml(item.label)}</button>`,
                )
                .join('')}</div>`,
            ) +
              row('当前说明', escapeHtml(presetList.find(item => item.id === preset)?.description || ''), '<span class="plugin-tag core-tag">生效中</span>'),
          ))}
          ${section(
            `插件权限（${plugins.length}）`,
            plugins.length
              ? card(
                  plugins
                    .flatMap(plugin =>
                      plugin.capabilities.map(cap =>
                        row(
                          `${escapeHtml(plugin.displayName)}${plugin.core ? ' · 核心' : ''}`,
                          escapeHtml(cap.label || cap.id),
                          plugin.core
                            ? '<span class="plugin-tag core-tag">核心插件豁免</span>'
                            : `<button class="switch ${cap.granted ? 'on' : ''}" data-perm-toggle="${escapeHtml(plugin.id)}::${escapeHtml(cap.id)}" title="${cap.granted ? '拒绝' : '允许'}"></button>`,
                        ),
                      ),
                    )
                    .join(''),
                )
              : '<div class="settings-card"><div class="setting-row"><div class="setting-main"><div class="setting-name">还没有插件声明特殊权限</div><div class="setting-help">声明了 network / storage / notify / code-execution 的插件会出现在这里。</div></div></div></div>',
          )}
          ${section('数据与密钥', card(
            row('数据保存位置', '默认在项目根目录 user_data；可在「数据」页切换', '<button class="outline-btn" data-action="open-data">数据设置</button>') +
              row('API Key', 'AES-256-GCM 密文保存；接口返回始终打码', '<span class="text-good">● 本机加密</span>') +
              row('遥测 / 诊断上报', '没有遥测；错误只写入本机 user_data/logs/error.log', '<span class="text-good">● 不上传</span>'),
          ))}
          <div class="settings-note">
            权限中心是「用户知情 + 服务访问拦截」，不是操作系统沙箱：插件仍与内核运行在同一进程。
            要彻底隔离需要独立插件进程 + RPC，已在「未实现清单」登记。
          </div>`)

        container.querySelectorAll('[data-perm-preset]').forEach(button => {
          button.addEventListener('click', () => {
            permissions.setPreset(button.dataset.permPreset)
            toast.success(`插件权限预设：${button.textContent}`)
            render()
          })
        })
        container.querySelectorAll('[data-perm-toggle]').forEach(button => {
          button.addEventListener('click', () => {
            const [id, capability] = String(button.dataset.permToggle).split('::')
            const next = !button.classList.contains('on')
            button.classList.toggle('on', next)
            permissions.setGrant(id, capability, next)
            toast.success(next ? `已允许「${id}」使用 ${capability}` : `已拒绝「${id}」使用 ${capability}`)
            render()
          })
        })
        container.querySelector('[data-action="open-data"]')?.addEventListener('click', () => pages.open('data'))
      }

      render()
      const off = ctx.on('permissions:changed', render)
      return () => off?.()
    },
  })
}
