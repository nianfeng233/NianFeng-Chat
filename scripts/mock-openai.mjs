/**
 * 本地 OpenAI 兼容 Mock 服务（开发 / 集成测试用，不进入应用 UI）。
 *
 *   npm run mock:openai            # 默认监听 127.0.0.1:18099
 *   MOCK_PORT=19001 npm run mock:openai
 *
 * 提供：
 *   GET  /v1/models            返回一个 mock-chat 模型
 *   POST /v1/chat/completions  支持 stream=true 的 SSE 流式回复
 *                              带 tools 时返回确定性的 tool_calls（chat_send / read_messages / send_document），
 *                              用于验证风语的工具调用链路；普通文本请求行为不变。
 *
 * 用途：在没有任何云端 Key / 本地 Ollama 的机器上，验证风语的
 * 「提供商 → /api/chat → SSE → 气泡」完整链路。它不是模型，也不假装是模型。
 */
import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'

const DEFAULT_REPLY = '这是一段来自本地 OpenAI 兼容 Mock 服务的真实流式回复，用于验证风语对话链路。'

function readBody(req) {
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

/** 根据对话状态选择要模拟的工具调用（确定性，便于集成测试） */
function chooseToolCall(body, question, replyText = REPLY_TEXT) {
  const messages = body.messages || []
  const last = messages[messages.length - 1]
  const toolResults = messages.filter(message => message.role === 'tool')
  let callId = 0
  const call = (name, args) => ({ id: `call_mock_${++callId}`, name, args })

  if (last?.role === 'user' || (!toolResults.length && last?.role !== 'tool')) {
    if (/两条|两条消息|多段/.test(question)) {
      return call('chat_send', { messages: ['第一条消息', '第二条消息'], end: true })
    }
    if (/资料|文献|长文|文档/.test(question)) {
      return call('send_document', {
        title: 'Mock 资料',
        summary: '这是一份用于验证 send_document 的资料缩略',
        content_type: 'text/markdown',
        content: '# Mock 资料\n\n' + '这是资料原文，不应该出现在聊天记录里。'.repeat(30),
        end: true,
      })
    }
    if (/读.*(记录|历史|消息)|翻.*记录|上下文/.test(question)) {
      return call('read_messages', { query: '', limit: 3 })
    }
    if (/权限|跨渠道|别的渠道/.test(question)) {
      return call('read_messages', { channel: 'qq:private:99999', limit: 1 })
    }
    return call('chat_send', { messages: [replyText], end: body.model === 'deepseek-v4-flash' ? false : true })
  }

  // 上一轮是工具结果：根据结果决定下一步
  const lastTool = toolResults[toolResults.length - 1]
  const content = String(lastTool?.content || '')
  if (content.includes('目标渠道不可用') || content.includes('CHANNEL_UNAVAILABLE')) {
    return call('chat_send', { messages: ['那个渠道我暂时访问不了。'], end: true })
  }
  if (content.includes('"messages"') || content.includes('"truncated"')) {
    return call('chat_send', { messages: ['我查过之前的记录了，你最开始说的是你好。'], end: true })
  }
  return call('chat_send', { messages: ['我处理好了。'], end: true })
}

const REPLY_TEXT = '这是一段来自本地 OpenAI 兼容 Mock 服务的真实流式回复，用于验证风语对话链路。'

/** 以 OpenAI SSE 格式流式返回一个 tool_call */
async function streamToolCall(res, body, call, sleep, reasoningText = '') {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })
  const model = body.model || 'mock-chat'
  const chunk = payload => res.write(`data: ${JSON.stringify({ id: 'chatcmpl-mock', object: 'chat.completion.chunk', model, choices: [{ index: 0, ...payload }] })}\n\n`)
  if (reasoningText) {
    chunk({ delta: { reasoning_content: reasoningText } })
    await sleep(4)
  }
  chunk({ delta: { role: 'assistant', content: null, tool_calls: [{ index: 0, id: call.id, type: 'function', function: { name: call.name, arguments: '' } }] } })
  const args = JSON.stringify(call.args)
  for (let i = 0; i < args.length; i += 16) {
    chunk({ delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(i, i + 16) } }] } })
    await sleep(3)
  }
  chunk({ delta: {}, finish_reason: 'tool_calls' })
  res.write('data: [DONE]\n\n')
  res.end()
}

/**
 * @returns {Promise<{url:string,port:number,close:()=>Promise<void>}>}
 */
export async function startMockOpenAI({ port = 18099, host = '127.0.0.1', apiKey = 'sk-mock', reply = DEFAULT_REPLY } = {}) {
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
  const requests = []

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
    const auth = String(req.headers.authorization || '')
    const authorized = !apiKey || auth === `Bearer ${apiKey}`

    const json = (status, data) => {
      const body = JSON.stringify(data)
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) })
      res.end(body)
    }

    if (url.pathname.endsWith('/models')) {
      if (!authorized) return json(401, { error: { message: 'invalid api key' } })
      return json(200, { object: 'list', data: [{ id: 'mock-chat', object: 'model', owned_by: 'fengyu-mock' }] })
    }

    if (url.pathname.endsWith('/chat/completions') && req.method === 'POST') {
      if (!authorized) return json(401, { error: { message: 'invalid api key' } })
      let body
      try {
        body = await readBody(req)
      } catch (_) {
        return json(400, { error: { message: 'invalid json' } })
      }
      requests.push(body)
      const reasoningText = body.thinking?.type === 'enabled' || body.reasoning_effort ? '这是 DeepSeek 风格的推理内容。' : ''
      const lastUser = [...(body.messages || [])].reverse().find(message => message.role === 'user')
      const question = String(lastUser?.content || '')
      let text = reply
      if (question.includes('温度') || question.includes('temperature')) text = `[temperature=${body.temperature ?? '未传'}] ${reply}`
      if (question.includes('推理') || body.thinking || body.reasoning_effort) {
        text = `[thinking=${body.thinking?.type ?? 'none'},reasoning=${body.reasoning_effort ?? 'none'}] ${reply}`
      }
      if (question.includes('ping')) text = 'pong'

      // function calling：当调用方带 tools 时，用确定性的脚本模拟工具调用，
      // 覆盖“读记录 / 发资料 / 无权限渠道 / 普通 chat_send”四条路径。
      if (Array.isArray(body.tools) && body.tools.length) {
        const call = chooseToolCall(body, question, text)
        if (call) {
          if (!body.stream) {
            return json(200, {
              id: 'chatcmpl-mock',
              object: 'chat.completion',
              model: body.model || 'mock-chat',
              choices: [
                {
                  index: 0,
                  message: { role: 'assistant', content: null, tool_calls: [{ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] },
                  finish_reason: 'tool_calls',
                },
              ],
            })
          }
          return streamToolCall(res, body, call, sleep, reasoningText)
        }
      }

      if (!body.stream) {
        return json(200, {
          id: 'chatcmpl-mock',
          object: 'chat.completion',
          model: body.model || 'mock-chat',
          choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
        })
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      })
      const pieces = [...text]
      if (reasoningText) {
        res.write(`data: ${JSON.stringify({ id: 'chatcmpl-mock', object: 'chat.completion.chunk', model: body.model || 'mock-chat', choices: [{ index: 0, delta: { reasoning_content: reasoningText } }] })}\n\n`)
        await sleep(8)
      }
      for (const piece of pieces) {
        res.write(`data: ${JSON.stringify({ id: 'chatcmpl-mock', object: 'chat.completion.chunk', model: body.model || 'mock-chat', choices: [{ index: 0, delta: { content: piece } }] })}\n\n`)
        await sleep(8)
      }
      res.write(`data: ${JSON.stringify({ id: 'chatcmpl-mock', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }

    json(404, { error: { message: `not found: ${req.method} ${url.pathname}` } })
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, resolve)
  })
  const actualPort = server.address().port

  return {
    url: `http://${host}:${actualPort}`,
    port: actualPort,
    reply,
    requests,
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

// 直接运行：一直提供 Mock 服务
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mock = await startMockOpenAI({ port: Number(process.env.MOCK_PORT || 18099) })
  console.log(`\n  Mock OpenAI 兼容服务已启动：${mock.url}/v1`)
  console.log('  在 设置 → 模型 里新增 OpenAI 兼容提供商：')
  console.log(`    Base URL: ${mock.url}/v1`)
  console.log('    API Key : sk-mock（任意非空值也可）')
  console.log('  然后获取模型列表并选择 mock-chat。按 Ctrl+C 停止。\n')
}
