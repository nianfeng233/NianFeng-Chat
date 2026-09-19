/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * 生产 / 正规发布前静态门禁。
 *
 * 只做低成本、可重复的静态校验，不启动服务、不依赖网络：
 *   - package.json / package-lock.json / Rust Cargo.toml 版本号一致；
 *   - 访问令牌相关代码只保存摘要，不写 .webui-token 明文；
 *   - 备用模型已经切换为有序列表 model.failoverKeys；
 *   - 我方可分发的必需文件存在。
 *
 * 完整发布门禁请在通过本脚本后继续执行：
 *   npm test
 *   npm run build:release
 *   node scripts/prepare-publish.mjs
 *
 * 用法：npm run verify:production
 */
import { readdir, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isAccessTokenHash } from '../server/security-utils.mjs'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const results = []
let failed = 0

function check(name, ok, detail = '') {
  results.push({ name, ok })
  if (!ok) failed++
  console.log(`${ok ? '  ✔' : '  ✗'} ${name}${ok ? '' : '  → ' + detail}`)
}

async function readText(...segments) {
  return readFile(join(ROOT, ...segments), 'utf8')
}

function packageVersionFromCargo(cargoText) {
  const match = cargoText.match(/\[package\]([\s\S]*?)(?:\n\[|$)/)
  if (!match) return ''
  const version = match[1].match(/^\s*version\s*=\s*"([^"]+)"/m)
  return version ? version[1].trim() : ''
}

async function collectPluginIndexFiles(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'vendor') continue
      await collectPluginIndexFiles(full, out)
    } else if (entry.name === 'index.mjs') {
      out.push(full)
    }
  }
  return out
}

function pluginMetaFromSource(text) {
  const name = text.match(/export const name\s*=\s*'([^']+)'/)?.[1] || ''
  const version = text.match(/export const version\s*=\s*'([^']+)'/)?.[1] || ''
  return { name, version }
}

async function checkRegistryVersionSync() {
  const registryPath = join(ROOT, 'plugins', 'registry.mjs')
  const registryModule = await import(`${pathToFileURL(registryPath).href}?verify=${Date.now()}`)
  const registryEntries = Array.isArray(registryModule.plugins) ? registryModule.plugins : []
  const byId = new Map(registryEntries.map(entry => [String(entry.id), entry]))
  const files = await collectPluginIndexFiles(join(ROOT, 'plugins'))
  const mismatches = []
  for (const file of files) {
    const text = await readFile(file, 'utf8')
    const { name, version } = pluginMetaFromSource(text)
    if (!name || !version) continue
    const entry = byId.get(name)
    if (!entry) continue
    if (String(entry.version) !== version) {
      mismatches.push(`${name}: 源码 ${version} ≠ registry ${entry.version}`)
    }
  }
  return { checked: files.length, mismatches }
}

async function main() {
  console.log(`\n念风生产/发布静态校验：${ROOT}`)

  const pkg = JSON.parse(await readText('package.json'))
  const lock = JSON.parse(await readText('package-lock.json'))
  const cargoVersion = packageVersionFromCargo(await readText('scripts', 'desktop-wrapper', 'Cargo.toml'))
  check('package.json 版本号有效', /^\d+\.\d+\.\d+/.test(pkg.version), pkg.version)
  check('package-lock.json 根版本与 package.json 一致', lock.version === pkg.version, `${lock.version} != ${pkg.version}`)
  check('桌面壳 Cargo.toml 版本与 package.json 一致', cargoVersion === pkg.version, `${cargoVersion} != ${pkg.version}`)
  const registrySync = await checkRegistryVersionSync()
  check(
    `插件源码 version 与 plugins/registry.mjs 同步（${registrySync.checked} 个插件）`,
    registrySync.mismatches.length === 0,
    registrySync.mismatches.slice(0, 10).join('；'),
  )

  const configPlugin = await readText('plugins', 'foundation', 'config', 'index.mjs')
  check(
    '配置默认值包含有序备用模型列表 model.failoverKeys',
    /['"]model\.failoverKeys['"]\s*:\s*\[\]/.test(configPlugin) && !/['"]model\.failoverKey['"]\s*:/.test(configPlugin),
    '请确认旧单值默认已被 failoverKeys 替换',
  )
  const modelService = await readText('plugins', 'domain', 'model-service', 'index.mjs')
  check(
    '模型服务按列表顺序逐个降级',
    modelService.includes("config.get('model.failoverKeys'") && modelService.includes('attemptOrder') && modelService.includes('model:fallback'),
    '缺少 failoverKeys 调度逻辑',
  )
  const settingsItemModel = await readText('plugins', 'views', 'settings-item-model', 'index.mjs')
  const failoverView = await readText('plugins', 'views', 'settings-item-model', 'failover.mjs')
  check(
    '模型设置页提供可拖拽排序的备用模型表',
    failoverView.includes('data-failover-list') &&
      failoverView.includes('draggable="true"') &&
      failoverView.includes('data-failover-add') &&
      failoverView.includes('model.failoverKeys') &&
      settingsItemModel.includes('buildFailoverBlockHtml'),
    '拖拽列表实现缺失',
  )

  const startText = await readText('start.mjs')
  const serverText = await readText('server', 'index.mjs')
  const networkSettingsText = await readText('plugins', 'views', 'settings-item-network', 'index.mjs')
  check(
    '启动入口不再写 .webui-token 明文文件',
    !/writeFile\([^\n]*\.webui-token/.test(startText) && !/writeFile\([^\n]*\.webui-token/.test(serverText),
    '仍存在明文令牌写盘代码',
  )
  check(
    '访问令牌只保存摘要并支持旧版明文迁移',
    existsSync(join(ROOT, 'server', 'access-token.mjs')) &&
      serverText.includes('resolveStartupAccessToken') &&
      networkSettingsText.includes('webuiTokenSet') &&
      networkSettingsText.includes('clear-webui-token'),
    '缺少 access-token 模块或设置页接入',
  )
  const settingsPlugin = await readText('server', 'plugins', 'settings.mjs')
  const accessTokenModule = await readText('server', 'access-token.mjs')
  check(
    '后端配置只接受 webuiTokenHash，不回显明文',
    settingsPlugin.includes('webuiTokenHash') &&
      settingsPlugin.includes('webuiTokenSet') &&
      accessTokenModule.includes('createAccessTokenHash') &&
      accessTokenModule.includes('normalizeAccessTokenPatch') &&
      accessTokenModule.includes('generateIfUnset'),
    'settings.mjs 未完成摘要化改造',
  )

  check('发布说明 docs/RELEASING.md 存在', existsSync(join(ROOT, 'docs', 'RELEASING.md')))
  check(
    'Web 安全 / HTTP IO 公共件存在',
    existsSync(join(ROOT, 'server', 'web-security.mjs')) && existsSync(join(ROOT, 'server', 'http-io.mjs')),
    '两个入口仍有重复安全/HTTP 实现的风险',
  )
  check('安全说明 docs/SECURITY-HARDENING.md 存在', existsSync(join(ROOT, 'docs', 'SECURITY-HARDENING.md')))
  check('第三方许可 NOTICE / THIRD-PARTY-NOTICES 齐全', existsSync(join(ROOT, 'NOTICE')) && existsSync(join(ROOT, 'THIRD-PARTY-NOTICES.md')))
  check('发布脚本与测试脚本齐全', existsSync(join(ROOT, 'scripts', 'package-release.mjs')) && existsSync(join(ROOT, 'scripts', 'prepare-publish.mjs')) && existsSync(join(ROOT, 'scripts', 'test-failover.mjs')))

  const localUserConfig = join(ROOT, 'user_data', 'config.json')
  if (existsSync(localUserConfig)) {
    let parsed = null
    try {
      parsed = JSON.parse(await readFile(localUserConfig, 'utf8'))
    } catch (_) {
      parsed = null
    }
    const network = parsed?.network || {}
    const plain = String(network.webuiToken || '').trim()
    const hash = String(network.webuiTokenHash || '').trim()
    check('本地 config.json 不残留明文访问令牌', !plain, plain ? 'user_data/config.json 仍有 webuiToken 明文' : '')
    check('本地 config.json 的摘要格式合法', !hash || isAccessTokenHash(hash), hash.slice(0, 24))
  } else {
    check('本地 config.json 不存在时跳过数据检查', true)
  }

  console.log(`\n结果：${results.length - failed}/${results.length} 项通过`)
  if (failed) {
    console.error('生产/发布静态校验未通过，请先修复后再发布。')
    process.exit(1)
  }
  console.log('生产/发布静态校验通过；继续执行 npm test 与 build:release 完成完整门禁。')
}

main().catch(err => {
  console.error('生产校验脚本执行失败：', err)
  process.exit(1)
})
