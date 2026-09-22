/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * 外部插件扫描边界回归：
 *   - 插件包内部的 vendor/<依赖>/lib/index.mjs 不能被识别成独立插件；
 *   - 旧版安装错误遗留在插件根目录的 lib/index.mjs（无 manifest、非 Cordis 插件）
 *     也不能被扫描出来并标红。
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startBackend } from '../server/index.mjs'

const checks = []
const check = (name, ok, detail = '') => {
  checks.push({ name, ok: !!ok, detail })
  console.log(`${ok ? '  ✔' : '  ✗'} ${name}${!ok && detail ? `  → ${detail}` : ''}`)
}

const dataDir = await mkdtemp(join(tmpdir(), 'nianfeng-plugin-scan-'))
const pluginsDir = join(dataDir, 'plugins')
const mediaDir = join(pluginsDir, 'media-post')
let backend = null
try {
  await mkdir(join(mediaDir, 'lib'), { recursive: true })
  await mkdir(join(mediaDir, 'vendor', 'silk-wasm', 'lib'), { recursive: true })
  await mkdir(join(pluginsDir, 'lib'), { recursive: true })
  await writeFile(join(mediaDir, 'manifest.json'), JSON.stringify({ id: 'media-post', name: 'media-post', version: '2.1.0' }))
  await writeFile(join(mediaDir, 'index.mjs'), "export const name = 'media-post'\nexport const version = '2.1.0'\nexport function apply() {}\n")
  await writeFile(join(mediaDir, 'lib', 'tools.mjs'), 'export const x = 1\n')
  await writeFile(join(mediaDir, 'vendor', 'silk-wasm', 'package.json'), JSON.stringify({ name: 'silk-wasm', version: '1.0.0' }))
  await writeFile(join(mediaDir, 'vendor', 'silk-wasm', 'lib', 'index.mjs'), 'export function encode() { return "silk" }\n')
  // 模拟旧版 findPluginRoots 误安装出来的顶层 lib 目录。
  await writeFile(join(pluginsDir, 'lib', 'index.mjs'), 'export function encode() { return "silk" }\n')

  backend = await startBackend({ port: 0, host: '127.0.0.1', dataDir })
  const signatures = []
  backend.ctx.on('plugins/changed', payload => signatures.push(String(payload?.signature || '')))
  const snapshot = await backend.ctx.pluginRegistry.refresh()
  const external = (snapshot.plugins || []).filter(item => item.external).map(item => item.id).sort()
  check('真实插件 media-post 被识别', external.includes('media-post'), JSON.stringify(external))
  check('vendored silk-wasm 的 lib/index.mjs 不会被识别成插件', !external.includes('lib'), JSON.stringify(external))
  check('外部插件数量只有真实的 1 个', external.length === 1, JSON.stringify(external))

  const before = (snapshot.plugins || []).find(item => item.id === 'media-post')
  check('外部插件入口使用路径版本段', /\/user-plugins\/__nfv\/[A-Za-z0-9._+-]+\/media-post\/index\.mjs$/.test(before?.path || ''), String(before?.path))
  const entryResponse = await fetch(`${backend.url}${before.path}`)
  check('外部插件入口文件可通过版本路径读取', entryResponse.status === 200, String(entryResponse.status))

  // 只改 lib 文件（index.mjs 不变）也必须产生新 revision，避免子模块缓存旧代码。
  await writeFile(join(mediaDir, 'lib', 'tools.mjs'), 'export const x = 2\n')
  const next = await backend.ctx.pluginRegistry.refresh()
  const after = (next.plugins || []).find(item => item.id === 'media-post')
  check('只修改 lib 文件也会改变插件 revision', before?.path !== after?.path, `${before?.path} -> ${after?.path}`)
  const subPath = String(after.path).replace(/index\.mjs$/, 'lib/tools.mjs')
  const subResponse = await fetch(`${backend.url}${subPath}`)
  check('插件的相对子模块路径继承版本段', subResponse.status === 200 && (await subResponse.text()).includes('x = 2'), String(subResponse.status))
  check(
    '插件代码变化会广播签名，供服务端代聊判断是否重启 Worker',
    signatures.length >= 2 && signatures.every(Boolean) && signatures[0] !== signatures[1],
    JSON.stringify(signatures),
  )
} finally {
  await backend?.close?.().catch(() => {})
  await rm(dataDir, { recursive: true, force: true }).catch(() => {})
}

const failed = checks.filter(item => !item.ok)
console.log(`\n结果：${checks.length - failed.length}/${checks.length} 项通过`)
if (failed.length) process.exit(1)
process.exit(0)
