/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * 插件健康守卫：启动完成后自动跑一次插件自检。
 * 如果有红色错误（加载失败 / 缺少依赖 / 服务冲突等），弹出警告并引导到插件设置页；
 * 版本不匹配、未激活等提示仍按黄色显示在插件列表中。
 */
export const name = 'plugin-health-guard'
export const version = '1.0.0'
export const displayName = '插件健康守卫'
export const description = '启动检查 · 发现插件错误时弹窗提醒，并引导到插件设置。'
export const author = '念风内核'
export const icon = '🩺'
export const core = false
export const depends = { 'plugin-manager': '^1.0.0' }
export const inject = ['plugin-manager', 'modal', 'event-bus', 'toast?']
export const provides = []

export function apply(ctx) {
  let checked = false

  const check = async () => {
    if (checked) return
    checked = true
    const manager = ctx.inject('plugin-manager')
    let issues = []
    try {
      issues = manager.selfCheck() || []
    } catch (err) {
      ctx.logger.warn(`插件启动自检失败：${err.message}`)
      return
    }
    const errors = issues.filter(issue => issue.severity === 'error')
    if (!errors.length) return

    const lines = errors.slice(0, 8).map(issue => `· ${issue.id}：${issue.message}`)
    const more = errors.length > lines.length ? `\n…以及另外 ${errors.length - lines.length} 个错误` : ''
    const description = [
      '以下插件没有正常启动：',
      '',
      ...lines,
      more,
      '',
      '请前往「设置 → 插件」检查依赖、版本与冲突情况；红色插件在修复前，相关功能可能不可用。',
    ]
      .filter(line => line !== undefined)
      .join('\n')

    ctx.inject('toast')?.error?.(`插件启动检查发现 ${errors.length} 个错误`)
    try {
      const result = await ctx.inject('modal').open({
        title: '插件启动检查发现错误',
        description,
        confirmText: '打开插件设置',
        cancelText: '稍后处理',
      })
      if (result?.ok) {
        ctx.registry.get('settings-container')?.open('plugins')
        ctx.registry.get('view-router')?.switch('settings')
      }
    } catch (err) {
      ctx.logger.error('插件健康警告弹窗失败', err)
    }
  }

  const off = ctx.on('app:ready', () => {
    setTimeout(() => check().catch(err => ctx.logger.warn(`插件健康检查异常：${err.message}`)), 260)
  })
  ctx.effect(off)
}
