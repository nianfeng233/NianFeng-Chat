/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * 插件热插拔回归测试：
 *   - 运行期新增 / 更新 / 删除插件不重启、不刷新；
 *   - 外部插件文件变化（path 版本号变化）会重新 import 新模块；
 *   - 禁用上游插件会级联停用依赖它的插件，恢复上游后依赖插件自动回来；
 *   - 禁用期间不 import 模块；启用后导入失败会明确标 error 而不是静默；
 *   - 服务注册随 fiber 释放，不会出现“重新启用后重复注册 / 残留服务”。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { App } from '../src/runtime/app.mjs'

const checks = []
const check = (name, ok, detail = '') => {
  checks.push({ name, ok: !!ok, detail })
  console.log(`${ok ? '  ✔' : '  ✗'} ${name}${!ok && detail ? `  → ${detail}` : ''}`)
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

let querySeq = 0
/** 写一个外部插件目录，返回与后端 /api/plugins 相同形状的 entry。 */
async function writePlugin(root, { id, version, depends = {}, optionalDepends = {}, inject = [], provides = [], source = '' }) {
  const dir = join(root, id)
  await mkdir(dir, { recursive: true })
  const file = join(dir, 'index.mjs')
  querySeq += 1
  const revision = `${Date.now().toString(36)}${querySeq.toString(36)}`
  const body = `
export const name = ${JSON.stringify(id)}
export const version = ${JSON.stringify(version)}
export const displayName = ${JSON.stringify(`Hot ${id}`)}
export const depends = ${JSON.stringify(depends)}
export const optionalDepends = ${JSON.stringify(optionalDepends)}
export const inject = ${JSON.stringify(inject)}
export const provides = ${JSON.stringify(provides)}
export function apply(ctx) {
  const services = ${JSON.stringify(provides.map(item => (typeof item === 'string' ? item : item.name)))}
  for (const name of services) {
    ctx.provide(name, { plugin: ${JSON.stringify(id)}, version: ${JSON.stringify(version)} })
  }
  ${source}
}
`
  await writeFile(file, body, 'utf8')
  await wait(5)
  return {
    id,
    version,
    displayName: `Hot ${id}`,
    path: `${pathToFileURL(file).href}?v=${revision}`,
    dir: id,
    external: true,
    source: 'external',
    depends,
    optionalDepends,
    inject,
    provides,
  }
}

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'nianfeng-hot-plugin-'))
  const app = new App({ baseUrl: new URL('../', import.meta.url) })
  const state = () => ({ disabled: [], removed: [], enabled: [], reason: 'test' })

  try {
    console.log('\n① 运行期新增插件（无需刷新 / 重启）')
    const alpha1 = await writePlugin(root, {
      id: 'hot-alpha',
      version: '1.0.0',
      provides: [{ name: 'hot-alpha-service', type: 'singleton' }],
    })
    const beta = await writePlugin(root, {
      id: 'hot-beta',
      version: '1.0.0',
      depends: { 'hot-alpha': '*' },
      inject: ['hot-alpha-service'],
      provides: [{ name: 'hot-beta-service', type: 'singleton' }],
    })
    await app.syncEntries([alpha1, beta], state())
    check('新增两个插件后都处于 active', ['hot-alpha', 'hot-beta'].every(id => app.get(id)?.status === 'active'), JSON.stringify(app.list().map(r => [r.id, r.status])))
    check('新增插件的服务立即可用', !!app.services.get('hot-alpha-service')?.value && !!app.services.get('hot-beta-service')?.value)
    check('外部插件记录来源正确', app.get('hot-alpha')?.external === true)

    console.log('\n② 运行期更新外部插件（path 版本号变化 -> 重新 import）')
    const alpha2 = await writePlugin(root, {
      id: 'hot-alpha',
      version: '1.1.0',
      provides: [{ name: 'hot-alpha-service', type: 'singleton' }],
    })
    await app.syncEntries([alpha2, beta], state())
    const alphaRecord = app.get('hot-alpha')
    check('版本号已热更新到 1.1.0', alphaRecord?.manifest.version === '1.1.0', JSON.stringify(alphaRecord?.manifest.version))
    check('更新后服务实现也是新版', app.services.get('hot-alpha-service')?.value?.version === '1.1.0')
    check('更新后仍处于 active', alphaRecord?.status === 'active')

    console.log('\n③ 禁用上游插件 -> 级联停用依赖者')
    const disabled = await app.disable('hot-alpha')
    await wait(80)
    check('disable 返回 true', disabled === true)
    check('上游 hot-alpha 已停用且服务释放', app.get('hot-alpha')?.status === 'disabled' && !app.services.get('hot-alpha-service'))
    check('依赖者 hot-beta 被级联停用且服务释放', app.get('hot-beta')?.status === 'disabled' && !app.services.get('hot-beta-service'))

    console.log('\n④ 恢复上游 -> 依赖者自动恢复')
    const enabled = await app.enable('hot-alpha')
    await wait(80)
    check('enable 返回 true 且 hot-alpha active', enabled === true && app.get('hot-alpha')?.status === 'active')
    check('hot-beta 自动恢复 active', app.get('hot-beta')?.status === 'active')
    check('两个服务都恢复注册', !!app.services.get('hot-alpha-service') && !!app.services.get('hot-beta-service'))

    console.log('\n⑤ 禁用期间不 import：坏插件不会拖慢启动')
    const brokenDir = join(root, 'hot-broken')
    await mkdir(brokenDir, { recursive: true })
    const brokenFile = join(brokenDir, 'index.mjs')
    await writeFile(brokenFile, "export const name = 'hot-broken'\nexport const version = '1.0.0'\nthrow new Error('boom-import')\n", 'utf8')
    const broken = {
      id: 'hot-broken',
      version: '1.0.0',
      displayName: 'Hot hot-broken',
      path: `${pathToFileURL(brokenFile).href}?v=broken`,
      dir: 'hot-broken',
      external: true,
      source: 'external',
    }
    await app.syncEntries([alpha2, beta, broken], { disabled: ['hot-broken'], removed: [], enabled: [], reason: 'test-disabled' })
    check('默认禁用 / 已禁用插件的模块不会被 import', app.get('hot-broken')?.status === 'disabled', JSON.stringify(app.get('hot-broken')?.status))
    await app.syncEntries([alpha2, beta, broken], { disabled: [], removed: [], enabled: ['hot-broken'], reason: 'test-enable-broken' })
    check('启用坏插件后明确标记 error', app.get('hot-broken')?.status === 'error' && /boom-import/.test(app.get('hot-broken')?.reason || ''), app.get('hot-broken')?.reason)

    console.log('\n⑥ 运行期删除插件（文件删除 / 目录切换）')
    await app.syncEntries([], { disabled: [], removed: [], enabled: [], reason: 'delete-all' })
    check('已删除插件从 records 移除', ['hot-alpha', 'hot-beta', 'hot-broken'].every(id => !app.get(id)))
    check('对应服务全部释放', !app.services.get('hot-alpha-service') && !app.services.get('hot-beta-service') && !app.services.get('hot-broken-service'))

    console.log('\n⑦ 旧版插件依赖版本不匹配必须标红并阻止激活')
    const legacyApi = await writePlugin(root, { id: 'hot-legacy-api', version: '1.0.0' })
    const needsV2 = await writePlugin(root, {
      id: 'hot-needs-v2',
      version: '1.0.0',
      depends: { 'hot-legacy-api': '^2.0.0' },
    })
    const optionalV2 = await writePlugin(root, {
      id: 'hot-optional-v2',
      version: '1.0.0',
      optionalDepends: { 'hot-legacy-api': '^2.0.0' },
    })
    await app.syncEntries([legacyApi, needsV2, optionalV2], state())
    await wait(100)
    const requiredRecord = app.list().find(record => record.id === 'hot-needs-v2')
    const optionalRecord = app.list().find(record => record.id === 'hot-optional-v2')
    check(
      '必须依赖版本不匹配时插件不会激活',
      requiredRecord?.status === 'inactive' && /版本|实际 1\.0\.0/.test(requiredRecord?.reason || ''),
      JSON.stringify({ status: requiredRecord?.status, reason: requiredRecord?.reason }),
    )
    check(
      '必须依赖版本不匹配标记为 error',
      requiredRecord?.dependencyHealth === 'error' &&
        requiredRecord?.dependencyIssues?.some(item => item.required && item.status === 'version-mismatch' && item.severity === 'error'),
      JSON.stringify(requiredRecord?.dependencyIssues),
    )
    check(
      '可选依赖版本不匹配保持 warning，不阻止激活',
      optionalRecord?.status === 'active' && optionalRecord?.dependencyHealth === 'warning' &&
        optionalRecord?.dependencyIssues?.every(item => !item.required || item.severity !== 'error'),
      JSON.stringify({ status: optionalRecord?.status, health: optionalRecord?.dependencyHealth }),
    )
  } finally {
    try {
      await app.cordis.stop?.()
    } catch (_) {
      /* ignore */
    }
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }

  const failed = checks.filter(item => !item.ok)
  console.log(`\n结果：${checks.length - failed.length}/${checks.length} 项通过`)
  if (failed.length) {
    console.log('\n失败项：')
    for (const item of failed) console.log(`  ✗ ${item.name} ${item.detail || ''}`)
    process.exit(1)
  }
}

main().catch(err => {
  console.error('\n热插拔测试异常终止：')
  console.error(err)
  process.exit(1)
})
