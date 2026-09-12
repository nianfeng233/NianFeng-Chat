/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * V14 · channel-detail-host
 * 渠道详情：未选择时是空状态；选中后展示真实信息与操作。
 *
 * 说明：具体的渠道扩展（Telegram 等）暂未内置在核心里，
 * 渠道类型由渠道插件注册；未实现的类型会在「添加渠道」菜单里明确标注。
 */
export const name = 'channel-detail-host'
export const version = '3.0.0'
export const displayName = '渠道详情'
export const description = '视觉内容 · 渠道详情与基础操作入口。'
export const author = '念风内核'
export const icon = '🔎'
export const core = true
export const depends = { 'channel-view': '^1.0.0', 'channel-registry': '^1.0.0' }
export const inject = ['slots', 'channel-registry', 'session-service', 'toast', 'i18n']

import { useStyle } from '../../../src/util/style.mjs'
import { CHANNEL_DETAIL_CSS } from './style.mjs'
import { escapeHtml } from '../../../src/util/format.mjs'
import { icons } from '../../../src/util/icons.mjs'

const STATUS_LABEL = { online: '已连接', offline: '未连接', connecting: '连接中', error: '异常' }
const STATUS_COLOR = { online: '#70a15a', offline: '#b3b9c2', connecting: '#c9a227', error: '#c65b5b' }

export function apply(ctx) {
  const channels = ctx.inject('channel-registry')
  const sessions = ctx.inject('session-service')
  const toast = ctx.inject('toast')
  const i18n = ctx.inject('i18n')

  useStyle(ctx, CHANNEL_DETAIL_CSS)

  ctx.slots.register('channel:detail', container => {
    let detailCleanup = null

    const render = () => {
      try {
        detailCleanup?.()
      } catch (_) {
        /* ignore */
      }
      detailCleanup = null

      const channel = channels.active()
      if (!channel) {
        container.innerHTML = `
          <div class="empty-state">
            ${icons.channel}
            <div class="empty-title">${i18n.t('channel.empty', '选择一个渠道查看详情')}</div>
            <div class="empty-sub">${i18n.t('channel.emptySub', '或点击左侧「添加渠道」接入新的消息渠道')}</div>
          </div>`
        return
      }

      const type = channels.type(channel.type)
      // 渠道类型可提供自己的详情渲染器（例如微信 Clawbot 的接入二维码/登录状态）。
      if (typeof type?.detail === 'function') {
        try {
          detailCleanup = type.detail({ container, channel, type }) || null
        } catch (err) {
          ctx.logger.error(`渠道 ${channel.type} 自定义详情渲染失败`, err)
        }
        if (detailCleanup) return
      }
      const color = STATUS_COLOR[channel.status] || STATUS_COLOR.offline
      const conversation = sessions.list().find(c => c.meta?.channelId === channel.id)

      container.innerHTML = `
        <div class="channel-detail">
          <div class="channel-detail-head">
            <div class="channel-avatar" style="--c1:${channel.color};--c2:${channel.color}">${escapeHtml(channel.name.slice(0, 1))}</div>
            <div class="channel-detail-main">
              <div class="channel-detail-name">${escapeHtml(channel.name)}</div>
              <div class="channel-detail-sub">${escapeHtml(type?.name || channel.type)} · ${escapeHtml(type?.description || '由渠道插件提供')}</div>
            </div>
            <span class="channel-status" style="color:${color}">● ${STATUS_LABEL[channel.status] || channel.status}</span>
          </div>

          <div class="settings-section">
            <div class="settings-section-title">渠道信息</div>
            <div class="settings-card">
              <div class="setting-row">
                <div class="setting-main"><div class="setting-name">渠道 ID</div><div class="setting-help">会话与消息流中的唯一标识</div></div>
                <div class="setting-control"><span class="channel-code">${escapeHtml(channel.id)}</span></div>
              </div>
              <div class="setting-row">
                <div class="setting-main"><div class="setting-name">接入插件</div><div class="setting-help">该渠道类型由哪个插件注册</div></div>
                <div class="setting-control"><span class="channel-code">${type ? `channel-${escapeHtml(channel.type)}` : '未注册类型'}</span></div>
              </div>
              <div class="setting-row">
                <div class="setting-main"><div class="setting-name">连接状态</div><div class="setting-help">${channel.status === 'online' ? '当前与外部服务保持连接' : '当前未连接'}</div></div>
                <div class="setting-control"><button class="outline-btn" data-action="toggle">${channel.status === 'online' ? '断开' : '连接'}</button></div>
              </div>
            </div>
          </div>

          <div class="settings-section">
            <div class="settings-section-title">消息会话</div>
            <div class="settings-card">
              ${conversation
                ? `<div class="setting-row">
                    <div class="setting-main">
                      <div class="setting-name">${escapeHtml(conversation.name)}</div>
                      <div class="setting-help">${escapeHtml((conversation.preview || '暂无消息').slice(0, 60))}</div>
                    </div>
                    <div class="setting-control"><button class="outline-btn" data-action="open">打开会话</button></div>
                  </div>`
                : `<div class="setting-row">
                    <div class="setting-main"><div class="setting-name">还没有消息</div><div class="setting-help">渠道收到消息后会自动在这里创建对应会话</div></div>
                  </div>`}
            </div>
          </div>

          <div class="settings-section"><div class="settings-note">
            该渠道由插件提供。未实现的渠道类型会在「添加渠道」里明确标注原因，不会用模拟数据冒充。
          </div></div>
        </div>`

      container.querySelector('.channel-detail')?.addEventListener('click', onClick)
    }

    const onClick = async e => {
      const btn = e.target.closest('[data-action]')
      if (!btn) return
      const channel = channels.active()
      if (!channel) return
      if (btn.dataset.action === 'toggle') {
        const tab = channels.activeKey()?.split(':')[0] || 'private'
        try {
          if (channel.status === 'online') {
            await channels.disconnect(tab, channel.id)
            toast.info(`「${channel.name}」已断开`)
          } else {
            await channels.connect(tab, channel.id)
            toast.success(`「${channel.name}」已连接`)
          }
        } catch (err) {
          toast.error(`「${channel.name}」连接失败：${err.message}`)
        }
      } else if (btn.dataset.action === 'open') {
        const conversation = sessions.list().find(c => c.meta?.channelId === channel.id)
        if (conversation) {
          ctx.registry.get('view-router')?.switch('chat')
          sessions.activate(conversation.id)
        }
      }
    }

    const offs = [
      ctx.on('channel:activated', render),
      ctx.on('channel:status', render),
      ctx.on('channel:removed', render),
      ctx.on('channel:updated', render),
      ctx.on('conversation:update', render),
      ctx.on('i18n:changed', render),
    ]

    render()
    return () => {
      try {
        detailCleanup?.()
      } catch (_) {
        /* ignore */
      }
      detailCleanup = null
      offs.forEach(off => off())
      container.innerHTML = ''
    }
  })
}
