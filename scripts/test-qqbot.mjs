/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目：念风 Chat（NianFeng-Chat）
 *
 * QQ 官方机器人后端桥测试：使用本地 mock QQ OpenAPI 验证
 * 手动凭据接入 -> Webhook op=13/op=0 -> 会话绑定/拒绝串线 -> 被动回复 msg_seq 上限 -> 扫码适配器。
 */
import { createServer } from 'node:http'
import { createCipheriv, randomBytes } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const dataDir = join(ROOT, '.tmp', `qqbot-test-${Date.now()}`)
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
  await mkdir(dataDir, { recursive: true })
  // 让桥使用 AES-256-GCM 加密凭据，后面断言密钥不会明文落盘
  await writeFile(join(dataDir, '.secret-key'), Buffer.alloc(32, 7).toString('base64'), 'utf8')

  console.log('\n① mock QQ OpenAPI / 扫码服务')
  const calls = []
  const sentMessages = []
  let lastBindKey = ''
  let gatewayUnauthorized = false
  let formalGatewayWhitelist = false
  let nextQrAppId = 'mock-app-2'
  let nextQrUserOpenid = 'openid-user-qr'
  const encryptSecret = (plain, keyBase64) => {
    const key = Buffer.from(String(keyBase64 || ''), 'base64')
    const nonce = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, nonce)
    const ciphertext = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    return Buffer.concat([nonce, ciphertext, tag]).toString('base64')
  }
  const mock = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const body = req.method === 'POST' ? await readBody(req) : {}
    // 测试里让 sandbox API base 指向 mockBase/sandbox，从而能分别验证正式域名与沙箱域名。
    const sandbox = url.pathname === '/sandbox' || url.pathname.startsWith('/sandbox/')
    const path = sandbox ? url.pathname.slice('/sandbox'.length) || '/' : url.pathname
    calls.push({ method: req.method, path, query: url.search, body, sandbox })
    const send = payload => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(payload))
    }
    if (path === '/app/getAppAccessToken') {
      send({ access_token: `mock-token-${body.appId || 'unknown'}`, expires_in: 7200 })
    } else if (path === '/users/@me') {
      send({ id: 'bot-1', username: 'MockQQBot', avatar: '' })
    } else if (path === '/gateway/bot') {
      if (gatewayUnauthorized || (formalGatewayWhitelist && !sandbox)) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ message: '接口访问源IP不在白名单', code: 11298, err_code: 40023002 }))
      } else {
        send({ url: '', shards: 1, session_start_limit: { max_concurrency: 1, remaining: 1 } })
      }
    } else if (/^\/v2\/users\/[^/]+\/files$/.test(path)) {
      calls.push({ method: 'UPLOAD', path, body })
      send({ file_uuid: 'file-uuid-1', file_info: 'file-info-1', ttl: 0 })
    } else if (/^\/v2\/groups\/[^/]+\/files$/.test(path)) {
      calls.push({ method: 'UPLOAD', path, body })
      send({ file_uuid: 'file-uuid-g1', file_info: 'file-info-g1', ttl: 0 })
    } else if (/^\/v2\/users\/[^/]+\/messages$/.test(path)) {
      sentMessages.push({ target: 'c2c', path, body })
      send({ id: `sent-c2c-${sentMessages.length}`, timestamp: new Date().toISOString() })
    } else if (/^\/v2\/groups\/[^/]+\/messages$/.test(path)) {
      sentMessages.push({ target: 'group', path, body })
      send({ id: `sent-group-${sentMessages.length}`, timestamp: new Date().toISOString() })
    } else if (/^\/v2\/groups\/[^/]+\/members\/[^/]+$/.test(path)) {
      const memberId = decodeURIComponent(String(path).split('/').pop() || '')
      send({ member_openid: memberId, nick: `群昵称-${memberId}` })
    } else if (path === '/qq-image.png') {
      // 模拟 QQ 附件 HTTPS URL：桥会下载并转存到 image-service。
      res.writeHead(200, { 'Content-Type': 'image/png' })
      res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lK3Q6wAAAABJRU5ErkJggg==', 'base64'))
    } else if (path === '/lite/create_bind_task') {
      lastBindKey = String(body.key || '')
      send({ retcode: 0, data: { task_id: 'task-qr-1' } })
    } else if (path === '/lite/poll_bind_result') {
      const appId = nextQrAppId || 'mock-app-2'
      const secret = appId === 'mock-app-2' ? 'mock-secret-2' : `mock-secret-${appId}`
      send({
        retcode: 0,
        data: {
          status: 2,
          bot_appid: appId,
          bot_encrypt_secret: encryptSecret(secret, lastBindKey),
          user_openid: nextQrUserOpenid || undefined,
        },
      })
    } else {
      send({})
    }
  })
  await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve))
  const mockBase = `http://127.0.0.1:${mock.address().port}`
  check('mock 服务已启动', mock.address().port > 0, mockBase)

  process.env.NIANFENG_QQBOT_TOKEN_URL = `${mockBase}/app/getAppAccessToken`
  process.env.NIANFENG_QQBOT_API_BASE = mockBase
  process.env.NIANFENG_QQBOT_SANDBOX_API_BASE = `${mockBase}/sandbox`
  process.env.NIANFENG_QQBOT_BIND_HOST = mockBase

  const { startBackend } = await import('../server/index.mjs')
  console.log('\n② 启动念风后端（自动加载 qqbot bridge）')
  let backend = await startBackend({ port: 0, host: '127.0.0.1', dataDir })
  check('后端已启动', backend.port > 0, backend.url)
  let base = backend.url

  try {
    console.log('\n③ 手动 AppID/AppSecret + Webhook 接入')
    const login = await (await api(base, '/api/qqbot/login/start', {
      method: 'POST',
      body: { mode: 'manual', channelId: 'ch-manual', appId: 'mock-app-1', appSecret: 'mock-secret-1', transport: 'webhook', sessionType: 'c2c', autoBind: true },
    })).json()
    check('手动接入返回 ok', login.ok === true && login.appId === 'mock-app-1', JSON.stringify(login))
    check('Webhook 模式下状态为已接入', login.status === 'online' && login.bot?.username === 'MockQQBot', JSON.stringify(login))
    check('access_token 请求使用 AppID', calls.some(call => call.path === '/app/getAppAccessToken' && call.body.appId === 'mock-app-1'))

    console.log('\n④ 会话绑定与自动绑定防串线')
    const bind = await (await api(base, '/api/qqbot/bind', {
      method: 'POST',
      body: { channelId: 'ch-manual', appId: 'mock-app-1', sessionType: 'c2c', autoBind: true, bindings: [] },
    })).json()
    check('绑定接口返回绑定列表', bind.ok === true && Array.isArray(bind.bindings) && bind.bindings.length === 0, JSON.stringify(bind))

    const c2cEvent = {
      id: 'event-1',
      op: 0,
      s: 1,
      t: 'C2C_MESSAGE_CREATE',
      d: {
        id: 'msg-1',
        content: '你好，QQ机器人',
        timestamp: new Date().toISOString(),
        author: { id: 'openid-user-1', user_openid: 'openid-user-1' },
      },
    }
    const hook1 = await api(base, '/api/qqbot/webhook', {
      method: 'POST',
      headers: { 'X-Bot-Appid': 'mock-app-1' },
      body: c2cEvent,
    })
    const hook1Body = await hook1.json()
    check('Webhook 事件返回 op=12 ACK', hook1Body.op === 12, JSON.stringify(hook1Body))
    await sleep(60)
    const inbox1 = await (await api(base, '/api/qqbot/inbox?channelId=ch-manual')).json()
    check('私聊消息进入渠道队列并自动绑定', inbox1.messages?.length === 1 && inbox1.messages[0].text === '你好，QQ机器人', JSON.stringify(inbox1))
    const statusAfterAutoBind = await (await api(base, '/api/qqbot/status?channelId=ch-manual')).json()
    check(
      '自动绑定记录 openid',
      statusAfterAutoBind.bindings?.length === 1 && statusAfterAutoBind.bindings[0].peerId === 'openid-user-1',
      JSON.stringify(statusAfterAutoBind.bindings),
    )

    const c2cOther = {
      id: 'event-2',
      op: 0,
      s: 2,
      t: 'C2C_MESSAGE_CREATE',
      d: {
        id: 'msg-2',
        content: '另一个人发来的消息',
        timestamp: new Date().toISOString(),
        author: { id: 'openid-user-2', user_openid: 'openid-user-2' },
      },
    }
    await api(base, '/api/qqbot/webhook', { method: 'POST', headers: { 'X-Bot-Appid': 'mock-app-1' }, body: c2cOther })
    await sleep(60)
    const inbox2 = await (await api(base, '/api/qqbot/inbox?channelId=ch-manual')).json()
    check('同一机器人的其它 openid 不会进入本渠道', inbox2.messages?.length === 1, JSON.stringify(inbox2.messages))
    const discover = await (await api(base, '/api/qqbot/discover?channelId=ch-manual')).json()
    check(
      '其它 openid 出现在发现会话列表',
      discover.discovered?.some(item => item.peerId === 'openid-user-2' && !item.channelId),
      JSON.stringify(discover),
    )

    const groupEvent = {
      id: 'event-3',
      op: 0,
      s: 3,
      t: 'GROUP_AT_MESSAGE_CREATE',
      d: {
        id: 'msg-3',
        content: '@MockQQBot 群里说话',
        timestamp: new Date().toISOString(),
        group_openid: 'group-openid-1',
        author: { id: 'member-openid-1', member_openid: 'member-openid-1' },
      },
    }
    await api(base, '/api/qqbot/webhook', { method: 'POST', headers: { 'X-Bot-Appid': 'mock-app-1' }, body: groupEvent })
    await sleep(60)
    const inbox3 = await (await api(base, '/api/qqbot/inbox?channelId=ch-manual')).json()
    check('群聊消息不会被私聊渠道接收（分类隔离）', inbox3.messages?.length === 1, JSON.stringify(inbox3.messages))

    console.log('\n④a QQ 官方图片消息入站')
    const imageEvent = {
      id: 'event-image',
      op: 0,
      s: 4,
      t: 'C2C_MESSAGE_CREATE',
      d: {
        id: 'msg-image-1',
        content: '',
        timestamp: new Date().toISOString(),
        author: { id: 'openid-user-1', user_openid: 'openid-user-1' },
        attachments: [
          {
            content_type: 'image/png',
            filename: 'image.png',
            width: 1,
            height: 1,
            url: `${mockBase}/qq-image.png`,
          },
        ],
      },
    }
    await api(base, '/api/qqbot/webhook', {
      method: 'POST',
      headers: { 'X-Bot-Appid': 'mock-app-1' },
      body: imageEvent,
    })
    await sleep(400)
    const inboxImage = await (await api(base, '/api/qqbot/inbox?channelId=ch-manual')).json()
    const imageMessage = (inboxImage.messages || []).find(item => item.id === 'qq-c2c-openid-user-1-msg-image-1')
    check(
      'QQ 图片消息 content 为空也能进入渠道队列',
      !!imageMessage && imageMessage.text === '[图片]',
      JSON.stringify(inboxImage.messages),
    )
    check(
      'QQ 图片附件会下载并转存为 imageId',
      Array.isArray(imageMessage?.images) && imageMessage.images.length === 1 && !!imageMessage.images[0]?.id,
      JSON.stringify(imageMessage),
    )

    console.log('\n④b 未绑定私聊自动回复绑定提示')
    await api(base, '/api/qqbot/login/start', {
      method: 'POST',
      body: {
        mode: 'manual',
        channelId: 'ch-unbound',
        appId: 'mock-app-unbound',
        appSecret: 'mock-secret-u',
        transport: 'webhook',
        sessionType: 'c2c',
        autoBind: false,
      },
    })
    await api(base, '/api/qqbot/bind', {
      method: 'POST',
      body: { channelId: 'ch-unbound', appId: 'mock-app-unbound', sessionType: 'c2c', autoBind: false, bindings: [] },
    })
    const unboundEvent = {
      id: 'event-unbound',
      op: 0,
      s: 9,
      t: 'C2C_MESSAGE_CREATE',
      d: {
        id: 'msg-unbound-1',
        content: '你好，我还没绑定',
        timestamp: new Date().toISOString(),
        author: { id: 'openid-user-unbound', user_openid: 'openid-user-unbound' },
      },
    }
    await api(base, '/api/qqbot/webhook', {
      method: 'POST',
      headers: { 'X-Bot-Appid': 'mock-app-unbound' },
      body: unboundEvent,
    })
    await sleep(160)
    const unboundPrompt = sentMessages.find(
      item => item.target === 'c2c' && item.path === '/v2/users/openid-user-unbound/messages',
    )
    check(
      '未绑定私聊会自动回复「前往绑定」提示',
      !!unboundPrompt &&
        /绑定/.test(String(unboundPrompt.body?.content || '')) &&
        unboundPrompt.body?.msg_id === 'msg-unbound-1',
      JSON.stringify(unboundPrompt),
    )
    const unboundStatus = await (await api(base, '/api/qqbot/status?channelId=ch-unbound')).json()
    check(
      '未绑定 openid 进入发现会话，等待用户绑定',
      unboundStatus.discovered?.some(item => item.peerId === 'openid-user-unbound'),
      JSON.stringify(unboundStatus.discovered),
    )

    console.log('\n④c QQ 官方群聊适配（group_openid + member_openid + 群昵称）')
    await api(base, '/api/qqbot/login/start', {
      method: 'POST',
      body: {
        mode: 'manual',
        channelId: 'ch-group',
        appId: 'mock-app-1',
        appSecret: 'mock-secret-1',
        transport: 'webhook',
        sessionType: 'group',
        autoBind: true,
      },
    })
    await api(base, '/api/qqbot/bind', {
      method: 'POST',
      body: { channelId: 'ch-group', appId: 'mock-app-1', sessionType: 'group', autoBind: true, bindings: [] },
    })
    const groupEventAdapted = {
      id: 'event-group-adapted',
      op: 0,
      s: 5,
      t: 'GROUP_AT_MESSAGE_CREATE',
      d: {
        id: 'msg-group-adapted',
        content: '@MockQQBot 群里说话',
        timestamp: new Date().toISOString(),
        group_openid: 'group-openid-1',
        author: { id: 'member-openid-1', member_openid: 'member-openid-1' },
      },
    }
    await api(base, '/api/qqbot/webhook', { method: 'POST', headers: { 'X-Bot-Appid': 'mock-app-1' }, body: groupEventAdapted })
    await sleep(260)
    const groupInbox = await (await api(base, '/api/qqbot/inbox?channelId=ch-group')).json()
    const groupMessage = (groupInbox.messages || []).find(item => item.id.includes('msg-group-adapted'))
    check(
      '群消息进入群聊渠道并携带 group_openid',
      !!groupMessage && groupMessage.sessionType === 'group' && groupMessage.peerId === 'group-openid-1' && groupMessage.mentionedSelf === true,
      JSON.stringify(groupInbox),
    )
    check(
      '群成员以 member_openid 作为群内唯一身份',
      groupMessage?.senderId === 'member-openid-1' && groupMessage?.senderOpenid === 'member-openid-1',
      JSON.stringify(groupMessage),
    )
    check(
      '群昵称由群成员信息接口回填',
      groupMessage?.senderName === '群昵称-member-openid-1',
      JSON.stringify(groupMessage),
    )
    check(
      '群成员信息接口按群 / 成员 openid 请求',
      calls.some(call => call.method === 'GET' && call.path === '/v2/groups/group-openid-1/members/member-openid-1'),
      JSON.stringify(calls.filter(call => call.path.includes('/members/'))),
    )
    const groupStatus = await (await api(base, '/api/qqbot/status?channelId=ch-group')).json()
    check(
      '群 openid 自动绑定为本渠道会话',
      groupStatus.bindings?.some(item => item.sessionType === 'group' && item.peerId === 'group-openid-1'),
      JSON.stringify(groupStatus.bindings),
    )
    const groupReply = await (await api(base, '/api/qqbot/send', {
      method: 'POST',
      body: { channelId: 'ch-group', text: '群聊回复', sessionType: 'group', peerId: 'group-openid-1', msgId: 'msg-group-adapted' },
    })).json()
    const groupSendCall = sentMessages.find(item => item.target === 'group' && item.path === '/v2/groups/group-openid-1/messages')
    check(
      '群聊回复走 /v2/groups/{group_openid}/messages 且携带 msg_id',
      groupReply.ok === true && groupSendCall?.body?.msg_id === 'msg-group-adapted' && groupSendCall?.body?.content === '群聊回复',
      JSON.stringify({ groupReply, groupSendCall }),
    )

    console.log('\n④d QQ 群全量消息（群开启「机器人可获取群内全部消息」后的未 @ 消息）')
    await api(base, '/api/qqbot/login/start', {
      method: 'POST',
      body: {
        mode: 'manual',
        channelId: 'ch-group-full',
        appId: 'mock-app-1',
        appSecret: 'mock-secret-1',
        transport: 'webhook',
        sessionType: 'group',
        autoBind: true,
      },
    })
    await api(base, '/api/qqbot/bind', {
      method: 'POST',
      body: { channelId: 'ch-group-full', appId: 'mock-app-1', sessionType: 'group', autoBind: true, bindings: [] },
    })
    const groupFullEvent = {
      id: 'event-group-full-1',
      op: 0,
      s: 6,
      t: 'GROUP_MESSAGE_CREATE',
      d: {
        id: 'msg-group-full-1',
        content: '普通群聊消息，没有艾特机器人',
        timestamp: new Date().toISOString(),
        group_openid: 'group-openid-full',
        author: { id: 'member-openid-full-1', member_openid: 'member-openid-full-1' },
        mentions: [],
      },
    }
    await api(base, '/api/qqbot/webhook', { method: 'POST', headers: { 'X-Bot-Appid': 'mock-app-1' }, body: groupFullEvent })
    await sleep(260)
    const fullInbox = await (await api(base, '/api/qqbot/inbox?channelId=ch-group-full')).json()
    const fullMessage = (fullInbox.messages || []).find(item => item.id.includes('msg-group-full-1'))
    check(
      'GROUP_MESSAGE_CREATE 未 @ 消息进入群聊渠道并记录为全量消息',
      !!fullMessage &&
        fullMessage.sessionType === 'group' &&
        fullMessage.peerId === 'group-openid-full' &&
        fullMessage.mentionedSelf === false &&
        fullMessage.fullGroupMessage === true,
      JSON.stringify(fullInbox),
    )
    const fullStatus = await (await api(base, '/api/qqbot/status?channelId=ch-group-full')).json()
    check(
      '未 @ 的全量群消息也能触发自动绑定',
      fullStatus.bindings?.some(item => item.sessionType === 'group' && item.peerId === 'group-openid-full'),
      JSON.stringify(fullStatus.bindings),
    )
    const mentionedFullEvent = {
      id: 'event-group-full-2',
      op: 0,
      s: 7,
      t: 'GROUP_MESSAGE_CREATE',
      d: {
        id: 'msg-group-full-2',
        content: '@MockQQBot 这条是全量事件里 @ 我的',
        timestamp: new Date().toISOString(),
        group_openid: 'group-openid-full',
        author: { id: 'member-openid-full-1', member_openid: 'member-openid-full-1' },
      },
    }
    await api(base, '/api/qqbot/webhook', { method: 'POST', headers: { 'X-Bot-Appid': 'mock-app-1' }, body: mentionedFullEvent })
    await sleep(260)
    const mentionedInbox = await (await api(base, '/api/qqbot/inbox?channelId=ch-group-full')).json()
    const mentionedMessage = (mentionedInbox.messages || []).find(item => item.id.includes('msg-group-full-2'))
    check(
      '全量事件里带 @ 的消息仍会标记 mentionedSelf=true',
      mentionedMessage?.mentionedSelf === true && mentionedMessage?.fullGroupMessage === true,
      JSON.stringify(mentionedMessage),
    )

    // AstrBot / qq-botpy 全量群消息用 mentions[].is_you 标记“是不是 @ 的机器人”。
    const mentionsFlagEvent = {
      id: 'event-group-full-3',
      op: 0,
      s: 9,
      t: 'GROUP_MESSAGE_CREATE',
      d: {
        id: 'msg-group-full-3',
        content: '这条正文没有 @ 字符',
        timestamp: new Date().toISOString(),
        group_openid: 'group-openid-full',
        author: { id: 'member-openid-full-1', member_openid: 'member-openid-full-1' },
        mentions: [{ id: 'bot-openid-1', is_you: true, username: 'MockQQBot' }],
      },
    }
    await api(base, '/api/qqbot/webhook', { method: 'POST', headers: { 'X-Bot-Appid': 'mock-app-1' }, body: mentionsFlagEvent })
    await sleep(260)
    const mentionsFlagInbox = await (await api(base, '/api/qqbot/inbox?channelId=ch-group-full')).json()
    const mentionsFlagMessage = (mentionsFlagInbox.messages || []).find(item => item.id.includes('msg-group-full-3'))
    check(
      '全量事件里 mentions[].is_you 能识别 @',
      mentionsFlagMessage?.mentionedSelf === true,
      JSON.stringify(mentionsFlagMessage),
    )


    // QQ 如果未来改事件名，payload 结构兜底仍要能识别群消息，避免整类消息被丢弃。
    const structuralGroupEvent = {
      id: 'event-group-structural-1',
      op: 0,
      s: 8,
      t: 'GROUP_CHAT_MESSAGE_PUSH',
      d: {
        id: 'msg-group-structural-1',
        content: '未知事件名但结构是群消息',
        timestamp: new Date().toISOString(),
        group_openid: 'group-openid-full',
        author: { id: 'member-openid-full-1', member_openid: 'member-openid-full-1' },
      },
    }
    await api(base, '/api/qqbot/webhook', { method: 'POST', headers: { 'X-Bot-Appid': 'mock-app-1' }, body: structuralGroupEvent })
    await sleep(260)
    const structuralInbox = await (await api(base, '/api/qqbot/inbox?channelId=ch-group-full')).json()
    const structuralMessage = (structuralInbox.messages || []).find(item => item.id.includes('msg-group-structural-1'))
    check(
      '未知群消息事件名按 payload 结构兜底识别',
      !!structuralMessage && structuralMessage.sessionType === 'group' && structuralMessage.peerId === 'group-openid-full',
      JSON.stringify(structuralInbox),
    )

    const quotedSend = await (await api(base, '/api/qqbot/send', {
      method: 'POST',
      body: {
        channelId: 'ch-group-full',
        sessionType: 'group',
        peerId: 'group-openid-full',
        text: '开启引用时发送 message_reference',
        msgId: 'msg-group-full-2',
        quote: true,
      },
    })).json()
    const quotedCall = sentMessages.find(item => item.target === 'group' && item.body?.content === '开启引用时发送 message_reference')
    check(
      '回复引用开关开启时走被动回复（带 msg_id）',
      quotedSend.ok === true && quotedCall?.body?.msg_id === 'msg-group-full-2' && quotedCall?.body?.message_reference === undefined,
      JSON.stringify({ quotedSend, quotedCall }),
    )

    const unquotedSend = await (await api(base, '/api/qqbot/send', {
      method: 'POST',
      body: {
        channelId: 'ch-group-full',
        sessionType: 'group',
        peerId: 'group-openid-full',
        text: '关闭引用时不发送 message_reference',
        msgId: 'msg-group-full-2',
        quote: false,
      },
    })).json()
    const unquotedCall = sentMessages.find(item => item.target === 'group' && item.body?.content === '关闭引用时不发送 message_reference')
    check(
      '回复引用开关关闭时走主动消息（不带 msg_id）',
      unquotedSend.ok === true && unquotedCall && unquotedCall.body?.msg_id === undefined && unquotedCall.body?.message_reference === undefined,
      JSON.stringify({ unquotedSend, unquotedCall }),
    )


    const SILK_BASE64 = Buffer.from('\u0002#!SILK_V3test-voice', 'latin1').toString('base64')
    const uploadsBeforeVoice = calls.filter(call => call.method === 'UPLOAD' && call.path === '/v2/groups/group-openid-1/files').length
    const sendsBeforeVoice = sentMessages.filter(item => item.target === 'group').length
    const voiceReply = await (await api(base, '/api/qqbot/send', {
      method: 'POST',
      body: {
        channelId: 'ch-group',
        text: '给你唱一小段。',
        sessionType: 'group',
        peerId: 'group-openid-1',
        msgId: 'msg-group-adapted',
        voice: { dataUrl: `data:audio/silk;base64,${SILK_BASE64}`, mime: 'audio/silk' },
      },
    })).json()
    await sleep(40)
    const voiceUploadCall = calls
      .filter(call => call.method === 'UPLOAD' && call.path === '/v2/groups/group-openid-1/files')
      .slice(uploadsBeforeVoice)
      .find(call => Number(call.body?.file_type) === 3)
    const voiceSentCall = sentMessages
      .filter(item => item.target === 'group')
      .slice(sendsBeforeVoice)
      .find(item => Number(item.body?.msg_type) === 7 && !!item.body?.media?.file_info)
    check(
      'QQ 官方语音先按 file_type=3 上传',
      voiceReply.ok === true && !!voiceUploadCall && !!voiceUploadCall.body?.file_data,
      JSON.stringify({ voiceReply, uploads: calls.filter(call => call.method === 'UPLOAD').slice(-2) }),
    )
    check(
      'QQ 官方语音用 msg_type=7 + media.file_info 发送',
      !!voiceSentCall && voiceSentCall.body?.media?.file_info === 'file-info-g1' && voiceSentCall.body?.msg_id === 'msg-group-adapted',
      JSON.stringify({ voiceReply, voiceSentCall }),
    )
    const badVoice = await (await api(base, '/api/qqbot/send', {
      method: 'POST',
      body: {
        channelId: 'ch-group',
        sessionType: 'group',
        peerId: 'group-openid-1',
        voice: { dataUrl: `data:audio/mpeg;base64,${Buffer.from('not-silk').toString('base64')}` },
      },
    })).json()
    check('非 SILK 语音会被明确拒绝', badVoice.ok === false && badVoice.code === 'VOICE_FORMAT_INVALID', JSON.stringify(badVoice))

    console.log('\n④d 同群多机器人联动镜像（官方 bot 之间本地互见）')
    await api(base, '/api/qqbot/login/start', {
      method: 'POST',
      body: {
        mode: 'manual',
        channelId: 'ch-group-2',
        appId: 'mock-app-link',
        appSecret: 'mock-link-1',
        transport: 'webhook',
        sessionType: 'group',
        autoBind: false,
      },
    })
    await api(base, '/api/qqbot/bind', {
      method: 'POST',
      body: {
        channelId: 'ch-group-2',
        appId: 'mock-app-link',
        sessionType: 'group',
        autoBind: false,
        channelName: '桑多涅',
        linkGroupId: 'fatui-harbingers',
        linkAutoReply: true,
        linkMaxTurns: 1,
        bindings: [{ sessionType: 'group', peerId: 'group-openid-2', alias: '联动测试群', identityMode: 'member' }],
      },
    })
    await api(base, '/api/qqbot/bind', {
      method: 'POST',
      body: {
        channelId: 'ch-group',
        appId: 'mock-app-1',
        sessionType: 'group',
        autoBind: true,
        channelName: '哥伦比娅',
        linkGroupId: 'fatui-harbingers',
        linkAutoReply: true,
        linkMaxTurns: 1,
      },
    })
    const linkedSend = await (await api(base, '/api/qqbot/send', {
      method: 'POST',
      body: { channelId: 'ch-group', text: '月亮升起来了。', sessionType: 'group', peerId: 'group-openid-1' },
    })).json()
    await sleep(40)
    const group2Inbox = await (await api(base, '/api/qqbot/inbox?channelId=ch-group-2')).json()
    const linkedMessage = (group2Inbox.messages || []).find(item => item.text === '月亮升起来了。')
    check(
      'A 机器人群消息会镜像到同联动标识的 B 机器人',
      linkedSend.ok === true &&
        !!linkedMessage &&
        linkedMessage.linkedBot === true &&
        linkedMessage.peerId === 'group-openid-2' &&
        linkedMessage.senderName === '哥伦比娅',
      JSON.stringify({ linkedSend, group2Inbox }),
    )
    const linkedBack = await (await api(base, '/api/qqbot/send', {
      method: 'POST',
      body: { channelId: 'ch-group-2', text: '不过是人造的光。', sessionType: 'group', peerId: 'group-openid-2' },
    })).json()
    await sleep(40)
    const groupInboxBack = await (await api(base, '/api/qqbot/inbox?channelId=ch-group')).json()
    const linkedBackMessage = (groupInboxBack.messages || []).find(item => item.text === '不过是人造的光。')
    check(
      'B 机器人群消息会反向镜像到 A 机器人',
      linkedBack.ok === true &&
        !!linkedBackMessage &&
        linkedBackMessage.linkedBot === true &&
        linkedBackMessage.peerId === 'group-openid-1' &&
        linkedBackMessage.senderName === '桑多涅',
      JSON.stringify({ linkedBack, groupInboxBack }),
    )

    console.log('\n⑤ 被动回复 msg_seq 与主动消息')
    const sendReply = async (text = '回复') =>
      (await api(base, '/api/qqbot/send', {
        method: 'POST',
        body: { channelId: 'ch-manual', text, sessionType: 'c2c', peerId: 'openid-user-1', msgId: 'msg-1' },
      })).json()
    const first = await sendReply('第一条')
    const second = await sendReply('第二条')
    check('被动回复按 msg_seq 递增', first.ok === true && first.msgSeq === 1 && second.ok === true && second.msgSeq === 2, JSON.stringify([first, second]))
    const c2cCalls = sentMessages.filter(item => item.target === 'c2c' && item.path === '/v2/users/openid-user-1/messages')
    check('发送接口路径为 /v2/users/{openid}/messages', c2cCalls[0]?.path === '/v2/users/openid-user-1/messages', JSON.stringify(c2cCalls[0]))
    check('被动回复携带 msg_id', c2cCalls[0]?.body?.msg_id === 'msg-1' && c2cCalls[0]?.body?.content === '第一条', JSON.stringify(c2cCalls[0]?.body))
    for (let i = 0; i < 3; i++) await sendReply(`补充 ${i}`)
    const sixth = await sendReply('第六条')
    check('同一条 QQ 消息超过 5 次被动回复被拒绝', sixth.ok === false && sixth.code === 'PASSIVE_LIMIT', JSON.stringify(sixth))

    const imageSend = await (await api(base, '/api/qqbot/send', {
      method: 'POST',
      body: {
        channelId: 'ch-manual',
        text: '看图',
        images: ['data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lK3Q6wAAAABJRU5ErkJggg=='],
        sessionType: 'c2c',
        peerId: 'openid-user-1',
        msgId: 'msg-img-1',
      },
    })).json()
    const imageMessageCall = sentMessages.find(item => item.target === 'c2c' && item.body?.msg_type === 7)
    const uploadCall = calls.find(item => item.method === 'UPLOAD' && item.path === '/v2/users/openid-user-1/files')
    check('QQ 图片发送先上传 files 接口', !!uploadCall, JSON.stringify(calls.filter(item => item.method === 'UPLOAD')))
    check(
      'QQ 图片消息携带 media.file_info 与 msg_id',
      imageSend.ok === true && !!imageMessageCall && imageMessageCall.body?.media?.file_info === 'file-info-1' && imageMessageCall.body?.msg_id === 'msg-img-1',
      JSON.stringify({ imageSend, imageMessageCall }),
    )

    console.log('\n⑥ Webhook op=13 Ed25519 校验')
    const verify = await (await api(base, '/api/qqbot/webhook', {
      method: 'POST',
      headers: { 'X-Bot-Appid': 'mock-app-1' },
      body: { op: 13, d: { plain_token: 'plain-token-1', event_ts: '1725442341' } },
    })).json()
    const { signWebhook } = await import('../plugins/channels/qqbot/bridge.mjs?test=1')
    check(
      'op=13 返回 AppSecret 派生的 Ed25519 签名',
      verify.plain_token === 'plain-token-1' && verify.signature === signWebhook('mock-secret-1', 'plain-token-1', '1725442341'),
      JSON.stringify(verify),
    )

    console.log('\n⑦ 扫码绑定（q.qq.com /lite 协议）接入第二个机器人')
    const qrStart = await (await api(base, '/api/qqbot/login/start', {
      method: 'POST',
      body: {
        mode: 'qrcode',
        channelId: 'ch-qr',
        sessionType: 'c2c',
        autoBind: true,
        transport: 'webhook',
        bindHost: mockBase,
      },
    })).json()
    const bindCreateCall = calls.find(call => call.path === '/lite/create_bind_task')
    check(
      '扫码模式生成 q.qq.com 授权二维码',
      qrStart.ok === true &&
        String(qrStart.qr?.content || '').includes('/qqbot/openclaw/connect.html?task_id=task-qr-1') &&
        !!bindCreateCall?.body?.key,
      JSON.stringify({ qr: qrStart.qr, bindCreateCall }),
    )
    let qrStatus = null
    for (let i = 0; i < 30; i++) {
      qrStatus = await (await api(base, '/api/qqbot/login/status?channelId=ch-qr')).json()
      if (qrStatus.loggedIn && qrStatus.appId === 'mock-app-2') break
      await sleep(120)
    }
    check('扫码确认后解密 AppSecret 并登录', qrStatus?.loggedIn === true && qrStatus?.appId === 'mock-app-2', JSON.stringify(qrStatus))
    check(
      '扫码返回的 user_openid 自动绑定为渠道默认会话',
      qrStatus?.bindings?.some(item => item.sessionType === 'c2c' && item.peerId === 'openid-user-qr' && item.auto === true),
      JSON.stringify(qrStatus?.bindings),
    )

    await api(base, '/api/qqbot/bind', {
      method: 'POST',
      body: { channelId: 'ch-qr', appId: 'mock-app-2', sessionType: 'c2c', autoBind: true, bindings: [] },
    })
    const c2cEvent2 = {
      id: 'event-4',
      op: 0,
      s: 4,
      t: 'C2C_MESSAGE_CREATE',
      d: {
        id: 'msg-4',
        content: '扫码号发来的私聊',
        timestamp: new Date().toISOString(),
        author: { id: 'openid-user-qr', user_openid: 'openid-user-qr', username: '扫码用户' },
      },
    }
    await api(base, '/api/qqbot/webhook', { method: 'POST', headers: { 'X-Bot-Appid': 'mock-app-2' }, body: c2cEvent2 })
    await sleep(60)
    const qrInbox = await (await api(base, '/api/qqbot/inbox?channelId=ch-qr')).json()
    check(
      '扫码账号的私聊消息进入渠道并带作者昵称',
      qrInbox.messages?.length === 1 && qrInbox.messages[0].peerId === 'openid-user-qr' && qrInbox.messages[0].senderName === '扫码用户',
      JSON.stringify(qrInbox),
    )
    const qrReply = await (await api(base, '/api/qqbot/send', {
      method: 'POST',
      body: { channelId: 'ch-qr', text: '私聊回复', sessionType: 'c2c', peerId: 'openid-user-qr', msgId: 'msg-4' },
    })).json()
    check(
      '扫码账号私聊回复走 /v2/users/{openid}/messages',
      qrReply.ok === true && sentMessages.some(item => item.target === 'c2c' && item.path === '/v2/users/openid-user-qr/messages'),
      JSON.stringify(qrReply),
    )

    console.log('\n⑦b 群聊 / 私聊分类隔离：群消息不会串进私聊渠道')
    const groupEventUnsupported = {
      id: 'event-5',
      op: 0,
      s: 5,
      t: 'GROUP_AT_MESSAGE_CREATE',
      d: {
        id: 'msg-5',
        content: '@MockQQBot 群消息',
        timestamp: new Date().toISOString(),
        group_openid: 'group-openid-unsupported',
        author: { id: 'member-openid-x', member_openid: 'member-openid-x' },
      },
    }
    await api(base, '/api/qqbot/webhook', { method: 'POST', headers: { 'X-Bot-Appid': 'mock-app-2' }, body: groupEventUnsupported })
    await sleep(60)
    const qrInboxAfterGroup = await (await api(base, '/api/qqbot/inbox?channelId=ch-qr')).json()
    const qrDiscover = await (await api(base, '/api/qqbot/discover?channelId=ch-qr')).json()
    check('群聊消息不会进入私聊渠道', qrInboxAfterGroup.messages?.length === 1, JSON.stringify(qrInboxAfterGroup.messages))
    check(
      '群聊消息不会污染私聊渠道的发现列表（需创建群聊渠道后显示）',
      !qrDiscover.discovered?.some(item => item.sessionType === 'group' && item.peerId === 'group-openid-unsupported'),
      JSON.stringify(qrDiscover),
    )

    console.log('\n⑦c 已有凭据复用 / 断开保留 / 移除渠道后复用')
    const bindTaskCountBefore = calls.filter(call => call.path === '/lite/create_bind_task').length
    const reuse = await (await api(base, '/api/qqbot/login/start', {
      method: 'POST',
      body: { mode: 'qrcode', channelId: 'ch-qr' },
    })).json()
    const bindTaskCountAfter = calls.filter(call => call.path === '/lite/create_bind_task').length
    check(
      '已有凭据的渠道再次请求扫码会直接复用重连，不再创建绑定任务',
      reuse.ok === true && reuse.reused === true && bindTaskCountAfter === bindTaskCountBefore,
      JSON.stringify({ reuse, bindTaskCountBefore, bindTaskCountAfter }),
    )

    const accounts = await (await api(base, '/api/qqbot/accounts')).json()
    check(
      '账号列表包含已登录机器人且不泄露密钥',
      accounts.ok === true &&
        accounts.accounts?.some(item => item.appId === 'mock-app-2' && item.bot?.username === 'MockQQBot') &&
        !JSON.stringify(accounts).includes('mock-secret-2'),
      JSON.stringify(accounts),
    )

    const disconnect = await (await api(base, '/api/qqbot/logout', {
      method: 'POST',
      body: { channelId: 'ch-qr', disposeAccount: false },
    })).json()
    check('手动断开只停用渠道，不删除本机凭据', disconnect.ok === true && disconnect.disposed === false, JSON.stringify(disconnect))

    const statusAfterDisconnect = await (await api(base, '/api/qqbot/login/status?channelId=ch-qr')).json()
    check(
      '断开后仍显示已登录、可通过「重新连接」恢复',
      statusAfterDisconnect.loggedIn === true && statusAfterDisconnect.status === 'offline' && statusAfterDisconnect.channelDisabled === true,
      JSON.stringify(statusAfterDisconnect),
    )

    const reconnect = await (await api(base, '/api/qqbot/login/start', {
      method: 'POST',
      body: { mode: 'reconnect', channelId: 'ch-qr' },
    })).json()
    let reconnectStatus = reconnect
    for (let i = 0; i < 20 && reconnectStatus?.status !== 'online'; i++) {
      await sleep(60)
      reconnectStatus = await (await api(base, '/api/qqbot/login/status?channelId=ch-qr')).json()
    }
    check(
      '断开后无需再次扫码即可重连',
      reconnectStatus?.ok !== false && reconnectStatus?.status === 'online' && reconnectStatus?.appId === 'mock-app-2',
      JSON.stringify(reconnectStatus),
    )

    const removed = await (await api(base, '/api/qqbot/logout', {
      method: 'POST',
      body: { channelId: 'ch-qr', disposeAccount: false, removeChannel: true },
    })).json()
    check('删除渠道后保留机器人账号凭据', removed.ok === true && removed.retained === true, JSON.stringify(removed))

    const accountsAfterRemove = await (await api(base, '/api/qqbot/accounts')).json()
    check(
      '机器人账号仍可被其它渠道复用',
      accountsAfterRemove.accounts?.some(item => item.appId === 'mock-app-2' && !item.channels.some(ch => ch.channelId === 'ch-qr')),
      JSON.stringify(accountsAfterRemove),
    )

    const attach = await (await api(base, '/api/qqbot/login/start', {
      method: 'POST',
      body: { mode: 'reconnect', channelId: 'ch-reuse', appId: 'mock-app-2' },
    })).json()
    let attachStatus = attach
    for (let i = 0; i < 20 && attachStatus?.status !== 'online'; i++) {
      await sleep(60)
      attachStatus = await (await api(base, '/api/qqbot/login/status?channelId=ch-reuse')).json()
    }
    check(
      '新渠道可以直接复用已登录机器人',
      attachStatus?.ok !== false && attachStatus?.status === 'online' && attachStatus?.appId === 'mock-app-2',
      JSON.stringify(attachStatus),
    )

    console.log('\n⑦d 扫码账号自动降级沙箱（免 IP 白名单）')
    formalGatewayWhitelist = true
    nextQrAppId = 'mock-app-sandbox'
    nextQrUserOpenid = 'openid-user-sandbox'
    const sandboxStart = await (await api(base, '/api/qqbot/login/start', {
      method: 'POST',
      body: { mode: 'qrcode', channelId: 'ch-sandbox-fallback', sessionType: 'c2c', autoBind: true, transport: 'ws', bindHost: mockBase },
    })).json()
    let sandboxStatus = null
    for (let i = 0; i < 40; i++) {
      sandboxStatus = await (await api(base, '/api/qqbot/status?channelId=ch-sandbox-fallback')).json()
      if (sandboxStatus?.sandboxFallback) break
      await sleep(120)
    }
    check(
      '正式环境要求 IP 白名单时扫码账号自动切换沙箱域名',
      sandboxStart.ok === true &&
        sandboxStatus?.sandbox === true &&
        sandboxStatus?.sandboxFallback === true &&
        calls.some(call => call.sandbox === true && call.path === '/gateway/bot'),
      JSON.stringify({ sandboxStart, sandboxStatus }),
    )
    formalGatewayWhitelist = false
    nextQrAppId = 'mock-app-2'
    nextQrUserOpenid = 'openid-user-qr'

    console.log('\n⑦e IP 白名单错误提示')
    gatewayUnauthorized = true
    await api(base, '/api/qqbot/login/start', {
      method: 'POST',
      body: {
        mode: 'manual',
        channelId: 'ch-whitelist',
        appId: 'mock-app-whitelist',
        appSecret: 'mock-secret-w',
        transport: 'ws',
      },
    })
    await sleep(160)
    const whitelistStatus = await (await api(base, '/api/qqbot/status?channelId=ch-whitelist')).json()
    check(
      'IP 不在白名单时给出可操作的错误指引',
      whitelistStatus.status === 'error' && /白名单/.test(whitelistStatus.error || '') && /IP/.test(whitelistStatus.error || ''),
      JSON.stringify(whitelistStatus),
    )
    gatewayUnauthorized = false

    console.log('\n⑦f 重启后续扫未完成的二维码任务')
    const restartStart = await (await api(base, '/api/qqbot/login/start', {
      method: 'POST',
      body: { mode: 'qrcode', channelId: 'ch-restart' },
    })).json()
    check('重启前已生成待扫码任务', restartStart.ok === true && !!restartStart.qr?.id, JSON.stringify(restartStart))
    const bindCountBeforeRepeat = calls.filter(call => call.path === '/lite/create_bind_task').length
    const pendingReuse = await (await api(base, '/api/qqbot/login/start', {
      method: 'POST',
      body: { mode: 'qrcode', channelId: 'ch-restart' },
    })).json()
    check(
      '未完成的二维码任务会被复用，不会重复创建',
      pendingReuse.ok === true &&
        pendingReuse.reused === true &&
        pendingReuse.qr?.id === restartStart.qr.id &&
        calls.filter(call => call.path === '/lite/create_bind_task').length === bindCountBeforeRepeat,
      JSON.stringify(pendingReuse),
    )
    await backend.close().catch(() => {})
    await sleep(80)
    backend = await startBackend({ port: 0, host: '127.0.0.1', dataDir })
    base = backend.url
    check('后端已重启', backend.port > 0, backend.url)
    let restartStatus = null
    for (let i = 0; i < 40; i++) {
      restartStatus = await (await api(base, '/api/qqbot/status?channelId=ch-restart')).json()
      if (restartStatus.loggedIn && restartStatus.appId === 'mock-app-2') break
      await sleep(120)
    }
    check(
      '重启后继续轮询并完成扫码，无需重新扫码',
      restartStatus?.loggedIn === true && restartStatus?.appId === 'mock-app-2',
      JSON.stringify(restartStatus),
    )

    console.log('\n⑦g 弹窗层级与关闭后取消重扫')
    const { MODAL_CSS } = await import('../plugins/foundation/modal-host/style.mjs')
    const { QQBOT_CSS } = await import('../plugins/channels/qqbot/style.mjs')
    const zIndexOf = (css, selector) => {
      const index = css.indexOf(selector)
      if (index < 0) return 0
      const match = /z-index\s*:\s*(\d+)/.exec(css.slice(index, index + 240))
      return Number(match?.[1] || 0)
    }
    const modalZ = zIndexOf(MODAL_CSS, '.modal-mask')
    const wcZ = zIndexOf(QQBOT_CSS, '.wc-mask')
    check('二次确认弹窗层级高于渠道接入弹窗', modalZ > wcZ, `modal=${modalZ} wc=${wcZ}`)

    const qqbotIndexSource = await readFile(join(ROOT, 'plugins', 'channels', 'qqbot', 'index.mjs'), 'utf8')
    check(
      '关闭接入弹窗会取消待确认的重新扫码，不再继续创建二维码任务',
      /if \(closed \|\| !confirmed\) return/.test(qqbotIndexSource),
      '未找到关闭弹窗后的取消保护',
    )

    console.log('\n⑧ 凭据加密落盘')
    const stateRaw = await readFile(join(dataDir, 'qqbot.json'), 'utf8')
    check('AppSecret 不以明文写入 qqbot.json', !stateRaw.includes('mock-secret-1') && !stateRaw.includes('mock-secret-2'))
    check('access_token 不以明文写入 qqbot.json', !stateRaw.includes('mock-token-mock-app-1') && !stateRaw.includes('mock-token-mock-app-2'))
  } finally {
    await backend.close().catch(() => {})
    await new Promise(resolve => mock.close(resolve))
    await sleep(50)
    await rm(dataDir, { recursive: true, force: true }).catch(() => {})
  }

  console.log(`\n${failed ? `✗ ${failed}/${results.length} 项失败` : `✔ QQ 官方机器人桥测试全部通过（${results.length}/${results.length}）`}`)
  process.exit(failed ? 1 : 0)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
