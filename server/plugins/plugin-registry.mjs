/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * 后端 · plugin-registry
 * 内置插件 + 用户外部插件目录的统一扫描、清单合并与资源读取。
 *
 * 设计目标：
 *   - exe / Web 部署版的 runtime/app/plugins 是「随版本发布的内置插件」，
 *     升级时会被整体替换；用户自己的插件放在外部目录，升级不会丢。
 *   - 外部目录默认是 <数据目录>/plugins（因此数据目录外置后它也跟着外置），
 *     也可以在「设置 → 插件」里选择任意目录，或用环境变量 NIANFENG_PLUGINS_DIR 指定。
 *   - 后端扫描目录并生成插件清单；前端 boot 时从 /api/plugins 取清单并动态加载。
 *     这样 exe 不需要内置 scripts/sync-plugins.mjs，用户丢完插件重启/重新扫描即可。
 */
import { constants } from 'node:fs'
import { createHash } from 'node:crypto'
import { access, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, extname, join, normalize, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isInsideDir } from '../security-utils.mjs'
import { ZipError, isSafeZipEntryName, listZipEntries } from '../zip-utils.mjs'

export const name = 'plugin-registry'
export const inject = ['settings', 'instance', 'hub']

const SKIP_DIRS = new Set(['node_modules', '.git', '.tmp', '.cache'])
const EXTENSIONS = new Set([
  '.mjs', '.js', '.cjs', '.json', '.css', '.html', '.txt', '.md',
  '.svg', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.ico', '.woff2', '.wasm', '.map',
])

export function apply(ctx, config = {}) {
  const settings = ctx.settings
  const instance = ctx.instance
  const hub = ctx.hub
  const builtinDir = resolve(config.builtinDir || join(process.cwd(), 'plugins'))
  const appVersion = String(config.appVersion || '').trim()
  /* 进程级 build：/api/plugins 返回给 WebUI 插件清单缓存做版本校验。 */
  const build = String(config.build || '').trim()
  const appMajor = (() => {
    const parsed = Number.parseInt(String(appVersion).split('.')[0], 10)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 2
  })()
  const legacyReasonFor = version => `插件版本 ${version} 未适配念风 ${appMajor}.x，需升级到 ${appMajor}.x 兼容版本`

  let builtinEntries = null
  let snapshot = null

  const envDir = () => String(process.env.NIANFENG_PLUGINS_DIR || '').trim()
  const configuredDir = () => String(settings.get()?.plugins?.dir || '').trim()
  const defaultExternalDir = () => join(instance.info().dataDir, 'plugins')

  const normalizeExternalDir = input => {
    let value = String(input || '').trim()
    if (!value || value === '~') return value ? resolve(homedir()) : resolve(defaultExternalDir())
    if (value.startsWith('~/') || value.startsWith('~\\')) value = join(homedir(), value.slice(2))
    return resolve(value)
  }

  const externalDir = () => normalizeExternalDir(envDir() || configuredDir() || defaultExternalDir())

  /**
   * 广播插件目录变化：SSE 通知前端刷新，同时让后端启动器可选的 onPluginsChanged
   * 回调重启服务端代聊 Worker，使 QQ / NapCat 等渠道也能拿到新安装的外部插件工具。
   */
  const broadcastPluginsChanged = payload => {
    hub.broadcast('plugins/changed', payload)
    try {
      ctx.emit('plugins/changed', payload)
    } catch (_) {
      /* 没有后端监听者时忽略 */
    }
  }


  const isInside = (parent, child) => isInsideDir(parent, child)

  const canWrite = async dir => {
    try {
      await access(dir, constants.W_OK)
      return true
    } catch (_) {
      return false
    }
  }

  async function readBuiltinEntries() {
    if (builtinEntries) return builtinEntries
    try {
      const mod = await import(pathToFileURL(join(builtinDir, 'registry.mjs')).href)
      const list = Array.isArray(mod.plugins) ? mod.plugins : Array.isArray(mod.default) ? mod.default : []
      builtinEntries = list.map(entry => ({ ...entry, external: false, source: 'builtin' }))
    } catch (err) {
      ctx.logger.warn(`内置插件清单读取失败：${err.message}`)
      builtinEntries = []
    }
    return builtinEntries
  }

  /**
   * 递归查找外部插件目录里的 index.mjs。
   *
   * 关键边界：一旦某个目录本身包含 manifest.json（或非根目录下直接包含 index.mjs），
   * 就把它视为“一个插件根”，不再继续往它的 lib / vendor / node_modules 内部递归。
   * 否则插件自带的依赖包入口（例如 media-post/vendor/silk-wasm/lib/index.mjs）会被
   * 误识别成名为 lib 的独立插件，版本 0.0.0 → 被标红“旧版不兼容”。
   */
  async function walkPlugins(dir, out = [], depth = 0) {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (_) {
      return out
    }
    const fileNames = new Set(entries.filter(entry => entry.isFile()).map(entry => entry.name))
    const hasManifest = fileNames.has('manifest.json')
    const hasIndex = fileNames.has('index.mjs')
    if (hasManifest) {
      // 有清单的目录就是插件根：入口固定为同级 index.mjs，不再扫描内部 vendored 依赖。
      if (hasIndex) out.push(join(dir, 'index.mjs'))
      return out
    }
    if (hasIndex && depth > 0) {
      // 兼容旧版没有 manifest 的外部插件：同级 index.mjs 直接作为插件入口。
      out.push(join(dir, 'index.mjs'))
      return out
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue
      if (!entry.isDirectory()) continue
      await walkPlugins(join(dir, entry.name), out, depth + 1)
    }
    return out
  }

  /** 外部插件版本段里不再包含目录层级，避免影响插件相对 import 的深度计算。 */
  const REVISION_SKIP_DIRS = new Set([...SKIP_DIRS, 'release', 'target'])
  const MAX_REVISION_FILES = 3000

  /**
   * 计算插件目录的稳定 revision。
   *
   * 不能只看 index.mjs 的 mtime：插件升级常见情况是 index 没变、只替换了
   * lib/*.mjs。这里把目录内所有普通文件的大小 / mtime 纳入摘要，任一文件变化
   * 都会得到新的 revision，插件整棵模块图因此换到新的 URL 前缀下。
   */
  async function pluginRevision(root, fallbackFile, fallbackInfo) {
    const hash = createHash('sha1')
    let latest = Number(fallbackInfo?.mtimeMs) || 0
    let count = 0
    let truncated = false
    const addFile = async file => {
      const info = await stat(file)
      count += 1
      const mtime = Number(info.mtimeMs) || 0
      latest = Math.max(latest, mtime)
      hash.update(`${relative(root, file).split(sep).join('/')}:${Number(info.size) || 0}:${Math.round(mtime)}\n`)
    }
    const walk = async (dir, depth) => {
      if (depth > 8 || count >= MAX_REVISION_FILES) {
        truncated = true
        return
      }
      let entries = []
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch (_) {
        return
      }
      entries.sort((a, b) => a.name.localeCompare(b.name))
      for (const entry of entries) {
        if (entry.name.startsWith('.') || REVISION_SKIP_DIRS.has(entry.name)) continue
        const full = join(dir, entry.name)
        try {
          if (entry.isDirectory()) {
            await walk(full, depth + 1)
          } else if (entry.isFile()) {
            await addFile(full)
          }
        } catch (_) {
          /* 读不到的单个文件不阻断扫描 */
        }
        if (count >= MAX_REVISION_FILES) {
          truncated = true
          break
        }
      }
    }
    try {
      await walk(root, 0)
      if (!count && fallbackFile) await addFile(fallbackFile)
    } catch (_) {
      const mtime = Number(fallbackInfo?.mtimeMs) || Date.now()
      return `${Math.round(mtime).toString(36)}-fallback`
    }
    const digest = hash.digest('hex').slice(0, 12)
    return `${Math.round(latest).toString(36)}-${digest}${truncated ? 't' : ''}`
  }

  /** 读取单个外部插件的元信息（在 Node 侧动态 import，与 sync-plugins 的做法一致） */
  async function readExternalEntry(file, root) {
    const info = await stat(file)
    const dir = dirname(file)
    const relFile = relative(root, file).split(sep).join('/')
    const folder = relative(root, dir).split(sep).join('/') || relFile.replace(/\/index\.mjs$/, '')
    const revision = await pluginRevision(dir, file, info).catch(() => Math.round(info.mtimeMs || Date.now()).toString(36))
    // 版本段放在插件目录之前，插件内部的相对 import 会继续解析到
    // `/user-plugins/__nfv/<revision>/<folder>/...`，整棵模块图一起换版本。
    const urlPath = `/user-plugins/__nfv/${revision}/${relFile.split('/').map(encodeURIComponent).join('/')}`
    const base = { external: true, source: 'external', path: urlPath, dir: folder, __file: file }

    let manifest = null
    try {
      const parsed = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'))
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) manifest = parsed
    } catch (_) {
      manifest = null
    }

    try {
      const mod = await import(pathToFileURL(file).href + '?v=' + revision)
      const isPluginModule =
        typeof mod.apply === 'function' ||
        typeof mod.default === 'function' ||
        typeof mod.default?.apply === 'function'
      // 没有 manifest、也不具备 Cordis 插件形态的 index.mjs 只是插件内部依赖
      // （典型：vendor/silk-wasm/lib/index.mjs），不能当成外部插件扫描出来。
      if (!manifest && !isPluginModule) return null

      const pluginVersion = String(mod.version || manifest?.version || '0.0.0')
      const pluginMajor = Number.parseInt(pluginVersion.split('.')[0], 10)
      const legacy = !Number.isFinite(pluginMajor) || pluginMajor < appMajor
      const pluginId = mod.name || manifest?.id || manifest?.name || folder || relFile
      return {
        ...base,
        id: pluginId,
        name: mod.name || manifest?.name || manifest?.id || folder || relFile,
        version: pluginVersion,
        legacy,
        legacyReason: legacy ? legacyReasonFor(pluginVersion) : '',
        displayName: mod.displayName || manifest?.displayName || mod.name || manifest?.name || folder || relFile,
        description: mod.description || manifest?.description || '',
        author: mod.author || manifest?.author || '',
        icon: mod.icon || manifest?.icon || '',
        core: !!(mod.core || manifest?.core),
        enabled: mod.enabled !== undefined ? mod.enabled !== false : manifest?.enabled !== false,
        unavailable: mod.unavailable === true || manifest?.unavailable === true,
        unavailableReason: mod.unavailableReason || manifest?.unavailableReason || '',
        depends: mod.depends || manifest?.depends || {},
        optionalDepends: mod.optionalDepends || mod.softDepends || manifest?.optionalDepends || manifest?.optional_depends || {},
        inject: Array.isArray(mod.inject)
          ? mod.inject
          : mod.inject && typeof mod.inject === 'object'
            ? Object.keys(mod.inject)
            : Array.isArray(manifest?.inject)
              ? manifest.inject
              : manifest?.inject && typeof manifest.inject === 'object'
                ? Object.keys(manifest.inject)
                : [],
        provides: mod.provides || manifest?.provides || [],
        permissions: mod.permissions || manifest?.permissions || [],
        slots: mod.slots || manifest?.slots || [],
        // 运行范围：external 插件可通过 export const scope = 'server'|'webui'|'both'
        // 声明；默认 both，保持旧插件兼容。
        scope: mod.scope || mod.runtime || manifest?.scope || manifest?.runtime || 'both',
        error: '',
      }
    } catch (err) {
      return {
        ...base,
        id: manifest?.id || manifest?.name || folder || relFile,
        name: manifest?.name || manifest?.id || folder || relFile,
        displayName: manifest?.displayName || manifest?.name || folder || relFile,
        version: String(manifest?.version || '0.0.0'),
        description: manifest?.description || '',
        error: String(err?.message || err),
      }
    }
  }

  const publicEntry = ({ __file, ...rest }) => rest

  /**
   * 外部插件代码签名：包含进程 build 与每个插件入口的版本路径。
   *
   * 前端 / 服务端代聊都靠它区分“只是启停偏好变了（可以热同步）”与
   * “插件文件 / revision 变了（Node ESM 模块图必须换新，Worker 需重启）”。
   */
  const snapshotSignature = value =>
    createHash('sha256')
      .update(
        `${value?.build || ''}|${(value?.externalEntries || [])
          .map(entry => `${entry.id}:${entry.path}`)
          .sort()
          .join('|')}`,
      )
      .digest('hex')
      .slice(0, 24)

  async function scan({ force = false } = {}) {
    const root = externalDir()
    if (!force && snapshot && Date.now() - snapshot.scannedAt < 1500) return snapshot

    await mkdir(root, { recursive: true }).catch(() => {})
    const builtin = await readBuiltinEntries()
    const files = (await walkPlugins(root)).sort()
    const warnings = []
    const externalEntries = []
    const usedIds = new Set(builtin.map(entry => entry.id))

    for (const file of files) {
      const entry = await readExternalEntry(file, root)
      // 插件内部依赖包（vendor / lib 等）没有 manifest 也不是 Cordis 插件，直接忽略。
      if (!entry) continue
      if (entry.error) {
        warnings.push({ id: entry.id, level: 'error', message: `模块读取失败：${entry.error}` })
      }
      if (usedIds.has(entry.id)) {
        warnings.push({ id: entry.id, level: 'warn', message: '插件 id 与内置插件或其他外部插件重复，已跳过后一个' })
        continue
      }
      usedIds.add(entry.id)
      externalEntries.push(entry)
    }

    const plugins = [
      ...builtin.map(entry => ({ ...entry, external: false, source: 'builtin' })),
      ...externalEntries.map(publicEntry),
    ]

    snapshot = {
      plugins,
      build,
      builtinDir,
      externalDir: root,
      defaultExternalDir: resolve(defaultExternalDir()),
      envOverride: !!envDir(),
      configured: !!configuredDir(),
      writable: await canWrite(root),
      warnings,
      scannedAt: Date.now(),
      count: plugins.length,
      externalCount: externalEntries.length,
      externalEntries,
    }
    return snapshot
  }

  const publicDirs = value => ({
    builtinDir: value.builtinDir,
    externalDir: value.externalDir,
    defaultExternalDir: value.defaultExternalDir,
    envOverride: value.envOverride,
    configured: value.configured,
    writable: value.writable,
    warnings: value.warnings,
    scannedAt: value.scannedAt,
    count: value.count,
    externalCount: value.externalCount,
  })

  /**
   * 前端插件启停状态由共享 preferences 保存；随插件清单一起返回，
   * 浏览器 / 服务端代聊 Worker 在 boot 阶段就能按同一份状态加载，
   * 不会再出现“页面里卸载了，代聊 Worker 还加载着旧插件”的情况。
   */
  const pluginPreferences = () => {
    const prefs = settings.get()?.preferences?.plugins || {}
    const list = value => (Array.isArray(value) ? value.map(item => String(item || '').trim()).filter(Boolean) : [])
    return {
      disabled: list(prefs.disabled),
      removed: list(prefs.removed),
      enabled: list(prefs.enabled),
    }
  }

  const publicSnapshot = value => ({
    plugins: value.plugins,
    build: value.build || build,
    ...pluginPreferences(),
    ...publicDirs(value),
  })

  async function setExternalDir(input) {
    const raw = String(input || '').trim()
    if (!raw) {
      await settings.update({ plugins: { dir: '' } })
    } else {
      const target = normalizeExternalDir(raw)
      try {
        await mkdir(target, { recursive: true })
      } catch (err) {
        const error = new Error(`无法创建插件目录：${err.message}`)
        error.status = 400
        throw error
      }
      await settings.update({ plugins: { dir: target } })
    }
    const next = await scan({ force: true })
    broadcastPluginsChanged({ action: 'dir-changed', externalDir: next.externalDir, signature: snapshotSignature(next) })
    return publicDirs(next)
  }

  async function removeExternal(id) {
    const current = await scan({ force: true })
    const entry = current.externalEntries.find(item => item.id === id)
    if (!entry) return { ok: false, error: '没有找到该外部插件（只有外部插件可以通过这里删除文件）' }
    const target = dirname(entry.__file)
    if (!isInside(current.externalDir, target) || target === current.externalDir) {
      return { ok: false, error: '插件目录不合法，已拒绝删除' }
    }
    await rm(target, { recursive: true, force: true })
    const next = await scan({ force: true })
    broadcastPluginsChanged({ action: 'removed', id, signature: snapshotSignature(next) })
    return { ok: true, pluginId: id, dirs: publicDirs(next) }
  }

  async function readExternalFile(input) {
    const root = externalDir()
    let rel = String(input || '').replace(/^\/+/, '')
    if (!rel) return null
    try {
      rel = decodeURIComponent(rel)
    } catch (_) {
      /* 保持原样 */
    }
    // `/user-plugins/__nfv/<revision>/<plugin>/...`：revision 只用于浏览器 URL
    // 版本隔离，真实文件路径不包含该段。旧的无版本 URL 继续兼容。
    let versioned = false
    const versionMatch = /^__nfv\/[A-Za-z0-9._+-]{1,160}\/(.+)$/.exec(rel)
    if (versionMatch) {
      rel = versionMatch[1]
      versioned = true
    }
    if (!rel) return null
    const target = normalize(join(root, rel))
    if (!isInside(root, target)) return null
    const ext = extname(target).toLowerCase()
    if (!EXTENSIONS.has(ext)) return null
    try {
      const info = await stat(target)
      if (!info.isFile()) return null
    } catch (_) {
      return null
    }
    return { file: target, ext, versioned }
  }

  function openExternalDir() {
    const dir = externalDir()
    const done = () => {}
    try {
      if (process.platform === 'win32') execFile('explorer.exe', [dir], done)
      else if (process.platform === 'darwin') execFile('open', [dir], done)
      else execFile('xdg-open', [dir], done)
    } catch (_) {
      /* 打不开就算了，前端会提示路径 */
    }
    return { ok: true, dir }
  }

  /* ---------------- 上传安装 zip 插件 ---------------- */

  const BLOCKED_INSTALL_EXTENSIONS = new Set(['.exe', '.dll', '.bat', '.cmd', '.ps1', '.sh', '.com', '.scr', '.msi', '.node', '.so', '.dylib'])
  const MAX_ZIP_BYTES = 32 * 1024 * 1024

  const safeFolderName = value => {
    const name = String(value || '')
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/^[.\-\s]+|[.\-\s]+$/g, '')
      .slice(0, 64)
    return name || 'plugin'
  }

  /** 判断 child 是否就是 parent 本身，或位于 parent 目录内部；parent 为空表示 zip 根目录。 */
  const isSameOrInside = (parent, child) => {
    if (parent === child) return true
    if (parent === '') return child !== ''
    return child.startsWith(`${parent}/`)
  }

  /**
   * 从 zip 条目里找出「插件根目录」：包含 index.mjs 的最外层目录（最多三层）。
   *
   * 不能简单把所有 index.mjs 都当成插件：插件 zip 里常带 vendor/<包名>/lib/index.mjs
   * （例如 media-post 内置的 silk-wasm），如果把这类依赖入口也当成插件解压，
   * 会多出一个名为 lib、版本 0.0.0 的假插件并在插件页标红。
   *   1. 排除 npm 包内部的入口（该目录的某个祖先是 package.json 所在目录）；
   *   2. 当 zip 根目录本身就是一个插件根（有根 index.mjs）时，丢弃其所有嵌套根。
   */
  const findPluginRoots = entries => {
    const files = entries.filter(entry => !entry.directory)
    const packageDirs = new Set()
    for (const entry of files) {
      if (/(^|\/)package\.json$/i.test(entry.name)) {
        packageDirs.add(entry.name.slice(0, entry.name.length - 'package.json'.length).replace(/\/$/, ''))
      }
    }

    const roots = new Set()
    for (const entry of files) {
      const name = entry.name
      if (!/(^|\/)index\.mjs$/i.test(name)) continue
      if (/(^|\/)node_modules(\/|$)/i.test(name)) continue
      const root = name.slice(0, name.length - 'index.mjs'.length).replace(/\/$/, '')
      if (root.split('/').filter(Boolean).length > 3) continue
      // vendor/silk-wasm/lib/index.mjs 的某个非空祖先是 package.json 所在目录 → 依赖入口。
      let ancestor = root
      let insidePackage = false
      while (ancestor) {
        const slash = ancestor.lastIndexOf('/')
        ancestor = slash < 0 ? '' : ancestor.slice(0, slash)
        if (ancestor && packageDirs.has(ancestor)) {
          insidePackage = true
          break
        }
      }
      if (insidePackage) continue
      roots.add(root)
    }

    const sorted = [...roots].sort((a, b) => a.split('/').filter(Boolean).length - b.split('/').filter(Boolean).length)
    const picked = []
    for (const root of sorted) {
      if (picked.some(parent => isSameOrInside(parent, root))) continue
      picked.push(root)
    }
    return picked
  }

  const resolvePluginName = (pluginRoot, entries, fallback) => {
    const prefix = pluginRoot ? `${pluginRoot}/` : ''
    const manifest = entries.find(entry => !entry.directory && entry.name === `${prefix}manifest.json`)
    if (manifest) {
      try {
        const parsed = JSON.parse(manifest.data.toString('utf8'))
        const id = String(parsed.id || parsed.name || '').trim()
        if (id) return safeFolderName(id)
      } catch (_) {
        /* manifest 坏了就退回目录名 */
      }
    }
    const tail = pluginRoot.split('/').filter(Boolean).pop()
    return safeFolderName(tail || fallback || 'plugin')
  }

  /** 对 zip 条目中的实际文件做稳定内容哈希；与官方仓库 scripts/build-market.mjs 的算法一致。 */
  const hashPluginEntries = entries => {
    const hash = createHash('sha256')
    const files = entries
      .filter(entry => !entry.directory)
      .slice()
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of files) {
      const name = String(entry.name || '').replace(/\\/g, '/')
      const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data || '')
      hash.update(`file:${name}\n`)
      hash.update(`size:${data.length}\n`)
      hash.update(data)
      hash.update('\n')
    }
    return hash.digest('hex')
  }

  const rootManifestOf = entries => {
    const file = entries.find(entry => !entry.directory && String(entry.name).replace(/\\/g, '/') === 'manifest.json')
    if (!file) return null
    try {
      return JSON.parse(file.data.toString('utf8'))
    } catch (_) {
      return null
    }
  }

  /**
   * 安装已解析的 zip 条目（浏览器上传与插件市场共用）：
   *   - 默认拒绝覆盖已存在的插件目录，overwrite=true 时才整体替换；
   *   - 路径、类型、体积都在这里做安全校验，只写入当前外部插件目录；
   *   - expected 用于市场安装时校验插件 id / 版本 / 内容 SHA-256。
   */
  async function installZipEntries({ entries = [], filename = '', overwrite = false, expected = null } = {}) {
    if (!Array.isArray(entries) || !entries.length) return { ok: false, error: '压缩包内容为空' }

    const expectedId = expected?.id ? String(expected.id).trim() : ''
    const expectedVersion = expected?.version ? String(expected.version).trim() : ''
    let hashVerified = false
    if (expectedId && safeFolderName(expectedId) !== expectedId) return { ok: false, error: '市场插件 id 不合法' }

    const roots = findPluginRoots(entries)
    if (!roots.length) return { ok: false, error: '压缩包里没有找到 index.mjs；请把插件目录（内含 index.mjs）压缩后再上传' }
    if (roots.length > 1 && expectedId) return { ok: false, error: '市场来源的压缩包包含多个插件根，已拒绝安装' }

    const rootManifest = rootManifestOf(entries)
    if (rootManifest) {
      const manifestId = String(rootManifest.id || rootManifest.name || '').trim()
      if (expectedId && manifestId && safeFolderName(manifestId) !== expectedId) {
        return { ok: false, error: `插件 id 不一致：市场为 ${expectedId}，压缩包为 ${manifestId}` }
      }
      const manifestVersion = String(rootManifest.version || '').trim()
      if (expectedVersion && manifestVersion && manifestVersion !== expectedVersion) {
        return { ok: false, error: `插件版本不一致：市场为 ${expectedVersion}，压缩包为 ${manifestVersion}` }
      }
    }

    if (expected?.sha256) {
      const actualHash = hashPluginEntries(entries)
      const wanted = String(expected.sha256)
        .trim()
        .toLowerCase()
        .replace(/^sha(?:256)?[:-]/i, '')
      if (actualHash !== wanted) {
        return {
          ok: false,
          hashMismatch: true,
          expectedHash: wanted,
          actualHash,
          error: '插件内容哈希校验失败：压缩包可能与市场清单不一致，已拒绝安装',
        }
      }
      hashVerified = true
    }

    const rootDir = externalDir()
    await mkdir(rootDir, { recursive: true }).catch(() => {})
    const fallback = expectedId || String(filename || '').replace(/\.zip$/i, '')

    // 先算出所有目标目录并检查冲突，避免多个插件时装一半又失败。
    const planned = roots.map(pluginRoot => {
      const name = resolvePluginName(pluginRoot, entries, fallback)
      return { pluginRoot, name, target: resolve(rootDir, name) }
    })
    for (const item of planned) {
      if (!isInside(rootDir, item.target) || item.target === rootDir) return { ok: false, error: '插件安装目录不合法' }
      let exists = false
      try {
        exists = (await stat(item.target)).isDirectory()
      } catch (_) {
        /* 不存在 */
      }
      if (exists && !overwrite) return { ok: false, exists: true, pluginId: item.name, error: `插件目录「${item.name}」已存在，确认覆盖后可重试` }
      // 覆盖时不在这里删旧目录：先把新文件完整写进隐藏暂存目录，最后再整体替换，
      // 避免前端在文件写了一半时扫描并出现“大量插件一下子标红又恢复”。
    }

    const installed = []
    const blocked = []
    const staged = []
    let currentStage = ''
    try {
      for (const item of planned) {
        const suffix = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
        const stageDir = resolve(rootDir, `.${item.name}.installing-${suffix}`)
        if (!isInside(rootDir, stageDir) || stageDir === rootDir) throw new Error('插件暂存目录不合法')
        currentStage = stageDir
        await rm(stageDir, { recursive: true, force: true }).catch(() => {})
        await mkdir(stageDir, { recursive: true })
        const prefix = item.pluginRoot ? `${item.pluginRoot}/` : ''
        let fileCount = 0
        for (const entry of entries) {
          if (entry.directory || !isSafeZipEntryName(entry.name)) continue
          if (prefix) {
            if (!entry.name.startsWith(prefix)) continue
          } else if (roots.some(root => root && (entry.name === root || entry.name.startsWith(`${root}/`)))) {
            continue // 属于其它插件根，交给对应轮次
          }
          const rel = prefix ? entry.name.slice(prefix.length) : entry.name
          if (!rel || !isSafeZipEntryName(rel)) continue
          if (BLOCKED_INSTALL_EXTENSIONS.has(extname(rel).toLowerCase())) {
            blocked.push(`${item.name}/${rel}`)
            continue
          }
          const dest = resolve(stageDir, rel)
          if (!isInside(stageDir, dest)) continue
          await mkdir(dirname(dest), { recursive: true })
          await writeFile(dest, entry.data)
          fileCount += 1
        }
        staged.push({ ...item, stageDir, fileCount })
        currentStage = ''
      }

      // 全部暂存成功后再切换；此时外部插件目录里最多只有隐藏的 .installing-*，
      // 扫描会直接跳过，不会把半成品标成错误插件。
      for (const item of staged) {
        await rm(item.target, { recursive: true, force: true })
        await rename(item.stageDir, item.target)
        installed.push({ id: item.name, dir: item.target, files: item.fileCount })
      }
    } catch (err) {
      for (const item of staged) {
        try { await rm(item.stageDir, { recursive: true, force: true }) } catch (_) { /* ignore */ }
      }
      if (currentStage) {
        try { await rm(currentStage, { recursive: true, force: true }) } catch (_) { /* ignore */ }
      }
      return { ok: false, error: `插件安装失败：${err?.message || err}` }
    }

    const next = await scan({ force: true })
    broadcastPluginsChanged({ action: 'installed', ids: installed.map(item => item.id), signature: snapshotSignature(next) })
    return {
      ok: true,
      installed,
      hashVerified: hashVerified && blocked.length === 0,
      blocked: blocked.length ? blocked : undefined,
      plugins: publicSnapshot(next).plugins,
      dirs: publicDirs(next),
    }
  }

  /**
   * 安装浏览器上传的 zip 插件包：
   *   - data 是 base64（前端 FileReader 读取本地文件后上传，远程部署同样适用）；
   *   - 默认拒绝覆盖已存在的插件目录，overwrite=true 时才整体替换；
   *   - 路径、类型、体积都在这里做安全校验，只写入当前外部插件目录。
   */
  async function installZip({ base64 = '', filename = '', overwrite = false, expected = null } = {}) {
    const raw = String(base64 || '').replace(/^data:[^,]*,/, '')
    if (!raw) return { ok: false, error: '缺少压缩包内容（data）' }
    if (filename && !/\.zip$/i.test(String(filename))) return { ok: false, error: '只支持 .zip 插件压缩包' }
    let buffer = null
    try {
      buffer = Buffer.from(raw, 'base64')
    } catch (_) {
      return { ok: false, error: '压缩包 base64 解码失败' }
    }
    if (!buffer.length) return { ok: false, error: '压缩包内容为空' }
    if (buffer.length > MAX_ZIP_BYTES) return { ok: false, error: `压缩包超过 ${Math.round(MAX_ZIP_BYTES / 1024 / 1024)}MB 限制` }

    let entries = []
    try {
      entries = listZipEntries(buffer)
    } catch (err) {
      return { ok: false, error: err?.message || 'zip 解析失败' }
    }
    return installZipEntries({ entries, filename, overwrite, expected })
  }

  const service = {
    name: 'plugin-registry',
    builtinDir: () => builtinDir,
    externalDir: () => externalDir(),
    defaultExternalDir: () => resolve(defaultExternalDir()),
    list: options => scan(options).then(publicSnapshot),
    dirs: () => scan().then(publicDirs),
    signature: () => scan().then(snapshotSignature),
    refresh: async () => {
      const next = await scan({ force: true })
      broadcastPluginsChanged({ action: 'rescan', count: next.count, signature: snapshotSignature(next) })
      return publicSnapshot(next)
    },
    setExternalDir,
    resetExternalDir: () => setExternalDir(''),
    removeExternal,
    readExternalFile,
    installZip,
    installEntries: installZipEntries,
    openExternalDir,
    pickDirectory: () => instance.pickDirectory({ description: '选择插件的存放目录' }),
  }

  ctx.provide('pluginRegistry', service)
  ctx.logger.info(`插件注册表就绪：内置 ${builtinDir}，外部 ${externalDir()}`)
}
