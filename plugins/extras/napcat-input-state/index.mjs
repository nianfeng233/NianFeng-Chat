/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * 扩展 · napcat-input-state
 * 参考 AstrBot 的 astrbot_plugin_input_state_by_nc：
 *   NapCat 的 set_input_status 只能保持很短时间，需要在整轮模型调用期间
 *   持续上报“正在输入中”，直到 chat:request-done 才停止。
 *
 * 说明：NapCat / OneBot 的 set_input_status 只支持私聊（C2C），群聊接口不支持；
 * 因此群聊渠道会自动跳过，并在设置里说明。
 */
export const name = 'napcat-input-state'
export const version = '1.0.0'
export const displayName = 'NapCat 输入状态'
export const description = '扩展 · NapCat 私聊在模型调用期间持续显示“正在输入中”（定时刷新，整轮结束停止）。'
export const author = '念风插件'
export const icon = '⌨️'
export const core = false
export const depends = { 'channel-registry': '^1.0.0', napcat: '^1.0.0', config: '^1.0.0' }
export const inject = ['channel-registry', 'event-bus', 'config', 'napcat-channel?', 'plugin-manager?']
export const permissions = ['network']

import { page, section, card, row, switchBtn, input, bindConfigControls } from '../../../src/util/settings.mjs'

const DEFAULT_INTERVAL = 3000
const DEFAULT_TIMEOUT = 10 * 60 * 1000
const SHORT_PULSE_MS = 8000

export function apply(ctx) {
  const registry = ctx.inject('channel-registry')
  const events = ctx.inject('event-bus')
  const config = ctx.inject('config')
  const napcat = ctx.inject('napcat-channel?')
  const pluginManager = ctx.inject('plugin-manager?')

  /** conversationId -> 保活状态 */
  const loops = new Map()

  const enabled = () => config.get('napcat.inputState.enabled', true) !== false
  const intervalMs = () => Math.max(1000, Number(config.get('napcat.inputState.intervalMs', DEFAULT_INTERVAL)) || DEFAULT_INTERVAL)
  const timeoutMs = () => Math.max(5000, Number(config.get('napcat.inputState.timeoutMs', DEFAULT_TIMEOUT)) || DEFAULT_TIMEOUT)

  const findChannel = conversationId => {
    const wanted = String(conversationId || '')
    if (!wanted) return null
    for (const tab of registry.tabs()) {
      for (const channel of registry.channels(tab)) {
        if (channel?.type === 'napcat' && String(channel.meta?.conversationId || '') === wanted) return channel
      }
    }
    return null
  }

  const targetOf = channel => ({
    instanceId: String(channel?.meta?.instanceId || '').trim(),
    targetId: String(channel?.meta?.targetId || '').trim(),
    targetType: channel?.meta?.targetType === 'group' || channel?.meta?.category === 'group' ? 'group' : 'private',
  })

  const stopLoop = (conversationId, reason = '') => {
    const state = loops.get(conversationId)
    if (!state) return
    loops.delete(conversationId)
    if (state.timer) clearInterval(state.timer)
    if (reason) ctx.logger.debug(`[napcat-input-state] 停止 ${conversationId}：${reason}`)
  }

  const stopAll = () => {
    for (const conversationId of [...loops.keys()]) stopLoop(conversationId, '插件停止')
  }

  const sendOnce = async state => {
    if (!napcat || !state.instanceId || !state.targetId) return false
    if (state.targetType !== 'private') return false
    try {
      await napcat.action(state.instanceId, 'set_input_status', {
        user_id: Number(state.targetId) || state.targetId,
        event_type: 1,
      })
      state.failures = 0
      state.lastSentAt = Date.now()
      return true
    } catch (err) {
      state.failures = (state.failures || 0) + 1
      if (state.failures === 1) ctx.logger.debug(`[napcat-input-state] set_input_status 调用失败：${err?.message || err}`)
      if (state.failures >= 3) stopLoop(state.conversationId, '连续调用失败')
      return false
    }
  }

  /**
   * @param {string} conversationId
   * @param {object} channel
   * @param {{short?: boolean}} options short=true 表示只在本次外发附近短暂显示
   */
  const startLoop = (conversationId, channel, { short = false } = {}) => {
    if (!enabled() || !napcat) return
    if (!channel) return
    const target = targetOf(channel)
    if (target.targetType === 'group') return // NapCat set_input_status 仅支持 C2C
    if (!target.instanceId || !target.targetId) return

    const existing = loops.get(conversationId)
    if (existing) {
      if (short && !existing.isShort) {
        // 整轮保活中：只需补报一次，不能让短脉冲覆盖整轮状态。
        sendOnce(existing)
        return
      }
      if (!short && existing.isShort) {
        // 从“外发附近短暂显示”升级为整轮保活。
        stopLoop(conversationId, '切换为整轮保活')
      } else {
        existing.expiresAt = Math.max(existing.expiresAt, Date.now() + (short ? SHORT_PULSE_MS : timeoutMs()))
        sendOnce(existing)
        return
      }
    }

    const now = Date.now()
    const state = {
      conversationId,
      channelId: channel.id,
      instanceId: target.instanceId,
      targetId: target.targetId,
      targetType: target.targetType,
      isShort: short,
      startedAt: now,
      expiresAt: now + (short ? SHORT_PULSE_MS : timeoutMs()),
      timer: null,
      failures: 0,
    }
    loops.set(conversationId, state)
    sendOnce(state)
    state.timer = setInterval(() => {
      if (!loops.has(conversationId)) return
      if (Date.now() > state.expiresAt) {
        stopLoop(conversationId, '超时')
        return
      }
      if (!enabled()) {
        stopLoop(conversationId, '配置已关闭')
        return
      }
      sendOnce(state)
    }, intervalMs())
  }

  const offs = [
    events.on('chat:request-start', ({ conversationId } = {}) => {
      const channel = findChannel(conversationId)
      if (channel) startLoop(conversationId, channel)
    }),
    events.on('chat:request-done', ({ conversationId } = {}) => stopLoop(conversationId, '整轮结束')),
    events.on('chat:typing', ({ conversationId, typing } = {}) => {
      if (!typing) {
        const state = loops.get(conversationId)
        if (state?.isShort) stopLoop(conversationId, '本批消息发送完成')
        return
      }
      const channel = findChannel(conversationId)
      if (channel) startLoop(conversationId, channel, { short: true })
    }),
    events.on('channel:removed', ({ channel } = {}) => {
      if (channel?.type !== 'napcat') return
      for (const [conversationId, state] of [...loops.entries()]) {
        if (String(state.channelId) === String(channel.id)) stopLoop(conversationId, '渠道已删除')
      }
    }),
    ctx.on('config:changed', ({ key, value } = {}) => {
      if (key === 'napcat.inputState.enabled' && value === false) stopAll()
    }),
  ]

  if (pluginManager?.registerSettings) {
    const dispose = pluginManager.registerSettings({
      id: name,
      title: 'NapCat 输入状态',
      description: '整轮模型调用期间持续向 QQ 私聊上报“正在输入中”。',
      render(container) {
        container.innerHTML = page(
          'NapCat 输入状态',
          'NapCat 的输入状态只能保持一小会儿，插件会在整轮模型调用期间自动定时刷报；调用彻底结束后停止。',
          `
            ${section('输入状态', card(
              row('启用输入状态', 'NapCat 私聊渠道在模型调用期间显示“正在输入中”', switchBtn('napcat.inputState.enabled', true)) +
                row(
                  '刷新间隔（毫秒）',
                  'NapCat 输入状态会自动消失，需要按此间隔重复上报；默认 3000ms',
                  input('napcat.inputState.intervalMs', config.get('napcat.inputState.intervalMs', DEFAULT_INTERVAL), { type: 'number', width: 100 }),
                ) +
                row(
                  '最长持续时间（毫秒）',
                  '防止异常情况下输入中一直不消失；默认 600000ms（10 分钟）',
                  input('napcat.inputState.timeoutMs', config.get('napcat.inputState.timeoutMs', DEFAULT_TIMEOUT), { type: 'number', width: 120 }),
                ),
            ))}
            <div class="settings-note">
              OneBot / NapCat 的 <code>set_input_status</code> 目前只支持私聊（C2C）；群聊渠道没有对应接口，因此不会显示群输入状态。
            </div>`,
        )
        return bindConfigControls(container, ctx)
      },
    })
    ctx.effect(() => () => dispose?.())
  }

  ctx.effect(() => () => {
    offs.forEach(off => off?.())
    stopAll()
  })

  ctx.logger.debug('NapCat 输入状态扩展就绪（仅私聊）')
}
