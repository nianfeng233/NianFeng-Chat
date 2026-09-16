/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * 厂商协议适配测试（真实 HTTP / SSE）
 *
 * 覆盖：
 *   - DeepSeek 官方：thinking / reasoning_effort、reasoning_content 回传、
 *     不发送 tool_choice（对齐官方 deepseek-harness）
 *   - Anthropic Claude：tools / tool_use / tool_result 转换与流式解析
 *   - Google Gemini：functionDeclarations / functionCall / functionResponse 转换与流式解析
 *   - 通用 OpenAI 兼容：tool_choice / max_tokens 参数不被网关接受时的逐项降级重试
 *
 * 用法：npm run test:vendors
 */
import { createServer } from 'node:http'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startBackend } from '../server/index.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const dataDir = join(ROOT, '.tmp', `vendors-${Date.now()}`)

const results = []
let failed = 0
function check(name, ok, detail = '') {
  results.push({ name, ok })
  if (!ok) failed++
  console.log(`${ok ? '  ✔' : '  ✗'} ${name}${ok ? '' : '  → ' + detail}`)
}

const api = (base, path, options = {}) =>
  fetch(`${base}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    body: options.body ? JSON.stringify(options.body) : undefined,
  })

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {})
      } catch (err) {
        reject(err)
      }
    })
    req.on('error', reject)
  })
}

function sse(res, events) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
  for (const event of events) {
    if (event.type) res.write(`event: ${event.type}\n`)
    res.write(`data: ${JSON.stringify(event.data)}\n\n`)
  }
  res.write('data: [DONE]\n\n')
  res.end()
}

function json(res, status, data) {
  const body = JSON.stringify(data)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) })
  res.end(body)
}

function parseChatSse(raw) {
  const events = []
  let type = ''
  let dataLines = []
  const dispatch = () => {
    if (!type && !dataLines.length) return
    let data = null
    try {
      data = dataLines.length ? JSON.parse(dataLines.join('\n')) : null
    } catch (_) {
      data = null
    }
    events.push({ type: type || 'message', data })
    type = ''
    dataLines = []
  }
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith('event:')) type = line.slice(6).trim()
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
    else if (!line.trim()) dispatch()
  }
  dispatch()
  return events
}

async function startVendorServer() {
  const captured = { deepseek: [], anthropic: [], gemini: [], fallback: [] }
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
    const path = url.pathname

    if (req.method === 'GET' && path.endsWith('/models')) {
      if (path.includes('/anthropic/')) return json(res, 200, { data: [{ id: 'claude-test', display_name: 'Claude Test' }] })
      if (path.includes('/gemini/')) {
        return json(res, 200, { models: [{ name: 'models/gemini-flash', displayName: 'Gemini Flash', supportedGenerationMethods: ['generateContent'] }] })
      }
      return json(res, 200, { data: [{ id: path.includes('/deepseek/') ? 'deepseek-v4-flash' : 'mock-chat', object: 'model' }] })
    }

    if (req.method !== 'POST') return json(res, 404, { error: { message: 'not found' } })

    let body = {}
    try {
      body = await readJson(req)
    } catch (_) {
      return json(res, 400, { error: { message: 'invalid json' } })
    }

    if (path.includes('/deepseek/chat/completions')) {
      captured.deepseek.push(body)
      const hasTrigger = (body.messages || []).some(message => String(message.content || '').includes('__reasoning_400__'))
      const triggerAttempts = captured.deepseek.filter(item =>
        (item.messages || []).some(message => String(message.content || '').includes('__reasoning_400__')),
      ).length
      if (hasTrigger && triggerAttempts === 1) {
        // 模拟 DeepSeek 思考模式的 reasoning_content 400，用于验证适配器的降级重试。
        return json(res, 400, {
          error: {
            message: 'The `reasoning_content` in the thinking mode must be passed back to the API.',
            type: 'invalid_request_error',
            param: null,
            code: 'invalid_request_error',
          },
        })
      }
      return sse(res, [
        {
          data: {
            choices: [
              {
                index: 0,
                delta: {
                  role: 'assistant',
                  reasoning_content: '我先想一下。',
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_deepseek_1',
                      type: 'function',
                      function: { name: 'chat_send', arguments: JSON.stringify({ messages: ['DeepSeek 工具回复'], end: true }) },
                    },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
          },
        },
      ])
    }

    if (path.includes('/anthropic/v1/messages')) {
      captured.anthropic.push(body)
      return sse(res, [
        { type: 'message_start', data: { type: 'message_start', message: { id: 'msg_test' } } },
        { type: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_test', name: 'chat_send' } } },
        {
          type: 'content_block_delta',
          data: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ messages: ['Claude 工具回复'], end: true }) } },
        },
        { type: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
        { type: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'tool_use' } } },
        { type: 'message_stop', data: { type: 'message_stop' } },
      ])
    }

    if (path.includes(':streamGenerateContent')) {
      captured.gemini.push(body)
      return sse(res, [
        {
          data: {
            candidates: [
              {
                content: {
                  role: 'model',
                  parts: [
                    { text: 'Gemini 的思考', thought: true },
                    { functionCall: { id: 'gemini_call_1', name: 'chat_send', args: { messages: ['Gemini 工具回复'], end: true } } },
                  ],
                },
                finishReason: 'STOP',
              },
            ],
          },
        },
      ])
    }

    if (path.includes('/fallback/chat/completions')) {
      captured.fallback.push(body)
      if (body.tool_choice) return json(res, 400, { error: { message: 'Unsupported parameter: tool_choice' } })
      if (body.max_tokens) return json(res, 400, { error: { message: 'max_tokens is not supported; use max_completion_tokens' } })
      return sse(res, [{ data: { choices: [{ index: 0, delta: { content: 'fallback ok' }, finish_reason: 'stop' }] } }])
    }

    return json(res, 404, { error: { message: `not found: ${req.method} ${path}` } })
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    captured,
    close: () =>
      new Promise(resolve => {
        try {
          server.closeIdleConnections?.()
          server.closeAllConnections?.()
        } catch (_) {
          /* ignore */
        }
        server.close(resolve)
      }),
  }
}

async function chat(base, provider, model, body = {}) {
  const res = await api(base, '/api/chat', { method: 'POST', body: { provider, model, messages: [{ role: 'user', content: '你好' }], ...body } })
  const raw = await res.text()
  return { status: res.status, raw, events: parseChatSse(raw) }
}

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'chat_send',
      description: '发送聊天消息',
      parameters: { type: 'object', properties: { messages: { type: 'array', items: { type: 'string' } }, end: { type: 'boolean' } }, required: ['messages'] },
    },
  },
]

/** 模拟旧插件里 Gemini 不支持的联合类型 / additionalProperties schema。 */
const SCHEMA_TOOLS = [
  ...TOOLS,
  {
    type: 'function',
    function: {
      name: 'legacy_schema_test',
      description: '工具 schema 兼容性测试',
      parameters: {
        type: 'object',
        properties: {
          config: { type: ['object', 'string'], additionalProperties: true },
          fields: { type: ['string', 'array'], items: { type: 'string' } },
          targets: { type: 'array', items: { type: ['string', 'object'], properties: { qq: { type: 'string' } } } },
        },
        required: ['config'],
      },
    },
  },
]

function schemaHasUnsupportedFields(schema) {
  if (Array.isArray(schema)) return true
  if (!schema || typeof schema !== 'object') return false
  if (Array.isArray(schema.type)) return true
  if (Object.prototype.hasOwnProperty.call(schema, 'additionalProperties')) return true
  if (schema.type === 'array' && !schema.items) return true
  return Object.values(schema.properties || {}).some(schemaHasUnsupportedFields)
}

async function main() {
  console.log('\n① 启动厂商 Mock + 念风后端')
  const vendor = await startVendorServer()
  const backend = await startBackend({ port: 0, host: '127.0.0.1', dataDir })
  const base = backend.url
  console.log(`     Vendor Mock : ${vendor.url}`)
  console.log(`     后端         : ${base}`)

  const providers = [
    ['deepseek', { type: 'deepseek', name: 'DeepSeek', baseURL: `${vendor.url}/deepseek`, apiKey: 'test', models: [{ id: 'deepseek-v4-flash', name: 'Flash' }] }],
    ['claude', { type: 'anthropic', name: 'Claude', baseURL: `${vendor.url}/anthropic`, apiKey: 'test', models: [{ id: 'claude-test', name: 'Claude Test' }] }],
    ['gemini', { type: 'gemini', name: 'Gemini', baseURL: `${vendor.url}/gemini`, apiKey: 'test', models: [{ id: 'gemini-flash', name: 'Gemini Flash' }] }],
    ['fallback', { type: 'openai', name: 'Fallback', baseURL: `${vendor.url}/fallback`, apiKey: 'test', models: [{ id: 'mock-chat', name: 'Mock' }] }],
  ]
  for (const [id, provider] of providers) {
    const created = await api(base, '/api/providers', { method: 'POST', body: { id, ...provider } })
    check(`新增提供商 ${id}`, created.status === 201, `HTTP ${created.status}`)
  }

  console.log('\n② DeepSeek 官方协议')
  const deepseekCall = await chat(base, 'deepseek', 'deepseek-v4-flash', { tools: TOOLS, toolChoice: 'required', reasoningEffort: 'high' })
  const deepseekBody = vendor.captured.deepseek.at(-1)
  check('DeepSeek 请求带 tools', Array.isArray(deepseekBody?.tools) && deepseekBody.tools[0].function.name === 'chat_send')
  check('DeepSeek 不发送 tool_choice（对齐官方 harness）', deepseekBody?.tool_choice === undefined)
  check(
    'DeepSeek high -> thinking enabled + reasoning_effort',
    deepseekBody?.thinking?.type === 'enabled' && deepseekBody?.reasoning_effort === 'high',
    JSON.stringify({ thinking: deepseekBody?.thinking, reasoning_effort: deepseekBody?.reasoning_effort }),
  )
  check('DeepSeek 流式返回 reasoning 事件', deepseekCall.events.some(event => event.type === 'reasoning' && event.data?.delta === '我先想一下。'))
  check('DeepSeek 流式返回 tool_call 事件', deepseekCall.events.some(event => event.type === 'tool_call' && event.data?.name === 'chat_send'))
  const deepseekDone = deepseekCall.events.find(event => event.type === 'done')?.data
  check('DeepSeek done 带完整 toolCalls', deepseekDone?.toolCalls?.[0]?.function?.name === 'chat_send', JSON.stringify(deepseekDone))

  await chat(base, 'deepseek', 'deepseek-v4-flash', { reasoningEffort: 'off' })
  const deepseekOff = vendor.captured.deepseek.at(-1)
  check('DeepSeek off -> thinking disabled 且不带 reasoning_effort', deepseekOff?.thinking?.type === 'disabled' && deepseekOff.reasoning_effort === undefined)

  console.log('\n③ DeepSeek 历史 reasoning_content 回传')
  const historyMessages = [
    { role: 'system', content: '你是测试角色' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_prev', type: 'function', function: { name: 'chat_send', arguments: '{"messages":["上一轮"],"end":true}' } }], reasoning_content: '历史推理内容' },
    { role: 'tool', tool_call_id: 'call_prev', name: 'chat_send', content: '{"ok":true}' },
    { role: 'user', content: '继续' },
  ]
  const historyResponse = await api(base, '/api/chat', {
    method: 'POST',
    body: { provider: 'deepseek', model: 'deepseek-v4-flash', messages: historyMessages, tools: TOOLS, reasoningEffort: 'low' },
  })
  // 必须消费完 SSE 流：fetch 只等响应头，mock 端记录请求体 / 适配器发请求
  // 与后面的断言存在竞态，之前偶发拿不到最新 body（32/34）。
  await historyResponse.text()
  const withHistory = vendor.captured.deepseek.at(-1)
  const assistantWire = withHistory.messages.find(message => message.role === 'assistant' && message.tool_calls)
  check('DeepSeek assistant 历史保留 reasoning_content', assistantWire?.reasoning_content === '历史推理内容', JSON.stringify(assistantWire))
  check('DeepSeek 历史工具结果保留 role=tool', withHistory.messages.some(message => message.role === 'tool' && message.tool_call_id === 'call_prev'))

  console.log('\n③b DeepSeek reasoning_content 缺失补全与 400 降级')
  const missingReasoningMessages = [
    { role: 'system', content: '你是测试角色' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_missing', type: 'function', function: { name: 'chat_send', arguments: '{"messages":["上一轮"],"end":true}' } }] },
    { role: 'tool', tool_call_id: 'call_missing', name: 'chat_send', content: '{"ok":true}' },
    { role: 'user', content: '继续' },
  ]
  await api(base, '/api/chat', {
    method: 'POST',
    body: { provider: 'deepseek', model: 'deepseek-v4-flash', messages: missingReasoningMessages, tools: TOOLS, reasoningEffort: 'high' },
  }).then(response => response.text())
  const paddedBody = vendor.captured.deepseek.findLast(body =>
    (body.messages || []).some(message => message.tool_calls?.some(call => call.id === 'call_missing')),
  )
  const paddedAssistant = paddedBody?.messages.find(message => message.role === 'assistant' && message.tool_calls)
  check(
    'DeepSeek 工具历史缺少 reasoning_content 时自动补空字段',
    paddedAssistant?.reasoning_content === '',
    JSON.stringify(paddedAssistant),
  )

  const reasoningFallbackMessages = [
    { role: 'system', content: '你是测试角色' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_retry', type: 'function', function: { name: 'chat_send', arguments: '{"messages":["上一轮"],"end":true}' } }], reasoning_content: '旧的推理内容' },
    { role: 'tool', tool_call_id: 'call_retry', name: 'chat_send', content: '{"ok":true}' },
    { role: 'user', content: '__reasoning_400__ 继续' },
  ]
  const reasoningFallbackResponse = await api(base, '/api/chat', {
    method: 'POST',
    body: { provider: 'deepseek', model: 'deepseek-v4-flash', messages: reasoningFallbackMessages, tools: TOOLS, reasoningEffort: 'high' },
  })
  const reasoningFallbackRaw = await reasoningFallbackResponse.text()
  const reasoningAttempts = vendor.captured.deepseek.filter(body =>
    (body.messages || []).some(message => String(message.content || '').includes('__reasoning_400__')),
  )
  const firstReasoningAttempt = reasoningAttempts[0]
  const lastReasoningAttempt = reasoningAttempts.at(-1)
  check(
    'DeepSeek reasoning_content 400 会自动降级重试并完成',
    reasoningAttempts.length >= 2 && reasoningFallbackRaw.includes('event: done') && !reasoningFallbackRaw.includes('event: error'),
    reasoningFallbackRaw.slice(0, 240),
  )
  check(
    '首次请求保留 thinking enabled 与历史 reasoning_content',
    firstReasoningAttempt?.thinking?.type === 'enabled' && firstReasoningAttempt.messages.some(message => message.reasoning_content === '旧的推理内容'),
    JSON.stringify(firstReasoningAttempt && { thinking: firstReasoningAttempt.thinking }),
  )
  check(
    '降级请求关闭 thinking 并移除全部 reasoning_content',
    lastReasoningAttempt?.thinking?.type === 'disabled' &&
      !(lastReasoningAttempt.messages || []).some(message => message.reasoning_content !== undefined),
    JSON.stringify(lastReasoningAttempt && { thinking: lastReasoningAttempt.thinking, messages: lastReasoningAttempt.messages?.slice(-3) }),
  )

  console.log('\n④ Anthropic Claude 协议')
  const claudeMessages = [
    { role: 'system', content: '你是测试角色' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'toolu_prev', type: 'function', function: { name: 'chat_send', arguments: '{"messages":["上一轮"],"end":false}' } }] },
    { role: 'tool', tool_call_id: 'toolu_prev', name: 'chat_send', content: '{"ok":true,"message_ids":["m_1"]}' },
    { role: 'user', content: '继续' },
  ]
  const claudeCall = await chat(base, 'claude', 'claude-test', { messages: claudeMessages, tools: TOOLS, toolChoice: 'required' })
  const claudeBody = vendor.captured.anthropic.at(-1)
  check('Claude 请求使用 tools[].input_schema', claudeBody?.tools?.[0]?.name === 'chat_send' && !!claudeBody.tools[0].input_schema)
  check('Claude required -> tool_choice any', claudeBody?.tool_choice?.type === 'any', JSON.stringify(claudeBody?.tool_choice))
  const assistantBlocks = claudeBody?.messages?.find(message => message.role === 'assistant')?.content
  check('Claude assistant tool_calls -> tool_use 内容块', Array.isArray(assistantBlocks) && assistantBlocks.some(block => block.type === 'tool_use' && block.id === 'toolu_prev'))
  const toolResultBlocks = claudeBody?.messages?.flatMap(message => (Array.isArray(message.content) ? message.content : [])).find(block => block.type === 'tool_result')
  check('Claude 工具结果 -> user.tool_result 内容块', !!toolResultBlocks && toolResultBlocks.tool_use_id === 'toolu_prev')
  check('Claude 流式 text/tool_use 正确结束', claudeCall.events.some(event => event.type === 'done' && event.data?.toolCalls?.[0]?.function?.name === 'chat_send'), claudeCall.raw.slice(0, 200))

  console.log('\n⑤ Google Gemini 协议')
  const geminiMessages = [
    { role: 'system', content: '你是测试角色' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'gemini_prev', type: 'function', function: { name: 'chat_send', arguments: '{"messages":["上一轮"],"end":false}' } }] },
    { role: 'tool', tool_call_id: 'gemini_prev', name: 'chat_send', content: '{"ok":true,"message_ids":["m_1"]}' },
    { role: 'user', content: '继续' },
  ]
  const geminiCall = await chat(base, 'gemini', 'gemini-flash', { messages: geminiMessages, tools: SCHEMA_TOOLS, toolChoice: 'required', temperature: 0.5 })
  const geminiBody = vendor.captured.gemini.at(-1)
  check('Gemini 请求使用 functionDeclarations', geminiBody?.tools?.[0]?.functionDeclarations?.[0]?.name === 'chat_send', JSON.stringify(geminiBody?.tools))
  const legacyDeclaration = (geminiBody?.tools?.[0]?.functionDeclarations || []).find(item => item.name === 'legacy_schema_test')
  check(
    'Gemini functionDeclarations 会收敛联合类型 / additionalProperties / 缺 items 数组',
    !!legacyDeclaration &&
      legacyDeclaration.parameters?.type === 'object' &&
      !schemaHasUnsupportedFields(legacyDeclaration.parameters),
    JSON.stringify(legacyDeclaration?.parameters),
  )
  check('Gemini required -> toolConfig ANY', geminiBody?.toolConfig?.functionCallingConfig?.mode === 'ANY', JSON.stringify(geminiBody?.toolConfig))
  check('Gemini temperature -> generationConfig', geminiBody?.generationConfig?.temperature === 0.5)
  const modelParts = geminiBody?.contents?.find(item => item.role === 'model')?.parts || []
  check('Gemini assistant tool_calls -> functionCall', modelParts.some(part => part.functionCall?.name === 'chat_send'))
  const responseParts = geminiBody?.contents?.flatMap(item => item.parts || []).find(part => part.functionResponse)
  check('Gemini 工具结果 -> functionResponse', responseParts?.functionResponse?.name === 'chat_send', JSON.stringify(responseParts))
  check('Gemini 流式 reasoning 事件', geminiCall.events.some(event => event.type === 'reasoning' && event.data?.delta === 'Gemini 的思考'))
  check('Gemini 流式 functionCall 转为 tool_call', geminiCall.events.some(event => event.type === 'tool_call' && event.data?.name === 'chat_send'))
  const geminiDone = geminiCall.events.find(event => event.type === 'done')?.data
  check('Gemini done 带完整 toolCalls', geminiDone?.toolCalls?.[0]?.function?.name === 'chat_send', JSON.stringify(geminiDone))

  console.log('\n⑥ 通用 OpenAI 兼容参数降级')
  const fallbackCall = await chat(base, 'fallback', 'mock-chat', { tools: TOOLS, toolChoice: 'required', maxTokens: 123 })
  check('tool_choice / max_tokens 被网关拒绝后仍成功', fallbackCall.events.some(event => event.type === 'done'), fallbackCall.raw.slice(0, 200))
  check('第一次请求带 tool_choice', vendor.captured.fallback[0]?.tool_choice === 'required')
  check('重试后带 tools 但移除 tool_choice', vendor.captured.fallback[1]?.tool_choice === undefined && Array.isArray(vendor.captured.fallback[1]?.tools))
  check('max_tokens 被拒绝后改用 max_completion_tokens', vendor.captured.fallback.at(-1)?.max_completion_tokens === 123 && vendor.captured.fallback.at(-1)?.max_tokens === undefined)

  console.log('\n⑦ 收尾')
  await backend.close()
  await vendor.close()
  await rm(dataDir, { recursive: true, force: true }).catch(() => {})
  console.log(`\n结果：${results.length - failed}/${results.length} 项通过`)
  process.exit(failed ? 1 : 0)
}

main().catch(async err => {
  console.error('\n厂商协议测试异常：', err)
  await rm(dataDir, { recursive: true, force: true }).catch(() => {})
  process.exit(1)
})
