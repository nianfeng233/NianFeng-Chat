/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * 零依赖代码风格检查。
 *
 * 只检查最容易在合并 / Windows 编辑器之间漂移、又完全不需要格式化工具的问题：
 *   - Tab 缩进
 *   - 行尾空白
 *   - CRLF / 混用行尾（.mjs 统一 LF）
 *   - 文件结尾缺少换行
 *
 * 用法：npm run check:style
 */
import { readdir, readFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const SCAN_ROOTS = ['src', 'plugins', 'server', 'scripts', 'start.mjs']
const SKIP_DIRS = new Set(['node_modules', '.git', '.tmp', '.local', 'release', 'data', 'user_data', 'vendor'])
const SKIP_FILES = new Set(['registry.mjs'])

async function collect(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) await collect(full, out)
    else if (entry.name.endsWith('.mjs') && !SKIP_FILES.has(entry.name)) out.push(full)
  }
  return out
}

const files = []
for (const root of SCAN_ROOTS) {
  const full = join(ROOT, root)
  if (root.endsWith('.mjs')) files.push(full)
  else await collect(full, files)
}

const issues = []
for (const file of files) {
  const text = await readFile(file, 'utf8')
  const rel = relative(ROOT, file).split(sep).join('/')
  if (text.includes('\t')) issues.push(`${rel}: 包含 Tab 缩进`)
  if (/\r/.test(text)) issues.push(`${rel}: 包含 CRLF 行尾（.mjs 应统一 LF）`)
  if (text.length && !text.endsWith('\n')) issues.push(`${rel}: 文件结尾缺少换行`)
  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    if (/[ \t]+$/.test(lines[index])) {
      issues.push(`${rel}:${index + 1}: 行尾有多余空白`)
      break
    }
  }
}

console.log(
  issues.length
    ? `✗ 代码风格检查未通过（${issues.length} 项）：`
    : `✔ 代码风格检查通过（${files.length} 个 .mjs 文件：LF / 无 Tab / 无行尾空白 / 以换行结尾）`,
)
for (const issue of issues.slice(0, 60)) console.error(`  ${issue}`)
if (issues.length > 60) console.error(`  … 还有 ${issues.length - 60} 项`)
process.exit(issues.length ? 1 : 0)
