/**
 * 对话链路集成测试（真实 HTTP + SSE，不依赖云端 Key / Ollama）
 *
 *   本地 Mock OpenAI 兼容服务 ↔ 风语后端 /api/chat
 *
 * 覆盖：
 *   - 新建 OpenAI 兼容提供商（Base URL / API Key）
 *   - 真实拉取模型列表
 *   - 模型级参数（temperature / max_tokens）透传到请求体
 *   - 流式 SSE 收到多个 chunk 并正确结束
 *
 * 用法：npm run test:chat
 */
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startBackend } from '../server/index.mjs'
import { startMockOpenAI } from './mock-openai.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const dataDir = join(ROOT, '.tmp', `chat-test-${Date.now()}`)

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

async function main() {
  console.log('\n① 启动本地 Mock OpenAI + 风语后端')
  const mock = await startMockOpenAI({ port: 0, apiKey: 'sk-mock' })
  const backend = await startBackend({ port: 0, host: '127.0.0.1', dataDir })
  const base = backend.url
  console.log(`     Mock : ${mock.url}/v1`)
  console.log(`     后端 : ${base}`)
  check('Mock 服务已启动', mock.port > 0)
  check('后端已启动', backend.port > 0)

  console.log('\n② 通过 API 配置提供商（模拟设置页操作）')
  const created = await api(base, '/api/providers', {
    method: 'POST',
    body: { id: 'mock', type: 'openai', name: 'Mock OpenAI', baseURL: `${mock.url}/deepseek/v1`, apiKey: 'sk-mock' },
  })
  check('新增 OpenAI 兼容提供商', created.status === 201, `HTTP ${created.status}`)

  const refreshed = await api(base, '/api/providers/mock/refresh', { method: 'POST' })
  const refreshedBody = await refreshed.json()
  check('真实拉取模型列表', refreshed.status === 200 && refreshedBody.models?.some(m => m.id === 'mock-chat'), JSON.stringify(refreshedBody))
  check('模型列表请求带上了 API Key', refreshed.status === 200)

  const patched = await api(base, `/api/providers/mock/models/${encodeURIComponent('mock-chat')}`, {
    method: 'PUT',
    body: { params: { temperature: 0.3, maxTokens: 256 } },
  })
  check('保存模型参数（temperature / max_tokens）', patched.status === 200, `HTTP ${patched.status}`)
  await api(base, '/api/providers/mock', { method: 'PUT', body: { defaultModel: 'mock-chat', enabled: true } })

  console.log('\n③ 真实对话（/api/chat SSE）')
  const chatRes = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider: 'mock',
      model: 'mock-chat',
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: '请回复一段测试文本，并告诉我温度。' },
      ],
    }),
  })
  check('聊天接口返回 SSE', chatRes.status === 200 && (chatRes.headers.get('content-type') || '').includes('text/event-stream'))
  const raw = await chatRes.text()
  let text = ''
  let chunks = 0
  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue
    const payload = line.slice(5).trim()
    if (!payload || payload === '[DONE]') continue
    try {
      const data = JSON.parse(payload)
      if (data.delta) {
        text += data.delta
        chunks++
      }
    } catch (_) {
      /* 忽略无法解析的行 */
    }
  }
  check('收到多个流式 chunk', chunks > 10, `chunks=${chunks}`)
  check('回复内容来自 Mock 模型', text.includes('Mock 服务') || text.includes('对话链路'), text.slice(0, 80))
  check('模型级 temperature 已透传到请求体', text.includes('temperature=0.3'), text.slice(0, 80))
  check('SSE 正确结束（event: done）', raw.includes('event: done') || raw.includes('"length"'), raw.slice(-120))

  console.log('\n③b 推理等级（DeepSeek thinking / reasoning_effort）')
  const runChat = async (content, extra = {}) => {
    const res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'mock',
        model: 'mock-chat',
        messages: [{ role: 'user', content }],
        ...extra,
      }),
    })
    const streamText = await res.text()
    let assembled = ''
    for (const line of streamText.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (!payload || payload === '[DONE]') continue
      try {
        const data = JSON.parse(payload)
        if (data.delta) assembled += data.delta
      } catch (_) {
        /* ignore */
      }
    }
    return { raw: streamText, text: assembled }
  }
  const maxChat = await runChat('推理等级测试', { reasoningEffort: 'max' })
  check(
    'max 档：thinking enabled + reasoning_effort=max',
    maxChat.text.includes('thinking=enabled') && maxChat.text.includes('reasoning=max'),
    maxChat.text.slice(0, 90),
  )
  const offChat = await runChat('推理等级测试', { reasoningEffort: 'off' })
  check(
    'off 档：thinking disabled 且不发 reasoning_effort',
    offChat.text.includes('thinking=disabled') && offChat.text.includes('reasoning=none'),
    offChat.text.slice(0, 90),
  )

  console.log('\n④ 收尾')
  await backend.close()
  await mock.close()
  await rm(dataDir, { recursive: true, force: true }).catch(() => {})
  console.log(`\n结果：${results.length - failed}/${results.length} 项通过`)
  process.exit(failed ? 1 : 0)
}

main().catch(async err => {
  console.error('\n对话链路测试异常：', err)
  await rm(dataDir, { recursive: true, force: true }).catch(() => {})
  process.exit(1)
})
