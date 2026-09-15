/*
 * 念风chat · 扩展插件测试 · group-chat-tools
 *
 * 用法：node extensions/group-chat-tools/test.mjs
 *
 * 思路：
 *   1. 启动真实后端 + 真实前端 cordis 运行时（dom-shim），插件通过 App.loadAll 以
 *      「外部插件入口」的方式加载，和浏览器里加载外部插件的路径一致（只是换成 file URL）；
 *   2. 把 napcat-channel 服务替换成 mock，记录所有 OneBot action 调用；
 *   3. 构造一个假群聊渠道，逐项验证 5 个工具的查询 / 发送 / 管理 / 公告 / 安全约束。
 */
import '../../scripts/dom-shim.mjs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { startBackend } from '../../server/index.mjs'

const results = []
let failed = 0

function check(name, condition, detail = '') {
  const ok = !!condition
  results.push({ name, ok })
  if (!ok) failed++
  console.log(`${ok ? '  ✔' : '  ✗'} ${name}${detail ? `  ${!ok ? '→ ' + detail : ''}` : ''}`)
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function waitFor(fn, { timeout = 8000, interval = 40 } = {}) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    const value = await fn()
    if (value) return value
    await sleep(interval)
  }
  return null
}

async function main() {
  const dataDir = await mkdtemp(join(tmpdir(), 'nianfeng-gm-'))
  const backend = await startBackend({ port: 0, host: '127.0.0.1', dataDir })
  const base = backend.url

  const appRoot = document.createElement('div')
  appRoot.id = 'app'
  document.body.appendChild(appRoot)
  localStorage.setItem('nianfeng:config', JSON.stringify({ data: { backend: { url: `${base}/api` } } }))

  const { app, ctx, loader } = await import('../../src/main.mjs').then(mod => mod.boot())
  await sleep(300)
  await waitFor(() => ctx.inject('tool-registry') && ctx.inject('channel-registry') && ctx.inject('session-service'), { timeout: 8000 })

  /* ---------------- 以外部插件方式加载被测插件 ---------------- */

  const pluginPath = new URL('./index.mjs', import.meta.url).href
  await app.loadAll(
    [{ id: 'group-chat-tools', path: pluginPath, external: true, source: 'external', dir: 'extensions/group-chat-tools' }],
    { disabled: [], removed: [], enabled: [] },
  )
  await waitFor(() => app.list().find(item => item.id === 'group-chat-tools')?.status === 'active', { timeout: 6000 })
  const record = app.list().find(item => item.id === 'group-chat-tools')
  check('扩展插件已激活', record?.status === 'active', record?.reason || '')
  check('插件提供了 group-chat-tools 服务', app.hasService('group-chat-tools'))

  /* ---------------- mock NapCat ---------------- */

  const actions = []
  const members = [
    { user_id: 10001, nickname: '测试机器人', card: '小助手', role: 'admin', level: '6', qq_level: 80, join_time: 1600000000, last_sent_time: 1700000000, title: '' },
    { user_id: 10002, nickname: '小明', card: '明哥', role: 'member', level: '2', qq_level: 30, join_time: 1650000000, last_sent_time: 1700000001, title: '元老' },
    { user_id: 10003, nickname: '晓明', card: '', role: 'member', level: '1', qq_level: 10, join_time: 1660000000, last_sent_time: 1700000002, title: '' },
    { user_id: 10004, nickname: '小刚', card: '钢哥', role: 'admin', level: '5', qq_level: 60, join_time: 1655000000, last_sent_time: 1700000003, title: '' },
    { user_id: 10005, nickname: '群主大人', card: '', role: 'owner', level: '9', qq_level: 99, join_time: 1500000000, last_sent_time: 1700000004, title: '' },
  ]
  const respond = (action, params = {}) => {
    switch (action) {
      case 'get_group_member_list':
        return { ok: true, data: members }
      case 'get_stranger_info':
        return {
          ok: true,
          data: {
            user_id: Number(params.user_id),
            nickname: '小明',
            sex: 'male',
            age: 18,
            qid: 'qid-abc',
            qqLevel: 30,
            long_nick: '大家好，我是小明',
            reg_time: 1600000000,
            is_vip: true,
            is_years_vip: false,
            vip_level: 1,
            remark: '好友备注小明',
            status: 10,
          },
        }
      case 'get_group_member_info':
        return { ok: true, data: members.find(item => String(item.user_id) === String(params.user_id)) || null }
      case 'get_friend_list':
        return { ok: true, data: [{ user_id: 10002, nickname: '小明', remark: '好友备注小明' }] }
      case 'get_profile_like':
        return { ok: true, data: { favoriteInfo: { totalCount: 12, userInfos: [{ uin: 10003, nick: '晓明' }] }, voteInfo: { totalCount: 3 } } }
      case 'nc_get_user_status':
        return { ok: false, code: 1, error: 'packetBackend 不可用（mock）' }
      case 'get_group_honor_info':
        return { ok: true, data: { current_talkative: { user_id: 10002, nickname: '小明', description: '今日发言最多' }, talkative_list: [{ user_id: 10002, nickname: '小明', description: '龙王' }] } }
      case 'get_group_list':
        return { ok: true, data: [{ group_id: 22222, group_name: '测试群' }, { group_id: 33333, group_name: '另一个群' }] }
      case 'get_group_info':
        return { ok: true, data: { group_id: 22222, group_name: '测试群', member_count: members.length, max_member_count: 200, group_all_shut: 0 } }
      case 'get_group_detail_info':
        return { ok: true, data: { groupName: '测试群', memberNum: members.length, maxMemberNum: 200, groupClass: 1, groupGrade: 2, groupCreateTime: 1500000000 } }
      case 'get_group_shut_list':
        return { ok: true, data: [{ user_id: 10003, nickname: '晓明', shut_up_timestamp: Math.floor(Date.now() / 1000) + 600 }] }
      case 'get_group_system_msg':
        return {
          ok: true,
          data: {
            join_requests: [{ request_id: 123, group_id: 22222, group_name: '测试群', requester_uin: 10009, requester_nick: '新人甲', message: '求进群', checked: false }],
            invited_requests: [],
          },
        }
      case 'get_group_at_all_remain':
        return { ok: true, data: { can_at_all: true, remain_at_all_count_for_group: 5, remain_at_all_count_for_uin: 3 } }
      case '_get_group_notice':
        return {
          ok: true,
          data: [
            { notice_id: 'n1', sender_id: 10001, publish_time: 1700000000, message: { text: '第一条公告' }, read_num: 10 },
            { notice_id: 'n2', sender_id: 10001, publish_time: 1700000100, message: { text: '第二条公告' }, read_num: 2 },
          ],
        }
      case 'send_group_msg':
        return { ok: true, data: { message_id: 7001 } }
      default:
        return { ok: true, data: null }
    }
  }

  const napcatService = ctx.inject('napcat-channel')
  napcatService.action = async (instanceId, action, params) => {
    actions.push({ instanceId, action, params })
    if (String(instanceId) !== 'inst-1') return { ok: false, code: 'NO_INSTANCE', error: 'mock 未配置该连接' }
    return respond(action, params)
  }
  napcatService.instance = id => (String(id) === 'inst-1' ? { id: 'inst-1', status: 'online', login: { userId: '10001', nickname: '测试机器人' } } : null)
  napcatService.listInstances = () => [{ id: 'inst-1', status: 'online', login: { userId: '10001', nickname: '测试机器人' } }]

  /* ---------------- 构造假群聊渠道 ---------------- */

  const channels = ctx.inject('channel-registry')
  const sessions = ctx.inject('session-service')
  const groupTab = channels.groups('group')[0] || channels.addGroup('group', '测试分组')
  const conv = sessions.create({
    name: '测试群会话',
    meta: { channelType: 'napcat', channelGroup: 'group', roleId: 'role-1', hiddenFromSessionList: true, channelConversation: true },
  })
  const channel = channels.addChannel('group', groupTab.id, {
    type: 'napcat',
    name: '测试群渠道',
    color: '#0099ff',
    status: 'online',
    meta: {
      conversationId: conv.id,
      instanceId: 'inst-1',
      category: 'group',
      targetType: 'group',
      targetId: '22222',
      targetName: '测试群',
      roleId: 'role-1',
      permissions: { read: true, reply: true, context: false, crossRead: false, crossSend: false, confirm: true },
    },
  })
  const convNow = sessions.get(conv.id)
  sessions.update(conv.id, {
    meta: {
      ...convNow.meta,
      channelId: `napcat:${channel.id}`,
      napcatChannelId: channel.id,
      napcatInstanceId: 'inst-1',
      napcatTargetType: 'group',
      napcatTargetId: '22222',
      napcatTargetName: '测试群',
    },
  })
  const secondGroup = channels.addChannel('group', groupTab.id, {
    type: 'napcat',
    name: '另一个群渠道',
    color: '#0099ff',
    status: 'online',
    meta: {
      instanceId: 'inst-1',
      category: 'group',
      targetType: 'group',
      targetId: '33333',
      targetName: '另一个群',
      roleId: 'role-1',
      permissions: { read: true, reply: true, context: false, crossRead: false, crossSend: false, confirm: true },
    },
  })
  const secondConv = sessions.create({
    name: '另一个群会话',
    meta: { channelType: 'napcat', channelGroup: 'group', roleId: 'role-1', hiddenFromSessionList: true, channelConversation: true, channelId: `napcat:${secondGroup.id}` },
  })
  channels.updateChannel('group', secondGroup.id, { meta: { ...secondGroup.meta, conversationId: secondConv.id } })

  const tools = ctx.inject('tool-registry')
  const context = { conversationId: conv.id, channelId: `napcat:${channel.id}`, roleId: 'role-1', userId: 'web-user', userName: '测试用户' }
  const call = (tool, args) => tools.execute(tool, args, context)
  const lastAction = name => [...actions].reverse().find(item => item.action === name)
  const before = () => actions.length

  console.log('\n① 工具注册与成员查询')
  check('5 个群管工具已注册', ['napcat_group_member', 'napcat_group_send', 'napcat_group_manage', 'napcat_group_notice', 'napcat_group_info'].every(name => tools.has(name)), tools.names().join(','))
  const gmService = ctx.inject('group-chat-tools')
  const numericGroup = await gmService.resolveGroup('22222', context)
  check('服务接口支持按群号解析目标群', numericGroup.ok && numericGroup.target.groupId === '22222', JSON.stringify(numericGroup))
  const namedGroup = await gmService.resolveGroup('测试群', context)
  check('服务接口支持按群名解析目标群', namedGroup.ok && namedGroup.target.groupId === '22222', JSON.stringify(namedGroup))
  const searchFuzzy = await call('napcat_group_member', { keyword: '小明' })
  check('模糊搜索命中 10002', searchFuzzy.ok && searchFuzzy.members?.some(item => item.qq === '10002'), JSON.stringify(searchFuzzy))
  const searchExactCard = await call('napcat_group_member', { keyword: '明哥', match: 'exact' })
  check('群名片精确匹配 10002 且带匹配分', searchExactCard.ok && searchExactCard.members?.[0]?.qq === '10002' && searchExactCard.members[0].match_score >= 90, JSON.stringify(searchExactCard))
  const searchAmbiguous = await call('napcat_group_member', { keyword: '明' })
  check('歧义搜索返回多个候选', searchAmbiguous.ok && searchAmbiguous.total >= 2, JSON.stringify(searchAmbiguous))
  const memberList = await call('napcat_group_member', { keyword: '' })
  check('空关键词返回成员摘要', memberList.ok && memberList.summary?.total === 5 && memberList.summary?.owners === 1, JSON.stringify(memberList.summary))

  console.log('\n② 资料查询 fields/all')
  const infoAll = await call('napcat_group_member', { action: 'info', qq: '10002', fields: 'all' })
  check('info all 拉取基本资料', infoAll.ok && infoAll.user?.nickname === '小明' && infoAll.user?.display === '明哥', JSON.stringify(infoAll.user))
  check('info all 包含签名 / QQ等级 / 群等级 / 头衔', infoAll.user?.signature === '大家好，我是小明' && infoAll.user?.qq_level === 30 && infoAll.user?.group_member?.group_level === 2 && infoAll.user?.group_member?.title === '元老', JSON.stringify(infoAll.user))
  check('info all 包含群荣誉与名片点赞', Array.isArray(infoAll.user?.honor) && infoAll.user.honor.length > 0 && infoAll.user?.likes?.like_count === 12, JSON.stringify({ honor: infoAll.user?.honor, likes: infoAll.user?.likes }))
  check('info all 返回 QQ空间链接与服务端不支持说明', String(infoAll.user?.space?.url || '').includes('user.qzone.qq.com/10002'), JSON.stringify(infoAll.user?.space))
  check('info all 对 packetBackend 不可用的 status 优雅降级', infoAll.user?.status?.supported === false, JSON.stringify(infoAll.user?.status))

  console.log('\n③ 艾特 / 全体 / 音乐卡片')
  const sendBefore = before()
  const atResult = await call('napcat_group_send', { action: 'at', targets: ['明哥'], text: '你好' })
  const atAction = lastAction('send_group_msg')
  check('按名字 @ 成功解析出 QQ 10002', atResult.ok && atResult.mentioned?.[0]?.qq === '10002', JSON.stringify(atResult))
  check('@ 消息 segment 顺序为 at + 文本且带空格', !!atAction && atAction.params.message[0]?.type === 'at' && atAction.params.message[0].data.qq === '10002' && atAction.params.message[1]?.data?.text === ' 你好', JSON.stringify(atAction?.params))
  const records = sessions.messages(conv.id) || []
  const recorded = records[records.length - 1]
  check('工具发出的消息写入聊天记录且标记 outbound', recorded?.meta?.direction === 'outbound' && String(recorded.content).includes('@明哥'), JSON.stringify(recorded?.meta))
  check('发送动作全部经过 mock', actions.length > sendBefore, `actions=${actions.length}`)

  const atAmbiguous = await call('napcat_group_send', { action: 'at', targets: ['明'], text: '哈喽' })
  check('名字歧义时拒绝发送并返回候选', atAmbiguous.ok === false && Array.isArray(atAmbiguous.candidates) && atAmbiguous.candidates.length >= 2, JSON.stringify(atAmbiguous))

  const qqAtBefore = before()
  const qqAt = await call('napcat_group_send', { action: 'at', targets: [10003], text: '直接QQ' })
  check('纯 QQ 号 @ 不依赖成员列表查询', qqAt.ok && qqAt.mentioned?.[0]?.qq === '10003' && !actions.slice(qqAtBefore).some(item => item.action === 'get_group_member_list'), JSON.stringify(qqAt))

  const allResult = await call('napcat_group_send', { action: 'at_all', text: '开会了' })
  check('@全体成员 segment 使用 qq=all 并返回剩余次数', allResult.ok && allResult.remain?.can_at_all === true && (lastAction('send_group_msg')?.params?.message || []).some(segment => segment.type === 'at' && segment.data.qq === 'all'), JSON.stringify(allResult))

  const musicResult = await call('napcat_group_send', { action: 'music', music: { type: 'qq', id: '0039MnYb0qxYhV', title: '测试歌曲' } })
  check('音乐卡片按 music segment 发送', musicResult.ok && lastAction('send_group_msg')?.params?.message?.[0]?.type === 'music' && lastAction('send_group_msg').params.message[0].data.id === '0039MnYb0qxYhV', JSON.stringify(musicResult))

  console.log('\n④ 禁言 / 踢人 / 头衔 / 管理员 / 其他管理')
  const muteResult = await call('napcat_group_manage', { action: 'mute', name: '钢哥', duration: '10分钟' })
  check('禁言 10分钟换算为 600 秒', muteResult.ok && lastAction('set_group_ban')?.params?.duration === 600 && String(lastAction('set_group_ban').params.user_id) === '10004', JSON.stringify(muteResult))
  const unmuteResult = await call('napcat_group_manage', { action: 'unmute', qq: '10004' })
  check('解除禁言 duration=0', unmuteResult.ok && lastAction('set_group_ban')?.params?.duration === 0, JSON.stringify(unmuteResult))
  const customDurations = [['1分钟', 60], ['90秒', 90], ['三分钟', 180], ['1.5小时', 5400], ['1小时30分钟', 5400], ['1m30s', 90], ['半个小时', 1800], ['一个小时', 3600], ['3个小时', 10800], ['一分半', 90], ['2天', 172800], ['永久', 2592000]]
  for (const [label, seconds] of customDurations) {
    const result = await call('napcat_group_manage', { action: 'mute', qq: '10003', duration: label })
    check('自定义禁言时长 ' + label + ' -> ' + seconds + ' 秒', result.ok && lastAction('set_group_ban')?.params?.duration === seconds, JSON.stringify(result))
  }
  const badDuration = await call('napcat_group_manage', { action: 'mute', qq: '10003', duration: '几分钟' })
  check('模糊时长「几分钟」被拒绝', badDuration.ok === false, JSON.stringify(badDuration))
  const readableDuration = await call('napcat_group_manage', { action: 'mute', qq: '10003', duration: '90秒' })
  check('禁言结果带可读时长', readableDuration.ok && readableDuration.duration === 90 && String(readableDuration.duration_text).includes('1 分钟'), JSON.stringify(readableDuration))
  const muteAllResult = await call('napcat_group_manage', { action: 'mute_all', enable: true })
  check('全员禁言开关落到 set_group_whole_ban', muteAllResult.ok && lastAction('set_group_whole_ban')?.params?.enable === true, JSON.stringify(muteAllResult))
  const kickResult = await call('napcat_group_manage', { action: 'kick', qq: '10003', reject_add: true })
  check('踢人 + 拒绝再次加群参数正确', kickResult.ok && lastAction('set_group_kick')?.params?.reject_add_request === true, JSON.stringify(kickResult))
  const recallResult = await call('napcat_group_manage', { action: 'recall', message_id: '54321' })
  check('撤回消息调用 delete_msg', recallResult.ok && String(lastAction('delete_msg')?.params?.message_id) === '54321', JSON.stringify(recallResult))
  const pokeResult = await call('napcat_group_manage', { action: 'poke', qq: '10002' })
  check('戳一戳调用 group_poke', pokeResult.ok && String(lastAction('group_poke')?.params?.target_id) === '10002', JSON.stringify(pokeResult))
  const signResult = await call('napcat_group_manage', { action: 'sign' })
  check('群打卡调用 send_group_sign', signResult.ok && !!lastAction('send_group_sign'), JSON.stringify(signResult))

  console.log('\n⑤ 安全约束')
  const selfMute = await call('napcat_group_manage', { action: 'mute', qq: '10001', duration: 60 })
  check('拒绝对机器人自己禁言', selfMute.ok === false && String(selfMute.code).startsWith('GUARD'), JSON.stringify(selfMute))
  const ownerMute = await call('napcat_group_manage', { action: 'mute', qq: '10005', duration: 60 })
  check('拒绝禁言群主', ownerMute.ok === false && ownerMute.code === 'GUARD_OWNER', JSON.stringify(ownerMute))
  const protectedBoss = await call('napcat_group_manage', { action: 'kick', qq: '10002' })
  check('未配置保护名单时可以踢 10002（仅验证动作可达）', protectedBoss.ok === true, JSON.stringify(protectedBoss))
  ctx.inject('config').set('napcat.groupMaster.protectedUsers', '10002,10003')
  const protectedKick = await call('napcat_group_manage', { action: 'kick', qq: '10002' })
  check('保护名单生效', protectedKick.ok === false && protectedKick.code === 'GUARD_PROTECTED', JSON.stringify(protectedKick))
  ctx.inject('config').set('napcat.groupMaster.protectedUsers', '')

  // 头衔 / 管理员需要群主：先把 mock 里机器人角色改成 owner 并刷新缓存
  const titleFail = await call('napcat_group_manage', { action: 'set_title', qq: '10003', title: '大佬' })
  check('机器人不是群主时拒绝设置头衔', titleFail.ok === false && titleFail.code === 'BOT_NOT_OWNER', JSON.stringify(titleFail))
  members[0].role = 'owner'
  await call('napcat_group_member', { keyword: '', refresh: true })
  const titleOk = await call('napcat_group_manage', { action: 'set_title', qq: '10003', title: '大佬' })
  check('群主机器人可以设置头衔', titleOk.ok === true && lastAction('set_group_special_title')?.params?.special_title === '大佬', JSON.stringify(titleOk))
  const adminOk = await call('napcat_group_manage', { action: 'set_admin', qq: '10002', enable: true })
  check('群主机器人可以设置管理员', adminOk.ok === true && lastAction('set_group_admin')?.params?.enable === true, JSON.stringify(adminOk))
  const rawDenied = await call('napcat_group_manage', { action: 'raw', onebot_action: 'get_group_list' })
  check('raw 默认关闭', rawDenied.ok === false && String(rawDenied.error).includes('raw'), JSON.stringify(rawDenied))
  ctx.inject('config').set('napcat.groupMaster.allowRawAction', true)
  const rawOk = await call('napcat_group_manage', { action: 'raw', onebot_action: 'get_group_list', raw_params: {} })
  check('开启后 raw 透传可用', rawOk.ok === true && Array.isArray(rawOk.data), JSON.stringify(rawOk))
  ctx.inject('config').set('napcat.groupMaster.allowRawAction', false)

  console.log('\n⑥ 群公告')
  const noticeSend = await call('napcat_group_notice', { action: 'send', content: '明天放假', params: { pinned: true, popup: true, confirm: false, send_to_new_member: true } })
  const sentNotice = lastAction('_send_group_notice')
  check('公告发送带置顶 / 弹窗 / 免确认参数', noticeSend.ok && sentNotice?.params?.pinned === 1 && sentNotice?.params?.tip_window_type === 1 && sentNotice?.params?.confirm_required === 0, JSON.stringify(sentNotice?.params))
  check('公告未知参数原样透传给 NapCat', sentNotice?.params?.send_to_new_member === 1, JSON.stringify(sentNotice?.params))
  const noticeOverride = await call('napcat_group_notice', { action: 'send', content: '防覆盖', params: { group_id: '99999', content: '恶意覆盖' } })
  check('params 不能覆盖目标群号与公告正文', noticeOverride.ok && String(lastAction('_send_group_notice')?.params?.group_id) === '22222' && lastAction('_send_group_notice')?.params?.content === '防覆盖', JSON.stringify(lastAction('_send_group_notice')?.params))
  const noticeGet = await call('napcat_group_notice', { action: 'get' })
  check('公告列表包含序号与 notice_id', noticeGet.ok && noticeGet.notices?.[0]?.notice_id === 'n1' && noticeGet.notices?.[0]?.index === 1, JSON.stringify(noticeGet))
  const noticeDelete = await call('napcat_group_notice', { action: 'delete', index: 1 })
  check('按序号删除公告', noticeDelete.ok && String(lastAction('_del_group_notice')?.params?.notice_id) === 'n1', JSON.stringify(noticeDelete))
  const noticeEdit = await call('napcat_group_notice', { action: 'edit', keyword: '第二条', content: '第二条公告（改）' })
  check('编辑公告 = 删除旧公告 + 发布新公告', noticeEdit.ok && String(lastAction('_del_group_notice')?.params?.notice_id) === 'n2' && lastAction('_send_group_notice')?.params?.content === '第二条公告（改）', JSON.stringify(noticeEdit))
  const noticeDenied = await call('napcat_group_notice', { action: 'get' })
  check('公告 get 属于只读且不受管理开关影响', noticeDenied.ok === true, JSON.stringify(noticeDenied))

  console.log('\n⑦ 群信息 / 荣誉 / 禁言列表 / 入群申请')
  const groupInfo = await call('napcat_group_info', { action: 'info' })
  check('群资料归一化字段正确', groupInfo.ok && groupInfo.info?.group_name === '测试群' && groupInfo.info?.member_count === 5 && groupInfo.info?.max_member_count === 200, JSON.stringify(groupInfo))
  const honorInfo = await call('napcat_group_info', { action: 'honor' })
  check('群荣誉榜返回龙王等条目', honorInfo.ok && honorInfo.honors?.some(item => item.type === '龙王'), JSON.stringify(honorInfo))
  const mutedInfo = await call('napcat_group_info', { action: 'muted' })
  check('被禁言列表返回剩余时间', mutedInfo.ok && mutedInfo.count === 1 && mutedInfo.muted?.[0]?.muted_until, JSON.stringify(mutedInfo))
  const remainInfo = await call('napcat_group_info', { action: 'at_all_remain' })
  check('@全体剩余次数查询', remainInfo.ok && remainInfo.remain?.remain_at_all_count_for_uin === 3, JSON.stringify(remainInfo))
  const requestsInfo = await call('napcat_group_info', { action: 'requests' })
  check('待处理申请列表', requestsInfo.ok && requestsInfo.requests?.[0]?.request_id === '123' && requestsInfo.requests[0].kind === 'join', JSON.stringify(requestsInfo))
  const approveInfo = await call('napcat_group_info', { action: 'handle_request', request_id: '123', approve: true })
  check('同意入群申请 flag/approve 参数正确', approveInfo.ok && lastAction('set_group_add_request')?.params?.flag === '123' && lastAction('set_group_add_request')?.params?.approve === true, JSON.stringify(approveInfo))

  console.log('\n⑧ 跨群权限与总开关')
  const crossDenied = await call('napcat_group_member', { action: 'search', keyword: '小明', group: '另一个群' })
  check('未开启跨渠道权限时跨群查询被拒绝', crossDenied.ok === false && (crossDenied.code === 'CHANNEL_UNAVAILABLE' || String(crossDenied.error).includes('不可用')), JSON.stringify(crossDenied))
  ctx.inject('config').set('napcat.groupMaster.allowManage', false)
  const manageDenied = await call('napcat_group_manage', { action: 'mute', qq: '10002', duration: 60 })
  check('关闭管理开关后管理动作被拒绝', manageDenied.ok === false, JSON.stringify(manageDenied))
  ctx.inject('config').set('napcat.groupMaster.allowManage', true)
  ctx.inject('config').set('napcat.groupMaster.enabled', false)
  const disabledAll = await call('napcat_group_member', { action: 'search', keyword: '小明' })
  check('总开关关闭后所有工具拒绝执行', disabledAll.ok === false && disabledAll.code === 'GM_DISABLED', JSON.stringify(disabledAll))
  ctx.inject('config').set('napcat.groupMaster.enabled', true)

  console.log('\n⑨ 设置面板')
  const manager = ctx.inject('plugin-manager')
  check('插件设置面板已注册', manager.hasSettings('group-chat-tools'), JSON.stringify(manager.settingsOf('group-chat-tools')))
  manager.openSettings('group-chat-tools')
  await sleep(50)
  const panelText = String(document.body.textContent || '')
  check('设置面板渲染出开关 / 缓存 / 保护名单', panelText.includes('允许管理类操作') && panelText.includes('成员列表缓存') && panelText.includes('保护名单'))
  document.querySelector('.plugin-panel-close')?.click()

  /* ---------------- 收尾 ---------------- */

  await backend.close().catch(() => {})
  await rm(dataDir, { recursive: true, force: true }).catch(() => {})

  console.log(`\n结果\n  ${results.length - failed}/${results.length} 项通过`)
  process.exit(failed ? 1 : 0)
}

main().catch(err => {
  console.error('\n群聊工具测试异常：', err)
  process.exit(1)
})
