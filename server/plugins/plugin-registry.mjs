/**
 * 后端 · plugin-registry
 * 内置插件 + 用户外部插件目录的统一扫描、清单合并与资源读取。
 *
 * 设计目标：
 *   - exe / Web 部署版的 runtime/app/plugins 是「随版本发布的内置插件」，
 *     升级时会被整体替换；用户自己的插件放在外部目录，升级不会丢。
 *   - 外部目录默认是 <数据目录>/plugins（因此数据目录外置后它也跟着外置），
 *     也可以在「设置 → 插件」里选择任意目录，或用环境变量 FENGYU_PLUGINS_DIR 指定。
 *   - 后端扫描目录并生成插件清单；前端 boot 时从 /api/plugins 取清单并动态加载。
 *     这样 exe 不需要内置 scripts/sync-plugins.mjs，用户丢完插件重启/重新扫描即可。
 */
import { constants } from 'node:fs'
import { access, mkdir, readdir, rm, stat } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, extname, join, normalize, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

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

  let builtinEntries = null
  let snapshot = null

  const envDir = () => String(process.env.FENGYU_PLUGINS_DIR || '').trim()
  const configuredDir = () => String(settings.get()?.plugins?.dir || '').trim()
  const defaultExternalDir = () => join(instance.info().dataDir, 'plugins')

  const normalizeExternalDir = input => {
    let value = String(input || '').trim()
    if (!value || value === '~') return value ? resolve(homedir()) : resolve(defaultExternalDir())
    if (value.startsWith('~/') || value.startsWith('~\\')) value = join(homedir(), value.slice(2))
    return resolve(value)
  }

  const externalDir = () => normalizeExternalDir(envDir() || configuredDir() || defaultExternalDir())

  const isInside = (parent, child) => {
    const p = resolve(parent)
    const c = resolve(child)
    return c === p || c.startsWith(p + sep)
  }

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

  /** 递归查找外部插件目录里的 index.mjs */
  async function walkPlugins(dir, out = []) {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (_) {
      return out
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walkPlugins(full, out)
      } else if (entry.isFile() && entry.name === 'index.mjs') {
        out.push(full)
      }
    }
    return out
  }

  /** 读取单个外部插件的元信息（在 Node 侧动态 import，与 sync-plugins 的做法一致） */
  async function readExternalEntry(file, root) {
    const info = await stat(file)
    const relFile = relative(root, file).split(sep).join('/')
    const folder = relative(root, dirname(file)).split(sep).join('/') || relFile.replace(/\/index\.mjs$/, '')
    const revision = Math.round(info.mtimeMs || Date.now())
    // 保持与内置插件相同的“三层目录”URL 结构，插件里 ../../../src/... 的相对引用仍可解析。
    const urlPath = '/user-plugins/' + relFile.split('/').map(encodeURIComponent).join('/') + '?v=' + revision
    const base = { external: true, source: 'external', path: urlPath, dir: folder, __file: file }
    try {
      const mod = await import(pathToFileURL(file).href + '?v=' + revision)
      return {
        ...base,
        id: mod.name || folder || relFile,
        name: mod.name || folder || relFile,
        version: mod.version || '0.0.0',
        displayName: mod.displayName || mod.name || folder || relFile,
        description: mod.description || '',
        author: mod.author || '',
        icon: mod.icon || '',
        core: !!mod.core,
        enabled: mod.enabled !== false,
        unavailable: mod.unavailable === true,
        unavailableReason: mod.unavailableReason || '',
        depends: mod.depends || {},
        inject: Array.isArray(mod.inject) ? mod.inject : mod.inject && typeof mod.inject === 'object' ? Object.keys(mod.inject) : [],
        provides: mod.provides || [],
        permissions: mod.permissions || [],
        slots: mod.slots || [],
        error: '',
      }
    } catch (err) {
      return {
        ...base,
        id: folder || relFile,
        name: folder || relFile,
        displayName: folder || relFile,
        version: '0.0.0',
        description: '',
        error: String(err?.message || err),
      }
    }
  }

  const publicEntry = ({ __file, ...rest }) => rest

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

  const publicSnapshot = value => ({
    plugins: value.plugins,
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
    hub.broadcast('plugins/changed', { action: 'dir-changed', externalDir: next.externalDir })
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
    hub.broadcast('plugins/changed', { action: 'removed', id })
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
    return { file: target, ext }
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

  const service = {
    name: 'plugin-registry',
    builtinDir: () => builtinDir,
    externalDir: () => externalDir(),
    defaultExternalDir: () => resolve(defaultExternalDir()),
    list: options => scan(options).then(publicSnapshot),
    dirs: () => scan().then(publicDirs),
    refresh: async () => {
      const next = await scan({ force: true })
      hub.broadcast('plugins/changed', { action: 'rescan', count: next.count })
      return publicSnapshot(next)
    },
    setExternalDir,
    resetExternalDir: () => setExternalDir(''),
    removeExternal,
    readExternalFile,
    openExternalDir,
    pickDirectory: () => instance.pickDirectory({ description: '选择插件的存放目录' }),
  }

  ctx.provide('pluginRegistry', service)
  ctx.logger.info(`插件注册表就绪：内置 ${builtinDir}，外部 ${externalDir()}`)
}
