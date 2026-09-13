/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * 设置项 · 渠道授权
 * 把原本分散的跨渠道设置集中到一个页面：
 *   - 每个渠道的跨渠道读取 / 发送开关
 *   - 手动授权记录（来源角色 / 用户 / 来源渠道 → 目标渠道）
 *   - 最近的权限审计日志
 */
export const name = 'settings-item-chat-auth'
export const version = '1.0.0'
export const displayName = '设置项 · 渠道授权'
export const description = '设置页 · 跨渠道读取 / 发送策略、授权记录与审计日志。'
export const author = '念风内核'
export const icon = '🔐'
export const core = false
export const depends = {
  'chat-permissions': '^1.0.0',
  'chat-store': '^1.0.0',
  'event-bus': '*',
  'session-service': '>=2.0.0',
  'settings-container': '^1.0.0',
  'toast-host': '>=1.0.0',
}
export const optionalDepends = {}
export const inject = ['settings-container', 'chat-permissions', 'chat-store', 'session-service', 'event-bus', 'toast']

import { page, section, card, row } from '../../../src/util/settings.mjs'
import { escapeHtml } from '../../../src/util/format.mjs'

const GROUP_LABEL = { private: '私聊', group: '群聊', privacy: '隐私' }
const AUDIT_RESULT = {
  allowed: '放行',
  denied: '拒绝',
  confirmed: '已确认',
  timeout: '确认超时',
  rejected: '用户拒绝',
}

export function apply(ctx) {
  const pages = ctx.inject('settings-container')
  const permissions = ctx.inject('chat-permissions')
  const store = ctx.inject('chat-store')
  const sessions = ctx.inject('session-service')
  const events = ctx.inject('event-bus')
  const toast = ctx.inject('toast')

  pages.register({
    id: 'channel-auth',
    group: '系统',
    groupOrder: 40,
    label: '渠道授权',
    icon: '🔐',
    order: 95,
    render(container) {
      const channelRow = (record, rolePolicy = null) => {
        const isPrivacy = record.group === 'privacy'
        const conv = sessions.get(record.conversationId)
        const name = conv?.name || record.name || record.channelId
        // 渠道详情里的勾选写的是“允许该角色…”，所以这里显示角色聚合值：
        // 同一角色的网页渠道 / 微信 / QQ 渠道都会显示一致状态。
        const effective = rolePolicy || record
        const toggle = (flag, on, label) =>
          isPrivacy
            ? '<span class="plugin-tag">隐私渠道固定隔离</span>'
            : `<button class="switch ${on ? 'on' : ''}" data-ch-auth-channel="${escapeHtml(record.channelId)}" data-ch-auth-flag="${flag}" data-ch-auth-next="${on ? '0' : '1'}" title="${on ? `关闭${label}` : `开启${label}`}"></button>`
        return row(
          `${escapeHtml(name)}`,
          `${escapeHtml(GROUP_LABEL[record.group] || record.group || '未知')} · ${escapeHtml(record.channelId)} · 角色 ${escapeHtml(record.roleId || '-')}${
            isPrivacy ? '' : ' · 角色级策略'
          }`,
          `<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
            <span style="font-size:11.5px;color:var(--text-3)">读取其它渠道</span>${toggle('read', effective.crossReadable === true, '跨渠道读取')}
            <span style="font-size:11.5px;color:var(--text-3)">发送到其它渠道</span>${toggle('send', effective.crossSendable === true, '跨渠道发送')}
          </div>`,
        )
      }

      const grantRow = (grant, index) => {
        const flags = [
          grant.canRead ? '读' : '',
          grant.canSend ? '写' : '',
          grant.canCrossRead ? '跨读' : '',
          grant.canCrossSend ? '跨发' : '',
        ]
          .filter(Boolean)
          .join(' / ')
        return row(
          `${escapeHtml(grant.roleId || '*')} · ${escapeHtml(grant.userId || '*')}`,
          `${escapeHtml(grant.sourceChannel || '*')} → ${escapeHtml(grant.targetChannel || '*')} · ${escapeHtml(flags || '无权限位')}`,
          `<button class="outline-btn danger-btn" data-ch-grant-remove="${index}">删除</button>`,
        )
      }

      const auditRow = item =>
        row(
          `${escapeHtml(AUDIT_RESULT[item?.result] || item?.result || '-')}`,
          `${escapeHtml(new Date(item?.at || Date.now()).toLocaleString())} · ${escapeHtml(item?.action || '-')} · ${escapeHtml(
            `${item?.sourceChannel || '-'} → ${item?.targetChannel || '-'}`,
          )}`,
          '',
        )

      const render = () => {
        const channelsList = store.channels()
        // 角色级聚合：只要同角色任意渠道开启，所有渠道行都显示开启，与
        // chat-permissions 的实际放行逻辑一致。
        const rolePolicies = new Map()
        for (const record of channelsList) {
          const roleId = record.roleId || record.conversationId
          const current = rolePolicies.get(roleId) || { crossReadable: false, crossSendable: false }
          if (record.crossReadable === true) current.crossReadable = true
          if (record.crossSendable === true) current.crossSendable = true
          rolePolicies.set(roleId, current)
        }
        const grants = permissions.grants()
        const audits = permissions.audit(30)
        container.innerHTML = page(
          '渠道授权',
          '跨渠道读取 / 发送按角色生效，并自动同步到该角色的网页 / 微信 / QQ 等全部渠道；敏感操作是否还需要二次确认由「通用 → 敏感操作确认」控制。',
          `
            ${section(
              `渠道跨渠道策略（${channelsList.length}）`,
              channelsList.length
                ? card(channelsList.map(record => channelRow(record, rolePolicies.get(record.roleId || record.conversationId))).join(''))
                : '<div class="settings-card"><div class="setting-row"><div class="setting-main"><div class="setting-name">还没有渠道记录</div></div></div></div>',
            )}
            <div class="settings-note">这些开关是角色级策略：打开后同一角色的所有渠道一起生效，并会写回渠道详情里的“跨渠道读取 / 发送”复选框；隐私渠道仍固定单会话隔离。</div>
            ${section(
              `手动授权记录（${grants.length}）`,
              grants.length ? card(grants.map(grantRow).join('')) : '<div class="settings-card"><div class="setting-row"><div class="setting-main"><div class="setting-name">没有额外授权记录</div><div class="setting-help">通常只需在渠道详情里勾选跨渠道读取 / 发送即可。</div></div></div></div>',
            )}
            ${section(
              `最近审计（${audits.length}）`,
              audits.length
                ? card(audits.slice().reverse().map(auditRow).join(''))
                : '<div class="settings-card"><div class="setting-row"><div class="setting-main"><div class="setting-name">还没有权限审计</div></div></div></div>',
            )}`,
        )
      }

      const onClick = event => {
        const toggle = event.target.closest('[data-ch-auth-channel]')
        if (toggle) {
          const channelId = toggle.dataset.chAuthChannel
          const flag = toggle.dataset.chAuthFlag
          const next = toggle.dataset.chAuthNext === '1'
          const record = store.channelRecord(channelId)
          if (!record) return
          const roleId = record.roleId || record.conversationId
          const key = flag === 'read' ? 'crossReadable' : 'crossSendable'
          if (typeof permissions.setRolePolicy === 'function') {
            permissions.setRolePolicy(roleId, { [key]: next })
          } else {
            // 兼容没有角色级策略接口的旧权限服务，至少更新当前渠道。
            const conv = sessions.get(record.conversationId)
            if (conv) {
              sessions.update(conv.id, { meta: { ...(conv.meta || {}), [key]: next } })
              store.channelForConversation(conv.id)
            }
          }
          toast.success(next ? '已为整个角色开启跨渠道权限' : '已为整个角色关闭跨渠道权限')
          render()
          return
        }
        const remove = event.target.closest('[data-ch-grant-remove]')
        if (remove) {
          const index = Number(remove.dataset.chGrantRemove)
          if (permissions.revoke(index)) {
            toast.success('已删除授权记录')
            render()
          }
        }
      }
      container.addEventListener('click', onClick)

      render()
      const offs = [
        events.on('chat:permission-changed', render),
        events.on('chat:audit', render),
        events.on('channel:updated', render),
        events.on('channel:permissions-changed', render),
        events.on('conversation:update', render),
      ]
      return () => {
        offs.forEach(off => off?.())
        container.removeEventListener('click', onClick)
      }
    },
  })

  ctx.logger.debug('渠道授权设置页就绪')
}
