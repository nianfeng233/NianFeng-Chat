/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * WebUI → 后端终端代聊 E2E：
 *   1. 启动后端 + Mock OpenAI；
 *   2. 创建会话；
 *   3. 在 Worker 线程里启动服务端常驻代聊；
 *   4. POST /api/agent/send，模拟浏览器 WebUI 发消息；
 *   5. 验证消息由后端 Worker 的 chat-flow / chat_send 写回后端会话。
 */
import { Worker } from 'node:worker_threads'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startBackend } from '../server/index.mjs'
import { startMockOpenAI } from './mock-openai.mjs'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const checks = []
const check = (name, ok, detail = '') => {
  checks.push({ name, ok: !!ok, detail })
  console.log(`${ok ? '  ✔' : '  ✗'} ${name}${!ok && detail ? `  → ${detail}` : ''}`)
}
const api = (base, path, options = {}) =>
  fetch(`${base}${path}`, {
    method: options.method || 'GET',
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  })

const dataDir = await mkdtemp(join(tmpdir(), 'nianfeng-agent-bridge-'))
const mock = await startMockOpenAI({ port: 0 })
const backend = await startBackend({ port: 0, host: '127.0.0.1', dataDir })
const base = `${backend.url}/api`
let worker = null
try {
  console.log('\n① 准备 Mock 模型与会话')
  const provider = await api(base, '/providers', {
    method: 'POST',
    body: { id: 'mock', type: 'openai', name: 'Mock OpenAI', baseURL: `${mock.url}/v1`, apiKey: 'sk-mock' },
  })
  check('创建 Mock OpenAI 提供商', provider.status === 201, `HTTP ${provider.status}`)
  await api(base, '/providers/mock/refresh', { method: 'POST' })
  await api(base, '/providers/mock', { method: 'PUT', body: { defaultModel: 'mock-chat', enabled: true } })
  await backend.ctx.settings.update({ defaultProvider: 'mock', defaultModel: 'mock-chat' })

  const createdBody = await (await api(base, '/sessions', {
    method: 'POST',
    body: { name: 'Agent E2E', meta: { roleId: 'role-agent-e2e', persona: '你是一个测试助手，请通过 chat_send 回复。' } },
  })).json()
  const conversation = createdBody.conversation || createdBody
  check('创建测试会话', !!conversation?.id, JSON.stringify(createdBody))

  console.log('\n② 启动服务端常驻代聊 Worker')
  worker = new Worker(new URL('../src/headless/runtime.mjs', import.meta.url), {
    workerData: { backendUrl: base, accessToken: '' },
  })
  let workerReady = false
  let workerLog = ''
  worker.on('message', message => {
    if (message?.type === 'ready') workerReady = true
    workerLog += `\n[worker] ${JSON.stringify(message).slice(0, 300)}`
  })
  worker.on('error', err => {
    workerLog += `\n[worker-error] ${err?.stack || err}`
  })
  const readyDeadline = Date.now() + 20000
  while (Date.now() < readyDeadline && !workerReady) await sleep(200)
  check('服务端代聊 Worker 就绪', workerReady, workerLog.slice(-800))

  console.log('\n③ WebUI → 后端终端：发送消息')
  // WebUI 会先在本地回显用户消息，并把该消息 id 一起带到 agent/send；
  // Worker 落库必须复用这个 id，浏览器才能按 message_id 合并成同一条。
  const clientMessageId = 'm_e2e_local_echo'
  const send = await (await api(base, '/agent/send', {
    method: 'POST',
    body: { conversationId: conversation.id, clientId: 'e2e-client', clientMessageId, text: '你好，这是一条 E2E 测试消息。' },
  })).json()
  check('agent/send 入队成功', send?.ok === true, JSON.stringify(send))

  let messages = []
  const replyDeadline = Date.now() + 25000
  while (Date.now() < replyDeadline) {
    const result = await (await api(base, `/sessions/${conversation.id}/messages?all=1`)).json()
    messages = result?.messages || []
    if (messages.some(message => message.role === 'assistant' && String(message.content || '').trim())) break
    await sleep(500)
  }
  const user = messages.find(message => message.role === 'user' && String(message.content || '').includes('E2E 测试消息'))
  const assistant = messages.find(message => message.role === 'assistant' && String(message.content || '').trim())
  check('用户消息由后端 Worker 写回会话', !!user, JSON.stringify(messages.slice(-4)))
  check(
    'Worker 落库复用 WebUI 本地回显消息 id（避免重复气泡）',
    user?.id === clientMessageId && String(user?.message_id || '') === clientMessageId,
    JSON.stringify({ id: user?.id, message_id: user?.message_id, clientMessageId }),
  )
  check('助手回复由后端 chat_send 写回会话', !!assistant, JSON.stringify(messages.slice(-4)))
} finally {
  await worker?.terminate?.().catch(() => {})
  await backend.close().catch(() => {})
  await mock.close().catch(() => {})
  await rm(dataDir, { recursive: true, force: true }).catch(() => {})
}

const failed = checks.filter(item => !item.ok)
console.log(`\n结果：${checks.length - failed.length}/${checks.length} 项通过`)
if (failed.length) process.exit(1)
process.exit(0)
