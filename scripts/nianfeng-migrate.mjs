/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 *
 * 一次性迁移脚本：把历史命名（念风 / NianFeng / nianfeng / NIANFENG_）统一改为
 * 念风 / NianFeng / nianfeng / NIANFENG_，并给项目内所有文本文件补上
 * “念风chat”文件头标记。JSON 文件不支持注释，只做命名替换。
 */
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { extname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('..', import.meta.url)))
const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'release', '.tmp', 'user_data', 'data', 'dist', 'build',
  'target', 'coverage', '.edge-profile', '.npm-cache', '.cache',
])
const SKIP_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.svg', '.woff', '.woff2',
  '.ttf', '.otf', '.exe', '.dll', '.node', '.zip', '.tgz', '.tar', '.gz', '.7z', '.rar',
  '.pdf', '.db', '.sqlite', '.sqlite3', '.pyc', '.wasm', '.mp3', '.mp4', '.webm',
])
const SKIP_FILES = new Set(['LICENSE'])
const HEADER_MARK = '念风chat'
const REPO = 'https://github.com/nianfeng233/NianFeng-Chat'

function rebrand(text) {
  let out = String(text)
  out = out.replace(/https:\/\/github\.com\/nianfeng233\/nianfeng-chat/g, REPO)
  out = out.replace(/github\.com\/nianfeng233\/nianfeng-chat/g, 'github.com/nianfeng233/NianFeng-Chat')
  out = out.replace(/念风\s*·\s*AI\s*Chat/g, '念风Chat')
  out = out.replace(/念风\s+AI\s+Chat/g, '念风Chat')
  out = out.replace(/NianFeng\s*·\s*AI\s*Chat/g, 'NianFeng-Chat')
  out = out.replace(/NianFeng\s+AI\s+Chat/g, 'NianFeng-Chat')
  out = out.replace(/念风/g, '念风')
  out = out.replace(/NIANFENG_/g, 'NIANFENG_')
  out = out.replace(/NianFeng/g, 'NianFeng')
  out = out.replace(/NianFeng/g, 'NianFeng')
  out = out.replace(/nianfeng/g, 'nianfeng')
  out = out.replace(/念风\.exe/g, '念风Chat.exe')
  return out
}

function headerBlock(ext, fileName) {
  const lines = [
    '念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）',
    '项目全称：念风 Chat（NianFeng-Chat）',
    `仓库：${REPO}`,
  ]
  if (ext === '.html' || ext === '.htm' || ext === '.md' || ext === '.markdown') return `<!--\n${lines.join('\n')}\n-->`
  if (ext === '.mjs' || ext === '.js' || ext === '.cjs' || ext === '.css') return `/*\n * ${lines.join('\n * ')}\n */`
  if (ext === '.rs') return lines.map(line => `// ${line}`).join('\n')
  if (ext === '.cmd' || ext === '.bat') return lines.map(line => `rem ${line}`).join('\n')
  if (['.ps1', '.sh', '.py', '.toml', '.lock', '.yml', '.yaml', '.properties'].includes(ext)) {
    return lines.map(line => `# ${line}`).join('\n')
  }
  if (fileName === '.gitignore' || fileName === '.gitattributes' || ext === '.txt') {
    return lines.map(line => `# ${line}`).join('\n')
  }
  return lines.map(line => `// ${line}`).join('\n')
}

function insertHeader(text, ext, fileName) {
  if (!text.trim()) return text
  if (text.slice(0, 1500).includes(HEADER_MARK)) return text
  const nl = text.includes('\r\n') ? '\r\n' : '\n'
  const header = headerBlock(ext, fileName).replace(/\n/g, nl)
  if (ext === '.html' || ext === '.htm') {
    const match = text.match(/^(<!doctype[^>]*>\s*)/i)
    return match ? match[1] + header + nl + text.slice(match[1].length) : header + nl + text
  }
  if (ext === '.cmd' || ext === '.bat') {
    const match = text.match(/^(@echo\s+off[^\r\n]*\r?\n)/i)
    return match ? match[1] + header + nl + text.slice(match[1].length) : header + nl + text
  }
  if (text.startsWith('#!')) {
    const index = text.indexOf('\n')
    if (index >= 0) return text.slice(0, index + 1) + header + nl + text.slice(index + 1)
  }
  return header + nl + text
}

async function walk(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.gitignore' && entry.name !== '.gitattributes') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) await walk(full, out)
    } else if (entry.isFile()) {
      out.push(full)
    }
  }
  return out
}

const files = await walk(ROOT)
let changed = 0
for (const file of files) {
  const name = file.split(/[\\/]/).pop()
  const ext = extname(file).toLowerCase()
  if (SKIP_FILES.has(name) || SKIP_EXTS.has(ext)) continue
  let text = await readFile(file, 'utf8')
  const normalized = text.replace(/^\uFEFF/, '')
  let next = rebrand(normalized)
  if (ext !== '.json') next = insertHeader(next, ext, name)
  if (next !== text) {
    await writeFile(file, next, 'utf8')
    changed += 1
    console.log(relative(ROOT, file))
  }
}
console.log(`\n已完成：${changed} 个文件。`)
