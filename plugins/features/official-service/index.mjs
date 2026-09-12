/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * 念风官方服务（独立插件）
 *
 * 账号 / 登录 / 官方内置模型 / 计费都属于官方服务端能力。官方服务端
 * （独立官网项目）尚未制作，所以本插件当前标记为「暂不可用」：
 *   - 设置 → 账号 页面由本插件注册，禁用后页面与导航入口一起消失；
 *   - 设置 → 模型 里的「使用念风内置模型」开关与内置模型面板由
 *     official-service 服务是否存在来决定是否展示；
 *   - 「未实现清单」里与官方服务相关的条目也由本插件提供。
 *
 * 重新启用本插件后，所有入口恢复原状。本地模型（Ollama / OpenAI 兼容）
 * 不依赖本插件，禁用官方服务后仍可正常使用。
 */
export const name = 'official-service'
export const version = '1.0.0'
export const displayName = '念风官方服务'
export const description = '功能插件 · 账号 / 登录 / 官方内置模型（官方服务端尚未制作，暂不可用）。'
export const author = '念风内核'
export const icon = '☁️'
export const core = false
export const enabled = true
export const unavailable = true
export const unavailableReason = '官方服务端尚未制作：登录 / 官方内置模型 / 计费暂不可用。'
export const depends = { 'settings-container': '^1.0.0' }
export const inject = ['settings-container', 'config', 'api?', 'session-service', 'model-registry', 'toast', 'event-bus']
export const permissions = ['network']
export const provides = [{ name: 'official-service', type: 'singleton' }]

import { page, section, card, row, input, bindConfigControls } from '../../../src/util/settings.mjs'
import { icons } from '../../../src/util/icons.mjs'
import { escapeHtml } from '../../../src/util/format.mjs'

const BUILTIN_REASON =
  '「念风内置模型」由官方服务端提供（登录 / 计费 / 官方模型都在官网侧）。官方服务端是独立项目、当前尚未制作，所以这里没有可用的内置模型；关闭开关后可改用本机自定义提供商。'

export function apply(ctx) {
  const pages = ctx.inject('settings-container')
  const config = ctx.inject('config')
  const api = ctx.inject('api')
  const sessions = ctx.inject('session-service')
  const registry = ctx.inject('model-registry')
  const toast = ctx.inject('toast')
  const events = ctx.inject('event-bus')

  const fallbackBuiltin = () => ({
    available: false,
    provider: 'nianfeng-official',
    loginRequired: true,
    fetchedAt: Date.now(),
    reason: BUILTIN_REASON,
    models: [],
  })

  let builtinCache = null
  let builtinCacheAt = 0

  const service = {
    name: 'official-service',
    unavailable: true,
    reason: '官方服务端尚未制作，账号与官方内置模型暂不可用',
    accountPageId: 'account',

    /** 官方内置模型：当前后端会如实返回空列表；接口不可用时给出一致的空状态 */
    async builtin({ force = false } = {}) {
      if (!force && builtinCache && Date.now() - builtinCacheAt < 10000) return builtinCache
      try {
        const data = await api?.builtinModels?.()
        builtinCache = data && typeof data === 'object' ? data : fallbackBuiltin()
      } catch (err) {
        builtinCache = { ...fallbackBuiltin(), reason: `无法连接本地后端：${err.message}` }
      }
      builtinCacheAt = Date.now()
      return builtinCache
    },

    login() {
      toast.info('登录需要官方服务端；官方服务端尚未制作，当前版本暂不可用。')
    },

    /** 官方服务相关的“未实现 / 暂不可用”条目，供设置 → 未实现清单动态展示 */
    unimplementedItems() {
      return [
        [
          '登录 / 注册 / 账号',
          '暂不可用',
          '官方账号体系、设备码登录由独立官网项目提供；官方服务端尚未制作，本客户端不内置也不模拟登录。使用自带模型时不需要登录。',
        ],
        [
          '念风内置模型 / 官方计费',
          '暂不可用',
          '内置模型与计费由官方服务端提供；官方服务端尚未制作。可在「设置 → 模型」关闭内置模型开关，改配本机 Ollama / OpenAI 兼容提供商。',
        ],
        [
          '多设备云同步',
          '暂不可用',
          '需要官方云端存储与冲突合并策略；当前会话保存在本机 user_data/sessions.json，可在「设置 → 数据」切换数据目录或导出。',
        ],
        [
          '插件市场 / 在线安装',
          '暂不可用',
          '市场需要官方服务端索引与签名校验；当前仅支持本地插件目录 + 运行时启停。',
        ],
      ]
    },
  }

  pages.register({
    id: 'account',
    group: '账户',
    groupOrder: 10,
    label: '账号',
    icon: icons.user,
    order: 10,
    render(container) {
      const render = async () => {
        let health = null
        try {
          health = await api?.health()
        } catch (_) {
          health = null
        }
        const status = sessions.status?.() || {}
        const localProviders = registry.providers().length
        const localModels = registry.list().length

        container.innerHTML = page(
          '账号',
          '念风是纯客户端单机应用：数据保存在本机，模型可以完全自备；官方账号服务暂不可用。',
          `
          ${section('运行模式', card(
            row('当前模式', '不需要登录也能使用全部本地功能', '<span class="text-good">● 本地单机</span>') +
            row('本机昵称', '仅用于界面显示，保存在本地 config；会同步显示在顶栏头像上', input('ui.nickname', config.get('ui.nickname', ''), { placeholder: '给自己起个名字', width: 180 })) +
            row('数据来源', '后端在线时会话写入当前数据目录的 sessions.json', status.source === 'server'
              ? `<span class="text-good">● 本地后端（${escapeHtml(health?.dataDir || 'user_data')}）</span>`
              : '<span class="text-warn">● 浏览器本地缓存（离线模式）</span>') +
            row('自有模型', '已注册的提供商 / 可用模型', `<span class="mono">${localProviders} 个提供商 · ${localModels} 个模型</span>`),
          ))}

          ${section('官方服务（暂不可用）', card(
            row('服务端地址', '由官方服务项目提供；官方服务端尚未制作', '<input class="setting-input" style="width:260px" value="" placeholder="等待官方服务端发布" disabled />') +
            row('登录状态', '官方账号 / 官方模型 / 计费属于独立的官网项目，本插件仅托管相关入口', '<span class="plugin-tag warn">暂不可用</span>') +
            row('操作', '官方服务端就绪后，这里会变成设备码登录入口', '<button class="outline-btn" data-action="login" disabled>登录</button>'),
          ))}
          <div class="settings-note">
            为什么现在没有登录框？因为官方服务端还没有制作，做一个连不上的登录界面只会误导使用者。
            本页面与「使用念风内置模型」由插件「念风官方服务」提供；在 设置 → 插件 中禁用它，
            这些入口会一起隐藏，重新启用后恢复。使用自己的模型（Ollama 或任意 OpenAI 兼容接口）时，登录永远是可选的。
          </div>

          ${section('本机信息', card(
            row('平台', '来自浏览器 User-Agent', `<span class="mono">${escapeHtml(truncate(navigator.userAgent, 60))}</span>`) +
            row('后端', health ? `cordis v4 · ${escapeHtml(health.version)}` : '未连接', health ? '<span class="text-good">● 已连接</span>' : '<span class="text-bad">● 未连接</span>') +
            row('数据规模', '当前设备上的会话 / 消息', `<span class="mono">${sessions.count()} / ${sessions.stats?.().messages ?? 0}</span>`) +
            row('客户端版本', '念风Chat', `<span class="mono">v${escapeHtml(health?.version || '0.40.0')}</span>`),
          ))}`,
        )

        bindConfigControls(container, ctx)
        container.querySelector('[data-action="login"]')?.addEventListener('click', () => service.login())
      }

      render()
      const offs = [
        events.on('sessions:source', render),
        events.on('backend:status', render),
        events.on('model:provider-registered', render),
        events.on('model:models-updated', render),
      ]
      return () => offs.forEach(off => off())
    },
  })

  ctx.provide('official-service', service, { type: 'singleton' })
  ctx.logger.debug('念风官方服务入口已注册（官方服务端尚未制作，标记为暂不可用）')
}

function truncate(text, max) {
  const s = String(text || '')
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}
