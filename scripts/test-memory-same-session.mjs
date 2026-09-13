/*
 * 念风chat · 同会话记忆轻量测试
 *
 *   node scripts/test-memory-same-session.mjs
 *
 * 设计：
 *   - 默认复用当前正在运行的风语后端（http://127.0.0.1:5173/api）
 *   - 在风语里创建一个测试角色，导入一组事实和干扰轮次
 *   - 每题开始前清空协议轨迹，只给模型最近 5 轮渠道记忆
 *   - 近期事实应能直接回答；早期事实必须通过 read_messages 检索后回答
 *   - 默认用 DeepSeek（deepseek/deepseek-v4-pro），可通过环境变量覆盖
 *     （deepseek-v4-pro 在工具链路和记忆检索上比 deepseek-flash 更稳）
 *
 * 环境变量：
 *   FENGYU_BACKEND      后端 API 地址，默认 http://127.0.0.1:5173/api
 *   FENGYU_TEST_MODEL   模型 key，默认 deepseek/deepseek-v4-pro
 *   FENGYU_TURN_TIMEOUT 单题超时毫秒，默认 180000
 */
import './dom-shim.mjs'

const BACKEND = String(process.env.FENGYU_BACKEND || 'http://127.0.0.1:5173/api').replace(/\/$/, '')
const MODEL_KEY = String(process.env.FENGYU_TEST_MODEL || 'deepseek/deepseek-v4-pro')
const TURN_TIMEOUT = Math.max(10000, Number(process.env.FENGYU_TURN_TIMEOUT || 180000) || 180000)
const ROLE_ID = 'role-same-session-memory'
const ROLE_NAME = '风语·同会话记忆测试官'
const CONV_ID = 'conv-memory-same-session'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function waitFor(fn, { timeout = 30000, interval = 120, label = 'condition' } = {}) {
  const startedAt = Date.now()
  let lastError = null
  while (Date.now() - startedAt < timeout) {
    try {
      const value = await fn()
      if (value) return value
    } catch (err) {
      lastError = err
    }
    await sleep(interval)
  }
  throw new Error(`等待超时：${label}${lastError ? `（${lastError.message}）` : ''}`)
}

async function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) }
  const res = await fetch(`${BACKEND}${path}`, {
    ...options,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
  const text = await res.text()
  let data = null
  try {
    data = text ? JSON.parse(text) : null
  } catch (_) {
    data = text
  }
  if (!res.ok) {
    const detail = typeof data === 'object' && data ? data.error || data.message || JSON.stringify(data) : data
    const err = new Error(`${options.method || 'GET'} ${path} → HTTP ${res.status}${detail ? `：${detail}` : ''}`)
    err.status = res.status
    throw err
  }
  return data
}

const PERSONA = [
  '你是风语里的同会话记忆测试角色，你的名字是「风语·同会话记忆测试官」。',
  '你必须依据当前会话的历史记录回答问题，不能编造事实。',
  '回答时优先看最近上下文；如果最近上下文没有答案，必须调用 read_messages 检索当前会话。',
  '调用 read_messages 时 query 只传一个明确关键词（例如“咖啡”“上海”“工位”），不要传整句。',
  '检索到结果后用 chat_send 把答案发出来，不要直接输出 assistant 正文。',
].join('')

function buildSeedMessages() {
  const base = Date.now() - 60 * 60 * 1000
  const messages = []
  let index = 0
  const push = (role, content) => {
    index += 1
    const at = new Date(base + index * 1000)
    messages.push({
      id: `mem_seed_${index}`,
      role,
      content,
      sender_name: role === 'user' ? '测试用户' : ROLE_NAME,
      sender_id: role === 'user' ? 'web-user' : `role_${ROLE_ID}`,
      time: `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`,
      status: role === 'user' ? 'read' : 'done',
      kind: 'text',
      meta: {},
      createdAt: at.getTime(),
    })
  }

  // 早期事实：3 条，位于最近 5 轮之外
  push('user', '先记几件关于我的事，等下一会儿问你。')
  push('assistant', '好，这个会话里的内容我会记住。')
  push('user', '我喝咖啡只喝无糖拿铁，从不加糖。')
  push('assistant', '记住了：无糖拿铁，不加糖。')
  push('user', '我下周五要去上海出差，周一才回来。')
  push('assistant', '好的：下周五去上海，周一回来。')
  push('user', '我的工位在 12 楼，靠窗那一排。')
  push('assistant', '记下了：12 楼靠窗。')

  // 干扰轮次：把早期事实顶出最近 5 轮
  const fillers = [
    ['今天下班有点晚。', '辛苦了，早点休息。'],
    ['路上有点堵。', '高峰时段确实容易堵。'],
    ['周末想去看电影。', '可以，挑一部轻松的。'],
    ['我开始学做菜了。', '挺好，先从简单的来。'],
    ['刚跑了五公里。', '不错，记得拉伸。'],
    ['整理书架发现好多旧书。', '旧书翻翻也挺有意思。'],
    ['晚饭吃了面条。', '面食顶饱。'],
    ['最近睡得有点少。', '尽量早点睡。'],
  ]
  for (const [question, answer] of fillers) {
    push('user', question)
    push('assistant', answer)
  }

  // 近期事实：保留在最近 5 轮内
  push('user', '对了，我上周末领养了一只猫，叫团子。')
  push('assistant', '团子，记下了。')
  push('user', '它现在三个月大，特别粘人。')
  push('assistant', '三个月大的猫正是粘人的时候。')

  return messages
}

function formatUsage(usage = {}) {
  return {
    input: Number(usage.inputTokens || 0),
    output: Number(usage.outputTokens || 0),
    cached: Number(usage.cachedTokens || 0),
    total: Number(usage.totalTokens || 0),
  }
}

function sumUsage(target, usage = {}) {
  const one = formatUsage(usage)
  target.input += one.input
  target.output += one.output
  target.cached += one.cached
  target.total += one.total
  return target
}

async function main() {
  console.log(`后端: ${BACKEND}`)
  console.log(`模型: ${MODEL_KEY}`)

  // 1) 清理同名旧测试角色，保证每次运行都是干净会话
  const remoteBefore = await api('/sessions')
  const stale = (remoteBefore.conversations || []).filter(
    conv => conv.id === CONV_ID || conv.meta?.roleId === ROLE_ID || conv.name === ROLE_NAME,
  )
  for (const conv of stale) {
    await api(`/sessions/${encodeURIComponent(conv.id)}`, { method: 'DELETE' })
    console.log(`已删除旧测试角色: ${conv.name || conv.id}`)
  }

  // 2) 在风语数据里创建测试角色 + 种子消息
  const seedMessages = buildSeedMessages()
  const created = await api('/sessions', {
    method: 'POST',
    body: {
      id: CONV_ID,
      name: ROLE_NAME,
      avatar: '记',
      c1: '#7fb2ff',
      c2: '#4a7dff',
      meta: {
        roleId: ROLE_ID,
        channelType: 'nova',
        model: MODEL_KEY,
        persona: PERSONA,
      },
      messages: seedMessages,
    },
  })
  const convId = created.id
  console.log(`已创建测试角色: ${created.name}（${convId}，导入 ${seedMessages.length} 条消息）`)

  // 3) 启动前端插件运行时，连到当前风语后端
  localStorage.clear()
  localStorage.setItem('nianfeng:config', JSON.stringify({ data: { backend: { url: BACKEND } } }))
  const appRoot = document.createElement('div')
  appRoot.id = 'app'
  document.body.appendChild(appRoot)

  const { ctx } = await import('../src/main.mjs').then(mod => mod.boot())
  await waitFor(() => ctx.inject('chat-flow') && ctx.inject('context-builder') && ctx.inject('chat-tools'), {
    timeout: 10000,
    label: '前端聊天插件就绪',
  })
  await waitFor(() => ctx.inject('model-registry')?.list?.().some(item => item.key === MODEL_KEY), {
    timeout: 15000,
    label: `模型 ${MODEL_KEY} 注册`,
  })
  await waitFor(() => ctx.inject('session-service')?.get?.(convId)?.messages?.length >= seedMessages.length, {
    timeout: 15000,
    label: '测试角色从后端同步',
  })

  const sessions = ctx.inject('session-service')
  const messages = ctx.inject('message-service')
  const store = ctx.inject('chat-store')
  const builder = ctx.inject('context-builder')

  sessions.activate(convId)
  const conv = sessions.get(convId)
  const channel = store.channelForConversation(convId)
  if (!channel?.channelId) throw new Error('测试角色没有生成 Nova 渠道')

  const built = builder.build({ conversationId: convId, roleId: conv.meta.roleId, persona: conv.meta.persona })
  console.log(
    `上下文初始状态: transport=${built.stats.transport} totalRounds=${built.stats.totalRounds} selectedRounds=${built.stats.selectedRounds} memoryTokens≈${built.stats.memoryTokens}`,
  )

  const cases = [
    {
      label: '近期记忆：宠物',
      question: '我刚刚领养的猫叫什么名字？它多大了？',
      expected: ['团子', '三个月'],
      requireRead: false,
    },
    {
      label: '早期记忆：咖啡习惯',
      question: '我喝咖啡有什么固定习惯？',
      expected: ['无糖', '拿铁'],
      requireRead: true,
    },
    {
      label: '早期记忆：出差安排',
      question: '我下周五要去哪个城市出差？',
      expected: ['上海'],
      requireRead: true,
    },
    {
      label: '早期记忆：工位位置',
      question: '我的工位在几楼？',
      expected: ['12'],
      requireRead: true,
    },
  ]

  const totals = { input: 0, output: 0, cached: 0, total: 0 }
  let failed = 0

  for (const [index, item] of cases.entries()) {
    // 清空上一轮的协议轨迹，让每题只看到最近 5 轮可见消息 + 当前问题
    store.clearTranscript?.(channel.channelId)

    const beforeCount = sessions.messages(convId).length
    let donePayload = null
    const done = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`第 ${index + 1} 题超时（${TURN_TIMEOUT}ms）`)), TURN_TIMEOUT)
      const off = ctx.on('chat:request-done', payload => {
        if (payload?.conversationId !== convId) return
        clearTimeout(timer)
        off?.()
        donePayload = payload
        resolve(payload)
      })
    })

    const startedAt = Date.now()
    messages.requestSend(convId, item.question)
    await done
    await sleep(350)

    const afterMessages = sessions.messages(convId).slice(beforeCount)
    const answer = afterMessages
      .filter(message => message.role === 'assistant' && !message.streaming && String(message.content || '').trim())
      .map(message => String(message.content))
      .join('\n')
      .trim()

    const lastTurn = store.transcriptTurns?.(channel.channelId, { limitTurns: 1 })?.[0]
    const toolNames = (lastTurn?.messages || []).flatMap(message =>
      (message.tool_calls || []).map(call => String(call?.function?.name || '')),
    )
    const readUsed = toolNames.includes('read_messages')
    const sendUsed = toolNames.includes('chat_send') || toolNames.includes('send_document')
    const keywordOk = item.expected.every(keyword => answer.includes(keyword))
    const readOk = !item.requireRead || readUsed
    const pass = keywordOk && readOk && !!answer
    if (!pass) failed += 1

    sumUsage(totals, donePayload?.usage || {})

    console.log(`\n[${index + 1}/${cases.length}] ${item.label}`)
    console.log(`  Q: ${item.question}`)
    console.log(`  A: ${answer || '（无回答）'}`)
    console.log(
      `  工具: ${toolNames.join(', ') || '无'} | read_messages=${readUsed ? 'yes' : 'no'} | 期望检索=${item.requireRead ? 'yes' : 'optional'}`,
    )
    console.log(`  关键词: ${item.expected.join(' / ')} → ${keywordOk ? 'OK' : 'MISS'} | 结果: ${pass ? 'PASS' : 'FAIL'}`)
    console.log(
      `  usage: input=${formatUsage(donePayload?.usage || {}).input} output=${formatUsage(donePayload?.usage || {}).output} cached=${formatUsage(donePayload?.usage || {}).cached} total=${formatUsage(donePayload?.usage || {}).total}`,
    )

    // 测试角色保留在风语里；只清掉工具协议轨迹，避免后续问题被工具历史干扰
    store.clearTranscript?.(channel.channelId)
  }

  await sleep(1200)
  const remoteAfter = await api('/sessions')
  const persisted = (remoteAfter.conversations || []).find(item => item.id === convId)
  console.log('\n===== 汇总 =====')
  console.log(`用例: ${cases.length - failed}/${cases.length} 通过`)
  console.log(
    `模型 token 合计: input=${totals.input} output=${totals.output} cached=${totals.cached} total=${totals.total}`,
  )
  console.log(
    `测试角色持久化: ${persisted ? `OK（${persisted.name} / ${persisted.messageCount ?? persisted.messages?.length ?? 0} 条消息）` : 'FAIL'}`,
  )
  if (!persisted) failed += 1
  console.log('提示: 测试角色已保留，刷新风语会话列表即可看到。')

  process.exit(failed ? 1 : 0)
}

main().catch(err => {
  console.error('\n测试失败：', err?.stack || err?.message || err)
  process.exit(1)
})
