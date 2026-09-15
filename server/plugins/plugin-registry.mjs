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
import { access, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
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
        optionalDepends: mod.optionalDepends || mod.softDepends || {},
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
    broadcastPluginsChanged({ action: 'dir-changed', externalDir: next.externalDir })
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
    broadcastPluginsChanged({ action: 'removed', id })
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

  /** 从 zip 条目里找出「插件根目录」：包含 index.mjs 的最外层目录（最多三层）。 */
  const findPluginRoots = entries => {
    const roots = new Set()
    for (const entry of entries) {
      if (entry.directory) continue
      const name = entry.name
      if (!/(^|\/)index\.mjs$/i.test(name)) continue
      if (/(^|\/)node_modules(\/|$)/i.test(name)) continue
      const root = name.slice(0, name.length - 'index.mjs'.length).replace(/\/$/, '')
      if (root.split('/').filter(Boolean).length > 3) continue
      roots.add(root)
    }
    const sorted = [...roots].sort((a, b) => a.split('/').filter(Boolean).length - b.split('/').filter(Boolean).length)
    const picked = []
    for (const root of sorted) {
      if (picked.some(parent => root === parent || root.startsWith(`${parent}/`))) continue
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

  /**
   * 安装浏览器上传的 zip 插件包：
   *   - data 是 base64（前端 FileReader 读取本地文件后上传，远程部署同样适用）；
   *   - 默认拒绝覆盖已存在的插件目录，overwrite=true 时才整体替换；
   *   - 路径、类型、体积都在这里做安全校验，只写入当前外部插件目录。
   */
  async function installZip({ base64 = '', filename = '', overwrite = false } = {}) {
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
    const roots = findPluginRoots(entries)
    if (!roots.length) return { ok: false, error: '压缩包里没有找到 index.mjs；请把插件目录（内含 index.mjs）压缩后再上传' }

    const rootDir = externalDir()
    await mkdir(rootDir, { recursive: true }).catch(() => {})
    const fallback = String(filename || '').replace(/\.zip$/i, '')

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
      if (exists) {
        if (!overwrite) return { ok: false, exists: true, pluginId: item.name, error: `插件目录「${item.name}」已存在，确认覆盖后可重试` }
        await rm(item.target, { recursive: true, force: true })
      }
    }

    const installed = []
    const blocked = []
    for (const item of planned) {
      await mkdir(item.target, { recursive: true })
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
        const dest = resolve(item.target, rel)
        if (!isInside(item.target, dest)) continue
        await mkdir(dirname(dest), { recursive: true })
        await writeFile(dest, entry.data)
        fileCount += 1
      }
      installed.push({ id: item.name, dir: item.target, files: fileCount })
    }

    const next = await scan({ force: true })
    broadcastPluginsChanged({ action: 'installed', ids: installed.map(item => item.id) })
    return {
      ok: true,
      installed,
      blocked: blocked.length ? blocked : undefined,
      plugins: publicSnapshot(next).plugins,
      dirs: publicDirs(next),
    }
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
      broadcastPluginsChanged({ action: 'rescan', count: next.count })
      return publicSnapshot(next)
    },
    setExternalDir,
    resetExternalDir: () => setExternalDir(''),
    removeExternal,
    readExternalFile,
    installZip,
    openExternalDir,
    pickDirectory: () => instance.pickDirectory({ description: '选择插件的存放目录' }),
  }

  ctx.provide('pluginRegistry', service)
  ctx.logger.info(`插件注册表就绪：内置 ${builtinDir}，外部 ${externalDir()}`)
}
