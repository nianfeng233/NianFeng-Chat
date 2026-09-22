/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * 一键发布：提交发布工作树 → 打 tag → 推送 → 创建 GitHub Release。
 *
 * 前置条件：
 *   1. 已执行 npm run build:release
 *   2. 已执行 node scripts/prepare-publish.mjs（同步 release/publish 并完成安全扫描）
 *   3. release/publish 已配置 origin remote；gh 已登录（创建 Release 时需要）
 *
 * 用法：
 *   node scripts/publish-release.mjs --tag v0.41.0
 *   node scripts/publish-release.mjs --tag v0.41.0 --notes docs/releases/v0.41.0.md
 *   node scripts/publish-release.mjs --tag v0.41.0 --assets "release/a.exe,release/b.zip"
 *   node scripts/publish-release.mjs --tag v0.41.0 --dry-run
 *   node scripts/publish-release.mjs --tag v0.41.0 --no-release
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const PUBLISH_DIR = join(ROOT, 'release', 'publish')
const RELEASE_DIR = join(ROOT, 'release')

const args = new Map()
for (const item of process.argv.slice(2)) {
  const [key, value = 'true'] = item.replace(/^--/, '').split('=')
  args.set(key, value)
}
const tag = String(args.get('tag') || '').trim()
const dryRun = args.has('dry-run')
const createRelease = !args.has('no-release')
const notesFile = args.get('notes') ? resolve(ROOT, args.get('notes')) : ''
const repo = String(args.get('repo') || '').trim()
const skipPush = args.has('skip-push')

if (!tag || !/^v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(tag)) {
  console.error('请提供合法的发布 tag，例如 --tag v0.41.0（可带 -beta.1 等预发布后缀）')
  process.exit(1)
}
if (!existsSync(join(PUBLISH_DIR, '.git'))) {
  console.error(`发布工作树不存在或未初始化 Git：${PUBLISH_DIR}\n请先执行 npm run build:release 与 node scripts/prepare-publish.mjs`)
  process.exit(1)
}

const run = (command, commandArgs, options = {}) => {
  if (dryRun) {
    console.log(`[dry-run] ${command} ${commandArgs.join(' ')}`)
    return ''
  }
  return execFileSync(command, commandArgs, { cwd: options.cwd || PUBLISH_DIR, stdio: 'inherit', ...options })
}
const capture = (command, commandArgs, options = {}) =>
  execFileSync(command, commandArgs, { cwd: options.cwd || PUBLISH_DIR, encoding: 'utf8' }).trim()

const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
if (tag.replace(/^v/, '') !== version) {
  console.error(`版本号不一致：package.json = ${version}，tag = ${tag}`)
  process.exit(1)
}

// 1) 提交发布工作树
const dirty = capture('git', ['status', '--porcelain'])
if (dirty) {
  console.log('提交发布工作树变更…')
  run('git', ['add', '-A'])
  run('git', ['commit', '-m', `release: 念风Chat ${tag}`])
} else {
  console.log('发布工作树没有新变更，跳过提交')
}

// 2) 打 tag（已存在则中止，避免覆盖已发布版本）
const existingTag = dryRun ? '' : capture('git', ['tag', '--list', tag])
if (existingTag === tag) {
  console.error(`tag ${tag} 已存在；如需重新发布请升版本号`)
  process.exit(1)
}
run('git', ['tag', '-a', tag, '-m', `念风Chat ${tag}`])

// 3) 推送
if (!skipPush) {
  run('git', ['push', 'origin', 'HEAD'])
  run('git', ['push', 'origin', tag])
} else {
  console.log('已跳过 git push（--skip-push）')
}

// 4) 创建 GitHub Release 并上传附件
if (createRelease) {
  const assets = (args.get('assets') || '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean)
  if (!assets.length) {
    for (const file of readdirSync(RELEASE_DIR)) {
      if (/^nianfeng-(desktop|web-deploy|web-source).*\.(exe|zip)$/i.test(file)) assets.push(join(RELEASE_DIR, file))
    }
  }
  const missing = assets.filter(file => !existsSync(file))
  if (missing.length) {
    console.error(`Release 附件不存在：\n  ${missing.join('\n  ')}`)
    process.exit(1)
  }
  const releaseArgs = ['release', 'create', tag, ...assets]
  if (repo) releaseArgs.push('-R', repo)
  releaseArgs.push('--title', `念风Chat ${tag}`)
  if (notesFile && existsSync(notesFile)) releaseArgs.push('--notes-file', notesFile)
  else releaseArgs.push('--generate-notes')
  const prerelease = /-(alpha|beta|rc|preview)/i.test(tag)
  if (prerelease) releaseArgs.push('--prerelease')
  run('gh', releaseArgs, { cwd: ROOT })
}

console.log(`\n发布完成：${tag}`)
