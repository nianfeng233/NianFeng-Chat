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
import { satisfies, isValidRange } from '../src/runtime/semver.mjs'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const PLUGINS_DIR = join(ROOT, 'plugins')

function normalizeDependencyMap(value) {
  if (!value) return {}
  if (Array.isArray(value)) {
    return Object.fromEntries(value.map(item => [String(item || '').trim(), '*']).filter(([name]) => name))
  }
  if (typeof value === 'string') {
    const name = value.trim()
    return name ? { [name]: '*' } : {}
  }
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .map(([name, range]) => [String(name || '').trim(), String(range || '').trim() || '*'])
        .filter(([name]) => name),
    )
  }
  return {}
}

function collectInject(mod) {
  if (!mod.inject) return []
  if (Array.isArray(mod.inject)) return mod.inject.map(item => String(item ?? '').trim()).filter(Boolean)
  if (typeof mod.inject === 'string') return [mod.inject]
  if (typeof mod.inject === 'object') return Object.keys(mod.inject)
  return []
}

/** 内置插件依赖标注校验：返回 { problems, warnings }。 */
function validatePluginDependencies(entries) {
  const problems = []
  const warnings = []
  const byId = new Map()
  for (const entry of entries) {
    if (byId.has(entry.id)) problems.push(`重复插件 id：${entry.id}`)
    byId.set(entry.id, entry)
  }
  let hardEdges = 0
  let optionalPlugins = 0
  for (const entry of entries) {
    if (entry.error) {
      warnings.push(`${entry.id} 模块读取失败：${entry.error}`)
      continue
    }
    const hard = entry.depends || {}
    const soft = entry.optionalDepends || entry.softDepends || {}
    if (Object.keys(soft).length) optionalPlugins++
    for (const [kind, dependencies] of [['必须依赖', hard], ['可选依赖', soft]]) {
      for (const [dep, range] of Object.entries(dependencies)) {
        const label = `${entry.id} -> ${dep}`
        if (dep === entry.id) {
          problems.push(`${label}：不能依赖自己`)
          continue
        }
        if (!byId.has(dep)) {
          problems.push(`${label}：${kind}目标插件不存在`)
          continue
        }
        if (kind === '必须依赖') hardEdges++
        if (range && !isValidRange(range)) {
          problems.push(`${label}：${kind}版本范围不合法「${range}」`)
          continue
        }
        const target = byId.get(dep)
        if (range && !satisfies(target.version, range)) {
          warnings.push(`${label}：声明「${range}」，当前实际 ${target.version}`)
        }
      }
      for (const dep of Object.keys(hard)) {
        if (soft[dep]) problems.push(`${entry.id}: ${dep} 同时出现在必须依赖和可选依赖`)
      }
    }
  }
  return { problems, warnings, hardEdges, optionalPlugins }
}

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
      author: mod.author || '',
      core: !!mod.core,
      enabled: mod.enabled !== false,
      icon: mod.icon || '',
      unavailable: mod.unavailable === true,
      unavailableReason: mod.unavailableReason || '',
      depends: normalizeDependencyMap(mod.depends),
      optionalDepends: normalizeDependencyMap(mod.optionalDepends || mod.softDepends),
      inject: collectInject(mod),
      provides: mod.provides || [],
      permissions: mod.permissions || [],
      slots: mod.slots || [],
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

const dependencyResult = validatePluginDependencies(entries)

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

for (const warning of dependencyResult.warnings) {
  console.warn(`  ! 依赖版本提示：${warning}`)
}
if (dependencyResult.problems.length) {
  console.error(`\n✘ 依赖标注校验失败（${dependencyResult.problems.length} 项）：`)
  for (const problem of dependencyResult.problems) console.error(`  · ${problem}`)
  process.exitCode = 1
} else {
  console.log(
    `✔ 依赖标注校验通过：${dependencyResult.hardEdges} 条必须依赖 / ${dependencyResult.optionalPlugins} 个插件声明可选依赖`,
  )
}

