/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目：念风 Chat（NianFeng-Chat）
 *
 * 把微信clawbot 渠道插件单独拎到 release/plugins/ 目录，便于单独分发。
 * 用法：npm run build:clawbot-plugin
 */
import { cp, copyFile, mkdir, readFile, rm } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const ROOT = join(fileURLToPath(new URL('..', import.meta.url)))
const PLUGIN_NAME = 'wechat-clawbot'
const packageRoot = join(ROOT, 'extensions', PLUGIN_NAME)
const sourceDir = join(packageRoot, 'channels', PLUGIN_NAME)
const releaseRoot = join(ROOT, 'release', 'plugins')
const targetDir = join(releaseRoot, PLUGIN_NAME)
const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'))
const version = JSON.parse(await readFile(join(sourceDir, 'manifest.json'), 'utf8')).version || pkg.version
const zipPath = join(releaseRoot, `${PLUGIN_NAME}-plugin-v${version}.zip`)

await rm(targetDir, { recursive: true, force: true })
await mkdir(targetDir, { recursive: true })
await cp(packageRoot, targetDir, { recursive: true })
for (const name of ['LICENSE', 'THIRD-PARTY-NOTICES.md']) {
  await copyFile(join(ROOT, name), join(targetDir, name)).catch(() => {})
}
console.log(`✔ 插件目录已生成：${relative(ROOT, targetDir)}`)

try {
  await rm(zipPath, { force: true })
  if (process.platform === 'win32') {
    // Windows 10+ 自带 bsdtar，可以直接创建 zip；失败再退回 PowerShell Compress-Archive。
    try {
      await execFileAsync('tar.exe', ['-a', '-c', '-f', zipPath, '-C', targetDir, '.'])
    } catch (_) {
      await execFileAsync('powershell.exe', [
        '-NoProfile',
        '-Command',
        `Compress-Archive -Path '${targetDir}\\*' -DestinationPath '${zipPath}' -Force`,
      ])
    }
    console.log(`✔ 插件压缩包已生成：${relative(ROOT, zipPath)}`)
  } else {
    console.log('ℹ 非 Windows 环境未自动压缩；可直接分发目录。')
  }
} catch (err) {
  console.warn(`⚠ 压缩包生成失败：${err.message}；目录已可用，可手动压缩。`)
}