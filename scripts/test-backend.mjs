/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * 后端 API 冒烟测试（真实 HTTP 调用，临时数据目录）
 * 用法：npm run test:backend
 */
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startBackend } from '../server/index.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const dataDir = join(ROOT, '.tmp', `backend-test-${Date.now()}`)

let failed = 0
const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
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
  console.log('\n① 启动后端')
  let backend = await startBackend({ port: 0, host: '127.0.0.1', dataDir })
  const base = backend.url
  check('后端监听成功', backend.port > 0, JSON.stringify({ port: backend.port, url: backend.url }))

  console.log('\n② 健康检查')
  const health = await (await api(base, '/api/health')).json()
  check('返回 ok', health.ok === true)
  check('上报 providers（3 个内置类型）', health.providers?.length === 3, JSON.stringify(health.providers))
  check('上报 cordis 运行时', health.runtime === 'cordis v4', health.runtime)
  check('上报数据目录', !!health.dataDir)
  check('health 声明最新能力列表', Array.isArray(health.capabilities) && health.capabilities.includes('data-dir') && health.capabilities.includes('provider-crud'))

  console.log('\n③ 配置读写（真实文件）')
  const config = await (await api(base, '/api/config')).json()
  check('默认 provider 含 openai/ollama/anthropic', !!config.providers?.openai && !!config.providers?.ollama && !!config.providers?.anthropic)
  check('API Key 默认脱敏为空', config.providers.openai.apiKey === '')
  await api(base, '/api/config', { method: 'PUT', body: { network: { timeoutMs: 12345 } } })
  const config2 = await (await api(base, '/api/config')).json()
  check('配置写入生效', config2.network.timeoutMs === 12345)
  await api(base, '/api/config', { method: 'PUT', body: { network: { timeoutMs: 60000 } } })

  console.log('\n③b 多端偏好同步（手机 / 电脑实时一致）')
  const highAt = Date.now()
  await api(base, '/api/config', {
    method: 'PUT',
    body: {
      preferences: { chat: { reasoningEffort: 'high', temperature: 1 } },
      preferencesMeta: { 'chat.reasoningEffort': { at: highAt, by: 'desktop' }, 'chat.temperature': { at: highAt, by: 'desktop' } },
    },
  })
  let syncedConfig = await (await api(base, '/api/config')).json()
  check(
    '推理等级写入共享偏好（high）',
    syncedConfig.preferences?.chat?.reasoningEffort === 'high',
    JSON.stringify(syncedConfig.preferences?.chat),
  )
  check('返回 per-key 更新时间戳', Number(syncedConfig.preferencesMeta?.['chat.reasoningEffort']?.at) === highAt, JSON.stringify(syncedConfig.preferencesMeta))
  // 模拟手机上仍是旧值的页面在稍后整包推送：旧时间戳不能覆盖电脑端刚改的 high。
  await api(base, '/api/config', {
    method: 'PUT',
    body: {
      preferences: { chat: { reasoningEffort: 'off', temperature: 1 } },
      preferencesMeta: { 'chat.reasoningEffort': { at: highAt - 1000, by: 'mobile-stale' } },
    },
  })
  syncedConfig = await (await api(base, '/api/config')).json()
  check(
    '旧页面整包推送不会覆盖更新的设置',
    syncedConfig.preferences?.chat?.reasoningEffort === 'high',
    JSON.stringify(syncedConfig.preferences?.chat),
  )
  // 连 preferencesMeta 都没有的旧版本页面（升级前缓存）整包推送，也不能顶掉新值。
  await api(base, '/api/config', { method: 'PUT', body: { preferences: { chat: { reasoningEffort: 'off', temperature: 1 } } } })
  syncedConfig = await (await api(base, '/api/config')).json()
  check(
    '旧版本无时间戳的整包推送不会覆盖新值',
    syncedConfig.preferences?.chat?.reasoningEffort === 'high',
    JSON.stringify(syncedConfig.preferences?.chat),
  )
  // 真正更新的手机修改可以正常覆盖，证明同步不是单向锁定。
  await api(base, '/api/config', {
    method: 'PUT',
    body: {
      preferences: { chat: { reasoningEffort: 'max', temperature: 1 } },
      preferencesMeta: { 'chat.reasoningEffort': { at: highAt + 2, by: 'mobile-new' } },
    },
  })
  syncedConfig = await (await api(base, '/api/config')).json()
  check('更新的一端可以覆盖共享偏好', syncedConfig.preferences?.chat?.reasoningEffort === 'max', JSON.stringify(syncedConfig.preferences?.chat))
  check('health 声明多端偏好同步能力', health.capabilities?.includes('preferences-sync'), JSON.stringify(health.capabilities))

  console.log('\n④ 提供商：真实连通性检测（本地无服务时应如实报错）')
  const providers = await (await api(base, '/api/providers')).json()
  check('列出 3 个提供商', providers.providers.length === 3)
  const ollamaTest = await (await api(base, '/api/providers/ollama/test', { method: 'POST' })).json()
  check('Ollama 未运行时返回真实错误', ollamaTest.ok === false && typeof ollamaTest.detail === 'string', JSON.stringify(ollamaTest))
  console.log(`     真实结果：${ollamaTest.detail}`)
  const openaiTest = await (await api(base, '/api/providers/openai/test', { method: 'POST' })).json()
  check('未配置 Key 时明确提示', openaiTest.ok === false && /API Key/.test(openaiTest.detail))

  console.log('\n④b 托管提供商扩展点（预留给未来的官方服务，本仓库不含云逻辑）')
  backend.ctx.models.registerProvider('managed-demo', {
    type: 'managed',
    name: '托管示例',
    baseURL: 'managed://example',
    models: [{ id: 'managed-1', name: 'Managed One' }],
  })
  const withManaged = await (await api(base, '/api/providers')).json()
  const managed = withManaged.providers.find(p => p.id === 'managed-demo')
  check('运行时提供商出现在列表里', !!managed && managed.managed === true)
  check('托管提供商标记为不可编辑', managed.editable === false)
  const putManaged = await api(base, '/api/providers/managed-demo', { method: 'PUT', body: { name: 'hack' } })
  check('直接修改托管提供商被拒绝', putManaged.status === 400, `HTTP ${putManaged.status}`)

  console.log('\n④c 内置模型与自定义提供商 / 模型 CRUD（真实写盘）')
  const builtin = await (await api(base, '/api/builtin/models')).json()
  check('内置模型接口如实返回未接入', builtin.available === false && builtin.models.length === 0 && typeof builtin.reason === 'string')

  const newProvider = await api(base, '/api/providers', { method: 'POST', body: { id: 'custom-test', name: 'Custom Test', type: 'openai', baseURL: 'https://example.com/v1' } })
  check('新增提供商返回 201', newProvider.status === 201, `HTTP ${newProvider.status}`)
  const newProviderBody = await newProvider.json()
  check('新增提供商出现在列表里', newProviderBody.provider?.id === 'custom-test')

  const duplicateProvider = await api(base, '/api/providers', { method: 'POST', body: { id: 'custom-test', type: 'openai' } })
  check('重复提供商 ID 被拒绝', duplicateProvider.status === 409, `HTTP ${duplicateProvider.status}`)
  const badTypeProvider = await api(base, '/api/providers', { method: 'POST', body: { id: 'bad-type', type: 'not-an-adapter' } })
  check('未知适配器类型被拒绝', badTypeProvider.status === 400, `HTTP ${badTypeProvider.status}`)

  const updatedProvider = await api(base, '/api/providers/custom-test', {
    method: 'PUT',
    body: { name: 'Custom Test 2', timeoutMs: 15000, headers: { 'X-Test': '1' } },
  })
  check('修改提供商成功', updatedProvider.status === 200, `HTTP ${updatedProvider.status}`)
  const updatedProviderBody = await updatedProvider.json()
  const savedProvider = updatedProviderBody.providers.find(p => p.id === 'custom-test')
  check(
    '提供商的名称 / 超时 / 请求头已保存',
    savedProvider.name === 'Custom Test 2' && savedProvider.timeoutMs === 15000 && savedProvider.headers['X-Test'] === '1',
    JSON.stringify(savedProvider),
  )

  await api(base, '/api/providers/custom-test', {
    method: 'PUT',
    body: { headers: { 'X-Test': '1', Authorization: 'Bearer super-secret-token' } },
  })
  const maskedConfig = await (await api(base, '/api/config')).json()
  const maskedAuth = maskedConfig.providers['custom-test'].headers.Authorization
  check('敏感请求头在接口里打码', typeof maskedAuth === 'string' && maskedAuth.includes('…') && !maskedAuth.includes('secret-token'), maskedAuth)
  await api(base, '/api/providers/custom-test', { method: 'PUT', body: { headers: { 'X-Test': '1', Authorization: maskedAuth } } })
  const rawHeaders = backend.ctx.settings.get().providers['custom-test'].headers
  check('原样提交打码值不会覆盖真实请求头', rawHeaders.Authorization === 'Bearer super-secret-token', JSON.stringify(rawHeaders))
  await api(base, '/api/providers/custom-test', { method: 'PUT', body: { headers: { 'X-Test': '1' } } })
  const clearedHeaders = backend.ctx.settings.get().providers['custom-test'].headers
  check(
    '请求头覆盖提交后精确替换（删除旧 header 生效）',
    clearedHeaders['X-Test'] === '1' && !Object.keys(clearedHeaders).some(key => key.toLowerCase() === 'authorization'),
    JSON.stringify(clearedHeaders),
  )

  // 凭据加密落盘
  const SECRET_KEY = 'sk-encrypt-test-1234567890'
  await api(base, '/api/providers/custom-test', {
    method: 'PUT',
    body: { apiKey: SECRET_KEY, headers: { 'X-Test': '1', Authorization: 'Bearer super-secret-token' } },
  })
  const rawConfig = await (await import('node:fs/promises')).readFile(join(dataDir, 'config.json'), 'utf8')
  check('config.json 不出现明文 API Key', !rawConfig.includes(SECRET_KEY), rawConfig.slice(0, 120))
  check('config.json 不出现明文敏感请求头', !rawConfig.includes('super-secret-token'))
  check('凭据以 enc:v1 密文格式保存', rawConfig.includes('enc:v1:'))
  check('进程内仍能拿到明文凭据用于请求', backend.ctx.settings.get().providers['custom-test'].apiKey === SECRET_KEY)
  const configPublic = await (await api(base, '/api/config')).json()
  check('接口返回的 Key 仍是打码值', configPublic.providers['custom-test'].apiKey.includes('…') && !configPublic.providers['custom-test'].apiKey.includes(SECRET_KEY))

  const newModel = await api(base, '/api/providers/custom-test/models', { method: 'POST', body: { id: 'org/model-1', name: 'Model One' } })
  check('新增模型（ID 带斜杠）返回 201', newModel.status === 201, `HTTP ${newModel.status}`)
  const newModelBody = await newModel.json()
  check('新增模型标记为自定义', newModelBody.model?.custom === true && newModelBody.model.id === 'org/model-1')

  const duplicateModel = await api(base, '/api/providers/custom-test/models', { method: 'POST', body: { id: 'org/model-1' } })
  check('重复模型 ID 被拒绝', duplicateModel.status === 409, `HTTP ${duplicateModel.status}`)

  const modelPath = `/api/providers/custom-test/models/${encodeURIComponent('org/model-1')}`
  const updatedModel = await api(base, modelPath, {
    method: 'PUT',
    body: { name: 'Model One Renamed', enabled: false, params: { temperature: 0.3, maxTokens: 512, extraBody: { top_p: 0.9 } } },
  })
  check('修改模型与参数成功', updatedModel.status === 200, `HTTP ${updatedModel.status}`)
  const updatedModelBody = await updatedModel.json()
  check(
    '模型参数已保存',
    updatedModelBody.model?.params?.temperature === 0.3 &&
      updatedModelBody.model?.params?.maxTokens === 512 &&
      updatedModelBody.model?.params?.extraBody?.top_p === 0.9,
  )
  check('模型停用状态已保存', updatedModelBody.model?.enabled === false)

  console.log('\n④d 空回复自动重试并明确报错')
  let emptyAttempts = 0
  backend.ctx.models.registerAdapter('empty-test', {
    label: 'Empty Test',
    async listModels() {
      return [{ id: 'empty-1', name: 'Empty One' }]
    },
    async test() {
      return { detail: 'Empty Test 可用' }
    },
    async stream({ onDone }) {
      emptyAttempts += 1
      onDone({})
    },
  })
  await backend.ctx.settings.update({
    network: { emptyResponseRetries: 1 },
    providers: {
      'empty-test': {
        type: 'empty-test',
        name: 'Empty Test',
        baseURL: 'empty://local',
        enabled: true,
        models: [{ id: 'empty-1', name: 'Empty One' }],
        defaultModel: 'empty-1',
      },
    },
  })
  let emptyError = null
  try {
    await backend.ctx.models.stream({
      provider: 'empty-test',
      model: 'empty-1',
      messages: [{ role: 'user', content: 'hi' }],
      options: {},
    })
  } catch (err) {
    emptyError = err
  }
  check('空回复会自动重试', emptyAttempts === 2, `attempts=${emptyAttempts}`)
  check('重试仍为空后明确报错', !!emptyError && /空回复/.test(emptyError.message), emptyError?.message)

  console.log('\n④e 后端最终图片预算：无论什么渠道只保留最近 2 张真图')
  let budgetCaptured = null
  backend.ctx.models.registerAdapter('image-budget-test', {
    label: 'Image Budget Test',
    async listModels() {
      return [{ id: 'image-budget-1', name: 'Image Budget' }]
    },
    async test() {
      return { detail: 'Image Budget Test 可用' }
    },
    async stream({ messages, onChunk, onDone }) {
      budgetCaptured = JSON.parse(JSON.stringify(messages || []))
      onChunk('ok')
      onDone({})
    },
  })
  await backend.ctx.settings.update({
    preferences: { chat: { imagesPerRequest: 2 } },
    providers: {
      'image-budget-test': {
        type: 'image-budget-test',
        name: 'Image Budget Test',
        baseURL: 'image-budget://local',
        enabled: true,
        models: [{ id: 'image-budget-1', name: 'Image Budget' }],
        defaultModel: 'image-budget-1',
      },
    },
  })
  const imagePart = label => ({ type: 'image_url', image_url: { url: `data:image/png;base64,${label}` } })
  await backend.ctx.models.stream({
    provider: 'image-budget-test',
    model: 'image-budget-1',
    messages: [
      { role: 'user', content: [{ type: 'text', text: '旧图' }, imagePart('old-1'), imagePart('old-2')] },
      { role: 'assistant', content: '收到' },
      { role: 'user', content: [{ type: 'text', text: '新图' }, imagePart('new-1')] },
    ],
    options: {},
  })
  const budgetImages = (budgetCaptured || []).flatMap(message =>
    Array.isArray(message.content) ? message.content.filter(part => part?.type === 'image_url') : [],
  )
  const budgetPlaceholders = (budgetCaptured || []).flatMap(message =>
    Array.isArray(message.content) ? message.content.filter(part => part?.type === 'text' && part.text === '[图片]') : [],
  )
  check(
    '后端最终预算只保留最近 2 张真图，更早的降级为 [图片]',
    budgetImages.length === 2 &&
      budgetPlaceholders.length === 1 &&
      budgetImages.every(part => String(part.image_url?.url || '').includes('new-1') || String(part.image_url?.url || '').includes('old-2')),
    JSON.stringify({ images: budgetImages.map(part => part.image_url?.url), placeholders: budgetPlaceholders.length }),
  )


  // 远端拉取与已有模型合并：用户配置不能被覆盖
  backend.ctx.models.registerAdapter('merge-test', {
    label: 'Merge Test',
    async listModels() {
      return [{ id: 'remote-1', name: 'Remote 1' }, { id: 'keep-1', name: 'Remote Name' }]
    },
  })
  await api(base, '/api/providers', { method: 'POST', body: { id: 'merge-test', name: 'Merge Test', type: 'merge-test' } })
  await api(base, '/api/providers/merge-test/models', {
    method: 'POST',
    body: { id: 'keep-1', name: 'User Keep', params: { temperature: 0.5 } },
  })
  const refreshed = await (await api(base, '/api/providers/merge-test/refresh', { method: 'POST' })).json()
  const mergedProvider = (await (await api(base, '/api/providers')).json()).providers.find(p => p.id === 'merge-test')
  check('拉取模型会追加远端新模型', refreshed.ok === true && mergedProvider?.models?.some(m => m.id === 'remote-1'), JSON.stringify(mergedProvider?.models))
  const keptModel = mergedProvider?.models?.find(m => m.id === 'keep-1')
  check('拉取不会覆盖用户已有的模型配置', keptModel?.name === 'User Keep' && keptModel?.params?.temperature === 0.5, JSON.stringify(keptModel))

  // 「获取模型列表」必须只返回临时候选，不能像旧 refresh 一样全部写入并启用
  backend.ctx.models.registerAdapter('discover-test', {
    label: 'Discover Test',
    async listModels() {
      return [{ id: 'discover-1', name: 'Discover 1' }]
    },
  })
  await api(base, '/api/providers', { method: 'POST', body: { id: 'discover-test', name: 'Discover Test', type: 'discover-test' } })
  const discoveredRes = await api(base, '/api/providers/discover-test/models/remote')
  const discoveredBody = await discoveredRes.json()
  check(
    '获取模型列表返回临时候选并标记未安装',
    discoveredRes.status === 200 && discoveredBody.models?.[0]?.id === 'discover-1' && discoveredBody.models?.[0]?.installed === false,
    JSON.stringify(discoveredBody),
  )
  const discoverProvider = (await (await api(base, '/api/providers')).json()).providers.find(p => p.id === 'discover-test')
  check('获取模型列表不会自动写入 / 启用模型', !discoverProvider?.models?.length, JSON.stringify(discoverProvider?.models))
  await api(base, '/api/providers/discover-test', { method: 'DELETE' })


  const delModel = await api(base, modelPath, { method: 'DELETE' })
  check('删除模型成功', delModel.status === 200, `HTTP ${delModel.status}`)

  const delProvider = await api(base, '/api/providers/custom-test', { method: 'DELETE' })
  check('删除提供商成功', delProvider.status === 200, `HTTP ${delProvider.status}`)
  const afterDelete = await (await api(base, '/api/providers')).json()
  check('删除后提供商不再出现', !afterDelete.providers.some(p => p.id === 'custom-test'))

  console.log('\n⑤ 会话持久化（真实写盘）')
  const created = await (await api(base, '/api/sessions', { method: 'POST', body: { name: '测试会话' } })).json()
  check('创建会话', !!created.id && created.name === '测试会话')
  const msg = await (await api(base, `/api/sessions/${created.id}/messages`, { method: 'POST', body: { role: 'user', content: '你好，真实世界' } })).json()
  check('写入消息', msg.content === '你好，真实世界')
  const list = await (await api(base, '/api/sessions')).json()
  check('会话列表中可见', list.conversations.some(c => c.id === created.id))
  check('消息已挂到会话上', list.conversations.find(c => c.id === created.id)?.messages?.length === 1)
  const updated = await (await api(base, `/api/sessions/${created.id}`, { method: 'PUT', body: { name: '改名后的会话' } })).json()
  check('更新会话', updated.name === '改名后的会话')

  console.log('\n⑥ 翻译 / 聊天在未配置模型时给出明确错误')
  const translate = await api(base, '/api/translate', { method: 'POST', body: { text: '你好' } })
  check('翻译接口返回 4xx/5xx 而非假数据', translate.status >= 400, `HTTP ${translate.status}`)
  const translateBody = await translate.json()
  console.log(`     真实结果：${translateBody.error?.message || translateBody.message}`)
  const chat = await api(base, '/api/chat', { method: 'POST', body: { provider: 'openai', messages: [{ role: 'user', content: 'hi' }] } })
  check('聊天接口在缺 Key 时返回明确错误', chat.status >= 400 || (chat.headers.get('content-type') || '').includes('text/event-stream'))

  console.log('\n⑦ 范围检查：本仓库不包含官方服务端逻辑')
  const configAfter = await (await api(base, '/api/config')).json()
  check('配置里没有 cloud / telegram 等云端字段', !configAfter.cloud && !configAfter.telegram, Object.keys(configAfter).join(','))
  const unknownApi = await api(base, '/api/cloud/status')
  check('不存在的 /api/cloud/* 返回 404（没有内置云服务）', unknownApi.status === 404, `HTTP ${unknownApi.status}`)

  console.log('\n⑧ SSE 事件通道')
  const controller = new AbortController()
  const events = await fetch(`${base}/api/events`, { signal: controller.signal })
  check('SSE 连接建立', events.status === 200 && (events.headers.get('content-type') || '').includes('text/event-stream'))
  const reader = events.body.getReader()
  const hello = new TextDecoder().decode((await reader.read()).value)
  check('收到 hello 事件', hello.includes('event: hello'))

  // 真实链路：PUT /api/config -> hub.broadcast('settings/updated') -> SSE。
  // 手机页面正是靠这条事件实时拿到电脑端刚改的偏好。
  const ssePrefAt = Date.now() + 1000
  const putOverSse = api(base, '/api/config', {
    method: 'PUT',
    body: {
      preferences: { chat: { reasoningEffort: 'high' } },
      preferencesMeta: { 'chat.reasoningEffort': { at: ssePrefAt, by: 'sse-test' } },
    },
  }).then(res => res.json())
  let sseText = hello
  for (let i = 0; i < 4 && !sseText.includes('event: settings/updated'); i++) {
    const chunk = await Promise.race([
      reader.read(),
      new Promise(resolve => setTimeout(() => resolve({ done: true, value: null }), 2000)),
    ])
    if (!chunk || chunk.done) break
    sseText += new TextDecoder().decode(chunk.value)
  }
  const putOverSseBody = await putOverSse
  check(
    'PUT /api/config 会实时广播 settings/updated（手机 / 电脑同步事件）',
    sseText.includes('event: settings/updated') && sseText.includes('"reasoningEffort":"high"') && putOverSseBody.preferences?.chat?.reasoningEffort === 'high',
    sseText.slice(-240),
  )
  controller.abort()

  console.log('\n⑨ 数据落盘')
  await backend.ctx.sessions.flush()
  const fs = await import('node:fs/promises')
  const configFile = await fs.readFile(join(dataDir, 'config.json'), 'utf8').catch(() => '')
  const sessionsFile = await fs.readFile(join(dataDir, 'sessions.json'), 'utf8').catch(() => '')
  check('config.json 已写入', configFile.includes('timeoutMs'))
  check('sessions.json 已写入', sessionsFile.includes('改名后的会话'))

  console.log('\n⑨b 实例数据目录切换')
  const dirInfo = await (await api(base, '/api/data-dir')).json()
  check('数据目录接口返回当前目录', dirInfo.dataDir === dataDir, dirInfo.dataDir)
  check('返回默认目录与指针文件', !!dirInfo.homeDir && !!dirInfo.instanceFile)

  const altDir = join(dataDir, 'alt-instance')
  const switched = await api(base, '/api/data-dir', { method: 'PUT', body: { dir: altDir, migrate: true } })
  const switchedBody = await switched.json()
  check('切换到新目录（自动创建 + 迁移）', switched.status === 200 && switchedBody.dataDir === altDir, `HTTP ${switched.status}`)
  const altConfig = await fs.readFile(join(altDir, 'config.json'), 'utf8').catch(() => '')
  const altSessions = await fs.readFile(join(altDir, 'sessions.json'), 'utf8').catch(() => '')
  const altKey = await fs.readFile(join(altDir, '.secret-key'), 'utf8').catch(() => '')
  check('当前配置已复制到新目录', altConfig.includes('timeoutMs'))
  check('当前会话已复制到新目录', altSessions.includes('改名后的会话'))
  check('密钥文件随目录一起迁移', altKey.trim().length > 20)
  check('数据目录内存状态已切换', backend.ctx.settings.dataDir === altDir && backend.ctx.sessions.dataDir === altDir)
  const providersAfterSwitch = await (await api(base, '/api/providers')).json()
  check(
    '切换后配置仍可用',
    ['openai', 'anthropic', 'ollama', 'merge-test'].every(id => providersAfterSwitch.providers.some(p => p.id === id)),
    providersAfterSwitch.providers.map(p => p.id).join(','),
  )

  const restored = await api(base, '/api/data-dir', { method: 'PUT', body: { dir: dataDir, migrate: false } })
  const restoredBody = await restored.json()
  check('切回原目录并加载原数据', restored.status === 200 && restoredBody.dataDir === dataDir && backend.ctx.sessions.count() === 1, JSON.stringify(restoredBody.current))

  console.log('\n⑨c 运行日志：文件持久化 / 前端日志 / SSE 实时')
  backend.ctx.logger.info('BACKEND_RUNTIME_PERSIST_TEST')
  await api(base, '/api/logs/client', {
    method: 'POST',
    body: {
      lines: [
        { at: Date.now(), level: 'info', name: 'web-test', text: 'CLIENT_FORWARD_TEST' },
        { at: Date.now() + 1, level: 'warn', name: 'web-test', text: 'CLIENT_FORWARD_WARN_TEST' },
      ],
    },
  })
  await new Promise(resolve => setTimeout(resolve, 120))

  const runtime = await (await api(base, '/api/logs/runtime?limit=300')).json()
  const runtimeLines = Array.isArray(runtime.lines) ? runtime.lines : []
  check('运行日志接口返回日志文件路径', typeof runtime.file === 'string' && runtime.file.endsWith('runtime.log'), runtime.file || '')
  check(
    '运行日志接口返回实例 ID（后端重启识别用）',
    typeof runtime.instance === 'string' && runtime.instance.includes('-') && runtime.instance.length >= 10,
    String(runtime.instance || ''),
  )
  check(
    '后端日志进入运行日志接口',
    runtimeLines.some(line => line.text === 'BACKEND_RUNTIME_PERSIST_TEST'),
  )
  check(
    '前端日志进入统一日志流（origin=web）',
    runtimeLines.some(line => line.text === 'CLIENT_FORWARD_TEST' && line.origin === 'web') &&
      runtimeLines.some(line => line.text === 'CLIENT_FORWARD_WARN_TEST' && line.level === 'warn'),
  )
  const runtimeFileText = await readFile(join(dataDir, 'logs', 'runtime.log'), 'utf8').catch(() => '')
  check(
    '运行日志已追加写入 runtime.log',
    runtimeFileText.includes('BACKEND_RUNTIME_PERSIST_TEST') && runtimeFileText.includes('CLIENT_FORWARD_TEST'),
  )

  // after 增量分页必须从旧到新返回；否则一次落后超过 limit 会直接跳到最新，漏掉中间日志。
  const pagedBase = runtimeLines.find(line => Number(line.id) > 0)
  const pagedBaseIndex = pagedBase ? runtimeLines.indexOf(pagedBase) : -1
  const pagedNext = pagedBaseIndex >= 0 ? runtimeLines[pagedBaseIndex + 1] : null
  const pagedData = pagedBase
    ? await (await api(base, `/api/logs/runtime?limit=1&after=${pagedBase.id}`)).json()
    : { lines: [] }
  check(
    'after 增量分页按从旧到新返回',
    !!pagedNext && pagedData.lines?.[0]?.id === pagedNext.id,
    JSON.stringify({ base: pagedBase?.id, next: pagedNext?.id, got: pagedData.lines?.[0]?.id }),
  )

  const streamController = new AbortController()
  const streamResponse = await fetch(`${base}/api/logs/runtime/stream`, { signal: streamController.signal })
  check(
    '运行日志 SSE 已建立',
    streamResponse.status === 200 && (streamResponse.headers.get('content-type') || '').includes('text/event-stream'),
    `HTTP ${streamResponse.status}`,
  )
  const streamReader = streamResponse.body.getReader()
  const streamDecoder = new TextDecoder()
  let streamText = ''
  backend.ctx.logger.info('SSE_RUNTIME_TEST')
  const sseDeadline = Date.now() + 3000
  while (Date.now() < sseDeadline && !streamText.includes('SSE_RUNTIME_TEST')) {
    const chunk = await Promise.race([
      streamReader.read(),
      new Promise(resolve => setTimeout(() => resolve({ timeout: true }), 400)),
    ])
    if (chunk?.timeout) continue
    if (chunk?.done) break
    streamText += streamDecoder.decode(chunk.value, { stream: true })
  }
  check('运行日志 SSE 实时推送', streamText.includes('SSE_RUNTIME_TEST'), streamText.slice(0, 160))
  streamController.abort()

  await backend.close()
  backend = await startBackend({ port: 0, host: '127.0.0.1', dataDir })
  const restoredRuntime = await (await api(backend.url, '/api/logs/runtime?limit=300')).json()
  check(
    '重启后端后仍会回读 runtime.log 历史',
    (restoredRuntime.lines || []).some(line => line.text === 'BACKEND_RUNTIME_PERSIST_TEST'),
  )
  check(
    '后端重启后实例 ID 会变化（前端据此强制全量重拉）',
    typeof restoredRuntime.instance === 'string' && restoredRuntime.instance !== runtime.instance,
    JSON.stringify({ before: runtime.instance, after: restoredRuntime.instance }),
  )

  console.log('\n⑩ 关闭')
  await backend.close()
  await rm(dataDir, { recursive: true, force: true }).catch(() => {})

  console.log(`\n结果：${results.length - failed}/${results.length} 项通过`)
  process.exit(failed ? 1 : 0)
}

main().catch(async err => {
  console.error('\n后端测试异常：', err)
  await rm(dataDir, { recursive: true, force: true }).catch(() => {})
  process.exit(1)
})
