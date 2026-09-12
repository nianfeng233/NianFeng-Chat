/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * Nova 渠道 · 工具循环集成测试
 *
 *   本地 Mock OpenAI（带 function calling） ↔ 念风后端 /api/chat ↔ 前端插件链路
 *
 * 覆盖文档第一阶段：
 *   - WebUI 会话 = nova:web:<会话id> 渠道，消息带 message_id / seq / timestamp / source
 *   - chat-flow 工具循环：read_messages / chat_send / send_document / read_document
 *   - 工作记忆 + 渠道记忆合并、untrusted 用户内容包装
 *   - 普通用户跨渠道读写被统一拒绝为“目标渠道不可用”
 *   - 高权限用户的跨渠道操作触发敏感确认（输入“确认”同意，其它拒绝）
 *
 * 用法：npm run test:chat-tools
 */
import './dom-shim.mjs'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startBackend } from '../server/index.mjs'
import { startMockOpenAI } from './mock-openai.mjs'
import { looksLikeToolMarkup, parseTextToolCalls } from '../src/util/tool-text.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const dataDir = join(ROOT, '.tmp', `chat-tools-${Date.now()}`)

const results = []
let failed = 0
function check(name, ok, detail = '') {
  results.push({ name, ok })
  if (!ok) failed++
  console.log(`${ok ? '  ✔' : '  ✗'} ${name}${ok ? '' : '  → ' + detail}`)
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const waitFor = async (fn, { timeout = 8000, interval = 25 } = {}) => {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    const value = await fn()
    if (value) return value
    await sleep(interval)
  }
  return null
}

const api = (base, path, options = {}) =>
  fetch(`${base}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    body: options.body ? JSON.stringify(options.body) : undefined,
  })

async function main() {
  localStorage.clear()

  console.log('\n① 启动 Mock OpenAI + 后端 + WebUI 插件系统')
  const mock = await startMockOpenAI({ port: 0, apiKey: 'sk-mock' })
  const backend = await startBackend({ port: 0, host: '127.0.0.1', dataDir })
  const base = backend.url

  // 一个明确不支持 function calling 的适配器：验证 chat-flow 的降级路径
  backend.ctx.models.registerAdapter('plain', {
    label: '纯文本测试',
    async listModels() {
      return [{ id: 'plain-chat', name: 'Plain Chat' }]
    },
    async test() {
      return { detail: '纯文本适配器可用' }
    },
    async stream({ options, onChunk, onDone }) {
      if (options?.tools?.length) throw new Error('tool_choice is not supported by this provider')
      const text = '这是模型不支持工具时的普通降级回复。'
      for (const char of text) {
        onChunk(char)
        await sleep(2)
      }
      onDone({})
    },
  })

  // 一个把工具调用输出成 DSLM 文本标记的适配器：验证文本协议兼容解析
  backend.ctx.models.registerAdapter('dslm', {
    label: 'DSLM 文本协议测试',
    async listModels() {
      return [{ id: 'dslm-chat', name: 'DSLM Chat' }]
    },
    async test() {
      return { detail: 'DSLM 适配器可用' }
    },
    async stream({ messages, onChunk, onDone }) {
      const hasToolResult = (messages || []).some(
        message => message.role === 'tool' || (message.role === 'user' && String(message.content || '').startsWith('[工具结果]')),
      )
      const sentence = hasToolResult ? '第二句也发完了' : '文本工具协议第一句'
      const end = hasToolResult ? 'true' : 'false'
      const text = `<|DSLM|calls>
<|DSLM|invoke name="chat_send">
<|DSLM|parameter name="message" string="true">${sentence}<|DSLM|parameter>
<|DSLM|parameter name="end" string="false">${end}<|DSLM|parameter>
<|DSLM|invoke>
<|DSLM|calls>`
      for (const char of text) {
        onChunk(char)
        await sleep(1)
      }
      onDone({})
    },
  })

  // 一个输出无法解析工具标记的适配器：验证“工具标记绝不进聊天气泡”
  backend.ctx.models.registerAdapter('broken', {
    label: '坏工具标记测试',
    async listModels() {
      return [{ id: 'broken-chat', name: 'Broken Chat' }]
    },
    async test() {
      return { detail: '坏标记适配器可用' }
    },
    async stream({ onChunk, onDone }) {
      const text = '<tool_call>这不是 JSON，也没有调用任何工具</tool_call>'
      for (const char of text) {
        onChunk(char)
        await sleep(1)
      }
      onDone({})
    },
  })

  // 一个忽略 tools、始终直接输出正文的适配器：验证严格工具模式
  const chattyRequests = []
  backend.ctx.models.registerAdapter('chatty', {
    label: '直出正文测试',
    async listModels() {
      return [{ id: 'chatty-1', name: 'Chatty' }]
    },
    async test() {
      return { detail: '直出正文适配器可用' }
    },
    async stream({ messages, onChunk, onDone }) {
      chattyRequests.push(JSON.parse(JSON.stringify(messages || [])))
      const text = '我是直接输出的正文。'
      for (const char of text) {
        onChunk(char)
        await sleep(1)
      }
      onDone({})
    },
  })

  console.log(`     Mock : ${mock.url}/v1`)
  console.log(`     后端 : ${base}`)

  const created = await api(base, '/api/providers', {
    method: 'POST',
    body: { id: 'mock', type: 'openai', name: 'Mock OpenAI', baseURL: `${mock.url}/deepseek/v1`, apiKey: 'sk-mock' },
  })
  check('新增 Mock OpenAI 提供商', created.status === 201, `HTTP ${created.status}`)
  await api(base, '/api/providers/mock/refresh', { method: 'POST' })
  await api(base, '/api/providers/mock', { method: 'PUT', body: { defaultModel: 'mock-chat', enabled: true } })
  await backend.ctx.settings.update({ defaultProvider: 'mock', defaultModel: 'mock-chat' })

  const plain = await api(base, '/api/providers', {
    method: 'POST',
    body: { id: 'plain', type: 'plain', name: '纯文本测试', baseURL: 'plain://local' },
  })
  check('新增纯文本提供商（用于降级测试）', plain.status === 201, `HTTP ${plain.status}`)
  await api(base, '/api/providers/plain/refresh', { method: 'POST' })
  await api(base, '/api/providers/plain', { method: 'PUT', body: { defaultModel: 'plain-chat', enabled: true } })

  const dslm = await api(base, '/api/providers', {
    method: 'POST',
    body: { id: 'dslm', type: 'dslm', name: 'DSLM 文本协议测试', baseURL: 'dslm://local' },
  })
  check('新增 DSLM 提供商（用于文本工具协议测试）', dslm.status === 201, `HTTP ${dslm.status}`)
  await api(base, '/api/providers/dslm/refresh', { method: 'POST' })
  await api(base, '/api/providers/dslm', { method: 'PUT', body: { defaultModel: 'dslm-chat', enabled: true } })

  const broken = await api(base, '/api/providers', {
    method: 'POST',
    body: { id: 'broken', type: 'broken', name: '坏工具标记测试', baseURL: 'broken://local' },
  })
  check('新增坏工具标记提供商（用于拦截测试）', broken.status === 201, `HTTP ${broken.status}`)
  await api(base, '/api/providers/broken/refresh', { method: 'POST' })
  await api(base, '/api/providers/broken', { method: 'PUT', body: { defaultModel: 'broken-chat', enabled: true } })

  const deepseek = await api(base, '/api/providers', {
    method: 'POST',
    body: {
      id: 'deepseek',
      type: 'deepseek',
      name: 'DeepSeek Mock',
      baseURL: `${mock.url}/deepseek`,
      apiKey: 'sk-mock',
    },
  })
  check('新增 DeepSeek 模拟提供商（用于推理回传测试）', deepseek.status === 201, `HTTP ${deepseek.status}`)
  await api(base, '/api/providers/deepseek/refresh', { method: 'POST' })
  await api(base, '/api/providers/deepseek/models', {
    method: 'POST',
    body: { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
  })
  await api(base, '/api/providers/deepseek', { method: 'PUT', body: { defaultModel: 'deepseek-v4-flash', enabled: true } })

  const chatty = await api(base, '/api/providers', {
    method: 'POST',
    body: { id: 'chatty', type: 'chatty', name: '直出正文测试', baseURL: 'chatty://local' },
  })
  check('新增直出正文提供商（用于严格工具模式测试）', chatty.status === 201, `HTTP ${chatty.status}`)
  await api(base, '/api/providers/chatty/refresh', { method: 'POST' })
  await api(base, '/api/providers/chatty', { method: 'PUT', body: { defaultModel: 'chatty-1', enabled: true } })

  const appRoot = document.createElement('div')
  appRoot.id = 'app'
  document.body.appendChild(appRoot)
  localStorage.setItem('nianfeng:config', JSON.stringify({ data: { backend: { url: `${base}/api` } } }))

  const { ctx, loader } = await import('../src/main.mjs').then(mod => mod.boot())
  await sleep(500)
  await waitFor(() => ctx.inject('model-registry')?.list?.().length > 0, { timeout: 6000 })
  await waitFor(() => ctx.inject('chat-store') && ctx.inject('chat-tools') && ctx.inject('context-builder'), { timeout: 6000 })
  // 显式选中 Mock 模型，避免提供商默认项互相覆盖影响测试
  await waitFor(() => ctx.inject('model-registry')?.list?.().some(item => item.key === 'mock/mock-chat'), { timeout: 4000 })
  ctx.inject('model-registry').select('mock/mock-chat')

  const list = loader.list()
  const errors = list.filter(item => item.status === 'error')
  const inactive = list.filter(item => item.status === 'inactive')
  check('没有 error 插件', errors.length === 0, errors.map(item => `${item.id}: ${item.reason}`).join(' | '))
  check('没有 inactive 插件（新增服务依赖齐全）', inactive.length === 0, inactive.map(item => `${item.id}: ${item.reason}`).join(' | '))
  for (const name of ['chat-store', 'document-service', 'chat-permissions', 'chat-queue', 'tool-registry', 'chat-tools', 'context-builder']) {
    check(`服务 ${name} 已注册`, ctx.registry.list().some(service => service.name === name))
  }

  const sessions = ctx.inject('session-service')
  const messages = ctx.inject('message-service')
  const config = ctx.inject('config')
  const store = ctx.inject('chat-store')
  const tools = ctx.inject('chat-tools')
  const documents = ctx.inject('document-service')
  const builder = ctx.inject('context-builder')
  const permissions = ctx.inject('chat-permissions')
  const flow = ctx.inject('chat-flow')
  const channelRegistry = ctx.inject('channel-registry')
  config.set('chat.simulateTyping', false)

  check('chat-flow 运行在工具模式', flow.mode() === 'tools', flow.mode())

  console.log('\n② 发送第一条消息：模型通过 chat_send 工具回复')
  const conv1 = sessions.create({ name: 'Nova 测试角色', meta: { roleId: 'role-test', persona: '你是冒烟测试角色，说话简短。' } })
  sessions.activate(conv1.id)
  const channel1 = store.channelForConversation(conv1.id)
  check('会话自动获得 Nova 渠道 ID', channel1?.channelId === `nova:web:${conv1.id}`, JSON.stringify(channel1))
  check('会话 meta 写入渠道元数据', sessions.get(conv1.id)?.meta?.channelType === 'nova', JSON.stringify(sessions.get(conv1.id)?.meta))

  const modelService = ctx.inject('model-service')
  const originalStream = modelService.stream
  let captured = null
  modelService.stream = function (modelMessages, options, callbacks) {
    captured = { messages: JSON.parse(JSON.stringify(modelMessages)), options: { ...options } }
    return originalStream.call(this, modelMessages, options, callbacks)
  }
  messages.requestSend(conv1.id, '你好')
  await waitFor(() => captured, { timeout: 3000 })
  modelService.stream = originalStream

  check('模型请求带上了工具定义', Array.isArray(captured?.options?.tools) && captured.options.tools.some(tool => tool.function?.name === 'chat_send'), JSON.stringify(captured?.options?.tools?.map(tool => tool.function?.name)))
  check('system 段落包含人设与工具规则', captured?.messages?.[0]?.role === 'system' && captured.messages[0].content.includes('冒烟测试角色') && captured.messages[0].content.includes('chat_send'), captured?.messages?.[0]?.content?.slice(0, 80))
  const wrappedUser = captured?.messages?.find(message => message.role === 'user')
  check('用户内容按 untrusted 紧凑 JSON 包装', typeof wrappedUser?.content === 'string' && wrappedUser.content.includes('"trust":"untrusted"'), String(wrappedUser?.content || '').slice(0, 120))

  const firstReply = await waitFor(() => {
    const prev = sessions.messages(conv1.id).at(-1)
    return prev?.role === 'assistant' && prev.content && prev.content.includes('本地 OpenAI 兼容 Mock 服务') ? prev : null
  })
  check('chat_send 工具发送的消息出现在聊天记录', !!firstReply, JSON.stringify(sessions.messages(conv1.id).slice(-2)))

  console.log('\n③ 结构化消息元数据（文档 §4.1）')
  const stored = store.messagesOf(channel1.channelId)
  const userMessage = stored.find(message => message.role === 'user' && message.content === '你好')
  const assistantMessage = stored.find(message => message.role === 'assistant' && message.content === firstReply?.content)
  check('消息带 channel_id', userMessage?.channel_id === channel1.channelId && assistantMessage?.channel_id === channel1.channelId)
  check('消息带稳定 message_id', !!userMessage?.message_id && userMessage.message_id === userMessage.id)
  check('消息带单调 seq', Number(userMessage?.seq) === 1 && Number(assistantMessage?.seq) === 2, `${userMessage?.seq} / ${assistantMessage?.seq}`)
  check('消息带 ISO timestamp', !Number.isNaN(Date.parse(userMessage?.timestamp || '')) && !Number.isNaN(Date.parse(assistantMessage?.timestamp || '')))
  check(
    '消息带 sender / role / source / visibility',
    ['我', 'web-user'].includes(userMessage?.sender_id) &&
      userMessage.source === 'nova' &&
      userMessage.visibility === 'shareable' &&
      assistantMessage?.is_bot === true,
    JSON.stringify(userMessage),
  )
  check('投递状态机推进', await waitFor(() => (sessions.message(conv1.id, userMessage.id)?.status || '') !== 'sent', { timeout: 3000 }))

  console.log('\n④ read_messages：模型主动读取历史')
  messages.requestSend(conv1.id, '帮我读一下前面的记录')
  const readReply = await waitFor(() => {
    const last = sessions.messages(conv1.id).at(-1)
    return last?.role === 'assistant' && last.content.includes('我查过之前的记录') ? last : null
  })
  check('read_messages 工具结果驱动了下一轮 chat_send', !!readReply, JSON.stringify(sessions.messages(conv1.id).slice(-2)))
  const afterRead = store.messagesOf(channel1.channelId)
  check('工具协议消息不会作为聊天消息出现', afterRead.every(message => message.role === 'user' || message.role === 'assistant'), JSON.stringify(afterRead.map(message => message.role)))
  const toolRead = await tools.execute('read_messages', { query: '你好', limit: 5 }, {
    conversationId: conv1.id,
    channelId: channel1.channelId,
    roleId: 'role-test',
    userId: 'web-user',
    sentContents: new Map(),
  })
  check(
    'read_messages 返回 total / returned / next_cursor',
    toolRead.ok === true && toolRead.total >= 1 && toolRead.returned >= 1 && 'next_cursor' in toolRead,
    JSON.stringify(toolRead).slice(0, 160),
  )

  console.log('\n⑤ send_document：资料原文入资料库，聊天记录只存引用')
  messages.requestSend(conv1.id, '发一份资料给我')
  const docMessage = await waitFor(() => {
    const last = sessions.messages(conv1.id).at(-1)
    return last?.kind === 'document' ? last : null
  })
  check('聊天记录出现资料消息', !!docMessage, JSON.stringify(sessions.messages(conv1.id).slice(-2)))
  check('资料消息带 doc_id 与缩略', !!docMessage?.meta?.docId?.startsWith('doc_') && docMessage.content.includes('缩略'), JSON.stringify(docMessage?.meta))
  const doc = documents.get(docMessage?.meta?.docId)
  check('资料库保存了原文', !!doc && doc.content.includes('资料原文'), doc ? `${doc.length} 字` : 'missing')
  check('聊天记录不存资料全文', !String(docMessage?.content || '').includes('资料原文'), String(docMessage?.content || '').slice(0, 80))

  const readDoc = await tools.execute('read_document', { doc_id: doc.doc_id, max_tokens: 100 }, {
    conversationId: conv1.id,
    channelId: channel1.channelId,
    roleId: 'role-test',
    userId: 'web-user',
    sentContents: new Map(),
  })
  check('read_document 按 token 上限分段读取', readDoc.ok === true && readDoc.truncated === true && readDoc.next_offset > 0, JSON.stringify(readDoc).slice(0, 160))

  console.log('\n⑥ 普通用户跨渠道：统一返回“目标渠道不可用”')
  const denied = await tools.execute('chat_send', { channel: 'qq:private:99999', messages: ['越权消息'], end: true }, {
    conversationId: conv1.id,
    channelId: channel1.channelId,
    roleId: 'role-test',
    userId: 'web-user',
    sentContents: new Map(),
  })
  check('未知 / 无权限渠道被拒绝', denied.ok === false && denied.error === '目标渠道不可用' && denied.code === 'CHANNEL_UNAVAILABLE', JSON.stringify(denied))

  messages.requestSend(conv1.id, '测试一下跨渠道权限')
  const boundaryReply = await waitFor(() => {
    const last = sessions.messages(conv1.id).at(-1)
    return last?.role === 'assistant' && last.content.includes('那个渠道我暂时访问不了') ? last : null
  })
  check('模型收到拒绝结果后改用当前渠道回复', !!boundaryReply, JSON.stringify(sessions.messages(conv1.id).slice(-2)))

  console.log('\n⑦ 工作记忆 + 渠道记忆合并')
  const conv2 = sessions.create({ name: '另一个 Nova 渠道', meta: { roleId: 'role-test' } })
  const channel2 = store.channelForConversation(conv2.id)
  const working = store.workingMessages({ roleId: 'role-test' })
  check('工作记忆包含同角色的其它渠道消息', working.some(message => message.channel_id === channel1.channelId), JSON.stringify(working.map(message => message.channel_id)))
  const built = builder.build({ conversationId: conv2.id, roleId: 'role-test', persona: '你是冒烟测试角色。' })
  const builtText = built.messages.map(message => message.content).join('\n')
  check('新渠道上下文合并了工作记忆', builtText.includes('你好') && builtText.includes('"trust":"untrusted"'), builtText.slice(0, 160))
  check('上下文带当前时间 / 时区 / 渠道元数据', builtText.includes('当前时间：') && builtText.includes('当前渠道：') && built.messages[0].role === 'system')
  check('context-builder 受 token 预算约束', built.stats.memoryTokens <= built.stats.budget, JSON.stringify(built.stats))

  console.log('\n⑦b 渠道设置里勾选跨渠道权限：来源侧策略直接生效')
  sessions.update(conv1.id, { meta: { ...sessions.get(conv1.id).meta, crossReadable: true, sensitiveConfirm: false } })
  store.channelForConversation(conv1.id)
  config.set('chat.confirmSensitive', true)
  const sourceAllowed = await permissions.authorize({ conversationId: conv1.id, action: 'read', channel: channel2.channelId })
  check('渠道设置即可放行跨渠道读取（无需额外 grants）', sourceAllowed.ok === true, JSON.stringify(sourceAllowed))
  const sourceRead = await tools.execute('read_messages', { channel: conv2.name, limit: 5 }, {
    conversationId: conv1.id,
    channelId: channel1.channelId,
    roleId: 'role-test',
    userId: 'web-user',
    sentContents: new Map(),
  })
  check('按渠道名解析并读取记录', sourceRead.ok === true && sourceRead.channel === channel2.channelId, JSON.stringify(sourceRead).slice(0, 160))
  const crossPrompt = builder.build({ conversationId: conv1.id, roleId: 'role-test' })
  check('上下文告知模型已开启跨渠道权限', String(crossPrompt.messages[0]?.content || '').includes('跨渠道读取'), String(crossPrompt.messages[0]?.content || '').slice(0, 120))
  sessions.update(conv1.id, { meta: { ...sessions.get(conv1.id).meta, crossReadable: false, sensitiveConfirm: true } })
  store.channelForConversation(conv1.id)

  console.log('\n⑧ 高权限用户的跨渠道访问与敏感确认')
  sessions.update(conv2.id, { meta: { ...sessions.get(conv2.id).meta, crossReadable: true, crossSendable: true } })
  store.channelForConversation(conv2.id) // 刷新渠道策略
  permissions.grant({ roleId: 'role-test', userId: 'web-user', sourceChannel: channel1.channelId, targetChannel: channel2.channelId, canCrossRead: true, canCrossSend: true })
  config.set('chat.confirmSensitive', false)
  const crossAllowed = await permissions.authorize({ conversationId: conv1.id, action: 'read', channel: channel2.channelId })
  check('授权后跨渠道读取放行', crossAllowed.ok === true, JSON.stringify(crossAllowed))

  config.set('chat.confirmSensitive', true)
  const seen = []
  const offConfirm = ctx.on('chat:confirm-request', payload => seen.push(payload))
  const beforeConfirmCount = sessions.messages(conv1.id).length
  const pendingDecision = permissions.authorize({ conversationId: conv1.id, action: 'send', channel: channel2.channelId })
  await waitFor(() => seen.length > 0, { timeout: 2000 })
  check('敏感操作发出确认请求', seen.length === 1 && seen[0].targetChannel === channel2.channelId, JSON.stringify(seen[0]))
  check(
    '确认文案包含目标渠道类型与名称',
    seen[0]?.targetName?.includes('渠道') === true && String(seen[0]?.targetName || '').includes(channel2.channelId),
    JSON.stringify(seen[0]?.targetName),
  )
  messages.requestSend(conv1.id, '确认')
  const confirmed = await pendingDecision
  await sleep(80)
  check('输入“确认”后跨渠道操作继续', confirmed.ok === true, JSON.stringify(confirmed))
  check('确认输入不会进入聊天记录', sessions.messages(conv1.id).length === beforeConfirmCount, `${beforeConfirmCount} → ${sessions.messages(conv1.id).length}`)
  offConfirm()

  const rejectedPromise = permissions.authorize({ conversationId: conv1.id, action: 'send', channel: channel2.channelId })
  await waitFor(() => permissions.hasPending(conv1.id), { timeout: 2000 })
  const beforeRejectCount = sessions.messages(conv1.id).length
  messages.requestSend(conv1.id, '不要')
  const rejected = await rejectedPromise
  await sleep(80)
  check('其它输入视为拒绝并返回工具错误', rejected.ok === false && rejected.code === 'CONFIRM_REJECTED', JSON.stringify(rejected))
  check('拒绝输入同样不会进入聊天记录', sessions.messages(conv1.id).length === beforeRejectCount, `${beforeRejectCount} → ${sessions.messages(conv1.id).length}`)
  check('审计日志记录了敏感操作', permissions.audit(20).length >= 3, `${permissions.audit(20).length} 条`)

  console.log('\n⑨ 模型不支持工具时的兼容降级')
  const registry = ctx.inject('model-registry')
  await waitFor(() => registry.list().some(item => item.key === 'plain/plain-chat'), { timeout: 4000 })
  check('纯文本模型已同步到前端注册表', registry.list().some(item => item.key === 'plain/plain-chat'))
  registry.select('plain/plain-chat')
  const conv3 = sessions.create({ name: '降级测试会话', meta: { roleId: 'role-plain', persona: '你是纯文本测试角色。' } })
  sessions.activate(conv3.id)
  messages.requestSend(conv3.id, '你好')
  const fallbackReply = await waitFor(() => {
    const last = sessions.messages(conv3.id).at(-1)
    return last?.role === 'assistant' && last.content.includes('普通降级回复') ? last : null
  }, { timeout: 6000 })
  check('模型拒绝 tool_choice 后自动回退为普通流式回复', !!fallbackReply, JSON.stringify(sessions.messages(conv3.id).slice(-2)))
  check('降级回复不带工具痕迹', (fallbackReply?.content || '').includes('普通降级回复') && flow.mode() === 'tools')

  console.log('\n⑩ 文本工具调用（DSLM 标记）兼容')
  const sample = `<|DSLM|calls>
<|DSLM|invoke name="chat_send">
<|DSLM|parameter name="message" string="true">解析检查<|DSLM|parameter>
<|DSLM|parameter name="end" string="false">false<|DSLM|parameter>
<|DSLM|invoke>
<|DSLM|calls>`
  check('能识别 DSLM 工具标记', looksLikeToolMarkup(sample) === true)
  const parsedSample = parseTextToolCalls(sample, ['chat_send'])
  const parsedArgs = parsedSample?.[0] ? JSON.parse(parsedSample[0].function.arguments) : {}
  check(
    'DSLM 解析为合法 tool_call',
    parsedSample?.[0]?.function?.name === 'chat_send' && parsedArgs.message === '解析检查' && parsedArgs.end === false,
    JSON.stringify(parsedSample),
  )
  const jsonSample = '<tool_call>{"name":"chat_send","arguments":{"messages":["JSON 协议"],"end":true}}</tool_call>'
  check('兼容 <tool_call> JSON 协议', parseTextToolCalls(jsonSample, ['chat_send'])?.[0]?.function?.name === 'chat_send')
  check('普通文本不会被误判为工具标记', looksLikeToolMarkup('你好，今天天气不错') === false)

  await waitFor(() => registry.list().some(item => item.key === 'dslm/dslm-chat'), { timeout: 4000 })
  check('DSLM 模型已同步到前端注册表', registry.list().some(item => item.key === 'dslm/dslm-chat'))
  registry.select('dslm/dslm-chat')
  const conv4 = sessions.create({ name: '文本协议测试会话', meta: { roleId: 'role-dslm', persona: '你是文本协议测试角色。' } })
  sessions.activate(conv4.id)
  messages.requestSend(conv4.id, '你好')
  const firstTextual = await waitFor(() => {
    const last = sessions.messages(conv4.id).at(-1)
    return last?.role === 'assistant' && last.content === '文本工具协议第一句' ? last : null
  }, { timeout: 6000 })
  const secondTextual = await waitFor(
    () => sessions.messages(conv4.id).find(message => message.role === 'assistant' && message.content === '第二句也发完了') || null,
    { timeout: 6000 },
  )
  check('DSLM 文本工具调用被解析并真正发送了消息', !!firstTextual && !!secondTextual, JSON.stringify(sessions.messages(conv4.id).map(m => m.content)))
  const textualContents = sessions.messages(conv4.id).map(message => String(message.content || ''))
  check('工具标记没有进入任何聊天气泡', textualContents.every(text => !text.includes('DSLM') && !text.includes('invoke') && !text.includes('parameter')), JSON.stringify(textualContents))
  check('end=false 后继续下一轮、end=true 结束', textualContents.filter(text => text === '文本工具协议第一句').length === 1 && textualContents.filter(text => text === '第二句也发完了').length === 1)

  console.log('\n⑩b 无法解析的工具标记必须被拦截')
  await waitFor(() => registry.list().some(item => item.key === 'broken/broken-chat'), { timeout: 4000 })
  check('坏标记模型已同步到前端注册表', registry.list().some(item => item.key === 'broken/broken-chat'))
  registry.select('broken/broken-chat')
  const conv5 = sessions.create({ name: '坏标记拦截测试', meta: { roleId: 'role-broken' } })
  sessions.activate(conv5.id)
  messages.requestSend(conv5.id, '你好')
  const interceptNotice = await waitFor(
    () => sessions.messages(conv5.id).find(message => message.role === 'assistant' && message.content.includes('无法解析的工具调用格式')) || null,
    { timeout: 6000 },
  )
  const brokenContents = sessions.messages(conv5.id).map(message => String(message.content || ''))
  check('无法解析的工具标记被替换为明确提示', !!interceptNotice, JSON.stringify(brokenContents))
  check('原始工具标记没有进入聊天气泡', brokenContents.every(text => !text.includes('<tool_call>') && !text.includes('这不是 JSON')), JSON.stringify(brokenContents))

  console.log('\n⑩c DeepSeek 原生工具调用 + reasoning_content 回传')
  await waitFor(() => registry.list().some(item => item.key === 'deepseek/deepseek-v4-flash'), { timeout: 4000 })
  check('DeepSeek 模型已同步到前端注册表', registry.list().some(item => item.key === 'deepseek/deepseek-v4-flash'))
  registry.select('deepseek/deepseek-v4-flash')
  config.set('chat.reasoningEffort', 'high')
  const beforeDeepseekRequests = mock.requests.length
  const conv6 = sessions.create({ name: 'DeepSeek 推理测试', meta: { roleId: 'role-deepseek', persona: '你是 DeepSeek 测试角色。' } })
  sessions.activate(conv6.id)
  messages.requestSend(conv6.id, '你好')
  const deepseekReply = await waitFor(
    () => sessions.messages(conv6.id).find(message => message.role === 'assistant' && String(message.content || '').includes('本地 OpenAI 兼容 Mock 服务')) || null,
    { timeout: 6000 },
  )
  check('DeepSeek 原生工具调用消息已发送', !!deepseekReply, JSON.stringify(sessions.messages(conv6.id).slice(-2)))
  await waitFor(() => mock.requests.filter(body => body.model === 'deepseek-v4-flash').length >= 2, { timeout: 4000 })
  const deepseekRequests = mock.requests.slice(beforeDeepseekRequests).filter(body => body.model === 'deepseek-v4-flash')
  check(
    'DeepSeek 请求不发送 tool_choice，但带 tools',
    deepseekRequests[0]?.tool_choice === undefined && Array.isArray(deepseekRequests[0]?.tools) && deepseekRequests[0].tools.length > 0,
    JSON.stringify(deepseekRequests[0] && { tool_choice: deepseekRequests[0].tool_choice, tools: deepseekRequests[0].tools?.length }),
  )
  check(
    'DeepSeek thinking + reasoning_effort 透传',
    deepseekRequests[0]?.thinking?.type === 'enabled' && deepseekRequests[0]?.reasoning_effort === 'high',
    JSON.stringify(deepseekRequests[0] && { thinking: deepseekRequests[0].thinking, reasoning_effort: deepseekRequests[0].reasoning_effort }),
  )
  const replayAssistant = deepseekRequests[1]?.messages?.find(message => message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length)
  check(
    '第二轮请求把 reasoning_content 原样回传',
    replayAssistant?.reasoning_content === '这是 DeepSeek 风格的推理内容。',
    JSON.stringify(deepseekRequests[1]?.messages?.slice(-4) || []),
  )
  config.set('chat.reasoningEffort', 'off')

  console.log('\n⑩d 严格工具模式：直出正文被丢弃并纠错')
  await waitFor(() => registry.list().some(item => item.key === 'chatty/chatty-1'), { timeout: 4000 })
  check('直出正文模型已同步到前端注册表', registry.list().some(item => item.key === 'chatty/chatty-1'))
  registry.select('chatty/chatty-1')
  config.set('chat.requireToolCall', true)
  config.set('chat.toolRetryLimit', 2)
  const beforeChatty = chattyRequests.length
  const conv7 = sessions.create({ name: '严格工具模式测试', meta: { roleId: 'role-chatty' } })
  sessions.activate(conv7.id)
  messages.requestSend(conv7.id, '你好')
  const strictNotice = await waitFor(
    () => sessions.messages(conv7.id).find(message => message.role === 'assistant' && message.content.includes('模型没有按要求调用工具')) || null,
    { timeout: 6000 },
  )
  check('多次未调用工具后终止并给出明确提示', !!strictNotice, JSON.stringify(sessions.messages(conv7.id).slice(-2)))
  check('模型直出的正文没有进入聊天气泡', !sessions.messages(conv7.id).some(message => String(message.content || '').includes('我是直接输出的正文')))
  const strictRounds = chattyRequests.slice(beforeChatty)
  check('严格模式触发了纠正重试', strictRounds.length >= 3, `模型调用 ${strictRounds.length} 次`)
  check(
    '纠正消息以 user 消息回传给模型',
    strictRounds.slice(1).some(messages => messages.some(message => message.role === 'user' && String(message.content || '').includes('[系统纠正'))),
    JSON.stringify(strictRounds[1]?.slice(-2) || []),
  )
  config.set('chat.requireToolCall', false)

  console.log('\n⑩e 聊天记录 JSON 编辑器数据层：replaceMessages')
  const conv8 = sessions.create({ name: 'JSON 编辑测试', meta: { roleId: 'role-json' } })
  const channel8 = store.channelForConversation(conv8.id).channelId
  store.append(conv8.id, { role: 'user', content: '原始消息' })
  const replaced = store.replaceMessages(channel8, [
    { role: 'assistant', content: '手工编辑的消息', seq: 5, timestamp: new Date().toISOString() },
  ])
  const edited = store.messagesOf(channel8)
  check('replaceMessages 写入成功', replaced.ok === true && replaced.count === 1, JSON.stringify(replaced))
  check(
    '编辑后的消息补齐渠道与结构字段',
    edited[0]?.content === '手工编辑的消息' && edited[0].channel_id === channel8 && edited[0].seq === 5 && !!edited[0].message_id,
    JSON.stringify(edited[0]),
  )
  check('聊天记录 JSON 里不会出现 tool 协议消息', edited.every(message => message.role === 'user' || message.role === 'assistant'))
  let invalidRejected = false
  try {
    store.replaceMessages(channel8, { not: 'array' })
  } catch (_) {
    invalidRejected = true
  }
  check('非数组 JSON 会被拒绝', invalidRejected)

  console.log('\n⑩f 图形化聊天记录编辑器：草稿 / 取消 / 保存 / 校验')
  ctx.inject('settings-container').open('chat-records')
  await sleep(80)
  check('图形编辑器已渲染', !!document.querySelector('[data-record-cards]') && !!document.querySelector('[data-record-source]'))
  const firstChannelButton = document.querySelector('[data-channel]')
  check('编辑器左侧列出渠道', !!firstChannelButton, document.querySelectorAll('[data-channel]').length + ' 个')
  if (firstChannelButton) {
    firstChannelButton.click()
    await sleep(30)
    const channelId = firstChannelButton.dataset.channel
    const otherRecord = store.listChannels().find(record => record.channelId !== channelId)
    if (otherRecord) {
      ctx.emit('chat-records:select', { channelId: otherRecord.channelId })
      await sleep(30)
      check(
        '打开聊天记录事件能定位到指定渠道',
        String(document.querySelector('[data-record-path]')?.textContent || '').includes(otherRecord.channelId),
        String(document.querySelector('[data-record-path]')?.textContent || ''),
      )
      ctx.emit('chat-records:select', { channelId })
      await sleep(30)
    }
    const firstCard = document.querySelector('[data-record-card]')
    check('图形视图显示消息卡片', !!firstCard)
    if (firstCard) {
      firstCard.click()
      await sleep(10)
      const contentField = document.querySelector('[data-editor-field="content"]')
      check('点击消息打开编辑表单', !!contentField && document.querySelector('[data-record-editor-mask]')?.classList.contains('show'))
      if (contentField) {
        contentField.value = '草稿修改内容'
        document.querySelector('[data-editor-confirm]').click()
        await sleep(20)
        check('确认修改只进入草稿，不写回 chat-store', store.messagesOf(channelId).every(message => message.content !== '草稿修改内容'))
        check(
          '草稿修改立即显示在图形视图',
          String(document.querySelector('[data-record-card] .record-card-content')?.textContent || '').includes('草稿修改内容'),
        )
        document.querySelector('[data-record-reload]').click()
        await sleep(20)
        check(
          '整体取消还原回修改前',
          !store.messagesOf(channelId).some(message => message.content === '草稿修改内容') &&
            !String(document.querySelector('[data-record-card] .record-card-content')?.textContent || '').includes('草稿修改内容'),
        )
        const cardsBeforeDelete = document.querySelectorAll('[data-record-card]').length
        const storeBeforeDelete = store.messagesOf(channelId).length
        document.querySelector('[data-record-delete]').click()
        await sleep(20)
        check('删除按钮只删除草稿中的消息', document.querySelectorAll('[data-record-card]').length === cardsBeforeDelete - 1)
        check('删除草稿不会立即写回 chat-store', store.messagesOf(channelId).length === storeBeforeDelete)
        document.querySelector('[data-record-reload]').click()
        await sleep(20)
        check('取消修改后可以恢复被删掉的消息', document.querySelectorAll('[data-record-card]').length === cardsBeforeDelete)
        document.querySelector('[data-record-card]').click()
        await sleep(10)
        document.querySelector('[data-editor-field="content"]').value = '整体保存后的内容'
        document.querySelector('[data-editor-confirm]').click()
        await sleep(10)
        document.querySelector('[data-record-save]').click()
        await sleep(40)
        check('点整体保存后才写回 chat-store', store.messagesOf(channelId).some(message => message.content === '整体保存后的内容'))
      }
      const cardAfterSave = document.querySelector('[data-record-card]')
      if (cardAfterSave) {
        cardAfterSave.click()
        await sleep(10)
        document.querySelector('[data-editor-field="content"]').value = '不应保存的内容'
        document.querySelector('[data-editor-cancel]').click()
        await sleep(10)
        check('单条取消不修改草稿', store.messagesOf(channelId).every(message => message.content !== '不应保存的内容'))
      }
    }
    document.querySelector('[data-record-mode="json"]').click()
    await sleep(10)
    // 高风险模式会有二次确认弹窗：先确认进入。
    document.querySelector('#modalOk')?.click()
    await sleep(20)
    const sourceEl = document.querySelector('[data-record-source]')
    sourceEl.value = '[{"role":"user","content":123}]'
    sourceEl.dispatchEvent({ type: 'input', target: sourceEl })
    await sleep(10)
    check('JSON 非法字段会显示错误', document.querySelector('[data-record-error]')?.classList.contains('show'))
    const countBeforeInvalidSave = store.messagesOf(channelId).length
    document.querySelector('[data-record-save]').click()
    await sleep(20)
    check('格式校验失败时不会写入', store.messagesOf(channelId).length === countBeforeInvalidSave)
  }

  console.log('\n⑩g 多条消息动态延迟（首条不延迟）')
  const delayConv = sessions.create({ name: '动态延迟测试', meta: { roleId: 'role-delay' } })
  const delayChannel = store.channelForConversation(delayConv.id).channelId
  const marks = []
  const offAdded = ctx.on('message:added', ({ conversationId, message } = {}) => {
    if (conversationId === delayConv.id && message?.role === 'assistant') marks.push({ at: Date.now(), content: message.content })
  })
  config.set('chat.simulateTyping', true)
  config.set('chat.typingMinMs', 500)
  config.set('chat.typingMaxMs', 2000)
  config.set('chat.typingPerCharMs', 0)
  const delayStarted = Date.now()
  await tools.execute(
    'chat_send',
    { messages: ['第一条消息', '第二条消息'], end: true },
    {
      conversationId: delayConv.id,
      channelId: delayChannel,
      roleId: 'role-delay',
      userId: 'web-user',
      sentContents: new Map(),
      delivery: { count: 0 },
      entry: { cancelled: false },
    },
  )
  const firstGap = marks[0] ? marks[0].at - delayStarted : null
  const secondGap = marks[1] ? marks[1].at - marks[0].at : null
  offAdded()
  check('首条工具消息不延迟', firstGap !== null && firstGap < 300, `${firstGap}ms`)
  check('第二条工具消息按 0.5s~2s 动态延迟', secondGap !== null && secondGap >= 450 && secondGap <= 2500, `${secondGap}ms`)
  check('两条消息按顺序写入', marks[0]?.content === '第一条消息' && marks[1]?.content === '第二条消息', JSON.stringify(marks))

  // 跨渠道发送同样保留逐条延迟（此前只在当前渠道生效，导致 QQ 等渠道一次性连发多条）
  sessions.update(conv1.id, { meta: { ...sessions.get(conv1.id).meta, crossSendable: true, sensitiveConfirm: false } })
  store.channelForConversation(conv1.id)
  const crossMarks = []
  const offCrossAdded = ctx.on('message:added', ({ conversationId, message } = {}) => {
    if (conversationId === conv2.id && message?.role === 'assistant') crossMarks.push({ at: Date.now(), content: message.content })
  })
  const crossStarted = Date.now()
  await tools.execute(
    'chat_send',
    { channel: channel2.channelId, messages: ['跨渠道第一条', '跨渠道第二条'], end: true },
    {
      conversationId: conv1.id,
      channelId: channel1.channelId,
      roleId: 'role-test',
      userId: 'web-user',
      sentContents: new Map(),
      delivery: { count: 0 },
      entry: { cancelled: false },
    },
  )
  const crossFirstGap = crossMarks[0] ? crossMarks[0].at - crossStarted : null
  const crossSecondGap = crossMarks[1] ? crossMarks[1].at - crossMarks[0].at : null
  offCrossAdded()
  check('跨渠道首条消息不延迟', crossFirstGap !== null && crossFirstGap < 300, `${crossFirstGap}ms`)
  check('跨渠道第二条消息仍按动态延迟', crossSecondGap !== null && crossSecondGap >= 450 && crossSecondGap <= 2500, `${crossSecondGap}ms`)
  sessions.update(conv1.id, { meta: { ...sessions.get(conv1.id).meta, crossSendable: false, sensitiveConfirm: true } })
  store.channelForConversation(conv1.id)
  config.set('chat.simulateTyping', false)

  console.log('\n⑩h 多轮上下文顺序与降级消息元数据')
  registry.select('chatty/chatty-1')
  config.set('chat.requireToolCall', false)
  config.set('chat.simulateTyping', false)
  const originStream = modelService.stream
  let turnMessages = null
  modelService.stream = function (modelMessages, options, callbacks) {
    if (Array.isArray(modelMessages) && modelMessages.some(message => String(message.content || '').includes('第二轮问题'))) {
      turnMessages = JSON.parse(JSON.stringify(modelMessages))
    }
    return originStream.call(this, modelMessages, options, callbacks)
  }
  const conv10 = sessions.create({ name: '多轮上下文测试', meta: { roleId: 'role-context' } })
  sessions.activate(conv10.id)
  check('chat-store.stampMessage 可用', typeof store.stampMessage === 'function')
  messages.requestSend(conv10.id, '第一轮问题')
  await waitFor(() => sessions.messages(conv10.id).filter(message => message.role === 'assistant' && !message.streaming).length >= 1, { timeout: 5000 })
  const firstAssistant = sessions.messages(conv10.id).find(message => message.role === 'assistant' && !message.streaming)
  check(
    '降级回复已带结构化元数据',
    !!firstAssistant?.message_id && !!firstAssistant?.channel_id && Number.isFinite(Number(firstAssistant.seq)) && !!firstAssistant?.timestamp,
    JSON.stringify(firstAssistant),
  )
  messages.requestSend(conv10.id, '第二轮问题')
  await waitFor(() => sessions.messages(conv10.id).filter(message => message.role === 'assistant' && !message.streaming).length >= 2, { timeout: 5000 })
  modelService.stream = originStream

  const contextRoles = (turnMessages || []).map(message => message.role)
  check('多轮上下文按 system → user → assistant → user 排列', contextRoles.join(',') === 'system,user,assistant,user', contextRoles.join(','))
  check(
    '上一轮 assistant 不会被塞进当前 user 字段',
    Array.isArray(turnMessages) &&
      String(turnMessages[1]?.content || '').includes('第一轮问题') &&
      String(turnMessages[3]?.content || '').includes('第二轮问题') &&
      !String(turnMessages[3]?.content || '').includes('第一轮问题'),
    JSON.stringify(turnMessages?.map(message => String(message.content || '').slice(0, 40))),
  )
  const storedMulti = store.messagesOf(store.channelForConversation(conv10.id).channelId)
  const builtContext = builder.build({ conversationId: conv10.id, roleId: 'role-context', persona: '' })
  check(
    '降级回复也带完整渠道元数据',
    storedMulti.length >= 4 && storedMulti.every(message => message.message_id && message.channel_id && message.timestamp && Number.isFinite(Number(message.seq))),
    JSON.stringify(storedMulti.map(message => ({ role: message.role, seq: message.seq, id: message.message_id }))),
  )
  check(
    '消息 seq 单调递增',
    storedMulti.every((message, index) => index === 0 || Number(message.seq) > Number(storedMulti[index - 1].seq)),
    JSON.stringify(storedMulti.map(message => message.seq)),
  )
  const builtRoles = builtContext.messages.map(message => message.role).join(',')
  check('构建上下文顺序与聊天记录一致', builtRoles === 'system,user,assistant,user,assistant' || builtRoles === 'system,user,assistant,user', builtRoles)

  console.log('\n⑩i 工具协议轨迹进入下一轮上下文')
  registry.select('mock/mock-chat')
  config.set('chat.requireToolCall', true)
  config.set('chat.simulateTyping', false)
  const toolOrigin = modelService.stream
  let toolTurnMessages = null
  const conv11 = sessions.create({ name: '工具轨迹测试', meta: { roleId: 'role-tool-transcript' } })
  sessions.activate(conv11.id)
  messages.requestSend(conv11.id, '你好')
  await waitFor(() => sessions.messages(conv11.id).some(message => message.role === 'assistant' && !message.streaming && String(message.content || '').includes('本地 OpenAI 兼容 Mock 服务')), { timeout: 6000 })
  modelService.stream = function (modelMessages, options, callbacks) {
    if (Array.isArray(modelMessages) && modelMessages.some(message => String(message.content || '').includes('再问一句'))) {
      toolTurnMessages = JSON.parse(JSON.stringify(modelMessages))
    }
    return toolOrigin.call(this, modelMessages, options, callbacks)
  }
  messages.requestSend(conv11.id, '再问一句')
  await waitFor(() => sessions.messages(conv11.id).filter(message => message.role === 'assistant' && !message.streaming).length >= 2, { timeout: 6000 })
  modelService.stream = toolOrigin
  const toolRoles = (toolTurnMessages || []).map(message => message.role).join(',')
  const hasToolCallHistory = Array.isArray(toolTurnMessages) && toolTurnMessages.some(message => message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length)
  check(
    '下一轮上下文包含 assistant.tool_calls + role=tool',
    hasToolCallHistory && toolTurnMessages.some(message => message.role === 'tool' && message.tool_call_id),
    toolRoles,
  )
  check('下一轮上下文以 system,user,assistant,tool,user 结尾', toolRoles.endsWith('system,user,assistant,tool,user'), toolRoles)

  console.log('\n⑩j 工具协议异常序列修复')
  const convOrphan = sessions.create({ name: '工具协议修复测试', meta: { roleId: 'role-orphan' } })
  const channelOrphan = store.channelForConversation(convOrphan.id)
  store.appendTranscript(channelOrphan.channelId, [
    { role: 'assistant', content: null, tool_calls: [{ id: 'call-bad', type: 'function', function: { name: 'read_messages', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call-other', name: 'read_messages', content: '{"ok":true}' },
  ])
  store.appendTranscript(channelOrphan.channelId, [{ role: 'user', content: '保留这条用户消息' }])
  const builtOrphan = builder.build({ conversationId: convOrphan.id, roleId: 'role-orphan' })
  check(
    '孤立 tool / 不完整工具轮次不会发给模型',
    !builtOrphan.messages.some(message => message.role === 'tool') &&
      builtOrphan.messages.some(message => String(message.content || '').includes('保留这条用户消息')),
    JSON.stringify(builtOrphan.messages.map(message => ({ role: message.role, tool_call_id: message.tool_call_id }))),
  )
  store.clearTranscript(channelOrphan.channelId)
  store.appendTranscript(channelOrphan.channelId, [
    { role: 'assistant', content: null, tool_calls: [{ id: 'call-good', type: 'function', function: { name: 'read_messages', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call-good', name: 'read_messages', content: '{"ok":true}' },
  ])
  const builtGood = builder.build({ conversationId: convOrphan.id, roleId: 'role-orphan' })
  check(
    '合法工具序列保留',
    builtGood.messages.some(message => message.role === 'assistant' && message.tool_calls?.length) &&
      builtGood.messages.some(message => message.role === 'tool' && message.tool_call_id === 'call-good'),
    JSON.stringify(builtGood.messages.map(message => message.role)),
  )

  console.log('\n⑩k 模型空回复：纠正重试后明确提示，不静默等待')
  {
    const originalStream = modelService.stream
    let emptyCalls = 0
    config.set('chat.simulateTyping', false)
    config.set('chat.emptyRetryLimit', 2)
    modelService.stream = function () {
      emptyCalls += 1
      const callbacks = arguments[2] || {}
      callbacks.onDone?.({})
      return { abort() {} }
    }
    try {
      const emptyConv = sessions.create({ name: '空回复测试', meta: { roleId: 'role-empty' } })
      sessions.activate(emptyConv.id)
      messages.requestSend(emptyConv.id, '测试模型空回复')
      const notice = await waitFor(
        () => sessions.messages(emptyConv.id).find(message => message.role === 'assistant' && String(message.content || '').includes('连续返回空回复')),
        { timeout: 6000 },
      )
      check('空回复自动纠正并重试', emptyCalls === 3, `模型调用 ${emptyCalls} 次`)
      check('重试仍为空后写入明确提示', !!notice, JSON.stringify(sessions.messages(emptyConv.id).map(message => message.content).slice(-3)))
    } finally {
      modelService.stream = originalStream
    }
  }

  console.log('\n⑪ 渠道数据跨 web/exe 共享持久化')
  const group = channelRegistry.groups('private')[0]
  const sharedChannel = channelRegistry.addChannel('private', group.id, {
    type: 'custom',
    name: '共享渠道测试',
    color: '#123456',
    status: 'offline',
    meta: { note: 'shared' },
  })
  const channelPushed = await waitFor(
    () =>
      backend.ctx.settings
        .get()
        .preferences?.app?.channels?.groups?.private?.flatMap?.(item => item.channels || [])
        .some(channel => channel.id === sharedChannel.id),
    { timeout: 5000 },
  )
  check('渠道变更写入后端共享 config.json', channelPushed === true, JSON.stringify(backend.ctx.settings.get().preferences?.app?.channels || null).slice(0, 160))
  const remoteChannels = {
    groups: {
      private: [
        {
          id: 'g-remote-private',
          name: '远端分组',
          expanded: true,
          channels: [{ id: 'ch-remote-shared', type: 'custom', name: '远端共享渠道', color: '#654321', status: 'offline', meta: {} }],
        },
      ],
      group: [{ id: 'g-remote-group', name: '我的渠道', expanded: true, channels: [] }],
      privacy: [{ id: 'g-remote-privacy', name: '我的渠道', expanded: true, channels: [] }],
    },
    activeKey: null,
    updatedAt: Date.now() + 10 * 60 * 1000,
  }
  config.set('app.channels', remoteChannels)
  await sleep(50)
  check(
    'config 同步的渠道数据被注册中心采纳',
    channelRegistry.findChannel('private', 'ch-remote-shared')?.name === '远端共享渠道',
    JSON.stringify(channelRegistry.channels('private').map(channel => channel.id)),
  )

  console.log('\n⑫ 收尾')
  await backend.ctx.sessions.flush()
  const rawData = JSON.parse(await readFile(join(dataDir, 'sessions.json'), 'utf8'))
  const rawConv = rawData.conversations.find(conversation => conversation.id === conv1.id)
  check(
    'sessions.json 只保留会话元数据，不再堆积聊天原文',
    !!rawConv && (!Array.isArray(rawConv.messages) || rawConv.messages.length === 0) && Number(rawConv.messageCount) > 0,
    JSON.stringify({ messages: rawConv?.messages?.length, messageCount: rawConv?.messageCount }),
  )
  let rawStructured = null
  try {
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(dataDir, 'chat.db'))
    rawStructured = db
      .prepare('SELECT data FROM messages WHERE conversation_id = ? ORDER BY seq ASC')
      .all(conv1.id)
      .map(row => JSON.parse(row.data))
      .find(message => message.message_id && message.channel_id && message.seq)
    db.close()
  } catch (_) {
    /* 旧 Node 回退 JSON 模式时下面仍从 rawConv 里找 */
    rawStructured = rawConv?.messages?.find(message => message.message_id && message.channel_id && message.seq)
  }
  check('结构化消息元数据已写入 chat.db 聊天记录库', !!rawStructured && String(rawStructured.channel_id).startsWith('nova:web:'), JSON.stringify(rawStructured || null).slice(0, 160))
  await backend.close()
  await mock.close()
  await rm(dataDir, { recursive: true, force: true }).catch(() => {})
  console.log(`\n结果：${results.length - failed}/${results.length} 项通过`)
  process.exit(failed ? 1 : 0)
}

main().catch(async err => {
  console.error('\nNova 工具链路测试异常：', err)
  await rm(dataDir, { recursive: true, force: true }).catch(() => {})
  process.exit(1)
})
