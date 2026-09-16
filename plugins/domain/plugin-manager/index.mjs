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
export const depends = {
  'config': '^1.0.0',
  'event-bus': '*',
  'modal-host': '>=1.0.0',
  'plugin-loader': '^1.0.0',
  'toast-host': '>=1.0.0',
}
export const optionalDepends = {}
export const inject = ['plugin-loader', 'config', 'event-bus', 'toast', 'modal']
export const provides = [{ name: 'plugin-manager', type: 'singleton' }]

import { useStyle } from '../../../src/util/style.mjs'

const PANEL_CSS = `
  .plugin-panel-mask{position:fixed;inset:0;z-index:1150;display:flex;align-items:center;justify-content:center;background:rgba(18,28,38,.34);backdrop-filter:blur(2px);}
  .plugin-panel{width:min(620px,94vw);max-height:88vh;overflow:auto;padding:18px 20px;border-radius:18px;background:var(--panel-solid,#fff);box-shadow:0 24px 70px rgba(20,40,60,.3);display:flex;flex-direction:column;gap:12px;color:var(--text);}
  .plugin-panel-head{display:flex;align-items:flex-start;gap:12px;}
  .plugin-panel-title{font-size:16px;font-weight:650;color:var(--text);}
  .plugin-panel-sub{font-size:12px;color:var(--text-3);line-height:1.6;margin-top:3px;}
  .plugin-panel-close{margin-left:auto;width:28px;height:28px;border-radius:8px;border:1px solid var(--border);background:transparent;color:var(--text-3);cursor:pointer;}
  .plugin-panel-body{display:flex;flex-direction:column;gap:12px;}
  .plugin-panel-body .settings-section{margin-top:0;}
  .plugin-panel-empty{padding:22px 8px;text-align:center;color:var(--text-4);font-size:12.5px;}
  .plugin-panel-item{display:flex;align-items:center;gap:12px;padding:10px 12px;border:1px solid var(--border);border-radius:12px;background:rgba(255,255,255,.48);}
  .plugin-panel-item-main{flex:1;min-width:0;}
  .plugin-panel-item-name{font-size:13px;font-weight:600;color:var(--text);}
  .plugin-panel-item-desc{font-size:11.5px;color:var(--text-3);line-height:1.6;margin-top:4px;word-break:break-all;}
  .plugin-panel-item-actions{display:flex;gap:7px;flex:0 0 auto;}
`

export function apply(ctx) {
  const loader = ctx.inject('plugin-loader')
  const config = ctx.inject('config')
  const events = ctx.inject('event-bus')
  const toast = ctx.inject('toast')
  const modal = ctx.inject('modal')

  const panels = new Map()
  let panelOverlay = null
  let panelCleanup = null

  useStyle(ctx, PANEL_CSS)

  const closePanel = () => {
    try {
      panelCleanup?.()
    } catch (_) {
      /* ignore */
    }
    panelCleanup = null
    panelOverlay?.remove()
    panelOverlay = null
  }

  const STATUS_LABEL = {
    active: '已启用',
    disabled: '已禁用',
    inactive: '未激活',
    error: '异常',
    pending: '加载中',
  }

  const escapeText = value =>
    String(value ?? '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[m])

  /**
   * 共享偏好（plugins.disabled / removed / enabled）变化时，把当前运行时的
   * 插件实际状态对齐。这样另一台设备 / 手机点卸载后，本页和代聊 Worker
   * 都能在不需要刷新页面的情况下停掉对应插件。
   */
  const reconcilePluginRuntime = async reason => {
    const disabled = new Set(config.get('plugins.disabled', []) || [])
    const removed = new Set(config.get('plugins.removed', []) || [])
    const enabled = new Set(config.get('plugins.enabled', []) || [])
    const changed = []
    for (const record of loader.list()) {
      const id = record?.id
      if (!id || record.manifest?.core) continue
      if (record.manifest) record.manifest.removed = removed.has(id)
      const defaultOff = record.manifest?.enabled === false && !enabled.has(id)
      const shouldStop = removed.has(id) || disabled.has(id) || defaultOff
      if (shouldStop) {
        if (record.status !== 'disabled') {
          await loader.disable(id)
          changed.push(`停用 ${id}`)
          events.emit('plugin:disabled', { id, reason })
        }
      } else if (record.status === 'disabled') {
        const ok = await loader.enable(id)
        if (ok) {
          changed.push(`启用 ${id}`)
          events.emit('plugin:enabled', { id, reason })
        }
      }
    }
    if (changed.length) ctx.logger.info(`[plugin-manager] 已按共享偏好热更新插件：${changed.join('、')}（${reason}）`)
    return changed
  }

  let reconcileTimer = null
  let reconcileChain = Promise.resolve()
  const scheduleReconcile = reason => {
    if (reconcileTimer) ctx.clearTimeout(reconcileTimer)
    reconcileTimer = ctx.setTimeout(() => {
      reconcileTimer = null
      reconcileChain = reconcileChain
        .then(() => reconcilePluginRuntime(reason))
        .catch(err => ctx.logger.warn(`[plugin-manager] 同步插件状态失败：${err?.message || err}`))
    }, 40)
  }

  let runtimeSyncTimer = null
  /**
   * 本页改了启停 / 卸载状态后：先把 preferences 立即写回后端，再触发
   * 插件目录重扫。重扫会重启服务端代聊 Worker，并让其按最新偏好加载，
   * 避免“插件已卸载、QQ 代聊还在调用旧工具”的残留。
   */
  const scheduleRuntimePluginSync = () => {
    if (runtimeSyncTimer) ctx.clearTimeout(runtimeSyncTimer)
    runtimeSyncTimer = ctx.setTimeout(() => {
      runtimeSyncTimer = null
      Promise.resolve()
        .then(() => config.flush?.())
        .then(() => ctx.registry.get('api')?.rescanPlugins?.())
        .catch(err => ctx.logger.debug(`[plugin-manager] 通知运行时刷新插件失败：${err?.message || err}`))
    }, 450)
  }

  const service = {
    name: 'plugin-manager',

    /**
     * 插件设置面板注册：插件可以在自己的 apply 里调用
     *   ctx.inject('plugin-manager').registerSettings({ id, title, description, render })
     * render(container, { ctx, manager, close }) 返回的清理函数会在面板关闭时执行。
     * 这样插件专属配置可以直接出现在「设置 → 插件」对应条目后的「设置」按钮里。
     */
    registerSettings(definition = {}) {
      const id = String(definition.id || '').trim()
      if (!id) throw new Error('插件设置面板必须声明 id')
      panels.set(id, {
        id,
        title: String(definition.title || '插件设置'),
        description: String(definition.description || ''),
        render: typeof definition.render === 'function' ? definition.render : null,
      })
      events.emit('plugin:settings-registered', { id })
      return () => service.unregisterSettings(id)
    },

    unregisterSettings(id) {
      panels.delete(String(id || ''))
      events.emit('plugin:settings-registered', { id, removed: true })
      return true
    },

    settingsOf(id) {
      const panel = panels.get(String(id || ''))
      return panel ? { id: panel.id, title: panel.title, description: panel.description } : null
    },

    hasSettings: id => panels.has(String(id || '')),

    /** 打开插件自己的设置面板（没有注册面板时返回 false） */
    openSettings(id) {
      const panel = panels.get(String(id || ''))
      if (!panel || !panel.render) {
        toast.warn('该插件没有提供设置面板')
        return false
      }
      closePanel()
      panelOverlay = document.createElement('div')
      panelOverlay.className = 'plugin-panel-mask'
      panelOverlay.innerHTML = `
        <div class="plugin-panel" role="dialog" aria-modal="true">
          <div class="plugin-panel-head">
            <div>
              <div class="plugin-panel-title">${escapeText(panel.title)}</div>
              <div class="plugin-panel-sub">${escapeText(panel.description || `插件 ${panel.id} 的设置面板`)}</div>
            </div>
            <button class="plugin-panel-close" title="关闭">✕</button>
          </div>
          <div class="plugin-panel-body"></div>
        </div>`
      const body = panelOverlay.querySelector('.plugin-panel-body')
      try {
        const cleanup = panel.render(body, { ctx, manager: service, close: closePanel })
        panelCleanup = typeof cleanup === 'function' ? cleanup : null
      } catch (err) {
        ctx.logger.error(`插件 ${panel.id} 设置面板渲染失败`, err)
        body.innerHTML = '<div class="plugin-panel-empty">设置面板渲染失败，请查看日志。</div>'
      }
      panelOverlay.querySelector('.plugin-panel-close')?.addEventListener('click', closePanel)
      panelOverlay.addEventListener('mousedown', event => {
        if (event.target === panelOverlay) closePanel()
      })
      document.body.appendChild(panelOverlay)
      return true
    },

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
        optionalDepends: meta.optionalDepends || {},
        dependencies: summary?.dependencies || [],
        dependencyIssues: summary?.dependencyIssues || [],
        dependencyHealth: summary?.dependencyHealth || 'ok',
        inject: meta.inject || [],
        provides: meta.provides || [],
        slots: meta.slots || [],
        installTime: record.installTime || 0,
        hasSettings: panels.has(id),
        settingsTitle: panels.get(id)?.title || '',
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
        scheduleRuntimePluginSync()
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
      scheduleRuntimePluginSync()
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
      scheduleRuntimePluginSync()
      return true
    },

    /** 恢复被卸载的插件（演示用，正式版会走市场安装流程） */
    async restore(id) {
      const removed = new Set(config.get('plugins.removed', []))
      removed.delete(id)
      config.set('plugins.removed', [...removed])
      const ok = await service.enable(id)
      scheduleRuntimePluginSync()
      return ok
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
      const dependencies = list.flatMap(r => r.dependencies || [])
      return {
        total: list.length,
        active: active.length,
        core: active.filter(r => r.manifest.core).length,
        thirdParty: active.filter(r => !r.manifest.core).length,
        errors: list.filter(r => r.status === 'error').length + list.filter(r => r.conflict).length,
        inactive: list.filter(r => r.status === 'inactive').length,
        warnings: issues.filter(i => i.severity !== 'error').length,
        dependencyErrors: dependencies.filter(d => d.required && d.severity === 'error').length,
        dependencyWarnings: dependencies.filter(d => !d.required && d.severity === 'warning').length,
        services: ctx.registry.list().length,
        servicesByType: ctx.registry.list().reduce((acc, s) => {
          acc[s.type] = (acc[s.type] || 0) + 1
          return acc
        }, {}),
      }
    },
  }

  // 另一台设备 / 手机改动共享偏好后，SSE 会同步到这里；无需刷新页面，
  // 插件管理器和所有依赖它的注册项会一起热更新。
  ctx.effect(
    ctx.on('config:changed', payload => {
      const key = String(payload?.key || '')
      if (key === '*' || key.startsWith('plugins.')) scheduleReconcile(`config:${key}`)
    }),
  )

  ctx.provide('plugin-manager', service, { type: 'singleton' })
  ctx.logger.debug('插件管理器就绪')
}
