/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 *
 * NapCat 渠道后端桥端到端测试：
 *   - Reverse WebSocket 握手 / get_login_info / 收消息 / 发消息
 *   - 同一 NapCat 地址 + token 自动复用，不创建重复连接
 *   - 群消息路由（群号 + sender 卡片 / 昵称 / QQ 号）
 *   - 引用回复 + 艾特触发者的 OneBot segment 结构
 *
 * 用法：npm run test:napcat
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startBackend } from '../server/index.mjs'

const results = []
let failed = 0
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function check(name, condition, detail = '') {
  const ok = !!condition
  results.push({ name, ok })
  if (!ok) failed++
  console.log(`${ok ? '  ✔' : '  ✗'} ${name}${detail ? `  ${ok ? '' : '→ ' + detail}` : ''}`)
}

async function waitFor(fn, { timeout = 6000, interval = 40 } = {}) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    const value = await fn()
    if (value) return value
    await sleep(interval)
  }
  return null
}

async function main() {
  const dataDir = await mkdtemp(join(tmpdir(), 'nianfeng-napcat-'))
  const backend = await startBackend({ port: 0, host: '127.0.0.1', dataDir })
  const api = `${backend.url}/api`
  const actions = []
  let ws = null
  let instanceId = ''

  const request = async (path, options = {}) => {
    const response = await fetch(`${api}${path}`, {
      method: options.method || 'GET',
      headers: options.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    })
    const data = await response.json().catch(() => null)
    return { status: response.status, data }
  }

  const respond = payload => {
    const send = value => ws?.send(JSON.stringify(value))
    if (payload.action === 'get_login_info') {
      send({ status: 'ok', retcode: 0, data: { user_id: 10001, nickname: '测试机器人' }, echo: payload.echo })
    } else if (payload.action === 'get_friend_list') {
      send({ status: 'ok', retcode: 0, data: [{ user_id: 10002, nickname: '好友甲' }], echo: payload.echo })
    } else if (payload.action === 'get_group_list') {
      send({ status: 'ok', retcode: 0, data: [{ group_id: 22222, group_name: '测试群' }], echo: payload.echo })
    } else if (payload.action === 'get_version_info') {
      send({ status: 'ok', retcode: 0, data: { app_name: 'NapCat.Test', version: '1.0.0' }, echo: payload.echo })
    } else if (payload.action === 'send_group_msg' || payload.action === 'send_private_msg') {
      send({ status: 'ok', retcode: 0, data: { message_id: 9001 }, echo: payload.echo })
    } else {
      send({ status: 'ok', retcode: 0, data: {}, echo: payload.echo })
    }
  }

  const pushEvent = payload => {
    ws?.send(JSON.stringify(payload))
  }

  try {
    // 1) 创建 reverse 实例并连接
    let created = await request('/napcat/instances', {
      method: 'POST',
      body: {
        mode: 'reverse',
        remark: '测试 NapCat',
        accessToken: 'napcat-token',
        autoConnect: true,
      },
    })
    check('创建 reverse 实例成功', created.data?.ok && created.data?.instance?.id, JSON.stringify(created.data))
    instanceId = created.data?.instance?.id || ''

    const endpoint = await request(`/napcat/instances/${encodeURIComponent(instanceId)}/endpoint`, {
      method: 'POST',
      body: { baseUrl: backend.url },
    })
    check('获取反向连接地址成功', endpoint.data?.simpleUrl?.includes('/ws'), endpoint.data?.simpleUrl || '')
    check(
      '反向连接使用独立监听端口（AstrBot / NapCat 风格 host/port/path）',
      Number(endpoint.data?.port) > 0 &&
        endpoint.data?.simpleUrl?.includes(`:${endpoint.data.port}`) &&
        endpoint.data?.path === '/ws' &&
        endpoint.data?.token === 'napcat-token',
      JSON.stringify({ host: endpoint.data?.host, port: endpoint.data?.port, path: endpoint.data?.path, url: endpoint.data?.url }),
    )
    const wsUrl = endpoint.data?.url || ''

    // Token 可选：留空时地址保持简短，不强制生成。
    const noTokenInstance = await request('/napcat/instances', {
      method: 'POST',
      body: { mode: 'reverse', remark: '无常 Token', accessToken: '', autoConnect: true },
    })
    const noTokenEndpoint = await request(`/napcat/instances/${encodeURIComponent(noTokenInstance.data?.instance?.id || '')}/endpoint`, {
      method: 'POST',
      body: { baseUrl: backend.url },
    })
    check(
      'Reverse Token 可选：留空时不生成 Token，地址为简短 ws://host:port/ws',
      noTokenEndpoint.data?.hasToken === false &&
        !String(noTokenEndpoint.data?.url || '').includes('access_token') &&
        noTokenEndpoint.data?.url === noTokenEndpoint.data?.simpleUrl,
      JSON.stringify({ url: noTokenEndpoint.data?.url, simpleUrl: noTokenEndpoint.data?.simpleUrl, token: noTokenEndpoint.data?.token }),
    )

    ws = new WebSocket(wsUrl)
    const wsOpen = await new Promise(resolve => {
      const timer = setTimeout(() => resolve(false), 4000)
      ws.addEventListener('open', () => {
        clearTimeout(timer)
        resolve(true)
      })
      ws.addEventListener('error', () => {
        clearTimeout(timer)
        resolve(false)
      })
    })
    check('反向 WebSocket 握手成功', wsOpen === true)
    ws.addEventListener('message', event => {
      let payload = null
      try {
        payload = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data))
      } catch (_) {
        return
      }
      if (payload?.action) {
        actions.push(payload)
        respond(payload)
      }
    })
    if (!wsOpen) throw new Error('反向 WebSocket 未连接')

    const online = await waitFor(async () => {
      const list = await request('/napcat/instances')
      const item = (list.data?.instances || []).find(entry => entry.id === instanceId)
      return item?.status === 'online' ? item : null
    })
    check('实例连接后获取到登录 QQ', online?.login?.userId === '10001' && online?.login?.nickname === '测试机器人', JSON.stringify(online?.login || {}))

    // 2) 同步渠道（群聊）
    const channelId = 'napcat-test-group'
    const sync = await request('/napcat/channels/sync', {
      method: 'POST',
      body: {
        channelId,
        channelName: '测试群渠道',
        roleId: 'role-1',
        instanceId,
        category: 'group',
        targetType: 'group',
        targetId: '22222',
        identityMode: 'owner',
        rules: { blacklist: ['19999'], requireAt: true, replyProbability: 50, quote: true, mention: true, silentContext: true },
        permissions: { read: true, reply: true, context: false, crossRead: false, crossSend: false, confirm: true },
      },
    })
    check('渠道路由同步成功', sync.data?.ok === true && sync.data?.channel?.targetId === '22222', JSON.stringify(sync.data))

    // 3) 群消息进入收件箱
    pushEvent({
      post_type: 'message',
      message_type: 'group',
      sub_type: 'normal',
      message_id: 1001,
      group_id: 22222,
      user_id: 10002,
      self_id: 10001,
      time: Math.floor(Date.now() / 1000),
      raw_message: '[CQ:at,qq=10001] 你好',
      message: [
        { type: 'at', data: { qq: '10001' } },
        { type: 'text', data: { text: ' 你好' } },
      ],
      sender: { user_id: 10002, nickname: 'QQ昵称甲', card: '群昵称甲', role: 'member' },
    })
    const inboxMessage = await waitFor(async () => {
      const inbox = await request(`/napcat/inbox?channelId=${encodeURIComponent(channelId)}`)
      return inbox.data?.messages?.[0]?.message || null
    })
    check('群消息被路由到渠道收件箱', !!inboxMessage, JSON.stringify(inboxMessage))
    check(
      '群消息身份包含群号 / 群昵称 / QQ 昵称 / QQ 号',
      inboxMessage?.groupId === '22222' &&
        inboxMessage?.senderCard === '群昵称甲' &&
        inboxMessage?.senderNickname === 'QQ昵称甲' &&
        inboxMessage?.senderId === '10002',
      JSON.stringify({ groupId: inboxMessage?.groupId, card: inboxMessage?.senderCard, nick: inboxMessage?.senderNickname, qq: inboxMessage?.senderId }),
    )
    check('群消息识别出 @ 机器人', inboxMessage?.mentionedSelf === true && inboxMessage?.text?.includes('你好'), `mentionedSelf=${inboxMessage?.mentionedSelf} text=${inboxMessage?.text}`)

    // 3b) 事件不带 self_id 时回退到 get_login_info 的登录账号；
    //     message 数组里没有 at、但 raw_message 的 CQ 码里有时也要能识别 @ 机器人。
    pushEvent({
      post_type: 'message',
      message_type: 'group',
      sub_type: 'normal',
      message_id: 1002,
      group_id: 22222,
      user_id: 10002,
      time: Math.floor(Date.now() / 1000),
      raw_message: '[CQ:at,qq=10001] 回退检测',
      message: [{ type: 'text', data: { text: '回退检测' } }],
      sender: { user_id: 10002, nickname: 'QQ昵称甲', card: '群昵称甲', role: 'member' },
    })
    const fallbackMessage = await waitFor(async () => {
      const inbox = await request(`/napcat/inbox?channelId=${encodeURIComponent(channelId)}`)
      return (inbox.data?.messages || []).find(item => item.message?.messageId === '1002')?.message || null
    })
    check(
      '缺少 self_id 时使用登录账号检测 @ 机器人',
      fallbackMessage?.mentionedSelf === true && fallbackMessage?.selfId === '10001' && fallbackMessage?.atUserIds?.includes('10001'),
      JSON.stringify({ selfId: fallbackMessage?.selfId, mentionedSelf: fallbackMessage?.mentionedSelf, atUserIds: fallbackMessage?.atUserIds }),
    )

    // 4) 发送：引用 + 艾特
    const beforeActions = actions.length
    const send = await request('/napcat/send', {
      method: 'POST',
      body: { channelId, text: '收到，测试回复', quoteMsgId: '1001', mentionUserId: '10002' },
    })
    check('发送接口返回成功', send.data?.ok === true && send.data?.messageId === 9001, JSON.stringify(send.data))
    const sendAction = await waitFor(() => actions.slice(beforeActions).find(item => item.action === 'send_group_msg') || null)
    check('发送动作走 send_group_msg', !!sendAction, JSON.stringify(sendAction))
    const segments = sendAction?.params?.message || []
    check(
      '回复包含引用原消息 segment',
      segments.some(segment => segment.type === 'reply' && String(segment.data?.id) === '1001'),
      JSON.stringify(segments),
    )
    check(
      '回复包含艾特触发者 segment',
      segments.some(segment => segment.type === 'at' && String(segment.data?.qq) === '10002'),
      JSON.stringify(segments),
    )
    check('回复文本正确', segments.some(segment => segment.type === 'text' && segment.data?.text === '收到，测试回复'), JSON.stringify(segments))

    // 4b) 私聊渠道：目标 QQ 路由与私聊发送
    const privateChannelId = 'napcat-test-private'
    const privateSync = await request('/napcat/channels/sync', {
      method: 'POST',
      body: {
        channelId: privateChannelId,
        channelName: '测试私聊渠道',
        roleId: 'role-1',
        instanceId,
        category: 'private',
        targetType: 'private',
        targetId: '10002',
        identityMode: 'owner',
        rules: {},
        permissions: { read: true, reply: true, context: true, crossRead: false, crossSend: false, confirm: true },
      },
    })
    check('私聊渠道路由同步成功', privateSync.data?.ok === true && privateSync.data?.channel?.targetType === 'private', JSON.stringify(privateSync.data))

    pushEvent({
      post_type: 'message',
      message_type: 'private',
      sub_type: 'friend',
      message_id: 2001,
      user_id: 10002,
      self_id: 10001,
      time: Math.floor(Date.now() / 1000),
      raw_message: '晚上好',
      message: [{ type: 'text', data: { text: '晚上好' } }],
      sender: { user_id: 10002, nickname: '好友甲' },
    })
    const privateInbox = await waitFor(async () => {
      const inbox = await request(`/napcat/inbox?channelId=${encodeURIComponent(privateChannelId)}`)
      return inbox.data?.messages?.[0]?.message || null
    })
    check('私聊消息被路由到目标 QQ 渠道', privateInbox?.messageType === 'private' && privateInbox?.peerId === '10002', JSON.stringify(privateInbox))
    check('私聊身份包含 QQ 昵称与 QQ 号', privateInbox?.senderNickname === '好友甲' && privateInbox?.senderId === '10002', JSON.stringify(privateInbox))

    const privateBefore = actions.length
    const privateSend = await request('/napcat/send', {
      method: 'POST',
      body: { channelId: privateChannelId, text: '私聊回复' },
    })
    check('私聊发送接口返回成功', privateSend.data?.ok === true && privateSend.data?.messageId === 9001, JSON.stringify(privateSend.data))
    const privateAction = await waitFor(
      () => actions.slice(privateBefore).find(item => item.action === 'send_private_msg') || null,
    )
    check(
      '私聊发送走 send_private_msg 且不包含引用 / 艾特',
      !!privateAction &&
        (privateAction.params?.message || []).every(segment => segment.type !== 'reply' && segment.type !== 'at') &&
        (privateAction.params?.message || []).some(segment => segment.type === 'text' && segment.data?.text === '私聊回复'),
      JSON.stringify(privateAction?.params || {}),
    )

    // 4c) 助手直接输出 CQ 码 / [at:qq] 简写时转换为真实消息段
    const cqBefore = actions.length
    const cqSend = await request('/napcat/send', {
      method: 'POST',
      body: { channelId, text: '[CQ:at,qq=10002] 你好', quoteMsgId: '1001' },
    })
    check('CQ 码发送接口返回成功', cqSend.data?.ok === true, JSON.stringify(cqSend.data))
    const cqAction = await waitFor(() => actions.slice(cqBefore).find(item => item.action === 'send_group_msg') || null)
    const cqSegments = cqAction?.params?.message || []
    check(
      'CQ 码 [CQ:at] 被解析为 at segment（含引用）',
      cqSegments.some(segment => segment.type === 'reply' && String(segment.data?.id) === '1001') &&
        cqSegments.some(segment => segment.type === 'at' && String(segment.data?.qq) === '10002'),
      JSON.stringify(cqSegments),
    )
    check(
      'CQ 码后的文本保留 @ 后面的空格',
      cqSegments.some(segment => segment.type === 'text' && segment.data?.text === ' 你好'),
      JSON.stringify(cqSegments),
    )

    const shorthandBefore = actions.length
    const shorthandSend = await request('/napcat/send', {
      method: 'POST',
      body: { channelId, text: '[at:10002] 醒醒 [CQ:face,id=14]' },
    })
    check('at 简写发送接口返回成功', shorthandSend.data?.ok === true, JSON.stringify(shorthandSend.data))
    const shorthandAction = await waitFor(() => actions.slice(shorthandBefore).find(item => item.action === 'send_group_msg') || null)
    const shorthandSegments = shorthandAction?.params?.message || []
    check(
      '[at:qq] 简写与 CQ face 被解析',
      shorthandSegments.some(segment => segment.type === 'at' && String(segment.data?.qq) === '10002') &&
        shorthandSegments.some(segment => segment.type === 'face' && String(segment.data?.id) === '14'),
      JSON.stringify(shorthandSegments),
    )

    const imageBefore = actions.length
    const imageSend = await request('/napcat/send', {
      method: 'POST',
      body: { channelId, text: '[CQ:image,file=https://example.com/a.png]' },
    })
    check('CQ image 发送接口返回成功', imageSend.data?.ok === true, JSON.stringify(imageSend.data))
    const imageAction = await waitFor(() => actions.slice(imageBefore).find(item => item.action === 'send_group_msg') || null)
    check(
      'CQ image（http 图片源）透传为 image segment',
      (imageAction?.params?.message || []).some(segment => segment.type === 'image' && segment.data?.file === 'https://example.com/a.png'),
      JSON.stringify(imageAction?.params || {}),
    )

    const privateCqBefore = actions.length
    const privateCqSend = await request('/napcat/send', {
      method: 'POST',
      body: { channelId: privateChannelId, text: '[CQ:at,qq=10002] 在吗' },
    })
    check('私聊 CQ at 发送接口返回成功', privateCqSend.data?.ok === true, JSON.stringify(privateCqSend.data))
    const privateCqAction = await waitFor(() => actions.slice(privateCqBefore).find(item => item.action === 'send_private_msg') || null)
    const privateCqSegments = privateCqAction?.params?.message || []
    check(
      '私聊没有 @ 语义：CQ at 降级为可读文本',
      privateCqSegments.every(segment => segment.type !== 'at') &&
        privateCqSegments.some(segment => segment.type === 'text' && String(segment.data?.text || '').includes('@10002')) &&
        privateCqSegments.some(segment => segment.type === 'text' && String(segment.data?.text || '').includes('在吗')),
      JSON.stringify(privateCqSegments),
    )
    check(
      '私聊 CQ at 文本降级保留原 @ 与正文顺序',
      privateCqSegments.findIndex(segment => segment.type === 'text' && String(segment.data?.text || '').includes('@10002')) <
        privateCqSegments.findIndex(segment => segment.type === 'text' && String(segment.data?.text || '').includes('在吗')),
      JSON.stringify(privateCqSegments),
    )

    const replyBefore = actions.length
    const replySend = await request('/napcat/send', {
      method: 'POST',
      body: { channelId, text: '[CQ:reply,id=2002] 自定义引用', quoteMsgId: '1001' },
    })
    check('CQ reply 发送接口返回成功', replySend.data?.ok === true, JSON.stringify(replySend.data))
    const replyAction = await waitFor(() => actions.slice(replyBefore).find(item => item.action === 'send_group_msg') || null)
    const replySegments = replyAction?.params?.message || []
    check(
      '正文已带 CQ reply 时不再叠加渠道自动引用',
      replySegments.filter(segment => segment.type === 'reply').length === 1 && String(replySegments.find(segment => segment.type === 'reply')?.data?.id) === '2002',
      JSON.stringify(replySegments),
    )

    // 白名单外的 CQ 类型（本地文件）必须被拒绝，不能把本机路径交给 NapCat。
    const dangerBefore = actions.length
    const dangerSend = await request('/napcat/send', {
      method: 'POST',
      body: { channelId, text: '[CQ:file,file=C:\\Windows\\win.ini]' },
    })
    check('白名单外 CQ 类型被拒绝且不发送', dangerSend.data?.ok === false, JSON.stringify(dangerSend.data))
    await sleep(80)
    check(
      '白名单外 CQ 类型没有产生发送动作',
      !actions.slice(dangerBefore).some(item => item.action === 'send_group_msg'),
      JSON.stringify(actions.slice(dangerBefore)),
    )
    check(
      'CQ 白名单外的内容不会作为纯文本原样发出',
      dangerSend.data?.error?.includes('不被允许') || dangerSend.data?.error?.includes('为空'),
      JSON.stringify(dangerSend.data),
    )

    // 5) 重复 forward 实例自动复用
    const firstForward = await request('/napcat/instances', {
      method: 'POST',
      body: { mode: 'forward', url: 'ws://127.0.0.1:9', accessToken: 'same-token', autoConnect: false },
    })
    const secondForward = await request('/napcat/instances', {
      method: 'POST',
      body: { mode: 'forward', url: 'ws://127.0.0.1:9', accessToken: 'same-token', autoConnect: false },
    })
    check(
      '相同地址 + 令牌的 forward 实例被复用',
      firstForward.data?.instance?.id && secondForward.data?.reused === true && secondForward.data.instance.id === firstForward.data.instance.id,
      JSON.stringify({ first: firstForward.data?.instance?.id, second: secondForward.data?.reused, secondId: secondForward.data?.instance?.id }),
    )

    const lifecycle = await request('/napcat/instances', {
      method: 'POST',
      body: { mode: 'forward', url: 'ws://127.0.0.1:9', accessToken: 'lifecycle-token', autoConnect: true },
    })
    const lifecycleId = lifecycle.data?.instance?.id || ''
    const started = await waitFor(async () => {
      const status = await request(`/napcat/instances/${encodeURIComponent(lifecycleId)}/status`)
      return status.data?.status?.status && status.data.status.status !== 'offline' ? status.data.status : null
    })
    check('forward 连接失败后进入异常 / 重连状态', started?.status === 'error' || started?.status === 'connecting', JSON.stringify(started))
    await request(`/napcat/instances/${encodeURIComponent(lifecycleId)}/disconnect`, { method: 'POST', body: {} })
    const disconnected = await request(`/napcat/instances/${encodeURIComponent(lifecycleId)}/status`)
    check('forward 断开后状态变为未连接', disconnected.data?.status?.status === 'offline', JSON.stringify(disconnected.data?.status))
    await request(`/napcat/instances/${encodeURIComponent(lifecycleId)}/connect`, { method: 'POST', body: {} })
    const reconnected = await waitFor(async () => {
      const status = await request(`/napcat/instances/${encodeURIComponent(lifecycleId)}/status`)
      return status.data?.status?.status && status.data.status.status !== 'offline' ? status.data.status : null
    })
    check('forward 断开后仍可重新发起连接', !!reconnected, JSON.stringify(reconnected))

    const discover = await request(`/napcat/discover?instanceId=${encodeURIComponent(instanceId)}`)
    check(
      '发现列表包含群会话与好友列表',
      (discover.data?.peers || []).some(item => item.type === 'group' && String(item.peerId) === '22222') &&
        (discover.data?.peers || []).some(item => item.type === 'private' && String(item.peerId) === '10002'),
      JSON.stringify((discover.data?.peers || []).map(item => `${item.type}:${item.peerId}`)),
    )
  } finally {
    try {
      ws?.close()
    } catch (_) {
      /* ignore */
    }
    await backend.close().catch(() => {})
    await rm(dataDir, { recursive: true, force: true }).catch(() => {})
  }

  console.log(`\n结果\n  ${results.length - failed}/${results.length} 项通过`)
  process.exit(failed ? 1 : 0)
}

main().catch(err => {
  console.error('\nNapCat 后端测试异常：', err)
  process.exit(1)
})
