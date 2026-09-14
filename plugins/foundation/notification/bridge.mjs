/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目：念风 Chat（NianFeng-Chat）
 *
 * 通知服务后端兜底：
 *   POST /api/notify/system   由服务器进程弹出一条系统通知（Windows Toast / Linux notify-send / macOS osascript）。
 *
 * 为什么需要它：
 *   浏览器 Notification API 只允许在安全上下文（HTTPS 或 localhost）申请权限。
 *   很多用户把念风部署在 Windows 云服务器 / 局域网机器，再从另一台电脑用
 *   http://IP:端口 打开 WebUI，此时浏览器会把通知权限直接判为“已拒绝”，
 *   页面本身无法越过这条安全策略。这个后端接口让服务器本机也能弹 Windows
 *   通知；WebUI 仅在浏览器系统通知不可用时才回退调用它。
 *
 * 安全：沿用 http 插件的全局鉴权（访问令牌 / Cookie），并限制频率与文本长度。
 * 风险：服务器端通知会显示在“运行念风后端的那台机器”上，而不是远程浏览器所在
 *       的电脑；这是浏览器安全模型决定的上限。需要本机弹窗请使用桌面版或将
 *       WebUI 部署到 HTTPS。
 */
import { execFile } from 'node:child_process'

export const name = 'notification-bridge'
export const version = '1.0.0'
export const displayName = '系统通知后端桥'
export const description = '基础服务后端 · 服务器端系统通知兜底（Windows Toast 等）。'
export const core = false
export const inject = ['settings', 'httpApi']
export const provides = []

const MAX_TITLE = 120
const MAX_BODY = 500
const MIN_INTERVAL_MS = 350
const PROBE_CACHE_MS = 5 * 60 * 1000
const EXEC_TIMEOUT_MS = 9000

let lastNotifyAt = 0
let probeResult = null
let probeAt = 0

const runFile = (file, args) =>
  new Promise(resolve => {
    try {
      execFile(file, args, { timeout: EXEC_TIMEOUT_MS, windowsHide: true }, (error, stdout, stderr) => {
        resolve({ error, stdout: String(stdout || ''), stderr: String(stderr || '') })
      })
    } catch (error) {
      // 某些受限环境（容器 / 组策略）下 spawn 会直接抛 EPERM，而不是回调 error。
      resolve({ error, stdout: '', stderr: String(error?.message || error || '') })
    }
  })

/** Windows Toast：走 PowerShell 5 / 7 的 WinRT 投影，不依赖 BurntToast 等外部模块。 */
async function deliverWindowsToast({ title, body, appId }) {
  const payload = Buffer.from(JSON.stringify({ title, body, appId }), 'utf8').toString('base64')
  const script = `
$ErrorActionPreference = 'Stop'
$payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null
$template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$texts = $template.GetElementsByTagName('text')
$texts.Item(0).AppendChild($template.CreateTextNode([string]$payload.title)) > $null
$texts.Item(1).AppendChild($template.CreateTextNode([string]$payload.body)) > $null
$toast = [Windows.UI.Notifications.ToastNotification]::new($template)
$notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier([string]$payload.appId)
$notifier.Show($toast)
`
  const candidates = process.platform === 'win32' ? ['powershell.exe', 'pwsh.exe'] : ['pwsh.exe']
  let lastError = ''
  for (const file of candidates) {
    const result = await runFile(file, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-Command', script])
    if (!result.error) return { ok: true, channel: 'windows-toast' }
    lastError = String(result.stderr || result.error?.message || '').trim().split('\n')[0] || 'PowerShell 调用失败'
    if (/ENOENT/.test(String(result.error?.code || ''))) continue
  }
  return { ok: false, reason: lastError || '当前服务器无法调用 Windows Toast' }
}

/** 服务器端能力探测：只加载类型，不真的弹通知。 */
async function probeServerToast() {
  if (probeResult && Date.now() - probeAt < PROBE_CACHE_MS) return probeResult
  probeAt = Date.now()
  if (process.platform === 'win32') {
    const script = `[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null; Write-Output 'ok'`
    for (const file of ['powershell.exe', 'pwsh.exe']) {
      const result = await runFile(file, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-Command', script])
      if (!result.error && /ok/i.test(result.stdout)) {
        probeResult = { available: true, channel: 'windows-toast' }
        return probeResult
      }
      if (/ENOENT/.test(String(result.error?.code || ''))) continue
      break
    }
    probeResult = { available: false, reason: 'Windows Toast 不可用（PowerShell / WinRT 未就绪）' }
    return probeResult
  }
  if (process.platform === 'darwin') {
    const result = await runFile('which', ['osascript'])
    probeResult = result.error ? { available: false, reason: '未找到 osascript' } : { available: true, channel: 'macos-notification' }
    return probeResult
  }
  const result = await runFile('which', ['notify-send'])
  probeResult = result.error ? { available: false, reason: '服务器未安装 notify-send' } : { available: true, channel: 'linux-notify' }
  return probeResult
}

async function deliver({ title, body }) {
  if (process.platform === 'win32') return deliverWindowsToast({ title, body, appId: 'NianFeng.Chat' })
  if (process.platform === 'darwin') {
    const escaped = value => String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    const result = await runFile('osascript', ['-e', `display notification "${escaped(body)}" with title "${escaped(title)}"`])
    return result.error ? { ok: false, reason: result.stderr || result.error.message } : { ok: true, channel: 'macos-notification' }
  }
  const result = await runFile('notify-send', ['-a', '念风 Chat', '-t', '6000', title, body])
  return result.error ? { ok: false, reason: '服务器未安装 notify-send' } : { ok: true, channel: 'linux-notify' }
}

export function apply(ctx) {
  const httpApi = ctx.httpApi

  const safe = handler => async (req, res, params, url) => {
    try {
      await handler(req, res, params, url)
    } catch (err) {
      if (!res.headersSent) httpApi.sendError(res, Number(err?.status) || 500, err?.message || String(err))
      else res.end()
    }
  }

  const dispose = httpApi.route(
    'POST',
    '/api/notify/system',
    safe(async (req, res) => {
      const body = await httpApi.readBody(req, 256 * 1024)
      const title = String(body.title || '念风 Chat').trim().slice(0, MAX_TITLE) || '念风 Chat'
      const text = String(body.body || '').trim().slice(0, MAX_BODY)
      if (!text) throw Object.assign(new Error('缺少通知内容'), { status: 400 })

      const now = Date.now()
      if (now - lastNotifyAt < MIN_INTERVAL_MS) {
        return httpApi.sendJson(res, 200, { ok: true, delivered: false, reason: 'rate-limited' })
      }
      lastNotifyAt = now

      const result = await deliver({ title, body: text })
      if (!result.ok) {
        ctx.logger?.warn?.(`[notification-bridge] 服务器端通知发送失败：${result.reason || 'unknown'}`)
        return httpApi.sendJson(res, 200, { ok: true, delivered: false, reason: result.reason || 'send-failed' })
      }
      ctx.logger?.debug?.(`[notification-bridge] 服务器端通知已发送（${result.channel}）：${title}`)
      httpApi.sendJson(res, 200, { ok: true, delivered: true, channel: result.channel })
    }),
  )

  const off = httpApi.registerCapability('server-toast')
  ctx.effect(() => () => {
    try {
      dispose?.()
    } catch (_) {
      /* ignore */
    }
    try {
      off?.()
    } catch (_) {
      /* ignore */
    }
  })

  // 后端启动时预热一次能力探测，失败也不影响启动。
  probeServerToast().catch(() => {})
  ctx.logger.info?.('[notification-bridge] 服务器端系统通知兜底已就绪')
}
