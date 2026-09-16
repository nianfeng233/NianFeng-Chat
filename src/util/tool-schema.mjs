/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * 工具参数 JSON Schema 兼容收敛。
 *
 * OpenAI function calling 使用 JSON Schema，但不同厂商支持的子集不同：
 *   - Gemini 不支持 `type: ['object', 'string']` 这类联合类型；
 *   - 部分网关不接受 `additionalProperties`、`oneOf` 等扩展字段；
 *   - 数组缺少 `items` 时可能直接拒绝整个 tools 定义。
 *
 * 这里把所有插件注册的工具 schema 统一收敛成“单类型 + properties/items”
 * 的通用结构，保证同一套工具可以直接给 OpenAI / DeepSeek / Anthropic /
 * Gemini / Ollama 使用。工具 handler 本身仍可按兼容格式解析参数。
 */

const VALID_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'array', 'object'])

const normalizeTypeName = value => {
  const text = String(value ?? '').trim().toLowerCase()
  if (!text) return ''
  if (text === 'float' || text === 'double') return 'number'
  if (text === 'int') return 'integer'
  if (text === 'bool') return 'boolean'
  if (text === 'dict' || text === 'map') return 'object'
  return VALID_TYPES.has(text) ? text : ''
}

function pickSingleType(schema, root = false) {
  const raw = schema?.type
  const candidates = Array.isArray(raw)
    ? raw.map(normalizeTypeName).filter(Boolean)
    : [normalizeTypeName(raw)].filter(Boolean)

  const hasObjectHints =
    schema && typeof schema === 'object' && (schema.properties || schema.required || schema.additionalProperties)
  const hasArrayHints = schema && typeof schema === 'object' && schema.items

  if (root || hasObjectHints) return 'object'
  if (hasArrayHints) return 'array'
  if (candidates.length) {
    // 联合类型优先选择对调用方最宽松的 object / array / string。
    for (const preferred of ['object', 'array', 'string', 'number', 'integer', 'boolean']) {
      if (candidates.includes(preferred)) return preferred
    }
    return candidates[0]
  }
  return root ? 'object' : 'string'
}

/**
 * 把单个 schema 节点收敛为跨厂商都能接受的子集。
 * @param {unknown} input
 * @param {{root?: boolean}} options
 */
export function sanitizeToolSchema(input, { root = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return root ? { type: 'object', properties: {} } : { type: 'string' }
  }

  const type = pickSingleType(input, root)
  const out = { type }

  const description = input.description
  if (description !== undefined && description !== null && String(description).trim()) {
    out.description = String(description)
  }
  if (input.nullable === true) out.nullable = true

  if (Array.isArray(input.enum) && input.enum.length && type !== 'object' && type !== 'array') {
    out.enum = input.enum.map(value => (typeof value === 'object' ? String(value) : value))
  }

  if (type === 'object') {
    const properties = {}
    const source = input.properties && typeof input.properties === 'object' && !Array.isArray(input.properties) ? input.properties : {}
    for (const [key, value] of Object.entries(source)) {
      const name = String(key || '').trim()
      if (!name) continue
      properties[name] = sanitizeToolSchema(value)
    }
    out.properties = properties
    if (Array.isArray(input.required)) {
      const required = input.required
        .map(value => String(value || '').trim())
        .filter(name => name && Object.prototype.hasOwnProperty.call(properties, name))
      if (required.length) out.required = [...new Set(required)]
    }
  } else if (type === 'array') {
    // Gemini 要求 array 必须带 items；插件的 handler 一般都能处理字符串数组。
    out.items = sanitizeToolSchema(input.items || { type: 'string' })
  }

  return out
}

/**
 * Gemini functionDeclarations.parameters 专用版本。
 * 顶层必须是 OBJECT；所有 array 必须带 items；不接受 additionalProperties。
 */
export function toGeminiSchema(input) {
  const clean = sanitizeToolSchema(input, { root: true })
  if (clean.type !== 'object') return { type: 'object', properties: {} }
  if (!clean.properties || typeof clean.properties !== 'object') clean.properties = {}
  return clean
}

export default sanitizeToolSchema
