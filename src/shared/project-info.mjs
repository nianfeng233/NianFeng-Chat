/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * 项目公共信息（库，不是插件）。
 *
 * 终端启动声明、WebUI 欢迎页等所有需要展示项目名称 / 仓库 / 官方群 /
 * 许可证的位置都从这里取值，避免在多处各写一份。浏览器端与 Node 端均可导入。
 */

export const PROJECT_NAME = '念风 Chat'
export const PROJECT_FULL_NAME = '念风 Chat（NianFeng-Chat）'
export const PROJECT_REPO = 'https://github.com/nianfeng233/NianFeng-Chat'
export const PROJECT_QQ_GROUP = '1109357470'
export const PROJECT_LICENSE = 'Apache License 2.0'
export const PROJECT_TAGLINE = '本地优先、插件化的 AI 聊天客户端'

/** 终端启动时打印的免费开源声明：与欢迎页使用同一套项目信息。 */
export const FREE_SOFTWARE_NOTICE_LINES = [
  `${PROJECT_FULL_NAME} · 完全免费、开源发布`,
  '',
  `本项目遵循 ${PROJECT_LICENSE}，官方发布渠道只有以下两个：`,
  `  官方仓库：${PROJECT_REPO}`,
  `  官方 QQ 群：${PROJECT_QQ_GROUP}`,
  '',
  '官方不会以任何形式收费售卖。如果你是通过付费购买获得本项目，',
  '请立即申请退款，并向交易平台和卖家举报；',
  '也欢迎通过 GitHub Issue 或官方 QQ 群反馈倒卖线索。',
]

/** 文本显示宽度：中日韩等全角字符按 2 列计算，供终端边框对齐。 */
export function displayWidth(text) {
  return [...String(text ?? '')].reduce((width, char) => width + (char.codePointAt(0) > 255 ? 2 : 1), 0)
}

/** 在终端打印免费开源声明；log 可替换，方便测试或自定义输出。 */
export function printFreeSoftwareNotice(log = console.log) {
  const lines = FREE_SOFTWARE_NOTICE_LINES
  const width = lines.reduce((max, line) => Math.max(max, displayWidth(line)), 0)
  log('')
  log('  ╭' + '─'.repeat(width + 2) + '╮')
  for (const line of lines) {
    log('  │ ' + line + ' '.repeat(Math.max(0, width - displayWidth(line))) + ' │')
  }
  log('  ╰' + '─'.repeat(width + 2) + '╯')
  log('')
}
