/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目：念风 Chat（NianFeng-Chat）
 *
 * 微信 Clawbot 后端桥测试：使用本地 mock iLink 服务验证
 * 登录二维码 → 扫码确认 → getupdates 入站队列 → typing 开始/结束 → sendmessage。
 */
import { createServer } from 'node:http'
import { rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const dataDir = join(ROOT, '.tmp', `clawbot-test-${Date.now()}`)
let failed = 0
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  if (!ok) failed++
  console.log(`${ok ? '  ✔' : '  ✗'} ${name}${ok ? '' : '  → ' + detail}`)
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const api = (base, path, options = {}) =>
  fetch(`${base}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    body: options.body ? JSON.stringify(options.body) : undefined,
  })

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const text = Buffer.concat(chunks).toString('utf8')
  try {
    return text ? JSON.parse(text) : {}
  } catch (_) {
    return { raw: text }
  }
}

async function main() {
  console.log('\n① mock iLink 服务')
  const calls = []
  let updatesServed = 0
  const mock = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const body = req.method === 'POST' ? await readBody(req) : {}
    calls.push({ method: req.method, path: url.pathname, query: url.search, body })
    const send = payload => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(payload))
    }
    if (url.pathname === '/ilink/bot/get_bot_qrcode') {
      send({ ret: 0, qrcode: 'mock-ticket-1', qrcode_img_content: 'https://weixin.qq.com/mock-login?t=1' })
    } else if (url.pathname === '/ilink/bot/get_qrcode_status') {
      send({ ret: 0, status: 'confirmed', bot_token: 'mock-token', ilink_bot_id: 'mock-bot-1', ilink_user_id: 'mock-user-1' })
    } else if (url.pathname === '/ilink/bot/msg/notifystart') {
      send({ ret: 0 })
    } else if (url.pathname === '/ilink/bot/getupdates') {
      await sleep(80)
      updatesServed += 1
      if (updatesServed === 1) {
        send({
          ret: 0,
          get_updates_buf: 'buf-1',
          msgs: [
            {
              message_id: 101,
              from_user_id: 'mock-user-1',
              message_type: 1,
              context_token: 'ctx-1',
              create_time_ms: Date.now(),
              item_list: [{ type: 1, text_item: { text: '你好，Clawbot' } }],
            },
          ],
        })
      } else {
        send({ ret: 0, get_updates_buf: 'buf-1', msgs: [] })
      }
    } else if (url.pathname === '/ilink/bot/getconfig') {
      send({ ret: 0, typing_ticket: 'mock-typing-ticket' })
    } else if (url.pathname === '/ilink/bot/sendtyping') {
      send({ ret: 0 })
    } else if (url.pathname === '/ilink/bot/sendmessage') {
      send({ ret: 0 })
    } else {
      send({ ret: 0 })
    }
  })
  await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve))
  const mockPort = mock.address().port
  const base = `http://127.0.0.1:${mockPort}`
  check('mock 服务已启动', mockPort > 0)

  process.env.NIANFENG_CLAWBOT_BASE_URL = base
  const { startBackend } = await import('../server/index.mjs')
  console.log('\n② 启动念风后端')
  let backend = await startBackend({ port: 0, host: '127.0.0.1', dataDir })
  check('后端已启动', backend.port > 0, backend.url)

  try {
    console.log('\n③ 二维码登录')
    const start = await (await api(backend.url, '/api/clawbot/login/start', { method: 'POST', body: { channelId: 'test-clawbot' } })).json()
    check('返回二维码内容', start.qr?.content === 'https://weixin.qq.com/mock-login?t=1', JSON.stringify(start))
    check('二维码 ticket 已保存', !!start.qr?.status)

    let login = null
    for (let i = 0; i < 30; i++) {
      login = await (await api(backend.url, '/api/clawbot/login/status?channelId=test-clawbot')).json()
      if (login?.loggedIn) break
      await sleep(120)
    }
    check('扫码确认后进入已登录', login?.loggedIn === true && login?.accountId === 'mock-bot-1', JSON.stringify(login))

    console.log('\n④ getupdates 入站消息')
    let inbox = { messages: [] }
    for (let i = 0; i < 20; i++) {
      inbox = await (await api(backend.url, '/api/clawbot/inbox?channelId=test-clawbot')).json()
      if (inbox.messages?.length) break
      await sleep(120)
    }
    check('入站消息进入待处理队列', inbox.messages?.[0]?.text === '你好，Clawbot', JSON.stringify(inbox))
    const msgId = inbox.messages?.[0]?.id
    const ack = await (await api(backend.url, '/api/clawbot/inbox/ack', { method: 'POST', body: { channelId: 'test-clawbot', ids: [msgId] } })).json()
    check('入站消息可确认消费', ack.ok === true && ack.removed === 1, JSON.stringify(ack))

    console.log('\n⑤ typing 与发送')
    const typingStart = await (await api(backend.url, '/api/clawbot/typing/start', { method: 'POST', body: { channelId: 'test-clawbot', toUserId: 'mock-user-1', contextToken: 'ctx-1' } })).json()
    check('typing 开始请求成功', typingStart.ok === true, JSON.stringify(typingStart))
    const typingStop = await (await api(backend.url, '/api/clawbot/typing/stop', { method: 'POST', body: { channelId: 'test-clawbot', toUserId: 'mock-user-1', contextToken: 'ctx-1' } })).json()
    check('typing 结束请求成功', typingStop.ok === true, JSON.stringify(typingStop))
    const send = await (await api(backend.url, '/api/clawbot/send', { method: 'POST', body: { channelId: 'test-clawbot', toUserId: 'mock-user-1', text: '念风回复', contextToken: 'ctx-1' } })).json()
    check('sendmessage 请求成功', send.ok === true, JSON.stringify(send))

    const typingCalls = calls.filter(call => call.path === '/ilink/bot/sendtyping')
    check('typing 状态按 1 → 2 顺序发送', typingCalls.length >= 2 && typingCalls[0].body.status === 1 && typingCalls[1].body.status === 2, JSON.stringify(typingCalls.map(c => c.body.status)))
    const sendCall = calls.find(call => call.path === '/ilink/bot/sendmessage')
    check('sendmessage 携带正确文本与目标', sendCall?.body?.msg?.to_user_id === 'mock-user-1' && sendCall?.body?.msg?.item_list?.[0]?.text_item?.text === '念风回复', JSON.stringify(sendCall?.body))

    console.log('\n⑤b 重启后端：token 持久化与自动重连')
    await backend.close()
    backend = await startBackend({ port: 0, host: '127.0.0.1', dataDir })
    check('重启后后端已启动', backend.port > 0, backend.url)
    let restartedStatus = null
    for (let i = 0; i < 40; i++) {
      restartedStatus = await (await api(backend.url, '/api/clawbot/status?channelId=test-clawbot')).json()
      if (restartedStatus?.loggedIn && restartedStatus?.status === 'online') break
      await sleep(120)
    }
    check('重启后保留 token 并自动登录', restartedStatus?.loggedIn === true, JSON.stringify(restartedStatus))
    check('重启后消息链路恢复在线', restartedStatus?.status === 'online', JSON.stringify(restartedStatus))

    console.log('\n⑥ 凭据落盘与退出')
    const stateFile = join(dataDir, 'clawbot.json')
    let rawState = ''
    for (let i = 0; i < 20; i++) {
      try {
        rawState = await readFile(stateFile, 'utf8')
        break
      } catch (_) {
        await sleep(120)
      }
    }
    check('账号状态已落盘', rawState.includes('mock-bot-1'), rawState.slice(0, 120))
    check('token 不以明文落盘', !!rawState && !rawState.includes('mock-token'))
    const logout = await (await api(backend.url, '/api/clawbot/logout', { method: 'POST', body: { channelId: 'test-clawbot' } })).json()
    const afterLogout = await (await api(backend.url, '/api/clawbot/status?channelId=test-clawbot')).json()
    check('退出后不再登录', logout.ok === true && afterLogout.loggedIn === false, JSON.stringify(afterLogout))
  } finally {
    console.log('\n⑦ 收尾')
    await backend.close().catch(() => {})
    await new Promise(resolve => mock.close(resolve))
    await rm(dataDir, { recursive: true, force: true }).catch(() => {})
  }

  console.log(`\n结果：${results.filter(item => item.ok).length}/${results.length} 项通过`)
  process.exit(failed ? 1 : 0)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})