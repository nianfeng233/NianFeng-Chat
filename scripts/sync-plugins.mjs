/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * 扫描 plugins/ 目录，生成 plugins/registry.mjs
 *
 * 用法：npm run sync-plugins
 *
 * 浏览器没有"扫描目录"的能力，所以由这个脚本在开发期完成
 * plugin-loader 的第一件事（扫描插件目录 / 读取 manifest）。
 * 每次新增插件后跑一次即可。
 */
import { readdir, writeFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const PLUGINS_DIR = join(ROOT, 'plugins')

/** 递归找出所有 index.mjs */
async function walk(dir) {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...await walk(full))
    else if (entry.name === 'index.mjs') out.push(full)
  }
  return out
}

const files = (await walk(PLUGINS_DIR)).sort()

const entries = []
for (const file of files) {
  const rel = relative(ROOT, file).split(sep).join('/')
  const folder = relative(PLUGINS_DIR, file).split(sep).join('/').replace(/\/index\.mjs$/, '')
  let meta = {}
  try {
    const mod = await import(pathToFileURL(file).href + `?t=${Date.now()}`)
    meta = {
      id: mod.name || folder,
      version: mod.version || '0.0.0',
      displayName: mod.displayName || mod.name || folder,
      description: mod.description || '',
      core: !!mod.core,
      enabled: mod.enabled !== false,
      icon: mod.icon || '',
      unavailable: mod.unavailable === true,
      unavailableReason: mod.unavailableReason || '',
      depends: mod.depends || {},
      optionalDepends: mod.optionalDepends || mod.softDepends || {},
      provides: mod.provides || [],
      permissions: mod.permissions || [],
    }
  } catch (err) {
    console.warn(`  ! 无法读取插件元信息：${rel}\n    ${err.message}`)
    meta = { id: folder, error: String(err.message || err) }
  }
  entries.push({
    ...meta,
    path: './' + rel,
    dir: 'plugins/' + folder,
  })
}

const body = `/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 *
 * 由 scripts/sync-plugins.mjs 自动生成，请勿手改。
 * 重新生成：npm run sync-plugins
 *
 * 共 ${entries.length} 个插件，按目录名排序；真正的加载顺序由
 * plugin-loader 依据 depends / inject 做拓扑排序决定。
 */
export const plugins = ${JSON.stringify(entries, null, 2)}

export default plugins
`

await writeFile(join(PLUGINS_DIR, 'registry.mjs'), body, 'utf8')
console.log(`✔ 已生成 plugins/registry.mjs（${entries.length} 个插件）`)
for (const e of entries) console.log(`  · ${String(e.id).padEnd(26)} ${e.core ? '核心' : '扩展'}  ${e.path}`)

