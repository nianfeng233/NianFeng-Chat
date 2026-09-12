/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * 生成可分发版本。
 *
 * 输出目录（默认 release/）：
 *   web/source/       纯净源码（不带个人数据、不带 node_modules）
 *   web/deploy/       可部署的 Web 版（app/ + 便携 Node 运行时 + 启动脚本）
 *   desktop/source/   桌面壳源码（Rust + 无官方服务插件、含微信clawbot 内置渠道的运行时 app + 嵌入资源）
 *   desktop/deploy/   打包好的单文件 .exe（嵌入式 Node 运行时 + WebView2）
 *
 * 用法：
 *   node scripts/package-release.mjs                 # 两版都生成
 *   node scripts/package-release.mjs --web-only      # 只生成 Web 版
 *   node scripts/package-release.mjs --desktop-only  # 只生成桌面版
 *
 * 桌面版会移除 official-service 插件（账号页 / 内置模型入口一起消失），
 * 并把干净的 app 与 node.exe 一起嵌进 exe；首次运行解压到
 * %LOCALAPPDATA%\\NianFengChat，用户数据保存在
 * %LOCALAPPDATA%\\NianFengChat\\user_data。
 */
import { execFileSync } from 'node:child_process'
import { cp, copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
// 默认 release/；NIANFENG_RELEASE_DIR 可指向临时目录，避免旧 exe 正在运行锁住 release/desktop。
const RELEASE = resolve(process.env.NIANFENG_RELEASE_DIR || join(ROOT, 'release'))
const args = new Set(process.argv.slice(2))
const onlyWeb = args.has('--web-only')
const onlyDesktop = args.has('--desktop-only')
const buildId = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)

const SOURCE_SKIP_DIRS = new Set(['release', 'node_modules', '.git', '.tmp', 'user_data', 'data'])
/** 只跳过特定路径下的目录：避免把本机编译缓存（可能含绝对路径）打进源码包 */
const SOURCE_SKIP_RELATIVE_DIRS = new Set(['scripts/desktop-wrapper/target'])
const SOURCE_SKIP_FILE = name => /^[a-z0-9]+_html_\d{8}_[a-z0-9]+\.html$/i.test(name) || /\.log$/i.test(name) || name === '.DS_Store'

async function pathExists(path) {
  try {
    await stat(path)
    return true
  } catch (_) {
    return false
  }
}

async function copyTree(from, to, { skipDirs = new Set(), skipFile = () => false, transform } = {}) {
  await mkdir(to, { recursive: true })
  const entries = await readdir(from, { withFileTypes: true })
  for (const entry of entries) {
    const src = join(from, entry.name)
    const dst = join(to, entry.name)
    const rel = relative(ROOT, src).split(sep).join('/')
    if (entry.isDirectory()) {
      if (skipDirs.has(entry.name) || (transform && (await transform(src, rel, true)) === false)) continue
      await copyTree(src, dst, { skipDirs, skipFile, transform })
    } else {
      if (skipFile(entry.name) || (transform && (await transform(src, rel, false)) === false)) continue
      await mkdir(dirname(dst), { recursive: true })
      await copyFile(src, dst)
    }
  }
}

async function copyCleanSource(dest) {
  await copyTree(ROOT, dest, {
    skipDirs: SOURCE_SKIP_DIRS,
    skipFile: SOURCE_SKIP_FILE,
    transform: (_src, rel, isDir) => !(isDir && SOURCE_SKIP_RELATIVE_DIRS.has(rel)),
  })
}

async function copyRuntimeApp(dest, { keepOfficialService }) {
  await rm(dest, { recursive: true, force: true })
  await mkdir(dest, { recursive: true })
  const runtimeItems = ['index.html', 'package.json', 'start.mjs', 'public', 'src', 'server', 'plugins', 'node_modules', 'logo.png']
  for (const item of runtimeItems) {
    const src = join(ROOT, item)
    if (!(await pathExists(src))) continue
    await cp(src, join(dest, item), { recursive: true })
  }
  if (!keepOfficialService) {
    await rm(join(dest, 'plugins', 'features', 'official-service'), { recursive: true, force: true })
    await rewriteRegistryWithout(dest, 'official-service')
  }
}

/** 从 registry.mjs 里过滤掉某个插件，不依赖 node_modules / 动态 import */
async function rewriteRegistryWithout(appDir, removedId) {
  const file = join(appDir, 'plugins', 'registry.mjs')
  const source = await readFile(file, 'utf8')
  const marker = 'export const plugins = '
  const start = source.indexOf(marker)
  const end = source.lastIndexOf(']')
  if (start < 0 || end < start) throw new Error('无法解析 plugins/registry.mjs')
  const list = JSON.parse(source.slice(start + marker.length, end + 1))
  const filtered = list.filter(item => item?.id !== removedId)
  const next = source.slice(0, start + marker.length) + JSON.stringify(filtered, null, 2) + source.slice(end + 1)
  await writeFile(file, next, 'utf8')
}

async function listFilesRecursive(dir, base = dir) {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await listFilesRecursive(full, base)))
    else out.push(relative(base, full).split(sep).join('/'))
  }
  return out
}

async function generateDesktopAssets(crateDir, appDir, runtimeDir) {
  const files = await listFilesRecursive(appDir)
  const rows = files
    .sort()
    .map(file => `  (${JSON.stringify(file)}, include_bytes!(${JSON.stringify(`../app/${file}`)})),`)
    .join('\n')
  const source = `// 由 scripts/package-release.mjs 自动生成，请勿手改。\n` +
    `// ${new Date().toISOString()}\n\n` +
    `pub static APP_FILES: &[(&str, &[u8])] = &[\n${rows}\n];\n\n` +
    `pub static NODE_EXE: &[u8] = include_bytes!("../runtime/node.exe");\n\n` +
    `pub const BUILD_ID: &str = ${JSON.stringify(buildId)};\n`
  await writeFile(join(crateDir, 'src', 'app_assets.rs'), source, 'utf8')
  return files.length + 1
}

async function buildWebRelease() {
  const base = join(RELEASE, 'web')
  const sourceDir = join(base, 'source')
  const deployDir = join(base, 'deploy')
  const appDir = join(deployDir, 'app')
  const runtimeDir = join(deployDir, 'runtime')

  await rm(base, { recursive: true, force: true })
  await copyCleanSource(sourceDir)

  await copyCleanSource(appDir)
  for (const item of ['node_modules']) {
    const src = join(ROOT, item)
    if (await pathExists(src)) await cp(src, join(appDir, item), { recursive: true })
  }
  await mkdir(runtimeDir, { recursive: true })
  await copyFile(process.execPath, join(runtimeDir, 'node.exe'))
  for (const name of ['LICENSE', 'THIRD-PARTY-NOTICES.md']) {
    await copyFile(join(ROOT, name), join(deployDir, name)).catch(() => {})
  }
  await mkdir(join(deployDir, 'docs'), { recursive: true })
  for (const name of ['DEPENDENCIES.md', 'COMMERCIAL-USE.md']) {
    await copyFile(join(ROOT, 'docs', name), join(deployDir, 'docs', name)).catch(() => {})
  }

  await writeFile(
    join(deployDir, '启动念风.cmd'),
    [
      '@echo off',
      'chcp 65001 >nul',
      'setlocal',
      'set "NIANFENG_HOME_DIR=%~dp0"',
      '"%~dp0runtime\\node.exe" "%~dp0app\\start.mjs" --serve',
      'if errorlevel 1 pause',
      '',
    ].join('\r\n'),
    'utf8',
  )
  await writeFile(
    join(deployDir, '部署说明.txt'),
    [
      '念风chat · Web 可部署版',
      '',
      '1. 双击「启动念风.cmd」即可运行，程序会启动本地服务并自动打开默认浏览器。',
      '2. 首次启动会读取本机 AppData 的数据目录指针，自动恢复上次使用的数据；之后固定使用当前目录 user_data 下的指针，不会反复覆盖数据目录。删除 user_data 可恢复全新状态。',
      '3. 默认端口 5173，如果被占用会明确提示；可通过环境变量 WEB_PORT 修改。',
      '4. 本目录自带便携 Node 运行时（runtime/node.exe），无需另装 Node.js。',
      '5. 内置微信clawbot 渠道插件：添加渠道菜单选择「微信clawbot」，详情点「接入」扫码即可使用。',
      '6. 外部插件：默认放在本目录 user_data\\plugins\\（也可在「设置 → 插件 → 插件目录」指定任意目录），放入插件文件夹后重新扫描/刷新即可，无需重新生成 registry.mjs。',
      '',
    ].join('\r\n'),
    'utf8',
  )
  console.log(`✔ Web 版生成完成：${relative(ROOT, deployDir)}`)
}

/**
 * 编译桌面壳时的路径重映射：避免把本机用户名 / 目录结构编译进 exe。
 * rustc 的 panic / panic location 字符串会记录源码绝对路径；remap 后统一变成
 * /cargo、/rustup、/workspace 等中性前缀，发布二进制里不再出现本机路径。
 */
function desktopRustFlags() {
  const home = homedir()
  const pairs = []
  if (home) {
    pairs.push([`${home}\\.cargo`, '/cargo'])
    pairs.push([`${home}\\.rustup`, '/rustup'])
  }
  pairs.push([ROOT, '/workspace'])
  return pairs.map(([from, to]) => `--remap-path-prefix=${from}=${to}`)
}

async function buildDesktopRelease() {
  const base = join(RELEASE, 'desktop')
  const sourceRoot = join(base, 'source')
  const deployDir = join(base, 'deploy')
  const crateDir = join(sourceRoot, 'desktop')
  const appDir = join(crateDir, 'app')
  const runtimeDir = join(crateDir, 'runtime')

  await rm(base, { recursive: true, force: true })
  // target/ 是本机编译产物（可能包含绝对路径），绝不能进入交付源码。
  await copyTree(join(ROOT, 'scripts', 'desktop-wrapper'), crateDir, { skipDirs: new Set(['target']) })
  await copyRuntimeApp(appDir, { keepOfficialService: false })
  await mkdir(runtimeDir, { recursive: true })
  await copyFile(process.execPath, join(runtimeDir, 'node.exe'))
  const embeds = await generateDesktopAssets(crateDir, appDir, runtimeDir)

  // 许可证 / 第三方声明随源码与部署目录一起分发。
  for (const name of ['LICENSE', 'THIRD-PARTY-NOTICES.md']) {
    await copyFile(join(ROOT, name), join(sourceRoot, name)).catch(() => {})
  }
  await mkdir(join(sourceRoot, 'docs'), { recursive: true })
  for (const name of ['DEPENDENCIES.md', 'COMMERCIAL-USE.md']) {
    await copyFile(join(ROOT, 'docs', name), join(sourceRoot, 'docs', name)).catch(() => {})
  }

  await writeFile(
    join(sourceRoot, '构建桌面版.cmd'),
    [
      '@echo off',
      'chcp 65001 >nul',
      'cd /d "%~dp0desktop"',
      'rem 不把本机用户名 / 路径编译进 exe（与 package-release.mjs 的 remap 保持一致）',
      'if not defined RUSTFLAGS set "RUSTFLAGS=--remap-path-prefix=%USERPROFILE%\\.cargo=/cargo --remap-path-prefix=%USERPROFILE%\\.rustup=/rustup --remap-path-prefix=%~dp0..=/workspace"',
      'cargo build --release',
      'if errorlevel 1 ( echo 构建失败 & pause & exit /b 1 )',
      'if not exist "..\\deploy" mkdir "..\\deploy"',
      'copy /y "target\\release\\nianfeng-desktop.exe" "..\\deploy\\念风Chat.exe" >nul',
      'copy /y "..\\LICENSE" "..\\deploy\\LICENSE" >nul',
      'copy /y "..\\THIRD-PARTY-NOTICES.md" "..\\deploy\\THIRD-PARTY-NOTICES.md" >nul',
      'if exist "..\\docs" xcopy /e /i /y "..\\docs" "..\\deploy\\docs" >nul',
      'echo 已生成 ..\\deploy\\念风Chat.exe',
      'pause',
      '',
    ].join('\r\n'),
    'utf8',
  )
  await writeFile(
    join(sourceRoot, 'README.md'),
    [
      '# 念风桌面壳（Rust + WebView2）源码',
      '',
      '- `desktop/app/`：干净的运行时资源（不含 official-service，账号页与内置模型入口已按桌面版要求移除）。',
      '- `desktop/runtime/node.exe`：准备嵌入的便携 Node 运行时。',
      '- `desktop/src/`：Rust 桌面壳源码与自动生成的嵌入资源清单；首次运行会解压到 `%LOCALAPPDATA%\\NianFengChat`。',
      '',
      '构建：双击 `构建桌面版.cmd`，或执行 `cd desktop && cargo build --release`。',
      `本次打包嵌入文件数：${embeds}`,
      '',
    ].join('\r\n'),
    'utf8',
  )

  await mkdir(deployDir, { recursive: true })
  for (const name of ['LICENSE', 'THIRD-PARTY-NOTICES.md']) {
    await copyFile(join(ROOT, name), join(deployDir, name)).catch(() => {})
  }
  await mkdir(join(deployDir, 'docs'), { recursive: true })
  for (const name of ['DEPENDENCIES.md', 'COMMERCIAL-USE.md']) {
    await copyFile(join(ROOT, 'docs', name), join(deployDir, 'docs', name)).catch(() => {})
  }
  await writeFile(
    join(deployDir, '使用说明.txt'),
    [
      '念风chat · 无边框桌面版',
      '',
      '1. 双击「念风Chat.exe」启动，首次运行会自动释放资源（约 1~3 秒）。',
      '2. 无边框窗口，可以直接拖动顶部栏；右上角有最小化 / 最大化 / 关闭按钮。',
      '3. 首次启动会读取本机 AppData 指针并恢复历史数据目录；之后数据目录记录在 %LOCALAPPDATA%\\NianFengChat\\user_data\\instance.json，不会反复覆盖。',
      '4. 按念风官方服务插件要求，桌面版不包含账号页与内置模型入口；自定义模型 / 本地 Ollama 均可用。',
      '5. 第三方组件与许可证声明见本目录的 THIRD-PARTY-NOTICES.md。',
      '6. 内置微信clawbot 渠道插件：添加渠道菜单选择「微信clawbot」，详情点「接入」扫码。',
      '7. 内置 QQ官方机器人 渠道插件（当前仅私聊）：添加渠道选择「QQ官方机器人」，详情点「接入」后用手机 QQ 扫一扫二维码。',
      '8. 内置图片服务：Web 上传 / 渠道入站图片统一存到数据目录 images/，聊天记录只存 imageId，升级不会丢。',
      '9. 外部插件：默认放在 %LOCALAPPDATA%\\NianFengChat\\user_data\\plugins\\，也可在「设置 → 插件 → 插件目录」指定任意目录；放入插件文件夹后重新扫描/刷新即可，升级 exe 不会删除外部插件。',
      '',
    ].join('\r\n'),
    'utf8',
  )

  if (process.env.NIANFENG_SKIP_DESKTOP_BUILD === '1') {
    console.log('⏭ 已设置 NIANFENG_SKIP_DESKTOP_BUILD=1，跳过桌面编译。')
    console.log(`   请在 ${relative(ROOT, crateDir)} 执行 cargo build --release，并把 target\\release\\${process.platform === 'win32' ? 'nianfeng-desktop.exe' : 'nianfeng-desktop'} 复制为 ${relative(ROOT, join(deployDir, '念风Chat.exe'))}`)
    return
  }

  console.log('⏳ 正在编译桌面壳（首次编译需要一些时间）…')
  try {
    // CARGO_ENCODED_RUSTFLAGS 用 0x1f 分隔，路径含空格也不会被拆错。
    const encodedRustFlags = desktopRustFlags().join('\u001f')
    execFileSync('cargo', ['build', '--release', '--offline'], {
      cwd: crateDir,
      stdio: 'inherit',
      env: { ...process.env, CARGO_TERM_COLOR: 'always', CARGO_ENCODED_RUSTFLAGS: encodedRustFlags },
    })
  } catch (err) {
    console.error('无法自动调用 cargo。请确认已安装 Rust MSVC 工具链，并在 source/desktop 目录手动执行：cargo build --release')
    throw err
  }
  const exeName = process.platform === 'win32' ? 'nianfeng-desktop.exe' : 'nianfeng-desktop'
  await copyFile(join(crateDir, 'target', 'release', exeName), join(deployDir, '念风Chat.exe'))
  // Cargo 的 target 目录只用于本次编译，不进入交付源码。
  await rm(join(crateDir, 'target'), { recursive: true, force: true })
  console.log(`✔ 桌面版生成完成：${relative(ROOT, join(deployDir, '念风Chat.exe'))}`)
}

async function main() {
  const wantWeb = !onlyDesktop
  const wantDesktop = !onlyWeb
  await mkdir(RELEASE, { recursive: true })
  if (wantWeb) await buildWebRelease()
  if (wantDesktop) await buildDesktopRelease()
  await writeFile(
    join(RELEASE, 'README.md'),
    [
      '# 念风chat 分发目录',
      '',
      '由 `scripts/package-release.mjs` 自动生成，不含个人数据（user_data / data / .tmp / 本地配置）。',
      '',
      '## 目录结构',
      '',
      '- `web/source/`：纯净源码（不含 node_modules，适合推送到 GitHub）。',
      '- `web/deploy/`：Web 可部署版（内含 app、便携 Node 运行时与启动脚本）。',
      '- `desktop/source/`：桌面壳源码（Rust + WebView2 外壳 + 无 official-service 的运行时 app）。',
      '- `desktop/deploy/`：打包好的单文件 `念风Chat.exe`（已内嵌 Node 运行时与 app 资源，不含 official-service 插件）。',
      '',
      '## 说明',
      '',
      '- 两个版本都包含源码与可直接使用的部署产物。',
      '- 桌面版不包含官方服务插件，禁止账号页与「使用念风内置模型」入口。',
      '- 各目录均已携带 `LICENSE`、`THIRD-PARTY-NOTICES.md`；依赖清单见 `docs/DEPENDENCIES.md`。',
      '- 重新生成：`npm run build:release`（只生成桌面版：`npm run build:desktop`）。',
      '',
    ].join('\n'),
    'utf8',
  )
}

main().catch(err => {
  console.error('\n生成分发版本失败：', err)
  process.exit(1)
})
