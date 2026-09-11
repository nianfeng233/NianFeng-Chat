/**
 * 兼容层：让风语插件可以使用一套简洁稳定的 ctx API，
 * 而底层完全运行在真实的 cordis Context 上。
 *
 * 插件拿到的 `ctx` 是一个以 cordis 的 fiber Context 为原型的对象：
 *   - 未覆盖的属性/方法直接走 cordis（ctx.effect / ctx.on / ctx.emit / ctx.extend ...）
 *   - 覆盖的部分提供风语的约定：
 *       inject(deps[, cb])   无需回调也能取值（cordis 只支持回调形式）
 *       provide(name, value, meta)  带 owner / 类型记录的冲突检测
 *       emit(name, payload, {interceptor, onIntercept})
 *       on/once/off          回调统一为 (payload, {event, plugin})，并带错误兜底
 *       registry / events    面向插件管理器的只读视图
 *       logger               带插件名的 cordis logger
 *       setTimeout/setInterval  随插件卸载自动清理
 */
import { ConflictError } from './errors.mjs'

export function toCamel(name) {
  return String(name).replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase())
}

function normalizeDeps(deps) {
  let list = []
  if (typeof deps === 'string') list = [deps]
  else if (Array.isArray(deps)) list = deps
  else if (deps && typeof deps === 'object') list = Object.keys(deps)
  return list
    .filter(Boolean)
    .map(raw => {
      const name = String(raw)
      const optional = name.endsWith('?')
      return { name: optional ? name.slice(0, -1) : name, optional }
    })
}

export function createCompat(app, ctx, { id, meta = {} } = {}) {
  const owner = id || ctx.fiber?.name || 'anonymous'

  const lifecycleFacades = new Map()

  /** 把注册型服务返回的 disposer 绑定到当前插件 fiber，插件卸载时自动清理。 */
  const bindDisposable = dispose => {
    if (typeof dispose !== 'function') return dispose
    try {
      ctx.effect(() => dispose)
    } catch (_) {
      /* fiber 已经卸载时忽略 */
    }
    return dispose
  }

  /**
   * 一部分服务（事件总线 / 插槽 / 设置页 / 视图路由 / 搜索源）的方法是
   * “注册 + 返回清理函数”的形态。如果调用方忘了手动 ctx.effect，
   * 插件卸载后注册会残留，重新启用时就会出现重复挂载或“再点没反应”。
   * 这里在 inject 出口做统一 lifecycle 绑定，提供方插件不必感知调用者。
   */
  function createLifecycleFacade(name, service) {
    if (!service || typeof service !== 'object') return service
    if (lifecycleFacades.has(name)) return lifecycleFacades.get(name)

    let facade = service
    if (name === 'event-bus') {
      facade = new Proxy(service, {
        get(target, prop) {
          if (prop === 'on') return (event, listener, options) => overrides.on(event, listener, options)
          if (prop === 'once') return (event, listener, options) => overrides.once(event, listener, options)
          if (prop === 'off') return (event, listener) => overrides.off(event, listener)
          if (prop === 'emit') return (event, payload, options) => overrides.emit(event, payload, options)
          if (prop === 'intercept') {
            return (event, payload, onIntercept) =>
              overrides.emit(event, payload, { interceptor: true, onIntercept, owner: overrides.id })
          }
          const value = Reflect.get(target, prop, target)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
    } else if (name === 'slots') {
      facade = new Proxy(service, {
        get(target, prop) {
          if (prop === 'register') {
            return (slotId, mount, slotMeta = {}) =>
              bindDisposable(
                target.register(slotId, mount, {
                  owner: overrides.id,
                  ctx: overrides,
                  ...slotMeta,
                }),
              )
          }
          if (prop === 'define') {
            return (slotId, slotMeta = {}) =>
              bindDisposable(target.define(slotId, { owner: overrides.id, ...slotMeta }))
          }
          const value = Reflect.get(target, prop, target)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
    } else if (name === 'settings-container') {
      facade = new Proxy(service, {
        get(target, prop) {
          if (prop === 'register') return page => bindDisposable(target.register(page))
          const value = Reflect.get(target, prop, target)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
    } else if (name === 'view-router') {
      facade = new Proxy(service, {
        get(target, prop) {
          if (prop === 'register') return (viewId, definition = {}) => bindDisposable(target.register(viewId, definition))
          const value = Reflect.get(target, prop, target)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
    } else if (name === 'search-service') {
      facade = new Proxy(service, {
        get(target, prop) {
          if (prop === 'registerProvider') return (providerId, fn) => bindDisposable(target.registerProvider(providerId, fn))
          const value = Reflect.get(target, prop, target)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
    } else if (name === 'keyboard-shortcuts') {
      facade = new Proxy(service, {
        get(target, prop) {
          if (prop === 'register') return (...args) => bindDisposable(target.register(...args))
          const value = Reflect.get(target, prop, target)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
    } else if (name === 'channel-base') {
      facade = new Proxy(service, {
        get(target, prop) {
          if (prop === 'defineChannel') {
            return definition => {
              const result = target.defineChannel(definition)
              if (result && typeof result.dispose === 'function') bindDisposable(result.dispose)
              return result
            }
          }
          const value = Reflect.get(target, prop, target)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
    } else if (name === 'model-registry') {
      facade = new Proxy(service, {
        get(target, prop) {
          if (prop === 'registerProvider') {
            return (providerId, provider) => bindDisposable(target.registerProvider(providerId, provider))
          }
          const value = Reflect.get(target, prop, target)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
    }

    lifecycleFacades.set(name, facade)
    return facade
  }

  const overrides = {
    /* -------------------- 元信息 -------------------- */
    id: `plugin:${owner}`,
    meta: { plugin: meta.plugin || meta, ...meta },

    /* -------------------- 服务 -------------------- */
    provide(name, value, serviceMeta = {}) {
      const existOwner = app.serviceOwners.get(name)
      if (existOwner && existOwner !== overrides.id) {
        throw new ConflictError(`服务「${name}」已被插件「${existOwner}」占用`, {
          service: name,
          owner: overrides.id,
          existOwner,
        })
      }
      if (value === undefined) throw new Error(`provide("${name}") 需要一个实现对象`)
      ctx.provide(name, value) // cordis：自动随 fiber 释放，重复注册会抛错
      const record = {
        name,
        type: serviceMeta.type || 'singleton',
        owner: overrides.id,
        ownerLabel: owner,
        meta: serviceMeta,
        value,
      }
      app.services.set(name, record)
      app.serviceOwners.set(name, overrides.id)
      ctx.effect(
        () => () => {
          if (app.services.get(name) === record) app.services.delete(name)
          if (app.serviceOwners.get(name) === overrides.id) app.serviceOwners.delete(name)
        },
      )
      app.emitServiceProvided(name, record)
      return () => {
        app.services.delete(name)
        app.serviceOwners.delete(name)
      }
    },

    inject(deps, callback) {
      const list = normalizeDeps(deps)

      const read = dep => {
        let value
        if (dep.name === 'app') value = app.publicApi()
        else {
          try {
            value = ctx.get(dep.name)
          } catch (_) {
            value = undefined
          }
        }
        if (value === undefined) return value
        // 插件权限中心可在服务访问层返回受限代理（真实拦截 api / storage / notification）
        let resolved = value
        try {
          resolved = app.applyServiceGuard?.(overrides.meta?.plugin || { id: owner }, dep.name, value) ?? value
        } catch (_) {
          resolved = value
        }
        return createLifecycleFacade(dep.name, resolved)
      }

      if (typeof callback !== 'function') {
        const values = {}
        for (const dep of list) values[toCamel(dep.name)] = read(dep)
        if (typeof deps === 'string') return values[toCamel(list[0]?.name || deps)]
        return values
      }

      const run = () => {
        const services = {}
        for (const dep of list) services[toCamel(dep.name)] = read(dep)
        const fork = ctx.extend ? createCompat(app, ctx.extend(), { id: `${owner}:inject`, meta: overrides.meta }) : overrides
        return callback(fork, services)
      }

      const missing = list.filter(dep => !dep.optional && read(dep) === undefined)
      if (!missing.length) return run()

      app.loggerFor(owner).debug(`等待服务：${missing.map(d => d.name).join(', ')}`)
      const off = app.onServiceProvided(name => {
        if (missing.some(d => d.name === name)) return
        off()
        try {
          run()
        } catch (err) {
          app.reportError(err, { plugin: overrides.id, event: 'inject' })
        }
      })
      return null
    },

    /* -------------------- 事件 -------------------- */
    emit(name, payload, options = {}) {
      return app.emitCompat(ctx, name, payload, options)
    },
    on(name, listener, options = {}) {
      return app.onCompat(ctx, name, listener, options, overrides.id)
    },
    once(name, listener, options = {}) {
      return app.onCompat(ctx, name, listener, { ...options, once: true }, overrides.id)
    },
    off(name, listener) {
      return app.offCompat(name, listener)
    },

    /* -------------------- 生命周期 -------------------- */
    /**
     * 风语语义：ctx.effect(fn) 表示"把 fn 注册为卸载时的清理函数"。
     * cordis 原生语义是 effect(execute)：立即执行 execute 并注册其返回值。
     * 这里统一成风语语义，并包一层错误兜底。
     */
    effect(fn) {
      if (typeof fn !== 'function') return () => {}
      return ctx.effect(() => () => {
        try {
          fn()
        } catch (err) {
          app.reportError(err, { plugin: overrides.id, event: 'effect' })
        }
      })
    },

    /* -------------------- 定时器 -------------------- */
    setTimeout(fn, ms, ...args) {
      const timer = setTimeout(() => fn(...args), ms)
      ctx.effect(() => () => clearTimeout(timer))
      return timer
    },
    setInterval(fn, ms, ...args) {
      const timer = setInterval(() => fn(...args), ms)
      ctx.effect(() => () => clearInterval(timer))
      return timer
    },
    clearTimeout(timer) {
      clearTimeout(timer)
    },
    clearInterval(timer) {
      clearInterval(timer)
    },

    /* -------------------- 只读视图 -------------------- */
    get registry() {
      return {
        get: name => readService(ctx, name),
        has: name => app.hasService(name) || safeGet(ctx, name) !== undefined,
        ownerOf: name => app.serviceOwners.get(name) ?? null,
        list: () => app.serviceList(),
        provide: (name, value, serviceMeta) => overrides.provide(name, value, serviceMeta),
        get size() {
          return app.serviceList().length
        },
      }
    },
    get events() {
      return app.eventsFacade
    },
    get logger() {
      return app.loggerFor(owner)
    },
    get app() {
      return app.publicApi()
    },
  }

  Object.defineProperty(overrides, 'slots', {
    get: () => createLifecycleFacade('slots', readService(ctx, 'slots')),
    enumerable: true,
  })
  Object.defineProperty(overrides, 'config', {
    get: () => readService(ctx, 'config'),
    enumerable: true,
  })

  return defineOverrides(Object.create(ctx), overrides)
}

/** 用 defineProperty 写入覆盖项：避免触发 cordis Proxy 原型链上的 set 陷阱 */
function defineOverrides(target, overrides) {
  for (const key of Reflect.ownKeys(overrides)) {
    Object.defineProperty(target, key, Object.getOwnPropertyDescriptor(overrides, key))
  }
  return target
}

function readService(ctx, name) {
  if (name === 'app') return ctx.app
  return safeGet(ctx, name)
}

function safeGet(ctx, name) {
  try {
    return ctx.get(name)
  } catch (_) {
    return undefined
  }
}
