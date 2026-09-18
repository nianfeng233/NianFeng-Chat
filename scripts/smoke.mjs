/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * 端到端冒烟测试（Node + 极简 DOM 垫片）
 * 用法：npm run test:smoke
 *
 * 覆盖：
 *  1. 全部插件加载 / 激活，无 error
 *  2. 服务注册表内容
 *  3. 事件总线 + 拦截型事件
 *  4. 聊天闭环：message:send → 流式 chunk → message:done
 *  5. 视图切换（chat ↔ channel）
 *  6. 可选中服务：动态启用 bubble-qq 并切换气泡
 *  7. 插件动态启停
 *  8. 主题样式注入、诊断信息
 */
import './dom-shim.mjs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { startBackend } from '../server/index.mjs'
import { mergePreferenceSnapshot } from '../plugins/foundation/config/index.mjs'
import { resolveTemperature } from '../plugins/features/model-adapter-backend/index.mjs'

const results = []
let failed = 0

function check(name, condition, detail = '') {
  const ok = !!condition
  results.push({ name, ok, detail })
  if (!ok) failed++
  console.log(`${ok ? '  ✔' : '  ✗'} ${name}${detail ? `  ${ok ? '' : '→ ' + detail}` : ''}`)
  return ok
}

function section(title) {
  console.log(`\n${title}`)
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const dataDir = join(ROOT, '.tmp', `smoke-${Date.now()}`)

/** 起一个真实后端，并注册一个测试用适配器（真实的 HTTP / SSE 链路，不是打桩前端） */
async function startTestBackend() {
  const backend = await startBackend({ port: 0, host: '127.0.0.1', dataDir })
  backend.ctx.models.registerAdapter('smoke', {
    label: 'Smoke 测试适配器',
    async listModels() {
      return [{ id: 'smoke-1', name: 'Smoke Model' }, { id: 'smoke-2', name: 'Smoke Model 2' }]
    },
    async test() {
      return { detail: '测试通过' }
    },
    async stream({ messages, onChunk, onDone }) {
      const promptText = JSON.stringify(messages || [])
      const text = promptText.includes('LONG_SUMMARY_SMOKE_MARKER')
        ? `${'这是一条用于验证记忆卡片完整展示的长概括。'.repeat(32)}LONG_SUMMARY_SMOKE_TAIL`
        : '这是来自本地后端的真实流式回复，用于端到端验证。'
      for (const char of text) {
        onChunk(char)
        await sleep(1)
      }
      onDone({})
    },
  })
  await backend.ctx.settings.update({
    providers: {
      smoke: {
        type: 'smoke',
        name: 'Smoke Provider',
        baseURL: 'smoke://local',
        enabled: true,
        models: [{ id: 'smoke-1', name: 'Smoke Model' }],
        defaultModel: 'smoke-1',
      },
    },
    defaultProvider: 'smoke',
    defaultModel: 'smoke-1',
  })
  return backend
}

/** 等待条件成立（带超时） */
async function waitFor(fn, { timeout = 5000, interval = 30 } = {}) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const value = await fn()
    if (value) return value
    await sleep(interval)
  }
  return null
}

async function main() {
  // 清掉上一次测试可能留下的持久化配置
  localStorage.clear()

  // 模拟 index.html 的 #app 挂载点与启动屏
  const appRoot = document.createElement('div')
  appRoot.id = 'app'
  document.body.appendChild(appRoot)

  section('① 启动真实后端 + 前端')
  const backend = await startTestBackend()
  localStorage.setItem('nianfeng:config', JSON.stringify({ data: { backend: { url: `${backend.url}/api` } } }))

  const { boot } = await import('../src/main.mjs')
  const { app, ctx, loader } = await boot()
  await sleep(600)
  await waitFor(() => document.getElementById('wind-diag'), { timeout: 3000 })

  // 冒烟用的 smoke 适配器只输出文本，不涉及工具协议；关掉严格工具模式保持旧闭环断言。
  ctx.inject('config').set('chat.requireToolCall', false)
  const list = loader.list()
  const errors = list.filter(r => r.status === 'error')
  const active = list.filter(r => r.status === 'active')
  const disabled = list.filter(r => r.status === 'disabled')
  const inactive = list.filter(r => r.status === 'inactive')

  check('后端健康接口可用', (await backend.ctx.models.list()).length >= 3)
  check('插件总数 ≥ 60', list.length >= 60, `实际 ${list.length}`)
  check('没有 error 插件', errors.length === 0, errors.map(e => `${e.id}: ${e.reason}`).join(' | '))
  check('没有 inactive 插件（依赖齐全）', inactive.length === 0, inactive.map(e => `${e.id}: ${e.reason}`).join(' | '))
  check('active 插件数量正常', active.length >= 55, `active=${active.length} disabled=${disabled.length}`)
  check('没有默认禁用的内置插件（精简后）', disabled.length === 0, disabled.map(d => d.id).join(','))

  section('② DOM 骨架')
  const appEl = document.getElementById('windApp')
  check('#windApp 已挂载', !!appEl)
  check('.titlebar 已渲染', !!document.querySelector('.titlebar'))
  check('.rail 已渲染', !!document.querySelector('.rail'))
  check('.list-pane 已渲染', !!document.querySelector('.list-pane'))
  check('.content 已渲染', !!document.querySelector('.content'))
  check('logo 图片已挂载', !!document.querySelector('.tb-logo'))
  check('会话列表容器已渲染', !!document.getElementById('convList'))
  check('消息滚动区已渲染', !!document.getElementById('msgScroll'))
  check('输入框存在', !!document.getElementById('composerInput'))
  check('“正在输入”提示默认隐藏', document.getElementById('typingHint')?.hasAttribute?.('hidden') === true)
  check('主题变量样式已注入', !!document.querySelector('style[data-plugin="theme-tokens"]'))
  check('绿雾背景 8 个光团', document.querySelectorAll('.bg-aurora .blob').length === 8, `实际 ${document.querySelectorAll('.bg-aurora .blob').length}`)
  check('rail:middle 插槽存在', !!document.querySelector('.rail-middle[data-slot="rail:middle"]'))

  section('③ 服务与插件系统')
  const services = ctx.registry.list().map(s => s.name)
  for (const name of [
    'event-bus', 'storage', 'config', 'logs', 'slots', 'theme', 'bg-provider',
    'session-service', 'message-service', 'model-registry', 'model-service',
    'view-router', 'channel-registry', 'plugin-manager', 'bubble-styles',
    'modal', 'context-menu', 'toast', 'shortcuts', 'notification', 'markdown',
    'api', 'model-adapter', 'export-service', 'search-service',
  ]) {
    check(`服务 ${name} 已注册`, services.includes(name))
  }
  check(
    '聊天记录 JSON 设置页已注册',
    ctx.inject('settings-container').list().some(pageItem => pageItem.id === 'chat-records'),
    ctx.inject('settings-container').list().map(pageItem => pageItem.id).join(','),
  )

  const toolDefs = ctx.registry.get('tool-registry')?.definitions?.() || []
  const chatSendDef = toolDefs.find(item => item?.function?.name === 'chat_send')
  check(
    'chat_send 描述要求多条短消息拆成多个数组项',
    String(chatSendDef?.function?.description || '').includes('独立消息') &&
      String(chatSendDef?.function?.description || '').includes('真人聊天习惯') &&
      String(chatSendDef?.function?.parameters?.properties?.messages?.description || '').includes('独立消息') &&
      String(chatSendDef?.function?.parameters?.properties?.messages?.description || '').includes('句尾句号'),
    JSON.stringify(chatSendDef?.function || null).slice(0, 260),
  )
  const smokeManager = ctx.inject('plugin-manager')
  check(
    '插件设置面板扩展点已注册（微信clawbot 有设置面板）',
    typeof smokeManager.registerSettings === 'function' && typeof smokeManager.openSettings === 'function' && smokeManager.hasSettings('wechat-clawbot'),
    typeof smokeManager.registerSettings,
  )
  check('NapCat 插件设置面板已注册', smokeManager.hasSettings('napcat'), smokeManager.hasSettings('napcat'))
  check('NapCat 输入状态插件设置面板已注册', smokeManager.hasSettings('napcat-input-state'), smokeManager.hasSettings('napcat-input-state'))

  const napcatService = ctx.inject('napcat-channel')
  check('NapCat 扩展服务 napcat-channel 可用', typeof napcatService?.decide === 'function' && typeof napcatService?.listInstances === 'function')
  const napcatRulesBase = { blacklist: [], requireAt: true, replyProbability: 50, quote: true, mention: true, silentContext: true }
  const napcatDecisionChannel = rules => ({ meta: { category: 'group', rules: { ...napcatRulesBase, ...rules } } })
  check(
    'NapCat 群聊规则：黑名单优先忽略',
    napcatService.decide(napcatDecisionChannel({ blacklist: ['42'] }), { senderId: '42', messageType: 'group' }).ignore === true,
  )
  check(
    'NapCat 群聊规则：开启艾特时只有 @ 机器人才触发',
    napcatService.decide(napcatDecisionChannel({ requireAt: true }), { senderId: '42', messageType: 'group', mentionedSelf: false }).trigger === false &&
      napcatService.decide(napcatDecisionChannel({ requireAt: true }), { senderId: '42', messageType: 'group', mentionedSelf: true }).trigger === true,
  )
  check(
    'NapCat 群聊规则：关闭艾特后回复概率生效',
    napcatService.decide(napcatDecisionChannel({ requireAt: false, replyProbability: 100 }), { senderId: '42', messageType: 'group' }).trigger === true &&
      napcatService.decide(napcatDecisionChannel({ requireAt: false, replyProbability: 0 }), { senderId: '42', messageType: 'group' }).trigger === false,
  )
  check(
    'NapCat 群聊规则：黑名单优先于白名单',
    napcatService.decide(napcatDecisionChannel({ blacklist: ['42'], whitelist: ['42'], whitelistForAt: true }), {
      senderId: '42',
      messageType: 'group',
      mentionedSelf: true,
    }).ignore === true,
  )
  check(
    'NapCat 群聊规则：艾特回复可应用白名单',
    napcatService.decide(napcatDecisionChannel({ whitelistForAt: true, whitelist: ['42'] }), { senderId: '42', messageType: 'group', mentionedSelf: true }).trigger === true &&
      napcatService.decide(napcatDecisionChannel({ whitelistForAt: true, whitelist: ['42'] }), { senderId: '99', messageType: 'group', mentionedSelf: true }).trigger === false,
  )
  check(
    'NapCat 群聊规则：概率回复可应用白名单',
    napcatService.decide(napcatDecisionChannel({ requireAt: false, replyProbability: 100, whitelistForProbability: true, whitelist: ['42'] }), {
      senderId: '42',
      messageType: 'group',
    }).trigger === true &&
      napcatService.decide(napcatDecisionChannel({ requireAt: false, replyProbability: 100, whitelistForProbability: true, whitelist: ['42'] }), {
        senderId: '99',
        messageType: 'group',
      }).trigger === false,
  )
  // 用户只勾选“@ 触发也受白名单限制”、没有勾选“仅 @ 时回复”时，
  // @ 机器人也必须稳定回复，不能再被回复概率随机拦下。
  check(
    'NapCat 群聊规则：关闭仅@限制后，@ 机器人仍然直接触发',
    napcatService.decide(napcatDecisionChannel({ requireAt: false, replyProbability: 0 }), {
      senderId: '42',
      messageType: 'group',
      mentionedSelf: true,
    }).trigger === true,
  )
  check(
    'NapCat 群聊规则：关闭仅@限制后，普通消息仍按概率触发',
    napcatService.decide(napcatDecisionChannel({ requireAt: false, replyProbability: 100 }), {
      senderId: '42',
      messageType: 'group',
      mentionedSelf: false,
    }).trigger === true &&
      napcatService.decide(napcatDecisionChannel({ requireAt: false, replyProbability: 0 }), {
        senderId: '42',
        messageType: 'group',
        mentionedSelf: false,
      }).trigger === false,
  )

  const smokeSessions = ctx.inject('session-service')
  const hiddenConversation = smokeSessions.create({ name: '隐藏渠道会话冒烟', meta: { hiddenFromSessionList: true } })
  await sleep(80)
  check(
    '渠道隐藏会话不出现在普通会话列表',
    !document.getElementById('convList')?.textContent?.includes('隐藏渠道会话冒烟'),
  )
  smokeSessions.remove(hiddenConversation.id)
  await sleep(40)

  const diagnostics = document.getElementById('wind-diag')
  check('诊断元素存在', !!diagnostics)
  check('诊断 error 为空', diagnostics?.dataset.errors === '[]', diagnostics?.dataset.errors)
  check('语义冲突检测已运行', typeof loader.warnings.length === 'number')

  section('③a 偏好合并规则（手机 / 电脑同步核心）')
  const newerAt = Date.now()
  const legacyMerge = mergePreferenceSnapshot(
    { chat: { reasoningEffort: 'off', temperature: 1 }, backend: { url: '/api' }, app: { channels: { updatedAt: 1, groups: {} } } },
    {},
    { chat: { reasoningEffort: 'high' }, backend: { url: 'http://other-device/api' } },
    { 'chat.reasoningEffort': { at: newerAt, by: 'desktop' } },
  )
  check('远端新值会覆盖本地默认值（旧版刷新后仍显示“无”的根因）', legacyMerge.data.chat.reasoningEffort === 'high', JSON.stringify(legacyMerge.data.chat))
  check('本机专属偏好不会被远端覆盖', legacyMerge.data.backend.url === '/api')
  check('变化列表可供设置控件 watch 实时更新', legacyMerge.changes.some(change => change.key === 'chat.reasoningEffort'))
  const localNewerMerge = mergePreferenceSnapshot(
    { chat: { reasoningEffort: 'max' } },
    { 'chat.reasoningEffort': { at: newerAt + 1000, by: 'mobile' } },
    { chat: { reasoningEffort: 'high' } },
    { 'chat.reasoningEffort': { at: newerAt, by: 'desktop' } },
    { isLocalOnly: () => false },
  )
  check('本机刚改过的值不会被远端旧值顶掉', localNewerMerge.data.chat.reasoningEffort === 'max' && localNewerMerge.changes.length === 0)
  const noMetaMerge = mergePreferenceSnapshot(
    { chat: { reasoningEffort: 'off' } },
    {},
    { chat: { reasoningEffort: 'high' } },
    {},
    { isLocalOnly: () => false },
  )
  check('旧版本无时间戳数据按远端优先，升级后能纠正历史值', noMetaMerge.data.chat.reasoningEffort === 'high')
  const channelsMerge = mergePreferenceSnapshot(
    { app: { channels: { updatedAt: 10, groups: { old: true } } } },
    {},
    { app: { channels: { updatedAt: 20, groups: { new: true } } } },
    {},
    { isLocalOnly: () => false },
  )
  check('渠道数据仍按 updatedAt 整体取新', channelsMerge.data.app.channels.groups.new === true && channelsMerge.changes.some(change => change.key === 'app.channels'))
  check(
    'chat-flow 下模型级 temperature 优先于全局默认值',
    resolveTemperature({ temperature: 1, preferModelParams: true }, { temperature: 0.3 }) === 0.3,
    String(resolveTemperature({ temperature: 1, preferModelParams: true }, { temperature: 0.3 })),
  )
  check(
    '模型未配置 temperature 时回退全局默认值',
    resolveTemperature({ temperature: 1, preferModelParams: true }, {}) === 1,
    String(resolveTemperature({ temperature: 1, preferModelParams: true }, {})),
  )
  check(
    '非 chat-flow 的显式 temperature 保持优先',
    resolveTemperature({ temperature: 1 }, { temperature: 0.3 }) === 1,
    String(resolveTemperature({ temperature: 1 }, { temperature: 0.3 })),
  )

  section('③b 外部插件目录')
  const externalRoot = join(ROOT, '.tmp', `smoke-plugins-${Date.now()}`)
  await mkdir(join(externalRoot, 'views', 'smoke-external'), { recursive: true })
  await writeFile(
    join(externalRoot, 'views', 'smoke-external', 'index.mjs'),
    [
      "export const name = 'smoke-external'",
      "export const version = '1.0.0'",
      "export const displayName = '冒烟外部插件'",
      "export const description = '验证外部插件目录'",
      'export const core = false',
      'export const inject = []',
      "export function apply(ctx) { ctx.provide('smokeExternalService', { name: 'smoke-external', ready: true }) }",
      '',
    ].join('\n'),
    'utf8',
  )
  const setDirRes = await fetch(`${backend.url}/api/plugins/dirs`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dir: externalRoot }),
  })
  check('外部插件目录可通过 API 指定', setDirRes.ok, `HTTP ${setDirRes.status}`)
  const extList = await (await fetch(`${backend.url}/api/plugins`)).json()
  const extEntry = extList.plugins.find(item => item.id === 'smoke-external')
  check('后端清单包含外部插件', !!extEntry && extEntry.external === true && extList.externalCount >= 1)
  const extFileRes = await fetch(`${backend.url}${extEntry.path}`)
  const extFileText = await extFileRes.text()
  check('外部插件模块可通过 /user-plugins 访问', extFileRes.ok && extFileText.includes('smoke-external'))
  const { App } = await import('../src/runtime/app.mjs')
  const extApp = new App({ baseUrl: new URL('../', import.meta.url) })
  await extApp.loadAll([{ ...extEntry, path: pathToFileURL(join(externalRoot, 'views', 'smoke-external', 'index.mjs')).href, external: true }], {})
  const extRecord = extApp.records.get('smoke-external')
  check(
    '外部插件可被前端运行时加载并激活',
    extRecord?.status === 'active' && extRecord?.manifest?.external === true && extApp.services.has('smokeExternalService'),
    extRecord?.reason || '',
  )
  const removeRes = await fetch(`${backend.url}/api/plugins/external/smoke-external`, { method: 'DELETE' })
  check('外部插件删除接口生效', removeRes.ok, `HTTP ${removeRes.status}`)

  // depends 版本不匹配：加载前标记未激活并进入 selfCheck 警告，而不是悄悄按旧版本启动。
  const providerDir = join(externalRoot, 'views', 'smoke-dep-provider')
  const versionDir = join(externalRoot, 'views', 'smoke-version')
  await mkdir(providerDir, { recursive: true })
  await mkdir(versionDir, { recursive: true })
  const providerFile = join(providerDir, 'index.mjs')
  const versionFile = join(versionDir, 'index.mjs')
  await writeFile(
    providerFile,
    [
      "export const name = 'smoke-dep-provider'",
      "export const version = '1.0.0'",
      "export const displayName = '版本依赖提供者'",
      "export const provides = [{ name: 'bubble-default', type: 'singleton' }]",
      'export function apply(ctx) { ctx.provide("bubble-default", { name: "smoke-dep-provider" }) }',
      '',
    ].join('\n'),
    'utf8',
  )
  await writeFile(
    versionFile,
    [
      "export const name = 'smoke-version'",
      "export const version = '1.0.0'",
      "export const displayName = '版本不匹配插件'",
      "export const depends = { 'smoke-dep-provider': '^99.0.0' }",
      'export function apply() {}',
      '',
    ].join('\n'),
    'utf8',
  )
  const versionApp = new App({ baseUrl: new URL('../', import.meta.url) })
  await versionApp.loadAll(
    [
      { id: 'smoke-dep-provider', version: '1.0.0', displayName: '版本依赖提供者', path: pathToFileURL(providerFile).href, external: true },
      { id: 'smoke-version', version: '1.0.0', displayName: '版本不匹配插件', path: pathToFileURL(versionFile).href, external: true },
    ],
    {},
  )
  const versionRecord = versionApp.records.get('smoke-version')
  const versionIssues = versionApp.selfCheck()
  check(
    '插件 depends 版本不匹配被标记警告',
    versionRecord?.status === 'active' &&
      versionIssues.some(issue => issue.id === 'smoke-version' && issue.severity === 'warning' && issue.message.includes('版本不匹配')),
    `${versionRecord?.status} · ${(versionIssues.find(issue => issue.id === 'smoke-version')?.message || '')}`,
  )

  // 可选依赖：缺失时插件照常运行，只在自检里标黄；必须依赖缺失仍然标红。
  const softDir = join(externalRoot, 'views', 'smoke-soft')
  const hardDir = join(externalRoot, 'views', 'smoke-hard')
  await mkdir(softDir, { recursive: true })
  await mkdir(hardDir, { recursive: true })
  const softFile = join(softDir, 'index.mjs')
  const hardFile = join(hardDir, 'index.mjs')
  await writeFile(
    softFile,
    [
      "export const name = 'smoke-soft'",
      "export const version = '1.0.0'",
      "export const displayName = '可选依赖插件'",
      "export const optionalDepends = { 'smoke-soft-missing': '^1.0.0' }",
      'export function apply() {}',
      '',
    ].join('\n'),
    'utf8',
  )
  await writeFile(
    hardFile,
    [
      "export const name = 'smoke-hard'",
      "export const version = '1.0.0'",
      "export const displayName = '缺失必须依赖插件'",
      "export const depends = { 'smoke-hard-missing': '^1.0.0' }",
      'export function apply() {}',
      '',
    ].join('\n'),
    'utf8',
  )
  const depApp = new App({ baseUrl: new URL('../', import.meta.url) })
  await depApp.loadAll(
    [
      { id: 'smoke-soft', version: '1.0.0', displayName: '可选依赖插件', path: pathToFileURL(softFile).href, external: true },
      { id: 'smoke-hard', version: '1.0.0', displayName: '缺失必须依赖插件', path: pathToFileURL(hardFile).href, external: true },
    ],
    {},
  )
  const softRecord = depApp.records.get('smoke-soft')
  const hardRecord = depApp.records.get('smoke-hard')
  const depIssues = depApp.selfCheck()
  check(
    '缺少可选依赖时插件仍激活并标黄',
    softRecord?.status === 'active' &&
      depIssues.some(issue => issue.id === 'smoke-soft' && issue.severity === 'warning' && issue.message.includes('可选依赖')),
    `${softRecord?.status} · ${(depIssues.find(issue => issue.id === 'smoke-soft')?.message || '')}`,
  )
  check(
    '缺少必须依赖时插件未激活并标红',
    hardRecord?.status === 'inactive' &&
      depIssues.some(issue => issue.id === 'smoke-hard' && issue.severity === 'error' && issue.message.includes('缺少依赖')),
    `${hardRecord?.status} · ${(depIssues.find(issue => issue.id === 'smoke-hard')?.message || '')}`,
  )

  await fetch(`${backend.url}/api/plugins/dirs`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dir: '' }),
  })
  await rm(externalRoot, { recursive: true, force: true })
  check(
    '插件目录恢复默认后不再包含测试插件',
    !(await (await fetch(`${backend.url}/api/plugins`)).json()).plugins.some(item => item.id === 'smoke-external'),
  )
  section('④ 事件总线')
  let hits = 0
  const off = ctx.on('smoke:ping', () => hits++)
  ctx.emit('smoke:ping', {})
  check('ctx.on / emit 正常', hits === 1)
  off()

  let intercepted = null
  ctx.on('smoke:intercept', payload => ({ ...payload, extra: true }), { owner: 'smoke' })
  ctx.emit('smoke:intercept', { value: 1 }, { interceptor: true, onIntercept: next => (intercepted = next) })
  check('拦截型事件可修改 payload', intercepted?.extra === true)

  // 开启事件追踪后再 emit：历史实现会在 cordis 代理上访问 ctx.id 而抛错，
  // 这里保证调试工具 __wind_debug.trace(true) 是可用的。
  const traced = []
  const previousTrace = loader.trace
  loader.trace = (phase, name, payload, owner) => traced.push({ phase, name, owner })
  let traceEmitOk = true
  try {
    ctx.emit('smoke:trace', { ok: true })
  } catch (_) {
    traceEmitOk = false
  }
  loader.trace = previousTrace
  check('开启事件追踪后 emit 仍然安全', traceEmitOk && traced.some(item => item.name === 'smoke:trace'), JSON.stringify(traced.slice(-3)))

  section('⑤ 聊天闭环（真实后端 + SSE）')
  const sessions = ctx.inject('session-service')
  const messages = ctx.inject('message-service')
  const conv = sessions.create({ name: '冒烟测试会话' })
  sessions.activate(conv.id)
  const before = sessions.messages(conv.id).length
  const sent = messages.requestSend(conv.id, '你好，请回复一段测试文本')
  check('message:send 已广播', !!sent?.conversationId)

  const done = await waitFor(() => {
    const last = sessions.messages(conv.id).at(-1)
    return last && last.role === 'assistant' && !last.streaming && last.content ? last : null
  }, { timeout: 8000 })

  check('助手回复完成（经后端 SSE 流式）', !!done, '8 秒内未收到 message:done')
  check('回复内容来自后端适配器', (done?.content || '').includes('本地后端'), (done?.content || '').slice(0, 40))
  check('消息数量增加 ≥ 2', sessions.messages(conv.id).length >= before + 2, `${before} → ${sessions.messages(conv.id).length}`)
  const statusAdvanced = await waitFor(
    () => sessions.messages(conv.id).find(m => m.role === 'user' && (m.status === 'read' || m.status === 'delivered')),
    { timeout: 3000 },
  )
  check('用户消息状态机推进（delivered/read）', !!statusAdvanced, '3 秒内状态未推进')
  check('气泡渲染包含助手回复', document.querySelectorAll('.msg-row').length >= 2 && !!document.querySelector('.msg-row:not(.right) .bubble'))
  check('会话已写回后端', await waitFor(async () => {
    const payload = await backend.ctx.sessions.list()
    return payload.some(c => c.id === conv.id && c.messages.length >= 2)
  }, { timeout: 3000 }))

  section('⑤b 收尾项：头像 / 语言包 / 通知')
  const config = ctx.inject('config')
  const scrollEl = document.getElementById('msgScroll')
  const scrollHtml = () => String(scrollEl?.innerHTML || '')
  check('用户消息头像默认使用念风 logo', scrollHtml().includes('public/assets/logo.png'))
  config.set('ui.avatarImage', 'data:image/png;base64,SMOKE')
  await sleep(80)
  check('更换头像后消息头像同步更新', scrollHtml().includes('data:image/png;base64,SMOKE'))
  config.set('ui.avatarImage', '')
  await sleep(80)
  check('清除头像后恢复念风 logo', scrollHtml().includes('public/assets/logo.png'))

  const i18n = ctx.inject('i18n')
  const localePacks = i18n.locales()
  check('默认只安装简体中文语言包', localePacks.length === 1 && localePacks[0].id === 'zh-CN', JSON.stringify(localePacks))
  check('未安装的语种不会被切换（i18n 切换真实生效）', i18n.setLocale('en') === false && i18n.locale() === 'zh-CN')

  const notifConv = sessions.create({ name: '通知测试会话' })
  // 保持当前会话仍是 conv，模拟“不在该会话”时收到角色消息
  sessions.activate(conv.id)
  messages.add(notifConv.id, { role: 'assistant', content: '通知测试：来自另一个会话的消息' })
  await sleep(120)
  const notifCards = document.querySelectorAll('.notify-card.notify-kind-character')
  check('非当前会话的角色消息会生成通知', notifCards.length >= 1)
  check(
    '角色通知包含头像 / 角色名 / 内容预览',
    !!notifCards[0]?.querySelector('.notify-avatar') &&
      notifCards[0]?.querySelector('.notify-title')?.textContent === '通知测试会话' &&
      (notifCards[0]?.querySelector('.notify-desc')?.textContent || '').includes('通知测试'),
  )
  ctx.inject('notification').clear?.()
  sessions.remove(notifConv.id)
  sessions.activate(conv.id)
  await sleep(40)

  const clearConv = sessions.create({ name: '清空消息测试' })
  sessions.activate(clearConv.id)
  messages.add(clearConv.id, { role: 'user', content: '待清空' })
  await sleep(50)
  check('清空前消息已渲染', document.querySelectorAll('.msg-row').length >= 1)
  sessions.clearMessages(clearConv.id)
  await sleep(60)
  check('清空消息后会话与界面同步清空', sessions.messages(clearConv.id).length === 0 && document.querySelectorAll('.msg-row').length === 0)
  sessions.remove(clearConv.id)
  sessions.activate(conv.id)
  await sleep(30)

  section('⑥ 视图切换')
  const router = ctx.inject('view-router')
  router.switch('channel')
  await sleep(60)
  const channelListVisible = document.querySelector('#mainPanel .main-view[data-view="channel"]')?.style.display !== 'none'
  const chatHidden = document.querySelector('#mainPanel .main-view[data-view="chat"]')?.style.display === 'none'
  check('切到渠道视图', router.active() === 'channel' && channelListVisible)
  check('会话主视图被隐藏', chatHidden)
  check('渠道列表渲染出分组', document.querySelectorAll('#groupsContainer .group').length >= 1)

  const channelRegistry = ctx.inject('channel-registry')
  const plannedTypes = channelRegistry.plannedList().map(p => p.type)
  const registeredTypes = channelRegistry.typeList().map(t => t.id)
  check('未实现渠道路径被明确标注 discord/email', plannedTypes.includes('discord') && plannedTypes.includes('email') && !plannedTypes.includes('wechat'), plannedTypes.join(','))
  check('微信clawbot 渠道类型已由插件注册', registeredTypes.includes('wechat-clawbot'), registeredTypes.join(','))
  const knownChannelTypes = new Set(['wechat-clawbot', 'qqbot', 'napcat'])
  check(
    'QQ官方机器人 渠道类型已由插件注册',
    registeredTypes.includes('qqbot') && registeredTypes.every(id => knownChannelTypes.has(id)),
    registeredTypes.join(','),
  )
  check('NapCat 渠道类型已由插件注册', registeredTypes.includes('napcat'), registeredTypes.join(','))
  const clawbotType = channelRegistry.type('wechat-clawbot')
  check('微信clawbot 提供自定义添加窗口', typeof clawbotType?.create === 'function')
  check('微信clawbot 提供自定义渠道详情', typeof clawbotType?.detail === 'function')
  const qqbotType = channelRegistry.type('qqbot')
  check('QQ官方机器人 提供自定义添加窗口', typeof qqbotType?.create === 'function')
  check('QQ官方机器人 提供自定义渠道详情', typeof qqbotType?.detail === 'function')
  const napcatType = channelRegistry.type('napcat')
  check('NapCat 提供自定义添加窗口', typeof napcatType?.create === 'function')
  check('NapCat 提供自定义渠道详情', typeof napcatType?.detail === 'function')

  section('⑥a 渠道即时外发（跨渠道 chat_send 回归）')
  {
    const baseService = ctx.inject('channel-base')
    const groups = channelRegistry.groups('private')
    const group = groups[0] || channelRegistry.addGroup('private', '外发测试')
    let delivered = null
    const registration = baseService.defineChannel({
      type: 'outbound-smoke',
      name: '外发测试渠道',
      color: '#8ab4ff',
      outbound: async ({ message }) => {
        delivered = message
        return { ok: true }
      },
    })
    const testChannel = channelRegistry.addChannel('private', group.id, {
      type: 'outbound-smoke',
      name: '外发测试渠道',
      color: '#8ab4ff',
      meta: { roleId: 'outbound-smoke-role' },
    })
    const outboundConv = sessions.create({
      name: '外发测试会话',
      meta: { channelType: 'outbound-smoke', channelId: `outbound-smoke:${testChannel.id}` },
    })
    channelRegistry.updateChannel('private', testChannel.id, {
      meta: { ...(testChannel.meta || {}), conversationId: outboundConv.id },
    })
    messages.add(outboundConv.id, { role: 'assistant', content: '这条消息应该立即外发' })
    const deliveredMessage = await waitFor(() => delivered, { timeout: 2000 })
    check(
      '助手消息写入渠道会话后立即外发（不再等整轮结束）',
      deliveredMessage?.content === '这条消息应该立即外发',
      String(deliveredMessage?.content || ''),
    )
    registration.dispose?.()
    channelRegistry.removeChannel('private', testChannel.id)
    sessions.remove(outboundConv.id)
  }

  section('⑥b NapCat 输入状态（整轮刷新，结束停止）')
  {
    const groups = channelRegistry.groups('private')
    const group = groups[0] || channelRegistry.addGroup('private', '输入状态测试')
    const inputConv = sessions.create({
      name: '输入状态测试会话',
      meta: { channelType: 'napcat', channelId: 'napcat:input-state-test' },
    })
    const inputChannel = channelRegistry.addChannel('private', group.id, {
      type: 'napcat',
      name: '输入状态测试',
      color: '#0099ff',
      meta: {
        conversationId: inputConv.id,
        instanceId: 'inst-input-test',
        targetType: 'private',
        targetId: '10001',
        category: 'private',
      },
    })
    const calls = []
    const originalAction = napcatService.action
    napcatService.action = async (instanceId, action, params) => {
      calls.push({ instanceId, action, params })
      return { ok: true }
    }
    config.set('napcat.inputState.enabled', true)
    config.set('napcat.inputState.intervalMs', 50)
    ctx.emit('chat:request-start', { conversationId: inputConv.id })
    await sleep(120)
    const inputCalls = calls.filter(call => call.action === 'set_input_status')
    check(
      'NapCat 私聊整轮期间持续刷新输入中',
      inputCalls.length >= 1 && inputCalls[0]?.params?.user_id === 10001,
      JSON.stringify(inputCalls.slice(0, 2)),
    )
    ctx.emit('chat:request-done', { conversationId: inputConv.id })
    await sleep(30)
    const countAtStop = calls.length
    await sleep(180)
    check('NapCat 整轮结束后停止刷新输入中', calls.length === countAtStop, `${countAtStop} → ${calls.length}`)
    napcatService.action = originalAction
    config.set('napcat.inputState.intervalMs', 3000)
    channelRegistry.removeChannel('private', inputChannel.id)
    sessions.remove(inputConv.id)
  }

  section('⑥c 外部渠道敏感确认（微信clawbot 回归）')
  {
    const permissions = ctx.inject('chat-permissions')
    const store = ctx.inject('chat-store')
    const groups = channelRegistry.groups('private')
    const group = groups[0] || channelRegistry.addGroup('private', '确认测试')
    const roleConv = sessions.create({ id: 'smoke-confirm-role', name: '确认测试角色' })
    const targetConv = sessions.create({ id: 'smoke-confirm-target', name: '确认目标网页会话' })
    const clawConv = sessions.create({
      id: 'smoke-confirm-claw',
      name: '微信确认测试会话',
      meta: {
        channelId: 'wechat-clawbot:smoke-confirm-claw-channel',
        channelType: 'wechat-clawbot',
        channelGroup: 'private',
        source: 'wechat-clawbot',
        roleId: roleConv.id,
        hiddenFromSessionList: true,
        channelConversation: true,
        // 故意使用与网页端身份不同的渠道身份，覆盖“微信主人自定义用户标识”的场景。
        identityUserId: 'smoke-wechat-owner',
        identityUserName: '微信主人',
        crossReadable: true,
        crossSendable: true,
        sensitiveConfirm: true,
      },
    })
    const clawChannel = channelRegistry.addChannel('private', group.id, {
      type: 'wechat-clawbot',
      name: '微信确认测试渠道',
      color: '#07c160',
      status: 'online',
      meta: {
        kind: 'wechat-clawbot',
        roleId: roleConv.id,
        category: 'private',
        identity: { userId: 'smoke-wechat-owner', userName: '微信主人' },
        conversationId: clawConv.id,
        permissions: { read: true, reply: true, context: true, typing: false, images: false, documents: false, crossRead: true, crossSend: true, confirm: true },
      },
    })
    let confirmRequest = null
    let confirmRequestCount = 0
    const offRequest = ctx.on('chat:confirm-request', payload => {
      confirmRequest = payload
      confirmRequestCount += 1
    })
    const confirmArgs = {
      conversationId: clawConv.id,
      action: 'read',
      channel: `nova:web:${targetConv.id}`,
    }
    const pendingDecision = permissions.authorize(confirmArgs)
    // 同一来源会话 + 同一动作 + 同一目标：并发的第二次请求应复用同一个 pending，
    // 否则用户只回复一次“确认”，另一条会超时并把超时提示写进聊天记录。
    const duplicateDecision = permissions.authorize(confirmArgs)
    await waitFor(() => confirmRequest, { timeout: 2000 })
    check('外部渠道跨渠道操作会创建敏感确认', !!confirmRequest && confirmRequest.conversationId === clawConv.id, JSON.stringify(confirmRequest))
    check('同一会话 / 动作 / 目标的重复确认请求会合并', confirmRequestCount === 1, `confirm-request 次数 ${confirmRequestCount}`)
    const clawChannelId = `wechat-clawbot:${clawChannel.id}`
    const beforeConfirmMessages = store.messagesOf(clawChannelId).length
    ctx.emit('backend:event', {
      event: 'clawbot:message',
      data: {
        channelId: clawChannel.id,
        message: {
          id: 'smoke-wx-confirm-1',
          text: '确认',
          fromUserId: 'smoke-openid-1',
          contextToken: 'smoke-ctx',
          nickname: '微信主人',
        },
      },
    })
    const [confirmed, duplicateConfirmed] = await Promise.race([
      Promise.all([pendingDecision, duplicateDecision]),
      sleep(1500).then(() => [null, null]),
    ])
    check('微信侧回复“确认”后放行跨渠道读取', confirmed?.ok === true && confirmed?.confirmed === true, JSON.stringify(confirmed))
    check('重复确认请求被同一次“确认”一起放行', duplicateConfirmed?.ok === true && duplicateConfirmed?.confirmed === true, JSON.stringify(duplicateConfirmed))
    check(
      '渠道身份确认不会把“确认”写进聊天记录',
      store.messagesOf(clawChannelId).length === beforeConfirmMessages,
      `${beforeConfirmMessages} → ${store.messagesOf(clawChannelId).length}`,
    )
    offRequest?.()
    channelRegistry.removeChannel('private', clawChannel.id)
    sessions.remove(clawConv.id)
    sessions.remove(targetConv.id)
    sessions.remove(roleConv.id)
  }

  section('⑥d 角色级渠道权限同步（设置页 / 渠道详情同一份状态）')
  {
    const chatPermissions = ctx.inject('chat-permissions')
    const chatStore = ctx.inject('chat-store')
    const syncRoleId = 'role-perm-sync'
    const syncConvA = smokeSessions.create({ name: '权限同步渠道 A', meta: { roleId: syncRoleId } })
    const syncConvB = smokeSessions.create({ name: '权限同步渠道 B', meta: { roleId: syncRoleId } })
    const recordA = chatStore.channelForConversation(syncConvA.id)
    const recordB = chatStore.channelForConversation(syncConvB.id)
    chatPermissions.setRolePolicy(syncRoleId, { crossReadable: true })
    await sleep(30)
    check(
      '设置页角色级开关同步到同角色全部会话',
      chatStore.channelRecord(recordA.channelId)?.crossReadable === true && chatStore.channelRecord(recordB.channelId)?.crossReadable === true,
      JSON.stringify({ a: chatStore.channelRecord(recordA.channelId), b: chatStore.channelRecord(recordB.channelId) }),
    )

    const permGroup = channelRegistry.groups('private')[0] || channelRegistry.addGroup('private', '权限同步测试')
    const externalChannel = channelRegistry.addChannel('private', permGroup.id, {
      type: 'wechat-clawbot',
      name: '权限同步外部渠道',
      meta: {
        roleId: syncRoleId,
        conversationId: syncConvB.id,
        permissions: { read: true, reply: true, context: true, crossRead: false, crossSend: false, confirm: true },
      },
    })
    await sleep(50)
    const externalAfterAdd = channelRegistry.findChannel('private', externalChannel.id)
    check(
      '新增渠道的默认关闭值不会把角色已有开启策略关掉，并会继承角色策略',
      chatStore.channelRecord(recordA.channelId)?.crossReadable === true && externalAfterAdd?.meta?.permissions?.crossRead === true,
      JSON.stringify(externalAfterAdd?.meta?.permissions || null),
    )

    channelRegistry.updateChannel('private', externalChannel.id, {
      meta: { ...externalAfterAdd.meta, permissions: { ...externalAfterAdd.meta.permissions, crossRead: false } },
    })
    await sleep(50)
    check(
      '渠道详情关闭跨渠道读取后，同角色其它渠道同步关闭',
      chatStore.channelRecord(recordA.channelId)?.crossReadable === false && chatStore.channelRecord(recordB.channelId)?.crossReadable === false,
      JSON.stringify({ a: chatStore.channelRecord(recordA.channelId), b: chatStore.channelRecord(recordB.channelId) }),
    )
    check('角色聚合策略被 chat-permissions 用于实际校验', chatPermissions.contextFor(syncConvA.id)?.crossReadable === false)

    chatPermissions.setRolePolicy(syncRoleId, { crossReadable: true, crossSendable: true })
    await sleep(50)
    const externalAfterSet = channelRegistry.findChannel('private', externalChannel.id)
    check(
      '设置页角色开关会回写渠道详情里的跨渠道读取 / 发送权限',
      externalAfterSet?.meta?.permissions?.crossRead === true && externalAfterSet?.meta?.permissions?.crossSend === true,
      JSON.stringify(externalAfterSet?.meta?.permissions || null),
    )

    channelRegistry.removeChannel('private', externalChannel.id)
    smokeSessions.remove(syncConvA.id)
    smokeSessions.remove(syncConvB.id)
    await sleep(30)
  }

  // 角色下拉框回归：chat-store 会把普通会话登记为 nova 网页渠道，它们仍是角色；
  // 其它渠道（wechat-clawbot / qqbot）的聊天记录容器不能被当成角色列出来。
  const roleConv = smokeSessions.create({ id: 'smoke-role-conv', name: '冒烟角色' })
  smokeSessions.create({
    id: 'smoke-nova-role',
    name: 'Nova角色冒烟',
    meta: { channelType: 'nova', channelId: 'nova:web:smoke-nova-role' },
  })
  smokeSessions.create({
    id: 'smoke-other-channel',
    name: '其它渠道记录',
    meta: { hiddenFromSessionList: true, channelConversation: true, channelType: 'wechat-clawbot', channelId: 'wechat-clawbot:other' },
  })
  await sleep(40)

  const readRoleOptions = async type => {
    type.create({ tab: 'private' })
    await sleep(40)
    const masks = Array.from(document.body.querySelectorAll('.wc-mask'))
    const dialog = masks[masks.length - 1]
    const select = dialog?.querySelector('[data-wc-role]')
    const text = Array.from(select?.querySelectorAll('option') || [])
      .map(option => option.textContent || '')
      .join('|')
    dialog?.querySelector('[data-wc-cancel]')?.click()
    await sleep(20)
    return { dialog, select, text }
  }

  const qqRoleOptions = await readRoleOptions(qqbotType)
  check(
    'QQ 添加渠道的角色下拉只列真正的角色',
    qqRoleOptions.text.includes('冒烟角色') &&
      qqRoleOptions.text.includes('Nova角色冒烟') &&
      !qqRoleOptions.text.includes('其它渠道记录'),
    qqRoleOptions.text,
  )
  const wxRoleOptions = await readRoleOptions(clawbotType)
  check(
    '微信clawbot 角色下拉同样不会把渠道记录当成角色',
    wxRoleOptions.text.includes('冒烟角色') &&
      wxRoleOptions.text.includes('Nova角色冒烟') &&
      !wxRoleOptions.text.includes('其它渠道记录'),
    wxRoleOptions.text,
  )

  // NapCat 创建窗口：群聊规则面板 / 目标群号 / 角色下拉过滤。
  napcatType.create({ tab: 'group' })
  await sleep(50)
  const ncMaskList = Array.from(document.body.querySelectorAll('.nc-mask'))
  const ncCreateDialog = ncMaskList[ncMaskList.length - 1]
  const ncRoleText = Array.from(ncCreateDialog?.querySelector('[data-nc-role]')?.querySelectorAll('option') || [])
    .map(option => option.textContent || '')
    .join('|')
  check(
    'NapCat 角色下拉只列真正的角色',
    ncRoleText.includes('冒烟角色') && ncRoleText.includes('Nova角色冒烟') && !ncRoleText.includes('其它渠道记录'),
    ncRoleText,
  )
  check('NapCat 群聊分类显示群聊规则面板', ncCreateDialog?.querySelector('[data-nc-group-rules]')?.hidden === false)
  check(
    'NapCat 群聊目标标签显示“目标群号”',
    String(ncCreateDialog?.querySelector('[data-nc-target-label]')?.textContent || '').includes('群号'),
    String(ncCreateDialog?.querySelector('[data-nc-target-label]')?.textContent || ''),
  )
  check(
    'NapCat 权限设置包含 6 项且复选框结构完整',
    ncCreateDialog?.querySelectorAll('[data-nc-perm]')?.length === 6,
    String(ncCreateDialog?.querySelectorAll('[data-nc-perm]')?.length),
  )
  const ncModeSelect = ncCreateDialog?.querySelector('[data-nc-mode]')
  if (ncModeSelect) {
    ncModeSelect.value = 'reverse'
    ncModeSelect.dispatchEvent({ type: 'change' })
  }
  check('NapCat Reverse 模式显示反向主机 / 端口', ncCreateDialog?.querySelector('[data-nc-reverse-row]')?.hidden === false)
  const ncRequireAt = ncCreateDialog?.querySelector('[data-nc-require-at]')
  const ncProbability = ncCreateDialog?.querySelector('[data-nc-probability]')
  const ncProbabilityNumber = ncCreateDialog?.querySelector('[data-nc-probability-number]')
  check(
    'NapCat “仅 @ 时回复”复选框不再嵌套 label（避免点击被浏览器双触发）',
    !!ncRequireAt && ncRequireAt.closest('label')?.parentElement?.tagName !== 'LABEL',
  )
  if (ncRequireAt && ncProbability) {
    ncRequireAt.checked = false
    ncRequireAt.dispatchEvent({ type: 'change' })
  }
  check('NapCat 关闭艾特限制后回复概率输入可用', ncProbability?.disabled === false)
  if (ncProbabilityNumber) {
    ncProbabilityNumber.value = '37'
    ncProbabilityNumber.dispatchEvent({ type: 'input' })
  }
  check('NapCat 回复概率支持手动输入数值', String(ncProbabilityNumber?.value || '') === '37' && String(ncProbability?.value || '') === '37')
  ncCreateDialog?.querySelector('[data-nc-cancel]')?.click()
  await sleep(20)

  // 保存渠道只负责创建并提示去详情「接入」，不应自动弹出二维码窗口。
  qqbotType.create({ tab: 'private' })
  await sleep(40)
  let maskList = Array.from(document.body.querySelectorAll('.wc-mask'))
  let qqCreateDialog = maskList[maskList.length - 1]
  qqCreateDialog.querySelector('[data-wc-role]').value = roleConv.id
  qqCreateDialog.querySelector('[data-wc-name]').value = 'QQ保存流程冒烟'
  qqCreateDialog.querySelector('[data-wc-save]')?.click()
  await sleep(80)
  const createdQQ = channelRegistry.channels('private').find(item => item.type === 'qqbot')
  const loginDialogVisible = Array.from(document.body.querySelectorAll('.wc-mask .wc-dialog h3'))
    .some(node => String(node.textContent || '').includes('接入 QQ 官方机器人'))
  check('保存 QQ 渠道后不会自动弹出二维码登录窗口', !!createdQQ && !loginDialogVisible)
  if (createdQQ) {
    const createdKey = `private:${createdQQ.id}`
    if (channelRegistry.activeKey() !== createdKey) channelRegistry.activate('private', createdQQ.id)
    await sleep(120)
    const connectButton = document.querySelector('.wc-detail [data-wc-action="connect"]')
    // 极简 DOM 垫片不实现事件冒泡，这里手动把 click 冒泡到祖先，触发详情容器的委托监听。
    for (let node = connectButton; node; node = node.parentNode) {
      node._fire?.('click', { target: connectButton })
    }
    await sleep(180)
    const loginDialog = Array.from(document.body.querySelectorAll('.wc-mask .wc-dialog h3'))
      .find(node => String(node.textContent || '').includes('接入 QQ 官方机器人'))
    const loginDialogBox = loginDialog?.parentNode || loginDialog?.closest?.('.wc-dialog')
    const loginText = loginDialogBox?.textContent || ''
    check(
      'QQ 接入弹窗可正常打开并提示本地 WebSocket / 沙箱免白名单方案',
      !!loginDialog && String(loginText).includes('本地 WebSocket') && String(loginText).includes('沙箱 OpenAPI'),
      String(loginText).slice(0, 120),
    )
    loginDialogBox?.querySelector?.('[data-wc-login-close]')?.click()
    await sleep(40)
    // 删除渠道时应同步清掉它的聊天记录容器（历史上删除后仍残留在聊天记录页）。
    smokeSessions.create({
      id: 'smoke-orphan-qqbot',
      name: 'QQ孤立记录',
      avatar: 'Q',
      meta: {
        channelType: 'qqbot',
        channelConversation: true,
        hiddenFromSessionList: true,
        qqbotChannelId: 'smoke-deleted-qqbot',
        channelId: 'qqbot:smoke-deleted-qqbot',
      },
    })
    await sleep(20)
    channelRegistry.removeChannel('private', createdQQ.id)
    await sleep(120)
    check('删除 QQ 渠道会同步清理对应聊天记录容器', !smokeSessions.get('smoke-orphan-qqbot'))
  }
  for (const id of ['smoke-role-conv', 'smoke-nova-role', 'smoke-other-channel']) smokeSessions.remove(id)
  await sleep(40)

  const group = channelRegistry.groups('private')[0]
  const channel = channelRegistry.addChannel('private', group.id, { type: 'custom', name: '测试渠道' })
  channelRegistry.activate('private', channel.id)
  await sleep(80)
  check('激活渠道后详情渲染', document.querySelector('.channel-detail')?.textContent.includes('测试渠道'), document.querySelector('.channel-detail')?.textContent?.slice(0, 60))
  check('渠道视图有 1 个真实渠道（非种子数据）', channelRegistry.channels('private').length === 1)

  router.switch('chat')
  await sleep(60)
  check('切回会话视图', router.active() === 'chat' && router.getWidth('chat') >= 68)

  // 视图注册也是注册型服务：注销时必须清理左右面板挂载，并把 active 回退到可用视图
  const tempViewDispose = router.register('smoke-temp-view', {
    label: '临时视图',
    icon: '',
    order: 999,
    rail: false,
    list(container) {
      container.innerHTML = '<div id="smokeTempList"></div>'
    },
    main(container) {
      container.innerHTML = '<div id="smokeTempMain"></div>'
    },
  })
  router.switch('smoke-temp-view')
  await sleep(40)
  check('临时注册的视图能挂载到左右面板', !!document.getElementById('smokeTempList') && !!document.getElementById('smokeTempMain'))
  tempViewDispose()
  await sleep(40)
  check(
    '视图注销后挂载被清理且 active 自动回退',
    !router.has('smoke-temp-view') && router.active() !== 'smoke-temp-view' && !document.getElementById('smokeTempMain'),
    String(router.active()),
  )

  section('⑦ 可选中服务与运行时启停')
  const bubbles = ctx.inject('bubble-styles')
  check('默认气泡已注册', bubbles.getActiveId() === 'bubble-default')
  check('气泡实现列表只有默认实现（精简后）', bubbles.list().length === 1, bubbles.list().map(b => b.id).join(','))

  const manager = ctx.inject('plugin-manager')
  const disabledOk = await manager.disable('tooltip-host')
  await sleep(80)
  const tooltipRecord = loader.get('tooltip-host')
  check('运行时禁用插件成功', disabledOk && tooltipRecord.status === 'disabled' && !ctx.registry.get('tooltip'))
  const enabledOk = await manager.enable('tooltip-host')
  await sleep(80)
  check('运行时重新启用插件成功', enabledOk && loader.get('tooltip-host').status === 'active' && !!ctx.registry.get('tooltip'))

  // 卸载不是“删了就找不回来”：记录保留 removed 标记，插件页提供恢复入口
  const uninstallPromise = manager.uninstall('tooltip-host')
  await sleep(30)
  document.querySelector('#modalOk')?.click()
  await uninstallPromise
  await sleep(80)
  check(
    '卸载后标记 removed 并从正常列表移除',
    manager.describe('tooltip-host')?.removed === true && !manager.list().some(p => p.id === 'tooltip-host'),
  )
  const restoreOk = await manager.restore('tooltip-host')
  await sleep(80)
  check(
    '卸载后的插件可以恢复运行',
    restoreOk && manager.describe('tooltip-host')?.removed === false && loader.get('tooltip-host').status === 'active',
  )
  // 卸载状态必须能在插件页里看到，并直接点「恢复」回来
  const pluginPages = ctx.inject('settings-container')
  const removeAgain = manager.uninstall('tooltip-host')
  await sleep(30)
  document.querySelector('#modalOk')?.click()
  await removeAgain
  await sleep(80)
  pluginPages.open('plugins')
  await sleep(50)
  const restoreButton = document.querySelector('[data-plugin-action="restore"][data-plugin-id="tooltip-host"]')
  check('插件页为已卸载插件渲染恢复按钮', !!restoreButton)
  restoreButton?.click()
  await sleep(120)
  check(
    '点击恢复按钮后插件重新运行',
    manager.describe('tooltip-host')?.removed === false && loader.get('tooltip-host').status === 'active',
  )

  // 注册型服务同样要随插件卸载一起释放，否则重新启用会出现残留/重复/注册冲突
  await manager.disable('settings-item-data')
  await sleep(80)
  check('禁用设置项后注册页被移除', !pluginPages.list().some(page => page.id === 'data'))
  await manager.enable('settings-item-data')
  await sleep(80)
  check('重新启用设置项后注册页恢复', pluginPages.list().some(page => page.id === 'data'))

  await manager.disable('global-search')
  await sleep(80)
  check('禁用全局搜索后侧栏入口与浮层一起移除', !document.getElementById('globalSearchBtn'))
  await manager.enable('global-search')
  await sleep(120)
  check(
    '重新启用全局搜索不产生重复入口',
    document.querySelectorAll('#globalSearchBtn').length === 1 && !!ctx.inject('global-search'),
  )

  section('⑧ 主题 / 背景可选中服务')
  const theme = ctx.inject('theme')
  theme.select('dark')
  await sleep(50)
  check('切换到深色主题', document.documentElement.dataset.theme === 'dark')
  theme.select('light')
  await sleep(50)
  check('切回浅色主题', document.documentElement.dataset.theme === 'light')
  const bg = ctx.inject('bg-provider')
  bg.select('bg-solid')
  await sleep(50)
  check('切换到纯色背景', !!document.querySelector('.bg-solid-inner'))
  bg.select('bg-aurora')
  await sleep(50)
  check('切回绿雾背景', bg.active() === 'bg-aurora' && !!document.querySelector('.bg-aurora'))

  // selectable 服务：禁用当前实现后 activeId 会临时落到别的实现上；
  // 重新启用同一个实现时必须自动切回来，而不是等刷新。
  await manager.disable('bg-aurora')
  await sleep(100)
  check('禁用绿雾背景后立即回退其它实现', bg.active() !== 'bg-aurora' && !document.querySelector('.bg-aurora'))
  await manager.enable('bg-aurora')
  await sleep(150)
  check(
    '重新启用绿雾背景后无需刷新即恢复',
    bg.active() === 'bg-aurora' && !!document.querySelector('.bg-aurora'),
    String(bg.active()),
  )

  section('⑨ 渠道消息闭环')
  const convCount = sessions.count()
  ctx.emit('channel:message', {
    channelId: channel.id,
    channel,
    message: { role: 'user', content: '来自测试渠道的问候' },
  })
  await sleep(200)
  check(
    '渠道消息落库为会话',
    sessions.count() === convCount + 1 && sessions.list().some(c => c.preview?.includes('测试渠道的问候')),
    `会话数 ${sessions.count()}`,
  )

  section('⑩ 设置页全量渲染')
  const settingsView = ctx.inject('settings-view')
  const settingsContainer = ctx.inject('settings-container')
  settingsView.open('account')
  await sleep(60)
  check('设置页已打开', settingsView.isOpen())
  check('设置导航已渲染', document.querySelectorAll('.settings-nav-item').length >= 10, `实际 ${document.querySelectorAll('.settings-nav-item').length}`)
  const pages = settingsContainer.list()
  check('设置页注册数量 ≥ 11', pages.length >= 11, `实际 ${pages.length}`)

  const pageErrors = []
  for (const page of pages) {
    settingsContainer.open(page.id)
    await sleep(50)
    const content = document.querySelector('#settingsContent') || document.querySelector('.settings-content')
    const html = content?.innerHTML || ''
    if (html.length < 80) pageErrors.push(`${page.id} 内容为空`)
    if (html.includes('页面渲染失败')) pageErrors.push(`${page.id} 渲染失败`)
  }
  check('所有设置页渲染成功', pageErrors.length === 0, pageErrors.join(' | '))
  const settingSearchHits = settingsContainer.searchItems('声音')
  check(
    '设置搜索能直接命中具体设置项',
    settingSearchHits.some(item => item.name.includes('声音提示')) && settingSearchHits.some(item => item.pageId === 'notifications'),
    JSON.stringify(settingSearchHits.map(item => `${item.pageId}/${item.name}`).slice(0, 8)),
  )

  settingsContainer.open('appearance')
  await sleep(60)
  const appearanceNames = []
  document.querySelectorAll('.settings-content .setting-name').forEach(el => appearanceNames.push(String(el.textContent)))
  check(
    '外观页背景使用正式名称',
    appearanceNames.includes('绿雾背景') && appearanceNames.includes('纯色背景') && appearanceNames.includes('自定义背景图'),
    appearanceNames.join(','),
  )
  check('外观页气泡使用正式名称', appearanceNames.includes('默认气泡'), appearanceNames.join(','))
  check('外观页不再把内部 id 当作名称', !appearanceNames.some(name => /^(bg-|bubble-|theme-)/.test(name)), appearanceNames.join(','))
  settingsContainer.open('plugins')
  await sleep(150)
  check('插件页显示外部插件目录设置', !!document.querySelector('#pluginDirInput'))
  const dirsText = String(document.querySelector('#pluginDirsContainer')?.textContent || '')
  check('插件页说明内置与外部插件目录', dirsText.includes('内置插件目录') && dirsText.includes('外部插件目录'), dirsText.slice(0, 120))
  check('插件页渲染出插件条目', (() => {
    settingsContainer.open('plugins')
    return document.querySelectorAll('#pluginListContainer .plugin-item').length >= 20
  })(), `实际 ${document.querySelectorAll('#pluginListContainer .plugin-item').length}`)
  const chatChannels = ctx.inject('channel-registry')
  const smokeGroup = chatChannels.groups('group')[0]
  const smokeGroupChannel = smokeGroup
    ? chatChannels.addChannel('group', smokeGroup.id, { type: 'custom', name: '群聊记忆开关冒烟', meta: { category: 'group' } })
    : null
  settingsContainer.open('model')
  await sleep(80)
  const modelContent = document.querySelector('.settings-content')
  check('官方服务插件已移出仓库（不编译、不推送）', !ctx.inject('plugin-manager').describe('official-service'))
  check('模型页默认展示自定义提供商面板', !!document.querySelector('.settings-content .model-provider-layout'))
  check('当前生效有模型选择按钮', !!document.querySelector('.settings-content [data-active-model]'))
  check('失败转移配置入口存在', (modelContent?.textContent || '').includes('失败自动切换模型'))
  const memorySummaryToggle = document.querySelector('.settings-content [data-config-toggle="memory.groupSummaryEnabled"]')
  const memoryRoundsInput = document.querySelector('.settings-content [data-config-input="memory.summaryRounds"]')
  check(
    '记忆模型分区包含私聊总结轮次与群聊记忆总开关',
    !!memorySummaryToggle && !!memoryRoundsInput && !!(modelContent?.textContent || '').includes('群聊记忆总结'),
    String(modelContent?.textContent || '').slice(0, 200),
  )
  if (memorySummaryToggle) {
    memorySummaryToggle.click()
    await sleep(20)
    check('群聊记忆总开关可写回配置', ctx.inject('config').get('memory.groupSummaryEnabled') === false)
    memorySummaryToggle.click()
    await sleep(20)
  }
  const memoryGroupToggle = smokeGroupChannel
    ? document.querySelector(`.settings-content [data-config-toggle="memory.groupSummaryDisabled.${smokeGroupChannel.id}"]`)
    : null
  check(
    '群聊记忆分区能列出逐渠道关闭开关',
    !smokeGroupChannel || !!memoryGroupToggle,
    String(modelContent?.querySelector('.setting-row')?.textContent || '').slice(0, 160),
  )
  if (memoryGroupToggle) {
    memoryGroupToggle.click()
    await sleep(20)
    check(
      '逐渠道关闭开关可写回配置',
      ctx.inject('config').get(`memory.groupSummaryDisabled.${smokeGroupChannel.id}`) === true &&
        ctx.inject('config').get('memory.groupSummaryDisabled')?.[smokeGroupChannel.id] === true,
    )
    memoryGroupToggle.click()
    await sleep(20)
  }
  if (smokeGroupChannel) chatChannels.removeChannel('group', smokeGroupChannel.id)
  const reasoningSlider = document.querySelector('.settings-content [data-slider="reasoning"]')
  const temperatureSlider = document.querySelector('.settings-content [data-slider="temperature"]')
  check('推理等级是独立滑块', !!reasoningSlider && !!reasoningSlider.querySelector('input[type="range"]'))
  check('temperature 是独立滑块', !!temperatureSlider && !!temperatureSlider.querySelector('input[type="range"]'))
  const reasoningRange = reasoningSlider?.querySelector('input[type="range"]')
  const temperatureRange = temperatureSlider?.querySelector('input[type="range"]')
  if (reasoningRange) {
    reasoningRange.value = '3'
    reasoningRange.dispatchEvent({ type: 'change' })
  }
  await sleep(30)
  check('推理等级写入 max', ctx.inject('config').get('chat.reasoningEffort') === 'max', String(ctx.inject('config').get('chat.reasoningEffort')))
  check('推理等级不改变 temperature', Number(ctx.inject('config').get('chat.temperature')) === 1)
  if (temperatureRange) {
    temperatureRange.value = '1.7'
    temperatureRange.dispatchEvent({ type: 'change' })
  }
  await sleep(30)
  check('temperature 支持 0-2 连续值', Number(ctx.inject('config').get('chat.temperature')) === 1.7, String(ctx.inject('config').get('chat.temperature')))
  check('temperature 不改变推理等级', ctx.inject('config').get('chat.reasoningEffort') === 'max')
  // 多端实时同步：模拟后端 SSE settings/updated 广播电脑端刚改的推理等级，
  // 当前已打开的手机模型页应该立即更新，而不是刷新后仍是“无”。
  const configService = ctx.inject('config')
  const remoteAt = Date.now() + 5000
  ctx.emit('backend:event', {
    event: 'settings/updated',
    data: {
      preferences: { chat: { reasoningEffort: 'high', stream: false } },
      preferencesMeta: { 'chat.reasoningEffort': { at: remoteAt, by: 'desktop-smoke' }, 'chat.stream': { at: remoteAt, by: 'desktop-smoke' } },
    },
  })
  await sleep(30)
  const liveReasoningSlider = document.querySelector('.settings-content [data-slider="reasoning"]')
  const liveReasoningRange = liveReasoningSlider?.querySelector('input[type="range"]')
  const streamToggle = document.querySelector('.settings-content [data-config-toggle="chat.stream"]')
  check('SSE 推送的电脑端偏好会实时写入本地配置', configService.get('chat.reasoningEffort') === 'high', String(configService.get('chat.reasoningEffort')))
  check(
    '已打开的推理滑块实时刷新，无需手动刷新页面',
    liveReasoningSlider?.classList.contains('reasoning-high') &&
      liveReasoningRange?.value === '2' &&
      liveReasoningSlider.querySelector('[data-slider-value]')?.textContent === '高',
    `${liveReasoningSlider?.className} / ${liveReasoningRange?.value} / ${liveReasoningSlider?.querySelector('[data-slider-value]')?.textContent}`,
  )
  check(
    '普通设置开关也实时刷新（流式输出）',
    !!streamToggle && !streamToggle.classList.contains('on'),
    streamToggle?.className,
  )
  // 恢复默认，避免影响后续对话测试
  configService.set('chat.reasoningEffort', 'off')
  configService.set('chat.temperature', 1)
  configService.set('chat.stream', true)
  check('关闭开关后切换为自定义提供商面板', !!document.querySelector('.settings-content .model-provider-layout'))
  check(
    '自定义提供商面板能看到后端提供商',
    (document.querySelector('.settings-content')?.textContent || '').includes('Smoke Provider'),
    '未找到 Smoke Provider',
  )
  const smokeItem = [...document.querySelectorAll('.settings-content [data-provider-id]')].find(el => el.dataset.providerId === 'smoke')
  check('提供商列表出现 smoke', !!smokeItem)
  smokeItem?.click()
  await sleep(40)
  check('提供商详情显示 Base URL', (document.querySelector('.settings-content')?.textContent || '').includes('smoke://local'))
  check('提供商详情展示模型列表', (document.querySelector('.settings-content')?.textContent || '').includes('Smoke Model'))
  check('提供商详情有新增自定义模型入口', !!document.querySelector('.settings-content [data-action="add-model"]'))
  // 「获取模型列表」必须展示临时列表：点击添加前不能写库 / 自动启用
  document.querySelector('.settings-content [data-action="refresh"]')?.click()
  await sleep(100)
  const discoveredSmoke = document.querySelector('[data-discover-add="smoke-1"]')
  check('获取模型列表以临时列表展示', !!document.querySelector('.model-discovered') && !!discoveredSmoke)
  check('已在模型列表中的远端候选标记为已添加', discoveredSmoke?.hasAttribute('disabled') === true)
  check(
    '获取模型列表不会自动写入或启用模型',
    backend.ctx.settings.get().providers.smoke?.models?.length === 1,
    JSON.stringify(backend.ctx.settings.get().providers.smoke?.models),
  )
  const discoveredSmokeNew = document.querySelector('[data-discover-add="smoke-2"]')
  check('未安装的远端候选提供添加入口', !!discoveredSmokeNew && !discoveredSmokeNew.hasAttribute('disabled'))
  discoveredSmokeNew?.click()
  const discoveredModelAdded = await waitFor(
    () => backend.ctx.settings.get().providers.smoke?.models?.some(model => model.id === 'smoke-2'),
    { timeout: 3000 },
  )
  check('点击「添加」后才写入模型列表', !!discoveredModelAdded)

  // 提供商启用开关（曾经是只有 data-toggle 没有绑定事件，点了没反应）
  document.querySelector('.settings-content [data-action="toggle-provider-enabled"]')?.click()
  const providerDisabledViaUi = await waitFor(() => backend.ctx.settings.get().providers.smoke?.enabled === false, { timeout: 3000 })
  check('提供商启用开关可写回后端（禁用）', !!providerDisabledViaUi)
  document.querySelector('.settings-content [data-action="toggle-provider-enabled"]')?.click()
  const providerEnabledViaUi = await waitFor(() => backend.ctx.settings.get().providers.smoke?.enabled !== false, { timeout: 3000 })
  check('提供商启用开关可写回后端（恢复）', !!providerEnabledViaUi)

  // 模型设置页反复刷新回归：select 同一个模型不应该反复写 selectable 配置。
  const modelRegistry = ctx.inject('model-registry')
  const eventBusForModel = ctx.inject('event-bus')
  const activeModelKey = modelRegistry?.activeKey?.()
  if (activeModelKey) {
    let modelPrefWrites = 0
    const offConfigWatch = eventBusForModel.on('config:changed', payload => {
      if (String(payload?.key || '').startsWith('selectable.model.')) modelPrefWrites += 1
    })
    modelRegistry.select(activeModelKey)
    await sleep(40)
    offConfigWatch?.()
    check(
      '重复选择当前模型不会反复写配置（模型设置页不再自刷新）',
      modelPrefWrites === 0,
      `selectable.model 配置写入 ${modelPrefWrites} 次`,
    )
  } else {
    check('重复选择当前模型不会反复写配置（模型设置页不再自刷新）', false, '当前没有可用模型')
  }

  // 自定义提供商 / 模型 CRUD（真实后端写盘 + 真实 DOM 事件）
  const setField = (selector, value) => {
    const el = document.querySelector(`.settings-content ${selector}`)
    if (el) el.value = value
  }
  document.querySelector('.settings-content [data-action="new-provider"]')?.click()
  await sleep(20)
  setField('[data-create="id"]', 'smoke-ui')
  setField('[data-create="name"]', 'Smoke UI Provider')
  setField('[data-create="baseURL"]', 'http://127.0.0.1:9/v1')
  document.querySelector('.settings-content [data-action="create-provider"]')?.click()
  const uiProviderCreated = await waitFor(() => backend.ctx.settings.get().providers['smoke-ui'] && !backend.ctx.settings.get().providers['smoke-ui'].deleted, { timeout: 3000 })
  check('可通过界面创建提供商', !!uiProviderCreated)
  const uiProviderSelected = await waitFor(() => {
    const el = document.querySelector('.settings-content [data-provider-id="smoke-ui"]')
    return el && el.classList.contains('active')
  }, { timeout: 3000 })
  check('新建提供商后自动选中', !!uiProviderSelected, '新提供商没有选中')
  document.querySelector('.settings-content [data-action="add-model"]')?.click()
  await sleep(20)
  setField('[data-new-model="id"]', 'smoke-ui-model')
  setField('[data-new-model="name"]', 'Smoke UI Model')
  document.querySelector('.settings-content [data-action="confirm-add-model"]')?.click()
  const uiModelCreated = await waitFor(
    () => backend.ctx.settings.get().providers['smoke-ui']?.models?.some(m => m.id === 'smoke-ui-model'),
    { timeout: 3000 },
  )
  check('可通过界面添加自定义模型', !!uiModelCreated)
  check('提供商列表项自带删除按钮', !!document.querySelector('.settings-content [data-provider-delete="smoke-ui"]'))
  document.querySelector('.settings-content [data-provider-delete="smoke-ui"]')?.click()
  await sleep(20)
  document.querySelector('#modalOk')?.click()
  const uiProviderDeleted = await waitFor(() => backend.ctx.settings.get().providers['smoke-ui']?.deleted === true, { timeout: 3000 })
  check('可通过界面删除提供商', !!uiProviderDeleted)

  settingsContainer.open('data')
  await sleep(120)
  const dataText = document.querySelector('.settings-content')?.textContent || ''
  check('数据页有数据目录设置', dataText.includes('当前数据目录') && dataText.includes('user_data'))
  check('数据页有输入框风格的路径与选择目录按钮', !!document.querySelector('[data-field="data-dir"]') && !!document.querySelector('[data-action="pick-dir"]'))
  check('数据页有导出 / 同步 / 清空操作', dataText.includes('导出全部会话') && dataText.includes('从后端重新同步') && dataText.includes('清空所有会话'))

  settingsContainer.open('network')
  await sleep(120)
  check('网络页可编辑全局代理', !!document.querySelector('.settings-content [data-field="proxy"]') && !!document.querySelector('.settings-content [data-action="save-network"]'))
  check('网络页可编辑后端地址', !!document.querySelector('.settings-content [data-field="backend-url"]'))

  settingsContainer.open('appearance')
  await sleep(30)
  check('外观页能看到气泡区块', !!document.querySelector('[data-bubble-section]'))
  check('外观页能看到背景区块', !!document.querySelector('[data-bg="bg-solid"]'))
  check('外观页有自定义背景图入口', !!document.querySelector('[data-bg-upload]'))
  check(
    '背景图片使用自定义文件选择器而不是原生控件',
    !!document.querySelector('.file-picker [data-bg-upload]') && !document.querySelector('.settings-content input.setting-input[type="file"]'),
  )
  const glassRange = document.querySelector('[data-glass-panel="chat-list"][data-glass-prop="alpha"]')
  check('外观页有每块玻璃板的完整属性滑块', !!glassRange && document.querySelectorAll('[data-glass-panel]').length >= 35, `实际 ${document.querySelectorAll('[data-glass-panel]').length}`)
  if (glassRange) {
    glassRange.value = '30'
    glassRange.dispatchEvent({ type: 'change' })
  }
  await sleep(40)
  check('玻璃板透明度写入 config', Number(ctx.inject('config').get('ui.glass.chatList.alpha')).toFixed(2) === '0.30', String(ctx.inject('config').get('ui.glass.chatList.alpha')))
  check(
    '玻璃板透明度映射为对应 CSS 变量',
    document.documentElement.style.getPropertyValue('--glass-chat-list-alpha') === '0.3',
    document.documentElement.style.getPropertyValue('--glass-chat-list-alpha'),
  )
  ctx.inject('config').set('ui.glass.chatList.blur', 4)
  document.querySelector('[data-glass-reset="all"]')?.click()
  await sleep(60)
  check(
    '恢复默认会重置全部玻璃板参数',
    Number(ctx.inject('config').get('ui.glass.chatList.alpha')).toFixed(2) === '0.55' &&
      Number(ctx.inject('config').get('ui.glass.chatList.blur')) === 22,
    JSON.stringify(ctx.inject('config').get('ui.glass.chatList')),
  )
  settingsView.close()
  await sleep(20)
  check('设置页可关闭', !settingsView.isOpen())

  section('⑩a 运行日志页')
  const logsRouter = ctx.inject('view-router')
  check('运行日志是独立视图而非设置页', logsRouter.has('logs') && logsRouter.get('logs')?.fullWidth === true)
  settingsView.close()
  logsRouter.switch('logs')
  await sleep(80)
  check('日志视图已激活且不打开设置浮层', logsRouter.active() === 'logs' && !settingsView.isOpen(), JSON.stringify({ active: logsRouter.active(), settingsOpen: settingsView.isOpen() }))
  check('运行日志页已注册并可打开', !!document.querySelector('.logs-list'))
  const logsRailBtn = document.getElementById('railLogsBtn')
  const settingsRailBtn = document.getElementById('railSettingsBtn')
  const railButtons = [...(settingsRailBtn?.parentNode?.childNodes || [])].filter(node => node.nodeType === 1)
  check(
    '侧栏有日志入口且位于设置按钮上方',
    !!logsRailBtn &&
      !!settingsRailBtn &&
      logsRailBtn.parentNode === settingsRailBtn.parentNode &&
      railButtons.indexOf(logsRailBtn) >= 0 &&
      railButtons.indexOf(logsRailBtn) < railButtons.indexOf(settingsRailBtn),
    JSON.stringify({
      logs: !!logsRailBtn,
      settings: !!settingsRailBtn,
      siblings: railButtons.map(el => el.id || el.tagName),
    }),
  )
  const levelInput = lvl => document.querySelector(`[data-logs-level="${lvl}"]`)
  check(
    '日志页默认只勾选“信息”，其它类型不勾选',
    levelInput('info')?.checked === true && ['error', 'warn', 'debug'].every(lvl => levelInput(lvl)?.checked === false),
    JSON.stringify([...document.querySelectorAll('[data-logs-level]')].map(input => ({ level: input.dataset.logsLevel, checked: input.checked }))),
  )
  check(
    '运行日志入口不再重复出现在设置导航',
    !document.querySelector('.settings-nav-item[data-page="logs"]'),
    String(!!document.querySelector('.settings-nav-item[data-page="logs"]')),
  )
  check('日志页有手动刷新按钮', !!document.querySelector('[data-logs-refresh]'))
  check('日志页有“有新日志”回到底部兜底按钮', !!document.querySelector('[data-logs-jump]'))
  check(
    '运行日志页有级别 / 分类 / 搜索控件',
    !!document.querySelector('[data-logs-level]') &&
      !!document.querySelector('[data-logs-cat]') &&
      !!document.querySelector('[data-logs-search]'),
  )
  check('运行日志页能显示已收集的日志', document.querySelectorAll('.logs-row').length > 0, String(document.querySelectorAll('.logs-row').length))

  // 自由勾选：info + debug 的组合应写入 config，并在页面重开后保持。
  const debugLevelInput = levelInput('debug')
  if (debugLevelInput) {
    debugLevelInput.checked = true
    debugLevelInput.dispatchEvent({ type: 'change' })
  }
  await sleep(40)
  check(
    '日志级别勾选组合会持久化',
    JSON.stringify(ctx.inject('config').get('logs.levels')) === JSON.stringify(['info', 'debug']),
    JSON.stringify(ctx.inject('config').get('logs.levels')),
  )
  logsRouter.switch('chat')
  await sleep(30)
  logsRouter.switch('logs')
  await sleep(60)
  check(
    '重新打开日志页仍保留勾选组合',
    levelInput('info')?.checked === true && levelInput('debug')?.checked === true && levelInput('warn')?.checked === false,
    JSON.stringify([...document.querySelectorAll('[data-logs-level]')].map(input => ({ level: input.dataset.logsLevel, checked: input.checked }))),
  )
  // 还原默认，避免后续断言受日志噪音影响。
  const debugLevelInputAfter = levelInput('debug')
  if (debugLevelInputAfter) {
    debugLevelInputAfter.checked = false
    debugLevelInputAfter.dispatchEvent({ type: 'change' })
  }
  await sleep(20)
  backend.ctx.logger.info('SMOKE_RUNTIME_LOG_LINE')
  await sleep(150)
  logsRouter.switch('chat')
  await sleep(30)
  logsRouter.switch('logs')
  const backendLogShown = await waitFor(() => document.querySelector('.logs-list')?.textContent?.includes('SMOKE_RUNTIME_LOG_LINE'), { timeout: 3000 })
  check('后端日志可进入运行日志页（历史拉取）', !!backendLogShown)
  const logTimeValue = text => {
    const match = String(text || '').trim().match(/^(\d{2}):(\d{2}):(\d{2})\.(\d{3})$/)
    return match ? Number(match[1]) * 3600000 + Number(match[2]) * 60000 + Number(match[3]) * 1000 + Number(match[4]) : -1
  }
  const logTimeValuesBeforeRefresh = [...document.querySelectorAll('.logs-list .logs-time')]
    .map(el => logTimeValue(el.textContent))
    .filter(value => value >= 0)
  check(
    '日志列表按时间顺序排列（历史回填 / 实时日志混排后仍稳定）',
    logTimeValuesBeforeRefresh.every((value, index) => !index || value >= logTimeValuesBeforeRefresh[index - 1]),
    logTimeValuesBeforeRefresh.slice(0, 8).join(' | '),
  )
  const logEntryCount = () => Number((document.querySelector('[data-logs-stats]')?.textContent || '').match(/(\d+)\s*条/)?.[1]) || 0
  const entriesBeforeRefresh = logEntryCount()
  backend.ctx.logger.info('SMOKE_LOG_REFRESH_BUTTON')
  await sleep(30)
  const refreshLogsBtn = document.querySelector('[data-logs-refresh]')
  refreshLogsBtn?.click()
  const refreshedLogShown = await waitFor(() => document.querySelector('.logs-list')?.textContent?.includes('SMOKE_LOG_REFRESH_BUTTON'), { timeout: 2000 })
  check(
    '日志页“刷新”按钮能立即重新拉取后端日志',
    !!refreshedLogShown,
    JSON.stringify({
      hasButton: !!refreshLogsBtn,
      attr: refreshLogsBtn?.hasAttribute?.('data-logs-refresh'),
      tail: String(document.querySelector('.logs-list')?.textContent || '').slice(-200),
    }),
  )
  const entriesAfterRefresh = logEntryCount()
  check(
    '日志刷新不会丢掉已有历史',
    entriesAfterRefresh >= entriesBeforeRefresh,
    `${entriesBeforeRefresh} -> ${entriesAfterRefresh}`,
  )

  // 访问日志噪音（HTTP POST /api/xxx → 200）不应出现在日志页。
  backend.ctx.logger.info('HTTP POST /api/smoke-noise → 200 · 1ms')
  await sleep(40)
  refreshLogsBtn?.click()
  await sleep(220)
  check(
    '日志页不展示 HTTP 访问日志噪音',
    !String(document.querySelector('.logs-list')?.textContent || '').includes('/api/smoke-noise'),
    String(document.querySelector('.logs-list')?.textContent || '').slice(-200),
  )
  logsRouter.switch('chat')
  await sleep(30)

  section('⑩a-2 记忆与知识库页')
  const libraryRouter = ctx.inject('view-router')
  check('记忆与知识库是独立视图', libraryRouter.has('library') && libraryRouter.get('library')?.fullWidth === true && libraryRouter.get('library')?.lazy === true)
  settingsView.close()
  libraryRouter.switch('library')
  await sleep(120)
  check('记忆与知识库页已注册并可打开', !!document.querySelector('.lib-page') && !!document.querySelector('[data-lib-tab="memory"]'))
  check('侧栏出现记忆与知识库入口', !!document.querySelector('.rail-btn[data-view="library"]'))
  check('记忆库标签默认激活并渲染工具栏', !!document.querySelector('[data-lib-memory-role]') && !!document.querySelector('[data-lib-memory-list]'))
  const libraryWrapper = document.querySelector('.main-view[data-view="library"]')
  const nowIso = new Date().toISOString()
  const smokeMemory = await backend.ctx.memories.ingest({
    roleId: 'role-smoke-memory',
    memoryScope: 'normal',
    channelId: 'napcat:smoke',
    conversationId: 'conv-smoke',
    sourceGroup: 'group',
    everyRounds: 2,
    summaryProvider: 'smoke',
    summaryModel: 'smoke-1',
    rounds: [
      {
        id: 'round:smoke-1',
        channel_id: 'napcat:smoke',
        conversation_id: 'conv-smoke',
        source_group: 'group',
        messages: [
          { message_id: 'smoke-m1', seq: 1, role: 'user', content: '冒烟记忆：我早上习惯喝咖啡', sender_name: '测试用户', timestamp: nowIso },
          { message_id: 'smoke-m2', seq: 2, role: 'assistant', content: '好的，我记住了。', sender_name: '念风', timestamp: nowIso },
        ],
      },
      {
        id: 'round:smoke-2',
        channel_id: 'napcat:smoke',
        conversation_id: 'conv-smoke',
        source_group: 'group',
        messages: [
          { message_id: 'smoke-m3', seq: 3, role: 'user', content: '再记一条：周末想去图书馆', sender_name: '测试用户', timestamp: nowIso },
          { message_id: 'smoke-m4', seq: 4, role: 'assistant', content: '记下了。', sender_name: '念风', timestamp: nowIso },
        ],
      },
    ],
  })
  check('记忆库后端能为冒烟数据生成概括条目', smokeMemory?.ok !== false && Number(smokeMemory?.created) >= 1, JSON.stringify(smokeMemory).slice(0, 240))
  const smokeMemoryId = String(smokeMemory?.summaries?.[0]?.id || '')
  const findSmokeMemoryCardById = () =>
    [...document.querySelectorAll('[data-lib-memory-card]')].find(
      card => !smokeMemoryId || card.getAttribute('data-lib-memory-card') === smokeMemoryId,
    ) || null
  const findSmokeMemoryCard = () => findSmokeMemoryCardById() || document.querySelector('[data-lib-memory-card]')
  const memoryRefresh = document.querySelector('[data-lib-memory-refresh]')
  libraryWrapper?.dispatchEvent({ type: 'click', target: memoryRefresh })
  await waitFor(() => document.querySelectorAll('[data-lib-memory-card]').length > 0, { timeout: 4000 })
  check('记忆库页面能列出已有记忆条目', document.querySelectorAll('[data-lib-memory-card]').length > 0)
  // 刷新的列表接口是异步的：等目标记忆卡片真正出现，避免点到更早自动生成的其它卡片。
  await waitFor(() => findSmokeMemoryCardById(), { timeout: 4000 })
  const memoryToggle =
    findSmokeMemoryCard()?.querySelector('[data-lib-memory-toggle]') || document.querySelector('[data-lib-memory-toggle]')
  libraryWrapper?.dispatchEvent({ type: 'click', target: memoryToggle })
  await waitFor(() => findSmokeMemoryCard()?.querySelector('.lib-message-body'), { timeout: 4000 })
  check(
    '展开记忆条目能看到条目对应的消息原文',
    String(findSmokeMemoryCard()?.querySelector('.lib-message-body')?.textContent || '').includes('咖啡'),
    String(findSmokeMemoryCard()?.querySelector('.lib-message-body')?.textContent || '').slice(0, 120),
  )
  // 回归 bug3：记忆库卡片曾用 shortText 截断到 220 字，导致长概括在列表里只剩前半段。
  const longSummaryTail = 'LONG_SUMMARY_SMOKE_TAIL'
  const longMemoryRounds = [
    {
      id: 'round:smoke-long-1',
      channel_id: 'napcat:smoke-long-summary',
      conversation_id: 'conv-smoke-long-summary',
      source_group: 'private',
      messages: [
        {
          message_id: 'smoke-long-m1',
          seq: 1,
          role: 'user',
          content: `LONG_SUMMARY_SMOKE_MARKER 请生成一条长概括`,
          sender_name: '测试用户',
          timestamp: nowIso,
        },
        { message_id: 'smoke-long-m2', seq: 2, role: 'assistant', content: '好的。', sender_name: '长概括测试角色', timestamp: nowIso },
      ],
    },
    {
      id: 'round:smoke-long-2',
      channel_id: 'napcat:smoke-long-summary',
      conversation_id: 'conv-smoke-long-summary',
      source_group: 'private',
      messages: [
        { message_id: 'smoke-long-m3', seq: 3, role: 'user', content: '继续。', sender_name: '测试用户', timestamp: nowIso },
        { message_id: 'smoke-long-m4', seq: 4, role: 'assistant', content: '好的。', sender_name: '长概括测试角色', timestamp: nowIso },
      ],
    },
  ]
  const longMemory = await backend.ctx.memories.ingest({
    roleId: 'role-smoke-long-summary',
    roleName: '长概括测试角色',
    memoryScope: 'normal',
    channelId: 'napcat:smoke-long-summary',
    conversationId: 'conv-smoke-long-summary',
    sourceGroup: 'private',
    mode: 'round',
    windowSize: 0,
    everyRounds: 2,
    summaryProvider: 'smoke',
    summaryModel: 'smoke-1',
    rounds: longMemoryRounds,
  })
  check(
    '后端完整保存长概括（不按 600 字硬切）',
    longMemory?.created === 1 &&
      String(longMemory?.summaries?.[0]?.summary || '').includes(longSummaryTail) &&
      String(longMemory?.summaries?.[0]?.summary || '').length > 220,
    JSON.stringify(longMemory).slice(0, 240),
  )
  libraryWrapper?.dispatchEvent({ type: 'click', target: memoryRefresh })
  const longMemoryCard = await waitFor(
    () =>
      [...document.querySelectorAll('[data-lib-memory-card]')].find(card =>
        String(card.querySelector('.lib-card-title')?.textContent || '').includes(longSummaryTail),
      ) || null,
    { timeout: 4000 },
  )
  check(
    '记忆库卡片完整展示长概括，不再截断成半截',
    !!longMemoryCard && String(longMemoryCard.querySelector('.lib-card-title')?.textContent || '').length > 220,
    String(longMemoryCard?.querySelector('.lib-card-title')?.textContent || '').slice(-80),
  )
  const smokeWindowMessages = ids =>
    ids.map((id, index) => ({
      message_id: id,
      seq: index + 1,
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `群聊窗口消息 ${id}`,
      sender_name: index % 2 === 0 ? '群成员' : '念风',
      timestamp: nowIso,
    }))
  const baseWindowIds = Array.from({ length: 20 }, (_, index) => `smoke-window-${index + 1}`)
  const ingestSmokeWindow = (ids, roundId) =>
    backend.ctx.memories.ingest({
      roleId: 'role-smoke-window',
      roleName: '群聊测试角色',
      memoryScope: 'normal',
      channelId: 'napcat:smoke-window',
      conversationId: 'conv-smoke-window',
      sourceGroup: 'group',
      mode: 'window',
      windowSize: 20,
      minNewMessages: 5,
      summaryProvider: 'smoke',
      summaryModel: 'smoke-1',
      rounds: [
        {
          id: roundId,
          channel_id: 'napcat:smoke-window',
          source_group: 'group',
          messages: smokeWindowMessages(ids),
        },
      ],
    })
  const windowFirst = await ingestSmokeWindow(baseWindowIds, 'window:smoke-window:20')
  check(
    '群聊窗口记忆：20 条全新消息会生成概括',
    windowFirst?.ok !== false && windowFirst?.created === 1 && windowFirst?.mode === 'window',
    JSON.stringify(windowFirst).slice(0, 240),
  )
  const shortWindow = await ingestSmokeWindow(baseWindowIds.slice(0, 19), 'window:smoke-window:19')
  check(
    '群聊窗口记忆：不足 20 条先等待',
    shortWindow?.skipped === true && shortWindow?.reason === 'window-not-full',
    JSON.stringify(shortWindow).slice(0, 240),
  )
  const windowRepeated = await ingestSmokeWindow(baseWindowIds, 'window:smoke-window:20')
  check(
    '群聊窗口记忆：重复 20 条会跳过',
    windowRepeated?.skipped === true && windowRepeated?.duplicate_count === 20,
    JSON.stringify(windowRepeated).slice(0, 240),
  )
  const shiftedWindowIds = [
    ...baseWindowIds.slice(5),
    'smoke-window-new-1',
    'smoke-window-new-2',
    'smoke-window-new-3',
    'smoke-window-new-4',
    'smoke-window-new-5',
  ]
  const windowShifted = await ingestSmokeWindow(shiftedWindowIds, 'window:smoke-window:25')
  check(
    '群聊窗口记忆：15 条重复 + 5 条新消息会总结',
    windowShifted?.created === 1 && windowShifted?.duplicate_count === 15,
    JSON.stringify(windowShifted).slice(0, 240),
  )
  const mostlyRepeatedWindowIds = [
    ...baseWindowIds.slice(4),
    'smoke-window-extra-1',
    'smoke-window-extra-2',
    'smoke-window-extra-3',
    'smoke-window-extra-4',
  ]
  const windowMostlyRepeated = await ingestSmokeWindow(mostlyRepeatedWindowIds, 'window:smoke-window:24')
  check(
    '群聊窗口记忆：重复超过 15 条会跳过',
    windowMostlyRepeated?.skipped === true && windowMostlyRepeated?.duplicate_count === 16,
    JSON.stringify(windowMostlyRepeated).slice(0, 240),
  )
  // 回归：私聊 / 隐私的 windowSize=0 曾被 clamp 成最小 2，错误进入群聊窗口模式，
  // 结果每 1 轮（2 条消息）就生成一条“群里”措辞的概括。这里锁死按轮次概括路径。
  const privateRounds = [
    {
      id: 'round:smoke-private-1',
      channel_id: 'napcat:smoke-private',
      conversation_id: 'conv-smoke-private',
      source_group: 'private',
      messages: [
        { message_id: 'smoke-private-m1', seq: 1, role: 'user', content: '私聊冒烟：明天要去看牙医', sender_name: '测试用户', timestamp: nowIso },
        { message_id: 'smoke-private-m2', seq: 2, role: 'assistant', content: '好的，我记下了。', sender_name: '私聊测试角色', timestamp: nowIso },
      ],
    },
    {
      id: 'round:smoke-private-2',
      channel_id: 'napcat:smoke-private',
      conversation_id: 'conv-smoke-private',
      source_group: 'private',
      messages: [
        { message_id: 'smoke-private-m3', seq: 3, role: 'user', content: '私聊冒烟：记得提醒我带医保卡', sender_name: '测试用户', timestamp: nowIso },
        { message_id: 'smoke-private-m4', seq: 4, role: 'assistant', content: '没问题。', sender_name: '私聊测试角色', timestamp: nowIso },
      ],
    },
  ]
  const privateIngest = await backend.ctx.memories.ingest({
    roleId: 'role-smoke-private',
    roleName: '私聊测试角色',
    memoryScope: 'normal',
    channelId: 'napcat:smoke-private',
    conversationId: 'conv-smoke-private',
    sourceGroup: 'private',
    mode: 'round',
    windowSize: 0,
    everyRounds: 2,
    summaryProvider: 'smoke',
    summaryModel: 'smoke-1',
    rounds: privateRounds,
  })
  check(
    '私聊记忆 windowSize=0 不会误入群聊窗口模式',
    privateIngest?.ok === true && privateIngest?.mode === undefined && privateIngest?.summaries?.[0]?.source?.group === 'private',
    JSON.stringify(privateIngest).slice(0, 240),
  )
  check(
    '私聊记忆按 everyRounds=2 合并为一条 2 轮 / 4 条',
    privateIngest?.created === 1 &&
      privateIngest?.summaries?.[0]?.round_count === 2 &&
      privateIngest?.summaries?.[0]?.message_count === 4,
    JSON.stringify(privateIngest).slice(0, 240),
  )
  // 逐渠道关闭后，服务端也必须兜底拒绝写入（旧前端 / 其它调用方同样不能绕过）。
  await backend.ctx.settings.update({
    preferences: { memory: { groupSummaryDisabled: { 'napcat:smoke-group-off': true } } },
  })
  const disabledGroupIngest = await backend.ctx.memories.ingest({
    roleId: 'role-smoke-group-off',
    roleName: '群聊关闭测试角色',
    memoryScope: 'normal',
    channelId: 'napcat:smoke-group-off',
    conversationId: 'conv-smoke-group-off',
    sourceGroup: 'group',
    windowSize: 20,
    summaryProvider: 'smoke',
    summaryModel: 'smoke-1',
    rounds: [
      {
        id: 'round:smoke-group-off-1',
        channel_id: 'napcat:smoke-group-off',
        source_group: 'group',
        messages: [
          { message_id: 'smoke-group-off-m1', seq: 1, role: 'user', content: '这个群的记忆应该被关闭', sender_name: '群成员', timestamp: nowIso },
          { message_id: 'smoke-group-off-m2', seq: 2, role: 'assistant', content: '不会写入。', sender_name: '群聊关闭测试角色', timestamp: nowIso },
        ],
      },
    ],
  })
  check(
    '群聊渠道关闭记忆总结后绝不生成新记忆',
    disabledGroupIngest?.ok === true && disabledGroupIngest?.skipped === true && disabledGroupIngest?.reason === 'group-summary-disabled',
    JSON.stringify(disabledGroupIngest).slice(0, 240),
  )
  await backend.ctx.settings.update({
    preferences: { memory: { groupSummaryDisabled: { 'napcat:smoke-group-off': false } } },
  })
  // 知识库扩展不在内置插件里，冒烟通过替换 api.get 的 /knowledge 返回，
  // 验证知识库标签页的列表 / 全文渲染逻辑；真实 bridge 路由由后端测试和
  // 扩展自身测试覆盖。
  const apiService = ctx.registry.get('api')
  const originalGet = apiService.get.bind(apiService)
  const smokeKnowledgeEntry = {
    id: 'kb-smoke',
    path: '冒烟/知识',
    title: '冒烟知识条目',
    tags: ['冒烟', '测试'],
    revision: 2,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    content_length: 24,
    preview: '这是知识库冒烟预览。',
    embedded: false,
  }
  apiService.get = async (path, options) => {
    if (path.startsWith('/knowledge/entries?')) {
      return { ok: true, total: 1, offset: 0, limit: 20, returned: 1, entries: [smokeKnowledgeEntry] }
    }
    if (path === '/knowledge/entries/kb-smoke') {
      return {
        ok: true,
        entry: {
          ...smokeKnowledgeEntry,
          content: '这是知识库冒烟全文，包含端到端关键词。',
          history: [{ revision: 1, title: '冒烟知识条目', path: '冒烟/知识', content_length: 12, updated_at: new Date().toISOString(), reason: '首次写入' }],
        },
      }
    }
    return originalGet(path, options)
  }
  const knowledgeTab = document.querySelector('[data-lib-tab="knowledge"]')
  libraryWrapper?.dispatchEvent({ type: 'click', target: knowledgeTab })
  await waitFor(() => document.querySelectorAll('[data-lib-knowledge-card]').length > 0, { timeout: 4000 })
  check('知识库标签页能渲染条目列表', document.querySelectorAll('[data-lib-knowledge-card]').length === 1)
  const knowledgeToggle = document.querySelector('[data-lib-knowledge-toggle]')
  libraryWrapper?.dispatchEvent({ type: 'click', target: knowledgeToggle })
  await waitFor(() => document.querySelector('[data-lib-knowledge-card] .lib-content'), { timeout: 4000 })
  check(
    '展开知识条目能看到全文、标签与历史版本',
    String(document.querySelector('[data-lib-knowledge-card] .lib-content')?.textContent || '').includes('端到端关键词') &&
      String(document.querySelector('[data-lib-knowledge-card] .lib-card-detail')?.textContent || '').includes('冒烟') &&
      String(document.querySelector('[data-lib-knowledge-card] .lib-history')?.textContent || '').includes('首次写入'),
    String(document.querySelector('[data-lib-knowledge-card] .lib-card-detail')?.textContent || '').slice(0, 180),
  )
  apiService.get = originalGet
  const memoryTab = document.querySelector('[data-lib-tab="memory"]')
  libraryWrapper?.dispatchEvent({ type: 'click', target: memoryTab })
  await sleep(120)
  check(
    '记忆库页面没有错误提示',
    !!document.querySelector('[data-lib-memory-list]') && !document.querySelector('[data-lib-memory-list] .lib-error'),
    String(document.querySelector('[data-lib-memory-list]')?.innerHTML || '').slice(0, 160),
  )
  libraryRouter.switch('chat')
  await sleep(30)

  section('⑩b 捏人窗口与插件权限')
  const characterSessions = ctx.inject('session-service')
  const charCountBefore = characterSessions.count()
  document.getElementById('newConvBtn')?.click()
  await waitFor(() => document.querySelector('.char-dialog'), { timeout: 2000 })
  check('新建会话弹出捏人窗口', !!document.querySelector('.char-dialog'))
  const nameField = document.querySelector('.char-name')
  if (nameField) nameField.value = '冒烟角色'
  const personaField = document.querySelector('.char-persona')
  if (personaField) personaField.value = '你是冒烟测试人格，请简短回答。'
  document.querySelector('[data-char-save]')?.click()
  const characterConv = await waitFor(
    () => characterSessions.list().find(item => item.name === '冒烟角色'),
    { timeout: 3000 },
  )
  check(
    '捏人窗口创建会话并写入人格',
    characterSessions.count() === charCountBefore + 1 && characterConv?.meta?.persona?.includes('冒烟测试人格'),
    JSON.stringify(characterConv?.meta),
  )
  check('角色模型默认可跟随全局', !characterConv?.meta?.model)

  document.getElementById('chatMoreBtn')?.click()
  await sleep(40)
  const editRoleItem = [...document.querySelectorAll('.context-menu .menu-item')].find(el => (el.textContent || '').includes('编辑角色'))
  check('会话头部菜单有「编辑角色」', !!editRoleItem)
  check('会话头部菜单已分组', document.querySelectorAll('.context-menu .menu-group').length >= 3)
  check('会话列表有删除按钮', !!document.querySelector('[data-conv-delete]'))
  editRoleItem?.click()
  const editDialog = await waitFor(() => document.querySelector('.char-dialog'), { timeout: 2000 })
  const personaShown = editDialog?.querySelector('.char-persona')
  check('编辑窗口带出原人格', String(personaShown?.value || personaShown?.textContent || '').includes('冒烟测试人格'))
  document.querySelector('[data-char-cancel]')?.click()
  check('角色编辑窗口可关闭', !document.querySelector('.char-dialog'))

  // 验证 chat-flow 真的把人设与生成参数传给了 model-service
  const modelService = ctx.inject('model-service')
  const originalStream = modelService.stream
  let captured = null
  modelService.stream = function (modelMessages, options, callbacks) {
    captured = { messages: JSON.parse(JSON.stringify(modelMessages)), options: { ...options } }
    return originalStream.call(this, modelMessages, options, callbacks)
  }
  messages.requestSend(characterConv.id, '验证人设注入')
  await waitFor(() => captured, { timeout: 3000 })
  modelService.stream = originalStream
  await sleep(200)
  check(
    'chat-flow 注入人设 system 段落',
    captured?.messages?.[0]?.role === 'system' && captured.messages[0].content.includes('冒烟测试人格'),
    JSON.stringify(captured?.messages?.[0] || null),
  )
  check(
    'chat-flow 传递独立的推理等级与 temperature',
    captured?.options?.reasoningEffort === 'off' && Number(captured?.options?.temperature) === 1 && captured?.options?.preferModelParams === true,
    JSON.stringify(captured?.options || {}),
  )

  // 停止生成：stub 一个永不结束的流，验证 composer 停止按钮与 chat-flow.abort
  await waitFor(() => !ctx.inject('chat-flow')?.isRunning(characterConv.id), { timeout: 3000 })
  let abortCalled = false
  modelService.stream = function (modelMessages, options, callbacks) {
    callbacks.onStart?.({})
    return {
      abort() {
        abortCalled = true
      },
    }
  }
  messages.requestSend(characterConv.id, '测试停止生成')
  // requestSend 里的会话写入 / 事件派发现在是异步的：等 chat:request-start
  // 真正到达 composer 后再点停止，避免测试抢先于产品事件。
  const stopButton = await waitFor(
    () => {
      const button = document.getElementById('stopBtn')
      return button?.classList.contains('show') ? button : null
    },
    { timeout: 3000 },
  )
  const stopShown = !!stopButton
  stopButton?.click()
  await sleep(80)
  modelService.stream = originalStream
  const cancelledMessage = [...sessions.messages(characterConv.id)].reverse().find(item => item.role === 'assistant')
  check('生成过程中出现停止按钮', stopShown)
  check('停止生成会取消请求并结束占位消息', abortCalled && cancelledMessage?.error === '请求已取消', JSON.stringify(cancelledMessage || null))

  const permissions = ctx.inject('permissions')
  check('权限预设有三个', permissions.presets().length === 3)
  const fakeApi = { health: () => 'ok', baseUrl: () => '/api' }
  const guardedApi = permissions.guardService(
    { name: 'settings-item-network', displayName: '网络', core: false, permissions: ['network'] },
    'api',
    fakeApi,
  )
  check('已声明权限的插件拿到活代理', guardedApi !== fakeApi)
  permissions.setPreset('read-only')
  let denied = false
  try {
    guardedApi.health()
  } catch (err) {
    denied = err.code === 'PLUGIN_PERMISSION_DENIED'
  }
  check('只读预设拒绝非核心插件 network', denied && permissions.isGranted('settings-item-network', 'network') === false)
  check('core 插件权限豁免', permissions.isGranted('chat-flow', 'network') === true)
  permissions.setPreset('standard')
  check('改回标准预设立即恢复', guardedApi.health() === 'ok' && permissions.isGranted('settings-item-network', 'network') === true)

  section('⑪ 搜索 / 导出 / 日志')
  const search = ctx.inject('search-service')
  const result = search.search('冒烟测试')
  check('搜索能命中会话', result.total > 0 && !!result.groups.conversation, JSON.stringify(Object.keys(result.groups)))
  check('搜索能命中插件', search.search('bubble').total > 0)
  const exportService = ctx.inject('export-service')
  const md = exportService.toMarkdown(sessions.get(conv.id))
  check('导出 Markdown 内容正常', md.includes('# 冒烟测试会话') && md.includes('本地后端'))
  const allHtml = exportService.toAllHtml(sessions.list())
  check(
    '导出全部会话 HTML 保留每个会话标题',
    allHtml.includes('冒烟测试会话') && allHtml.includes('冒烟角色') && allHtml.includes('conv-block'),
    allHtml.slice(0, 120),
  )
  check('导出 JSON 数据完整', JSON.stringify(sessions.list()).length > 500)
  check('日志服务有历史记录', ctx.inject('logs').history().length > 5)

  // 搜索结果必须能“真正打开”目标，而不只是让 UI 看起来变了
  const conversationHit = result.groups.conversation?.[0]
  sessions.activate(null)
  search.run(conversationHit)
  await sleep(30)
  check('搜索会话结果会真正激活会话', !!conversationHit && sessions.activeId() === conversationHit.id, String(sessions.activeId()))
  const channelHit = search.search('测试渠道').groups.channel?.[0]
  channelRegistry.activate(null)
  search.run(channelHit)
  await sleep(30)
  check(
    '搜索渠道结果会真正激活渠道',
    !!channelHit && channelRegistry.activeKey() === `private:${channelHit.id}`,
    String(channelRegistry.activeKey()),
  )

  // Markdown 代码块（曾经会被二次转义成 &lt;pre&gt; 纯文本）
  const markdownHtml = ctx.inject('markdown').render('before\n\n```js\nconst a = 1 < 2 && "x"\n```\n\nafter **bold**')
  check(
    'Markdown 代码块渲染为 pre，而不是被转义的文本',
    markdownHtml.includes('<pre class="code md-code"') && markdownHtml.includes('<strong>bold</strong>') && !markdownHtml.includes('&lt;pre'),
    markdownHtml.slice(0, 120),
  )

  section('⑫ 样式完整性')
  const styles = document.head.children.filter(c => c.nodeName === 'STYLE')
  check('各插件样式均已注入（≥ 15 个）', styles.length >= 15, `实际 ${styles.length}`)
  const pluginNames = new Set(styles.map(s => s.getAttribute('data-plugin')))
  for (const name of ['app-shell', 'theme-tokens', 'session-list', 'channel-list', 'settings-item-plugins', 'bubble-default', 'composer']) {
    check(`样式来自插件 ${name}`, pluginNames.has(name))
  }
  const sessionStyleText = styles.find(s => s.getAttribute('data-plugin') === 'session-list')?.textContent || ''
  check('紧凑模式会隐藏会话行删除按钮（避免压住头像）', sessionStyleText.includes('.list-pane.compact .conv-del'))
  check(
    '批量工具条 [hidden] 会真正隐藏（避免没进批量模式也显示一排按钮）',
    sessionStyleText.includes('.batch-bar[hidden]{display:none'),
    sessionStyleText.slice(0, 120),
  )
  check('全局搜索插件已注入样式', pluginNames.has('global-search'))
  {
    const { MOBILE_SHELL_CSS } = await import('../plugins/shell/mobile-shell/style.mjs')
    check(
      '手机端 app-main 使用全宽单列（避免 0px rail 列把会话 / 渠道压成空白）',
      /\.app-main\{[^}]*grid-template-columns:minmax\(0,1fr\)/.test(MOBILE_SHELL_CSS) &&
        !/\.app-main\{[^}]*grid-template-columns:0 minmax\(0,1fr\)/.test(MOBILE_SHELL_CSS),
    )
    check(
      '手机端 app 使用单行布局（避免 app-main 落进 0px 高标题栏行）',
      /\.app\{[^}]*grid-template-rows:minmax\(0,1fr\)/.test(MOBILE_SHELL_CSS) && !/\.app\{[^}]*grid-template-rows:0 1fr/.test(MOBILE_SHELL_CSS),
    )
    check(
      '手机端设置项重置桌面 flex-basis（避免 150/240px 变成高度撑出大片空白）',
      /\.setting-control\{[^}]*flex:0 0 auto !important/.test(MOBILE_SHELL_CSS) &&
        /\.model-provider-main \.setting-main,[^{]*\{[^}]*flex:0 0 auto !important/.test(MOBILE_SHELL_CSS),
    )
    check(
      '手机端模型页提供商改成横向可滑动选择条（避免占满首屏）',
      /\.model-provider-list\{[^}]*flex-direction:row/.test(MOBILE_SHELL_CSS),
    )
  }

  const globalSearch = ctx.inject('global-search')
  check('侧栏有全局搜索入口', !!document.getElementById('globalSearchBtn'))
  globalSearch.open()
  await sleep(20)
  const globalSearchInput = document.getElementById('globalSearchInput')
  if (globalSearchInput) {
    globalSearchInput.value = '冒烟测试'
    globalSearchInput.dispatchEvent({ type: 'input' })
  }
  await sleep(180)
  check('全局搜索能渲染分组结果', document.querySelectorAll('.gsearch-item').length >= 1, `实际 ${document.querySelectorAll('.gsearch-item').length}`)
  document.querySelector('.gsearch-item')?.click()
  await sleep(30)
  check('点击搜索结果后搜索浮层会关闭', !document.querySelector('.gsearch-mask.show'))

  section('⑬ 交互组件')
  const toast = ctx.inject('toast')
  const menu = ctx.inject('context-menu')
  const modal = ctx.inject('modal')
  toast.success('冒烟测试提示')
  await sleep(30)
  check('toast 能渲染', !!document.querySelector('.toast-wrap .toast-success'))
  menu.open(100, 100, [{ label: '测试项', action() {} }, { separator: true }, { label: '禁用项', disabled: true }])
  check('右键菜单能渲染', document.querySelectorAll('.context-menu .menu-item').length === 2 && !!document.querySelector('.context-menu.show'))
  menu.close()
  const opened = modal.open({ title: '测试弹窗', description: '描述', input: true, value: 'abc', requireValue: true })
  await sleep(20)
  check('弹窗能渲染', !!document.querySelector('#modalMask.show') && document.querySelector('#modalTitle').textContent === '测试弹窗')
  document.querySelector('#modalCancel').click()
  check('弹窗取消正常返回', (await opened).ok === false)
  const shortcuts = ctx.inject('shortcuts')
  const shortcutList = shortcuts.list().map(s => s.combo)
  check('快捷键已注册（Ctrl+K / Ctrl+N）', shortcutList.includes('Ctrl+K') && shortcutList.includes('Ctrl+N'), shortcutList.join(','))
  check(
    '全局搜索 / 视图切换快捷键已注册',
    shortcutList.includes('Ctrl+Shift+F') && shortcutList.includes('Ctrl+1'),
    shortcutList.join(','),
  )
  ctx.inject('notification').notify({ title: '通知测试', body: '正文', level: 'info' })
  await sleep(20)
  check('通知中心渲染通知卡片', !!document.querySelector('.notify-center .notify-card'))
  ctx.inject('notification').clear?.()

  section('⑬b 插件自检与错误高亮')
  const pagesApi = ctx.inject('settings-container')
  pagesApi.open('plugins')
  await sleep(60)
  const healthyIssues = manager.selfCheck()
  check('自检返回问题数组', Array.isArray(healthyIssues))
  check('健康启动时没有 error 级问题', healthyIssues.filter(i => i.severity === 'error').length === 0, JSON.stringify(healthyIssues.slice(0, 3)))
  check('插件页有状态汇总', document.querySelectorAll('[data-plugin-summary] .plugin-chip').length >= 4)
  check('插件页渲染出插件条目', document.querySelectorAll('#pluginListContainer .plugin-item').length >= 20)

  // 注入一个"错误插件"，验证标红与原因展示
  const victim = loader.get('markdown-enhancer')
  const snapshot = { status: victim.status, reason: victim.reason, error: victim.error, conflict: victim.conflict }
  victim.status = 'error'
  victim.reason = '冒烟测试注入的错误原因'
  victim.error = new Error('冒烟测试注入的错误原因')
  pagesApi.open('plugins')
  await sleep(40)
  const errorItem = document.querySelector('#pluginListContainer .plugin-item.error')
  check('错误插件被标红', !!errorItem, '未找到 .plugin-item.error')
  check('错误插件显示了原因', (errorItem?.textContent || '').includes('冒烟测试注入的错误原因'), errorItem?.textContent?.slice(0, 80))

  // 注入一个"冲突插件"，验证标红与冲突原因
  victim.status = 'inactive'
  victim.conflict = true
  victim.reason = '服务「storage」已被插件「storage」占用（冒烟测试）'
  pagesApi.open('plugins')
  await sleep(40)
  const conflictItem = document.querySelector('#pluginListContainer .plugin-item.error')
  check('冲突插件被标红', !!conflictItem, '未找到冲突高亮')
  check('冲突插件显示了原因', (conflictItem?.textContent || '').includes('已被插件'), conflictItem?.textContent?.slice(0, 80))

  Object.assign(victim, snapshot)
  pagesApi.open('plugins')
  await sleep(40)
  check('恢复后不再有标红插件', !document.querySelector('#pluginListContainer .plugin-item.error'))
  await sleep(10)

  section('⑭ 错误与告警')
  console.log(`  插件告警 ${loader.warnings.length} 条`)
  for (const w of loader.warnings.slice(0, 6)) console.log(`    · [${w.severity}] ${w.id}: ${w.message}`)
  check('无 error 日志中的致命异常', loader.list().filter(r => r.status === 'error').length === 0)

  section('⑮ 收尾')
  await backend.close()
  await rm(dataDir, { recursive: true, force: true }).catch(() => {})
  check('后端已关闭', true)

  section('结果')
  console.log(`  ${results.length - failed}/${results.length} 项通过`)
  if (failed) {
    console.log('\n失败项：')
    for (const r of results.filter(r => !r.ok)) console.log(`  ✗ ${r.name} ${r.detail || ''}`)
  }
  process.exit(failed ? 1 : 0)
}

main().catch(err => {
  console.error('\n冒烟测试异常终止：')
  console.error(err)
  process.exit(1)
})
