/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * WebUI 运行范围回归：
 *   - scope=webui 时不加载 chat-flow / context-builder / chat-tools / memory-store /
 *     model-service / tool-registry / document-service / chat-queue 等业务执行插件；
 *   - 视觉 / 设置 / 数据适配插件仍然激活，界面可以正常渲染；
 *   - agent-client 负责把浏览器消息转发给后端终端。
 */
setTimeout(() => {
  console.log('GLOBAL TIMEOUT')
  process.exit(3)
}, 30000)

import '../src/headless/dom-shim.mjs'
import { App } from '../src/runtime/app.mjs'
import { plugins } from '../plugins/registry.mjs'
import { isPluginInScope, pluginScopeOf } from '../src/runtime/plugin-scope.mjs'

const checks = []
const check = (name, ok, detail = '') => {
  checks.push({ name, ok: !!ok, detail })
  console.log(`${ok ? '  ✔' : '  ✗'} ${name}${!ok && detail ? `  → ${detail}` : ''}`)
}

document.body.innerHTML = '<div id="app"></div>'

const entries = plugins.filter(entry => isPluginInScope(entry, 'webui'))
const app = new App({ baseUrl: new URL('../', import.meta.url) })
const result = await Promise.race([
  app.loadAll(entries, { scope: 'webui' }).then(() => 'loaded'),
  new Promise(resolve => setTimeout(() => resolve('timeout'), 15000)),
])

console.log('\n① 运行范围拆分')
check('WebUI 清单过滤成功', result === 'loaded', result)
check('WebUI 清单里没有业务执行插件', ['chat-flow', 'context-builder', 'chat-tools', 'document-service', 'memory-store', 'model-service', 'chat-queue'].every(id => !entries.some(entry => entry.id === id)))
check('业务执行插件在 webui scope 下没有记录', ['chat-flow', 'context-builder', 'chat-tools', 'memory-store', 'model-service'].every(id => !app.get(id)))
check('tool-registry 作为纯注册表保留在 WebUI scope（不执行工具）', app.get('tool-registry')?.status === 'active', app.get('tool-registry')?.reason || '')
check('chat-flow 被标记为 server scope', pluginScopeOf({ id: 'chat-flow', dir: 'plugins/features/chat-flow' }) === 'server')
check('settings-item-theme 被标记为 webui scope', pluginScopeOf({ id: 'settings-item-theme', dir: 'plugins/views/settings-item-theme' }) === 'webui')
check('session-service 被标记为 both', pluginScopeOf({ id: 'session-service', dir: 'plugins/domain/session-service' }) === 'both')
check('外部未声明 scope 的插件默认 both', pluginScopeOf({ id: 'third-party-thing', dir: 'external/thing' }) === 'both')

console.log('\n② WebUI 视觉 / 操作插件')
for (const id of ['app-shell', 'left-list-panel', 'right-main-panel', 'message-list', 'composer', 'settings-container', 'settings-item-theme', 'settings-item-model', 'settings-item-logs', 'session-service', 'message-service', 'channel-registry', 'model-registry']) {
  const record = app.get(id)
  check(`视觉 / 操作插件「${id}」激活`, record?.status === 'active', record?.reason || '')
}
check('远程代聊通道 agent-client 已激活', app.get('agent-client')?.status === 'active', app.get('agent-client')?.reason || '')

console.log('\n③ 无业务执行插件时的自检')
const fatal = app.list().filter(record => record.status === 'error' && record.id !== 'app-shell')
check('没有 error 级插件', fatal.length === 0, JSON.stringify(fatal.map(record => [record.id, record.reason])))
const dependencyBad = app.list().filter(record => record.dependencyHealth !== 'ok')
check(
  '出厂内置插件依赖健康度全部正常',
  dependencyBad.length === 0,
  JSON.stringify(dependencyBad.map(record => [record.id, record.dependencyHealth, record.dependencyIssues])),
)
const factoryWarning = app.selfCheck().filter(issue => issue.severity === 'warning' || issue.severity === 'error')
check(
  '出厂内置插件没有 warning / error 自检项',
  factoryWarning.length === 0,
  JSON.stringify(factoryWarning.map(issue => [issue.id, issue.severity, issue.message])),
)

try {
  await app.cordis.stop?.()
} catch (_) {
  /* ignore */
}
const failed = checks.filter(item => !item.ok)
console.log(`\n结果：${checks.length - failed.length}/${checks.length} 项通过`)
if (failed.length) process.exit(1)
process.exit(0)
