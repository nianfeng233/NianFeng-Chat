/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * 生成「官方插件仓库」脚手架。
 *
 * 用法：node scripts/scaffold-market-repo.mjs [--out <目录>] [--git]
 *
 * 默认把 extensions/ 下现有的外部插件复制到 <项目>/.local/NianFeng-Chat-Plugins，
 * 按插件市场标准格式生成：
 *   - market.json         仓库内的插件清单（含 id / version / path / SHA-256）
 *   - index.json          市场索引（指向本仓库，作为官方源默认地址）
 *   - plugins/<id>/       插件本体
 *   - scripts/build-market.mjs  后续维护者重新生成清单
 *
 * 生成后把该目录推送到 GitHub（默认假定为
 * https://github.com/nianfeng233/NianFeng-Chat-Plugins）即可。
 */
import { cp, mkdir, readdir, rm, writeFile, copyFile, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { basename, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const args = process.argv.slice(2)
const outIndex = args.findIndex(item => item === '--out')
const outArg = outIndex >= 0 ? args[outIndex + 1] : args.find(item => !item.startsWith('--'))
const OUT = resolve(outArg || join(ROOT, '.local', 'NianFeng-Chat-Plugins'))
const initGit = args.includes('--git')
const REPO_URL = 'https://github.com/nianfeng233/NianFeng-Chat-Plugins'
const BRANCH = 'main'
const PLUGIN_SOURCE_DIR = join(ROOT, 'extensions')

const SKIP_DIRS = new Set(['node_modules', '.git', '.tmp', '.cache', 'target', 'dist'])
const SKIP_FILE_PATTERN = /\.(zip|ps1|cmd|bat|exe|dll|msi)$/i
const SKIP_FILES = new Set(['test.mjs', 'install.ps1', 'uninstall.ps1'])

function shouldSkip(source) {
  const name = basename(source)
  if (SKIP_DIRS.has(name)) return true
  if (SKIP_FILES.has(name)) return true
  if (SKIP_FILE_PATTERN.test(name)) return true
  return false
}

const BUILD_SCRIPT = `/*
 * 念风官方插件仓库 · 清单生成脚本
 * 用法：node scripts/build-market.mjs
 */
import { createHash } from 'node:crypto'
import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const PLUGINS_DIR = join(ROOT, 'plugins')
const REPO_URL = process.env.MARKET_REPO_URL || ${JSON.stringify(REPO_URL)}
const BRANCH = process.env.MARKET_REPO_BRANCH || ${JSON.stringify(BRANCH)}

async function walkFiles(dir, base = dir, out = []) {
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.DS_Store') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) await walkFiles(full, base, out)
    else if (entry.isFile()) out.push({ full, rel: relative(base, full).split(sep).join('/') })
  }
  return out
}

async function hashFileEntries(entries) {
  const hash = createHash('sha256')
  const files = [...entries].sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  for (const file of files) {
    const data = await readFile(file.full)
    hash.update(\`file:\${file.rel}\\n\`)
    hash.update(\`size:\${data.length}\\n\`)
    hash.update(data)
    hash.update('\\n')
  }
  return hash.digest('hex')
}

async function main() {
  const entries = await readdir(PLUGINS_DIR, { withFileTypes: true })
  const plugins = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const dir = join(PLUGINS_DIR, entry.name)
    let manifest = {}
    try {
      manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'))
    } catch (_) {
      manifest = {}
    }
    const id = String(manifest.id || entry.name).trim()
    const files = await walkFiles(dir)
    const hash = await hashFileEntries(files, dir)
    plugins.push({
      id,
      name: String(manifest.displayName || manifest.name || id),
      displayName: String(manifest.displayName || manifest.name || id),
      version: String(manifest.version || '0.0.0'),
      description: String(manifest.description || ''),
      author: String(manifest.author || ''),
      icon: String(manifest.icon || ''),
      license: String(manifest.license || 'Apache-2.0'),
      path: \`plugins/\${entry.name}\`,
      entry: String(manifest.entry || 'index.mjs').replace(/^\\.?\\//, '') || 'index.mjs',
      scope: String(manifest.scope || 'both'),
      permissions: Array.isArray(manifest.permissions) ? manifest.permissions : [],
      tags: Array.isArray(manifest.tags) ? manifest.tags : [],
      minAppVersion: String(manifest.minAppVersion || '2.0.0'),
      hashType: 'content-sha256',
      sha256: hash,
      updatedAt: new Date().toISOString(),
      repo: REPO_URL,
      branch: BRANCH,
      homepage: \`\${REPO_URL}/tree/\${BRANCH}/\${'plugins/' + entry.name}\`,
      release: null,
    })
  }
  plugins.sort((a, b) => a.id.localeCompare(b.id))
  const market = {
    version: 1,
    name: '念风官方插件仓库',
    repo: REPO_URL,
    branch: BRANCH,
    updatedAt: new Date().toISOString(),
    plugins,
  }
  await writeFile(join(ROOT, 'market.json'), JSON.stringify(market, null, 2) + '\\n', 'utf8')
  const index = {
    version: 1,
    updatedAt: new Date().toISOString(),
    repos: [{ name: market.name, url: REPO_URL, branch: BRANCH, manifest: 'market.json', official: true }],
  }
  await writeFile(join(ROOT, 'index.json'), JSON.stringify(index, null, 2) + '\\n', 'utf8')
  console.log(\`✔ 已生成 market.json / index.json（\${plugins.length} 个插件）\`)
  for (const plugin of plugins) console.log(\`  · \${plugin.id.padEnd(24)} v\${plugin.version}  \${plugin.sha256.slice(0, 12)}…\`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
`

const README = `# 念风官方插件仓库

本仓库是念风 Chat 的官方插件市场源，格式同时兼容第三方仓库使用。

## 文件说明

- \`index.json\`：市场索引，记录允许上架的插件仓库；念风 WebUI 默认读取该文件。
- \`market.json\`：本仓库的插件清单，声明插件 id、版本、目录、SHA-256 与仓库地址。
- \`plugins/<id>/\`：插件本体，每个目录必须包含 \`index.mjs\`；后端桥为可选的 \`bridge.mjs\`。
- \`scripts/build-market.mjs\`：修改插件后重新生成 \`market.json\` / \`index.json\`。

## 安全约定

- 每个插件必须有稳定、唯一的 \`id\`，安装目录只使用该 id。
- 插件版本与 \`market.json\` 中的版本必须一致，安装时会校验。
- \`sha256\` 是插件目录内所有文件按稳定算法计算出的内容哈希；念风安装前会复算并拒绝不一致的压缩包。
- 单仓库可以放多个插件（本仓库即为这种模式）；第三方也可以一个仓库只放一个插件。
- 有 GitHub Release 的仓库可提供 \`release.url\` / release \`sha256\`，程序优先使用 release，否则直接下载仓库源码压缩包。

## 维护命令

\`\`\`bash
node scripts/build-market.mjs
\`\`\`

## 发布

\`\`\`bash
git remote add origin https://github.com/nianfeng233/NianFeng-Chat-Plugins.git
git add -A
git commit -m "更新插件市场清单"
git push -u origin main
\`\`\`

如果换了仓库地址，请同时修改念风主仓库 \`src/shared/market-format.mjs\` 里的
\`OFFICIAL_MARKET_REPO\` / \`OFFICIAL_MARKET_INDEX_URL\`，保证官方源指向正确位置。
`

async function copyPlugin(source, target) {
  await cp(source, target, {
    recursive: true,
    force: true,
    filter: sourcePath => !shouldSkip(sourcePath),
  })
}

async function walkFiles(dir, base = dir, out = []) {
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name) || entry.name === '.DS_Store') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) await walkFiles(full, base, out)
    else if (entry.isFile()) out.push({ full, rel: relative(base, full).split(sep).join('/') })
  }
  return out
}

/** 与 server/plugins/plugin-registry.mjs 的 hashPluginEntries 保持一致的内容哈希。 */
async function hashDirectory(dir) {
  const files = (await walkFiles(dir)).sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  const hash = createHash('sha256')
  for (const file of files) {
    const data = await readFile(file.full)
    hash.update(`file:${file.rel}\n`)
    hash.update(`size:${data.length}\n`)
    hash.update(data)
    hash.update('\n')
  }
  return hash.digest('hex')
}

async function writeMarketFiles() {
  const entries = await readdir(join(OUT, 'plugins'), { withFileTypes: true })
  const plugins = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const dir = join(OUT, 'plugins', entry.name)
    let manifest = {}
    try {
      manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'))
    } catch (_) {
      manifest = {}
    }
    const id = String(manifest.id || entry.name).trim()
    const hash = await hashDirectory(dir)
    plugins.push({
      id,
      name: String(manifest.displayName || manifest.name || id),
      displayName: String(manifest.displayName || manifest.name || id),
      version: String(manifest.version || '0.0.0'),
      description: String(manifest.description || ''),
      author: String(manifest.author || ''),
      icon: String(manifest.icon || ''),
      license: String(manifest.license || 'Apache-2.0'),
      path: `plugins/${entry.name}`,
      entry: String(manifest.entry || 'index.mjs').replace(/^\.?\//, '') || 'index.mjs',
      scope: String(manifest.scope || 'both'),
      permissions: Array.isArray(manifest.permissions) ? manifest.permissions : [],
      tags: Array.isArray(manifest.tags) ? manifest.tags : [],
      minAppVersion: String(manifest.minAppVersion || '2.0.0'),
      hashType: 'content-sha256',
      sha256: hash,
      updatedAt: new Date().toISOString(),
      repo: REPO_URL,
      branch: BRANCH,
      homepage: `${REPO_URL}/tree/${BRANCH}/plugins/${entry.name}`,
      release: null,
    })
  }
  plugins.sort((a, b) => a.id.localeCompare(b.id))
  const market = {
    version: 1,
    name: '念风官方插件仓库',
    repo: REPO_URL,
    branch: BRANCH,
    updatedAt: new Date().toISOString(),
    plugins,
  }
  await writeFile(join(OUT, 'market.json'), JSON.stringify(market, null, 2) + '\n', 'utf8')
  await writeFile(
    join(OUT, 'index.json'),
    JSON.stringify(
      {
        version: 1,
        updatedAt: new Date().toISOString(),
        repos: [{ name: market.name, url: REPO_URL, branch: BRANCH, manifest: 'market.json', official: true }],
      },
      null,
      2,
    ) + '\n',
    'utf8',
  )
  for (const plugin of plugins) {
    console.log(`  · ${plugin.id.padEnd(24)} v${plugin.version}  ${plugin.sha256.slice(0, 12)}…`)
  }
  console.log(`✔ 已生成 market.json / index.json（${plugins.length} 个插件）`)
  return plugins.length
}

const runGit = gitArgs =>
  new Promise((resolvePromise, reject) => {
    execFile('git', gitArgs, { cwd: OUT }, err => (err ? reject(err) : resolvePromise()))
  })

async function main() {
  if (!existsSync(PLUGIN_SOURCE_DIR)) throw new Error(`缺少插件源目录：${PLUGIN_SOURCE_DIR}`)
  await rm(OUT, { recursive: true, force: true })
  await mkdir(join(OUT, 'plugins'), { recursive: true })
  await mkdir(join(OUT, 'scripts'), { recursive: true })

  const entries = await readdir(PLUGIN_SOURCE_DIR, { withFileTypes: true })
  let copied = 0
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const source = join(PLUGIN_SOURCE_DIR, entry.name)
    if (!existsSync(join(source, 'index.mjs'))) continue
    await copyPlugin(source, join(OUT, 'plugins', entry.name))
    copied += 1
  }

  await writeFile(join(OUT, 'scripts', 'build-market.mjs'), BUILD_SCRIPT, 'utf8')
  await writeFile(join(OUT, 'README.md'), README, 'utf8')
  await writeFile(join(OUT, '.gitignore'), 'node_modules/\n*.zip\n.DS_Store\n.tmp/\n', 'utf8')
  // 插件内容哈希与文件字节一一对应：禁止 Git 做 CRLF/LF 转换，确保下载到的
  // GitHub 压缩包与 market.json 中的 sha256 完全一致。
  await writeFile(join(OUT, '.gitattributes'), '* -text\n', 'utf8')
  for (const file of ['LICENSE', 'NOTICE', 'THIRD-PARTY-NOTICES.md']) {
    const source = join(ROOT, file)
    if (existsSync(source)) await copyFile(source, join(OUT, file))
  }

  const pluginCount = await writeMarketFiles()

  if (initGit) {
    try {
      await runGit(['init', '-b', 'main'])
      await runGit(['add', '-A'])
      console.log('✔ 已初始化 git 仓库并暂存文件（尚未 commit；请核对后 commit / push）')
    } catch (err) {
      console.warn(`跳过 git 初始化：${err?.message || err}`)
    }
  }

  console.log(`✔ 官方插件仓库脚手架已生成：${OUT}`)
  console.log(`  插件数量：${copied}（清单 ${pluginCount} 条）`)
  console.log(`  下一步：push 到 ${REPO_URL}`)
}

main().catch(err => {
  console.error('生成失败：', err?.message || err)
  process.exit(1)
})
