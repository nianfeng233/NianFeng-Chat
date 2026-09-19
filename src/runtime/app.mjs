/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * 念风应用运行时：真实 cordis 之上的薄封装。
 *
 * 职责：
 *  - 创建 cordis Context，并把念风约定（事件索引 / 服务台账 / 插件状态）挂上去
 *  - 动态 import 插件模块 → 交给 cordis 的 ctx.plugin() 管理生命周期与依赖注入
 *  - 提供插件管理器需要的状态视图（active / inactive / error / disabled）与启停
 *  - 语义冲突启发式检测（插槽拥挤 / 多监听者 / 多实现）
 *
 * 所有插件的依赖注入、fiber 生命周期、事件总线、日志系统均由 cordis 原生实现。
 */
import { Context as CordisContext } from 'cordis'
import { satisfies } from './semver.mjs'
import { createCompat } from './compat.mjs'
import { ConflictError } from './errors.mjs'
import { isPluginInScope } from './plugin-scope.mjs'

export const VERSION = '2.2.0-preview.3'

export const STATUS = {
  PENDING: 'pending',
  ACTIVE: 'active',
  INACTIVE: 'inactive',
  DISABLED: 'disabled',
  ERROR: 'error',
}

/** 插件依赖类型：必须依赖缺失=红，可选依赖缺失=黄。 */
export const DEPENDENCY_KIND = {
  REQUIRED: 'required',
  OPTIONAL: 'optional',
}

const FIBER = { PENDING: 0, LOADING: 1, ACTIVE: 2, FAILED: 3, DISPOSED: 4, UNLOADING: 5 }

export class App {
  constructor({ baseUrl } = {}) {
    this.baseUrl = baseUrl
    this.version = VERSION
    this.startedAt = Date.now()
    this.cordis = new CordisContext()

    this.records = new Map()
    this.services = new Map() // name -> { name, type, owner, meta, value }
    this.serviceOwners = new Map()
    this.serviceGuard = null // 插件权限中心注册的服务访问守卫（可选）
    this.eventIndex = new Map() // name -> Set<record>
    this.eventSinks = new Set() // 事件历史 / 调试用
    this.serviceWaiters = new Set()
    this.warnings = []
    this.trace = null
    this.onError = (err, meta) => console.error(`[kernel] ${meta?.event || ''} ${meta?.plugin || ''}`, err)
    this.loggers = new Map()
    // 热插拔：所有清单同步串行化，避免安装 / 卸载 / 禁用同时触发导致双实例。
    this.syncChain = Promise.resolve()
    this.progress = null
    this.enabling = new Set()
    // 运行范围：all=测试/完整，server=后端终端，webui=浏览器视觉界面。
    this.scope = 'all'

    // 内核自身也是 cordis 服务：插件可以通过 inject: ['app'] 使用
    this.cordis.provide('app', this.publicApi())
    this.services.set('app', { name: 'app', type: 'singleton', owner: 'kernel', meta: {}, value: this.publicApi() })
    this.serviceOwners.set('app', 'kernel')

    // 根 ctx 的念风兼容视图（调试对象 / 引导脚本使用；插件拿到的是各自 fiber 的兼容视图）
    this.rootCompat = createCompat(this, this.cordis, { id: 'app', meta: { plugin: { name: 'app' } } })

    this.eventsFacade = {
      get onError() {
        return self.onError
      },
      set onError(fn) {
        self.onError = typeof fn === 'function' ? fn : self.onError
      },
      get trace() {
        return self.trace
      },
      set trace(fn) {
        self.trace = typeof fn === 'function' ? fn : null
      },
      owners: name => [...(self.eventIndex.get(name) || [])].map(r => r.owner),
      listeners: name =>
        [...(self.eventIndex.get(name) || [])].map(r => ({ owner: r.owner, once: r.once, interceptor: r.interceptor })),
      eventNames: () => [...self.eventIndex.keys()],
      addSink(cb) {
        self.eventSinks.add(cb)
        return () => {
          self.eventSinks.delete(cb)
        }
      },
      removeSink(cb) {
        self.eventSinks.delete(cb)
      },
    }
    const self = this
  }

  /* ================= 对外 API（服务 app） ================= */

  publicApi() {
    const self = this
    return {
      version: VERSION,
      get loader() {
        return self
      },
      get startedAt() {
        return self.startedAt
      },
      get warnings() {
        return self.warnings
      },
      services: () => self.serviceList(),
      service: name => self.serviceList().find(s => s.name === name),
      onServiceProvided: cb => self.onServiceProvided(cb),
      /** 插件权限中心：安装服务访问守卫（接线后所有 inject 都会先过守卫） */
      setServiceGuard: fn => {
        self.serviceGuard = typeof fn === 'function' ? fn : null
        return () => {
          if (self.serviceGuard === fn) self.serviceGuard = null
        }
      },
      applyServiceGuard: (manifest, serviceName, value) => (self.serviceGuard ? self.serviceGuard(manifest, serviceName, value) : value),
      /** 取插件 manifest（权限中心按插件 id 查询声明） */
      manifestOf: id => self.records.get(id)?.manifest || null,
      manifests: () => [...self.records.values()].map(record => record.manifest),
      /** 运行期热插拔：按最新 /api/plugins 快照同步新增 / 更新 / 删除 / 启停。 */
      syncEntries: (entries, options) => self.syncEntries(entries, options),
      reloadPlugin: (id, options) => self.reloadPlugin(id, options),
      removePlugin: (id, options) => self.removeRuntimeRecord(id, options),
      reportError: (err, meta) => self.reportError(err, meta),
      trace: (on = true, sink = console.log) => {
        self.trace = on ? (phase, name, payload, owner) => sink(`[trace] ${phase} ${name}`, owner, payload) : null
        return on
      },
    }
  }

  /* ================= 日志 ================= */

  loggerFor(owner) {
    if (!owner) return this.cordis.logger
    if (!this.loggers.has(owner)) {
      try {
        this.loggers.set(owner, this.cordis.logger(owner))
      } catch (_) {
        this.loggers.set(owner, this.cordis.logger)
      }
    }
    return this.loggers.get(owner)
  }

  reportError(err, meta = {}) {
    try {
      this.onError(err, meta)
    } catch (_) {
      console.error(err)
    }
  }

  /* ================= 服务台账 ================= */

  hasService(name) {
    return this.services.has(name)
  }

  serviceList() {
    return [...this.services.values()].map(s => ({
      name: s.name,
      type: s.type,
      owner: s.owner,
      count: 1,
      owners: [s.owner],
      meta: s.meta,
    }))
  }

  emitServiceProvided(name, record) {
    if (this.trace) this.trace('service', name, record.owner)
    for (const waiter of [...this.serviceWaiters]) {
      try {
        waiter(name, record)
      } catch (_) {
        /* ignore */
      }
    }
    // 服务出现后，等待该服务的 fiber 可能会在下一个微任务 / 宏任务里激活：
    // 自动跑一次 reclassify，插件页状态不必等用户手动刷新。
    this.scheduleReclassify()
  }

  onServiceProvided(cb) {
    this.serviceWaiters.add(cb)
    return () => this.serviceWaiters.delete(cb)
  }

  scheduleReclassify() {
    if (this.reclassifyTimer) return
    this.reclassifyTimer = setTimeout(() => {
      this.reclassifyTimer = null
      try {
        this.reclassify()
        this.emit('plugins:state-changed', { count: this.activeCount, total: this.records.size })
      } catch (err) {
        this.reportError(err, { event: 'reclassify', plugin: 'kernel' })
      }
    }, 0)
  }

  /* ================= 事件兼容层 ================= */

  onCompat(ctx, name, listener, options = {}, owner = ctx.fiber?.name || 'anonymous') {
    if (typeof listener !== 'function') throw new TypeError(`事件 ${name} 的监听器必须是函数`)
    const record = {
      name,
      owner,
      once: !!options.once,
      interceptor: !!options.interceptor,
      orig: listener,
      wrapped: null,
      dispose: null,
    }
    if (!record.interceptor) {
      record.wrapped = payload => {
        if (this.trace) this.trace('dispatch', name, payload, owner)
        try {
          listener(payload, { event: name, plugin: owner })
        } catch (err) {
          this.reportError(err, { event: name, plugin: owner })
        }
      }
      const realDispose = options.once ? ctx.once(name, record.wrapped) : ctx.on(name, record.wrapped)
      record.dispose = () => {
        try {
          realDispose?.()
        } catch (_) {
          /* ignore */
        }
      }
    }
    if (!this.eventIndex.has(name)) this.eventIndex.set(name, new Set())
    this.eventIndex.get(name).add(record)

    const remove = () => {
      const set = this.eventIndex.get(name)
      set?.delete(record)
      record.dispose?.()
    }
    // 随插件 fiber 一起清理 eventIndex 记录（对拦截器尤其重要：
    // 拦截器不走 cordis 的 ctx.emit，必须显式在卸载时移除）。
    try {
      ctx.effect(() => remove)
    } catch (_) {
      this._disposers?.push(remove)
    }
    return remove
  }

  offCompat(name, listener) {
    const set = this.eventIndex.get(name)
    if (!set) return false
    for (const record of [...set]) {
      if (record.orig === listener) {
        set.delete(record)
        record.dispose?.()
        return true
      }
    }
    return false
  }

  emitCompat(ctx, name, payload, options = {}) {
    if (this.trace) {
      let owner = 'app'
      try {
        owner = ctx?.fiber?.name || 'app'
      } catch (_) {
        /* cordis 代理在极端情况下可能拒绝访问，保持可追踪即可 */
      }
      this.trace('emit', name, payload, owner)
    }
    if (this.eventSinks.size) {
      const entry = { event: name, payload, time: Date.now() }
      for (const sink of [...this.eventSinks]) {
        try {
          sink(entry)
        } catch (_) {
          /* ignore */
        }
      }
    }

    // 拦截型事件：按注册顺序依次调用，允许监听器返回新 payload（文档 §4.3）
    if (options.interceptor) {
      let current = payload
      for (const record of [...(this.eventIndex.get(name) || [])]) {
        try {
          const returned = record.orig(current, { event: name, plugin: record.owner })
          if (returned !== undefined && returned !== current) {
            options.onIntercept?.(returned, record.owner)
            current = returned
          }
        } catch (err) {
          this.reportError(err, { event: name, plugin: record.owner })
        }
        if (record.once) {
          const set = this.eventIndex.get(name)
          set?.delete(record)
        }
      }
      return current
    }

    let current = payload
    const records = [...(this.eventIndex.get(name) || [])]
    const interceptors = records.filter(r => r.interceptor)
    for (const record of interceptors) {
      try {
        const returned = record.orig(current, { event: name, plugin: record.owner })
        if (returned !== undefined && returned !== current) {
          options.onIntercept?.(returned, record.owner)
          current = returned
        }
      } catch (err) {
        this.reportError(err, { event: name, plugin: record.owner })
      }
    }
    try {
      ctx.emit(name, current)
    } catch (err) {
      this.reportError(err, { event: name, plugin: 'kernel' })
    }
    return current
  }

  /** 内核自身广播（不经过插件 ctx） */
  emit(name, payload, options = {}) {
    return this.emitCompat(this.cordis, name, payload, options)
  }

  /* ================= 插件加载 ================= */

  /**
   * 完整加载：先从清单元数据建立记录，再并发导入模块，最后按依赖顺序激活。
   * 与旧实现的关键区别：
   *   - 禁用 / 卸载的插件不再被 import，省掉无意义的网络与解析开销；
   *   - 模块导入并发执行，远程 WebUI 不再因为几十个串行请求卡半分钟；
   *   - 导入失败只影响单个插件，运行期可通过 syncEntries() 重试或热添加。
   */
  async loadAll(entries = [], { disabled = [], enabled = [], removed = [], onProgress = null, scope = 'all' } = {}) {
    this.disabledIds = new Set(disabled)
    this.enabledIds = new Set(enabled)
    this.removedIds = new Set(removed)
    this.progress = onProgress
    this.scope = scope || 'all'

    for (const entry of entries) {
      if (!entry?.path || !this.entryAllowed(entry)) continue
      const record = this.createRecord(entry)
      this.records.set(record.id, record)
    }

    this.applyBootPreferences()
    const pending = [...this.records.values()].filter(record => record.status === STATUS.PENDING)
    await this.prefetchRecords(pending, { onProgress })
    await this.activatePending({ timeout: 2500, onProgress })
    this.emit('plugins:ready', { count: this.activeCount, total: this.records.size, mode: 'boot' })
    return this
  }

  /**
   * 从 /api/plugins 快照热同步：新增 / 更新 / 删除 / 启停都在运行期完成。
   * 多个运行时（WebUI、服务端代聊 Worker、手机）共享同一份清单，任何一端
   * 安装 / 卸载外部插件后，其它端不需要刷新页面或重启进程。
   */
  syncEntries(entries = [], { disabled = [], removed = [], enabled = [], reason = 'sync', onProgress = null, scope = null } = {}) {
    const task = this.syncChain.catch(() => {}).then(() =>
      this._syncEntries(entries, { disabled, removed, enabled, reason, onProgress, scope }),
    )
    this.syncChain = task
    return task
  }

  async _syncEntries(entries, { disabled, removed, enabled, reason, onProgress, scope = null }) {
    this.disabledIds = new Set(disabled || [])
    this.enabledIds = new Set(enabled || [])
    this.removedIds = new Set(removed || [])
    this.progress = onProgress
    if (scope) this.scope = scope
    const next = new Map()
    for (const entry of entries || []) {
      if (!entry?.path || !this.entryAllowed(entry)) continue
      next.set(String(entry.id || entry.dir || entry.path), entry)
    }

    // 1) 文件已删除 / 插件目录被切换：先停掉依赖它的插件，再摘掉记录。
    for (const record of [...this.records.values()]) {
      if (!next.has(record.id)) {
        await this.removeRuntimeRecord(record.id, { reason: `${reason}: 已从插件清单移除`, cascade: true })
      }
    }

    // 2) 新增 / 更新清单。外部插件 path 带 mtime 版本号，路径变化即代码变化。
    const changed = []
    for (const [id, entry] of next) {
      let record = this.records.get(id)
      if (!record) {
        record = this.createRecord(entry)
        record.manifest.removed = this.removedIds.has(id)
        this.records.set(id, record)
        changed.push({ id, kind: 'added' })
        continue
      }
      const previousPath = record.path
      const wasLegacy = !!record.manifest?.legacy
      record.entry = entry
      record.path = entry.path
      record.external = !!entry.external
      record.source = entry.source || record.source || (entry.external ? 'external' : 'builtin')
      const preservedRemoved = !!record.manifest.removed
      record.manifest = this.manifestFromEntry(entry, record.manifest)
      record.manifest.removed = preservedRemoved || this.removedIds.has(id)
      const becameLegacy = !wasLegacy && !!record.manifest.legacy
      if (entry.error) {
        await this.disposeRecord(record)
        record.module = null
        record.status = STATUS.ERROR
        record.error = new Error(entry.error)
        record.reason = `模块导入失败：${entry.error}`
        continue
      }
      // 代码文件变化（外部插件 path 带 mtime）或清单从兼容变为旧版不兼容时，
      // 都先释放旧实例再重新判定，避免旧版插件继续以“正常”状态运行。
      if (previousPath && (previousPath !== entry.path || becameLegacy)) {
        await this.disposeRecord(record)
        record.module = null
        record.status = STATUS.PENDING
        record.reloadPending = true
        changed.push({ id, kind: 'updated' })
      }
    }

    // 3) 共享偏好：禁用 / 卸载 / 默认关闭。
    for (const record of this.records.values()) {
      const id = record.id
      const defaultOff = record.manifest.enabled === false && !this.enabledIds.has(id)
      record.manifest.removed = this.removedIds.has(id)
      const shouldStop = record.manifest.removed || this.disabledIds.has(id) || defaultOff
      if (shouldStop) {
        if (record.status !== STATUS.DISABLED || record.fiber) {
          record.reason = record.manifest.removed
            ? '已被卸载'
            : this.disabledIds.has(id)
              ? '已被用户禁用'
              : '默认未启用（可在插件管理中开启）'
          await this.disableTree(record, { reason: record.reason, markDisabled: true, rootId: id })
        }
      } else if (record.status === STATUS.DISABLED) {
        // 偏好恢复启用：走统一激活流程；更新过的外部插件会拿到新模块。
        record.status = STATUS.PENDING
        record.reason = ''
        record.disabledRoot = null
        record.reloadPending = true
      }
    }

    const pending = [...this.records.values()].filter(record => record.status === STATUS.PENDING && !record.manifest.removed)
    await this.prefetchRecords(pending, { onProgress })
    await this.activatePending({ timeout: 1800, onProgress })
    this.emit('plugins:synced', { reason, changed, count: this.activeCount, total: this.records.size })
    return { ok: true, changed, active: this.activeCount, total: this.records.size }
  }

  /** 断开旧 fiber、执行模块 dispose hook，但不改变用户偏好状态。 */
  async disposeRecord(record) {
    if (!record) return
    await this.stopOne(record)
    try {
      if (typeof record.module?.dispose === 'function') await record.module.dispose(record.compatCtx, record.config)
    } catch (err) {
      this.emit('plugin:error', { id: record.id, error: err, phase: 'dispose' })
    }
    try {
      await record.fiber?.dispose()
    } catch (err) {
      this.emit('plugin:error', { id: record.id, error: err, phase: 'dispose' })
    }
    record.fiber = null
    record.fiberPromise = null
    record.compatCtx = null
    record.started = false
  }

  /** 运行期删除记录（外部插件文件被删除 / 插件目录切换时调用）。 */
  async removeRuntimeRecord(id, { reason = '', cascade = true } = {}) {
    const record = this.records.get(id)
    if (!record) return false
    if (cascade) {
      for (const dependent of this.dependentsOf(id)) {
        if (dependent.manifest.core) continue
        dependent.disabledRoot = id
        await this.disableTree(dependent, { reason: `依赖 ${id} 已不存在`, markDisabled: false, rootId: id })
      }
    }
    await this.disposeRecord(record)
    this.records.delete(id)
    this.emit('plugin:removed', { id, reason })
    return true
  }

  /** 运行期重新导入并激活一个插件；外部插件更新后可立即生效。 */
  async reloadPlugin(id, { reason = 'reload' } = {}) {
    const record = this.records.get(id)
    if (!record) return false
    const wasEnabled = !this.disabledIds.has(id) && !record.manifest.removed
    await this.disposeRecord(record)
    record.module = null
    record.status = wasEnabled ? STATUS.PENDING : STATUS.DISABLED
    record.reason = ''
    if (!wasEnabled) return true
    await this.prefetchRecords([record], { force: true })
    if (record.status === STATUS.ERROR) return false
    await this.activatePending({ timeout: 1500 })
    this.emit('plugin:reloaded', { id, reason, status: record.status })
    return record.status === STATUS.ACTIVE
  }

  /** 按清单元数据创建轻量记录：此时不 import 模块，禁用插件因此完全不产生网络请求。 */
  createRecord(entry) {
    const id = String(entry.id || entry.dir || entry.path || '').trim()
    return {
      id,
      path: entry.path,
      dir: entry.dir || '',
      external: !!entry.external,
      source: entry.source || (entry.external ? 'external' : 'builtin'),
      entry,
      status: entry.error ? STATUS.ERROR : STATUS.PENDING,
      error: entry.error ? new Error(entry.error) : null,
      reason: entry.error ? `模块导入失败：${entry.error}` : '',
      warnings: [],
      started: false,
      dynamic: false,
      fiber: null,
      fiberPromise: null,
      compatCtx: null,
      inject: [],
      optionalInject: [],
      module: null,
      importPromise: null,
      config: entry.config || {},
      manifest: this.manifestFromEntry(entry),
    }
  }

  /** 把 /api/plugins 清单字段映射成 manifest；不覆盖已有运行期字段。 */
  manifestFromEntry(entry = {}, base = {}) {
    const id = String(entry.id || base.name || entry.dir || entry.path || '').trim()
    const pick = (next, previous) => (next === undefined || next === null || next === '' ? previous : next)
    return {
      ...base,
      name: id || base.name,
      version: pick(entry.version, base.version) || '0.0.0',
      legacy: entry.legacy !== undefined ? !!entry.legacy : !!base.legacy,
      legacyReason: pick(entry.legacyReason, base.legacyReason) || '',
      displayName: pick(entry.displayName, base.displayName) || id,
      description: pick(entry.description, base.description) || '',
      author: pick(entry.author, base.author) || '',
      icon: pick(entry.icon, base.icon) || '',
      unavailable: entry.unavailable !== undefined ? !!entry.unavailable : !!base.unavailable,
      unavailableReason: pick(entry.unavailableReason, base.unavailableReason) || '',
      core: entry.core !== undefined ? !!entry.core : !!base.core,
      enabled: entry.enabled !== undefined ? entry.enabled !== false : base.enabled !== false,
      depends: normalizeDepends(entry.depends !== undefined ? entry.depends : base.depends),
      optionalDepends: normalizeDepends(
        entry.optionalDepends !== undefined || entry.softDepends !== undefined
          ? entry.optionalDepends || entry.softDepends
          : base.optionalDepends,
      ),
      inject: entry.inject !== undefined ? collectEntryInject(entry.inject) : base.inject || [],
      provides: entry.provides !== undefined ? entry.provides : base.provides || [],
      permissions: entry.permissions !== undefined ? entry.permissions : base.permissions || [],
      slots: entry.slots !== undefined ? entry.slots : base.slots || [],
      external: !!entry.external,
      source: entry.source || base.source || (entry.external ? 'external' : 'builtin'),
      removed: entry.removed !== undefined ? !!entry.removed : !!base.removed,
      hasApply: base.hasApply !== false,
    }
  }

  /** 并发导入模块；单个失败不会影响其它插件。 */
  async prefetchRecords(records = [], { concurrency = 8, onProgress = null, force = false } = {}) {
    const queue = records.filter(Boolean)
    const total = queue.length
    if (!total) return
    let done = 0
    const workers = Array.from({ length: Math.min(Math.max(1, concurrency), total) }, async () => {
      while (queue.length) {
        const record = queue.shift()
        await this.importRecord(record, { force: force || record.reloadPending })
        record.reloadPending = false
        done += 1
        if (onProgress) {
          onProgress({ phase: 'import', loaded: done, total, id: record.id, status: record.status, reason: record.reason })
        }
      }
    })
    await Promise.all(workers)
  }

  /** 导入单个插件模块并回填 manifest；同一插件的并发导入会复用同一个 Promise。 */
  async importRecord(record, { force = false } = {}) {
    if (!record || !record.path) return null
    if (record.module && !force) return record.module
    if (record.importPromise) return record.importPromise
    if (record.status === STATUS.ERROR && !force) return null
    const task = (async () => {
      try {
        const url = this.moduleUrl(record, { force })
        const mod = await import(/* @vite-ignore */ url)
        record.module = mod
        record.manifest = collectManifest(mod, { ...(record.entry || {}), id: record.id, external: record.external })
        const nextId = String(record.manifest.name || record.id)
        if (nextId && nextId !== record.id && !this.records.has(nextId)) {
          this.records.delete(record.id)
          record.id = nextId
          this.records.set(nextId, record)
        }
        if (this.removedIds?.has(record.id)) record.manifest.removed = true
        record.status = STATUS.PENDING
        record.error = null
        record.reason = ''
        return mod
      } catch (err) {
        record.module = null
        record.status = STATUS.ERROR
        record.error = err
        record.reason = '模块导入失败：' + (err?.message || String(err))
        this.emit('plugin:error', { id: record.id, error: err, phase: 'import' })
        return null
      } finally {
        record.importPromise = null
      }
    })()
    record.importPromise = task
    return task
  }

  moduleUrl(record, { force = false } = {}) {
    const base = this.baseUrl || (typeof location !== 'undefined' ? location.href : 'http://localhost/')
    const url = new URL(record.path, base)
    if (force) {
      // 同一 URL 的 ESM 模块会被浏览器 / Node 永久缓存；热重载必须换 key。
      url.searchParams.set('__nfv', `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`)
    }
    return url.href
  }

  /** 激活所有 PENDING 记录：依赖排序、循环检测、fiber 激活、start 钩子、自检。 */
  async activatePending({ timeout = 2500, onProgress = null } = {}) {
    const graph = this.graph()
    for (const id of graph.cycleIds) {
      const record = this.records.get(id)
      if (record && record.status === STATUS.PENDING) {
        record.status = STATUS.INACTIVE
        record.reason = `循环依赖：${graph.cycle.join(' → ')}`
        this.emit('plugin:inactive', { id: record.id, reason: record.reason, missing: [] })
      }
    }

    for (const record of this.orderedRecords()) {
      if (record.status !== STATUS.PENDING) continue
      const skipIfUnavailable = () => {
        const compatibilityIssues = this.compatibilityIssues(record)
        if (compatibilityIssues.length) {
          record.status = STATUS.INACTIVE
          record.reason = `不兼容：${compatibilityIssues.join('、')}`
          this.emit('plugin:inactive', { id: record.id, reason: record.reason, missing: compatibilityIssues })
          return true
        }
        const hardIssues = this.hardDependsIssues(record)
        if (hardIssues.length) {
          record.status = STATUS.INACTIVE
          record.reason = `依赖不满足：${hardIssues.join('、')}`
          this.emit('plugin:inactive', { id: record.id, reason: record.reason, missing: hardIssues })
          return true
        }
        return false
      }
      // 允许的条目元数据里已经有 depends / legacy 时先判掉，避免为了加载一个注定标红的插件
      // 也去 import 模块、执行顶层代码，把启动过程拖慢甚至带崩。
      if (skipIfUnavailable()) continue
      if (!record.module) {
        await this.importRecord(record, { force: record.reloadPending })
        record.reloadPending = false
      }
      if (record.status !== STATUS.PENDING) continue
      // import 之后 manifest 才是最终版，再判一次（外部插件的 depends 可能只有模块里才写全）。
      if (skipIfUnavailable()) continue
      await this.activate(record)
    }

    await this.settle(timeout)
    this.reclassify()

    for (const record of this.orderedRecords()) {
      if (record.status !== STATUS.ACTIVE || record.started) continue
      await this.startOne(record)
    }

    this.detectSemanticConflicts()
    if (onProgress) onProgress({ phase: 'ready', loaded: this.activeCount, total: this.records.size })
  }

  /** 当前运行范围是否允许该插件（all/server/webui）。 */
  entryAllowed(entry) {
    return isPluginInScope(entry, this.scope)
  }

  applyBootPreferences() {
    for (const record of this.records.values()) {
      if (record.status !== STATUS.PENDING) continue
      const defaultOff = record.manifest.enabled === false && !this.enabledIds.has(record.id)
      record.manifest.removed = this.removedIds.has(record.id)
      if (this.disabledIds.has(record.id) || record.manifest.removed || defaultOff) {
        record.status = STATUS.DISABLED
        record.reason = record.manifest.removed
          ? '已被卸载'
          : defaultOff
            ? '默认未启用（可在插件管理中开启）'
            : '已被用户禁用'
      }
    }
  }

  dependentsOf(id) {
    const list = []
    for (const record of this.records.values()) {
      if (record.id === id) continue
      if (record.manifest?.depends && Object.prototype.hasOwnProperty.call(record.manifest.depends, id)) list.push(record)
    }
    return list
  }

  /** 把单个插件交给 cordis（inject 不满足时会保持 pending，由 cordis 在服务出现后自动激活） */
  async activate(record) {
    if (!record) return record
    if (!record.module) {
      await this.importRecord(record, { force: record.reloadPending })
      record.reloadPending = false
    }
    const mod = record.module
    const apply = pickApply(mod)
    if (!apply) {
      record.status = STATUS.ERROR
      record.reason = record.error ? record.reason : '插件没有导出 apply(ctx)'
      if (!record.error) record.error = new Error(record.reason)
      this.emit('plugin:error', { id: record.id, error: record.error, phase: 'manifest' })
      return record
    }
    // 可选依赖（'xxx?'）的处理：
    //  - 提供方插件已安装且未被禁用/出错：仍然作为硬依赖，等服务注册后再激活；
    //  - 提供方不存在 / 被用户禁用 / 本身就加载失败：从 cordis inject 中剔除，
    //    插件内 ctx.inject('xxx') 得到 undefined 后走离线降级分支。
    // cordis 的 inject 列表本身没有“可选”概念，因此可选性在这里完成判定。
    const requiredInject = []
    const optionalInject = []
    for (const item of collectInject(mod) || []) {
      const raw = String(item ?? '').trim()
      if (!raw) continue
      const optional = raw.endsWith('?')
      const name = optional ? raw.slice(0, -1) : raw
      if (!name || name === 'logger') continue
      if (optional && name !== 'app' && !this.isServiceProvisioned(name)) optionalInject.push(name)
      else requiredInject.push(name)
    }
    record.inject = [...new Set([...requiredInject, ...optionalInject])]
    record.optionalInject = [...new Set(optionalInject)]

    const wrapped = {
      name: record.id,
      inject: [...new Set(requiredInject)],
      apply: (fiberCtx, config) => {
        const compat = createCompat(this, fiberCtx, {
          id: record.id,
          meta: { plugin: record.manifest },
        })
        record.compatCtx = compat
        return apply.call(mod, compat, config)
      },
    }

    try {
      const fiber = this.cordis.plugin(wrapped, record.config || {})
      record.fiber = fiber
      record.status = STATUS.PENDING
      record.error = null
      record.reason = ''
      // 注意：cordis 的 await fiber 对 PENDING 状态也会立即 resolve，
      // 因此这里只捕获失败，真正的状态判定统一交给 reclassify() 读取 fiber.state。
      record.fiberPromise = Promise.resolve(fiber).catch(err => {
        record.error = err
        if (err?.name === 'ConflictError') record.conflict = true
      })
    } catch (err) {
      record.error = err
      record.conflict = err?.name === 'ConflictError'
      record.status = record.conflict ? STATUS.INACTIVE : STATUS.ERROR
      record.reason = err?.message || String(err)
      this.emit('plugin:error', { id: record.id, error: err, phase: 'plugin' })
    }
    return record
  }

  /** 等待 cordis 完成激活（pending 的插件保持 pending） */
  async settle(timeout = 2000) {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      const pendingFibers = [...this.records.values()].filter(
        r => r.fiber && (r.fiber.state === FIBER.PENDING || r.fiber.state === FIBER.LOADING),
      )
      if (!pendingFibers.length) return
      await new Promise(resolve => setTimeout(resolve, 25))
    }
  }

  /** 根据 cordis fiber 状态回填念风状态 */
  reclassify() {
    for (const record of this.records.values()) {
      // 手动标记为禁用 / 循环依赖的保持不变
      if (record.status === STATUS.DISABLED || (record.status === STATUS.INACTIVE && !record.fiber)) continue
      if (!record.fiber) continue

      const previous = record.status
      const state = record.fiber.state
      if (state === FIBER.ACTIVE) {
        record.status = STATUS.ACTIVE
        record.reason = ''
        record.error = null
      } else if (state === FIBER.FAILED) {
        const err = record.error || record.fiberError || record.fiber?._error
        record.conflict = err?.name === 'ConflictError'
        record.status = record.conflict ? STATUS.INACTIVE : STATUS.ERROR
        record.reason = record.reason || err?.message || '插件执行失败'
        this.emit('plugin:error', { id: record.id, error: err || new Error(record.reason), phase: 'apply' })
      } else if (state === FIBER.DISPOSED) {
        record.status = STATUS.DISABLED
      } else {
        // PENDING / LOADING：依赖未就绪
        record.status = STATUS.INACTIVE
        record.reason = `缺少依赖：${this.missingDeps(record).join('、') || '服务未就绪'}`
        this.emit('plugin:inactive', { id: record.id, reason: record.reason, missing: this.missingDeps(record) })
      }

      if (previous !== STATUS.ACTIVE && record.status === STATUS.ACTIVE) {
        this.emit('plugin:loaded', { id: record.id, manifest: record.manifest })
      }
    }
  }

  /** 判断某个服务是否由“已安装且未被禁用/加载失败”的插件声明提供 */
  isServiceProvisioned(name) {
    if (!name) return false
    if (name === 'app') return true
    for (const record of this.records.values()) {
      if (record.manifest?.removed) continue
      if (
        record.status === STATUS.DISABLED ||
        record.status === STATUS.ERROR ||
        record.status === STATUS.INACTIVE
      ) {
        continue
      }
      for (const item of record.manifest?.provides || []) {
        const provided = typeof item === 'string' ? item : item?.name
        if (provided === name) return true
      }
    }
    return false
  }

  /** 检查一组插件名依赖（不含 cordis inject 服务），用于加载前的版本/依赖判定 */
  dependsIssuesFor(record, dependencies = {}) {
    const issues = []
    for (const [dep, range] of Object.entries(dependencies || {})) {
      const target = this.records.get(dep)
      if (!target) issues.push(`${dep}${range ? '@' + range : ''}`)
      else if (target.manifest?.removed) issues.push(`${dep}(已卸载)`)
      else if (target.status === STATUS.ERROR) issues.push(`${dep}(加载失败)`)
      else if (target.status === STATUS.INACTIVE) issues.push(`${dep}(未激活)`)
      else if (target.status === STATUS.DISABLED) issues.push(`${dep}(已被禁用)`)
      else if (range && range !== '*' && !satisfies(target.manifest.version, range)) {
        issues.push(`${dep}@${range}(实际 ${target.manifest.version})`)
      }
    }
    return [...new Set(issues)]
  }

  /** 只检查插件必须 depends 声明（不含 cordis inject 服务） */
  dependsIssues(record) {
    return this.dependsIssuesFor(record, record.manifest.depends || {})
  }

  /**
   * 可选插件依赖（manifest.optionalDepends / softDepends）。
   * 缺失、未启用或版本不匹配都不会阻止本插件加载，只在插件页标黄提示；
   * 仍然影响插件详情里的依赖说明，方便第三方插件做“装了才启用”的扩展联动。
   */
  optionalDependsIssues(record) {
    return this.dependsIssuesFor(record, record.manifest.optionalDepends || {})
  }

  /** 运行环境兼容性：外部插件主版本必须与当前内核主版本一致。 */
  compatibilityIssues(record) {
    if (!record?.manifest?.legacy) return []
    const reason = record.manifest.legacyReason || `外部插件版本 ${record.manifest.version || '0.0.0'} 未适配当前内核`
    return [reason]
  }

  /**
   * 真正阻止插件激活的硬依赖问题：缺失 / 已卸载 / 加载失败 / 未激活 / 被禁用。
   * 版本不匹配不再阻止激活，只在插件页标黄提示（可能还能跑，但没按声明的范围来）。
   */
  hardDependsIssues(record) {
    const issues = []
    for (const [dep] of Object.entries(record.manifest.depends || {})) {
      const target = this.records.get(dep)
      if (!target) issues.push(`${dep}`)
      else if (target.manifest?.removed) issues.push(`${dep}(已卸载)`)
      else if (target.status === STATUS.ERROR) issues.push(`${dep}(加载失败)`)
      else if (target.status === STATUS.INACTIVE) issues.push(`${dep}(未激活)`)
      else if (target.status === STATUS.DISABLED) issues.push(`${dep}(已被禁用)`)
    }
    return [...new Set(issues)]
  }

  /**
   * 结构化依赖报告（插件管理页直接消费）。
   * status: ok | pending | missing | version-mismatch | error | inactive | disabled | removed
   * severity: ok | warning | error；必须依赖缺失 / 加载失败为 error；
   * 版本不匹配只标黄（仍会尝试加载），可选依赖任何异常都只做 warning。
   */
  dependencyReportFor(record, kind = DEPENDENCY_KIND.REQUIRED) {
    if (!record) return []
    const optional = kind === DEPENDENCY_KIND.OPTIONAL
    const dependencies = optional ? record.manifest.optionalDepends || {} : record.manifest.depends || {}
    return Object.entries(dependencies).map(([name, rawRange]) => {
      const range = String(rawRange || '*').trim() || '*'
      const target = this.records.get(name)
      const installedVersion = target?.manifest?.version || ''
      const report = {
        name,
        kind,
        required: !optional,
        range,
        installed: !!target,
        installedVersion,
        status: 'ok',
        severity: 'ok',
        satisfied: true,
        requiredBy: record.id,
        reason: '',
      }
      if (!target) {
        report.status = 'missing'
        report.satisfied = false
        report.severity = optional ? 'warning' : 'error'
        report.reason = `未安装（需要 ${name}@${range}）`
      } else if (target.manifest?.removed) {
        report.status = 'removed'
        report.satisfied = false
        report.severity = optional ? 'warning' : 'error'
        report.reason = '已卸载'
      } else if (target.status === STATUS.ERROR) {
        report.status = STATUS.ERROR
        report.satisfied = false
        report.severity = optional ? 'warning' : 'error'
        report.reason = `加载失败${target.reason ? `：${target.reason}` : ''}`
      } else if (target.status === STATUS.INACTIVE) {
        report.status = STATUS.INACTIVE
        report.satisfied = false
        report.severity = optional ? 'warning' : 'error'
        report.reason = `未激活${target.reason ? `：${target.reason}` : ''}`
      } else if (target.status === STATUS.DISABLED) {
        report.status = STATUS.DISABLED
        report.satisfied = false
        report.severity = optional ? 'warning' : 'error'
        report.reason = '已被禁用'
      } else if (range !== '*' && !satisfies(installedVersion, range)) {
        report.status = 'version-mismatch'
        report.satisfied = false
        // 版本不匹配只标黄：插件仍会加载，但没按声明的最佳版本组合运行。
        report.severity = 'warning'
        report.reason = `版本不匹配（声明 ${range}，实际 ${installedVersion}）；可能仍可运行`
      } else if (target.status === STATUS.PENDING) {
        report.status = STATUS.PENDING
        report.reason = '加载中'
      }
      return report
    })
  }

  /** 某个插件的全部依赖（必须依赖在前，可选依赖在后） */
  dependencyReport(recordOrId) {
    const record = typeof recordOrId === 'string' ? this.records.get(recordOrId) : recordOrId
    if (!record) return []
    return [
      ...this.dependencyReportFor(record, DEPENDENCY_KIND.REQUIRED),
      ...this.dependencyReportFor(record, DEPENDENCY_KIND.OPTIONAL),
    ]
  }

  /** 依赖健康度：error=有必须依赖不可用 / warning=有可选依赖提示 / ok=全部满足 */
  dependencyHealth(recordOrId) {
    const report = this.dependencyReport(recordOrId)
    if (report.some(item => item.required && item.severity === 'error')) return 'error'
    if (report.some(item => item.severity === 'warning')) return 'warning'
    return 'ok'
  }

  missingDeps(record) {
    const missing = [...this.dependsIssues(record)]
    for (const name of record.inject || []) {
      if (name === 'app') continue
      if ((record.optionalInject || []).includes(name)) continue
      if (!this.services.has(name)) missing.push(`服务:${name}`)
    }
    return [...new Set(missing)]
  }

  async startOne(record) {
    if (record.status !== STATUS.ACTIVE || record.started) return
    try {
      if (typeof record.module.start === 'function') await record.module.start(record.compatCtx, record.config)
      record.started = true
      this.emit('plugin:started', { id: record.id, manifest: record.manifest })
    } catch (err) {
      record.status = STATUS.ERROR
      record.error = err
      record.reason = 'start() 执行失败：' + err.message
      this.emit('plugin:error', { id: record.id, error: err, phase: 'start' })
    }
  }

  async stopOne(record) {
    if (!record.started) return
    try {
      if (typeof record.module.stop === 'function') await record.module.stop(record.compatCtx, record.config)
    } catch (err) {
      this.emit('plugin:error', { id: record.id, error: err, phase: 'stop' })
    }
    record.started = false
  }

  /* ================= 运行期启停 ================= */

  async enable(id, { reason = '' } = {}) {
    const record = this.records.get(id)
    if (!record) return false
    if (this.enabling.has(id)) return false
    this.enabling.add(id)
    try {
      // 先把必须依赖拉起：依赖被禁用时只启用当前插件是无效的，
      // 用户看到的就会是“装上了但功能没生效，得重启”。
      for (const dep of Object.keys(record.manifest.depends || {})) {
        const depRecord = this.records.get(dep)
        if (!depRecord) continue
        if (depRecord.status !== STATUS.ACTIVE) {
          const ok = await this.enable(dep, { reason: reason || `依赖链：${id} 需要 ${dep}` })
          if (!ok) {
            record.status = STATUS.INACTIVE
            record.reason = `依赖不满足：${dep} 未能启用`
            this.emit('plugin:inactive', { id: record.id, reason: record.reason, missing: [dep] })
            return false
          }
        }
      }

      this.disabledIds.delete(id)
      this.enabledIds.add(id)
      record.manifest.removed = false
      if (record.status === STATUS.ACTIVE) return true

      await this.disposeRecord(record)
      // 上次运行期发现文件变化 / 外部插件刚重装：强制换 URL 重新 import，避免拿到旧模块。
      if (record.reloadPending) record.module = null
      record.status = STATUS.PENDING
      record.error = null
      record.reason = ''
      record.disabledRoot = null
      record.started = false

      if (!record.module) {
        await this.importRecord(record, { force: record.reloadPending })
        record.reloadPending = false
      }
      if (record.status === STATUS.ERROR) {
        this.emit('plugin:enabled', { id })
        return false
      }

      const compatibilityIssues = this.compatibilityIssues(record)
      if (compatibilityIssues.length) {
        record.status = STATUS.INACTIVE
        record.reason = `不兼容：${compatibilityIssues.join('、')}`
        this.emit('plugin:inactive', { id: record.id, reason: record.reason, missing: compatibilityIssues })
        this.emit('plugin:enabled', { id })
        return false
      }
      const depIssues = this.hardDependsIssues(record)
      if (depIssues.length) {
        record.status = STATUS.INACTIVE
        record.reason = `依赖不满足：${depIssues.join('、')}`
        this.emit('plugin:inactive', { id: record.id, reason: record.reason, missing: depIssues })
        this.emit('plugin:enabled', { id })
        return false
      }
      await this.activate(record)
      await this.settle(1500)
      this.reclassify()
      if (record.status === STATUS.ACTIVE) await this.startOne(record)
      this.detectSemanticConflicts()
      this.emit('plugin:enabled', { id, reason })

      // 之前因为“依赖被停用”而自动停掉的插件，上游恢复后一起恢复。
      for (const dependent of [...this.records.values()]) {
        if (dependent.disabledRoot !== id || dependent.status !== STATUS.DISABLED) continue
        dependent.disabledRoot = null
        await this.enable(dependent.id, { reason: `上游插件 ${id} 已恢复` })
      }
      return record.status === STATUS.ACTIVE
    } finally {
      this.enabling.delete(id)
    }
  }

  async disable(id, { reason = '' } = {}) {
    const record = this.records.get(id)
    if (!record || record.manifest.core) return false
    await this.disableTree(record, { reason: reason || '用户禁用', markDisabled: true, rootId: id })
    this.detectSemanticConflicts()
    return true
  }

  /**
   * 递归停用一个插件及其活跃依赖者。
   * markDisabled=false 用于级联停用：依赖者的用户偏好仍是“启用”，
   * 上游恢复后 enable() 会按 disabledRoot 把它们一起拉回来。
   */
  async disableTree(record, { reason = '', markDisabled = false, rootId = null, cascade = true } = {}) {
    if (!record) return
    const root = rootId || record.id
    if (cascade) {
      for (const dependent of this.dependentsOf(record.id)) {
        if (dependent.manifest.core) continue
        if (dependent.status === STATUS.DISABLED && !dependent.fiber) continue
        dependent.disabledRoot = root
        await this.disableTree(dependent, {
          reason: `依赖 ${record.id} 已停用`,
          markDisabled: false,
          rootId: root,
          cascade: true,
        })
      }
    }
    await this.disposeRecord(record)
    record.status = STATUS.DISABLED
    record.reason = reason
    record.disabledRoot = markDisabled ? null : root
    if (markDisabled) {
      this.disabledIds.add(record.id)
      this.enabledIds.delete(record.id)
    }
    this.emit('plugin:disabled', { id: record.id, reason, cascadedBy: markDisabled ? undefined : root })
  }

  async toggle(id) {
    const record = this.records.get(id)
    if (!record) return false
    return record.status === STATUS.ACTIVE ? this.disable(id) : this.enable(id)
  }

  /* ================= 查询 / 依赖图 ================= */

  get(id) {
    return this.records.get(id)
  }

  get activeCount() {
    return [...this.records.values()].filter(r => r.status === STATUS.ACTIVE).length
  }

  list() {
    return [...this.records.values()].map(record => {
      const dependencies = this.dependencyReport(record)
      const dependencyIssues = dependencies.filter(item => item.status !== 'ok' && item.status !== 'pending')
      return {
        id: record.id,
        dir: record.dir,
        path: record.path,
        status: record.status,
        reason: record.reason,
        legacy: !!record.manifest.legacy,
        legacyReason: record.manifest.legacyReason || '',
        compatibilityIssues: this.compatibilityIssues(record),
        error: record.error ? String(record.error.message || record.error) : null,
        conflict: !!record.conflict,
        started: record.started,
        dynamic: !!record.dynamic,
        warnings: record.warnings,
        fiberState: record.fiber?.state ?? null,
        dependencies,
        dependencyIssues,
        dependencyHealth:
          dependencyIssues.some(item => item.required && item.severity === 'error')
            ? 'error'
            : dependencies.some(item => item.severity === 'warning')
              ? 'warning'
              : 'ok',
        manifest: record.manifest,
      }
    })
  }

  /**
   * 自检：验证"插件是否真的在正常工作"。
   *  - 声明 provide 的服务是否真的注册了
   *  - 声明使用的插槽是否真的挂载了内容
   *  - 失败 / 冲突 / 未激活的插件汇总为 issue
   */
  selfCheck() {
    const issues = []
    const push = (id, severity, message, detail = '') => issues.push({ id, severity, message, detail, at: Date.now() })

    for (const record of this.records.values()) {
      const id = record.id

      // 结构化依赖报告：必须依赖异常标红，可选依赖异常标黄。
      // 插件自身已禁用/卸载时，不把“依赖也无人启用”当成错误，避免产生噪音。
      const dependencyReport =
        record.status === STATUS.DISABLED || record.manifest.removed ? [] : this.dependencyReport(record)
      for (const item of dependencyReport) {
        if (item.status === 'ok' || item.status === 'pending') continue
        const required = item.required

        // 必须依赖版本不匹配按错误处理，未升级的旧插件不会再只标黄；可选依赖仍只提示。
        if (item.status === 'version-mismatch') {
          push(
            id,
            'warning',
            `${required ? '依赖版本不匹配' : '可选依赖版本不匹配'}：${item.name}@${item.range}（实际 ${item.installedVersion}）`,
            '已继续加载，但没有按声明的最佳版本组合运行；建议在「设置 → 插件」里升级 / 降级依赖插件到声明范围',
          )
          continue
        }

        const unavailable =
          item.status === 'missing'
            ? '未安装'
            : item.status === 'error'
              ? '加载失败'
              : item.status === 'inactive'
                ? '未激活'
                : item.status === 'disabled'
                  ? '已被禁用'
                  : item.status === 'removed'
                    ? '已卸载'
                    : item.status || '不可用'
        if (required) {
          push(
            id,
            'error',
            `缺少依赖：${item.name}@${item.range}（${unavailable}）`,
            '检查依赖插件是否安装、启用或加载成功，或依赖版本是否满足声明范围',
          )
        } else {
          const label = item.status === 'missing' ? '缺少可选依赖' : '可选依赖不可用'
          push(
            id,
            'warning',
            `${label}：${item.name}@${item.range}（${unavailable}）`,
            '缺少可选依赖不影响本插件基础功能，只影响依赖它扩展的能力',
          )
        }
      }

      if (record.status === STATUS.ERROR) {
        push(id, 'error', `加载/运行失败：${record.reason || '未知错误'}`, record.error?.stack || '')
      }
      if (record.conflict || (record.reason || '').includes('已被插件')) {
        push(id, 'error', `服务冲突：${record.reason}`, '另一个插件已经注册了同名 singleton 服务')
      }
      if (record.status === STATUS.INACTIVE) {
        const compatibilityIssues = this.compatibilityIssues(record)
        if (compatibilityIssues.length) {
          push(id, 'error', compatibilityIssues.join('、'), '请把外部插件升级到当前内核主版本对应的 2.x 版本')
        } else {
          const hasHardDependencyIssue = dependencyReport.some(
            item => item.required && item.status !== 'ok' && item.status !== 'pending',
          )
          if (!hasHardDependencyIssue) {
            const missing = this.missingDeps(record)
            push(
              id,
              'error',
              `缺少依赖：${missing.join('、') || record.reason || '依赖未就绪'}`,
              '检查依赖插件是否安装、启用或加载成功，或服务注入名是否正确',
            )
          }
        }
      }
      if (record.status !== STATUS.ACTIVE) continue

      // 声明提供但没注册
      for (const item of record.manifest.provides || []) {
        const name = typeof item === 'string' ? item : item.name
        if (!name) continue
        if (!this.services.has(name)) {
          push(id, 'warning', `声明提供「${name}」，但运行时没有注册该服务`, '检查 provide 是否被条件分支跳过')
        }
      }

      // 声明使用插槽但没有挂载内容
      const slotsService = this.services.get('slots')?.value
      for (const slotId of record.manifest.slots || []) {
        const slot = slotsService?.find?.(slotId)
        if (!slot) continue
        const owned = (slot.entries || []).some(e => e.owner === `plugin:${id}`)
        if (!owned) push(id, 'warning', `声明使用插槽「${slotId}」，但没有挂载内容`, '检查 slots.register 是否执行')
      }

      // 语义冲突提示（多监听者 / 多实现 / 插槽拥挤）
      for (const warning of record.warnings || []) {
        push(id, warning.severity || 'info', warning.message, '语义冲突提示，通常不阻塞运行')
      }
    }

    // 重复 id / 服务归属异常
    for (const [name, owner] of this.serviceOwners) {
      if (owner === 'kernel') continue
      const record = this.records.get(owner.replace(/^plugin:/, ''))
      if (!record || record.status !== STATUS.ACTIVE) {
        push(owner.replace(/^plugin:/, ''), 'error', `服务「${name}」仍被未激活的插件占用`, '可能存在未正确释放的服务')
      }
    }

    this.selfCheckIssues = issues
    return issues
  }

  orderedRecords() {
    return this.graph()
      .order.map(id => this.records.get(id))
      .filter(Boolean)
  }

  /** 插件名 depends 的依赖图 + 拓扑排序 + 环检测；optionalDepends 单独返回，不参与硬加载顺序 */
  graph() {
    const ids = [...this.records.keys()]
    const edges = new Map(ids.map(id => [id, new Set()]))
    const optionalEdges = new Map(ids.map(id => [id, new Set()]))
    for (const [id, record] of this.records) {
      for (const dep of Object.keys(record.manifest.depends || {})) {
        if (this.records.has(dep)) edges.get(id).add(dep)
      }
      for (const dep of Object.keys(record.manifest.optionalDepends || {})) {
        if (this.records.has(dep)) optionalEdges.get(id).add(dep)
      }
    }
    const order = []
    const state = new Map()
    const cycleIds = new Set()
    let cycle = []
    const visit = (id, stack) => {
      const s = state.get(id)
      if (s === 2) return true
      if (s === 1) {
        cycle = stack.slice(stack.indexOf(id)).concat(id)
        cycle.forEach(x => cycleIds.add(x))
        return false
      }
      state.set(id, 1)
      stack.push(id)
      let ok = true
      for (const dep of edges.get(id) || []) ok = visit(dep, stack) && ok
      stack.pop()
      state.set(id, 2)
      if (ok) order.push(id)
      return ok
    }
    for (const id of ids) visit(id, [])
    return { order, edges, optionalEdges, cycleIds, cycle }
  }

  /* ================= 第 2 层：语义冲突启发式 ================= */

  detectSemanticConflicts() {
    this.warnings = []
    // 每次都从干净状态重算，避免热同步 / 反复 selfCheck 后同一条提示叠很多行。
    for (const record of this.records.values()) record.warnings = []
    const warn = (record, message, severity = 'info') => {
      if (!record) return
      if (record.warnings.some(item => item.message === message)) return
      record.warnings.push({ message, severity })
      this.warnings.push({ id: record.id, message, severity })
      this.emit('plugin:warning', { id: record.id, message, severity })
    }

    // 多个插件挂同一个 UI 插槽是设计允许的行为（例如 rail:bottom 同时放设置与搜索），
    // 不再产出“可能拥挤”这类噪音提示。

    for (const record of this.records.values()) {
      if (record.status !== STATUS.ACTIVE) continue
      const declared = record.manifest.provides || []
      for (const item of declared) {
        const name = typeof item === 'string' ? item : item.name
        const type = typeof item === 'string' ? 'singleton' : item.type || 'singleton'
        if (type !== 'selectable') continue
        const service = this.services.get(name)?.value
        if (service?.list) {
          const impls = service.list()
          if (impls.length > 1) warn(record, `可选中服务「${name}」有 ${impls.length} 个实现，可在设置中切换`)
        }
      }
    }

    for (const [event, records] of this.eventIndex) {
      const owners = [...new Set([...records].map(r => r.owner))]
      if (owners.length >= 2 && event.endsWith(':send')) {
        for (const owner of owners) {
          warn(this.records.get(owner), `事件「${event}」有 ${owners.length} 个监听者，执行顺序可能影响结果`, 'warning')
        }
      }
    }
    return this.warnings
  }
}

/* ================= 工具 ================= */

/**
 * 依赖声明统一成 { 插件名: semver范围 }：
 * - { name: '^1.0.0' }
 * - [name, name2]（等价于不做版本约束）
 * - 'name'
 */
function normalizeDepends(value) {
  if (!value) return {}
  if (Array.isArray(value)) {
    return Object.fromEntries(value.map(item => [String(item || '').trim(), '']).filter(([name]) => name))
  }
  if (typeof value === 'string') {
    const name = value.trim()
    return name ? { [name]: '' } : {}
  }
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .map(([name, range]) => [String(name || '').trim(), String(range || '').trim()])
        .filter(([name]) => name),
    )
  }
  return {}
}

function collectManifest(mod, entry) {
  const apply = pickApply(mod)
  return {
    name: mod.name || entry.id || entry.dir || 'unknown',
    version: mod.version || entry.version || '0.0.0',
    legacy: entry.legacy !== undefined ? !!entry.legacy : false,
    legacyReason: entry.legacyReason || '',
    displayName: mod.displayName || mod.name || entry.id,
    description: mod.description || entry.description || '',
    author: mod.author || entry.author || '',
    icon: mod.icon || entry.icon || '',
    unavailable: mod.unavailable !== undefined ? !!mod.unavailable : !!entry.unavailable,
    unavailableReason: mod.unavailableReason || entry.unavailableReason || '',
    core: mod.core !== undefined ? !!mod.core : !!entry.core,
    enabled: mod.enabled !== undefined ? !!mod.enabled : entry.enabled !== false,
    depends: normalizeDepends(mod.depends || entry.depends),
    optionalDepends: normalizeDepends(mod.optionalDepends || mod.softDepends || entry.optionalDepends || entry.softDepends),
    inject: mod.inject !== undefined ? mod.inject : collectEntryInject(entry.inject),
    provides: mod.provides !== undefined ? mod.provides : entry.provides || [],
    permissions: mod.permissions !== undefined ? mod.permissions : entry.permissions || [],
    slots: mod.slots !== undefined ? mod.slots : entry.slots || [],
    external: !!entry.external,
    source: entry.source || (entry.external ? 'external' : 'builtin'),
    hasApply: !!apply,
  }
}

function collectInject(mod) {
  const inject = mod.inject
  if (!inject) return []
  if (Array.isArray(inject)) return inject
  if (typeof inject === 'string') return [inject]
  if (typeof inject === 'object') return Object.keys(inject)
  return []
}

/** /api/plugins 清单里的 inject 可能是数组、字符串或对象（cordis 原生写法）。 */
function collectEntryInject(inject) {
  if (!inject) return []
  if (Array.isArray(inject)) return inject
  if (typeof inject === 'string') return [inject]
  if (typeof inject === 'object') return Object.keys(inject)
  return []
}

function pickApply(mod) {
  if (!mod) return null
  if (typeof mod === 'function') return mod
  if (typeof mod.apply === 'function') return mod.apply
  if (mod.default) {
    if (typeof mod.default === 'function') return mod.default
    if (typeof mod.default.apply === 'function') return mod.default.apply
  }
  return null
}

export { ConflictError }
