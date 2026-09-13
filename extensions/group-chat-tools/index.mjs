/*
 * 念风chat · 扩展插件 · group-chat-tools
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 *
 * 群聊工具（外部插件，不随本体打包）。
 *
 * 参考 AstrBot 的 xiaofeng_plugin_group_master，但按念风的能力重新设计：
 *   - 所有能力以 tool-registry 工具形式提供给模型，AI 自然语言即可调用；
 *   - 目标群默认当前群聊渠道；跨群操作沿用 chat-permissions 的跨渠道权限与确认；
 *   - 群成员匹配 / 资料查询走「精确优先、模糊兜底、歧义返回候选」策略，
 *     避免模型猜名字把消息 @ 错人；
 *   - 直发 CQ 码的能力由 NapCat 后端桥的出站解析提供
 *     （chat_send 正文里写 [CQ:at,qq=123] / [at:123] 即可）；
 *   - 管理动作有硬性安全约束：不操作机器人自己、群主与保护名单成员。
 *
 * 安装：把本目录复制到 <数据目录>/plugins/group-chat-tools/（或用 install.ps1），
 * 重新扫描插件即可；依赖内置 napcat 渠道插件。
 */
export const name = 'group-chat-tools'
export const version = '1.0.0'
export const displayName = '群聊工具'
export const description = '扩展 · NapCat 群聊增强：@成员 / @全体、成员搜索与资料查询、禁言踢人、群头衔、群公告、群信息与待处理申请。'
export const author = '念风扩展'
export const icon = '🎯'
export const core = false
export const enabled = true
export const depends = {
  'channel-registry': '^1.0.0',
  'config': '>=1.1.0',
  'event-bus': '*',
  'napcat': '^1.0.0',
  'session-service': '^2.0.0',
  'tool-registry': '^1.0.0',
}
export const optionalDepends = {
  'chat-permissions': '^1.0.0',
  'chat-store': '>=1.0.0',
  'plugin-manager': '>=1.0.0',
}
export const inject = [
  'tool-registry',
  'channel-registry',
  'session-service',
  'config',
  'event-bus',
  'napcat-channel?',
  'chat-store?',
  'chat-permissions?',
  'plugin-manager?',
]
export const provides = [{ name: 'group-chat-tools', type: 'singleton' }]
export const permissions = ['network']

/* ================================================================== */
/* 模块级小工具                                                        */
/* ================================================================== */

const FIELD_KEYS = ['basic', 'signature', 'qq_level', 'vip', 'group_member', 'friend', 'honor', 'likes', 'status', 'space']
const MAX_TARGETS = 10
const QQ_MAX_BAN_SECONDS = 30 * 24 * 60 * 60

function clampNum(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.floor(n)))
}

function parseList(value) {
  if (Array.isArray(value)) return value.map(item => String(item || '').trim()).filter(Boolean)
  return String(value || '')
    .split(/[,，、;；\s]+/)
    .map(item => item.trim())
    .filter(Boolean)
}

/** 用于名字匹配的归一化：全角转半角、去零宽/空白、去首部 @、统一小写。 */
function normalizeKey(value) {
  return String(value ?? '')
    .replace(/[\uff01-\uff5e]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[\u200b-\u200d\ufeff\s\u00a0]+/g, '')
    .toLowerCase()
    .replace(/^@+/, '')
}

function isQqId(value) {
  return /^\d{3,20}$/.test(String(value ?? '').trim())
}

function fmtTime(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return ''
  const date = new Date(n < 1e12 ? n * 1000 : n)
  if (Number.isNaN(date.getTime())) return ''
  const pad = v => String(v).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function humanDuration(seconds) {
  const n = Math.max(0, Math.floor(Number(seconds) || 0))
  if (n <= 0) return '解除'
  const days = Math.floor(n / 86400)
  const hours = Math.floor((n % 86400) / 3600)
  const minutes = Math.floor((n % 3600) / 60)
  const secs = n % 60
  const parts = []
  if (days) parts.push(`${days} 天`)
  if (hours) parts.push(`${hours} 小时`)
  if (minutes) parts.push(`${minutes} 分钟`)
  if (secs) parts.push(`${secs} 秒`)
  return parts.slice(0, 2).join(' ') || `${n} 秒`
}

/** 中文数字 -> 阿拉伯数字（支持常用 0~999 写法：一、十五、二十五、一百零五）。 */
function chineseNumber(value) {
  const text = String(value || '').replace(/\s|个/g, '')
  if (!text) return null
  if (text === '半') return 0.5
  const digits = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
  const units = { 十: 10, 百: 100 }
  let section = 0
  let number = 0
  for (const ch of text) {
    if (digits[ch] !== undefined) {
      number = digits[ch]
    } else if (units[ch] !== undefined) {
      if (number === 0 && ch === '十') number = 1
      section += number * units[ch]
      number = 0
    } else {
      return null
    }
  }
  const total = section + number
  return Number.isFinite(total) && total >= 0 ? total : null
}

/** 把人话里的中文时长统一成 `数字+单位`，例如 三分钟 -> 3分钟、一个半小时 -> 1.5小时。 */
function normalizeChineseDurations(text) {
  let out = String(text || '')
  // 一个半小时 / 两个半小时
  out = out.replace(/([一二两三四五六七八九十百零〇]+)个半(秒|秒钟|分钟|分|小时|时|天|日)/g, (_, n, unit) => {
    const value = chineseNumber(n)
    return value === null ? `${n}个半${unit}` : `${value + 0.5}${unit}`
  })
  // 1个半小时
  out = out.replace(/(\d+(?:\.\d+)?)个半(秒|秒钟|分钟|分|小时|时|天|日)/g, (_, n, unit) => `${Number(n) + 0.5}${unit}`)
  // 半小时 / 半分钟
  out = out.replace(/半个?(秒|秒钟|分钟|分|小时|时|天|日)/g, '0.5$1')
  // 中文数字 + 单位（可带“个”）：三分钟 / 十五分 / 一百零五分钟
  out = out.replace(/([一二两三四五六七八九十百零〇]+)\s*个?\s*(?=秒|秒钟|分钟|分|小时|时|天|日)/g, m => {
    const value = chineseNumber(m)
    return value === null ? m : String(value)
  })
  out = out.replace(/(\d+(?:\.\d+)?)个(?=秒|秒钟|分钟|分|小时|时|天|日)/g, '$1')
  // 3分半 = 210 秒
  out = out.replace(/(\d+(?:\.\d+)?)分半/g, (_, n) => `${Math.round(Number(n) * 60 + 30)}秒`)
  return out
}

function banUnitSeconds(unit) {
  const value = String(unit || '').toLowerCase()
  if (/^(秒|秒钟|s|secs?|seconds?)$/.test(value)) return 1
  if (/^(分钟|分|m|mins?|minutes?)$/.test(value)) return 60
  if (/^(小时|时|h|hrs?|hours?)$/.test(value)) return 3600
  if (/^(天|日|d|days?)$/.test(value)) return 86400
  return 0
}

/**
 * 禁言时长解析：数字按秒，或自定义单位与组合。
 *   60 / 90秒 / 1m30s / 1分钟 / 5分钟 / 一点五分钟 / 1.5小时 / 1小时30分钟 / 2天 / 半个钟头（不支持“钟头”）
 *   0 / 解禁 / unmute 解除；永久按 QQ 上限 30 天处理。
 */
function parseBanDuration(value) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) return null
    return clampNum(Math.round(value), 0, QQ_MAX_BAN_SECONDS, null)
  }
  let raw = String(value).trim().toLowerCase().replace(/\s+/g, '')
  if (!raw) return null
  if (/^(解禁|解除|取消|unmute|off|none|0)$/.test(raw)) return 0
  if (/^(永久|无限|长期|forever|permanent)$/.test(raw)) return QQ_MAX_BAN_SECONDS
  raw = normalizeChineseDurations(raw)
  if (/^\d+(?:\.\d+)?$/.test(raw)) return clampNum(Math.round(Number(raw)), 0, QQ_MAX_BAN_SECONDS, null)
  const token = /(\d+(?:\.\d+)?)(秒钟|秒|seconds?|secs?|s|分钟|分|minutes?|mins?|m|小时|时|hours?|hrs?|h|天|日|days?|d)/g
  let total = 0
  let matched = false
  let lastIndex = 0
  let leftover = ''
  let match
  while ((match = token.exec(raw))) {
    if (match.index > lastIndex) leftover += raw.slice(lastIndex, match.index)
    const seconds = banUnitSeconds(match[2])
    if (!seconds) return null
    total += Number(match[1]) * seconds
    matched = true
    lastIndex = token.lastIndex
  }
  if (!matched) return null
  leftover += raw.slice(lastIndex)
  // 允许“个 / 半 / 、，, + 和 及”等连接符，其它残余字符视为格式错误。
  if (leftover.replace(/[个半、，,+和及]/g, '')) return null
  return clampNum(Math.round(total), 0, QQ_MAX_BAN_SECONDS, null)
}

function compact(obj) {
  const out = {}
  for (const [key, value] of Object.entries(obj || {})) {
    if (value === undefined || value === null || value === '') continue
    out[key] = value
  }
  return out
}

function truncatePayload(data, limit = 3000) {
  try {
    const json = JSON.stringify(data ?? null)
    if (!json || json.length <= limit) return data ?? null
    return { truncated: true, preview: json.slice(0, limit) }
  } catch (_) {
    return String(data)
  }
}

const qqAvatarUrl = qq => `https://q1.qlogo.cn/g?b=qq&nk=${encodeURIComponent(String(qq))}&s=640`
const qzoneUrl = qq => `https://user.qzone.qq.com/${encodeURIComponent(String(qq))}`

/* ================================================================== */
/* 插件主体                                                            */
/* ================================================================== */

export function apply(ctx) {
  const tools = ctx.inject('tool-registry')
  const registry = ctx.inject('channel-registry')
  const sessions = ctx.inject('session-service')
  const config = ctx.inject('config')
  const events = ctx.inject('event-bus')
  const napcat = ctx.inject('napcat-channel?')
  const store = ctx.inject('chat-store?')
  const permissions = ctx.inject('chat-permissions?')
  const manager = ctx.inject('plugin-manager?')

  /** `${instanceId}:${groupId}` -> { at, members } */
  const MEMBER_CACHE = new Map()
  /** groupId -> { at, notices } */
  const NOTICE_CACHE = new Map()
  const registeredNames = []

  /* ---------------- 配置 ---------------- */

  const enabled = () => {
    const value = config.get('napcat.groupMaster.enabled', true)
    return value !== false && value !== 'false' && value !== 0
  }
  const allowManage = () => enabled() && config.get('napcat.groupMaster.allowManage', true) !== false
  const allowRawAction = () => enabled() && config.get('napcat.groupMaster.allowRawAction', false) === true
  const memberCacheMs = () => clampNum(config.get('napcat.groupMaster.memberCacheMs', 60000), 1000, 30 * 60 * 1000, 60000)
  const maxResults = () => clampNum(config.get('napcat.groupMaster.maxResults', 20), 1, 50, 20)
  const protectedUsers = () => parseList(config.get('napcat.groupMaster.protectedUsers', ''))

  const disabledResult = () => ({ ok: false, code: 'GM_DISABLED', error: '群聊工具已禁用（可在插件设置中开启）。' })

  const emitAction = (action, payload = {}) => {
    try {
      events.emit('group-chat-tools:action', { action, at: Date.now(), ...payload })
    } catch (_) {
      /* 事件监听方出错不影响工具执行 */
    }
  }

  /* ---------------- 渠道与目标群 ---------------- */

  const allChannels = () => {
    const out = []
    for (const tab of registry.tabs()) out.push(...registry.channels(tab))
    return out
  }
  const isGroupChannel = channel => channel?.type === 'napcat' && (channel?.meta?.targetType === 'group' || channel?.meta?.category === 'group')
  const napcatChannels = () => allChannels().filter(channel => channel?.type === 'napcat')
  const groupChannels = () => napcatChannels().filter(isGroupChannel)
  const currentChannel = context => {
    const conversationId = String(context?.conversationId || '')
    if (!conversationId) return null
    return napcatChannels().find(channel => String(channel?.meta?.conversationId || '') === conversationId) || null
  }
  const targetOf = channel => ({
    channel,
    instanceId: String(channel?.meta?.instanceId || '').trim(),
    groupId: String(channel?.meta?.targetId || '').trim(),
    name: String(channel?.meta?.targetName || channel?.name || '').trim() || String(channel?.meta?.targetId || '群'),
  })
  const describeGroup = target => `${target.name}（${target.groupId}）`

  async function callOneBot(instanceId, action, params = {}, options = {}) {
    if (!napcat) return { ok: false, code: 'NO_NAPCAT', error: 'NapCat 渠道服务不可用（napcat 插件未启用）。' }
    const id = String(instanceId || '').trim()
    if (!id) return { ok: false, code: 'NO_INSTANCE', error: '目标群渠道没有绑定 NapCat 连接。' }
    try {
      const result = await napcat.action(id, String(action || ''), params || {})
      if (!result || result.ok !== true) {
        return {
          ok: false,
          code: result?.code || 'ACTION_FAILED',
          error: String(result?.error || result?.message || `NapCat ${action} 执行失败`),
          data: result?.data ?? null,
        }
      }
      if (!options.silent) ctx.logger.debug(`[group-chat-tools] ${action} 执行成功`)
      return { ok: true, data: result.data ?? null }
    } catch (err) {
      return { ok: false, code: 'ACTION_ERROR', error: `NapCat ${action} 调用失败：${err?.message || err}` }
    }
  }

  async function callOneBotFallback(instanceId, actions, params = {}, options = {}) {
    let last = null
    for (const action of actions) {
      const result = await callOneBot(instanceId, action, params, options)
      if (result.ok) return { ...result, action }
      last = result
    }
    return last || { ok: false, error: '没有可用的 NapCat action。' }
  }

  const instanceOf = target => {
    const id = String(target?.instanceId || '')
    return napcat?.instance?.(id) || (napcat?.listInstances?.() || []).find(item => String(item?.id || '') === id) || null
  }
  const botQqOf = target => String(instanceOf(target)?.login?.userId || '').trim()

  async function resolveGroupTarget(ref, context) {
    const wanted = String(ref ?? '').trim()
    const current = currentChannel(context)
    if (!wanted || wanted === 'current' || wanted === '本群' || wanted === '当前群') {
      if (isGroupChannel(current)) return { ok: true, target: targetOf(current) }
      return { ok: false, code: 'NO_TARGET_GROUP', error: '当前会话不是 NapCat 群聊渠道；请在 group 参数里指定群号或群名。' }
    }
    if (isQqId(wanted)) {
      const hit = groupChannels().find(channel => String(channel?.meta?.targetId || '') === wanted)
      if (hit) return { ok: true, target: targetOf(hit) }
      return {
        ok: false,
        code: 'GROUP_NOT_CONFIGURED',
        error: `念风里没有群 ${wanted} 的 NapCat 群聊渠道；请先在「渠道 → 添加渠道 → NapCat → 群聊」中添加该群。`,
      }
    }
    const key = normalizeKey(wanted)
    const namesOf = channel => [channel?.name, channel?.meta?.targetName, channel?.meta?.targetId].filter(Boolean).map(normalizeKey)
    const exact = groupChannels().filter(channel => namesOf(channel).includes(key))
    const pool = exact.length ? exact : groupChannels().filter(channel => namesOf(channel).some(name => name.includes(key) || key.includes(name)))
    if (pool.length === 1) return { ok: true, target: targetOf(pool[0]) }
    if (pool.length > 1) {
      return {
        ok: false,
        code: 'GROUP_AMBIGUOUS',
        error: `「${wanted}」匹配到多个群，请改用群号：${pool.map(channel => channel?.meta?.targetId).join('、')}`,
        candidates: pool.map(channel => ({ group_id: channel?.meta?.targetId, name: channel?.meta?.targetName || channel?.name })),
      }
    }
    // 配置里没有：尝试从 NapCat 的群列表里找群名，给出明确的「先建渠道」提示。
    const fallbackInstance = String(current?.meta?.instanceId || '') || (napcat?.listInstances?.() || []).find(item => item?.status === 'online')?.id
    if (fallbackInstance && napcat) {
      const listed = await callOneBot(fallbackInstance, 'get_group_list', {}, { silent: true })
      const rows = listed.ok && Array.isArray(listed.data) ? listed.data : []
      const fuzzy = rows.filter(row => {
        const name = normalizeKey(row?.group_name)
        return name && (name.includes(key) || key.includes(name))
      })
      if (fuzzy.length === 1) {
        const row = fuzzy[0]
        const groupId = String(row?.group_id ?? '')
        const hit = groupChannels().find(channel => String(channel?.meta?.targetId || '') === groupId)
        if (hit) return { ok: true, target: targetOf(hit) }
        return {
          ok: false,
          code: 'GROUP_NOT_CONFIGURED',
          error: `群「${row?.group_name}」(${groupId}) 还没有对应的念风群聊渠道，请先添加后再操作。`,
        }
      }
    }
    const available = groupChannels().map(channel => `${channel?.meta?.targetName || channel?.name}(${channel?.meta?.targetId})`).join('、')
    return { ok: false, code: 'GROUP_NOT_FOUND', error: `没有找到群「${wanted}」。已配置的群聊渠道：${available || '（无）'}` }
  }

  /** 同群直接放行；跨群沿用 chat-permissions 的跨渠道校验与敏感确认。 */
  async function authorizeTarget(action, context, target) {
    const channel = target?.channel
    if (!channel) return { ok: false, code: 'CHANNEL_UNAVAILABLE', error: '目标渠道不可用' }
    const channelConversationId = String(channel?.meta?.conversationId || '')
    if (channelConversationId && channelConversationId === String(context?.conversationId || '')) return { ok: true }
    if (!permissions?.authorize) {
      return { ok: false, code: 'CHANNEL_UNAVAILABLE', error: '目标渠道不可用：跨群操作需要 chat-permissions 服务。' }
    }
    const conv = channelConversationId ? sessions.get(channelConversationId) : null
    const storeChannelId = String(conv?.meta?.channelId || `napcat:${channel.id}`)
    const decision = await permissions.authorize({ conversationId: context?.conversationId, action, channel: storeChannelId })
    if (!decision?.ok) return { ok: false, code: decision?.code || 'CHANNEL_UNAVAILABLE', error: decision?.error || '目标渠道不可用' }
    return { ok: true }
  }

  /* ---------------- 群成员 ---------------- */

  function normalizeMember(raw) {
    const qq = String(raw?.user_id ?? raw?.userId ?? '').trim()
    const nickname = String(raw?.nickname ?? '').trim()
    const card = String(raw?.card ?? '').trim()
    const shutUp = Number(raw?.shut_up_timestamp ?? raw?.shutUpTime ?? 0) || 0
    const nowSeconds = Math.floor(Date.now() / 1000)
    return {
      qq,
      nickname,
      card,
      display: card || nickname || qq,
      role: ['owner', 'admin', 'member'].includes(raw?.role) ? raw.role : 'member',
      title: String(raw?.title ?? raw?.memberSpecialTitle ?? '').trim(),
      level: Number(raw?.level ?? raw?.memberRealLevel ?? 0) || 0,
      qq_level: Number(raw?.qq_level ?? raw?.qqLevel ?? 0) || 0,
      sex: String(raw?.sex ?? 'unknown'),
      age: Number(raw?.age ?? 0) || 0,
      join_time: Number(raw?.join_time ?? raw?.joinTime ?? 0) || 0,
      last_sent_time: Number(raw?.last_sent_time ?? raw?.lastSpeakTime ?? 0) || 0,
      shut_up_timestamp: shutUp,
      muted: shutUp > nowSeconds,
      is_robot: raw?.is_robot === true || raw?.isRobot === true,
    }
  }

  function publicMember(member) {
    return compact({
      qq: member.qq,
      nickname: member.nickname,
      card: member.card,
      display: member.display,
      role: member.role,
      title: member.title,
      group_level: member.level || undefined,
      qq_level: member.qq_level || undefined,
      sex: member.sex && member.sex !== 'unknown' ? member.sex : undefined,
      join_time: fmtTime(member.join_time) || undefined,
      last_sent_time: fmtTime(member.last_sent_time) || undefined,
      muted_until: member.muted ? fmtTime(member.shut_up_timestamp) : undefined,
      is_robot: member.is_robot || undefined,
    })
  }

  async function fetchMembers(target, { refresh = false } = {}) {
    const cacheKey = `${target.instanceId}:${target.groupId}`
    const cached = MEMBER_CACHE.get(cacheKey)
    if (!refresh && cached && Date.now() - cached.at < memberCacheMs()) {
      return { ok: true, members: cached.members, cached: true }
    }
    const result = await callOneBot(target.instanceId, 'get_group_member_list', {
      group_id: target.groupId,
      no_cache: refresh === true,
    })
    if (!result.ok) return { ok: false, code: result.code, error: result.error }
    const rows = Array.isArray(result.data) ? result.data : []
    const members = rows.map(normalizeMember).filter(member => member.qq)
    MEMBER_CACHE.set(cacheKey, { at: Date.now(), members })
    return { ok: true, members, cached: false }
  }

  /** 返回带 _score 的排序结果；exact 只保留 100/90/80 分。 */
  function matchMembers(members, keyword, mode = 'auto') {
    const key = normalizeKey(keyword)
    if (!key) return []
    const scoreOf = member => {
      const cardKey = normalizeKey(member.card)
      const nickKey = normalizeKey(member.nickname)
      const qqKey = normalizeKey(member.qq)
      if (qqKey === key) return 100
      if (cardKey && cardKey === key) return 90
      if (nickKey && nickKey === key) return 80
      if (cardKey && cardKey.startsWith(key)) return 70
      if (nickKey && nickKey.startsWith(key)) return 68
      if (cardKey && cardKey.includes(key)) return 60
      if (nickKey && nickKey.includes(key)) return 58
      if (qqKey.includes(key)) return 50
      return 0
    }
    const scored = members
      .map(member => ({ ...member, _score: scoreOf(member) }))
      .filter(member => member._score > 0)
      .sort((a, b) => b._score - a._score || String(a.qq).localeCompare(String(b.qq)))
    if (mode === 'exact') return scored.filter(member => member._score >= 80)
    if (mode === 'fuzzy') return scored
    return scored
  }

  function pickMemberFromList(members, ref, { requireMember = true } = {}) {
    const raw = String(ref ?? '').trim()
    if (!raw) return { ok: false, code: 'MEMBER_REQUIRED', error: '缺少成员 QQ 号或名字。' }
    if (isQqId(raw)) {
      const found = members.find(member => member.qq === raw)
      if (found) return { ok: true, member: found }
      if (!requireMember) {
        return { ok: true, member: normalizeMember({ user_id: raw, nickname: '', card: '' }) }
      }
      return { ok: false, code: 'MEMBER_NOT_FOUND', error: `群成员里没有找到 QQ ${raw}。` }
    }
    const exact = matchMembers(members, raw, 'exact')
    if (exact.length === 1) return { ok: true, member: exact[0] }
    if (exact.length > 1) {
      return { ok: false, code: 'MEMBER_AMBIGUOUS', error: `「${raw}」精确匹配到多个成员，请改用 QQ 号。`, candidates: exact.slice(0, 10).map(publicMember) }
    }
    const fuzzy = matchMembers(members, raw, 'fuzzy')
    if (fuzzy.length === 1) return { ok: true, member: fuzzy[0] }
    if (fuzzy.length > 1) {
      return { ok: false, code: 'MEMBER_AMBIGUOUS', error: `「${raw}」模糊匹配到多个成员，请改用 QQ 号。`, candidates: fuzzy.slice(0, 10).map(publicMember) }
    }
    return { ok: false, code: 'MEMBER_NOT_FOUND', error: `群里没有找到「${raw}」。`, candidates: [] }
  }

  async function resolveTargetMember(target, args, { requireMember = true, refresh = false } = {}) {
    const ref = args?.qq || args?.name || args?.target || args?.keyword
    const members = await fetchMembers(target, { refresh: refresh || args?.refresh === true })
    if (!members.ok) return members
    const picked = pickMemberFromList(members.members, ref, { requireMember })
    if (!picked.ok) return picked
    return { ok: true, member: picked.member, members: members.members, cached: members.cached }
  }

  async function botRoleOf(target) {
    const botQq = botQqOf(target)
    if (!botQq) return ''
    const members = await fetchMembers(target, {})
    if (!members.ok) return ''
    return members.members.find(member => member.qq === botQq)?.role || ''
  }

  /** 用缓存的成员列表预检机器人权限；拿不到列表时交给 NapCat 自己报错。 */
  async function requireBotRole(target, level = 'admin') {
    const role = await botRoleOf(target)
    if (!role) return { ok: true }
    if (level === 'owner' && role !== 'owner') {
      return { ok: false, code: 'BOT_NOT_OWNER', error: '该操作只有群主可以执行（当前机器人不是群主）。' }
    }
    if (level === 'admin' && role !== 'owner' && role !== 'admin') {
      return { ok: false, code: 'BOT_NOT_ADMIN', error: '该操作需要机器人是群管理员或群主。' }
    }
    return { ok: true }
  }

  function guardMember(target, member, { allowSelf = false, allowOwner = false } = {}) {
    const botQq = botQqOf(target)
    if (!allowSelf && botQq && String(member.qq) === botQq) {
      return { ok: false, code: 'GUARD_SELF', error: '出于安全考虑，不能对机器人自己执行该操作。' }
    }
    if (!allowOwner && member.role === 'owner') {
      return { ok: false, code: 'GUARD_OWNER', error: '对方是群主，无法执行该操作。' }
    }
    if (protectedUsers().includes(String(member.qq))) {
      return { ok: false, code: 'GUARD_PROTECTED', error: `${member.display}(${member.qq}) 在保护名单中，已拒绝。` }
    }
    return { ok: true }
  }

  /* ---------------- 发送与落库 ---------------- */

  function recordOutbound(target, content, meta = {}) {
    const conversationId = String(target?.channel?.meta?.conversationId || '')
    if (!conversationId || typeof store?.append !== 'function') return null
    const conv = sessions.get(conversationId)
    if (!conv) return null
    try {
      return store.append(conversationId, {
        role: 'assistant',
        content: String(content ?? ''),
        sender_id: `role_${conversationId}`,
        sender_name: conv.name || '助手',
        is_bot: true,
        source: 'nova',
        visibility: 'shareable',
        meta: {
          via: 'group-chat-tools',
          // direction=outbound 让 channel-base 不会把这条记录再外发一次。
          direction: 'outbound',
          napcatInstanceId: target.instanceId,
          napcatGroupId: target.groupId,
          ...meta,
        },
      })
    } catch (err) {
      ctx.logger.debug(`[group-chat-tools] 发送记录落库失败：${err?.message || err}`)
      return null
    }
  }

  async function sendGroupSegments(target, segments, meta = {}) {
    const result = await callOneBot(target.instanceId, 'send_group_msg', {
      group_id: target.groupId,
      message: segments,
    })
    if (!result.ok) return result
    const messageId = String(result.data?.message_id ?? result.data?.messageId ?? '')
    return { ok: true, messageId, raw: result.data, meta }
  }

  const pushText = (text, hasAt) => {
    const value = String(text ?? '')
    if (!value) return null
    if (!hasAt) return { type: 'text', data: { text: value } }
    const sep = /^[\s，,。.！!？?、:：]/.test(value) ? '' : ' '
    return { type: 'text', data: { text: `${sep}${value}` } }
  }

  /* ---------------- 资料字段 ---------------- */

  function parseFields(value) {
    const out = new Set()
    let all = false
    const list = Array.isArray(value) ? value : String(value ?? '').split(/[,，、;；\s]+/)
    for (const item of list) {
      const key = String(item ?? '').trim().toLowerCase()
      if (!key) continue
      if (key === 'all') all = true
      else if (FIELD_KEYS.includes(key)) out.add(key)
    }
    if (all) return new Set(FIELD_KEYS)
    if (!out.size) ['basic', 'signature', 'qq_level', 'group_member'].forEach(key => out.add(key))
    return out
  }

  function summarizeHonor(data, qq) {
    const sources = [
      ['current_talkative', '当前龙王'],
      ['talkative_list', '龙王'],
      ['performer_list', '群聊之火'],
      ['legend_list', '群聊炽焰'],
      ['strong_newbie_list', '冒尖小春笋'],
      ['emotion_list', '快乐源泉'],
    ]
    const hits = []
    for (const [key, label] of sources) {
      const value = data?.[key]
      const list = key === 'current_talkative' ? (value ? [value] : []) : Array.isArray(value) ? value : []
      for (const item of list) {
        const userId = String(item?.user_id ?? item?.uin ?? item?.userId ?? '')
        if (userId !== String(qq)) continue
        hits.push(compact({ type: label, description: String(item?.description ?? item?.desc ?? '').slice(0, 120) || undefined }))
      }
    }
    return hits.length ? hits : [{ type: 'none', description: '暂无群荣誉记录' }]
  }

  function summarizeLikes(data) {
    if (!data || typeof data !== 'object') return { supported: false, note: '没有返回数据' }
    const favorite = data.favoriteInfo || data.favorite_info || {}
    const vote = data.voteInfo || data.vote_info || {}
    const users = source =>
      (Array.isArray(source) ? source : [])
        .slice(0, 5)
        .map(item => compact({ qq: String(item?.uin ?? item?.user_id ?? ''), nickname: String(item?.nick ?? item?.nickname ?? '') }))
        .filter(item => item.qq || item.nickname)
    const countOf = obj => Number(obj?.totalCount ?? obj?.total_count ?? obj?.count ?? 0) || (Array.isArray(obj?.userInfos) ? obj.userInfos.length : 0)
    const likedUsers = users(favorite.userInfos || favorite.user_infos)
    const votedUsers = users(vote.userInfos || vote.user_infos)
    return compact({
      like_count: countOf(favorite) || undefined,
      liked_users: likedUsers.length ? likedUsers : undefined,
      vote_count: countOf(vote) || undefined,
      vote_users: votedUsers.length ? votedUsers : undefined,
    })
  }

  /* ---------------- 工具 1：群成员与资料 ---------------- */

  async function toolMember(args, context) {
    if (!enabled()) return disabledResult()
    const action = String(args?.action || 'search').trim() || 'search'
    const resolved = await resolveGroupTarget(args?.group, context)
    if (!resolved.ok) return resolved
    const target = resolved.target
    const auth = await authorizeTarget('read', context, target)
    if (!auth.ok) return auth

    if (action === 'info') return memberInfo(args, target)
    if (action !== 'search') return { ok: false, error: 'action 只支持 search / info。' }

    const fetched = await fetchMembers(target, { refresh: args?.refresh === true })
    if (!fetched.ok) return { ok: false, code: fetched.code, error: fetched.error }
    const members = fetched.members
    const limit = clampNum(args?.limit, 1, 50, Math.min(10, maxResults()))
    const offset = Math.max(0, Number(args?.offset) || 0)
    const mode = ['auto', 'exact', 'fuzzy'].includes(args?.match) ? args.match : 'auto'
    const keyword = String(args?.keyword ?? '').trim()
    const summary = {
      total: members.length,
      owners: members.filter(member => member.role === 'owner').length,
      admins: members.filter(member => member.role === 'admin').length,
      muted: members.filter(member => member.muted).length,
      robots: members.filter(member => member.is_robot).length,
    }
    const base = { ok: true, group: { id: target.groupId, name: target.name }, cached: fetched.cached, summary }

    if (!keyword) {
      const page = members.slice(offset, offset + limit)
      return {
        ...base,
        keyword: '',
        total: members.length,
        returned: page.length,
        members: page.map(publicMember),
        hint: 'keyword 为空时返回成员摘要；可传关键词按群名片 / QQ昵称 / QQ号 精确或模糊查找。',
      }
    }
    const matched = matchMembers(members, keyword, mode)
    const page = matched.slice(offset, offset + limit)
    const result = {
      ...base,
      keyword,
      match: mode,
      total: matched.length,
      returned: page.length,
      members: page.map(member => ({ ...publicMember(member), match_score: member._score })),
    }
    if (!matched.length) result.hint = '没有匹配到成员；可换更短的关键词，或 match=fuzzy。'
    else if (matched.length > 1) result.hint = '有多个匹配；艾特或管理时请直接使用返回的 QQ 号，避免歧义。'
    return result
  }

  async function memberInfo(args, target) {
    const fields = parseFields(args?.fields)
    let qq = String(args?.qq ?? '').trim()
    const name = String(args?.name ?? '').trim()
    let member = null
    if (!qq && name) {
      const fetched = await fetchMembers(target, { refresh: args?.refresh === true })
      if (!fetched.ok) return { ok: false, code: fetched.code, error: fetched.error }
      const picked = pickMemberFromList(fetched.members, name, { requireMember: true })
      if (!picked.ok) return picked
      qq = picked.member.qq
      member = picked.member
    }
    if (!isQqId(qq)) return { ok: false, error: '请提供精确的 QQ 号（qq），或在群里用一个唯一成员名（name）。' }

    const notes = []
    const needStranger = ['basic', 'signature', 'qq_level', 'vip', 'friend', 'status'].some(key => fields.has(key))
    const needMember = fields.has('group_member')
    const needHonor = fields.has('honor')
    const needLikes = fields.has('likes')

    let stranger = null
    if (needStranger) {
      const result = await callOneBot(target.instanceId, 'get_stranger_info', { user_id: qq, no_cache: true })
      if (result.ok) stranger = result.data || {}
      else notes.push(`QQ 资料：${result.error}`)
    }
    if (needMember && !member) {
      const result = await callOneBot(target.instanceId, 'get_group_member_info', { group_id: target.groupId, user_id: qq, no_cache: true })
      if (result.ok) member = normalizeMember(result.data)
      else notes.push(`群成员资料：${result.error}`)
    }

    const user = { qq }
    if (fields.has('basic')) {
      user.nickname = String(stranger?.nickname ?? member?.nickname ?? '').trim() || undefined
      user.display = member?.display || user.nickname || qq
      user.avatar = qqAvatarUrl(qq)
      const sex = String(stranger?.sex ?? member?.sex ?? '')
      user.sex = sex && sex !== 'unknown' ? sex : undefined
      user.age = Number(stranger?.age ?? member?.age) || undefined
      user.qid = stranger?.qid || undefined
      user.remark = stranger?.remark || undefined
    }
    if (fields.has('signature')) user.signature = String(stranger?.long_nick ?? stranger?.longNick ?? '').trim() || undefined
    if (fields.has('qq_level')) user.qq_level = Number(stranger?.qqLevel ?? stranger?.qq_level ?? member?.qq_level) || undefined
    if (fields.has('vip')) {
      const vip = compact({
        is_vip: stranger?.is_vip ?? stranger?.isVip,
        is_years_vip: stranger?.is_years_vip ?? stranger?.isYearsVip,
        level: Number(stranger?.vip_level ?? stranger?.vipLevel) || undefined,
      })
      if (Object.keys(vip).length) user.vip = vip
    }
    if (fields.has('group_member')) {
      user.group_member = member
        ? compact({
            card: member.card || undefined,
            role: member.role,
            title: member.title || undefined,
            group_level: member.level || undefined,
            join_time: fmtTime(member.join_time) || undefined,
            last_sent_time: fmtTime(member.last_sent_time) || undefined,
            muted_until: member.muted ? fmtTime(member.shut_up_timestamp) : undefined,
          })
        : undefined
      if (!user.group_member) notes.push('群成员资料：目标不在本群或 NapCat 没有返回。')
    }
    if (fields.has('friend')) {
      const result = await callOneBot(target.instanceId, 'get_friend_list', {})
      let friend = null
      if (result.ok && Array.isArray(result.data)) {
        friend = result.data.find(item => String(item?.user_id ?? item?.userId ?? '') === qq) || null
      }
      const remark = String(friend?.remark ?? stranger?.remark ?? '').trim()
      const friendNick = String(friend?.nickname ?? '').trim()
      if (remark || friendNick) user.friend = compact({ nickname: friendNick || undefined, remark: remark || undefined })
    }
    if (needHonor) {
      const result = await callOneBot(target.instanceId, 'get_group_honor_info', { group_id: target.groupId, type: 'all' })
      if (result.ok) user.honor = summarizeHonor(result.data, qq)
      else notes.push(`群荣誉：${result.error}`)
    }
    if (needLikes) {
      const result = await callOneBot(target.instanceId, 'get_profile_like', { user_id: qq, start: 0, count: 10 })
      user.likes = result.ok ? summarizeLikes(result.data) : { supported: false, note: result.error }
    }
    if (fields.has('status')) {
      const result = await callOneBotFallback(target.instanceId, ['nc_get_user_status', 'get_user_status'], { user_id: qq })
      if (result.ok && result.data !== null && result.data !== undefined) user.status = truncatePayload(result.data, 600)
      else user.status = { supported: false, note: result.ok ? '接口没有返回数据（部分 NapCat 需要 packetBackend）' : result.error }
    }
    if (fields.has('space')) {
      user.space = {
        url: qzoneUrl(qq),
        note: '可把空间主页链接发给用户查看。',
      }
    }
    const payload = {
      ok: true,
      group: { id: target.groupId, name: target.name },
      user,
      fields: [...fields],
      hint: 'fields=all 可拉取全部可查字段。',
    }
    if (notes.length) payload.notes = notes
    return payload
  }

  /* ---------------- 工具 2：群内发言增强 ---------------- */

  async function toolSend(args, context) {
    if (!enabled()) return disabledResult()
    const action = String(args?.action || 'at').trim() || 'at'
    const resolved = await resolveGroupTarget(args?.group, context)
    if (!resolved.ok) return resolved
    const target = resolved.target
    const auth = await authorizeTarget('send', context, target)
    if (!auth.ok) return auth
    const text = String(args?.text ?? '')
    const replyTo = String(args?.reply_to ?? '').trim()

    if (action === 'at') {
      const rawTargets = Array.isArray(args?.targets) ? args.targets : args?.targets ? [args.targets] : []
      if (!rawTargets.length) return { ok: false, error: 'action=at 需要 targets：QQ 号或成员名，可以传多个。' }
      const wanted = rawTargets.slice(0, MAX_TARGETS)
      const refOf = item =>
        typeof item === 'string' || typeof item === 'number' ? String(item) : String(item?.qq ?? item?.name ?? item?.target ?? '')
      // 纯 QQ 号不需要先拉成员列表；只有按名字找人才查询群成员。
      const needLookup = wanted.some(item => !isQqId(refOf(item)))
      let memberList = []
      let cached = false
      if (needLookup) {
        const fetched = await fetchMembers(target, { refresh: args?.refresh === true })
        if (!fetched.ok) return { ok: false, code: fetched.code, error: fetched.error }
        memberList = fetched.members
        cached = fetched.cached
      }
      const members = []
      for (const item of wanted) {
        const ref = refOf(item)
        if (isQqId(ref)) {
          const found = memberList.find(member => member.qq === ref)
          members.push(found || { ...normalizeMember({ user_id: ref, nickname: '', card: '' }), display: found?.display || ref })
          continue
        }
        const picked = pickMemberFromList(memberList, ref, { requireMember: false })
        if (!picked.ok) {
          return {
            ...picked,
            hint: '为了避免 @ 错人，本次没有发送任何消息；请依据 candidates 用精确 QQ 号重试。',
          }
        }
        members.push(picked.member)
      }
      const segments = []
      if (replyTo && /^\d+$/.test(replyTo)) segments.push({ type: 'reply', data: { id: replyTo } })
      for (const member of members) segments.push({ type: 'at', data: { qq: member.qq } })
      const textSegment = pushText(text, true)
      if (textSegment) segments.push(textSegment)
      const sent = await sendGroupSegments(target, segments)
      if (!sent.ok) return sent
      const display = `${members.map(member => `@${member.display}`).join(' ')}${text ? ` ${text}` : ''}`
      recordOutbound(target, display, { mentions: members.map(member => ({ qq: member.qq, name: member.display })), napcatMessageId: sent.messageId })
      emitAction('at', { groupId: target.groupId, mentions: members.map(member => member.qq), messageId: sent.messageId })
      return {
        ok: true,
        action,
        group: { id: target.groupId, name: target.name },
        message_id: sent.messageId,
        mentioned: members.map(publicMember),
        cached,
        text,
      }
    }

    if (action === 'at_all') {
      if (!text.trim()) return { ok: false, error: 'action=at_all 需要 text 作为 @全体成员 后要说的内容。' }
      const remain = await callOneBot(target.instanceId, 'get_group_at_all_remain', { group_id: target.groupId }, { silent: true })
      if (remain.ok && remain.data?.can_at_all === false) {
        return { ok: false, error: '当前账号没有 @全体成员 权限，或今天的次数已用完。', remain: remain.data }
      }
      const segments = []
      if (replyTo && /^\d+$/.test(replyTo)) segments.push({ type: 'reply', data: { id: replyTo } })
      segments.push({ type: 'at', data: { qq: 'all' } })
      segments.push({ type: 'text', data: { text: ` ${text}` } })
      const sent = await sendGroupSegments(target, segments)
      if (!sent.ok) return sent
      recordOutbound(target, `@全体成员 ${text}`, { mentionAll: true, napcatMessageId: sent.messageId })
      emitAction('at_all', { groupId: target.groupId, messageId: sent.messageId })
      return {
        ok: true,
        action,
        group: { id: target.groupId, name: target.name },
        message_id: sent.messageId,
        text,
        remain: remain.ok ? remain.data : undefined,
      }
    }

    if (action === 'music') {
      const music = args?.music && typeof args.music === 'object' ? args.music : {}
      const type = String(music.type || 'qq').trim()
      const platforms = ['qq', '163', 'kugou', 'kuwo', 'migu']
      if (platforms.includes(type)) {
        if (!music.id) return { ok: false, error: '音乐卡片需要 music.id（歌曲 ID）。' }
      } else if (type === 'custom') {
        if (!music.url || !music.image) return { ok: false, error: '自定义音乐卡片需要 music.url 与 music.image。' }
      } else {
        return { ok: false, error: 'music.type 只支持 qq / 163 / kugou / kuwo / migu / custom。' }
      }
      const data = compact({
        type,
        id: music.id !== undefined ? String(music.id) : undefined,
        url: music.url || undefined,
        audio: music.audio || undefined,
        title: music.title || undefined,
        content: music.content || undefined,
        image: music.image || undefined,
      })
      const sent = await sendGroupSegments(target, [{ type: 'music', data }])
      if (!sent.ok) return sent
      const title = String(music.title || music.content || music.id || '音乐卡片')
      recordOutbound(target, `[音乐卡片] ${title}`, { music: data, napcatMessageId: sent.messageId })
      emitAction('music', { groupId: target.groupId, messageId: sent.messageId })
      return { ok: true, action, group: { id: target.groupId, name: target.name }, message_id: sent.messageId, music: data }
    }

    return { ok: false, error: 'action 只支持 at / at_all / music。' }
  }

  /* ---------------- 工具 3：群管理 ---------------- */

  async function toolManage(args, context) {
    if (!enabled()) return disabledResult()
    const action = String(args?.action || '').trim()
    if (!action) return { ok: false, error: '缺少 action。' }
    if (action === 'raw') {
      if (!allowRawAction()) return { ok: false, error: 'raw 透传未开启：请在插件设置中允许「任意 OneBot action 透传」。' }
    } else if (!allowManage()) {
      return { ok: false, error: '管理类操作已关闭：请在插件设置中开启「允许管理类操作」。' }
    }
    const resolved = await resolveGroupTarget(args?.group, context)
    if (!resolved.ok) return resolved
    const target = resolved.target
    const auth = await authorizeTarget('send', context, target)
    if (!auth.ok) return auth

    switch (action) {
      case 'mute':
      case 'unmute': {
        const picked = await resolveTargetMember(target, args, { requireMember: true })
        if (!picked.ok) return picked
        const guard = guardMember(target, picked.member)
        if (!guard.ok) return guard
        const permission = await requireBotRole(target, 'admin')
        if (!permission.ok) return permission
        const duration = action === 'unmute' ? 0 : parseBanDuration(args?.duration)
        if (duration === null) return { ok: false, error: '禁言时长格式不对：支持数字秒数（60）、90秒、1分钟、5分钟、1.5小时、1小时30分钟、三分钟、2天；0 或 unmute 表示解除（QQ 上限 30 天）。' }
        const result = await callOneBot(target.instanceId, 'set_group_ban', {
          group_id: target.groupId,
          user_id: picked.member.qq,
          duration,
        })
        if (!result.ok) return result
        const message = duration > 0
          ? `已禁言 ${picked.member.display}(${picked.member.qq}) ${humanDuration(duration)}。`
          : `已解除 ${picked.member.display}(${picked.member.qq}) 的禁言。`
        ctx.logger.info(`[group-chat-tools] ${message}`)
        emitAction('mute', { groupId: target.groupId, qq: picked.member.qq, duration })
        return { ok: true, action, message, user: publicMember(picked.member), duration, duration_text: humanDuration(duration) }
      }

      case 'mute_all': {
        if (args?.enable === undefined) return { ok: false, error: 'action=mute_all 需要 enable=true/false 指定开启或关闭全员禁言。' }
        const permission = await requireBotRole(target, 'admin')
        if (!permission.ok) return permission
        const enable = args.enable !== false && args.enable !== 'false'
        const result = await callOneBot(target.instanceId, 'set_group_whole_ban', { group_id: target.groupId, enable })
        if (!result.ok) return result
        emitAction('mute_all', { groupId: target.groupId, enable })
        return { ok: true, action, message: enable ? '已开启全员禁言。' : '已关闭全员禁言。', enable }
      }

      case 'kick': {
        const picked = await resolveTargetMember(target, args, { requireMember: true })
        if (!picked.ok) return picked
        const guard = guardMember(target, picked.member)
        if (!guard.ok) return guard
        const permission = await requireBotRole(target, 'admin')
        if (!permission.ok) return permission
        const rejectAdd = args?.reject_add === true || args?.reject_add === 'true'
        const result = await callOneBot(target.instanceId, 'set_group_kick', {
          group_id: target.groupId,
          user_id: picked.member.qq,
          reject_add_request: rejectAdd,
        })
        if (!result.ok) return result
        const message = `已将 ${picked.member.display}(${picked.member.qq}) 移出群聊${rejectAdd ? '，并拒绝其再次加群' : ''}。`
        ctx.logger.info(`[group-chat-tools] ${message}`)
        emitAction('kick', { groupId: target.groupId, qq: picked.member.qq, rejectAdd })
        return { ok: true, action, message, user: publicMember(picked.member), reject_add: rejectAdd }
      }

      case 'set_card': {
        const picked = await resolveTargetMember(target, args, { requireMember: true })
        if (!picked.ok) return picked
        const guard = guardMember(target, picked.member, { allowSelf: true })
        if (!guard.ok) return guard
        const permission = await requireBotRole(target, 'admin')
        if (!permission.ok) return permission
        const card = String(args?.card ?? '').slice(0, 60)
        const result = await callOneBot(target.instanceId, 'set_group_card', {
          group_id: target.groupId,
          user_id: picked.member.qq,
          card,
        })
        if (!result.ok) return result
        emitAction('set_card', { groupId: target.groupId, qq: picked.member.qq, card })
        return { ok: true, action, message: card ? `已将 ${picked.member.display}(${picked.member.qq}) 的群名片改为「${card}」。` : `已清除 ${picked.member.display}(${picked.member.qq}) 的群名片。` }
      }

      case 'set_title': {
        const picked = await resolveTargetMember(target, args, { requireMember: true })
        if (!picked.ok) return picked
        const guard = guardMember(target, picked.member)
        if (!guard.ok) return guard
        const permission = await requireBotRole(target, 'owner')
        if (!permission.ok) return permission
        const title = String(args?.title ?? '').slice(0, 18)
        const result = await callOneBot(target.instanceId, 'set_group_special_title', {
          group_id: target.groupId,
          user_id: picked.member.qq,
          special_title: title,
        })
        if (!result.ok) return result
        emitAction('set_title', { groupId: target.groupId, qq: picked.member.qq, title })
        return { ok: true, action, message: title ? `已将 ${picked.member.display}(${picked.member.qq}) 的专属头衔设为「${title}」。` : `已清除 ${picked.member.display}(${picked.member.qq}) 的专属头衔。` }
      }

      case 'set_admin': {
        const picked = await resolveTargetMember(target, args, { requireMember: true })
        if (!picked.ok) return picked
        const guard = guardMember(target, picked.member)
        if (!guard.ok) return guard
        const permission = await requireBotRole(target, 'owner')
        if (!permission.ok) return permission
        const enable = args?.enable !== false && args?.enable !== 'false'
        const result = await callOneBot(target.instanceId, 'set_group_admin', {
          group_id: target.groupId,
          user_id: picked.member.qq,
          enable,
        })
        if (!result.ok) return result
        emitAction('set_admin', { groupId: target.groupId, qq: picked.member.qq, enable })
        return { ok: true, action, message: enable ? `已将 ${picked.member.display}(${picked.member.qq}) 设为管理员。` : `已取消 ${picked.member.display}(${picked.member.qq}) 的管理员。`, enable }
      }

      case 'recall': {
        const messageId = String(args?.message_id ?? '').trim()
        if (!/^\d+$/.test(messageId)) return { ok: false, error: 'action=recall 需要 message_id（消息 ID，可在上下文消息的 meta.message_id 里找到）。' }
        const result = await callOneBot(target.instanceId, 'delete_msg', { message_id: messageId })
        if (!result.ok) return result
        emitAction('recall', { groupId: target.groupId, messageId })
        return { ok: true, action, message: `已尝试撤回消息 ${messageId}（只有机器人自己发送的或管理员可撤回的消息会成功）。` }
      }

      case 'sign': {
        const result = await callOneBotFallback(target.instanceId, ['send_group_sign', 'set_group_sign'], { group_id: target.groupId })
        if (!result.ok) return result
        emitAction('sign', { groupId: target.groupId })
        return { ok: true, action, message: '已完成群打卡。' }
      }

      case 'poke': {
        const picked = await resolveTargetMember(target, args, { requireMember: true })
        if (!picked.ok) return picked
        const guard = guardMember(target, picked.member, { allowSelf: true, allowOwner: true })
        if (!guard.ok) return guard
        const result = await callOneBot(target.instanceId, 'group_poke', { group_id: target.groupId, target_id: picked.member.qq })
        if (!result.ok) return { ...result, hint: '戳一戳依赖 NapCat packetBackend；可在 NapCat 高级配置里检查。' }
        emitAction('poke', { groupId: target.groupId, qq: picked.member.qq })
        return { ok: true, action, message: `已戳了戳 ${picked.member.display}(${picked.member.qq})。` }
      }

      case 'raw': {
        const onebotAction = String(args?.onebot_action || '').trim()
        if (!onebotAction) return { ok: false, error: 'action=raw 需要 onebot_action。' }
        const blocked = new Set(['bot_exit', 'set_restart', 'clean_cache', 'set_qq_profile', 'set_qq_avatar', 'delete_friend'])
        if (blocked.has(onebotAction)) return { ok: false, error: `出于安全考虑，raw 透传不允许调用 ${onebotAction}。` }
        let params = args?.raw_params
        if (typeof params === 'string' && params.trim()) {
          try {
            params = JSON.parse(params)
          } catch (_) {
            return { ok: false, error: 'raw_params 不是合法 JSON。' }
          }
        }
        if (!params || typeof params !== 'object' || Array.isArray(params)) params = {}
        const result = await callOneBot(target.instanceId, onebotAction, params)
        if (!result.ok) return result
        emitAction('raw', { groupId: target.groupId, onebotAction })
        return { ok: true, action, onebot_action: onebotAction, data: truncatePayload(result.data, 3000) }
      }

      default:
        return { ok: false, error: '不支持的 action：支持 mute / unmute / mute_all / kick / set_card / set_title / set_admin / recall / sign / poke / raw。' }
    }
  }

  /* ---------------- 工具 4：群公告 ---------------- */

  function noticeOptions(params) {
    const source = params && typeof params === 'object' ? params : {}
    const alias = { confirm: 'confirm_required', popup: 'tip_window_type', show_edit_card: 'is_show_edit_card' }
    const out = {}
    // 已知别名统一成 NapCat 的字段名；其余键原样透传，
    // 这样 NapCat 新版本增加公告参数（如推送新成员等）时无需改插件。
    for (const [key, value] of Object.entries(source)) {
      if (value === undefined || value === null) continue
      out[alias[key] || key] = value === true ? 1 : value === false ? 0 : value
    }
    return out
  }

  function normalizeNotice(raw, index) {
    const message = raw?.message && typeof raw.message === 'object' ? raw.message : {}
    const text = String(message.text ?? (typeof raw?.message === 'string' ? raw.message : '') ?? '').trim()
    const images = Array.isArray(message.images) ? message.images : Array.isArray(message.image) ? message.image : []
    return compact({
      index,
      notice_id: String(raw?.notice_id ?? raw?.noticeId ?? ''),
      sender_id: String(raw?.sender_id ?? raw?.senderId ?? ''),
      publish_time: fmtTime(raw?.publish_time ?? raw?.publishTime ?? 0) || undefined,
      text: text || undefined,
      images: images.length ? images.slice(0, 4).map(image => ({ id: image?.id, width: image?.width ?? image?.w, height: image?.height ?? image?.h })) : undefined,
      read_num: Number(raw?.read_num ?? raw?.readNum ?? 0) || undefined,
      settings: raw?.settings !== undefined ? truncatePayload(raw.settings, 400) : undefined,
    })
  }

  async function fetchNotices(target) {
    const result = await callOneBotFallback(target.instanceId, ['_get_group_notice', 'get_group_notice'], { group_id: target.groupId })
    if (!result.ok) return result
    const notices = (Array.isArray(result.data) ? result.data : []).map((item, index) => normalizeNotice(item, index + 1))
    NOTICE_CACHE.set(target.groupId, { at: Date.now(), notices })
    return { ok: true, notices }
  }

  async function toolNotice(args, context) {
    if (!enabled()) return disabledResult()
    const action = String(args?.action || '').trim()
    if (!action) return { ok: false, error: '缺少 action。' }
    if (!['send', 'get', 'delete', 'edit'].includes(action)) return { ok: false, error: 'action 只支持 send / get / delete / edit。' }
    if ((action === 'send' || action === 'delete' || action === 'edit') && !allowManage()) {
      return { ok: false, error: '公告发布 / 删除 / 编辑属于管理操作，当前已在插件设置中关闭。' }
    }
    const resolved = await resolveGroupTarget(args?.group, context)
    if (!resolved.ok) return resolved
    const target = resolved.target
    const auth = await authorizeTarget(action === 'get' ? 'read' : 'send', context, target)
    if (!auth.ok) return auth

    if (action === 'get') {
      const fetched = await fetchNotices(target)
      if (!fetched.ok) return fetched
      return {
        ok: true,
        action,
        group: { id: target.groupId, name: target.name },
        count: fetched.notices.length,
        notices: fetched.notices.slice(0, 20),
        hint: 'delete / edit 可以按 notice_id、index（上面的序号）或 keyword 定位公告。',
      }
    }

    if (action === 'send') {
      const content = String(args?.content ?? '').trim()
      if (!content) return { ok: false, error: 'action=send 需要 content（公告正文）。' }
      const role = await botRoleOf(target)
      if (role === 'member') return { ok: false, error: '发布群公告需要机器人是群管理员或群主。' }
      // 先展开透传参数，再覆盖 group_id / content，防止模型用 params 覆盖目标群绕过授权。
      const params = { ...noticeOptions(args?.params), group_id: target.groupId, content }
      if (args?.image) params.image = String(args.image)
      const result = await callOneBotFallback(target.instanceId, ['_send_group_notice', 'send_group_notice'], params)
      if (!result.ok) return result
      emitAction('notice_send', { groupId: target.groupId, pinned: params.pinned === 1, popup: params.tip_window_type === 1 })
      return {
        ok: true,
        action,
        group: { id: target.groupId, name: target.name },
        flag: 'notice_sent',
        content,
        params: noticeOptions(args?.params),
      }
    }

    const resolveNoticeId = async () => {
      let noticeId = String(args?.notice_id ?? '').trim()
      let matched = ''
      let notices = NOTICE_CACHE.get(target.groupId)?.notices
      if (!noticeId && (args?.index !== undefined || args?.keyword)) {
        if (!notices) {
          const fetched = await fetchNotices(target)
          if (!fetched.ok) return { ok: false, error: fetched.error }
          notices = fetched.notices
        }
        if (args?.index !== undefined) {
          const index = Number(args.index)
          const hit = notices.find(item => item.index === index)
          if (hit?.notice_id) {
            noticeId = hit.notice_id
            matched = `序号 ${index}`
          }
        }
        if (!noticeId && args?.keyword) {
          const key = String(args.keyword).trim().toLowerCase()
          const hit = notices.find(item => String(item.text || '').toLowerCase().includes(key))
          if (hit?.notice_id) {
            noticeId = hit.notice_id
            matched = `关键词「${args.keyword}」`
          }
        }
      }
      if (!noticeId) return { ok: false, error: '没有定位到公告：请提供 notice_id，或先 get 再用 index / keyword。' }
      return { ok: true, noticeId, matched }
    }

    if (action === 'delete') {
      const located = await resolveNoticeId()
      if (!located.ok) return located
      const result = await callOneBotFallback(target.instanceId, ['_del_group_notice', 'del_group_notice'], {
        group_id: target.groupId,
        notice_id: located.noticeId,
      })
      if (!result.ok) return result
      const cached = NOTICE_CACHE.get(target.groupId)
      if (cached) cached.notices = cached.notices.filter(item => item.notice_id !== located.noticeId)
      emitAction('notice_delete', { groupId: target.groupId, noticeId: located.noticeId })
      return { ok: true, action, message: `已删除群公告${located.matched ? `（${located.matched}）` : ''}。`, notice_id: located.noticeId }
    }

    if (action === 'edit') {
      const content = String(args?.content ?? '').trim()
      if (!content) return { ok: false, error: 'action=edit 需要 content（新的公告正文）。QQ 没有原地编辑接口，这里会删除旧公告并按新参数重发。' }
      const located = await resolveNoticeId()
      if (!located.ok) return located
      const removed = await callOneBotFallback(target.instanceId, ['_del_group_notice', 'del_group_notice'], {
        group_id: target.groupId,
        notice_id: located.noticeId,
      })
      if (!removed.ok) return { ok: false, error: `删除旧公告失败，未发布新公告：${removed.error}` }
      const params = { ...noticeOptions(args?.params), group_id: target.groupId, content }
      if (args?.image) params.image = String(args.image)
      const published = await callOneBotFallback(target.instanceId, ['_send_group_notice', 'send_group_notice'], params)
      if (!published.ok) return { ok: false, error: `旧公告已删除，但发布新公告失败：${published.error}` }
      const cached = NOTICE_CACHE.get(target.groupId)
      if (cached) cached.notices = cached.notices.filter(item => item.notice_id !== located.noticeId)
      emitAction('notice_edit', { groupId: target.groupId, oldNoticeId: located.noticeId })
      return { ok: true, action, message: '已删除旧公告并发布新公告（QQ 的“编辑”只能这样实现）。', old_notice_id: located.noticeId, content }
    }

    return { ok: false, error: 'action 只支持 send / get / delete / edit。' }
  }

  /* ---------------- 工具 5：群信息与只读查询 ---------------- */

  function normalizeGroupInfo(...sources) {
    const pick = keys => {
      for (const source of sources) {
        if (!source || typeof source !== 'object') continue
        for (const key of keys) {
          const value = source[key]
          if (value !== undefined && value !== null && value !== '') return value
        }
      }
      return undefined
    }
    const shutAll = pick(['shutUpAllTimestamp', 'group_all_shut', 'shut_up_all_timestamp'])
    return compact({
      group_id: pick(['group_id', 'groupCode', 'groupId']),
      group_name: pick(['group_name', 'groupName']),
      member_count: pick(['member_count', 'memberNum']),
      max_member_count: pick(['max_member_count', 'maxMemberNum']),
      group_remark: pick(['group_remark', 'groupRemark']),
      group_class: pick(['groupClass', 'group_class']),
      group_grade: pick(['groupGrade', 'group_grade']),
      create_time: fmtTime(pick(['groupCreateTime', 'createTime', 'create_time'])) || undefined,
      whole_muted: Number(shutAll) > 0 ? true : shutAll === undefined ? undefined : false,
      whole_muted_until: Number(shutAll) > 1e9 ? fmtTime(Number(shutAll)) : undefined,
    })
  }

  async function toolInfo(args, context) {
    if (!enabled()) return disabledResult()
    const action = String(args?.action || '').trim()
    if (!action) return { ok: false, error: '缺少 action。' }
    if (!['info', 'honor', 'muted', 'at_all_remain', 'requests', 'handle_request'].includes(action)) {
      return { ok: false, error: 'action 只支持 info / honor / muted / at_all_remain / requests / handle_request。' }
    }
    const resolved = await resolveGroupTarget(args?.group, context)
    if (!resolved.ok) return resolved
    const target = resolved.target
    const auth = await authorizeTarget(action === 'handle_request' ? 'send' : 'read', context, target)
    if (!auth.ok) return auth

    if (action === 'info') {
      const [basic, detail] = await Promise.all([
        callOneBot(target.instanceId, 'get_group_info', { group_id: target.groupId }),
        callOneBot(target.instanceId, 'get_group_detail_info', { group_id: target.groupId }),
      ])
      if (!basic.ok && !detail.ok) return { ok: false, error: basic.error || detail.error }
      const info = normalizeGroupInfo(basic.ok ? basic.data : null, detail.ok ? detail.data : null)
      return { ok: true, action, group: { id: target.groupId, name: target.name }, info }
    }

    if (action === 'honor') {
      const result = await callOneBot(target.instanceId, 'get_group_honor_info', { group_id: target.groupId, type: 'all' })
      if (!result.ok) return result
      const data = result.data || {}
      const take = (list, label) =>
        (Array.isArray(list) ? list : []).slice(0, 5).map(item => compact({
          type: label,
          qq: String(item?.user_id ?? item?.uin ?? item?.userId ?? ''),
          nickname: String(item?.nickname ?? item?.nick ?? ''),
          description: String(item?.description ?? item?.desc ?? '').slice(0, 80) || undefined,
        }))
      const lists = [
        ...(data.current_talkative ? [{ type: '当前龙王', qq: String(data.current_talkative.user_id ?? ''), nickname: String(data.current_talkative.nickname ?? ''), description: String(data.current_talkative.description ?? '').slice(0, 80) || undefined }] : []),
        ...take(data.talkative_list, '龙王'),
        ...take(data.performer_list, '群聊之火'),
        ...take(data.legend_list, '群聊炽焰'),
        ...take(data.strong_newbie_list, '冒尖小春笋'),
        ...take(data.emotion_list, '快乐源泉'),
      ]
      return { ok: true, action, group: { id: target.groupId, name: target.name }, honors: lists }
    }

    if (action === 'muted') {
      const result = await callOneBot(target.instanceId, 'get_group_shut_list', { group_id: target.groupId })
      if (!result.ok) return result
      const rows = Array.isArray(result.data) ? result.data : []
      const muted = rows.map(item => compact({
        qq: String(item?.user_id ?? item?.uin ?? item?.uid ?? ''),
        nickname: String(item?.nickname ?? item?.nick ?? ''),
        muted_until: fmtTime(item?.shut_up_timestamp ?? item?.timeStamp ?? item?.muteTime) || undefined,
      }))
      return { ok: true, action, group: { id: target.groupId, name: target.name }, count: muted.length, muted }
    }

    if (action === 'at_all_remain') {
      const result = await callOneBot(target.instanceId, 'get_group_at_all_remain', { group_id: target.groupId })
      if (!result.ok) return result
      return { ok: true, action, group: { id: target.groupId, name: target.name }, remain: result.data }
    }

    if (action === 'requests') {
      const count = clampNum(args?.count, 1, 50, 50)
      const result = await callOneBot(target.instanceId, 'get_group_system_msg', { count })
      if (!result.ok) return result
      const data = result.data || {}
      const mapRow = kind => item => compact({
        kind,
        request_id: String(item?.request_id ?? ''),
        group_id: String(item?.group_id ?? ''),
        group_name: String(item?.group_name ?? ''),
        requester_qq: String(item?.requester_uin ?? item?.invitor_uin ?? item?.actor ?? ''),
        requester_nick: String(item?.requester_nick ?? item?.invitor_nick ?? ''),
        message: String(item?.message ?? '').slice(0, 200) || undefined,
        handled: item?.checked === true,
      })
      const requests = [
        ...(Array.isArray(data.join_requests) ? data.join_requests : []).map(mapRow('join')),
        ...(Array.isArray(data.invited_requests) ? data.invited_requests : Array.isArray(data.InvitedRequest) ? data.InvitedRequest : []).map(mapRow('invite')),
      ]
      return {
        ok: true,
        action,
        group: { id: target.groupId, name: target.name },
        count: requests.length,
        requests,
        hint: '用 handle_request + request_id 同意或拒绝；也可以让群管工具在收到申请时提醒你。',
      }
    }

    if (action === 'handle_request') {
      if (!allowManage()) return { ok: false, error: '处理入群申请属于管理操作，当前已在插件设置中关闭。' }
      const requestId = String(args?.request_id ?? '').trim()
      if (!requestId) return { ok: false, error: 'action=handle_request 需要 request_id（来自 requests）。' }
      const approve = args?.approve !== false && args?.approve !== 'false'
      const result = await callOneBot(target.instanceId, 'set_group_add_request', {
        flag: requestId,
        approve,
        reason: String(args?.reason ?? '').slice(0, 200) || ' ',
      })
      if (!result.ok) return result
      emitAction('handle_request', { groupId: target.groupId, requestId, approve })
      return { ok: true, action, message: approve ? `已同意申请 ${requestId}。` : `已拒绝申请 ${requestId}。`, request_id: requestId, approve }
    }

    return { ok: false, error: 'action 只支持 info / honor / muted / at_all_remain / requests / handle_request。' }
  }

  /* ---------------- 工具注册 ---------------- */

  const toolDefinitions = [
    {
      name: 'napcat_group_member',
      definition: {
        description:
          'NapCat 群成员查询。search：按群名片 / 昵称 / QQ号 精确或模糊查找，返回 QQ 号、角色、头衔、等级等资料；info：按精确 QQ 号或群内唯一名字拉取资料，fields=all 可全拉。备注：某些时候说的“开盒”一般指这个工具，仅作为玩笑。除非确认是真的开盒话题，否则禁止以说教式回复。',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['search', 'info'], description: '默认 search。' },
            keyword: { type: 'string', description: 'search：关键词；留空列出成员。' },
            qq: { type: 'string', description: 'info：精确 QQ 号。' },
            name: { type: 'string', description: 'info：成员名，与 qq 二选一。' },
            fields: { type: ['string', 'array'], items: { type: 'string' }, description: '资料分组：basic/signature/qq_level/vip/group_member/friend/honor/likes/status/space 或 all。' },
            match: { type: 'string', enum: ['auto', 'exact', 'fuzzy'], description: '匹配方式，默认 auto。' },
            group: { type: 'string', description: '群号或群名，默认当前群。' },
            limit: { type: 'number', description: '返回条数，默认 10，最大 50。' },
            offset: { type: 'number', description: '分页偏移。' },
            refresh: { type: 'boolean', description: 'true 时不使用成员缓存。' },
          },
        },
      },
      handler: toolMember,
    },
    {
      name: 'napcat_group_send',
      definition: {
        description:
          'NapCat 群内发言。at：艾特成员并发送 text（targets 传 QQ 号或名字）；at_all：发送 @全体成员 + text；music：发送音乐卡片。也可直接在 chat_send 正文里写 [CQ:at,qq=123] 或 [at:123]。',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['at', 'at_all', 'music'], description: '默认 at。' },
            group: { type: 'string', description: '群号或群名，默认当前群。' },
            text: { type: 'string', description: '要说的话。' },
            targets: {
              type: 'array',
              description: 'at：QQ 号或名字，最多 10 个。',
              items: { type: ['string', 'object'], properties: { qq: { type: 'string' }, name: { type: 'string' } } },
            },
            reply_to: { type: 'string', description: '引用消息的 message_id。' },
            music: {
              type: 'object',
              description: 'type=qq/163/kugou/kuwo/migu 需 id；type=custom 需 url 与 image。',
              properties: { type: { type: 'string' }, id: { type: 'string' }, url: { type: 'string' }, audio: { type: 'string' }, title: { type: 'string' }, content: { type: 'string' }, image: { type: 'string' } },
            },
          },
        },
      },
      handler: toolSend,
    },
    {
      name: 'napcat_group_manage',
      definition: {
        description:
          'NapCat 群管理。mute/unmute 禁言（duration：秒 / 10分钟 / 1小时 / 2天，0 解除）；mute_all 全员禁言（enable）；kick 踢人（reject_add）；set_card 群名片；set_title 头衔；set_admin 管理员；recall 撤回消息；sign 打卡；poke 戳一戳；raw 透传 action（需设置开启）。',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['mute', 'unmute', 'mute_all', 'kick', 'set_card', 'set_title', 'set_admin', 'recall', 'sign', 'poke', 'raw'] },
            group: { type: 'string', description: '群号或群名，默认当前群。' },
            qq: { type: 'string', description: '目标 QQ 号。' },
            name: { type: 'string', description: '目标成员名，与 qq 二选一。' },
            duration: { type: ['number', 'string'], description: '禁言时长：数字按秒，也可写 90秒 / 1分钟 / 5分钟 / 1.5小时 / 1小时30分钟 / 三分钟 / 2天；0 或 unmute 解除（QQ 上限 30 天）。' },
            enable: { type: 'boolean', description: 'mute_all / set_admin 开关。' },
            reject_add: { type: 'boolean', description: 'kick：拒绝再次加群。' },
            card: { type: 'string', description: 'set_card：新名片，留空清除。' },
            title: { type: 'string', description: 'set_title：新头衔，留空清除。' },
            message_id: { type: 'string', description: 'recall：消息 ID。' },
            onebot_action: { type: 'string', description: 'raw：OneBot action。' },
            raw_params: { type: 'object', description: 'raw：action 参数。' },
          },
          required: ['action'],
        },
      },
      handler: toolManage,
    },
    {
      name: 'napcat_group_notice',
      definition: {
        description:
          'NapCat 群公告。send 发布（content/image/params）；get 读取；delete 按 notice_id 或 index / keyword 删除；edit 删旧公告后发新公告。params：pinned 置顶、confirm 需成员确认、popup 弹窗、show_edit_card 提醒改名片。',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['send', 'get', 'delete', 'edit'] },
            group: { type: 'string', description: '群号或群名，默认当前群。' },
            content: { type: 'string', description: 'send / edit：公告正文。' },
            image: { type: 'string', description: '公告图片 URL。' },
            notice_id: { type: 'string', description: 'delete / edit：公告 ID。' },
            index: { type: 'number', description: 'delete / edit：公告序号（从 1 开始）。' },
            keyword: { type: 'string', description: 'delete / edit：正文关键词。' },
            params: { type: 'object', description: '公告参数：pinned / confirm / popup / show_edit_card / type；其余键原样透传给 NapCat。', additionalProperties: true },
          },
          required: ['action'],
        },
      },
      handler: toolNotice,
    },
    {
      name: 'napcat_group_info',
      definition: {
        description:
          'NapCat 群信息。info 群资料；honor 荣誉榜；muted 被禁言成员；at_all_remain @全体剩余次数；requests 待处理入群 / 邀请申请；handle_request 按 request_id 审批（approve）。',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['info', 'honor', 'muted', 'at_all_remain', 'requests', 'handle_request'] },
            group: { type: 'string', description: '群号或群名，默认当前群。' },
            request_id: { type: 'string', description: 'handle_request：申请 ID。' },
            approve: { type: 'boolean', description: 'handle_request：true 同意，false 拒绝。' },
            reason: { type: 'string', description: 'handle_request：拒绝理由。' },
            count: { type: 'number', description: 'requests：拉取数量，默认 50。' },
          },
          required: ['action'],
        },
      },
      handler: toolInfo,
    },
  ]
  for (const item of toolDefinitions) {
    registeredNames.push(item.name)
    const dispose = tools.register(item.name, item.definition, item.handler)
    ctx.effect(() => () => {
      try {
        dispose()
      } catch (_) {
        /* ignore */
      }
    })
  }

  /* ---------------- 插件设置面板 ---------------- */

  const escapeHtml = value =>
    String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch])
  const settingsSection = (title, content) => `<div class="settings-section">${title ? `<div class="settings-section-title">${title}</div>` : ''}${content}</div>`
  const settingsCard = rows => `<div class="settings-card">${rows}</div>`
  const settingsRow = (title, help, control) =>
    `<div class="setting-row"><div class="setting-main"><div class="setting-name">${title}</div>${help ? `<div class="setting-help">${help}</div>` : ''}</div><div class="setting-control">${control}</div></div>`
  const settingsToggle = (key, on) => `<button class="switch ${on ? 'on' : ''}" data-gm-toggle="${escapeHtml(key)}"></button>`
  const settingsInput = (key, value, { type = 'text', width = 140, placeholder = '' } = {}) =>
    `<input class="setting-input" type="${type}" data-gm-input="${escapeHtml(key)}" value="${escapeHtml(value)}" placeholder="${escapeHtml(placeholder)}" style="width:${width}px" />`

  const bindSettings = container => {
    const offs = []
    for (const element of container.querySelectorAll('[data-gm-toggle]')) {
      const key = element.dataset.gmToggle
      let value = config.get(key, element.classList.contains('on')) !== false
      element.classList.toggle('on', value)
      const onClick = () => {
        value = !value
        element.classList.toggle('on', value)
        config.set(key, value)
        ctx.logger.info(`[group-chat-tools] ${key} = ${value}`)
      }
      element.addEventListener('click', onClick)
      offs.push(() => element.removeEventListener('click', onClick))
      offs.push(config.watch(key, next => element.classList.toggle('on', next !== false)))
    }
    for (const element of container.querySelectorAll('[data-gm-input]')) {
      const key = element.dataset.gmInput
      element.value = String(config.get(key, element.value ?? ''))
      const onChange = () => {
        const value = element.type === 'number' ? Number(element.value) : element.value
        config.set(key, element.type === 'number' && !Number.isFinite(value) ? config.get(key, 0) : value)
        ctx.logger.info(`[group-chat-tools] ${key} = ${element.value}`)
      }
      element.addEventListener('change', onChange)
      offs.push(() => element.removeEventListener('change', onChange))
      offs.push(config.watch(key, next => {
        if (typeof document === 'undefined' || document.activeElement !== element) element.value = String(next ?? '')
      }))
    }
    return () => offs.forEach(off => off())
  }

  if (manager?.registerSettings) {
    const disposeSettings = manager.registerSettings({
      id: name,
      title: '群聊工具',
      description: '给 AI 提供 NapCat 群聊工具：成员搜索、资料查询、@、禁言踢人、群公告等。',
      render(container) {
        container.innerHTML = `
          <div class="settings-title-row">
            <div>
              <div class="settings-title">群聊工具</div>
              <div class="settings-desc">所有工具都通过内置 napcat 渠道执行；跨群操作沿用 chat-permissions 的跨渠道权限与敏感确认。</div>
            </div>
          </div>
          ${settingsSection('总开关', settingsCard(
            settingsRow('启用群管工具', '关闭后所有 napcat_group_* 工具都会拒绝执行', settingsToggle('napcat.groupMaster.enabled', config.get('napcat.groupMaster.enabled', true) !== false)) +
              settingsRow('允许管理类操作', '禁言 / 踢人 / 头衔 / 群公告 / 撤回等；关闭后只保留查询与 @', settingsToggle('napcat.groupMaster.allowManage', config.get('napcat.groupMaster.allowManage', true) !== false)) +
              settingsRow('允许 raw 透传', '允许模型调用任意 OneBot action（危险，默认关闭）', settingsToggle('napcat.groupMaster.allowRawAction', config.get('napcat.groupMaster.allowRawAction', false) === true)),
          ))}
          ${settingsSection('查询与安全', settingsCard(
            settingsRow('成员列表缓存（毫秒）', '群成员搜索的缓存时间，默认 60000', settingsInput('napcat.groupMaster.memberCacheMs', config.get('napcat.groupMaster.memberCacheMs', 60000), { type: 'number', width: 110 })) +
              settingsRow('单次返回上限', '成员搜索 / 列表每次最多返回多少条，默认 20', settingsInput('napcat.groupMaster.maxResults', config.get('napcat.groupMaster.maxResults', 20), { type: 'number', width: 110 })) +
              settingsRow('保护名单', '逗号分隔的 QQ 号，禁言 / 踢人 / 改头衔时永不操作', settingsInput('napcat.groupMaster.protectedUsers', config.get('napcat.groupMaster.protectedUsers', ''), { width: 260, placeholder: '例如 10001,10002' })),
          ))}
          <div class="settings-note">安全约束：不会对机器人自己、群主或保护名单成员执行禁言 / 踢人 / 改头衔；raw 透传默认关闭，并会拦截 bot_exit / set_restart 等危险 action。</div>
        `
        return bindSettings(container)
      },
    })
    ctx.effect(() => () => disposeSettings?.())
  }

  /* ---------------- 给其它扩展的服务 ---------------- */

  ctx.provide(
    'group-chat-tools',
    {
      name,
      version,
      toolNames: () => [...registeredNames],
      members: fetchMembers,
      resolveGroup: resolveGroupTarget,
      action: callOneBot,
      protectedUsers,
    },
    { type: 'singleton' },
  )

  ctx.effect(() => () => {
    MEMBER_CACHE.clear()
    NOTICE_CACHE.clear()
  })

  ctx.logger.debug(`群聊工具就绪（${registeredNames.length} 个工具：${registeredNames.join(', ')}）`)
}
