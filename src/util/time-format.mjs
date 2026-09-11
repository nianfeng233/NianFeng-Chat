/**
 * 时间展示与消息时间戳分隔工具。
 *
 * 聊天时间戳规则：
 *   - 当天：HH:mm
 *   - 昨天：昨天 HH:mm
 *   - 七天内：星期几 HH:mm
 *   - 超过七天：M月D日 HH:mm；跨年时额外带上年份
 *
 * 同时导出时间戳分隔线的插入阈值，供 message-service 使用。
 */

export const MINUTE_MS = 60 * 1000

/** 连续聊天时，每隔多久补一条时间戳（默认 30 分钟） */
export const DEFAULT_DIVIDER_INTERVAL_MS = 30 * MINUTE_MS

/** 两条消息间隔超过多久算“重新开始聊”（默认 10 分钟） */
export const DEFAULT_DIVIDER_GAP_MS = 10 * MINUTE_MS

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']
const pad = n => String(n).padStart(2, '0')

/** 把各种时间输入统一为 Date；无效输入返回 null */
export function toDate(value) {
  if (value === null || value === undefined || value === '') return null
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value
  if (typeof value === 'number') {
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? null : date
  }
  const text = String(value).trim()
  if (!text) return null
  const legacy = text.match(/^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/)
  if (legacy) {
    const date = new Date(
      Number(legacy[1]),
      Number(legacy[2]) - 1,
      Number(legacy[3]),
      Number(legacy[4] || 0),
      Number(legacy[5] || 0),
      Number(legacy[6] || 0),
    )
    return Number.isNaN(date.getTime()) ? null : date
  }
  const parsed = new Date(text)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

/** 工整的绝对时间，用于分隔线的持久化占位（界面会动态改写展示文本） */
export function formatFullDateTime(value = new Date()) {
  const date = toDate(value) || new Date()
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** HH:mm */
export function formatClock(value = new Date()) {
  const date = toDate(value)
  if (!date) return ''
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 日历日差：今天=0，昨天=1……跨月跨年同样成立 */
export function calendarDayDiff(value, now = new Date()) {
  const date = toDate(value)
  const current = toDate(now) || new Date()
  if (!date) return Number.NaN
  const a = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())
  const b = Date.UTC(current.getFullYear(), current.getMonth(), current.getDate())
  return Math.round((b - a) / 86400000)
}

/**
 * 聊天时间戳展示文本。
 * @param {string|number|Date} value
 * @param {string|number|Date} now 当前时间，可注入以便测试
 */
export function formatChatTimestamp(value, now = new Date()) {
  const date = toDate(value)
  if (!date) return ''
  const current = toDate(now) || new Date()
  const days = calendarDayDiff(date, current)
  const clock = formatClock(date)

  if (days === 0) return clock
  if (days === 1) return `昨天 ${clock}`
  if (days > 1 && days <= 7) return `星期${WEEKDAYS[date.getDay()]} ${clock}`

  const sameYear = date.getFullYear() === current.getFullYear()
  const dateText = sameYear
    ? `${date.getMonth() + 1}月${date.getDate()}日`
    : `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`
  // 未来时间（日历日差为负）按绝对日期兜底，避免显示成“星期几”或负数。
  return `${dateText} ${clock}`
}

/**
 * 从消息里提取可用于排序 / 格式化的时间戳。
 * 优先使用结构化 timestamp；兼容旧分隔线 content 里的 YYYY/MM/DD HH:mm。
 */
export function resolveMessageTimestamp(message) {
  if (!message) return null
  const candidate =
    message.meta?.at ??
    message.timestamp ??
    message.createdAt ??
    message.at ??
    message.meta?.timestamp ??
    null
  if (candidate !== null && candidate !== undefined && candidate !== '') return candidate
  const legacy = String(message.content || '').match(/^(\d{4})[\/-]\d{1,2}[\/-]\d{1,2}(?:\s+\d{1,2}:\d{1,2})?$/)
  return legacy ? message.content : null
}

/** 读取消息的毫秒时间（无效时使用 fallback） */
export function messageTimestampMs(message, fallback = Date.now()) {
  const date = toDate(resolveMessageTimestamp(message))
  return date ? date.getTime() : fallback
}
