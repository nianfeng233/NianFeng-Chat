/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目：念风 Chat（NianFeng-Chat）
 *
 * 微信 Clawbot 渠道插件（openclaw-weixin / iLink 协议）。
 *
 * 安装后会在「渠道 → 添加渠道」里注册“微信clawbot”类型：
 *   1. 添加渠道时选择角色、渠道分类（私聊/群聊/隐私）与权限；
 *   2. 详情里点「接入」获取微信二维码，手机扫码后即可使用；
 *   3. 微信消息写入所选角色对应的 clawbot 渠道聊天记录，模型调用结束后
 *      自动把回复发回微信；微信侧的 typing 状态在整轮模型调用彻底结束时关闭。
 *
 * 后端桥接代码在同目录 bridge.mjs，由 server/index.mjs 加载。
 */
import { useStyle } from '../../../src/util/style.mjs'
import { escapeHtml } from '../../../src/util/format.mjs'
import { resolveUserNickname } from '../../../src/util/identity.mjs'
import { WECHAT_CLAWBOT_CSS } from './style.mjs'
import { renderQrSvg, isQrImageContent } from './qrcode.mjs'

export const name = 'wechat-clawbot'
export const version = '1.0.0'
export const displayName = '微信clawbot'
export const description = '渠道插件 · 微信 Clawbot 扫码接入、消息收发与 typing 状态。'
export const author = '念风插件'
export const icon = '💬'
export const core = false
export const depends = {
  'channel-base': '^1.0.0',
  'channel-list': '^1.0.0',
  'channel-detail-host': '^3.0.0',
  'session-service': '^2.0.0',
}
export const inject = [
  'channel-base',
  'channel-registry',
  'session-service',
  'event-bus',
  'toast',
  'config',
  'api?',
  'message-service?',
  'chat-store?',
  'plugin-manager?',
]
export const provides = []
export const permissions = ['network']

const TYPE_ID = 'wechat-clawbot'
const TYPE_COLOR = '#07c160'
const TYPE_ICON = '💬'
const TAB_LABELS = { private: '私聊', group: '群聊', privacy: '隐私' }
const TAB_ORDER = ['private', 'group', 'privacy']
const DEFAULT_PERMISSIONS = {
  read: true,
  reply: true,
  context: true,
  typing: true,
  images: true,
  documents: true,
  crossRead: false,
  crossSend: false,
  confirm: true,
}
const PERMISSION_META = [
  ['read', '接收消息', '把微信消息写入角色上下文'],
  ['reply', '自动回复', '模型生成后自动发回微信'],
  ['context', '参与工作记忆', '该渠道消息参与角色级工作记忆'],
  ['typing', '发送 typing', '模型处理期间在微信侧显示“正在输入”'],
  ['images', '收发图片', '允许图片消息参与对话（文本协议优先）'],
  ['documents', '收发资料', '允许发送长资料 / 文件'],
  ['crossRead', '跨渠道读取', '允许该角色读取其它渠道记录'],
  ['crossSend', '跨渠道发送', '允许向其它渠道发送消息'],
  ['confirm', '敏感操作确认', '跨渠道等敏感操作需要二次确认'],
]
const STATUS_LABEL = { online: '已接入', connecting: '连接中', offline: '未连接', error: '异常' }
const STATUS_COLOR = { online: '#70a15a', connecting: '#c9a227', offline: '#b3b9c2', error: '#c65b5b' }

export function apply(ctx) {
  const base = ctx.inject('channel-base')
  const channels = ctx.inject('channel-registry')
  const sessions = ctx.inject('session-service')
  const events = ctx.inject('event-bus')
  const toast = ctx.inject('toast')
  const config = ctx.inject('config')
  const api = ctx.inject('api?')
  const messages = ctx.inject('message-service?')
  const store = ctx.inject('chat-store?')

  useStyle(ctx, WECHAT_CLAWBOT_CSS)

  /** conversationId -> resolve，等 chat-flow 整轮完成 */
  const pendingTurns = new Map()
  /** conversationId -> 串行 Promise，保证同一渠道消息按顺序处理 */
  const busyChains = new Map()
  /** channelId -> Set(messageId)，页面内去重（SSE 与 inbox 可能同时到达） */
  const handledInbound = new Map()
  const closing = []

  /* ---------------- 基础工具 ---------------- */

  const findChannel = channelId => {
    for (const tab of channels.tabs()) {
      const channel = channels.findChannel(tab, channelId)
      if (channel) return channel
    }
    return null
  }
  const findTab = channelId => channels.tabs().find(tab => channels.findChannel(tab, channelId)) || 'private'
  const channelKey = channelId => `wechat-clawbot:${channelId}`
  const permissionsOf = channel => ({ ...DEFAULT_PERMISSIONS, ...(channel?.meta?.permissions || {}) })
  /** 渠道详情「打开聊天记录」：进入 设置 → 聊天记录 并定位到该渠道，而不是普通会话。 */
  const openChannelRecords = channel => {
    if (!isClawbotChannel(channel)) return
    ensureConversation(channel)
    const channelId = channelKey(channel.id)
    const settingsView = ctx.registry.get('settings-view')
    const settingsContainer = ctx.registry.get('settings-container')
    if (settingsView?.open) settingsView.open('chat-records')
    else settingsContainer?.open?.('chat-records')
    setTimeout(() => events.emit('chat-records:select', { channelId }), 0)
  }
  /**
   * 微信侧用户标识。
   * Clawbot 通常是个人号，微信协议只给出内部 user id；允许用户在渠道设置里
   * 手动填写「用户显示名 / 唯一标识」，模型才能把它识别成网页端同一位用户。
   * 默认跟随念风网页端用户标识，保证开箱即用。
   */
  const channelIdentity = channel => {
    // 默认身份跟随统一的 user-identity 服务：未来联网账号插件注册 provider 后，
    // 新添加的 clawbot 渠道会自动使用真实用户名 / 用户 ID，旧渠道仍保留手动配置。
    const shared = ctx.registry.get('user-identity')?.get?.() || {}
    const fallbackUserId = String(shared.userId || config.get('chat.userId', 'web-user') || 'web-user').trim() || 'web-user'
    const fallbackUserName = String(shared.userName || resolveUserNickname(config)).trim() || resolveUserNickname(config)
    return {
      userId: String(channel?.meta?.identity?.userId || channel?.meta?.identityUserId || fallbackUserId).trim() || fallbackUserId,
      userName: String(channel?.meta?.identity?.userName || channel?.meta?.identityUserName || fallbackUserName).trim() || fallbackUserName,
    }
  }
  const roleOf = channel => sessions.get(channel?.meta?.roleId) || null
  const isClawbotChannel = channel => channel?.type === TYPE_ID
  const statusClickColor = status => STATUS_COLOR[status] || STATUS_COLOR.offline

  /** 只把真正的角色会话列进角色选择框；渠道聊天记录容器不参与角色选择。 */
  const isRoleConversation = conv => {
    const meta = conv?.meta || {}
    if (meta.channelConversation === true || meta.hiddenFromSessionList === true) return false
    const channelType = String(meta.channelType || '')
    const channelId = String(meta.channelId || '')
    if (!channelType && !channelId) return true
    if (channelType && channelType !== 'nova') return false
    if (channelId && !channelId.startsWith('nova:web:')) return false
    return true
  }

  function roleOptions(selectedId = '') {
    const list = sessions.list().filter(isRoleConversation)
    if (selectedId && !list.some(conv => conv.id === selectedId)) {
      const selected = sessions.get(selectedId)
      if (selected) list.unshift(selected)
    }
    return list
      .map(conv => `<option value="${escapeHtml(conv.id)}" ${conv.id === selectedId ? 'selected' : ''}>${escapeHtml(conv.name || conv.id)}</option>`)
      .join('')
  }

  /** 渠道 -> 独立会话（角色在渠道里的聊天记录容器） */
  function ensureConversation(channel) {
    if (!isClawbotChannel(channel)) return null
    const role = roleOf(channel)
    const roleId = channel.meta?.roleId || role?.meta?.roleId || role?.id || channel.id
    let conv = sessions.get(channel.meta?.conversationId)
    const metaPatch = {
      channelId: channelKey(channel.id),
      channelType: TYPE_ID,
      channelGroup: channel.meta?.category || 'private',
      source: 'wechat-clawbot',
      roleId,
      clawbotChannelId: channel.id,
      // 渠道消息有自己的渠道记录与记录入口（渠道详情 / 设置→聊天记录），
      // 不在普通「会话」列表里再显示一份，避免同一角色出现两个入口、两份消息。
      hiddenFromSessionList: true,
      channelConversation: true,
      identityUserId: channelIdentity(channel).userId,
      identityUserName: channelIdentity(channel).userName,
      participatesWorkingMemory: permissionsOf(channel).context !== false,
      // chat-permissions 会直接读取这两个来源侧策略，渠道设置里的跨渠道开关
      // 不再需要用户另建 grants；sensitiveConfirm 控制跨渠道操作要不要二次确认。
      crossReadable: permissionsOf(channel).crossRead === true,
      crossSendable: permissionsOf(channel).crossSend === true,
      sensitiveConfirm: permissionsOf(channel).confirm !== false,
      persona: role?.meta?.persona ?? conv?.meta?.persona ?? '',
      model: role?.meta?.model ?? conv?.meta?.model ?? '',
      avatarImage: role?.meta?.avatarImage ?? conv?.meta?.avatarImage ?? '',
    }
    if (!conv) {
      conv = sessions.create({
        name: `${role?.name || '角色'} · 微信clawbot`,
        avatar: role?.avatar || (role?.name || '微').slice(0, 1),
        c1: role?.c1,
        c2: role?.c2,
        preview: `${role?.name || '角色'} 的微信clawbot渠道`,
        meta: metaPatch,
      })
      channels.updateChannel(findTab(channel.id), channel.id, {
        meta: { ...(channel.meta || {}), conversationId: conv.id },
      })
    } else {
      sessions.update(conv.id, {
        name: conv.name || `${role?.name || '角色'} · 微信clawbot`,
        meta: { ...(conv.meta || {}), ...metaPatch },
      })
    }
    // 立刻登记到 chat-store 渠道索引：即使还没收到消息，设置 → 聊天记录里也能看到并可编辑。
    try {
      store?.channelForConversation?.(conv.id)
    } catch (_) {
      /* chat-store 未就绪时忽略 */
    }
    return conv
  }

  function updateChannelFromStatus(data) {
    if (!data?.channelId) return
    const channel = findChannel(data.channelId)
    if (!channel) return
    const mapped = data.status === 'online' || data.status === 'logged_in'
      ? 'online'
      : data.status === 'offline' || data.status === 'idle'
        ? 'offline'
        : data.status === 'expired' || data.status === 'error'
          ? 'error'
          : 'connecting'
    const clearingAccount =
      data.loggedIn === false || data.status === 'offline' || data.status === 'idle' || data.status === 'expired'
    const nextMeta = {
      ...(channel.meta || {}),
      clawbotStatus: data.status || mapped,
      accountId: data.accountId || (clearingAccount ? '' : channel.meta?.accountId || ''),
      nickname: data.nickname || (clearingAccount ? '' : channel.meta?.nickname || ''),
      lastError: data.error || '',
    }
    const unchanged =
      channel.status === mapped &&
      channel.meta?.clawbotStatus === nextMeta.clawbotStatus &&
      (channel.meta?.accountId || '') === nextMeta.accountId &&
      (channel.meta?.nickname || '') === nextMeta.nickname &&
      (channel.meta?.lastError || '') === nextMeta.lastError
    if (unchanged) return
    channels.updateChannel(findTab(channel.id), channel.id, { status: mapped, meta: nextMeta })
  }

  async function syncChannelStatuses() {
    if (!api) return
    for (const tab of channels.tabs()) {
      for (const channel of channels.channels(tab)) {
        if (!isClawbotChannel(channel)) continue
        try {
          const data = await api.get(`/clawbot/status?channelId=${encodeURIComponent(channel.id)}`)
          if (data) updateChannelFromStatus(data)
        } catch (_) {
          /* 后端未启动时保持本地状态 */
        }
      }
    }
  }

  /* ---------------- 添加 / 编辑渠道窗口 ---------------- */

  function openSettings({ mode = 'create', tab = 'private', channel = null, onSaved } = {}) {
    const editing = mode === 'edit' && channel
    const source = editing ? findChannel(channel.id) || channel : null
    const roleId = source?.meta?.roleId || ''
    const category = source?.meta?.category || (TAB_ORDER.includes(tab) ? tab : 'private')
    const permissions = permissionsOf(source)
    let overlay = null

    overlay = document.createElement('div')
    overlay.className = 'wc-mask'
    overlay.innerHTML = `
      <div class="wc-dialog" role="dialog" aria-modal="true">
        <h3>${editing ? '编辑微信clawbot渠道' : '添加微信clawbot渠道'}</h3>
        <div class="wc-sub">${editing ? '修改角色、分类与权限后立即生效。' : '微信消息会进入所选角色的 clawbot 渠道，处理完成后自动回复微信。'}</div>
        <label class="wc-field">
          <span>渠道名称</span>
          <input data-wc-name maxlength="30" value="${escapeHtml(source?.name || '微信clawbot')}" placeholder="例如：微信clawbot" />
        </label>
        <label class="wc-field">
          <span>使用角色</span>
          <select data-wc-role>
            <option value="">请选择角色</option>
            ${roleOptions(roleId)}
          </select>
        </label>
        <div class="wc-grid">
          <label class="wc-field">
            <span>渠道分类</span>
            <select data-wc-category>
              ${TAB_ORDER.map(value => `<option value="${value}" ${value === category ? 'selected' : ''}>${TAB_LABELS[value]}</option>`).join('')}
            </select>
          </label>
          <div class="wc-field">
            <span>登录状态</span>
            <div class="wc-status" style="height:34px">
              <span class="dot" style="background:${statusClickColor(source?.status)}"></span>
              <span>${STATUS_LABEL[source?.status] || '新渠道 · 点击详情里的「接入」扫码'}</span>
            </div>
          </div>
        </div>
        <div class="wc-grid">
          <label class="wc-field">
            <span>用户显示名</span>
            <input data-wc-identity-name maxlength="30" value="${escapeHtml(channelIdentity(source).userName)}" placeholder="例如：我 / 猫娘主人" />
          </label>
          <label class="wc-field">
            <span>用户唯一标识</span>
            <input data-wc-identity-id maxlength="80" value="${escapeHtml(channelIdentity(source).userId)}" placeholder="例如：web-user" />
          </label>
        </div>
        <div class="wc-note">
          Clawbot 通常是个人号，微信协议不会给出网页端的用户身份。把这里填成与网页端相同的标识，
          模型才会把微信侧消息识别成同一位主人，聊天上下文才能自然延续。
        </div>
        <div class="wc-field">
          <span>权限设置</span>
          <div class="wc-perms">
            ${PERMISSION_META.map(([key, label, help]) => `
              <label class="wc-perm">
                <input type="checkbox" data-wc-perm="${key}" ${permissions[key] !== false ? 'checked' : ''} />
                <span>${label}<small>${help}</small></span>
              </label>`).join('')}
          </div>
        </div>
        <div class="wc-note">微信 Clawbot 由 Tencent openclaw-weixin 协议提供；登录凭据仅保存在本机数据目录。</div>
        <div class="wc-error" data-wc-error hidden></div>
        <div class="wc-actions">
          <button class="outline-btn" data-wc-cancel>取消</button>
          <button class="outline-btn primary-soft" data-wc-save>${editing ? '保存修改' : '添加渠道'}</button>
        </div>
      </div>`

    const nameInput = overlay.querySelector('[data-wc-name]')
    const roleSelect = overlay.querySelector('[data-wc-role]')
    const categorySelect = overlay.querySelector('[data-wc-category]')
    const identityNameInput = overlay.querySelector('[data-wc-identity-name]')
    const identityIdInput = overlay.querySelector('[data-wc-identity-id]')
    const errorEl = overlay.querySelector('[data-wc-error]')

    const setError = message => {
      errorEl.textContent = message || ''
      errorEl.hidden = !message
    }
    const close = () => {
      overlay?.remove()
      overlay = null
    }

    const save = () => {
      const name = String(nameInput.value || '').trim() || '微信clawbot'
      const nextRoleId = String(roleSelect.value || '').trim()
      if (!nextRoleId) return setError('请先选择一个角色；没有角色时可先到「会话」里创建一个角色。')
      const nextCategory = TAB_ORDER.includes(categorySelect.value) ? categorySelect.value : 'private'
      const nextPermissions = {}
      for (const [key] of PERMISSION_META) nextPermissions[key] = !!overlay.querySelector(`[data-wc-perm="${key}"]`)?.checked
      const sharedIdentity = ctx.registry.get('user-identity')?.get?.() || {}
      const nextIdentity = {
        userId:
          String(identityIdInput.value || '').trim() ||
          sharedIdentity.userId ||
          config.get('chat.userId', 'web-user') ||
          'web-user',
        userName:
          String(identityNameInput.value || '').trim() ||
          sharedIdentity.userName ||
          resolveUserNickname(config),
      }
      const meta = {
        ...(source?.meta || {}),
        kind: TYPE_ID,
        roleId: nextRoleId,
        category: nextCategory,
        permissions: nextPermissions,
        identity: nextIdentity,
        clawbotStatus: source?.meta?.clawbotStatus || 'offline',
        updatedAt: Date.now(),
      }

      let saved = null
      if (editing && source) {
        const fromTab = findTab(source.id)
        channels.updateChannel(fromTab, source.id, { name, meta })
        if (fromTab !== nextCategory) {
          const moved = channels.removeChannel(fromTab, source.id)
          if (moved) {
            const groups = channels.groups(nextCategory)
            const group = groups[0] || channels.addGroup(nextCategory, '我的渠道')
            saved = channels.addChannel(nextCategory, group.id, { ...moved, name, meta })
            channels.activate(nextCategory, saved.id)
          }
        } else {
          saved = channels.findChannel(fromTab, source.id)
        }
        toast.success(`「${name}」已更新`)
      } else {
        const groups = channels.groups(nextCategory)
        const group = groups[0] || channels.addGroup(nextCategory, '我的渠道')
        saved = channels.addChannel(nextCategory, group.id, { type: TYPE_ID, name, color: TYPE_COLOR, status: 'offline', meta })
        channels.activate(nextCategory, saved.id)
        toast.success(`「${name}」已添加，点击详情里的「接入」扫码登录`)
      }
      if (saved) {
        try {
          ensureConversation(saved)
        } catch (err) {
          ctx.logger?.warn?.(`创建 clawbot 渠道会话失败：${err.message}`)
        }
      }
      onSaved?.(saved)
      close()
    }

    overlay.querySelector('[data-wc-cancel]')?.addEventListener('click', close)
    overlay.querySelector('[data-wc-save]')?.addEventListener('click', save)
    overlay.addEventListener('mousedown', event => {
      if (event.target === overlay) close()
    })
    const onKeydown = event => {
      if (event.key === 'Escape') close()
    }
    document.addEventListener('keydown', onKeydown)
    closing.push(() => document.removeEventListener('keydown', onKeydown))
    document.body.appendChild(overlay)
    setTimeout(() => nameInput?.focus(), 30)
  }

  /* ---------------- 扫码登录弹窗 ---------------- */

  function qrMarkup(qr) {
    if (!qr) return '<div class="wc-qr-fallback">正在获取二维码…</div>'
    const content = String(qr.content || '').trim()
    const imageUrl = String(qr.imageUrl || '').trim()
    if (imageUrl) return `<img src="${escapeHtml(imageUrl)}" alt="微信登录二维码" />`
    if (!content) return '<div class="wc-qr-fallback">微信没有返回二维码内容，请点击「重新获取」。</div>'
    if (isQrImageContent(content)) {
      const src = /^data:/i.test(content)
        ? content
        : /^https?:/i.test(content)
          ? content
          : `data:image/png;base64,${content.replace(/\s+/g, '')}`
      return `<img src="${escapeHtml(src)}" alt="微信登录二维码" />`
    }
    const svg = renderQrSvg(content, { size: 244, margin: 3 })
    return svg || `<div class="wc-qr-fallback">${escapeHtml(content)}</div>`
  }

  function openLogin(channel) {
    let overlay = null
    let closed = false
    let closeTimer = null
    let pollTimer = null

    const stopTimers = () => {
      if (closeTimer) clearTimeout(closeTimer)
      if (pollTimer) clearTimeout(pollTimer)
      closeTimer = null
      pollTimer = null
    }
    const close = () => {
      if (closed) return
      closed = true
      stopTimers()
      overlay?.remove()
      overlay = null
    }

    overlay = document.createElement('div')
    overlay.className = 'wc-mask'
    overlay.innerHTML = `
      <div class="wc-dialog" role="dialog" aria-modal="true" style="width:min(460px,94vw)">
        <h3>接入微信clawbot</h3>
        <div class="wc-sub">用手机微信扫描下方二维码并确认授权；扫码成功后该渠道会自动上线。</div>
        <div class="wc-qr" data-wc-qr><div class="wc-qr-fallback">正在获取二维码…</div></div>
        <div class="wc-status" data-wc-login-status><span class="dot" style="background:#c9a227"></span><span>正在获取二维码…</span></div>
        <div class="wc-error" data-wc-login-error hidden></div>
        <div class="wc-actions">
          <button class="outline-btn" data-wc-login-retry>重新获取二维码</button>
          <button class="outline-btn" data-wc-login-close>关闭</button>
        </div>
      </div>`

    const qrEl = overlay.querySelector('[data-wc-qr]')
    const statusEl = overlay.querySelector('[data-wc-login-status]')
    const errorEl = overlay.querySelector('[data-wc-login-error]')

    const setError = message => {
      errorEl.textContent = message || ''
      errorEl.hidden = !message
    }
    const setStatus = (text, color = '#c9a227') => {
      statusEl.innerHTML = `<span class="dot" style="background:${color}"></span><span>${escapeHtml(text)}</span>`
    }

    const applyStatus = data => {
      if (!data) return
      updateChannelFromStatus({ ...data, channelId: channel.id })
    }

    const succeed = () => {
      stopTimers()
      setStatus('已接入，微信消息链路正常。', '#70a15a')
      toast.success('微信clawbot 已接入')
      closeTimer = setTimeout(close, 1200)
    }

    /**
     * 返回 true 表示还要继续轮询。
     * 拿到 token 不等于链路已接入：后端会先返回 connecting，notifystart / getupdates
     * 成功后才返回 online。这里持续读取真实状态，不再手动把渠道状态改回“连接中”。
     */
    const paint = data => {
      const qr = data?.qr || null
      qrEl.innerHTML = qrMarkup(qr)
      if (data) applyStatus(data)
      const qrState = qr?.status || ''
      const actual = String(data?.status || '')
      const loggedIn = data?.loggedIn === true || actual === 'logged_in'
      if (loggedIn) {
        if (actual === 'online') {
          succeed()
          return false
        }
        if (actual === 'error' || actual === 'expired') {
          const message = data?.error || '登录失败，请重试。'
          setStatus(message, '#c65b5b')
          setError(message)
          return false
        }
        setError('')
        setStatus('已登录，正在建立微信消息链路…', '#70a15a')
        return true
      }

      const status = ['scanned', 'expired', 'error', 'verify_code_blocked'].includes(qrState)
        ? qrState
        : actual === 'error' || actual === 'expired'
          ? actual
          : qrState || actual || 'wait_scan'
      const qrError = data?.error || qr?.error || ''
      if (status === 'scanned') setStatus('已扫码，请在手机上确认授权…', '#c9a227')
      else if (status === 'expired') setStatus('二维码已过期，请重新获取。', '#c65b5b')
      else if (status === 'error' || (qrError && status === 'wait_scan')) setStatus(qrError || '登录失败，请重试。', '#c65b5b')
      else if (status === 'offline' || status === 'idle') setStatus('当前未连接，请点击「重新获取二维码」。', '#b3b9c2')
      else setStatus('请使用手机微信扫码，并在手机上确认授权。', '#c9a227')
      if (qrError) setError(qrError)
      return !['expired', 'error', 'verify_code_blocked', 'offline', 'idle'].includes(status)
    }

    const poll = async () => {
      if (closed) return
      try {
        const data = await api.get(`/clawbot/login/status?channelId=${encodeURIComponent(channel.id)}`)
        const shouldContinue = paint(data)
        if (shouldContinue) pollTimer = setTimeout(poll, data?.loggedIn ? 1200 : 2000)
      } catch (err) {
        setError(`查询扫码状态失败：${err.message}`)
        pollTimer = setTimeout(poll, 2600)
      }
    }

    const start = async () => {
      if (closed) return
      stopTimers()
      setError('')
      setStatus('正在获取二维码…')
      qrEl.innerHTML = '<div class="wc-qr-fallback">正在获取二维码…</div>'
      try {
        const data = await api.post('/clawbot/login/start', { channelId: channel.id })
        const shouldContinue = paint(data)
        if (shouldContinue) pollTimer = setTimeout(poll, data?.loggedIn ? 1200 : 1600)
      } catch (err) {
        setStatus('二维码获取失败', '#c65b5b')
        setError(err.message || String(err))
      }
    }

    overlay.querySelector('[data-wc-login-retry]')?.addEventListener('click', start)
    overlay.querySelector('[data-wc-login-close]')?.addEventListener('click', close)
    overlay.addEventListener('mousedown', event => {
      if (event.target === overlay) close()
    })
    const onKeydown = event => {
      if (event.key === 'Escape') close()
    }
    document.addEventListener('keydown', onKeydown)
    closing.push(() => document.removeEventListener('keydown', onKeydown))
    document.body.appendChild(overlay)
    start()
  }


  /* ---------------- 渠道详情（由 channel-detail-host 调用） ---------------- */

  function detailHtml(channel) {
    const role = roleOf(channel)
    const category = channel.meta?.category || 'private'
    const permissions = permissionsOf(channel)
    const conv = sessions.get(channel.meta?.conversationId)
    const status = channel.status || 'offline'
    const accountText = channel.meta?.nickname || channel.meta?.accountId || ''
    const enabled = PERMISSION_META.filter(([key]) => permissions[key] !== false).map(([, label]) => label)
    const statusText = STATUS_LABEL[status] || status
    const count = conv ? (sessions.messages(conv.id) || []).filter(m => m.kind !== 'divider').length : 0
    return `
      <div class="wc-detail">
        <div class="wc-detail-head">
          <div class="wc-detail-avatar">${TYPE_ICON}</div>
          <div style="flex:1;min-width:0">
            <div class="wc-detail-name">${escapeHtml(channel.name || '微信clawbot')}</div>
            <div class="wc-detail-sub">${escapeHtml(channel.id)} · ${escapeHtml(category)}渠道 · ${escapeHtml(role?.name || '未绑定角色')}</div>
          </div>
          <span class="wc-badge"><span class="dot" style="width:8px;height:8px;border-radius:50%;background:${statusClickColor(status)}"></span>${escapeHtml(statusText)}</span>
        </div>

        <div class="wc-detail-actions">
          ${status === 'online'
            ? '<button class="outline-btn primary-soft" data-wc-action="online">已接入</button>'
            : '<button class="outline-btn primary-soft" data-wc-action="connect">接入</button>'}
          <button class="outline-btn" data-wc-action="edit">编辑渠道</button>
          ${conv ? '<button class="outline-btn" data-wc-action="open">打开聊天记录</button>' : ''}
          ${status === 'online' ? '<button class="outline-btn" data-wc-action="logout">断开 / 退出登录</button>' : ''}
          <button class="outline-btn" data-wc-action="refresh">刷新状态</button>
        </div>
        ${channel.meta?.lastError ? `<div class="wc-error" style="margin-top:12px">${escapeHtml(channel.meta.lastError)}</div>` : ''}

        <div class="settings-section" style="margin-top:20px">
          <div class="settings-section-title">渠道配置</div>
          <div class="settings-card" style="padding:14px 16px">
            <div class="wc-kv">
              <span class="k">使用角色</span><span class="v">${escapeHtml(role?.name || '未绑定（请在编辑渠道里选择）')}</span>
              <span class="k">渠道分类</span><span class="v">${escapeHtml(TAB_LABELS[category] || category)}</span>
              <span class="k">聊天记录</span><span class="v">${conv ? `${escapeHtml(conv.name)} · ${count} 条` : '接入后自动创建'}</span>
              <span class="k">权限</span><span class="v">${escapeHtml(enabled.join(' · ') || '仅基础权限')}</span>
              <span class="k">用户标识</span><span class="v">${escapeHtml(channelIdentity(channel).userName)} · ${escapeHtml(channelIdentity(channel).userId)}</span>
              <span class="k">微信账号</span><span class="v">${escapeHtml(accountText || (status === 'online' ? '已登录' : '未登录'))}</span>
              <span class="k">协议</span><span class="v">openclaw-weixin · iLink HTTP JSON API</span>
            </div>
          </div>
        </div>

        <div class="settings-section">
          <div class="settings-note">
            点「接入」获取微信登录二维码；微信侧发消息后，所选角色会走念风完整模型链路，
            在模型整轮调用（含工具调用与全部回复消息）彻底结束后自动关闭微信 typing 状态。
            聊天记录可在「设置 → 聊天记录」里查看和修改。
          </div>
        </div>
      </div>`
  }

  function mountDetail({ container, channel, onDispose }) {
    const render = () => {
      const current = findChannel(channel.id) || channel
      container.innerHTML = detailHtml(current)
    }
    const onClick = async event => {
      const button = event.target.closest?.('[data-wc-action]')
      if (!button) return
      const current = findChannel(channel.id) || channel
      const action = button.dataset.wcAction
      if (action === 'connect') {
        openLogin(current)
      } else if (action === 'edit') {
        openSettings({ mode: 'edit', channel: current, onSaved: render })
      } else if (action === 'open') {
        openChannelRecords(current)
      } else if (action === 'refresh') {
        if (!api) return toast.error('后端未连接，无法刷新 Clawbot 状态')
        try {
          const data = await api.get(`/clawbot/status?channelId=${encodeURIComponent(current.id)}`)
          if (data) updateChannelFromStatus(data)
          render()
          toast.info('已刷新状态')
        } catch (err) {
          toast.error(`刷新失败：${err.message}`)
        }
      } else if (action === 'logout') {
        const modal = ctx.registry.get('modal')
        const confirmed = modal
          ? (await modal.confirm('断开微信clawbot', '会清除本机保存的微信登录凭据，重新使用需要再次扫码。')).ok
          : true
        if (!confirmed) return
        try {
          await api.post('/clawbot/logout', { channelId: current.id })
          updateChannelFromStatus({ channelId: current.id, status: 'offline' })
          toast.warn('已退出微信clawbot 登录')
        } catch (err) {
          toast.error(`退出失败：${err.message}`)
        }
      }
    }
    container.addEventListener('click', onClick)
    const offs = [
      events.on('channel:updated', payload => {
        const id = payload?.channel?.id || payload?.id
        if (id === channel.id) render()
      }),
      events.on('channel:status', payload => {
        if (payload?.id === channel.id) render()
      }),
      events.on('clawbot:status', payload => {
        if (payload?.channelId === channel.id) render()
      }),
      events.on('channel:sync', () => render()),
    ]

    // SSE 可能在页面打开前就广播过 online；挂载详情时主动对齐一次真实状态，
    // 避免界面一直停在本地缓存的“连接中”。
    const refresh = async () => {
      if (!api) return
      try {
        const data = await api.get(`/clawbot/status?channelId=${encodeURIComponent(channel.id)}`)
        if (data) {
          updateChannelFromStatus(data)
          render()
        }
      } catch (_) {
        /* 后端未就绪时保持本地状态 */
      }
    }
    const bootTimer = setTimeout(refresh, 0)
    const statusTimer = setInterval(() => {
      const current = findChannel(channel.id) || channel
      if (current.status === 'connecting') refresh()
    }, 4000)

    render()
    const cleanup = () => {
      clearTimeout(bootTimer)
      clearInterval(statusTimer)
      offs.forEach(off => off?.())
      container.removeEventListener('click', onClick)
    }
    onDispose?.(cleanup)
    return cleanup
  }

  /* ---------------- 微信消息 -> 角色模型 -> 微信 ---------------- */

  const buildOutboundText = message => {
    if (!message) return ''
    if (message.kind === 'document') {
      const title = message.meta?.title || message.content || '资料'
      const summary = message.meta?.summary || ''
      return [`【资料】${title}`, summary].filter(Boolean).join('\n')
    }
    return String(message.content || '').trim()
  }

  const splitForWechat = (text, max = 800) => {
    const value = String(text || '').trim()
    if (!value) return []
    const parts = []
    let current = ''
    for (const line of value.split('\n')) {
      const next = current ? `${current}\n${line}` : line
      if (next.length <= max) {
        current = next
        continue
      }
      if (current) parts.push(current)
      let rest = line
      while (rest.length > max) {
        parts.push(rest.slice(0, max))
        rest = rest.slice(max)
      }
      current = rest
    }
    if (current) parts.push(current)
    return parts
  }

  async function ackInbox(channelId, ids) {
    if (!api || !ids?.length) return
    try {
      await api.post('/clawbot/inbox/ack', { channelId, ids })
    } catch (_) {
      /* ignore */
    }
  }

  async function runInboundTurn(channel, conv, message, permissions) {
    const toUserId = message.fromUserId
    const contextToken = message.contextToken || channel.meta?.lastContextToken || ''
    const beforeIds = new Set((sessions.messages(conv.id) || []).map(item => item.id))
    let typingStarted = false

    if (permissions.typing !== false) {
      try {
        const result = await api.post('/clawbot/typing/start', { channelId: channel.id, toUserId, contextToken })
        typingStarted = result?.ok !== false
      } catch (_) {
        typingStarted = false
      }
    }

    await new Promise(resolve => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (pendingTurns.get(conv.id) === finish) pendingTurns.delete(conv.id)
        resolve()
      }
      const timer = setTimeout(finish, 10 * 60 * 1000)
      pendingTurns.set(conv.id, finish)
      try {
        // chat-flow 是模型调用链路的唯一入口；插件未启用时立即结束，避免 typing 悬挂。
        if (!ctx.registry.get('chat-flow')) finish()
        else events.emit('message:send', { conversationId: conv.id, text: message.text, skipUserAppend: true })
      } catch (_) {
        finish()
      }
    })

    const fresh = (sessions.messages(conv.id) || []).filter(
      item =>
        !beforeIds.has(item.id) &&
        item.role === 'assistant' &&
        !item.streaming &&
        !item.error &&
        (String(item.content || '').trim() || (Array.isArray(item.meta?.images) && item.meta.images.length > 0)),
    )
    for (const item of fresh) {
      const text = buildOutboundText(item)
      try {
        for (const segment of splitForWechat(text)) {
          await api.post('/clawbot/send', { channelId: channel.id, toUserId, text: segment, contextToken })
        }
        const images = Array.isArray(item.meta?.images) ? item.meta.images.slice(0, 4) : []
        for (const image of images) {
          if (!image?.id && !image?.dataUrl && !image?.url) continue
          await api.post('/clawbot/send-media', {
            channelId: channel.id,
            toUserId,
            contextToken,
            image: { id: image.id || '', dataUrl: image.dataUrl || '', url: image.url || '', mime: image.mime || '' },
          })
        }
        messages?.update?.(conv.id, item.id, {
          source: 'wechat-clawbot',
          meta: {
            ...(item.meta || {}),
            via: 'wechat-clawbot',
            direction: 'outbound',
            toUserId,
            contextToken,
            ...(images.length ? { imagesSent: true } : {}),
          },
        })
      } catch (err) {
        toast.warn(`微信回复发送失败：${err.message}`)
      }
    }

    if (typingStarted) {
      try {
        await api.post('/clawbot/typing/stop', { channelId: channel.id, toUserId, contextToken })
      } catch (_) {
        /* typing 取消失败不影响消息本身 */
      }
    }
  }

  async function handleInbound(payload) {
    const channelId = payload?.channelId
    const message = payload?.message
    const hasImages = Array.isArray(message?.images) && message.images.length > 0
    if (!channelId || !message?.id || (!message?.text && !hasImages)) return
    const channel = findChannel(channelId)
    if (!isClawbotChannel(channel)) return
    let seen = handledInbound.get(channelId)
    if (!seen) {
      seen = new Set()
      handledInbound.set(channelId, seen)
    }
    if (seen.has(message.id)) return
    seen.add(message.id)
    if (seen.size > 500) {
      const first = seen.values().next().value
      seen.delete(first)
    }

    const conv = ensureConversation(channel)
    if (!conv) return

    // 跨渠道敏感操作的“确认 / 拒绝”回复直接交给 chat-permissions 消费，
    // 不再作为普通聊天内容触发新一轮模型调用（与输入框确认的语义保持一致）。
    const chatPermissions = ctx.registry.get('chat-permissions')
    const pendingConfirm = chatPermissions?.resolvePending?.(conv.id, message.text, {
      senderId: channelIdentity(channel).userId,
    })
    if (pendingConfirm?.handled) {
      await ackInbox(channel.id, [message.id])
      return
    }

    const permissions = permissionsOf(channel)
    const identity = channelIdentity(channel)
    if (store?.append) {
      store.append(conv.id, {
        role: 'user',
        content: message.text,
        // 使用渠道设置里手动配置的用户标识；默认与网页端一致，便于模型识别为同一位主人。
        sender_id: identity.userId,
        sender_name: identity.userName,
        source: 'wechat-clawbot',
        meta: {
          via: 'wechat-clawbot',
          direction: 'inbound',
          clawbotChannelId: channel.id,
          fromUserId: message.fromUserId,
          wxSenderName: message.nickname || '',
          contextToken: message.contextToken || '',
          wxMessageId: message.id,
          images: Array.isArray(message.images) ? message.images : [],
        },
      })
    } else {
      messages?.add?.(conv.id, { role: 'user', content: message.text, status: 'sent' })
    }
    await ackInbox(channel.id, [message.id])
    if (permissions.read === false || permissions.reply === false) return

    const previous = busyChains.get(conv.id) || Promise.resolve()
    const task = previous
      .catch(() => {})
      .then(() => runInboundTurn(channel, conv, message, permissions))
      .catch(err => ctx.logger?.warn?.(`[wechat-clawbot] 处理 ${message.id} 失败：${err?.message || err}`))
    busyChains.set(conv.id, task)
    task.finally(() => {
      if (busyChains.get(conv.id) === task) busyChains.delete(conv.id)
    }).catch(() => {})
  }

  async function drainInbox(channel) {
    if (!api) return
    try {
      const data = await api.get(`/clawbot/inbox?channelId=${encodeURIComponent(channel.id)}`)
      for (const message of data?.messages || []) await handleInbound({ channelId: channel.id, message })
    } catch (_) {
      /* ignore */
    }
  }

  /* ---------------- 插件挂载 ---------------- */

  const registration = base.defineChannel({
    type: TYPE_ID,
    name: '微信clawbot',
    color: TYPE_COLOR,
    icon: TYPE_ICON,
    description: '微信 Clawbot 渠道：扫码接入后收发微信消息，支持 typing 状态与完整聊天记录。',
    create: options => openSettings({ mode: 'create', ...(options || {}) }),
    detail: options => mountDetail(options),
  })
  ctx.effect(() => () => registration.dispose?.())

  // 插件自己的配置面板：会出现在「设置 → 插件 → 微信clawbot → 设置」。
  // 这是通用扩展点，后续渠道插件也可以在 apply 里注册自己的面板，无需改本体插件页。
  const pluginManager = ctx.registry.get('plugin-manager')
  if (pluginManager?.registerSettings) {
    const disposePanel = pluginManager.registerSettings({
      id: name,
      title: '微信clawbot 渠道设置',
      description: '集中查看 / 配置本插件的 clawbot 渠道和接入状态，无需再单独打开渠道页。',
      render(container, helpers = {}) {
        const closePanel = () => helpers.close?.()
        const clawbotChannels = () => {
          const list = []
          for (const tab of channels.tabs()) for (const channel of channels.channels(tab)) if (isClawbotChannel(channel)) list.push({ tab, channel })
          return list
        }
        const paint = () => {
          const list = clawbotChannels()
          container.innerHTML = list.length
            ? list
                .map(({ tab, channel }) => {
                  const role = roleOf(channel)
                  const identity = channelIdentity(channel)
                  return `
                    <div class="plugin-panel-item">
                      <div class="plugin-panel-item-main">
                        <div class="plugin-panel-item-name">${escapeHtml(channel.name || '微信clawbot')} <span class="plugin-tag">${escapeHtml(TAB_LABELS[tab] || tab)}</span></div>
                        <div class="plugin-panel-item-desc">
                          角色：${escapeHtml(role?.name || '未绑定')} · 状态：${escapeHtml(STATUS_LABEL[channel.status] || channel.status)} ·
                          用户：${escapeHtml(identity.userName)} / ${escapeHtml(identity.userId)}
                        </div>
                      </div>
                      <div class="plugin-panel-item-actions">
                        <button class="outline-btn" data-wc-panel-edit="${escapeHtml(channel.id)}">配置</button>
                        ${channel.status === 'online'
                          ? '<button class="outline-btn" data-wc-panel-open="' + escapeHtml(channel.id) + '">打开记录</button>'
                          : '<button class="outline-btn primary-soft" data-wc-panel-connect="' + escapeHtml(channel.id) + '">接入</button>'}
                      </div>
                    </div>`
                })
                .join('')
            : '<div class="plugin-panel-empty">还没有微信clawbot 渠道。请到「渠道 → 添加渠道 → 微信clawbot」创建。</div>'
        }
        const onClick = event => {
          const edit = event.target.closest?.('[data-wc-panel-edit]')
          const connect = event.target.closest?.('[data-wc-panel-connect]')
          const open = event.target.closest?.('[data-wc-panel-open]')
          const target = findChannel(edit?.dataset.wcPanelEdit || connect?.dataset.wcPanelConnect || open?.dataset.wcPanelOpen)
          if (!target) return
          closePanel()
          if (edit) openSettings({ mode: 'edit', channel: target, onSaved: paint })
          else if (connect) openLogin(target)
          else if (open) openChannelRecords(target)
        }
        container.addEventListener('click', onClick)
        const offs = [
          events.on('channel:add', paint),
          events.on('channel:removed', paint),
          events.on('channel:updated', paint),
          events.on('channel:status', paint),
          events.on('channel:sync', paint),
        ]
        paint()
        return () => {
          offs.forEach(off => off?.())
          container.removeEventListener('click', onClick)
        }
      },
    })
    ctx.effect(() => () => disposePanel?.())
  }

  const offDone = events.on('chat:request-done', payload => {
    const finish = pendingTurns.get(payload?.conversationId)
    if (typeof finish === 'function') finish()
  })
  ctx.effect(offDone)

  /** 渠道删除 / 启动后清理已经没有对应渠道的微信聊天记录容器。 */
  function pruneOrphanConversations() {
    const tabs = typeof channels.tabs === 'function' ? channels.tabs() : []
    const known = new Set()
    for (const tab of tabs) {
      for (const channel of channels.channels(tab)) {
        if (isClawbotChannel(channel)) known.add(String(channel.id || ''))
      }
    }
    for (const conv of sessions.list()) {
      if (conv?.meta?.channelType !== TYPE_ID) continue
      const owner = String(conv.meta.clawbotChannelId || '')
      const rawKey = String(conv.meta.channelId || '')
      const keyed = rawKey.startsWith(`${TYPE_ID}:`) ? rawKey.slice(TYPE_ID.length + 1) : ''
      if (owner && known.has(owner)) continue
      if (!owner && keyed && known.has(keyed)) continue
      if (!owner && !keyed) continue
      sessions.remove(conv.id)
    }
  }

  const offBackend = ctx.on('backend:event', payload => {
    if (payload?.event === 'clawbot:message') handleInbound(payload.data).catch(() => {})
    else if (payload?.event === 'clawbot:status') updateChannelFromStatus(payload.data)
  })
  ctx.effect(offBackend)

  /** 跨渠道敏感确认：微信侧看不到网页输入框提示，主动把确认请求发到微信。 */
  const offConfirmBridge = events.on('chat:confirm-request', payload => {
    const conv = sessions.get(payload?.conversationId)
    if (!conv || conv.meta?.channelType !== TYPE_ID) return
    const channel = findChannel(conv.meta?.clawbotChannelId)
    if (!channel || !api) return
    const lastInbound = [...(sessions.messages(conv.id) || [])]
      .reverse()
      .find(item => item.meta?.direction === 'inbound' && item.meta?.fromUserId)
    if (!lastInbound) return
    const actionText = payload.action === 'read' ? '读取另一个渠道的聊天记录' : '向另一个渠道发送消息'
    const targetName = payload.targetName || payload.targetChannel || '其它渠道'
    api
      .post('/clawbot/send', {
        channelId: channel.id,
        toUserId: lastInbound.meta.fromUserId,
        contextToken: lastInbound.meta.contextToken || '',
        text: `检测到敏感跨渠道操作（${actionText}：${targetName}）。如果同意，请直接回复“确认”；回复其它内容将视为拒绝。`,
      })
      .catch(() => {
        /* 提示发送失败不影响原确认流程（网页端仍可输入确认） */
      })
  })
  ctx.effect(offConfirmBridge)

  /**
   * 渠道被真正移除时，同步清理后端保存的 Clawbot 登录凭据并停止长轮询，
   * 避免删除后旧 token 仍在后台连接、或污染之后新建渠道的扫码流程。
   * 注意：编辑渠道切换分类时会先 remove 再 add 同一个 id，因此延迟一拍再确认。
   */
  const channelExists = channelId => {
    for (const tab of channels.tabs()) if (channels.findChannel(tab, channelId)) return true
    return false
  }
  const offRemoved = events.on('channel:removed', payload => {
    const removed = payload?.channel
    if (!isClawbotChannel(removed)) return
    setTimeout(() => {
      if (channelExists(removed.id)) return
      pruneOrphanConversations()
      if (!api) return
      api.post('/clawbot/logout', { channelId: removed.id }).catch(() => {
        /* 后端未连接时忽略，下次后端启动可通过旧凭据自然过期 */
      })
    }, 0)
  })
  ctx.effect(offRemoved)

  // 启动后 / 渠道同步完成后清理历史残留：
  // 修复删除渠道后聊天记录页仍显示 wechat-clawbot 空渠道的问题。
  let orphanPruneTimer = null
  const scheduleOrphanPrune = (delay = 1200) => {
    if (orphanPruneTimer) clearTimeout(orphanPruneTimer)
    orphanPruneTimer = setTimeout(() => {
      orphanPruneTimer = null
      try {
        pruneOrphanConversations()
      } catch (err) {
        ctx.logger?.warn?.(`[clawbot] 清理孤立聊天记录失败：${err?.message || err}`)
      }
    }, delay)
  }
  const offChannelSync = events.on('channel:sync', () => scheduleOrphanPrune(300))
  ctx.effect(offChannelSync)
  scheduleOrphanPrune(1500)
  ctx.effect(() => {
    if (orphanPruneTimer) clearTimeout(orphanPruneTimer)
  })

  ctx.effect(() => () => {
    for (const cleanup of closing.splice(0)) {
      try {
        cleanup()
      } catch (_) {
        /* ignore */
      }
    }
  })

  // 启动后对齐后端登录状态，并消费未处理完的入站消息。
  const boot = async () => {
    await syncChannelStatuses()
    for (const tab of channels.tabs()) {
      for (const channel of channels.channels(tab)) {
        if (isClawbotChannel(channel)) drainInbox(channel).catch(() => {})
      }
    }
  }
  const bootTimer = setTimeout(() => {
    boot().catch(() => {})
  }, 600)
  ctx.effect(() => () => clearTimeout(bootTimer))

  ctx.logger?.debug?.('微信clawbot 渠道插件就绪')
}

