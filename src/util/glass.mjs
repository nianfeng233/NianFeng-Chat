/**
 * 玻璃板外观配置表（库，不是插件）。
 *
 * 这里是“每块玻璃板 × 每项属性”的唯一数据源：
 *  - theme-tokens 读取它，把 config 映射成 CSS 变量
 *  - settings-item-theme 读取它，生成外观页的滑块
 *  - 各面板插件消费生成的 CSS 变量
 */

export const GLASS_PROPERTIES = {
  alpha: {
    label: '透明度',
    help: '0% 接近完全透明，100% 为实色',
    min: 5,
    max: 100,
    step: 1,
    unit: '%',
    scale: 100,
    default: 0.55,
    css: value => String(value),
  },
  blur: {
    label: '模糊度',
    help: '背景模糊半径，视频壁纸建议调低',
    min: 0,
    max: 40,
    step: 1,
    unit: 'px',
    scale: 1,
    default: 22,
    css: value => `${value}px`,
  },
  saturate: {
    label: '饱和度',
    help: '玻璃后景色的鲜艳程度',
    min: 0,
    max: 200,
    step: 1,
    unit: '%',
    scale: 1,
    default: 150,
    css: value => `${value}%`,
  },
  brightness: {
    label: '亮度',
    help: '玻璃后景色的明暗程度',
    min: 0,
    max: 200,
    step: 1,
    unit: '%',
    scale: 1,
    default: 100,
    css: value => `${value}%`,
  },
  borderWidth: {
    label: '边框宽度',
    help: '玻璃板描边粗细，0px 为无边框',
    min: 0,
    max: 3,
    step: 0.5,
    unit: 'px',
    scale: 1,
    default: 1,
    css: value => `${value}px`,
  },
}

const base = { blur: 22, saturate: 150, brightness: 100, borderWidth: 1 }

export const GLASS_PANELS = [
  { id: 'chat-list', config: 'chatList', label: '会话列表栏', help: '会话界面左侧列表', defaults: { ...base, alpha: 0.55 } },
  { id: 'channel-list', config: 'channelList', label: '渠道列表栏', help: '渠道界面左侧列表', defaults: { ...base, alpha: 0.55 } },
  { id: 'chat-main', config: 'chatMain', label: '会话主面板', help: '消息区玻璃板', defaults: { ...base, alpha: 0.55 } },
  { id: 'channel-main', config: 'channelMain', label: '渠道主面板', help: '渠道详情玻璃板', defaults: { ...base, alpha: 0.55 } },
  { id: 'settings-nav', config: 'settingsNav', label: '设置导航', help: '设置页左侧导航', defaults: { ...base, alpha: 0.47, borderWidth: 0.5 } },
  { id: 'settings-content', config: 'settingsContent', label: '设置内容', help: '设置页右侧内容', defaults: { ...base, alpha: 0.56, borderWidth: 0.5 } },
  { id: 'titlebar', config: 'titlebar', label: '顶部栏', help: '标题栏玻璃', defaults: { ...base, alpha: 0.42, blur: 14, borderWidth: 0.5 } },
]

export const GLASS_PANEL_BY_ID = Object.fromEntries(GLASS_PANELS.map(panel => [panel.id, panel]))

/** ui.glass.chatList.alpha */
export function glassConfigKey(panel, prop) {
  return `ui.glass.${panel.config}.${prop}`
}

/** --glass-chat-list-alpha / --glass-settings-nav-border-width */
export function glassVarName(panel, prop) {
  const suffix = prop.replace(/[A-Z]/g, match => `-${match.toLowerCase()}`)
  return `--glass-${panel.id}-${suffix}`
}

export function clampGlassValue(prop, value, fallback) {
  const meta = GLASS_PROPERTIES[prop]
  const num = Number(value)
  const base = Number.isFinite(num) ? num : fallback
  if (!meta) return base
  return Math.max(meta.min / (meta.scale || 1), Math.min(meta.max / (meta.scale || 1), base))
}
