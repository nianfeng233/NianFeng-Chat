/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * 插件依赖标注专项测试。
 *
 * 确认三件事：
 *   1. 每个内置插件都声明了 depends / optionalDepends；
 *   2. depends / optionalDepends 的目标存在、版本范围合法且当前版本满足；
 *   3. inject 中的服务依赖能映射回提供方插件，并且已经写入对应插件级依赖。
 */
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { plugins } from '../plugins/registry.mjs'
import { satisfies, isValidRange } from '../src/runtime/semver.mjs'

let passed = 0
let failed = 0
const failures = []
function check(name, ok, detail = '') {
  if (ok) {
    passed++
    return true
  }
  failed++
  failures.push(`${name}${detail ? ` · ${detail}` : ''}`)
  return false
}

function section(title) {
  console.log(`\n${title}`)
}

const byId = new Map(plugins.map(entry => [entry.id, entry]))
const problems = []

section('① 清单字段')
check(`内置插件数量正常（${plugins.length}）`, plugins.length >= 90)
for (const entry of plugins) {
  check(`${entry.id} 声明 depends`, entry.depends && typeof entry.depends === 'object' && !Array.isArray(entry.depends))
  check(
    `${entry.id} 声明 optionalDepends`,
    entry.optionalDepends && typeof entry.optionalDepends === 'object' && !Array.isArray(entry.optionalDepends),
  )
}

section('② 插件名依赖与版本范围')
for (const entry of plugins) {
  const hard = entry.depends || {}
  const soft = entry.optionalDepends || entry.softDepends || {}
  for (const [dep, range] of Object.entries(hard)) {
    if (dep === entry.id) problems.push(`${entry.id} 不能依赖自己`)
    if (!byId.has(dep)) {
      problems.push(`${entry.id} 的必须依赖 ${dep} 不存在`)
      continue
    }
    if (range && !isValidRange(range)) problems.push(`${entry.id} -> ${dep} 范围不合法：${range}`)
    if (range && !satisfies(byId.get(dep).version, range)) {
      problems.push(`${entry.id} -> ${dep}@${range} 不满足当前版本 ${byId.get(dep).version}`)
    }
  }
  for (const [dep, range] of Object.entries(soft)) {
    if (dep === entry.id) problems.push(`${entry.id} 的可选依赖不能是自己`)
    if (!byId.has(dep)) {
      problems.push(`${entry.id} 的可选依赖 ${dep} 不存在`)
      continue
    }
    if (range && !isValidRange(range)) problems.push(`${entry.id} 可选 -> ${dep} 范围不合法：${range}`)
    if (range && !satisfies(byId.get(dep).version, range)) {
      problems.push(`${entry.id} 可选 -> ${dep}@${range} 不满足当前版本 ${byId.get(dep).version}`)
    }
    if (hard[dep]) problems.push(`${entry.id} 的 ${dep} 不能同时是必须依赖与可选依赖`)
  }
}
check(`全部依赖目标与版本范围有效（${problems.length} 个问题）`, problems.length === 0, problems.slice(0, 6).join(' | '))

section('③ 依赖图无环')
const graph = new Map(plugins.map(entry => [entry.id, new Set(Object.keys(entry.depends || {}).filter(dep => byId.has(dep)))]))
const visiting = new Set()
const visited = new Set()
let cycle = ''
const visit = id => {
  if (visited.has(id) || cycle) return
  if (visiting.has(id)) {
    cycle = id
    return
  }
  visiting.add(id)
  for (const dep of graph.get(id) || []) visit(dep)
  visiting.delete(id)
  visited.add(id)
}
for (const entry of plugins) visit(entry.id)
check('必须依赖拓扑排序无环', !cycle, cycle ? `存在环：${cycle}` : '')

section('④ inject 服务映射到插件依赖')
const moduleById = new Map()
const sourceById = new Map()
const serviceProviders = new Map()
const addProvider = (service, pluginId) => {
  if (!service) return
  if (!serviceProviders.has(service)) serviceProviders.set(service, new Set())
  serviceProviders.get(service).add(pluginId)
}
for (const entry of plugins) {
  const mod = await import(pathToFileURL(entry.path).href)
  moduleById.set(entry.id, mod)
  const source = await readFile(entry.path, 'utf8')
  sourceById.set(entry.id, source)
  for (const item of mod.provides || []) addProvider(typeof item === 'string' ? item : item?.name, entry.id)
}
for (const [id, source] of sourceById) {
  for (const match of source.matchAll(/ctx\.provide\(\s*['"]([^'"]+)['"]/g)) addProvider(match[1], id)
}

const injectList = mod => {
  if (!mod.inject) return []
  if (Array.isArray(mod.inject)) return mod.inject
  if (typeof mod.inject === 'string') return [mod.inject]
  if (typeof mod.inject === 'object') return Object.keys(mod.inject)
  return []
}
const mappingProblems = []
for (const entry of plugins) {
  const mod = moduleById.get(entry.id)
  const hard = mod.depends || {}
  const soft = mod.optionalDepends || mod.softDepends || {}
  for (const raw of injectList(mod)) {
    const text = String(raw ?? '').trim()
    if (!text || text === 'app') continue
    const optional = text.endsWith('?')
    const service = optional ? text.slice(0, -1) : text
    const providers = [...(serviceProviders.get(service) || [])].filter(id => id !== entry.id)
    if (!providers.length) {
      mappingProblems.push(`${entry.id} 的 inject 服务 ${service} 没有找到提供方插件`)
      continue
    }
    for (const providerId of providers) {
      const declared = optional ? soft : hard
      if (!declared[providerId]) {
        mappingProblems.push(
          `${entry.id} 使用${optional ? '可选' : '必须'}服务 ${service}（由 ${providerId} 提供），但未写入 ${optional ? 'optionalDepends' : 'depends'}`,
        )
      }
    }
  }
}
check(
  `inject 服务与插件依赖标注一致（${mappingProblems.length} 个问题）`,
  mappingProblems.length === 0,
  mappingProblems.slice(0, 6).join(' | '),
)

section('⑤ 版本规则')
const cases = [
  ['任意版本：*', satisfies('1.2.3', '*'), true],
  ['任意版本：空范围', satisfies('1.2.3', ''), true],
  ['精确版本：=', satisfies('1.2.3', '=1.2.3'), true],
  ['精确版本：不匹配', satisfies('1.2.4', '=1.2.3'), false],
  ['大于等于', satisfies('1.2.3', '>=1.0.0'), true],
  ['上下界', satisfies('1.2.3', '>=1.0.0 <2.0.0'), true],
  ['上下界越界', satisfies('2.0.0', '>=1.0.0 <2.0.0'), false],
  ['兼容范围 ^', satisfies('1.9.0', '^1.2.0'), true],
  ['兼容范围 ^ 越界', satisfies('2.0.0', '^1.2.0'), false],
  ['次版本 ~', satisfies('1.2.9', '~1.2.0'), true],
  ['次版本 ~ 越界', satisfies('1.3.0', '~1.2.0'), false],
  ['通配 1.x', satisfies('1.9.0', '1.x'), true],
  ['通配 1 主版本', satisfies('1.9.0', '1'), true],
  ['连字符范围', satisfies('2.0.0', '1.2.3 - 2.3.4'), true],
  ['或条件', satisfies('2.5.0', '>=1.0.0 || >=2.0.0'), true],
]
for (const [name, actual, expected] of cases) {
  check(name, actual === expected, `期望 ${expected}，实际 ${actual}`)
}
for (const [name, range, expected] of [
  ['合法范围 string', '>=1.0.0 <2.0.0', true],
  ['合法范围 x', '1.x', true],
  ['非法范围', 'not-a-version', false],
]) {
  check(`isValidRange ${name}`, isValidRange(range) === expected, range)
}

section('结果')
if (failed) {
  console.error(`✘ 依赖测试失败：${failed}/${passed + failed}`)
  for (const item of failures) console.error(`  · ${item}`)
  process.exit(1)
}
console.log(`✔ 依赖测试通过：${passed} 项`)
