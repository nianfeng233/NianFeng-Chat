/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * F13 · error-reporter
 * 统一捕获：事件监听器异常、未处理 Promise、window.onerror、插件加载异常。
 * 默认只记录不打断；错误提示以 toast 形式出现，可关闭。
 */
export const name = 'error-reporter'
export const version = '1.0.0'
export const displayName = '错误上报'
export const description = '基础服务 · 捕获运行期错误，集中记录与提示。'
export const author = '念风内核'
export const icon = '🚨'
export const core = false
export const depends = {
  'event-bus': '*',
}
export const optionalDepends = {}
export const inject = ['event-bus']
export const provides = [{ name: 'error-reporter', type: 'singleton' }]

export function apply(ctx) {
  const logger = ctx.logger
  const records = []
  const MAX = 200

  const report = (error, meta = {}) => {
    const record = {
      time: Date.now(),
      message: String(error?.message || error),
      stack: error?.stack ? String(error.stack) : '',
      source: meta.source || 'plugin',
      plugin: meta.plugin || '',
      event: meta.event || '',
    }
    records.push(record)
    if (records.length > MAX) records.shift()
    ctx.emit('error:reported', record)
    return record
  }

  // 内核事件异常（运行时提供的全局错误钩子）
  const prevOnError = ctx.events.onError
  ctx.events.onError = (err, meta) => {
    prevOnError?.(err, meta)
    const record = report(err, { source: 'event', ...meta })
    logger.error(`[${meta?.plugin}] 事件 ${meta?.event} 抛出异常：${record.message}`)
    ctx.registry.get('toast')?.error?.(`插件 ${meta?.plugin || '未知'} 运行出错：${record.message}`)
  }
  ctx.effect(() => {
    ctx.events.onError = prevOnError
  })

  // 未处理的 Promise / 全局错误
  const onRejection = e => report(e.reason, { source: 'unhandledrejection' })
  const onError = e => report(e.error || e.message, { source: 'window.onerror' })
  window.addEventListener('unhandledrejection', onRejection)
  window.addEventListener('error', onError)
  ctx.effect(() => {
    window.removeEventListener('unhandledrejection', onRejection)
    window.removeEventListener('error', onError)
  })

  // 插件加载失败
  ctx.on('plugin:error', payload => {
    report(payload.error, { source: 'plugin-loader', plugin: payload.id })
  })

  const service = {
    name: 'error-reporter',
    report,
    list: () => [...records],
    last: () => records[records.length - 1] || null,
    clear: () => {
      records.length = 0
    },
    count: () => records.length,
  }

  ctx.provide('error-reporter', service, { type: 'singleton' })
  ctx.logger.debug('错误上报就绪')
}
