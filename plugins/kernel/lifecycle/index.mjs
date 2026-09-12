/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * K4 · lifecycle
 * 统一的生命周期钩子：setup（apply）/ start / stop / dispose。
 * 这里把它固化成可查询的服务，并记录每个插件的阶段耗时。
 */
export const name = 'lifecycle'
export const version = '1.0.0'
export const displayName = '生命周期'
export const description = '内核层 · 提供 setup / start / stop / dispose 钩子与阶段统计。'
export const author = '念风内核'
export const icon = '♻️'
export const core = true
export const inject = ['event-bus']
export const provides = [{ name: 'lifecycle', type: 'singleton' }]

const PHASES = ['setup', 'start', 'stop', 'dispose']

export function apply(ctx) {
  const events = ctx.inject('event-bus')
  const startedAt = Date.now()
  const timeline = []
  const hooks = new Map(PHASES.map(p => [p, new Set()]))

  const service = {
    name: 'lifecycle',
    phases: PHASES,
    /** 注册全局钩子（会在插件对应阶段后触发） */
    hook(phase, fn) {
      if (!hooks.has(phase)) throw new Error(`未知生命周期阶段：${phase}`)
      hooks.get(phase).add(fn)
      return () => hooks.get(phase).delete(fn)
    },
    emit(phase, payload) {
      timeline.push({ phase, time: Date.now(), ...payload })
      if (timeline.length > 500) timeline.shift()
      for (const fn of [...hooks.get(phase) || []]) {
        try {
          fn(payload)
        } catch (err) {
          ctx.logger.error(`lifecycle hook ${phase} 失败`, err)
        }
      }
    },
    timeline: () => [...timeline],
    uptime: () => Date.now() - startedAt,
    startedAt: () => startedAt,
  }

  for (const phase of PHASES) {
    eventMap[phase]?.forEach(evt => {
      ctx.on(evt, payload => service.emit(phase, payload))
    })
  }
  events.on('plugin:error', payload => service.emit('dispose', { id: payload.id, error: String(payload.error?.message || payload.error) }))

  ctx.provide('lifecycle', service, { type: 'singleton' })
  ctx.logger.debug('生命周期服务就绪')
}

const eventMap = {
  setup: ['plugin:loaded'],
  start: ['plugin:started'],
  stop: ['plugin:stopped'],
  dispose: ['plugin:disabled'],
}
