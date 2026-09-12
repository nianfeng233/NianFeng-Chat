/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * 设置项 · 网络（真实版）
 * 展示 WebUI ↔ 本地后端的真实状态，并直接修改后端的全局请求超时。
 * 代理是「每个提供商」单独的配置，入口在 设置 → 模型 → 提供商 → 高级配置。
 */
export const name = 'settings-item-network'
export const version = '2.0.0'
export const displayName = '设置项 · 网络'
export const description = '设置页 · 后端连接状态与模型请求超时。'
export const author = '念风内核'
export const icon = '🌐'
export const core = false
export const depends = { 'settings-container': '^1.0.0', permissions: '^1.0.0', config: '^1.0.0' }
export const inject = ['settings-container', 'api', 'config', 'toast', 'event-bus', 'modal']
export const permissions = ["network"]

import { page, section, card, row } from '../../../src/util/settings.mjs'
import { icons } from '../../../src/util/icons.mjs'
import { escapeHtml } from '../../../src/util/format.mjs'

const TIMEOUT_OPTIONS = [
  { value: 30000, label: '30 秒' },
  { value: 60000, label: '60 秒（默认）' },
  { value: 120000, label: '120 秒' },
  { value: 300000, label: '300 秒' },
]

const EMPTY_RETRY_OPTIONS = [
  { value: 0, label: '不重试' },
  { value: 1, label: '1 次（默认）' },
  { value: 2, label: '2 次' },
  { value: 3, label: '3 次' },
  { value: 5, label: '5 次' },
]

export function apply(ctx) {
  const pages = ctx.inject('settings-container')
  const api = ctx.inject('api')
  const config = ctx.inject('config')
  const toast = ctx.inject('toast')
  const events = ctx.inject('event-bus')
  const modal = ctx.inject('modal')

  pages.register({
    id: 'network',
    group: '系统',
    groupOrder: 40,
    label: '网络',
    icon: icons.globe,
    order: 70,
    render(container) {
      let health = null
      let backendConfig = null
      let error = ''
      let disposed = false
      let saving = false

      const readSelect = el => {
        if (!el) return ''
        if (el.value) return el.value
        const option = el.querySelector('option[selected]')
        return option ? option.getAttribute('value') || '' : ''
      }

      const load = async () => {
        try {
          health = await api.health()
          backendConfig = await api.getConfig()
          error = ''
        } catch (err) {
          health = null
          backendConfig = null
          error = err.message
        }
        if (!disposed) render()
      }

      const render = () => {
        if (disposed) return
        const status = api.status()
        const online = !!health
        const timeoutMs = Number(backendConfig?.network?.timeoutMs) || 60000
        const options = TIMEOUT_OPTIONS.map(
          option => `<option value="${option.value}" ${option.value === timeoutMs ? 'selected' : ''}>${escapeHtml(option.label)}</option>`,
        ).join('')
        const emptyRetries = Number(backendConfig?.network?.emptyResponseRetries ?? 1)
        const emptyRetryOptions = EMPTY_RETRY_OPTIONS.map(
          option => `<option value="${option.value}" ${option.value === emptyRetries ? 'selected' : ''}>${escapeHtml(option.label)}</option>`,
        ).join('')
        const proxy = backendConfig?.network?.proxy || ''
        const webuiHost = backendConfig?.network?.webuiHost || '127.0.0.1'
        const webuiPort = Number(backendConfig?.network?.webuiPort) || 0
        const webuiToken = backendConfig?.network?.webuiToken || ''
        container.innerHTML = page('网络', '查看 WebUI ↔ 本地后端的真实连接状态，并配置模型请求的全局超时与代理。', `
          ${section('后端连接', card(
            row(
              '接口地址',
              'WebUI 通过这个地址访问本地后端；默认 /api（由启动脚本代理）',
              `<input class="setting-input" style="width:min(320px,100%)" data-field="backend-url" value="${escapeHtml(api.baseUrl())}" />
               <button class="outline-btn" data-action="save-backend-url">保存地址</button>`,
            ) +
              row('连接状态', error ? escapeHtml(error) : `延迟 ${status.latency || 0} ms`, online ? '<span class="text-good">● 已连接</span>' : '<span class="text-bad">● 未连接</span>') +
              row('后端版本', health ? `cordis v4 · ${escapeHtml(health.version)}` : '—', `<span class="mono">${health ? '运行时正常' : '等待后端'}</span>`) +
              row('数据目录', '当前实例的持久化目录', `<span class="mono">${escapeHtml(health?.dataDir || '—')}</span>`) +
              row('重新检测', '立即请求 /api/health', '<button class="outline-btn" data-action="recheck">重新检测</button>'),
          ))}
          ${section('WebUI 访问', card(
            row('监听地址', '127.0.0.1 = 仅本机；0.0.0.0 = 允许局域网 / 公网访问。保存后需要重启生效',
              `<select class="setting-select" data-field="webui-host">
                <option value="127.0.0.1" ${webuiHost === '127.0.0.1' ? 'selected' : ''}>127.0.0.1（仅本机）</option>
                <option value="0.0.0.0" ${webuiHost === '0.0.0.0' ? 'selected' : ''}>0.0.0.0（开放访问）</option>
              </select>`) +
            row('监听端口', 'Web 部署 / npm start 模式使用此端口；桌面版由宿主分配内部端口，此项在桌面版暂不生效',
              `<input class="setting-input" type="number" min="0" max="65535" style="width:110px" data-field="webui-port" value="${webuiPort}" />`) +
            row('访问令牌', '非空时，浏览器必须带 token 才能访问：/?token=xxx；建议至少 12 位随机字符。留空不校验',
              `<input class="setting-input" style="width:min(260px,100%)" data-field="webui-token" value="${escapeHtml(webuiToken)}" placeholder="例如 5f2c9a..." />`) +
            row('保存访问配置', '保存后弹窗询问是否立即重启；不重启则下次启动生效',
              `<button class="outline-btn primary-soft" data-action="save-webui" ${online ? '' : 'disabled'}>保存</button>`) +
            (webuiToken
              ? row('访问示例', '把主机换成实际 IP；验证通过后会写入 Cookie',
                  `<span class="mono">http://${escapeHtml(webuiHost === '0.0.0.0' ? '你的主机IP' : webuiHost)}:${webuiPort || 5173}/?token=你的令牌</span>`)
              : '') +
            (webuiHost === '0.0.0.0' && !webuiToken
              ? '<div class="settings-note" style="background:rgba(198,91,91,.1);color:#c65b5b;margin:12px 14px 0">安全提示：当前监听 0.0.0.0 且访问令牌为空，同一局域网 / 公网可直接打开 WebUI。仅建议在可信网络临时使用；不强制设置令牌，但强烈建议填写。</div>'
              : ''),
          ))}
          ${section('模型请求', card(
            row(
              '全局超时',
              '提供商未单独设置超时时的默认值；可在 模型 → 提供商 → 高级配置 里覆盖',
              `<select class="setting-select" data-field="timeout" ${online ? '' : 'disabled'}>${options}</select>`,
            ) +
              row(
                '空回复自动重试',
                '模型返回既无正文也无工具调用时，自动重试同一个请求；DeepSeek 官方 harness 默认也会重试',
                `<select class="setting-select" data-field="empty-response-retries" ${online ? '' : 'disabled'}>${emptyRetryOptions}</select>`,
              ) +
              row(
                '全局代理',
                '如 http://127.0.0.1:7890；对所有未单独配置代理的提供商生效。使用代理时由 Node 直接走 CONNECT 隧道，能绕过部分网络的连接超时问题。',
                `<input class="setting-input" style="width:min(260px,100%)" data-field="proxy" value="${escapeHtml(proxy)}" placeholder="http://127.0.0.1:7890" />`,
              ) +
              row('保存', '写入后端 config.json 的 network 段', `<button class="outline-btn primary-soft" data-action="save-network" ${online ? '' : 'disabled'}>保存网络配置</button>`),
          ))}
          <div class="settings-note">
            DeepSeek 等被网络限制的提供商：在这里填本机代理（例如 http://127.0.0.1:7890），或在提供商高级配置里单独填写。
            代理只用于你显式配置的提供商请求，念风不会自动走系统代理。
          </div>`)

        container.querySelector('[data-action="recheck"]')?.addEventListener('click', async () => {
          toast.info('正在检测后端…')
          await load()
        })
        container.querySelector('[data-action="save-network"]')?.addEventListener('click', saveNetwork)
        container.querySelector('[data-action="save-webui"]')?.addEventListener('click', saveWebui)
        container.querySelector('[data-action="save-backend-url"]')?.addEventListener('click', saveBackendUrl)
      }

      const saveWebui = async () => {
        if (saving) return
        const host = readSelect(container.querySelector('[data-field="webui-host"]')) || '127.0.0.1'
        const port = Number(container.querySelector('[data-field="webui-port"]')?.value || 0)
        const token = String(container.querySelector('[data-field="webui-token"]')?.value || '').trim()
        if (!Number.isFinite(port) || port < 0 || port > 65535) {
          toast.warn('端口需要在 0 - 65535 之间')
          return
        }
        if (token && token.length < 8) {
          toast.warn('访问令牌建议至少 8 位，避免被轻易猜到')
          return
        }
        saving = true
        try {
          await api.setConfig({ network: { webuiHost: host, webuiPort: port, webuiToken: token } })
          toast.success('WebUI 访问配置已保存')
          await load()
          const answer = await modal.confirm('立即重启念风？', '监听地址 / 端口 / 访问令牌需要重启后生效。\n\n点「确定」立即重启；点「取消」稍后手动重启（配置已保存）。')
          if (!answer?.ok) {
            toast.info('已保存，下次启动时生效')
            return
          }
          if (window.windHost?.restart) {
            window.windHost.restart()
            return
          }
          await api.restartSystem()
        } catch (err) {
          toast.error(`保存失败：${err.message}`)
        } finally {
          saving = false
        }
      }

      const saveNetwork = async () => {
        if (saving) return
        const value = Number(readSelect(container.querySelector('[data-field="timeout"]')))
        if (!Number.isFinite(value) || value < 1000) {
          toast.warn('请选择有效的超时时间')
          return
        }
        const proxy = String(container.querySelector('[data-field="proxy"]')?.value || '').trim()
        const emptyResponseRetries = Number(
          readSelect(container.querySelector('[data-field="empty-response-retries"]')) ?? backendConfig?.network?.emptyResponseRetries ?? 1,
        )
        saving = true
        try {
          await api.setConfig({ network: { timeoutMs: value, proxy, emptyResponseRetries } })
          toast.success('网络配置已保存')
          await load()
        } catch (err) {
          toast.error(`保存失败：${err.message}`)
        } finally {
          saving = false
        }
      }

      const saveBackendUrl = async () => {
        if (saving) return
        const url = String(container.querySelector('[data-field="backend-url"]')?.value || '').trim()
        if (!url) {
          toast.warn('接口地址不能为空')
          return
        }
        saving = true
        try {
          config.set('backend.url', url)
          toast.success('后端地址已保存，正在重新检测…')
          await load()
        } catch (err) {
          toast.error(`保存失败：${err.message}`)
        } finally {
          saving = false
        }
      }

      render()
      load()

      const offs = [
        events.on('backend:status', () => load()),
        events.on('backend:event', ({ event }) => {
          if (event === 'settings/updated') load()
        }),
      ]
      const onOnline = () => render()
      window.addEventListener('online', onOnline)
      window.addEventListener('offline', onOnline)

      return () => {
        disposed = true
        offs.forEach(off => off?.())
        window.removeEventListener('online', onOnline)
        window.removeEventListener('offline', onOnline)
      }
    },
  })
}
