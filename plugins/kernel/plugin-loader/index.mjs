/**
 * K2 · plugin-loader
 * 把 Kernel 的 PluginLoader 暴露成服务：查询状态、动态启停、查看依赖图。
 * 插件管理器的数据源就是它（D7）。
 */
export const name = 'plugin-loader'
export const version = '1.0.0'
export const displayName = '插件加载器'
export const description = '内核层 · 扫描插件目录、读取 manifest、按依赖顺序加载与启停插件。'
export const author = '风语内核'
export const icon = '🧩'
export const core = true
export const depends = { 'event-bus': '^1.0.0', 'dependency-resolver': '^1.0.0' }
export const inject = ['event-bus']
export const provides = [{ name: 'plugin-loader', type: 'singleton' }]

export function apply(ctx) {
  const loader = ctx.inject('app').loader
  if (!loader) throw new Error('PluginLoader 未初始化，请通过 src/main.mjs 启动')

  const service = {
    name: 'plugin-loader',
    list: () => loader.list(),
    get: id => loader.get(id),
    graph: () => loader.graph(),
    activeCount: () => loader.activeCount,
    warnings: () => loader.warnings,
    /** 自检：返回所有 error / warning 问题 */
    selfCheck: () => loader.selfCheck(),
    enable: id => loader.enable(id),
    disable: id => loader.disable(id),
    isEnabled: id => loader.get(id)?.status === 'active',
    /** reload 交给外壳插件：浏览器环境直接刷新即可 */
    reload: () => location.reload(),
    stats() {
      const list = loader.list()
      const by = status => list.filter(r => r.status === status).length
      return {
        total: list.length,
        active: by('active'),
        disabled: by('disabled'),
        inactive: by('inactive'),
        error: by('error'),
        core: list.filter(r => r.manifest.core).length,
        thirdParty: list.filter(r => !r.manifest.core).length,
      }
    },
  }

  ctx.provide('plugin-loader', service, { type: 'singleton' })
  ctx.logger.info(`插件加载器就绪 · 当前 ${loader.activeCount} 个插件激活`)
}
