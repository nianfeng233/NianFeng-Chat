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
  const snapshot = await backend.ctx.pluginRegistry.refresh()
  const external = (snapshot.plugins || []).filter(item => item.external).map(item => item.id).sort()
  check('真实插件 media-post 被识别', external.includes('media-post'), JSON.stringify(external))
  check('vendored silk-wasm 的 lib/index.mjs 不会被识别成插件', !external.includes('lib'), JSON.stringify(external))
  check('外部插件数量只有真实的 1 个', external.length === 1, JSON.stringify(external))
} finally {
  await backend?.close?.().catch(() => {})
  await rm(dataDir, { recursive: true, force: true }).catch(() => {})
}

const failed = checks.filter(item => !item.ok)
console.log(`\n结果：${checks.length - failed.length}/${checks.length} 项通过`)
if (failed.length) process.exit(1)
process.exit(0)
