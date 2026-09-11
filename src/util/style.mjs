/**
 * 插件样式注入工具。
 * UI 插件把自己的 CSS 作为字符串传给 useStyle(ctx, css)，
 * 内核会插入一个 <style data-plugin="插件名"> 并在插件卸载时移除。
 * —— 对应文档 §10.8「样式用 scoped，不要污染全局」的精神：
 *    约定每个插件只用自己的选择器/变量。
 */

const registry = new Map()

export function useStyle(ctx, css, { id } = {}) {
  if (!css) return () => {}
  const pluginId = id || ctx.meta?.plugin?.name || ctx.id
  if (typeof document === 'undefined') return () => {}

  const style = document.createElement('style')
  style.dataset.plugin = pluginId
  style.textContent = css
  document.head.appendChild(style)

  const entry = { style, count: (registry.get(pluginId)?.count || 0) + 1 }
  registry.set(pluginId, entry)

  return ctx.effect(() => {
    style.remove()
    const cur = registry.get(pluginId)
    if (cur === entry) registry.delete(pluginId)
  })
}
