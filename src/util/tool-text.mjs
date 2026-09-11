/**
 * 文本形式的工具调用解析（模型不支持原生 function calling 时的兼容层）。
 *
 * 支持：
 *   1. <tool_call>{"name":"chat_send","arguments":{...}}</tool_call>
 *   2. <function_call>...</function_call>
 *   3. 裸 JSON / ```json 代码块（必须包含已注册工具名）
 *   4. 类 DSLM / invoke 标记：
 *        <|DSLM|calls>
 *        <|DSLM|invoke name="chat_send">
 *          <|DSLM|parameter name="message" string="true">你好<|DSLM|parameter>
 *          <|DSLM|parameter name="end" string="false">false<|DSLM|parameter>
 *        <|DSLM|invoke>
 *        <|DSLM|calls>
 *      （同时兼容普通 <invoke name="x"><parameter name="y">…</parameter></invoke>）
 *
 * 解析结果统一为 OpenAI function-calling 结构：
 *   { id, type:'function', function:{ name, arguments } }
 * 其中 arguments 是 JSON 字符串，与原生 tool_calls 完全一致。
 */

const MARKER_RE = /<\s*(\/?)\s*\|?\s*((?:D\s*S\s*(?:L\s*M|M\s*L))\s*\|?\s*)?((?:tool_?)?calls?|invoke|parameter)\b([^>]*)>/gi
const JSON_BLOCK_RE = /<\s*\/?\s*(?:tool_call|function_call)\s*>([\s\S]*?)<\s*\/\s*(?:tool_call|function_call)\s*>/gi
const FENCED_JSON_RE = /```(?:json)?\s*([\s\S]*?)```/gi

const KNOWN_TOOL_HINT_RE = /"(?:name|tool|function)"\s*:\s*"[A-Za-z_][\w.-]*"/i

/** 是否包含工具调用标记（用于“绝不把标记当正文展示”的兜底判断） */
export function looksLikeToolMarkup(text) {
  const raw = String(text ?? '').replace(/[｜丨]/g, '|')
  if (!raw.trim()) return false
  if (/<\s*\/?\s*\|?\s*(?:D\s*S\s*(?:L\s*M|M\s*L)|(?:tool_?)?calls?|function_call|invoke|parameter)\b/i.test(raw)) return true
  if (/<\|tool[▁_\s-]?calls?/i.test(raw)) return true
  if (KNOWN_TOOL_HINT_RE.test(raw) && /\{\s*"(?:name|tool|function)"/.test(raw)) return true
  return false
}

/**
 * @param {string} text 模型输出的正文
 * @param {string[]} knownTools 已注册工具名；不在名单里的调用会被忽略
 * @returns {Array<{id:string,type:string,function:{name:string,arguments:string}}>|null}
 */
export function parseTextToolCalls(text, knownTools = []) {
  const raw = String(text ?? '').replace(/[｜丨]/g, '|')
  if (!raw.trim()) return null
  const known = new Set((knownTools || []).filter(Boolean))
  if (!known.size) return null

  const calls = []

  // 1. <tool_call> / <function_call> JSON
  JSON_BLOCK_RE.lastIndex = 0
  let match
  while ((match = JSON_BLOCK_RE.exec(raw))) {
    const call = parseJsonToolCall(match[1], known, calls.length + 1)
    if (call) calls.push(call)
  }

  // 2. 裸 JSON / fenced JSON
  if (!calls.length) {
    const candidates = []
    FENCED_JSON_RE.lastIndex = 0
    while ((match = FENCED_JSON_RE.exec(raw))) candidates.push(match[1])
    const trimmed = raw.trim()
    if (/^\{[\s\S]*\}$/.test(trimmed)) candidates.push(trimmed)
    // 从正文里提取平衡的 JSON 对象（最多尝试 5 个）
    for (const chunk of extractJsonObjects(raw).slice(0, 5)) candidates.push(chunk)
    for (const candidate of candidates) {
      const call = parseJsonToolCall(candidate, known, calls.length + 1)
      if (call && !calls.some(item => sameCall(item, call))) calls.push(call)
    }
  }

  // 3. DSLM / invoke 标记
  if (!calls.length) calls.push(...parseMarkers(raw, known))

  return calls.length ? calls : null
}

/* ------------------------------------------------------------------ */

function parseJsonToolCall(text, known, index) {
  const raw = String(text ?? '').trim()
  if (!raw) return null
  // 去掉可能残留的标记包装
  const cleaned = raw.replace(/^<[^>]*>|<\/?[^>]*>$/g, '').trim()
  let parsed
  for (const candidate of [cleaned, raw]) {
    try {
      parsed = JSON.parse(candidate)
      break
    } catch (_) {
      /* 继续尝试 */
    }
  }
  if (!parsed || typeof parsed !== 'object') return null
  const source = Array.isArray(parsed) ? parsed[0] : parsed
  if (!source || typeof source !== 'object') return null

  const name = source.name || source.tool || source.function?.name || source.function_name
  if (!name || !known.has(String(name))) return null
  let args = source.arguments ?? source.args ?? source.parameters ?? source.input ?? source.function?.arguments ?? source.function?.parameters
  if (args === undefined || args === null) {
    // 有些模型把参数直接铺在顶层
    const { name: _n, tool: _t, function: _f, ...rest } = source
    args = rest
  }
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args || '{}')
    } catch (_) {
      args = { raw: args }
    }
  }
  if (!args || typeof args !== 'object') args = {}
  return {
    id: source.id || `call_text_${index}_${Math.random().toString(36).slice(2, 8)}`,
    type: 'function',
    function: { name: String(name), arguments: JSON.stringify(args) },
  }
}

function parseMarkers(raw, known) {
  const calls = []
  const re = new RegExp(MARKER_RE.source, 'gi')
  let currentCall = null
  let currentParam = null
  let match

  const finishParam = endIndex => {
    if (!currentParam) return
    const value = raw.slice(currentParam.valueStart, endIndex).replace(/\s+$/, '')
    if (currentCall && !currentCall.ignored && currentParam.name) {
      currentCall.args[currentParam.name] = coerceValue(value, currentParam.attrs)
    }
    currentParam = null
  }

  const pushCall = () => {
    if (!currentCall) return
    if (!currentCall.ignored && currentCall.name && known.has(currentCall.name)) {
      calls.push({
        id: currentCall.id,
        type: 'function',
        function: { name: currentCall.name, arguments: JSON.stringify(currentCall.args) },
      })
    }
    currentCall = null
  }

  while ((match = re.exec(raw))) {
    const [, slash, , kindRaw, attrs] = match
    const kind = String(kindRaw).toLowerCase()
    const hasName = /\bname\s*=\s*["']/i.test(attrs)
    const closing = !!slash || !hasName

    if (kind === 'invoke' || /^(?:tool_?)?call$/.test(kind)) {
      finishParam(match.index)
      if (closing) {
        pushCall()
      } else {
        pushCall()
        const name = attrValue(attrs, 'name')
        currentCall = {
          id: `call_text_${calls.length + 1}_${Math.random().toString(36).slice(2, 8)}`,
          name,
          args: {},
          ignored: !name || !known.has(name),
        }
      }
      continue
    }

    if (kind === 'parameter') {
      finishParam(match.index)
      if (!closing) {
        currentParam = {
          name: attrValue(attrs, 'name'),
          valueStart: match.index + match[0].length,
          attrs,
        }
      }
      continue
    }

    // calls 标记：只作为分隔，不需要额外处理
    finishParam(match.index)
  }

  finishParam(raw.length)
  pushCall()
  return calls
}

function coerceValue(value, attrs = '') {
  const text = String(value ?? '')
  const trimmed = text.trim()
  const explicitString = /(?:string|type)\s*=\s*["']?true["']?/i.test(attrs) && !/type\s*=\s*["']?(?:boolean|bool|number|int|float)/i.test(attrs)
  if (explicitString) return text
  if (trimmed === '') return ''
  if (trimmed === 'true') return true
  if (trimmed === 'false') return false
  if (trimmed === 'null') return null
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed)
  if (/^[\[{]/.test(trimmed)) {
    try {
      return JSON.parse(trimmed)
    } catch (_) {
      /* 保持字符串 */
    }
  }
  return text
}

function attrValue(attrs, name) {
  if (!attrs) return ''
  const match = attrs.match(new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i'))
  return match ? match[1] ?? match[2] ?? '' : ''
}

function extractJsonObjects(text) {
  const out = []
  let depth = 0
  let start = -1
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === '{') {
      if (depth === 0) start = i
      depth += 1
    } else if (ch === '}') {
      depth -= 1
      if (depth === 0 && start >= 0) {
        out.push(text.slice(start, i + 1))
        start = -1
      }
      if (depth < 0) depth = 0
    }
  }
  return out
}

function sameCall(a, b) {
  return a?.function?.name === b?.function?.name && a?.function?.arguments === b?.function?.arguments
}
