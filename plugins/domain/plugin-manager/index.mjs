/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * D7 · plugin-manager
 * 插件启停 / 安装 / 卸载 的用户侧入口（文档 §4.4）。
 * 真正的加载由 plugin-loader 执行，这里只负责策略、持久化与事件。
 */
export const name = 'plugin-manager'
export const version = '1.0.0'
export const displayName = '插件管理器'
export const description = '业务服务 · 插件启停 / 安装 / 卸载与状态整理。'
export const author = '念风内核'
export const icon = '🧰'
export const core = true
export const depends = { 'plugin-loader': '^1.0.0', config: '^1.0.0' }
export const inject = ['plugin-loader', 'config', 'event-bus', 'toast', 'modal']
export const provides = [{ name: 'plugin-manager', type: 'singleton' }]

export function apply(ctx) {
  const loader = ctx.inject('plugin-loader')
  const config = ctx.inject('config')
  const events = ctx.inject('event-bus')
  const toast = ctx.inject('toast')
  const modal = ctx.inject('modal')

  const STATUS_LABEL = {
    active: '已启用',
    disabled: '已禁用',
    inactive: '未激活',
    error: '异常',
    pending: '加载中',
  }

  const service = {
    name: 'plugin-manager',

    /** 插件列表（含状态与可操作性） */
    list({ includeCore = true, includeRemoved = false } = {}) {
      return loader
        .list()
        .filter(record => (includeRemoved ? true : !record.manifest.removed))
        .filter(record => includeCore || !record.manifest.core)
        .map(record => service.describe(record.id))
        .filter(Boolean)
    },

    describe(id) {
      const record = loader.get(id)
      if (!record) return null
      const meta = record.manifest
      const summary = loader.list().find(r => r.id === id)
      return {
        id,
        name: meta.displayName || meta.name,
        version: meta.version,
        description: meta.description,
        author: meta.author,
        icon: meta.icon,
        core: !!meta.core,
        external: !!meta.external,
        source: meta.source || (meta.external ? 'external' : 'builtin'),
        unavailable: !!meta.unavailable,
        unavailableReason: meta.unavailableReason || '',
        removed: !!meta.removed,
        enabled: record.status === 'active',
        status: record.status,
        statusLabel: STATUS_LABEL[record.status] || record.status,
        reason: record.reason,
        error: record.error ? String(record.error.message || record.error) : null,
        conflict: !!(summary?.conflict || (record.reason || '').includes('已被插件')),
        fiberState: summary?.fiberState ?? null,
        warnings: record.warnings || [],
        started: record.started,
        dir: record.dir,
        path: record.path,
        depends: meta.depends || {},
        inject: meta.inject || [],
        provides: meta.provides || [],
        slots: meta.slots || [],
        installTime: record.installTime || 0,
      }
    },

    /** 运行自检（验证插件是否真的在正常工作） */
    selfCheck() {
      return loader.selfCheck()
    },

    async enable(id) {
      const record = loader.get(id)
      if (!record) return false
      const ok = await loader.enable(id)
      if (ok) {
        const disabled = config.get('plugins.disabled', []).filter(x => x !== id)
        config.set('plugins.disabled', disabled)
        const enabled = new Set(config.get('plugins.enabled', []))
        enabled.add(id)
        config.set('plugins.enabled', [...enabled])
        toast.success(`已启用插件「${record.manifest.displayName}」`)
        events.emit('plugin:enabled', { id })
      } else {
        toast.error(`插件「${record.manifest.displayName}」启用失败：${record.reason || '依赖未满足'}`)
      }
      return ok
    },

    async disable(id) {
      const record = loader.get(id)
      if (!record || record.manifest.core) {
        toast.warn('核心插件不能禁用')
        return false
      }
      await loader.disable(id)
      const disabled = new Set(config.get('plugins.disabled', []))
      disabled.add(id)
      config.set('plugins.disabled', [...disabled])
      const enabled = new Set(config.get('plugins.enabled', []))
      enabled.delete(id)
      config.set('plugins.enabled', [...enabled])
      toast.info(`已禁用插件「${record.manifest.displayName}」`)
      events.emit('plugin:disabled', { id })
      return true
    },

    async toggle(id) {
      const record = loader.get(id)
      if (!record) return false
      return record.status === 'active' ? service.disable(id) : service.enable(id)
    },

    /** 卸载：标记 removed 并禁用；用户数据按文档 §10.7 保留 */
    async uninstall(id) {
      const record = loader.get(id)
      if (!record || record.manifest.core) return false
      const ok = await modal.open({
        title: `卸载插件「${record.manifest.displayName}」`,
        description: '插件数据会被保留，重新安装后可以恢复。',
        confirmText: '卸载',
      })
      if (!ok.ok) return false
      await loader.disable(id)
      record.manifest.removed = true
      const removed = new Set(config.get('plugins.removed', []))
      removed.add(id)
      config.set('plugins.removed', [...removed])
      const disabled = new Set(config.get('plugins.disabled', []))
      disabled.add(id)
      config.set('plugins.disabled', [...disabled])
      toast.warn(`已卸载「${record.manifest.displayName}」`)
      events.emit('plugin:uninstalled', { id })
      return true
    },

    /** 恢复被卸载的插件（演示用，正式版会走市场安装流程） */
    async restore(id) {
      const removed = new Set(config.get('plugins.removed', []))
      removed.delete(id)
      config.set('plugins.removed', [...removed])
      return service.enable(id)
    },

    /** 安装插件：插件市场是 M5，这里预留入口 */
    async install() {
      toast.info('插件市场将在 M5 开放：支持从市场或本地目录安装插件。')
      return false
    },

    stats() {
      const list = loader.list()
      const active = list.filter(r => r.status === 'active')
      const issues = loader.selfCheck ? loader.selfCheck() : []
      return {
        total: list.length,
        active: active.length,
        core: active.filter(r => r.manifest.core).length,
        thirdParty: active.filter(r => !r.manifest.core).length,
        errors: list.filter(r => r.status === 'error').length + list.filter(r => r.conflict).length,
        inactive: list.filter(r => r.status === 'inactive').length,
        warnings: issues.filter(i => i.severity !== 'error').length,
        services: ctx.registry.list().length,
        servicesByType: ctx.registry.list().reduce((acc, s) => {
          acc[s.type] = (acc[s.type] || 0) + 1
          return acc
        }, {}),
      }
    },
  }

  ctx.provide('plugin-manager', service, { type: 'singleton' })
  ctx.logger.debug('插件管理器就绪')
}
