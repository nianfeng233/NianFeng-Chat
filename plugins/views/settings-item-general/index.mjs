/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * V17 · settings-item-general
 * 通用设置：启动行为、语言与聊天链路。
 */
export const name = 'settings-item-general'
export const version = '1.0.0'
export const displayName = '设置项 · 通用'
export const description = '设置页 · 应用行为与基础偏好。'
export const author = '念风内核'
export const icon = '🔧'
export const core = true
export const depends = {
  'config': '>=1.1.0',
  'i18n': '>=2.0.0',
  'settings-container': '^1.0.0',
}
export const optionalDepends = {}
export const inject = ['settings-container', 'config', 'i18n']

import { page, section, card, row, switchBtn, select, input, bindConfigControls } from '../../../src/util/settings.mjs'
import { icons } from '../../../src/util/icons.mjs'

export function apply(ctx) {
  const pages = ctx.inject('settings-container')
  const config = ctx.inject('config')
  const i18n = ctx.inject('i18n')

  // 桌面宿主：启动时同步一次「关闭窗口时最小化」，避免只有改设置后才生效。
  window.windHost?.setMinimizeOnClose?.(!!config.get('general.minimizeOnClose', false))

  pages.register({
    id: 'general',
    group: '系统',
    groupOrder: 40,
    label: '通用',
    icon: icons.settings,
    order: 40,
    render(container) {
      const hasWindowHost = !!window.windHost
      const localePacks = i18n.locales()
      container.innerHTML = page('通用', '应用行为、启动方式以及基础偏好设置。', `
        ${section('应用', card(
          row('启动时恢复上次状态', '重新打开应用时恢复上次激活的网页会话；渠道记录会话始终不会自动恢复（默认关闭）', switchBtn('general.restore', false)) +
          row(
            '关闭窗口时最小化',
            hasWindowHost ? '关闭窗口后继续在后台运行（由桌面端宿主接管）' : '仅桌面端宿主支持；当前是浏览器环境，此选项暂不生效',
            hasWindowHost ? switchBtn('general.minimizeOnClose', false) : '<span class="plugin-tag disabled">桌面端可用</span>',
          ),
        ))}
        ${section('语言', card(
          row('界面语言',
            localePacks.length
              ? '语言包由插件提供；内置简体中文，复制语言包插件并修改翻译表即可新增语种'
              : '尚未安装语言包插件，界面会回退到内置中文文案',
            localePacks.length
              ? select('ui.locale', localePacks.map(pack => ({ value: pack.id, label: pack.label })), i18n.locale())
              : '<span class="plugin-tag disabled">未安装语言包</span>'),
        ))}
        ${section('聊天链路', card(
          row('强制调用工具', '模型通过工具发送聊天消息；不支持 function calling 的模型会自动降级为普通回复', switchBtn('chat.toolsEnabled', true)) +
          row('工具选择策略', 'required=每轮强制任一工具；auto=模型自行决定；none=不向模型提供工具',
            select('chat.toolChoice', [
              { value: 'required', label: 'required · 强制工具' },
              { value: 'auto', label: 'auto · 模型决定' },
              { value: 'none', label: 'none · 关闭工具' },
            ], config.get('chat.toolChoice', 'required'))) +
          row('严格工具模式', '模型直接输出正文时先按纠错提示重试一次；仍未调用工具就把正文作为回复发出，不再让用户空等或直接报错', switchBtn('chat.requireToolCall', true)) +
          row('工具纠错次数', '严格模式下最多纠正几次（为提高响应速度，超过 1 次会按 1 次上限执行；0 = 不纠正，直接按普通文本降级）',
            input('chat.toolRetryLimit', config.get('chat.toolRetryLimit', 1), { type: 'number', width: 70 })) +
          row('空回复纠正次数', '模型既没输出正文也没调用工具时，最多纠正几次；仍为空则明确报错并停止本轮',
            input('chat.emptyRetryLimit', config.get('chat.emptyRetryLimit', 2), { type: 'number', width: 70 })) +
          row('最大工具轮次', '一轮回复内最多执行多少次“模型 → 工具 → 模型”循环（1-20）',
            input('chat.maxToolRounds', config.get('chat.maxToolRounds', 10), { type: 'number', width: 90 })) +
          row('上下文 token 预算', '工作记忆 + 渠道记忆的粗略 token 上限，超出时整轮丢弃最旧内容',
            input('chat.contextTokens', config.get('chat.contextTokens', 4096), { type: 'number', width: 110 })) +
          row('工作记忆轮数', '角色级普通私聊记忆保留轮数',
            input('chat.memoryRounds', config.get('chat.memoryRounds', 5), { type: 'number', width: 80 })) +
          row('渠道记忆轮数', '当前渠道最近消息保留轮数',
            input('chat.channelRounds', config.get('chat.channelRounds', 5), { type: 'number', width: 80 })) +
          row('单次读取上限', 'read_messages / read_document 单次返回的 token 上限',
            input('chat.readTokens', config.get('chat.readTokens', 1500), { type: 'number', width: 100 })) +
          row('敏感操作确认', '跨渠道读写等敏感操作需要在输入框输入“确认”', switchBtn('chat.confirmSensitive', true)) +
          row('模拟真人打字', '工具发送消息前按内容长度模拟打字延迟；每轮首条不延迟，网页与外部渠道一致', switchBtn('chat.simulateTyping', true)) +
          row('打字最小延迟（毫秒）', '后续消息的动态延迟下限，默认 500ms',
            input('chat.typingMinMs', config.get('chat.typingMinMs', 500), { type: 'number', width: 90 })) +
          row('打字最大延迟（毫秒）', '后续消息的动态延迟上限，默认 5000ms',
            input('chat.typingMaxMs', config.get('chat.typingMaxMs', 5000), { type: 'number', width: 90 })) +
          row('每字延迟（毫秒）', '延迟按消息字数线性增长，默认 35ms/字',
            input('chat.typingPerCharMs', config.get('chat.typingPerCharMs', 35), { type: 'number', width: 80 })),
        ))}`)

      const unbind = bindConfigControls(container, ctx, {
        onChange(key, value) {
          if (key === 'ui.locale') i18n.setLocale(value)
          if (key === 'general.minimizeOnClose') window.windHost?.setMinimizeOnClose?.(value)
        },
      })
      return unbind
    },
  })
}
