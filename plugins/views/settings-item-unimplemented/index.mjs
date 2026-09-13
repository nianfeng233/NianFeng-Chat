/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * 设置项 · 未实现清单
 * 把当前版本里"确实还没做"的功能集中列出，避免用户误以为是 bug。
 */
export const name = 'settings-item-unimplemented'
export const version = '1.0.0'
export const displayName = '设置项 · 未实现清单'
export const description = '设置页 · 如实列出尚未实现的功能与原因。'
export const author = '念风内核'
export const icon = '🚧'
export const core = false
export const depends = {
  'settings-container': '^1.0.0',
}
export const optionalDepends = {}
export const inject = ['settings-container']

import { page, section, card, row } from '../../../src/util/settings.mjs'
import { icons } from '../../../src/util/icons.mjs'

const ITEMS = [
  ['扩展插件（QQ / 微信气泡、音乐播放器、番茄钟、RSS、TTS、翻译、Telegram 渠道）', '未实现', '这些已从核心移除，定位为独立扩展插件：音乐播放器 / 番茄钟 / TTS（speechSynthesis）属于本地可做但需要单独排期的功能；RSS / 翻译依赖网络或已配置的模型；Telegram 与气泡渠道需要协议和权限。'],
  ['Discord 渠道', '未实现', '需要 Bot Gateway 长连接、OAuth 与权限申请流程。'],
  ['邮箱渠道', '未实现', '需要 IMAP/SMTP 凭据、邮件线程解析与附件处理。'],
  ['代码运行器（code-runner）', '部分实现', '设置 → 代码运行器 已内置 JavaScript Web Worker 沙箱：无 DOM、禁用 fetch / XHR / importScripts、5 秒超时自动终止。Python / Node / 系统命令需要操作系统级沙箱，未实现。'],
  ['语音输入（voice-input）', '部分实现', '输入框的语音按钮已接入浏览器 Web Speech API（Chrome / Edge 可用），识别结果直接填入输入框；不支持该 API 的浏览器仍会提示由插件扩展。'],
  ['系统级窗口控制与系统通知', '桌面端已实现', '桌面壳（Rust + WebView2）通过 window.windHost 接管最小化 / 最大化 / 关闭，并支持「关闭窗口时最小化」；系统通知由 Rust 宿主直接发送（Shell_NotifyIcon），不再受 WebView2 浏览器通知权限限制。浏览器环境仍只提供页面内提示。'],
  ['API Key 加密存储', '部分实现', 'API Key 与敏感请求头已用 AES-256-GCM 密文写入 config.json，密钥文件 .secret-key 与数据同目录（0600）。这不是系统凭据库：备份数据需要一起复制 .secret-key，接入 Keychain / DPAPI 仍需后续工作。'],
  ['背景图片上传', '部分实现', '已在「外观 → 背景」支持上传、自动压缩、本机持久化与切换；尚未提供交互式裁剪与多图管理（需要额外的图像编辑器，未排期）。'],
  ['插件权限沙箱', '部分实现', '已实现插件权限声明、只读/标准/完全权限预设、按插件授权，并在服务访问层真实拦截 api / storage / notification；代码运行器也有独立权限位。但它仍是同一进程内的服务拦截，不是操作系统沙箱；彻底隔离需要「独立插件进程 + RPC」，属于后续架构改造。'],
  ['数据导出为更多格式', '部分实现', '已支持 Markdown / JSON / TXT / HTML / CSV，以及调用浏览器打印另存为 PDF；服务端直接生成 PDF 需要额外排版依赖，未实现。'],
]

export function apply(ctx) {
  const pages = ctx.inject('settings-container')

  pages.register({
    id: 'unimplemented',
    group: '其他',
    groupOrder: 50,
    label: '未实现清单',
    icon: icons.info,
    order: 120,
    render(container) {
      const renderPage = () => {
        // 官方服务相关条目由 official-service 插件动态提供；插件禁用后它们会一起消失。
        const official = ctx.registry.get('official-service')
        const officialItems = official?.unimplementedItems?.() || []
        const items = [...officialItems, ...ITEMS]
        const description = official
          ? '以下功能当前版本确实没有做，列在这里而不是藏在界面里；标记「暂不可用」的由官方服务插件提供。'
          : '以下功能当前版本确实没有做，列在这里而不是藏在界面里。'
        container.innerHTML = page('未实现清单', description, `
          ${section('功能状态', card(
            items.map(([name, status, reason]) =>
              row(
                name,
                reason,
                status === '未实现'
                  ? '<span class="plugin-tag disabled">未实现</span>'
                  : status === '暂不可用'
                    ? '<span class="plugin-tag warn">暂不可用</span>'
                    : '<span class="plugin-tag core-tag">部分实现</span>',
              ),
            ).join(''),
          ))}
          <div class="settings-note">
            如果这里缺少你需要的功能，或某个"未实现"你希望优先做，可以直接告诉开发者。
          </div>`)
      }

      renderPage()
      const rerender = () => {
        if (container.isConnected === false) return
        renderPage()
      }
      const offEnabled = ctx.on('plugin:enabled', payload => {
        if (payload?.id === 'official-service') rerender()
      })
      const offDisabled = ctx.on('plugin:disabled', payload => {
        if (payload?.id === 'official-service') rerender()
      })
      return () => {
        offEnabled?.()
        offDisabled?.()
      }
    },
  })
}

