/**
 * 依赖许可证审计。
 *
 * 用法：node scripts/audit-dependencies.mjs
 * 输出：docs/DEPENDENCIES.md
 *
 * 包含：
 *   - package.json / node_modules 里的 Node 依赖
 *   - scripts/desktop-wrapper 的 Rust 依赖（cargo metadata --offline）
 *   - 宽松许可 / copyleft / 未知许可汇总
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const DESKTOP_CRATE = join(ROOT, 'scripts', 'desktop-wrapper')
const OUTPUT = join(ROOT, 'docs', 'DEPENDENCIES.md')

const COPYLEFT = /(^|[^A-Z])(A?GPL|LGPL|SSPL|CDDL|EPL|MPL|CPL|OSL|CC-BY-(NC|ND)|CC-BY-NC)/i

async function findPackageJsons(dir, depth = 0, out = []) {
  if (depth > 4) return out
  let entries = []
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (_) {
    return out
  }
  for (const entry of entries) {
    if (entry.name === '.bin') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue
      await findPackageJsons(full, depth + 1, out)
    } else if (entry.name === 'package.json') {
      out.push(full)
    }
  }
  return out
}

function readRustSnapshot(note) {
  try {
    const list = JSON.parse(readFileSync(join(ROOT, 'docs', 'rust-dependencies.json'), 'utf8'))
    return { packages: list, note: `${note}；已使用 docs/rust-dependencies.json 快照` }
  } catch (_) {
    return { packages: [], note: `${note}，且没有可用的 Rust 依赖快照` }
  }
}

function rustPackages() {
  let target = 'x86_64-pc-windows-msvc'
  try {
    const raw = execFileSync('cargo', ['-vV'], { encoding: 'utf8' })
    const match = raw.match(/^host:\s+(.+)$/m)
    if (match) target = match[1].trim()
  } catch (err) {
    return readRustSnapshot(`无法检测 Rust 工具链（${err.message}）`)
  }
  try {
    const raw = execFileSync(
      'cargo',
      ['metadata', '--offline', '--locked', '--format-version', '1', '--filter-platform', target],
      { cwd: DESKTOP_CRATE, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    )
    const meta = JSON.parse(raw)
    const packages = meta.packages.map(item => ({
      name: item.name,
      version: item.version,
      license: item.license || '(未标注)',
    }))
    return { packages, note: `Rust target: ${target}` }
  } catch (err) {
    return readRustSnapshot(`cargo metadata 不可用（${err.message}）`)
  }
}

function summarize(packages) {
  const byLicense = new Map()
  const copyleft = []
  const unknown = []
  for (const item of packages) {
    const license = item.license || '(未标注)'
    byLicense.set(license, (byLicense.get(license) || 0) + 1)
    if (license.includes('未标注')) unknown.push(`${item.name}@${item.version}`)
    if (COPYLEFT.test(license)) copyleft.push(`${item.name}@${item.version} (${license})`)
  }
  return { byLicense, copyleft, unknown }
}

function table(rows) {
  return ['| 包 | 版本 | 许可证 |', '|---|---|---|', ...rows].join('\n')
}

async function main() {
  const nodeRoot = join(ROOT, 'node_modules')
  const pkgFiles = await findPackageJsons(nodeRoot)
  const nodePackages = []
  for (const file of pkgFiles) {
    try {
      const data = JSON.parse(await readFile(file, 'utf8'))
      if (!data.name) continue
      nodePackages.push({
        name: data.name,
        version: data.version || '(unknown)',
        license: typeof data.license === 'string' ? data.license : '(未标注)',
        path: relative(ROOT, file).split(sep).join('/'),
      })
    } catch (_) {
      /* ignore invalid package.json */
    }
  }
  nodePackages.sort((a, b) => a.name.localeCompare(b.name))
  const rust = rustPackages()
  rust.packages.sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`))

  const nodeSummary = summarize(nodePackages)
  const rustSummary = summarize(rust.packages)
  const allCopyleft = [...nodeSummary.copyleft, ...rustSummary.copyleft]
  const allUnknown = [...nodeSummary.unknown, ...rustSummary.unknown]

  const lines = [
    '# 依赖与许可证清单',
    '',
    `> 由 \`scripts/audit-dependencies.mjs\` 自动生成，生成时间：${new Date().toISOString()}`,
    '> 这份清单用于发布前的依赖审查；如升级依赖，请重新运行 `npm run audit:deps`。',
    '',
    '## 结论摘要',
    '',
    `- Node 直接 / 运行时依赖：${nodePackages.length} 个`,
    `- Rust 依赖（当前平台可解析）：${rust.packages.length} 个`,
    `- copyleft / 非商业限制类许可证：${allCopyleft.length ? `发现 ${allCopyleft.length} 个，需要人工确认` : '未发现'}`,
    `- 未标注许可证：${allUnknown.length ? `发现 ${allUnknown.length} 个，需要人工确认` : '未发现'}`,
    '',
    '> 注意：许可证是否可用于商业场景，最终以各项目 LICENSE 原文为准；本文件不是法律意见。',
    '',
    '## Node / Web 依赖',
    '',
    nodePackages.length ? table(nodePackages.map(p => `| \`${p.name}\` | ${p.version} | ${p.license} |`)) : '_未发现已安装的 node_modules 依赖_',
    '',
    '## Rust / 桌面依赖',
    '',
    rust.note,
    '',
    rust.packages.length ? table(rust.packages.map(p => `| \`${p.name}\` | ${p.version} | ${p.license} |`)) : '_无（或 cargo metadata 不可用）_',
    '',
    '## 许可证分布',
    '',
    ...[...new Set([...nodeSummary.byLicense.keys(), ...rustSummary.byLicense.keys()])]
      .sort()
      .map(license => {
        const nodeCount = nodeSummary.byLicense.get(license) || 0
        const rustCount = rustSummary.byLicense.get(license) || 0
        return `- \`${license}\`：Node ${nodeCount} 个，Rust ${rustCount} 个`
      }),
    '',
    '## 发布前检查',
    '',
    '- [ ] 项目自身的 `LICENSE` / 版权归属已由发布方确认（当前为专有声明，可按需替换为 MIT / Apache-2.0 等）',
    '- [ ] 已随 Web 部署版携带 `THIRD-PARTY-NOTICES.md`',
    '- [ ] 桌面 exe 发布目录已携带 `THIRD-PARTY-NOTICES.md`',
    '- [ ] 若使用第三方模型 API（DeepSeek / OpenAI / Anthropic / Gemini 等），已阅读并遵守对应服务条款',
    '- [ ] 产品名称、Logo、图标涉及第三方商标时已完成授权确认',
    '- [ ] Node.js 与 WebView2 Runtime 的分发 / 依赖方式符合各自许可要求',
    '',
  ]

  await mkdir(dirname(OUTPUT), { recursive: true })
  await writeFile(OUTPUT, lines.join('\n'), 'utf8')
  console.log(`✔ 依赖清单已生成：${relative(ROOT, OUTPUT)}`)
  console.log(`  Node ${nodePackages.length} 个，Rust ${rust.packages.length} 个，copyleft ${allCopyleft.length} 个，未知 ${allUnknown.length} 个`)
}

main().catch(err => {
  console.error('依赖审计失败：', err)
  process.exit(1)
})
