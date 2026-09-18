/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * 独立扩展适配回归：
 *   - extensions/ 下每个插件都声明了 scope=both；
 *   - 在 WebUI scope 下全部能激活（视觉 / 设置 / 工具注册表可用）；
 *   - 不依赖 server-only 的 chat-flow / context-builder 等执行插件。
 */
setTimeout(() => {
  console.log('GLOBAL TIMEOUT')
  process.exit(3)
}, 30000)

import '../src/headless/dom-shim.mjs'
import { App } from '../src/runtime/app.mjs'
import { plugins } from '../plugins/registry.mjs'
import { isPluginInScope } from '../src/runtime/plugin-scope.mjs'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const checks = []
const check = (name, ok, detail = '') => {
  checks.push({ name, ok: !!ok, detail })
  console.log(`${ok ? '  ✔' : '  ✗'} ${name}${!ok && detail ? `  → ${detail}` : ''}`)
}

document.body.innerHTML = '<div id="app"></div>'

const external = []
for (const entry of await readdir('extensions', { withFileTypes: true }).catch(() => [])) {
  if (!entry.isDirectory()) continue
  const dir = join('extensions', entry.name)
  const index = join(dir, 'index.mjs')
  try {
    await stat(index)
    external.push({
      id: entry.name,
      path: pathToFileURL(index).href,
      dir: `extensions/${entry.name}`,
      external: true,
      scope: 'both',
    })
  } catch (_) {
    /* 不是插件目录 */
  }
}

check('发现独立扩展目录', external.length > 0, `count=${external.length}`)

const builtin = plugins.filter(entry => isPluginInScope(entry, 'webui'))
const app = new App({ baseUrl: new URL('../', import.meta.url) })
await Promise.race([
  app.loadAll([...builtin, ...external], { scope: 'webui' }),
  new Promise(resolve => setTimeout(() => resolve('timeout'), 15000)),
])

for (const entry of external) {
  const record = app.get(entry.id)
  check(`扩展「${entry.id}」在 WebUI scope 激活`, record?.status === 'active', record?.reason || '未加载')
}

try {
  await app.cordis.stop?.()
} catch (_) {
  /* ignore */
}
const failed = checks.filter(item => !item.ok)
console.log(`\n结果：${checks.length - failed.length}/${checks.length} 项通过`)
if (failed.length) process.exit(1)
process.exit(0)
