/**
 * X8 · markdown-enhancer
 * 增强 Markdown：提供 markdown 服务，气泡实现按需调用。
 * 支持：# 标题、**粗体**、*斜体*、`行内代码`、```代码块```、列表、引用、链接、分割线。
 * 输出前统一转义，避免 XSS（文档 §10.6）。
 */
export const name = 'markdown-enhancer'
export const version = '1.0.0'
export const displayName = 'Markdown 增强'
export const description = '可选扩展 · 为气泡提供 Markdown 渲染服务。'
export const author = '风语社区'
export const icon = '📝'
export const core = false
export const enabled = true
export const inject = []
export const provides = [{ name: 'markdown', type: 'singleton' }]

export function apply(ctx) {
  const escape = s =>
    String(s ?? '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[m])

  const inline = text =>
    text
      .replace(/`([^`\n]+)`/g, (_, code) => `<code class="md-inline">${code}</code>`)
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
      .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')

  function render(text) {
    const source = String(text ?? '').replace(/\r\n?/g, '\n')
    const codeBlocks = []

    // 先把代码块抽出来，避免其中的 Markdown 被误处理。
    // 占位符用 NUL 包裹，后面按“整行代码块”或行内替换两种方式还原。
    const withoutCode = source.replace(/```([^\n`]*)\n?([\s\S]*?)```/g, (_, info, code) => {
      const lang = String(info || '')
        .trim()
        .split(/\s+/)[0]
        .replace(/[^\w#+.-]/g, '')
      const idx =
        codeBlocks.push(
          `<pre class="code md-code"${lang ? ` data-lang="${escape(lang)}"` : ''}>${escape(code.replace(/\n$/, ''))}</pre>`,
        ) - 1
      return `\u0000CODE${idx}\u0000`
    })

    const lines = withoutCode.split('\n')
    const html = []
    let listType = null
    let inQuote = false

    const closeList = () => {
      if (listType) {
        html.push(`</${listType}>`)
        listType = null
      }
    }
    const closeQuote = () => {
      if (inQuote) {
        html.push('</blockquote>')
        inQuote = false
      }
    }

    for (const rawLine of lines) {
      const blockOnly = rawLine.trim().match(/^\u0000CODE(\d+)\u0000$/)
      if (blockOnly) {
        closeList()
        closeQuote()
        html.push(codeBlocks[Number(blockOnly[1])] || '')
        continue
      }

      const line = rawLine
      if (!line.trim()) {
        closeList()
        closeQuote()
        continue
      }
      if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) {
        closeList()
        closeQuote()
        html.push('<hr class="md-hr">')
        continue
      }
      const heading = line.match(/^(#{1,4})\s+(.*)$/)
      if (heading) {
        closeList()
        closeQuote()
        const level = heading[1].length
        html.push(`<div class="md-h${level}">${inline(escape(heading[2]))}</div>`)
        continue
      }
      const quote = line.match(/^>\s?(.*)$/)
      if (quote) {
        closeList()
        if (!inQuote) {
          html.push('<blockquote class="md-quote">')
          inQuote = true
        }
        html.push(`<div>${inline(escape(quote[1]))}</div>`)
        continue
      }
      closeQuote()
      const ul = line.match(/^\s*[-*+]\s+(.*)$/)
      if (ul) {
        if (listType !== 'ul') {
          closeList()
          html.push('<ul class="md-list">')
          listType = 'ul'
        }
        html.push(`<li>${inline(escape(ul[1]))}</li>`)
        continue
      }
      const ol = line.match(/^\s*\d+[.)]\s+(.*)$/)
      if (ol) {
        if (listType !== 'ol') {
          closeList()
          html.push('<ol class="md-list">')
          listType = 'ol'
        }
        html.push(`<li>${inline(escape(ol[1]))}</li>`)
        continue
      }
      closeList()
      html.push(`<div class="md-p">${inline(escape(line))}</div>`)
    }
    closeList()
    closeQuote()

    // 行内代码块占位符在这里统一还原；代码块内容在抽取时已转义。
    return html.join('').replace(/\u0000CODE(\d+)\u0000/g, (_, index) => codeBlocks[Number(index)] || '')
  }

  ctx.provide('markdown', {
    name: 'markdown',
    render,
    /** 给不知道 markdown 插件的实现一个安全兜底 */
    escape,
  }, { type: 'singleton' })

  ctx.logger.debug('Markdown 服务就绪')
}
