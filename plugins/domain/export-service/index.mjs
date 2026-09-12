/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * D9 · export-service
 * 会话导出：Markdown / JSON / TXT / HTML / CSV / PDF（浏览器打印）。
 * 监听 export:conversation 事件，其他插件（如 chat-header 的更多菜单）只广播事件。
 */
export const name = 'export-service'
export const version = '2.0.0'
export const displayName = '导出服务'
export const description = '业务服务 · 会话导出（Markdown / JSON / TXT / HTML / CSV / PDF）。'
export const author = '念风内核'
export const icon = '📤'
export const core = false
export const inject = ['session-service', 'event-bus', 'toast']
export const provides = [{ name: 'export-service', type: 'singleton' }]

const esc = value =>
  String(value ?? '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[m])

export function apply(ctx) {
  const sessions = ctx.inject('session-service')
  const events = ctx.inject('event-bus')
  const toast = ctx.inject('toast')

  const download = (filename, content, mime) => {
    const blob = new Blob([content], { type: mime })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    url && setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  const safeName = name => String(name).replace(/[\\/:*?"<>|]/g, '_')

  function toMarkdown(conv) {
    const lines = [`# ${conv.name}`, '', `> 导出时间：${new Date().toLocaleString()} · 共 ${conv.messages.length} 条`, '']
    for (const msg of conv.messages) {
      if (msg.kind === 'divider') {
        lines.push(`---\n\n*${msg.content}*`)
        continue
      }
      lines.push(msg.role === 'user' ? '## 我' : `## ${conv.name}`)
      lines.push('')
      lines.push(msg.content)
      lines.push('')
    }
    return lines.join('\n')
  }

  function toText(conv) {
    return conv.messages
      .map(msg => (msg.kind === 'divider' ? `—— ${msg.content} ——` : `[${msg.role === 'user' ? '我' : conv.name}] ${msg.content}`))
      .join('\n\n')
  }

  function toCsv(conv) {
    const cell = value => `"${String(value ?? '').replace(/"/g, '""')}"`
    const rows = [['时间', '角色', '内容'].map(cell).join(',')]
    for (const msg of conv.messages) {
      if (msg.kind === 'divider') {
        rows.push([cell(msg.time || ''), cell('系统'), cell(`—— ${msg.content} ——`)].join(','))
        continue
      }
      rows.push([cell(msg.time || msg.createdAt || ''), cell(msg.role === 'user' ? '我' : conv.name), cell(msg.content)].join(','))
    }
    return '\ufeff' + rows.join('\r\n')
  }

  const renderMessageSections = conv => conv.messages
    .map(msg => {
      if (msg.kind === "divider") return `<div class="divider">${esc(msg.content)}</div>`
      const who = msg.role === "user" ? "我" : conv.name
      return `<section class="msg ${msg.role === "user" ? "me" : "bot"}">
  <div class="meta"><span class="who">${esc(who)}</span><time>${esc(msg.time || "")}</time></div>
  <div class="content">${esc(msg.content).replace(/\n/g, "<br />")}</div>
</section>`
    })
    .join("\n")

  /** 自包含 HTML（也用于 PDF 打印，保留气泡布局） */
  function htmlDocument(title, subtitle, body) {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(title)} · 念风导出</title>
<style>
  :root{color-scheme:light}
  *{box-sizing:border-box}
  body{margin:0;padding:32px;background:#f6f8f4;color:#1a1d21;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei","Segoe UI",sans-serif;line-height:1.7}
  .wrap{max-width:820px;margin:0 auto}
  h1{font-size:20px;margin:0 0 6px}
  .sub{font-size:12px;color:#8b919c;margin-bottom:22px}
  .msg{margin:0 0 14px}
  .msg .meta{display:flex;gap:8px;align-items:baseline;font-size:11px;color:#8b919c;margin-bottom:4px}
  .msg.me .meta{justify-content:flex-end}
  .msg .content{padding:10px 13px;border-radius:12px;background:#fff;border:1px solid rgba(0,0,0,.06);font-size:13.5px;white-space:pre-wrap;word-break:break-word}
  .msg.me .content{background:#e8f4e2;border-color:rgba(112,161,90,.2)}
  .divider{text-align:center;color:#aab0ba;font-size:11px;margin:18px 0}
  .conv-block{margin:0 0 34px;padding-top:8px;border-top:1px solid rgba(0,0,0,.07)}
  .conv-block:first-of-type{border-top:0;padding-top:0}
  .conv-block h2{font-size:15px;margin:0 0 4px}
  .conv-sub{font-size:11px;color:#8b919c;margin:0 0 14px}
  .foot{margin-top:26px;font-size:11px;color:#aab0ba;text-align:center}
  @media print{body{background:#fff;padding:0}.msg .content{break-inside:avoid}}
</style>
</head>
<body>
  <div class="wrap">
    <h1>${esc(title)}</h1>
    <div class="sub">${esc(subtitle)}</div>
    ${body}
    <div class="foot">由念风chat 导出</div>
  </div>
</body>
</html>`
  }

  function toHtml(conv) {
    return htmlDocument(conv.name, `念风会话导出 · ${new Date().toLocaleString()} · 共 ${conv.messages.length} 条`, renderMessageSections(conv))
  }

  function toAllHtml(conversations) {
    const sections = conversations
      .map(conv => `<section class="conv-block"><h2>${esc(conv.name)}</h2><div class="conv-sub">${conv.messages.length} 条消息</div>${renderMessageSections(conv)}</section>`)
      .join("\n")
    return htmlDocument("念风 · 全部会话", `导出时间：${new Date().toLocaleString()} · 共 ${conversations.length} 个会话`, sections)
  }
  const exportPdf = conv => {
    if (typeof window === 'undefined' || typeof window.open !== 'function') {
      toast.error('当前环境不支持打开打印窗口')
      return false
    }
    const win = window.open('', '_blank')
    if (!win) {
      toast.warn('浏览器拦截了新窗口，无法调用打印生成 PDF')
      return false
    }
    win.document.open()
    win.document.write(toHtml(conv))
    win.document.close()
    setTimeout(() => {
      try {
        win.focus()
        win.print()
      } catch (_) {
        /* 部分浏览器需要用户手动 Ctrl+P */
      }
    }, 350)
    toast.info('已打开打印窗口：选择「另存为 PDF」即可')
    return true
  }

  const service = {
    name: 'export-service',
    formats: () => ['markdown', 'json', 'txt', 'html', 'csv', 'pdf'],
    exportConversation(id, format = 'markdown') {
      const conv = sessions.get(id)
      if (!conv) return false
      const base = safeName(conv.name)
      if (format === 'json') download(`${base}.json`, JSON.stringify(conv, null, 2), 'application/json')
      else if (format === 'txt') download(`${base}.txt`, toText(conv), 'text/plain;charset=utf-8')
      else if (format === 'html') download(`${base}.html`, toHtml(conv), 'text/html;charset=utf-8')
      else if (format === 'csv') download(`${base}.csv`, toCsv(conv), 'text/csv;charset=utf-8')
      else if (format === 'pdf') {
        if (!exportPdf(conv)) return false
      } else download(`${base}.md`, toMarkdown(conv), 'text/markdown;charset=utf-8')
      if (format !== 'pdf') toast.success(`已导出「${conv.name}」（${format}）`)
      events.emit('export:done', { id, format })
      return true
    },
    exportAll(format = 'json') {
      const conversations = sessions.list()
      const stamp = Date.now()
      if (format === 'html') {
        download(`念风-全部会话-${stamp}.html`, toAllHtml(conversations), 'text/html;charset=utf-8')
        toast.success('已导出全部会话（HTML）')
        return true
      }
      const payload = {
        version: ctx.inject('app').version,
        app: '念风chat',
        exportedAt: new Date().toISOString(),
        conversations,
      }
      if (format === 'txt') {
        const text = conversations.map(c => `${'='.repeat(20)}\n${c.name}\n${'='.repeat(20)}\n\n${toText(c)}`).join('\n\n')
        download(`念风-全部会话-${stamp}.txt`, text, 'text/plain;charset=utf-8')
        toast.success('已导出全部会话（TXT）')
        return true
      }
      download(`念风-全部会话-${stamp}.json`, JSON.stringify(payload, null, 2), 'application/json')
      toast.success('已导出全部会话（JSON）')
      return true
    },
    exportMany(ids = [], format = 'json') {
      const conversations = (Array.isArray(ids) ? ids : []).map(id => sessions.get(id)).filter(Boolean)
      if (!conversations.length) return false
      const stamp = Date.now()
      if (format === 'txt') {
        const text = conversations.map(c => `${'='.repeat(20)}\n${c.name}\n${'='.repeat(20)}\n\n${toText(c)}`).join('\n\n')
        download(`念风-选中会话-${stamp}.txt`, text, 'text/plain;charset=utf-8')
        toast.success(`已导出 ${conversations.length} 个会话（TXT）`)
        return true
      }
      if (format === 'html') {
        download(`念风-选中会话-${stamp}.html`, toAllHtml(conversations), 'text/html;charset=utf-8')
        toast.success(`已导出 ${conversations.length} 个会话（HTML）`)
        return true
      }
      const payload = {
        version: ctx.inject('app')?.version || '',
        app: '念风chat',
        exportedAt: new Date().toISOString(),
        conversations,
      }
      download(`念风-选中会话-${stamp}.json`, JSON.stringify(payload, null, 2), 'application/json')
      toast.success(`已导出 ${conversations.length} 个会话（JSON）`)
      return true
    },
    toMarkdown,
    toText,
    toCsv,
    toHtml,
    toAllHtml,
  }

  const off = events.on('export:conversation', ({ id, format }) => service.exportConversation(id, format))
  ctx.effect(off)

  ctx.provide('export-service', service, { type: 'singleton' })
  ctx.logger.debug('导出服务就绪（Markdown / JSON / TXT / HTML / CSV / PDF）')
}
