/**
 * X9 · lang-zh-cn
 * 简体中文语言包（i18n 的实例插件，也是新增语种的复制模板）。
 *
 * 新增语种步骤：
 *   1. 复制整个 `plugins/extras/lang-zh-cn/` 目录为 `plugins/extras/lang-xx-yy/`；
 *   2. 修改 name / displayName / description 与 id / label；
 *   3. 按 key 修改 MESSAGES 里的翻译表（键名保持一致，缺的键会自动回退到简中）。
 *
 * 翻译表只负责文案；界面是否随语言刷新由各插件监听 `i18n:changed` 决定。
 */
export const name = 'lang-zh-cn'
export const version = '1.0.0'
export const displayName = '语言包 · 简体中文'
export const description = '语言包 · 内置简体中文；复制本插件目录并修改翻译表即可新增其他语种。'
export const author = '风语内核'
export const icon = '🀄'
export const core = true
export const depends = { i18n: '^1.0.0' }
export const inject = ['i18n']
export const provides = []

export const MESSAGES = {
  'app.name': '风语',
  'app.slogan': '专注 AI 与人机对话',
  'view.chat': '会话',
  'view.channel': '渠道',
  'view.settings': '设置',
  'chat.placeholder': '输入消息，Enter 发送，Shift + Enter 换行',
  'chat.send': '发送',
  'chat.empty': '选择一个会话开始聊天',
  'chat.emptySub': '再次点击已选中的会话可以取消选择',
  'chat.online': '在线',
  'chat.searchConv': '搜索会话',
  'chat.searchChannel': '搜索渠道',
  'channel.empty': '选择一个渠道查看详情',
  'channel.emptySub': '或点击左侧「添加渠道」接入新的消息渠道',
  'channel.add': '添加渠道',
  'session.yesterday': '昨天',
  'settings.title': '设置',
}

export function apply(ctx) {
  const i18n = ctx.inject('i18n')
  // 立即注册语言包，并把注销函数交给插件生命周期管理。
  const dispose = i18n.register({
    id: 'zh-CN',
    label: '简体中文',
    messages: MESSAGES,
  })
  ctx.effect(() => dispose)
}
