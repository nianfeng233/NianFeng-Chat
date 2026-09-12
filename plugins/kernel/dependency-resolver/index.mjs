/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * K3 · dependency-resolver
 * 暴露插件依赖图、拓扑顺序与循环检测结果，供插件管理器与调试面板使用。
 * 真正的排序发生在 Kernel 的 PluginLoader.buildGraph()。
 */
export const name = 'dependency-resolver'
export const version = '1.0.0'
export const displayName = '依赖解析器'
export const description = '内核层 · 拓扑排序依赖、检测循环依赖、版本兼容性检查。'
export const author = '念风内核'
export const icon = '🧮'
export const core = true
export const inject = []
export const provides = [{ name: 'dependency-resolver', type: 'singleton' }]

export function apply(ctx) {
  const loader = ctx.inject('app').loader
  if (!loader) throw new Error('PluginLoader 未初始化')

  const service = {
    name: 'dependency-resolver',
    graph: () => loader.graph(),
    order: () => loader.graph().order,
    cycles: () => [...loader.graph().cycleIds],
    /** 某一个插件为什么起不来 */
    explain(id) {
      const record = loader.get(id)
      if (!record) return { id, found: false }
      const graph = loader.graph()
      return {
        id,
        found: true,
        status: record.status,
        reason: record.reason,
        depends: Object.keys(record.manifest.depends || {}),
        injectedBy: loader.list().filter(r => (r.manifest.inject || []).includes(id)).map(r => r.id),
        edges: [...(graph.edges.get(id) || [])],
      }
    },
    /** 加载顺序批次（与文档 §9.1 对照用） */
    batches() {
      const order = loader.graph().order
      const batches = []
      const placed = new Set()
      let guard = 0
      while (placed.size < order.length && guard++ < 64) {
        const batch = []
        for (const id of order) {
          if (placed.has(id)) continue
          const record = loader.get(id)
          const deps = Object.keys(record?.manifest.depends || {})
          if (deps.every(d => placed.has(d))) {
            batch.push(id)
            placed.add(id)
          }
        }
        if (!batch.length) break
        batches.push(batch)
      }
      return batches
    },
  }

  ctx.provide('dependency-resolver', service, { type: 'singleton' })
  ctx.logger.debug('依赖解析器就绪')
}
