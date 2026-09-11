/**
 * F6 · slots
 * 插槽注册中心：UI 上的命名锚点，任何插件都可以往里挂内容（文档附录 B）。
 *
 * 用法：
 *   ctx.slots.define('rail:middle')                  // 宿主声明
 *   ctx.slots.register('rail:middle', (el, ctx, meta) => {
 *     el.innerHTML = '...'
 *     return () => el.innerHTML = ''                 // 可选清理函数
 *   }, { order: 10 })
 */
export const name = 'slots'
export const version = '1.0.0'
export const displayName = '插槽注册中心'
export const description = '基础服务 · UI 插槽注册与管理，插件内容挂载点。'
export const author = '风语内核'
export const icon = '🧩'
export const core = true
export const inject = ['event-bus']
export const provides = [{ name: 'slots', type: 'singleton' }]

export function apply(ctx) {
  /** slotId -> { id, meta, entries: [] } */
  const slots = new Map()
  /** entry: { slotId, mount, owner, order, meta, cleanup, container } */
  const entries = []

  const ensure = (slotId, meta = {}) => {
    let slot = slots.get(slotId)
    if (!slot) {
      slot = { id: slotId, meta: { ...meta, auto: true }, entries: [] }
      slots.set(slotId, slot)
    }
    return slot
  }

  const mountEntry = entry => {
    const container = document.querySelector(`[data-slot="${entry.slotId}"]`)
    if (!container) return false
    if (entry.container === container && entry.mounted) return true
    try {
      const cleanup = entry.mount(container, entry.ctx, entry.meta)
      entry.cleanup = typeof cleanup === 'function' ? cleanup : null
      entry.container = container
      entry.mounted = true
      ctx.emit('slot:mounted', { slot: entry.slotId, owner: entry.owner })
      return true
    } catch (err) {
      ctx.logger.error(`插槽 ${entry.slotId} 挂载失败（${entry.owner}）`, err)
      return false
    }
  }

  const unmountEntry = entry => {
    if (!entry.mounted) return
    try {
      entry.cleanup?.()
    } catch (err) {
      ctx.logger.warn(`插槽 ${entry.slotId} 清理失败（${entry.owner}）`, err)
    }
    entry.mounted = false
    entry.container = null
  }

  const service = {
    name: 'slots',

    define(slotId, meta = {}) {
      const slot = ensure(slotId, meta)
      Object.assign(slot.meta, meta)
      return () => slots.delete(slotId)
    },

    register(slotId, mount, meta = {}) {
      const slot = ensure(slotId)
      const entry = {
        slotId,
        mount,
        owner: meta.owner || ctx.id,
        order: meta.order ?? 0,
        meta,
        mounted: false,
        cleanup: null,
        ctx: meta.ctx || ctx,
      }
      slot.entries.push(entry)
      slot.entries.sort((a, b) => a.order - b.order)
      entries.push(entry)
      service.flush()
      return () => {
        unmountEntry(entry)
        const i = slot.entries.indexOf(entry)
        if (i >= 0) slot.entries.splice(i, 1)
        const j = entries.indexOf(entry)
        if (j >= 0) entries.splice(j, 1)
      }
    },

    clear(slotId, owner) {
      for (const entry of [...entries]) {
        if (entry.slotId !== slotId) continue
        if (owner && entry.owner !== owner) continue
        unmountEntry(entry)
        const slot = slots.get(slotId)
        const i = slot?.entries.indexOf(entry) ?? -1
        if (i >= 0) slot.entries.splice(i, 1)
        const j = entries.indexOf(entry)
        if (j >= 0) entries.splice(j, 1)
      }
    },

    /** 尝试把所有"容器已存在"的条目挂上去 */
    flush() {
      let count = 0
      for (const entry of entries) if (mountEntry(entry)) count++
      return count
    },

    find(slotId) {
      return slots.get(slotId)
    },

    list() {
      return [...slots.values()].map(slot => ({
        id: slot.id,
        defined: !slot.meta.auto,
        meta: slot.meta,
        entries: slot.entries.map(e => ({ owner: e.owner, order: e.order, meta: e.meta })),
      }))
    },

    listSlots: () => service.list(),
  }

  // DOM 里出现新插槽容器时自动挂载（界面是插件运行时构建的）
  const observer = new MutationObserver(() => service.flush())
  observer.observe(document.body, { childList: true, subtree: true })
  ctx.effect(() => observer.disconnect())

  service.flush()
  ctx.provide('slots', service, { type: 'singleton' })
  ctx.logger.debug('插槽注册中心就绪')
}
