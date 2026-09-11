/**
 * 从 release/web/source（package-release 生成的纯净源码）同步到 release/publish。
 * 同步后执行严格的敏感信息扫描；扫描不通过就中止。
 *
 * 用法：
 *   node scripts/prepare-publish.mjs
 *   node scripts/prepare-publish.mjs --source=release/web/source --dest=release/publish
 */
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const args = new Map(process.argv.slice(2).map(item => {
  const [key, value = 'true'] = item.replace(/^--/, '').split('=')
  return [key, value]
}))
const SOURCE = resolve(ROOT, args.get('source') || 'release/web/source')
const DEST = resolve(ROOT, args.get('dest') || 'release/publish')
const KEEP_GIT = true

const SKIP_NAMES = new Set(['.git', 'node_modules', '.tmp', 'data', 'user_data', 'release'])

async function copyTree(from, to) {
  await mkdir(to, { recursive: true })
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (KEEP_GIT && entry.name === '.git') continue
    if (SKIP_NAMES.has(entry.name)) continue
    const src = join(from, entry.name)
    const dst = join(to, entry.name)
    if (entry.isDirectory()) await copyTree(src, dst)
    else await cp(src, dst)
  }
}

async function removeTreeExceptGit(dir) {
  if (!existsSync(dir)) return
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === '.git') continue
    await rm(join(dir, entry.name), { recursive: true, force: true })
  }
}

const TEXT_EXT = /\.(mjs|js|cjs|json|md|txt|html|css|ps1|cmd|rs|toml|yml|yaml|gitattributes|gitignore|notice|license)$/i
const SKIP_SCAN_FILE = /^(deepseek_html_.*\.html|.*\.log)$/i

const escapeRegExp = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const localUser = String(process.env.USERNAME || process.env.USER || '').trim()
const homeDir = homedir()

// 规则动态生成：不在脚本里写死本机用户名 / 工作区绝对路径，
// 否则扫描会命中脚本自身，导致发布门禁永远无法通过。
const RULES = [
  ['Windows 用户路径', /C:\\Users\\(?!Public\b|Default\b|All Users\b)[A-Za-z0-9_.\-]+/g],
  ['开发机项目路径', new RegExp(escapeRegExp(ROOT), 'gi')],
  ['API Key (sk-)', /sk-[A-Za-z0-9]{20,}/g],
  ['GitHub Token', /(ghp_|gho_|github_pat_)[A-Za-z0-9_]{20,}/g],
  ['AWS Key', /AKIA[0-9A-Z]{16}/g],
  ['Google Key', /AIza[0-9A-Za-z_\-]{30,}/g],
  ['Slack Token', /xox[baprs]-[A-Za-z0-9-]{10,}/g],
  ['私钥', /-----BEGIN [A-Z ]*PRIVATE KEY/g],
  ['邮箱', /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g],
  ['手机号', /(?<!\d)1[3-9]\d{9}(?!\d)/g],
  ['身份证号', /(?<!\d)\d{17}[\dXx](?!\d)/g],
  ['疑似令牌', /(token|secret|password|passwd)\s*[:=]\s*["']?[A-Za-z0-9_\-]{16,}/gi],
]
if (localUser && localUser.length >= 3) RULES.unshift(['本机用户名', new RegExp(escapeRegExp(localUser), 'g')])
if (homeDir) RULES.unshift(['本机用户目录', new RegExp(escapeRegExp(homeDir), 'gi')])

const SENSITIVE_FILES = new Set(['config.json', 'sessions.json', '.secret-key', 'instance.json', '.env'])

async function scan(dir) {
  const hits = []
  const files = []
  const walk = async current => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.name === '.git') continue
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.tmp' || entry.name === 'user_data' || entry.name === 'data') {
          hits.push({ file: relative(dir, full), rule: '禁止目录', value: entry.name })
          continue
        }
        await walk(full)
        continue
      }
      files.push(full)
      if (SENSITIVE_FILES.has(entry.name)) hits.push({ file: relative(dir, full), rule: '敏感文件', value: entry.name })
      if (!TEXT_EXT.test(entry.name) || SKIP_SCAN_FILE.test(entry.name)) continue
      const text = await readFile(full, 'utf8')
      for (const [rule, regex] of RULES) {
        regex.lastIndex = 0
        let match
        while ((match = regex.exec(text))) {
          const line = text.slice(0, match.index).split('\n').length
          hits.push({ file: relative(dir, full), line, rule, value: match[0].slice(0, 80) })
          if (match[0].length === 0) break
        }
      }
    }
  }
  await walk(dir)
  // 计算内容指纹，便于确认推送的确实是这一份
  const hash = createHash('sha256')
  for (const file of files.sort()) {
    hash.update(relative(dir, file).split(sep).join('/'))
    hash.update(await readFile(file))
  }
  return { hits, files: files.length, sha256: hash.digest('hex') }
}

if (!existsSync(SOURCE)) {
  console.error(`源目录不存在：${SOURCE}（先执行 npm run build:release）`)
  process.exit(1)
}

console.log(`同步纯净源码：${relative(ROOT, SOURCE)} → ${relative(ROOT, DEST)}`)
await removeTreeExceptGit(DEST)
await copyTree(SOURCE, DEST)

const result = await scan(DEST)
console.log(`文件数：${result.files}，内容 SHA-256：${result.sha256}`)
if (result.hits.length) {
  console.error('\n发现可疑内容，已中止发布：')
  for (const hit of result.hits.slice(0, 100)) {
    console.error(`  ${hit.file}${hit.line ? ':' + hit.line : ''} [${hit.rule}] ${hit.value}`)
  }
  console.error(`\n共 ${result.hits.length} 条，请先清理后再发布。`)
  process.exit(2)
}
console.log('安全扫描通过：未发现用户名、本机路径、凭据、私钥、邮箱、手机号或用户数据文件。')
await writeFile(join(DEST, '..', '.publish-meta.json'), JSON.stringify({ source: relative(ROOT, SOURCE), files: result.files, sha256: result.sha256, scannedAt: new Date().toISOString() }, null, 2) + '\n', 'utf8')
