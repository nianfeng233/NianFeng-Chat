/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * S2 · bg-provider
 * 背景接口：可选中型服务（绿雾 / 纯色 / 图片…）。
 * 背景实现由独立插件注册（S3 bg-aurora、S4 bg-solid）。
 */
export const name = 'bg-provider'
export const version = '1.0.0'
export const displayName = '背景接口'
export const description = '视觉框架 · 背景可选中服务，用户可在已安装实现间切换。'
export const author = '念风内核'
export const icon = '🌫️'
export const core = true
export const depends = {
  'event-bus': '*',
  'service-container': '^1.0.0',
}
export const optionalDepends = {}
export const inject = ['service-container', 'event-bus']
export const provides = [{ name: 'bg-provider', type: 'singleton' }]

export function apply(ctx) {
  const container = ctx.inject('service-container')

  const layer = document.createElement('div')
  layer.id = 'bgLayer'
  layer.className = 'bg-layer'
  document.body.insertBefore(layer, document.body.firstChild)
  ctx.effect(() => layer.remove())

  const selectable = container.createSelectable('bg', { displayName: '背景', fallback: 'bg-aurora' })
  let cleanup = null

  const applyActive = () => {
    const impl = selectable.getActive()
    cleanup?.()
    cleanup = null
    layer.className = 'bg-layer'
    layer.innerHTML = ''
    if (!impl) return
    try {
      cleanup = impl.mount?.(layer, ctx) || null
      layer.classList.add(`bg-${selectable.getActiveId()}`)
      ctx.emit('bg:applied', { id: selectable.getActiveId() })
    } catch (err) {
      ctx.logger.error('背景挂载失败', err)
    }
  }

  selectable.onChange(applyActive)

  ctx.provide('bg-provider', {
    name: 'bg-provider',
    register: (id, impl, meta) => selectable.register(id, impl, meta),
    select: id => selectable.select(id),
    active: () => selectable.getActiveId(),
    list: () => selectable.list(),
    layer: () => layer,
  }, { type: 'singleton' })

  applyActive()
  ctx.logger.debug(`背景就绪 · ${selectable.getActiveId()}`)
}
