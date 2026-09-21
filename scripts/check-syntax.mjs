/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * 语法 + 模块图检查。
 * 用法：npm run check:kernels
 *
 * 逐个 import 所有 .mjs 源文件：任何语法错误或相对路径写错都会在这里暴露。
 * （插件模块顶层只做声明，不应有副作用，因此 import 是安全的。）
 */
import { readdir } from 'node:fs/promises'
import { basename, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
// extensions/ 是独立分发副本，目录层级与外置安装布局一致（/user-plugins/channels/...），
// 不适合在本仓库根目录下直接 import，因此语法检查跳过；内置源仍在 plugins/ 下。
// video/ 是本地宣传片工程，不参与本体模块图检查。
const SKIP_DIRS = new Set(['node_modules', '.git', '.edge-profile', 'scripts', 'release', '.tmp', '.local', 'user_data', 'data', 'extensions', 'video'])

async function walk(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) await walk(full, out)
    else if (entry.name.endsWith('.mjs')) out.push(full)
  }
  return out
}

const files = (await walk(ROOT))
  .filter(f => !f.endsWith(`${sep}server.mjs`))
  .filter(f => !basename(f).startsWith('_'))
  .sort()
let failed = 0
let checked = 0

for (const file of files) {
  const rel = relative(ROOT, file).split(sep).join('/')
  try {
    await import(`${pathToFileURL(file).href}?check=${Date.now()}`)
    checked++
  } catch (err) {
    failed++
    console.error(`x ${rel}`)
    console.error(`  ${err.name}: ${err.message}`)
  }
}

console.log(
  failed
    ? `\n${failed}/${files.length} 个模块检查失败`
    : `OK ${checked} 个 .mjs 模块语法与导入路径检查通过`,
)
process.exit(failed ? 1 : 0)
