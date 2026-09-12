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

export const VERSION = '1.0.0'

export const STATUS = {
  PENDING: 'pending',
  ACTIVE: 'active',
  INACTIVE: 'inactive',
  DISABLED: 'disabled',
  ERROR: 'error',
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
  }

  onServiceProvided(cb) {
    this.serviceWaiters.add(cb)
    return () => this.serviceWaiters.delete(cb)
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

  async loadAll(entries = [], { disabled = [], enabled = [], removed = [] } = {}) {
    this.disabledIds = new Set(disabled)
    this.enabledIds = new Set(enabled)
    this.removedIds = new Set(removed)

    for (const entry of entries) {
      if (!entry?.path) continue
      const record = {
        id: entry.id || entry.dir || entry.path,
        path: entry.path,
        dir: entry.dir || '',
        external: !!entry.external,
        source: entry.source || (entry.external ? 'external' : 'builtin'),
        status: STATUS.PENDING,
        error: null,
        reason: '',
        warnings: [],
        started: false,
        dynamic: false,
        fiber: null,
        fiberPromise: null,
        compatCtx: null,
        inject: [],
        module: null,
        manifest: {
          name: entry.id,
          version: entry.version || '0.0.0',
          displayName: entry.displayName || entry.id,
          description: entry.description || '',
          author: entry.author || '',
          core: !!entry.core,
          enabled: entry.enabled !== false,
          icon: entry.icon || '',
          depends: entry.depends || {},
          optionalDepends: normalizeDepends(entry.optionalDepends || entry.softDepends),
          provides: entry.provides || [],
          slots: [],
        },
      }
      try {
        const mod = await import(new URL(entry.path, this.baseUrl).href)
        record.module = mod
        record.manifest = collectManifest(mod, entry)
        record.id = record.manifest.name
      } catch (err) {
        record.status = STATUS.ERROR
        record.error = err
        record.reason = '模块导入失败：' + err.message
      }
      if (this.removedIds.has(record.id)) record.manifest.removed = true
      this.records.set(record.id, record)
    }

    // 依赖图（插件名 depends）
    const graph = this.graph()
    for (const id of graph.cycleIds) {
      const record = this.records.get(id)
      if (record) {
        record.status = STATUS.INACTIVE
        record.reason = `循环依赖：${graph.cycle.join(' → ')}`
      }
    }

    // 默认关闭 / 用户禁用
    for (const record of this.records.values()) {
      if (record.status !== STATUS.PENDING) continue
      const defaultOff = record.manifest.enabled === false && !this.enabledIds.has(record.id)
      if (this.disabledIds.has(record.id) || record.manifest.removed || defaultOff) {
        record.status = STATUS.DISABLED
        record.reason = defaultOff ? '默认未启用（可在插件管理中开启）' : '已被用户禁用'
      }
    }

    // 按依赖顺序逐个交给 cordis；
    // 只有依赖插件缺失 / 加载失败 / 未激活时阻止加载；版本不匹配仅标记警告，
    // 因为服务注入本身已经提供了运行时兼容性判断，避免历史版本号声明误伤核心插件。
    for (const record of this.orderedRecords()) {
      if (record.status !== STATUS.PENDING) continue
      const hardIssues = this.hardDependsIssues(record)
      if (hardIssues.length) {
        record.status = STATUS.INACTIVE
        record.reason = `依赖不满足：${hardIssues.join('、')}`
        this.emit('plugin:inactive', { id: record.id, reason: record.reason, missing: hardIssues })
        continue
      }
      this.activate(record)
    }

    await this.settle(2500)
    this.reclassify()

    // start() 钩子
    for (const record of this.orderedRecords()) {
      if (record.status !== STATUS.ACTIVE || record.started) continue
      await this.startOne(record)
    }

    this.detectSemanticConflicts()
    this.emit('plugins:ready', { count: this.activeCount, total: this.records.size })
    return this
  }

  /** 把单个插件交给 cordis（inject 不满足时会保持 pending，由 cordis 在服务出现后自动激活） */
  async activate(record) {
    const mod = record.module
    const apply = pickApply(mod)
    if (!apply) {
      record.status = STATUS.ERROR
      record.reason = '插件没有导出 apply(ctx)'
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
        const err = record.error || record.fiberError
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
      if (record.status === STATUS.DISABLED || record.status === STATUS.ERROR) continue
      for (const item of record.manifest?.provides || []) {
        const provided = typeof item === 'string' ? item : item?.name
        if (provided === name) return true
      }
    }
    return false
  }

  /** 检查一组插件名依赖（不含 cordis inject 服务），用于加载前的版本/依赖判定 */
  dependsIssuesFor(record, dependencies = {}) {
    const missing = []
    for (const [dep, range] of Object.entries(dependencies || {})) {
      const target = this.records.get(dep)
      if (!target) missing.push(`${dep}${range ? '@' + range : ''}`)
      else if (range && !satisfies(target.manifest.version, range)) missing.push(`${dep}@${range}(实际 ${target.manifest.version})`)
      else if (target.status === STATUS.ERROR) missing.push(`${dep}(加载失败)`)
      else if (target.status === STATUS.INACTIVE || target.status === STATUS.DISABLED) missing.push(`${dep}(未激活)`)
    }
    return [...new Set(missing)]
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

  /** 硬依赖问题：缺失 / 加载失败 / 未激活；版本不匹配只做警告，不阻塞加载 */
  hardDependsIssues(record) {
    return this.dependsIssues(record).filter(item => !/实际|版本不匹配/.test(String(item)))
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

  async enable(id) {
    const record = this.records.get(id)
    if (!record) return false
    this.disabledIds.delete(id)
    this.enabledIds.add(id)
    record.manifest.removed = false
    if (record.status === STATUS.ACTIVE) return true

    if (record.fiber) {
      await record.fiber.dispose().catch(() => {})
      record.fiber = null
      record.fiberPromise = null
    }
    record.status = STATUS.PENDING
    record.error = null
    record.reason = ''
    record.started = false
    const depIssues = this.hardDependsIssues(record)
    if (depIssues.length) {
      record.status = STATUS.INACTIVE
      record.reason = `依赖不满足：${depIssues.join('、')}`
      this.emit('plugin:inactive', { id: record.id, reason: record.reason, missing: depIssues })
      this.emit('plugin:enabled', { id })
      return false
    }
    this.activate(record)
    await this.settle(1500)
    this.reclassify()
    if (record.status === STATUS.ACTIVE) await this.startOne(record)
    this.emit('plugin:enabled', { id })
    return record.status === STATUS.ACTIVE
  }

  async disable(id) {
    const record = this.records.get(id)
    if (!record || record.manifest.core) return false
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
    record.status = STATUS.DISABLED
    this.disabledIds.add(id)
    this.emit('plugin:disabled', { id })
    return true
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
    return [...this.records.values()].map(record => ({
      id: record.id,
      dir: record.dir,
      path: record.path,
      status: record.status,
      reason: record.reason,
      error: record.error ? String(record.error.message || record.error) : null,
      conflict: !!record.conflict,
      started: record.started,
      dynamic: !!record.dynamic,
      warnings: record.warnings,
      fiberState: record.fiber?.state ?? null,
      manifest: record.manifest,
    }))
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

      // 依赖版本不匹配：不阻塞加载，但明确标黄提示，避免协议悄悄漂移。
      for (const item of this.dependsIssues(record)) {
        if (/实际/.test(String(item))) {
          push(
            id,
            'warning',
            `依赖版本不匹配：${item}`,
            '请在「设置 → 插件」中升级 / 降级依赖插件到声明范围内',
          )
        }
      }

      // 可选依赖只影响扩展能力，缺失 / 未启用 / 版本不匹配统一标黄，不阻止插件运行。
      for (const item of this.optionalDependsIssues(record)) {
        if (/实际/.test(String(item))) {
          push(
            id,
            'warning',
            `可选依赖版本不匹配：${item}`,
            '可选依赖已安装但版本不同，相关扩展能力可能不可用；升级 / 降级后会自动恢复',
          )
        } else if (/\(未激活\)|\(加载失败\)/.test(String(item))) {
          push(
            id,
            'warning',
            `可选依赖不可用：${item}`,
            '可选依赖存在但未启用 / 加载失败；本插件仍可运行，相关扩展能力暂不可用',
          )
        } else {
          push(
            id,
            'warning',
            `缺少可选依赖：${item}`,
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
        const hard = this.hardDependsIssues(record)
        const versionOnly = !hard.length && /实际|版本/.test(record.reason || '')
        if (!versionOnly) {
          const detail = hard.length ? hard.join('、') : record.reason || '依赖未就绪'
          push(
            id,
            'error',
            `缺少依赖：${detail}`,
            '检查依赖插件是否安装、启用或加载成功，或依赖版本是否满足声明范围',
          )
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
    const warn = (record, message, severity = 'info') => {
      if (!record) return
      record.warnings = record.warnings || []
      record.warnings.push({ message, severity })
      this.warnings.push({ id: record.id, message, severity })
      this.emit('plugin:warning', { id: record.id, message, severity })
    }

    const slots = this.services.get('slots')?.value
    if (slots?.listSlots) {
      for (const slot of slots.listSlots()) {
        const owners = [...new Set((slot.entries || []).map(e => e.owner).filter(Boolean))]
        if (owners.length >= 2 && !slot.meta?.silent) {
          for (const owner of owners) {
            warn(this.records.get(String(owner).replace(/^plugin:/, '')), `插槽「${slot.id}」已有 ${owners.length} 个插件挂载内容，可能拥挤`)
          }
        }
      }
    }

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
    inject: mod.inject || [],
    provides: mod.provides || entry.provides || [],
    permissions: mod.permissions || entry.permissions || [],
    slots: mod.slots || [],
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
