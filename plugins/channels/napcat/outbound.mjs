/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * NapCat 渠道外发内容组装（纯函数，方便单测）。
 *
 * 一句话规则（对齐 AstrBot 的 platform_settings.forward_threshold 做法）：
 *   - 资料消息：正文进「合并转发（聊天记录）」，转发里第一条是标题，其后是一整段正文；
 *     多份资料各自一条转发，互不混在一条记录里；
 *   - 普通消息：字数超过阈值的长文同样折叠成转发记录，避免在群里刷屏；
 *   - 其它（短消息 / 图片）：原样返回文本与图片，走普通消息路径。
 *
 * 阈值、节点字数、节点数都可以通过 config 调整：
 *   chat.forwardThreshold / chat.forwardNodeChars / chat.forwardMaxNodes
 */
export const FORWARD_DEFAULTS = { threshold: 1500, nodeChars: 1500, maxNodes: 20 }

/**
 * 含 CQ 码 / [at:qq] 简写的消息不自动折叠：这类正文由 NapCat 桥按消息段解析
 * （@、图片、卡片等），折叠成转发节点会把它当成纯文本原样发出去。
 */
const CQ_MARKUP = /\[CQ:[a-zA-Z0-9_]+(?=[,\]])|\[at:(?:all|\d{3,20})\]/i

const clampNumber = (value, { min, max, fallback }) => {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return fallback
  return Math.min(Math.max(min, Math.round(number)), max)
}

/** 按字数上限切分长文本，尽量保持整行；超长单行再硬切。 */
export const splitByChars = (text, max) => {
  const value = String(text ?? '').trim()
  const limit = Math.max(1, Math.round(Number(max) || 0) || 1)
  if (!value) return []
  const parts = []
  let current = ''
  for (const line of value.split('\n')) {
    const next = current ? `${current}\n${line}` : line
    if (next.length <= limit) {
      current = next
      continue
    }
    if (current) parts.push(current)
    let rest = line
    while (rest.length > limit) {
      parts.push(rest.slice(0, limit))
      rest = rest.slice(limit)
    }
    current = rest
  }
  if (current) parts.push(current)
  return parts
}

/** 长文本 -> 转发节点；超过节点上限时截断，并在末节点标注省略字数。 */
export const forwardNodesFromText = (text, { nodeChars = FORWARD_DEFAULTS.nodeChars, maxNodes = FORWARD_DEFAULTS.maxNodes } = {}) => {
  const value = String(text ?? '').trim()
  if (!value) return []
  const chunks = splitByChars(value, nodeChars)
  const nodes = chunks.slice(0, maxNodes).map(chunk => ({ name: '', text: chunk }))
  if (chunks.length > maxNodes) {
    const omitted = chunks.slice(maxNodes).join('').length
    nodes[nodes.length - 1] = { name: '', text: `${nodes[nodes.length - 1].text}\n\n……（内容过长，已省略约 ${omitted} 字）` }
  }
  return nodes
}

/**
 * 资料消息 -> 合并转发节点：第一条是标题，往下是一整段正文（超长正文按节点上限续接）。
 * 取不到原文（资料已被清理 / 换了运行环境）时退回标题 + 缩略，绝不发空转发。
 */
export const documentForwardNodes = (
  message,
  { nodeChars = FORWARD_DEFAULTS.nodeChars, maxNodes = FORWARD_DEFAULTS.maxNodes, resolveDocument } = {},
) => {
  const title = String(message?.meta?.title || message?.content || '资料').trim()
  const summary = String(message?.meta?.summary || '').trim()
  const docId = String(message?.meta?.docId || message?.meta?.doc_id || '').trim()
  const doc = docId && typeof resolveDocument === 'function' ? resolveDocument(docId) : null
  const content = String(doc?.content || '').trim()
  const nodes = [{ name: '', text: title || '未命名资料' }]
  if (content) nodes.push(...forwardNodesFromText(content, { nodeChars, maxNodes }))
  else if (summary) nodes.push({ name: '', text: summary })
  return nodes.slice(0, maxNodes)
}

/**
 * 创建外发组装器。
 * @param {{ config?: { get?: Function }, resolveDocument?: (docId: string) => object|null }} options
 */
export function createOutboundPlanner(options = {}) {
  const readConfig = (key, fallback) => {
    try {
      const value = options.config?.get?.(key, fallback)
      return value === undefined || value === null ? fallback : value
    } catch (_) {
      return fallback
    }
  }
  const threshold = () => clampNumber(readConfig('chat.forwardThreshold', FORWARD_DEFAULTS.threshold), { min: 100, max: 2000000, fallback: FORWARD_DEFAULTS.threshold })
  const nodeChars = () => clampNumber(readConfig('chat.forwardNodeChars', FORWARD_DEFAULTS.nodeChars), { min: 200, max: 5000, fallback: FORWARD_DEFAULTS.nodeChars })
  const maxNodes = () => clampNumber(readConfig('chat.forwardMaxNodes', FORWARD_DEFAULTS.maxNodes), { min: 1, max: 60, fallback: FORWARD_DEFAULTS.maxNodes })
  const resolveDocument = typeof options.resolveDocument === 'function' ? options.resolveDocument : () => null

  const limits = () => ({ threshold: threshold(), nodeChars: nodeChars(), maxNodes: maxNodes() })

  /** 组装一次外发：{ text, images, forward? }（forward 存在时表示走合并转发）。 */
  const buildOutboundContent = message => {
    if (!message) return { text: '', images: [] }
    const images = Array.isArray(message.meta?.images) ? message.meta.images.slice(0, 4) : []
    if (message.kind === 'document' || message.content_type === 'document') {
      const forward = documentForwardNodes(message, { nodeChars: nodeChars(), maxNodes: maxNodes(), resolveDocument })
      return { text: '', images: [], forward }
    }
    const text = String(message.content || '').trim()
    if (text && text.length > threshold() && !CQ_MARKUP.test(text)) {
      return { text: '', images, forward: forwardNodesFromText(text, { nodeChars: nodeChars(), maxNodes: maxNodes() }) }
    }
    return { text, images }
  }

  return { limits, splitByChars, forwardNodesFromText, documentForwardNodes, buildOutboundContent }
}
