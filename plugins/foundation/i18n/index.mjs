/**
 * F4 · i18n
 * 多语言基础服务。插件通过 t('key') 取文案，切换语言会广播 i18n:changed。
 *
 * 设计约定：
 *   - i18n 本身不再内置任何具体语种，只负责注册、查询与切换；
 *   - 语言文案由独立的语言包插件提供（内置示例：extras/lang-zh-cn）；
 *   - 默认且唯一内置的语种是简体中文；新增语种复制语言包插件改翻译表即可；
 *   - 缺少翻译时回退到简中，再回退到调用方传入的 fallback，保证界面不缺字。
 */
export const name = 'i18n'
export const version = '2.0.0'
export const displayName = '多语言'
export const description = '基础服务 · 语言包注册与切换；具体语种由独立语言包插件提供。'
export const author = '风语内核'
export const icon = '🌏'
// 会话列表、输入框、渠道列表等核心 UI 都依赖 i18n 服务；它属于基础服务，
// 不允许被单独禁用，否则会让这些核心插件一起进入 inactive。
export const core = true
export const depends = { config: '^1.0.0' }
export const inject = ['config', 'event-bus']
export const provides = [{ name: 'i18n', type: 'singleton' }]

export const DEFAULT_LOCALE = 'zh-CN'

export function apply(ctx) {
  const config = ctx.inject('config')
  const events = ctx.inject('event-bus')

  /** id -> { id, label, messages } */
  const packs = new Map()
  let locale = String(config.get('ui.locale', DEFAULT_LOCALE) || DEFAULT_LOCALE)

  const has = id => packs.has(String(id || ''))
  const resolveInitial = () => {
    if (has(locale)) return locale
    if (has(DEFAULT_LOCALE)) return DEFAULT_LOCALE
    return [...packs.keys()][0] || DEFAULT_LOCALE
  }

  const broadcast = () => events.emit('i18n:changed', locale)

  const service = {
    name: 'i18n',

    /** 已注册语言包：[{ id, label }]，设置页直接用于下拉框 */
    locales: () => [...packs.values()].map(pack => ({ id: pack.id, label: pack.label || pack.id })),

    /** 当前语言 id */
    locale: () => locale,

    has,

    /** 取文案：当前语言 → 简中 → 调用方 fallback → key */
    t(key, fallback) {
      return packs.get(locale)?.messages?.[key] ?? packs.get(DEFAULT_LOCALE)?.messages?.[key] ?? fallback ?? key
    },

    /**
     * 注册一个语言包。
     * @param {{id:string,label?:string,messages:Record<string,string>}} pack
     * @returns {() => void} 注销函数（交给 ctx.effect 管理生命周期）
     */
    register(pack) {
      const id = String(pack?.id || '').trim()
      if (!id) throw new Error('语言包缺少 id')
      if (typeof pack.messages !== 'object' || !pack.messages) throw new Error(`语言包 ${id} 缺少翻译表`)
      packs.set(id, { id, label: pack.label || id, messages: { ...pack.messages } })
      const next = resolveInitial()
      if (next !== locale) {
        locale = next
        config.set('ui.locale', locale)
      }
      broadcast()
      ctx.logger.debug(`语言包已注册：${id}（当前：${locale}）`)
      return () => {
        packs.delete(id)
        const fallback = resolveInitial()
        if (fallback !== locale) {
          locale = fallback
          config.set('ui.locale', locale)
        }
        broadcast()
      }
    },

    /** 切换语言；未注册的语言包会被拒绝并返回 false */
    setLocale(next) {
      const id = String(next || '')
      if (!has(id) || id === locale) return false
      locale = id
      config.set('ui.locale', id)
      broadcast()
      return true
    },
  }

  // 偏好同步（远端 / 其他窗口写入）也立即生效，避免设置页切换后界面不同步。
  ctx.effect(
    events.on('config:changed', payload => {
      if (payload?.key !== 'ui.locale') return
      const next = String(payload.value || '')
      if (next && has(next) && next !== locale) {
        locale = next
        broadcast()
      }
    }),
  )

  ctx.provide('i18n', service, { type: 'singleton' })
  ctx.logger.debug(`多语言就绪：${locale}（语言包待注册）`)
}
