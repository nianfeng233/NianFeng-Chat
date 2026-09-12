/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目：念风 Chat（NianFeng-Chat）
 *
 * 统一身份与头像资源（库，不是插件）。
 *
 * 项目中所有需要「念风 logo / 用户头像」「角色消息头像」的地方都从这里取，
 * 避免每个插件各自写死一条 `./public/assets/logo.png` 或各自实现一遍头像 HTML。
 * 用户更换头像后只需写入 config 的 `ui.avatarImage`，所有监听 config:changed
 * 的界面会一起刷新；没有自定义头像时统一回退到念风 logo。
 */
import { escapeHtml } from './format.mjs'

/**
 * 全项目唯一的品牌 logo / 默认头像地址。
 * 任何需要“品牌标识”或“默认用户头像”的位置都必须引用这个常量，
 * 以后换头像资源只改这一处即可全量生效。
 */
export const BRAND_LOGO = './public/assets/logo.png'

/** 兼容旧命名：默认头像与品牌 logo 是同一个值，避免历史代码出现第二份路径。 */
export const DEFAULT_AVATAR = BRAND_LOGO

/** 用户偏好键：头像 / 昵称 / 签名（统一入口，避免各插件写错 key） */
export const USER_AVATAR_KEY = 'ui.avatarImage'
export const USER_NICKNAME_KEY = 'ui.nickname'
export const USER_SIGNATURE_KEY = 'ui.signature'

export const DEFAULT_USER_NICKNAME = '我'
export const DEFAULT_USER_SIGNATURE = '点此修改签名'

/** 当前用户头像地址：自定义优先，否则使用全项目唯一的念风 logo */
export function resolveUserAvatar(config) {
  const custom = String(config?.get?.(USER_AVATAR_KEY, '') || '').trim()
  return custom || DEFAULT_AVATAR
}

/** 当前用户昵称：未设置时回退到「我」 */
export function resolveUserNickname(config, fallback = DEFAULT_USER_NICKNAME) {
  return String(config?.get?.(USER_NICKNAME_KEY, '') || '').trim() || fallback
}

/** 当前用户签名：未设置时回退到占位文案 */
export function resolveUserSignature(config, fallback = DEFAULT_USER_SIGNATURE) {
  return String(config?.get?.(USER_SIGNATURE_KEY, '') || '').trim() || fallback
}

const safeText = value => escapeHtml(String(value ?? ''))

/**
 * 生成可安全放进 style="..." 里的 url()。
 * 注意：外层属性用双引号，所以 url() 内部必须使用单引号，并且剔除值里的
 * 单/双引号与反斜杠；否则头像路径会把 style 属性截断，消息里的头像就会空白。
 */
export function cssUrl(value) {
  const cleaned = String(value ?? '').replace(/["'\\\r\n]/g, '')
  return `url('${cleaned}')`
}

/** 统一的用户头像 HTML（默认念风 logo，可被 ui.avatarImage 覆盖） */
export function userAvatarHtml(config, { className = 'avatar', title = '我', alt = '我' } = {}) {
  const src = resolveUserAvatar(config)
  return `<div class="${safeText(className)} avatar-img" style="background-image:${cssUrl(src)}" title="${safeText(title)}" role="img" aria-label="${safeText(alt)}"></div>`
}

/** 角色会话头像：优先自定义图片，否则用角色名首字 + 调色板颜色 */
export function characterAvatarHtml(conversation, { className = 'avatar', title } = {}) {
  const avatarImage = conversation?.meta?.avatarImage || conversation?.avatarImage || ''
  const name = conversation?.name || '角色'
  const label = title || name
  if (avatarImage) {
    return `<div class="${safeText(className)} avatar-img" style="background-image:${cssUrl(avatarImage)}" title="${safeText(label)}" role="img" aria-label="${safeText(name)}"></div>`
  }
  const avatarText = String(conversation?.avatar || name.slice(0, 1) || '?').slice(0, 2)
  const c1 = conversation?.c1 || '#b9c2cf'
  const c2 = conversation?.c2 || '#8d99ab'
  return `<div class="${safeText(className)}" style="--c1:${safeText(c1)};--c2:${safeText(c2)}" title="${safeText(label)}" role="img" aria-label="${safeText(name)}">${safeText(avatarText)}</div>`
}

/** 通用头像信息（通知等只有零散字段的场景）：支持图片、字符与颜色 */
export function avatarHtmlFromInfo(info = {}, { className = 'avatar', title } = {}) {
  const { avatarImage, avatarText, avatar, name, c1, c2 } = info
  if (avatarImage) {
    return `<div class="${safeText(className)} avatar-img" style="background-image:${cssUrl(avatarImage)}" title="${safeText(title || name || '')}" role="img"></div>`
  }
  const text = String(avatarText || avatar || name?.slice?.(0, 1) || '?').slice(0, 2)
  return `<div class="${safeText(className)}" style="--c1:${safeText(c1 || '#b9c2cf')};--c2:${safeText(c2 || '#8d99ab')}" title="${safeText(title || name || '')}" role="img">${safeText(text)}</div>`
}
