/**
 * F? · permissions
 * 插件权限中心（对标 deepseek-harness 的 permission presets 思路）。
 *
 * 做法：
 *   - 插件可以在 manifest 里声明 `permissions: ['network', 'storage', ...]`
 *   - 用户设置「权限预设」：只读 / 标准 / 完全权限，也可以按插件单独放行 / 拒绝
 *   - 内核 compat 层在 `inject` 取服务时调用本服务的 guard：
 *       声明了权限且被拒绝的插件拿到的是受限代理，调用时给出明确错误
 *   - core 插件默认豁免（内核功能不能被权限中心掐断）
 *
 * 边界：这是「用户知情 + 服务访问拦截」，不是操作系统沙箱；
 * 真正的隔离需要独立插件进程，见「设置 → 未实现清单」。
 */
export const name = 'permissions'
export const version = '1.0.0'
export const displayName = '插件权限'
export const description = '基础服务 · 插件权限声明、预设与真实的服务访问拦截。'
export const author = '风语内核'
export const icon = '🛡️'
export const core = true
export const depends = { config: '^1.0.0', 'event-bus': '^1.0.0' }
export const inject = ['config', 'app', 'event-bus']
export const provides = [{ name: 'permissions', type: 'singleton' }]

const CAPABILITIES = {
  network: '访问本地后端 / 网络请求',
  storage: '读写本地存储',
  notify: '发送系统通知',
  'code-execution': '运行代码片段',
  secrets: '读取敏感配置（API Key 等）',
}

/** 服务名 -> 需要的权限；未列入的服务不做拦截 */
const SERVICE_CAPABILITIES = {
  api: 'network',
  storage: 'storage',
  notification: 'notify',
}

const PRESETS = {
  'read-only': {
    label: '只读',
    description: '插件只能做展示与通知，不能访问网络或写入本地数据。',
    allow: ['notify'],
  },
  standard: {
    label: '标准',
    description: '默认：允许模型/网络请求、本地读写与代码片段运行。',
    allow: ['notify', 'storage', 'network', 'code-execution'],
  },
  'full-access': {
    label: '完全权限',
    description: '允许所有已声明能力。只对你完全信任的插件使用。',
    allow: ['*'],
  },
}

export function apply(ctx) {
  const config = ctx.inject('config')
  const app = ctx.inject('app')
  const events = ctx.inject('event-bus')

  const preset = () => {
    const value = config.get('permissions.preset', 'standard')
    return PRESETS[value] ? value : 'standard'
  }

  const declared = id => {
    const manifest = app.manifestOf?.(id)
    const list = Array.isArray(manifest?.permissions) ? manifest.permissions : []
    return list.filter(cap => CAPABILITIES[cap])
  }

  const isGranted = (id, capability) => {
    const manifest = app.manifestOf?.(id)
    if (!manifest) return true
    if (manifest.core) return true
    const caps = Array.isArray(manifest.permissions) ? manifest.permissions : []
    if (!caps.includes(capability)) return true // 未声明的插件保持旧行为
    const grants = config.get('permissions.grants', {}) || {}
    if (Array.isArray(grants[id])) return grants[id].includes(capability)
    const allow = PRESETS[preset()]?.allow || []
    return allow.includes('*') || allow.includes(capability)
  }

  const setGrant = (id, capability, allowed) => {
    const grants = { ...(config.get('permissions.grants', {}) || {}) }
    // 没有 per-plugin grants 时，从「当前实际生效的集合」回填，
    // 避免在只读预设下打开某个权限时把其它未授予的声明权限一起放开。
    const current = new Set(
      Array.isArray(grants[id]) ? grants[id] : declared(id).filter(cap => isGranted(id, cap)),
    )
    if (allowed) current.add(capability)
    else current.delete(capability)
    grants[id] = [...current]
    config.set('permissions.grants', grants)
    events.emit('permissions:changed', { id, capability, allowed })
  }

  const setPreset = value => {
    if (!PRESETS[value]) return false
    config.set('permissions.preset', value)
    events.emit('permissions:changed', { preset: value })
    return true
  }

  const deniedError = (manifest, capability) => {
    const label = manifest?.displayName || manifest?.name || manifest?.id || '未知插件'
    const capLabel = CAPABILITIES[capability] || capability
    const err = new Error(`插件「${label}」没有「${capLabel}」权限。可在 设置 → 隐私 → 插件权限 中调整。`)
    err.code = 'PLUGIN_PERMISSION_DENIED'
    err.capability = capability
    err.plugin = manifest?.name || manifest?.id
    return err
  }

  const isManaged = (manifest, capability) =>
    !!manifest && !manifest.core && Array.isArray(manifest.permissions) && manifest.permissions.includes(capability)

  /**
   * 受管插件拿到的是「活代理」：每次方法调用都会重新查权限，
   * 因此在隐私页里改开关可以立即生效，不需要重载插件。
   */
  const liveGuard = (manifest, capability, value) => {
    const id = manifest.name || manifest.id
    if (typeof value === 'function') {
      return function guardedFunction(...args) {
        if (!isGranted(id, capability)) throw deniedError(manifest, capability)
        return value.apply(this, args)
      }
    }
    if (!value || typeof value !== 'object') return value
    return new Proxy(value, {
      get(target, prop, receiver) {
        const original = Reflect.get(target, prop, receiver)
        if (typeof original !== 'function') return original
        return function guardedMethod(...args) {
          if (!isGranted(id, capability)) throw deniedError(manifest, capability)
          return original.apply(target, args)
        }
      },
    })
  }

  const guardService = (manifest, serviceName, value) => {
    const capability = SERVICE_CAPABILITIES[serviceName]
    if (!capability || !isManaged(manifest, capability)) return value
    return liveGuard(manifest, capability, value)
  }

  const service = {
    name: 'permissions',
    capabilities: () => ({ ...CAPABILITIES }),
    presets: () =>
      Object.entries(PRESETS).map(([id, item]) => ({ id, label: item.label, description: item.description, active: id === preset() })),
    preset,
    setPreset,
    declared,
    isGranted,
    can: isGranted,
    setGrant,
    grant: (id, capability) => setGrant(id, capability, true),
    revoke: (id, capability) => setGrant(id, capability, false),
    guardService,
    /** 给设置页用的清单：哪些插件声明了权限、当前是否放行 */
    list() {
      const manifests = app.manifests?.() || []
      return manifests
        .map(manifest => {
          const caps = declared(manifest.name || manifest.id)
          if (!caps.length) return null
          return {
            id: manifest.name || manifest.id,
            displayName: manifest.displayName || manifest.name,
            core: !!manifest.core,
            capabilities: caps.map(cap => ({
              id: cap,
              label: CAPABILITIES[cap],
              granted: isGranted(manifest.name || manifest.id, cap),
            })),
          }
        })
        .filter(Boolean)
        .sort((a, b) => Number(a.core) - Number(b.core) || String(a.id).localeCompare(String(b.id)))
    },
  }

  app.setServiceGuard?.(guardService)
  ctx.on('config:changed', ({ key }) => {
    if (key === 'permissions.preset' || key === 'permissions.grants') events.emit('permissions:changed', { key })
  })

  ctx.provide('permissions', service, { type: 'singleton' })
  ctx.effect(() => app.setServiceGuard?.(null))
  ctx.logger.debug('插件权限中心就绪（预设 + 服务访问拦截）')
}
