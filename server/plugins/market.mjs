/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * 后端 · plugin-market
 * 插件市场服务：
 *   - 读取官方 / 自定义市场索引，再把索引里的每个仓库清单合并成统一目录；
 *   - 所有网络请求走 net-guard 的 SSRF 防护，安装包只从已校验的公开地址下载；
 *   - 安装前校验插件 id / 版本 / SHA-256，拒绝内容与清单不一致的压缩包；
 *   - 支持 GitHub 有 release / 无 release / 单仓库单插件 / 单仓库多插件等格式。
 *
 * 索引与清单格式见 src/shared/market-format.mjs。
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { compareVersions } from '../../src/runtime/semver.mjs'
import {
  MARKET_DEFAULT_BRANCH,
  MARKET_MANIFEST_FILENAMES,
  OFFICIAL_MARKET_BRANCH,
  OFFICIAL_MARKET_INDEX_URL,
  OFFICIAL_MARKET_REPO,
  githubRawUrl,
  isGithubRepoUrl,
  normalizeHash,
  normalizeMarketPlugin,
  normalizePluginPath,
  parseGithubRepo,
  parseMarketIndex,
  safePluginId,
} from '../../src/shared/market-format.mjs'
import { fetchPublicBuffer, fetchPublicText } from '../net-guard.mjs'
import { isSafeZipEntryName, listZipEntries } from '../zip-utils.mjs'

export const name = 'plugin-market'
export const version = '1.0.0'
export const displayName = '插件市场'
export const description = '业务服务 · 市场索引 / 仓库清单拉取、哈希校验与插件安装。'
export const author = '念风内核'
export const icon = '🛍️'
export const core = true
export const enabled = true
export const depends = {}
export const optionalDepends = {}
export const inject = ['settings', 'instance', 'pluginRegistry', 'httpApi']

const CACHE_VERSION = 1
const DEFAULT_CACHE_TTL = 30 * 60 * 1000
const REPO_INFO_TTL = 30 * 60 * 1000
const MARKET_MAX_BYTES = 4 * 1024 * 1024
const ZIP_MAX_BYTES = 32 * 1024 * 1024
const REPO_CONCURRENCY = 4

const JSON_HEADERS = {
  'User-Agent': 'NianFeng-Chat-Market/1.0',
  Accept: 'application/json, text/plain, */*',
}
const GITHUB_HEADERS = {
  'User-Agent': 'NianFeng-Chat-Market/1.0',
  Accept: 'application/vnd.github+json',
}
const ARCHIVE_HEADERS = {
  'User-Agent': 'NianFeng-Chat-Market/1.0',
  Accept: 'application/zip, application/octet-stream, */*',
}

const MIRROR_SOURCE_ID = 'github-mirror'
const SOURCE_DEFAULT_VERSION = 2
const GITHUB_MIRROR_PROXIES = ['https://ghproxy.net/', 'https://gh-proxy.com/', 'https://ghfast.top/']

const sha256Hex = value => createHash('sha256').update(value).digest('hex')

async function mapLimit(items, limit, fn) {
  const list = [...items]
  const results = new Array(list.length)
  let cursor = 0
  const workers = Array.from({ length: Math.max(1, Math.min(Number(limit) || 1, list.length || 1)) }, async () => {
    while (cursor < list.length) {
      const index = cursor
      cursor += 1
      results[index] = await fn(list[index], index)
    }
  })
  await Promise.all(workers)
  return results
}

const asTimestamp = value => {
  if (!value) return 0
  const parsed = typeof value === 'number' ? value : Date.parse(String(value))
  return Number.isFinite(parsed) ? parsed : 0
}

export function apply(ctx) {
  const settings = ctx.settings
  const instance = ctx.instance
  const registry = ctx.pluginRegistry
  const http = ctx.httpApi

  const dataDir = () => instance.info().dataDir
  const cacheFile = () => join(dataDir(), 'market-cache.json')
  const installedFile = () => join(dataDir(), 'market-installed.json')

  let diskCache = null
  let diskCacheDir = ''
  let cacheWriteChain = Promise.resolve()
  /** sourceId -> { at, source, plugins, warnings } */
  const catalogs = new Map()
  /** owner/repo -> { at, data, error } */
  const repoInfos = new Map()
  const inflightCatalogs = new Map()
  const inflightRepoInfos = new Map()

  const marketSettings = () => (settings.get()?.market && typeof settings.get().market === 'object' ? settings.get().market : {})
  const cacheTtl = () => Math.max(60 * 1000, Number(marketSettings().cacheTtlMs) || DEFAULT_CACHE_TTL)
  const officialIndexUrl = () =>
    String(process.env.NIANFENG_MARKET_INDEX_URL || marketSettings().officialIndexUrl || '').trim() || OFFICIAL_MARKET_INDEX_URL

  const mirrorIndexUrls = () => {
    const base = officialIndexUrl()
    const list = GITHUB_MIRROR_PROXIES.map(proxy => `${proxy}${base}`)
    if (base === OFFICIAL_MARKET_INDEX_URL) {
      list.push(`https://cdn.jsdelivr.net/gh/nianfeng233/NianFeng-Chat-Plugins@main/index.json`)
    }
    list.push(base)
    return [...new Set(list)]
  }

  const officialSource = () => ({
    id: 'official',
    name: '念风官方插件源',
    url: officialIndexUrl(),
    repo: OFFICIAL_MARKET_REPO,
    branch: OFFICIAL_MARKET_BRANCH,
    official: true,
    builtin: true,
    mirror: false,
  })

  /** 国内 GitHub 加速镜像：默认源，网络不可达时用户可手动切回官方源。 */
  const mirrorSource = () => ({
    id: MIRROR_SOURCE_ID,
    name: '国内 GitHub 镜像源',
    url: mirrorIndexUrls()[0],
    urls: mirrorIndexUrls(),
    repo: OFFICIAL_MARKET_REPO,
    branch: OFFICIAL_MARKET_BRANCH,
    official: false,
    builtin: true,
    mirror: true,
    githubProxies: GITHUB_MIRROR_PROXIES,
  })

  const normalizeCustomSource = raw => {
    if (!raw || typeof raw !== 'object') return null
    const url = String(raw.url || raw.indexUrl || '').trim()
    if (!/^https?:\/\//i.test(url)) return null
    const id = safePluginId(raw.id || `custom-${sha256Hex(url).slice(0, 12)}`)
    if (!id || id === 'official' || id === MIRROR_SOURCE_ID) return null
    return {
      id,
      name: String(raw.name || '').trim().slice(0, 60) || id,
      url,
      repo: String(raw.repo || '').trim(),
      branch: String(raw.branch || '').trim(),
      official: false,
      builtin: false,
      mirror: false,
      githubProxies: [],
      urls: [url],
    }
  }

  const customSources = () => {
    const list = marketSettings().sources
    return Array.isArray(list) ? list.map(normalizeCustomSource).filter(Boolean) : []
  }

  const allSources = () => [officialSource(), mirrorSource(), ...customSources()]

  const sourceById = id => {
    const wanted = String(id || '').trim()
    if (!wanted) return mirrorSource()
    return allSources().find(source => source.id === wanted) || null
  }

  let sourceDefaultsEnsured = false
  const ensureSourceDefaults = async () => {
    if (sourceDefaultsEnsured) return
    sourceDefaultsEnsured = true
    try {
      const current = marketSettings()
      if (Number(current.sourceDefaultVersion) >= SOURCE_DEFAULT_VERSION) return
      const next = { ...current, sourceDefaultVersion: SOURCE_DEFAULT_VERSION }
      // 旧版本默认官方源；升级后默认切到国内镜像，用户主动选回官方源后会保持。
      if (!current.activeSourceId || current.activeSourceId === 'official') next.activeSourceId = MIRROR_SOURCE_ID
      await settings.update({ market: next })
    } catch (err) {
      ctx.logger.debug(`插件市场默认源初始化失败：${err?.message || err}`)
    }
  }

  const activeSourceId = () => {
    const wanted = String(marketSettings().activeSourceId || '').trim()
    if (wanted && sourceById(wanted)) return wanted
    return sourceById(MIRROR_SOURCE_ID) ? MIRROR_SOURCE_ID : 'official'
  }

  const saveSources = async (sources, nextActiveId) => {
    await settings.update({
      market: {
        sources: sources
          .filter(source => !source.builtin)
          .map(source => ({
            id: source.id,
            name: source.name,
            url: source.url,
            repo: source.repo || '',
            branch: source.branch || '',
          })),
        activeSourceId: nextActiveId || activeSourceId(),
      },
    })
  }

  const loadDiskCache = async () => {
    const dir = dataDir()
    if (diskCache && diskCacheDir === dir) return diskCache
    diskCache = { version: CACHE_VERSION, catalogs: {}, repoInfo: {} }
    diskCacheDir = dir
    try {
      const parsed = JSON.parse(await readFile(cacheFile(), 'utf8'))
      if (parsed && typeof parsed === 'object') {
        diskCache = {
          version: CACHE_VERSION,
          catalogs: parsed.catalogs && typeof parsed.catalogs === 'object' ? parsed.catalogs : {},
          repoInfo: parsed.repoInfo && typeof parsed.repoInfo === 'object' ? parsed.repoInfo : {},
        }
      }
    } catch (_) {
      /* 首次运行没有缓存 */
    }
    for (const [key, value] of Object.entries(diskCache.catalogs)) {
      if (value && Array.isArray(value.plugins)) catalogs.set(key, value)
    }
    for (const [key, value] of Object.entries(diskCache.repoInfo)) {
      if (value && typeof value === 'object') repoInfos.set(key, value)
    }
    return diskCache
  }

  const saveDiskCache = () => {
    const pending = async () => {
      const cache = diskCache || { version: CACHE_VERSION, catalogs: {}, repoInfo: {} }
      cache.catalogs = Object.fromEntries([...catalogs.entries()])
      cache.repoInfo = Object.fromEntries([...repoInfos.entries()])
      await mkdir(dataDir(), { recursive: true }).catch(() => {})
      await writeFile(cacheFile(), JSON.stringify(cache, null, 2), 'utf8')
    }
    cacheWriteChain = cacheWriteChain.then(pending, pending).catch(() => {})
    return cacheWriteChain
  }

  const readInstalledMeta = async () => {
    try {
      const parsed = JSON.parse(await readFile(installedFile(), 'utf8'))
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    } catch (_) {
      return {}
    }
  }

  const writeInstalledMeta = async (id, meta) => {
    const current = await readInstalledMeta()
    current[id] = { ...(current[id] || {}), ...meta, updatedAt: Date.now() }
    await mkdir(dataDir(), { recursive: true }).catch(() => {})
    await writeFile(installedFile(), JSON.stringify(current, null, 2), 'utf8')
    return current
  }

  const githubRaw = (repoUrl, branch, file) => {
    if (isGithubRepoUrl(repoUrl)) return githubRawUrl(repoUrl, branch || MARKET_DEFAULT_BRANCH, file)
    try {
      const base = new URL(repoUrl.endsWith('/') ? repoUrl : `${repoUrl}/`)
      return new URL(file, base).href
    } catch (_) {
      return ''
    }
  }

  const isGithubHostUrl = value =>
    /^https:\/\/(raw\.githubusercontent\.com|github\.com|codeload\.github\.com|api\.github\.com)\//i.test(String(value || ''))

  /** 镜像源优先走加速前缀，最后一个候选才是 GitHub 原地址。 */
  const mirrorUrlCandidates = (url, source) => {
    const candidates = [url]
    if (source?.mirror && Array.isArray(source.githubProxies) && isGithubHostUrl(url)) {
      for (const proxy of source.githubProxies) candidates.unshift(`${proxy}${url}`)
    }
    return [...new Set(candidates.filter(Boolean))]
  }

  const fetchTextFirst = async (urls, options = {}) => {
    let lastError = null
    for (const url of urls) {
      try {
        return await fetchPublicText(url, { headers: JSON_HEADERS, timeoutMs: 12000, maxBytes: MARKET_MAX_BYTES, ...options })
      } catch (err) {
        lastError = err
      }
    }
    throw lastError || new Error('没有可用的下载地址')
  }

  const fetchBufferFirst = async (urls, options = {}) => {
    let lastError = null
    for (const url of urls) {
      try {
        return await fetchPublicBuffer(url, options)
      } catch (err) {
        lastError = err
      }
    }
    throw lastError || new Error('没有可用的下载地址')
  }

  const fetchJsonText = async (url, { source = null, timeoutMs = 12000, maxBytes = MARKET_MAX_BYTES } = {}) => {
    const result = await fetchTextFirst(mirrorUrlCandidates(url, source), { timeoutMs, maxBytes })
    return result.text
  }

  const fetchRepoInfo = async (repoUrl, source = null) => {
    const parsed = parseGithubRepo(repoUrl)
    if (!parsed) return null
    const key = `${parsed.owner}/${parsed.repo}`.toLowerCase()
    const cached = repoInfos.get(key)
    if (cached && Date.now() - Number(cached.at || 0) < REPO_INFO_TTL) return cached.data || null
    if (inflightRepoInfos.has(key)) return inflightRepoInfos.get(key)
    const task = (async () => {
      try {
        const apiUrl = `https://api.github.com/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}`
        const result = await fetchTextFirst(mirrorUrlCandidates(apiUrl, source), {
          headers: GITHUB_HEADERS,
          timeoutMs: 8000,
          maxBytes: 200000,
        })
        const data = JSON.parse(result.text)
        const info = {
          fullName: String(data.full_name || ''),
          owner: String(data.owner?.login || parsed.owner),
          author: String(data.owner?.login || ''),
          avatar: String(data.owner?.avatar_url || ''),
          stars: Number.isFinite(Number(data.stargazers_count)) ? Number(data.stargazers_count) : null,
          homepage: String(data.homepage || ''),
          description: String(data.description || ''),
          defaultBranch: String(data.default_branch || MARKET_DEFAULT_BRANCH),
          pushedAt: asTimestamp(data.pushed_at),
          updatedAt: asTimestamp(data.updated_at),
          license: String(data.license?.spdx_id || data.license?.name || ''),
        }
        repoInfos.set(key, { at: Date.now(), data: info, error: '' })
        saveDiskCache()
        return info
      } catch (err) {
        repoInfos.set(key, { at: Date.now(), data: null, error: String(err?.message || err) })
        saveDiskCache()
        return null
      } finally {
        inflightRepoInfos.delete(key)
      }
    })()
    inflightRepoInfos.set(key, task)
    return task
  }

  const normalizeManifestPlugins = (manifest, repo, source, warnings) => {
    if (!manifest || typeof manifest !== 'object') return []
    const rawList = Array.isArray(manifest) ? manifest : Array.isArray(manifest.plugins) ? manifest.plugins : [manifest]
    const repoUrl = String(manifest.repo || manifest.repository || repo.url || source.repo || source.url || '').trim()
    const branch = String(manifest.branch || manifest.ref || repo.branch || '').trim()
    const out = []
    for (const raw of rawList) {
      if (!raw || typeof raw !== 'object') continue
      const path = normalizePluginPath(raw.path || raw.dir || '')
      const fallbackId = safePluginId(`${parseGithubRepo(repoUrl)?.repo || repoUrl.split('/').filter(Boolean).pop() || 'plugin'}-${path || 'root'}`)
      const plugin = normalizeMarketPlugin(raw, {
        repo: repoUrl,
        branch,
        sourceId: source.id,
        sourceName: source.name,
        sourceUrl: source.url,
        official: source.official === true,
        fallbackId,
      })
      if (!plugin) {
        warnings.push(`${source.name || source.id}：仓库 ${repoUrl || '未知'} 里有一条插件记录缺少 id，已跳过`)
        continue
      }
      if (!plugin.repo) plugin.repo = repoUrl
      if (!plugin.branch) plugin.branch = branch
      out.push(plugin)
    }
    return out
  }

  const singlePluginFallback = async (repo, source, warnings) => {
    const repoUrl = String(repo.url || '').trim()
    if (!repoUrl) return []
    const branch = String(repo.branch || '').trim()
    const repoInfo = branch ? null : await fetchRepoInfo(repoUrl, source).catch(() => null)
    const rawBranch = branch || repoInfo?.defaultBranch || MARKET_DEFAULT_BRANCH
    const fallbackId = safePluginId(parseGithubRepo(repoUrl)?.repo || repoUrl.split('/').filter(Boolean).pop() || 'plugin')
    let manifest = null
    const manifestUrl = githubRaw(repoUrl, rawBranch, 'manifest.json')
    if (manifestUrl) {
      try {
        manifest = JSON.parse(await fetchJsonText(manifestUrl, { source }))
      } catch (_) {
        manifest = null
      }
    }
    if (manifest && typeof manifest === 'object') {
      const plugin = normalizeMarketPlugin(manifest, {
        repo: repoUrl,
        branch: rawBranch,
        sourceId: source.id,
        sourceName: source.name,
        sourceUrl: source.url,
        official: source.official === true,
        fallbackId,
      })
      if (plugin) return [plugin]
    }

    const indexUrl = githubRaw(repoUrl, rawBranch, 'index.mjs')
    if (indexUrl) {
      try {
        const result = await fetchTextFirst(mirrorUrlCandidates(indexUrl, source), { timeoutMs: 10000, maxBytes: 500000 })
        const pick = pattern => String(result.text.match(pattern)?.[1] || '').trim()
        const plugin = normalizeMarketPlugin(
          {
            id: pick(/export\s+const\s+name\s*=\s*['"`]([^'"`]+)['"`]/) || fallbackId,
            name: pick(/export\s+const\s+displayName\s*=\s*['"`]([^'"`]+)['"`]/) || fallbackId,
            version: pick(/export\s+const\s+version\s*=\s*['"`]([^'"`]+)['"`]/) || '0.0.0',
            description: pick(/export\s+const\s+description\s*=\s*['"`]([^'"`]+)['"`]/),
            author: pick(/export\s+const\s+author\s*=\s*['"`]([^'"`]+)['"`]/),
            icon: pick(/export\s+const\s+icon\s*=\s*['"`]([^'"`]+)['"`]/),
          },
          {
            repo: repoUrl,
            branch: rawBranch,
            sourceId: source.id,
            sourceName: source.name,
            sourceUrl: source.url,
            official: source.official === true,
            fallbackId,
          },
        )
        return plugin ? [plugin] : []
      } catch (_) {
        /* 没有 index.mjs，继续给出提示 */
      }
    }
    warnings.push(
      `${source.name || source.id}：仓库 ${repoUrl} 未找到可用市场清单（${MARKET_MANIFEST_FILENAMES.join(' / ')}），或网络不可达；已跳过`,
    )
    return []
  }

  const fetchRepoPlugins = async (repo, source, warnings) => {
    const repoUrl = String(repo.url || '').trim()
    if (!repoUrl) return []
    let branch = String(repo.branch || '').trim()
    if (!branch) {
      const info = await fetchRepoInfo(repoUrl, source).catch(() => null)
      branch = info?.defaultBranch || MARKET_DEFAULT_BRANCH
    }
    const candidates = [String(repo.manifest || '').trim(), ...MARKET_MANIFEST_FILENAMES].filter(Boolean)
    for (const file of candidates) {
      const url = /^https?:\/\//i.test(file) ? file : githubRaw(repoUrl, branch, file)
      if (!url) continue
      try {
        const text = await fetchJsonText(url, { source })
        const parsed = JSON.parse(text)
        const plugins = normalizeManifestPlugins(parsed, { url: repoUrl, branch }, source, warnings)
        if (plugins.length) return plugins
      } catch (_) {
        /* 尝试下一个候选清单 */
      }
    }
    return singlePluginFallback({ url: repoUrl, branch }, source, warnings)
  }

  const fetchSourceCatalog = async (source, { force = false } = {}) => {
    await loadDiskCache()
    const cached = catalogs.get(source.id)
    if (!force && cached && Date.now() - Number(cached.at || 0) < cacheTtl()) return cached
    if (inflightCatalogs.has(source.id)) return inflightCatalogs.get(source.id)

    const task = (async () => {
      const warnings = []
      const found = new Map()
      const addPlugins = (plugins, repoUrl) => {
        for (const plugin of plugins) {
          if (found.has(plugin.id)) {
            warnings.push(`插件 id 冲突：${plugin.id} 同时出现在多个仓库 / 源，已保留第一条记录`)
            continue
          }
          if (!plugin.repo) plugin.repo = String(repoUrl || source.repo || '')
          found.set(plugin.id, plugin)
        }
      }

      let index = null
      // 自定义源可以直接填 GitHub 仓库地址：直接走仓库清单，不再抓一次 HTML。
      const sourceLooksLikeGithubRepo = isGithubRepoUrl(source.url) && !/\.json(?:$|[?#])/i.test(source.url)
      if (!sourceLooksLikeGithubRepo) {
        try {
          const indexUrls = Array.isArray(source.urls) && source.urls.length ? source.urls : [source.url]
          const result = await fetchTextFirst(indexUrls)
          index = parseMarketIndex(result.text, source.repo || source.url)
        } catch (err) {
          warnings.push(`读取市场索引失败：${err?.message || err}`)
        }
      }

      if (index && (index.repos.length || index.directPlugins.length)) {
        if (index.directPlugins.length) {
          addPlugins(normalizeManifestPlugins({ plugins: index.directPlugins }, { url: source.repo || source.url, branch: source.branch }, source, warnings), source.repo || source.url)
        }
        const repos = index.repos.filter(repo => repo.url)
        const repoPlugins = await mapLimit(repos, REPO_CONCURRENCY, async repo => {
          try {
            return await fetchRepoPlugins(repo, source, warnings)
          } catch (err) {
            warnings.push(`仓库 ${repo.url} 读取失败：${err?.message || err}`)
            return []
          }
        })
        for (let index = 0; index < repos.length; index += 1) addPlugins(repoPlugins[index], repos[index].url)
      } else {
        // 源地址本身就是某个插件仓库 / 单插件清单
        try {
          const repoUrl = source.repo || source.url
          const plugins = await fetchRepoPlugins({ url: repoUrl, branch: source.branch, manifest: '' }, source, warnings)
          addPlugins(plugins, repoUrl)
        } catch (err) {
          warnings.push(`读取源失败：${err?.message || err}`)
        }
      }

      const plugins = [...found.values()]
      if (!plugins.length && !warnings.length) warnings.push('没有从该源读取到任何插件')
      if (
        !plugins.length &&
        warnings.some(warning => /ECONNRESET|ECONNREFUSED|ETIMEDOUT|请求超时|fetch failed|socket hang up|网络不可达/i.test(String(warning)))
      ) {
        warnings.push(
          '网络请求失败：若当前使用代理，请确认系统代理已开启，或设置环境变量 NIANFENG_MARKET_PROXY（例如 http://127.0.0.1:7890）后重启后端。',
        )
      }

      // 刷新失败（断网 / 代理抖动）时不能拿空目录覆盖上一次成功缓存，
      // 否则用户会看到插件和源一起“消失”。返回旧目录并标记 stale，让 UI 给出提示。
      if (!plugins.length && cached?.plugins?.length) {
        return {
          ...cached,
          stale: true,
          error: warnings.join('；'),
          warnings: [...(cached.warnings || []), ...warnings].slice(0, 80),
        }
      }

      // 用 GitHub 仓库信息补齐 star / 作者 / 更新时间；失败只显示为空，不影响目录。
      const uniqueRepos = [...new Set(plugins.map(plugin => plugin.repo).filter(Boolean))]
      const infoList = await mapLimit(uniqueRepos, REPO_CONCURRENCY, async repoUrl => {
        try {
          return await fetchRepoInfo(repoUrl, source)
        } catch (_) {
          return null
        }
      })
      const infoByRepo = new Map(uniqueRepos.map((repoUrl, index) => [repoUrl, infoList[index]]))
      for (const plugin of plugins) {
        const info = infoByRepo.get(plugin.repo) || null
        plugin.repoInfo = info
        plugin.manifestAuthor = plugin.author || ''
        if (info?.author) plugin.author = info.author
        else if (info?.owner) plugin.author = info.owner
        if (!plugin.author) plugin.author = plugin.manifestAuthor
        if (plugin.stars === null && info && Number.isFinite(info.stars)) plugin.stars = info.stars
        if (!plugin.description && info?.description) plugin.description = info.description
        if (!plugin.homepage && info?.homepage) plugin.homepage = info.homepage
        if (!plugin.license && info?.license) plugin.license = info.license
        if (!plugin.updatedAt && info) plugin.updatedAt = info.pushedAt || info.updatedAt || 0
        if (!plugin.branch && info?.defaultBranch) plugin.branch = info.defaultBranch
      }

      const catalog = { at: Date.now(), source: { ...source }, plugins, warnings: warnings.slice(0, 80) }
      catalogs.set(source.id, catalog)
      saveDiskCache()
      return catalog
    })()

    inflightCatalogs.set(source.id, task)
    try {
      return await task
    } finally {
      inflightCatalogs.delete(source.id)
    }
  }

  const getCatalog = async (source, { force = false } = {}) => {
    try {
      return await fetchSourceCatalog(source, { force })
    } catch (err) {
      const stale = catalogs.get(source.id)
      if (stale) return { ...stale, stale: true, error: String(err?.message || err) }
      throw err
    }
  }

  const installedVersions = async () => {
    try {
      const snapshot = await registry.list()
      return new Map(
        (snapshot.plugins || [])
          .filter(plugin => plugin.external && plugin.id)
          .map(plugin => [String(plugin.id), { version: String(plugin.version || '0.0.0'), dir: plugin.dir || '' }]),
      )
    } catch (_) {
      return new Map()
    }
  }

  const withInstallState = (plugin, installed) => {
    const local = installed.get(plugin.id) || null
    let status = 'not-installed'
    if (local) {
      const marketVersion = String(plugin.version || '0.0.0')
      const localVersion = String(local.version || '0.0.0')
      let cmp = 0
      try {
        cmp = compareVersions(marketVersion, localVersion)
      } catch (_) {
        cmp = marketVersion.localeCompare(localVersion)
      }
      status = cmp > 0 ? 'update' : cmp < 0 ? 'newer' : 'installed'
    }
    return {
      ...plugin,
      installed: !!local,
      installedVersion: local?.version || '',
      status,
      updateAvailable: status === 'update',
      verified: !!plugin.sha256,
    }
  }

  const publicSource = source => ({
    id: source.id,
    name: source.name,
    url: source.url,
    repo: source.repo || '',
    branch: source.branch || '',
    official: source.official === true,
    builtin: source.builtin === true,
    mirror: source.mirror === true,
  })

  const parseBool = value => value === true || String(value || '').toLowerCase() === 'true' || String(value || '') === '1'

  const sortPlugins = (list, sort, order) => {
    const direction = order === 'asc' ? 1 : -1
    const copy = [...list]
    copy.sort((a, b) => {
      let cmp = 0
      if (sort === 'stars') cmp = (Number(a.stars) || 0) - (Number(b.stars) || 0)
      else if (sort === 'name') cmp = String(a.displayName || a.name || a.id).localeCompare(String(b.displayName || b.name || b.id), 'zh-Hans-CN')
      else if (sort === 'version') {
        try {
          cmp = compareVersions(String(a.version || '0.0.0'), String(b.version || '0.0.0'))
        } catch (_) {
          cmp = String(a.version || '').localeCompare(String(b.version || ''))
        }
      } else {
        cmp = asTimestamp(a.updatedAt) - asTimestamp(b.updatedAt)
      }
      if (cmp === 0) cmp = String(a.id).localeCompare(String(b.id))
      return cmp * direction
    })
    return copy
  }

  const selectArchivePrefix = (entries, plugin) => {
    const names = entries
      .filter(entry => !entry.directory)
      .map(entry => String(entry.name || '').replace(/\\/g, '/'))
      .filter(name => name && isSafeZipEntryName(name))
    if (!names.length) return ''
    const topLevel = new Set(names.filter(name => name.includes('/')).map(name => name.split('/')[0]).filter(Boolean))
    const rootFiles = names.filter(name => !name.includes('/'))
    const base = rootFiles.length === 0 && topLevel.size === 1 ? `${[...topLevel][0]}/` : ''
    const pluginPath = normalizePluginPath(plugin.path || '')
    const entryName = String(plugin.entry || 'index.mjs').replace(/^\.?\//, '') || 'index.mjs'
    const candidates = []
    if (pluginPath) candidates.push(`${base}${pluginPath}/`, `${pluginPath}/`)
    candidates.push(base, '')
    const seen = new Set()
    for (const candidate of candidates) {
      if (seen.has(candidate)) continue
      seen.add(candidate)
      if (names.some(name => name === `${candidate}${entryName}` || name === `${candidate}manifest.json`)) return candidate
    }
    return candidates.find(candidate => names.some(name => name.startsWith(candidate))) || ''
  }

  const filterEntriesForPlugin = (entries, plugin) => {
    const prefix = selectArchivePrefix(entries, plugin)
    const selected = []
    for (const entry of entries) {
      if (entry.directory) continue
      const name = String(entry.name || '').replace(/\\/g, '/')
      if (!name || !isSafeZipEntryName(name)) continue
      if (prefix && !name.startsWith(prefix)) continue
      const rel = prefix ? name.slice(prefix.length) : name
      if (!rel || !isSafeZipEntryName(rel)) continue
      selected.push({ ...entry, name: rel })
    }
    return { prefix, entries: selected }
  }

  const downloadPluginArchive = async (plugin, source = null) => {
    const release = plugin.release && typeof plugin.release === 'object' ? plugin.release : null
    let archiveUrl = String(release?.url || plugin.archiveUrl || '').trim()
    if (!archiveUrl && isGithubRepoUrl(plugin.repo)) {
      const parsed = parseGithubRepo(plugin.repo)
      const ref = String(plugin.commit || plugin.branch || plugin.repoInfo?.defaultBranch || MARKET_DEFAULT_BRANCH).trim() || MARKET_DEFAULT_BRANCH
      archiveUrl = `https://codeload.github.com/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/zip/${ref}`
    }
    if (!archiveUrl) {
      return { ok: false, error: '该插件没有可用的下载地址（既没有 release，也不是 GitHub 仓库）' }
    }
    const result = await fetchBufferFirst(mirrorUrlCandidates(archiveUrl, source), {
      headers: ARCHIVE_HEADERS,
      maxBytes: ZIP_MAX_BYTES,
      timeoutMs: 180000,
    })
    if (result.truncated) return { ok: false, error: `插件压缩包超过 ${Math.round(ZIP_MAX_BYTES / 1024 / 1024)}MB 限制` }
    return { ok: true, archiveUrl: result.url || archiveUrl, buffer: result.buffer }
  }

  /* ---------------- HTTP API ---------------- */

  http.route('GET', '/api/market/sources', async (req, res) => {
    await ensureSourceDefaults()
    await loadDiskCache()
    http.sendJson(res, 200, {
      ok: true,
      sources: allSources().map(publicSource),
      activeSourceId: activeSourceId(),
    })
  })

  http.route('POST', '/api/market/sources', async (req, res) => {
    const body = await http.readBody(req)
    const name = String(body?.name || '').trim().slice(0, 60)
    const url = String(body?.url || '').trim()
    if (!name) return http.sendJson(res, 200, { ok: false, error: '请填写插件源名称' })
    if (!/^https?:\/\//i.test(url)) return http.sendJson(res, 200, { ok: false, error: '插件源地址必须是 http(s) URL' })
    const source = normalizeCustomSource({ id: `custom-${Date.now().toString(36)}`, name, url })
    if (!source) return http.sendJson(res, 200, { ok: false, error: '插件源地址不合法' })
    const sources = customSources().filter(item => item.id !== source.id && item.url !== source.url)
    sources.push(source)
    await saveSources(sources, activeSourceId())
    http.sendJson(res, 200, { ok: true, source: publicSource(source), sources: allSources().map(publicSource) })
  })

  http.route('PUT', '/api/market/sources/:id', async (req, res, params) => {
    const id = String(params.id || '')
    if (id === 'official') return http.sendJson(res, 200, { ok: false, error: '官方源不能修改' })
    const body = await http.readBody(req)
    const current = customSources().find(source => source.id === id)
    if (!current) return http.sendJson(res, 200, { ok: false, error: '插件源不存在' })
    const next = normalizeCustomSource({
      ...current,
      name: body?.name !== undefined ? body.name : current.name,
      url: body?.url !== undefined ? body.url : current.url,
    })
    if (!next) return http.sendJson(res, 200, { ok: false, error: '插件源地址不合法' })
    const sources = customSources().map(source => (source.id === id ? next : source))
    await saveSources(sources, activeSourceId())
    http.sendJson(res, 200, { ok: true, source: publicSource(next), sources: allSources().map(publicSource) })
  })

  http.route('DELETE', '/api/market/sources/:id', async (req, res, params) => {
    const id = String(params.id || '')
    if (id === 'official') return http.sendJson(res, 200, { ok: false, error: '官方源不能删除' })
    const sources = customSources().filter(source => source.id !== id)
    const nextActive = activeSourceId() === id ? 'official' : activeSourceId()
    await saveSources(sources, nextActive)
    http.sendJson(res, 200, { ok: true, sources: allSources().map(publicSource), activeSourceId: nextActive })
  })

  http.route('POST', '/api/market/sources/:id/activate', async (req, res, params) => {
    const source = sourceById(params.id)
    if (!source) return http.sendJson(res, 200, { ok: false, error: '插件源不存在' })
    await saveSources(customSources(), source.id)
    http.sendJson(res, 200, { ok: true, activeSourceId: source.id })
  })

  http.route('POST', '/api/market/refresh', async (req, res) => {
    await ensureSourceDefaults()
    const body = await http.readBody(req)
    const source = sourceById(body?.sourceId || activeSourceId())
    if (!source) return http.sendJson(res, 200, { ok: false, error: '插件源不存在' })
    try {
      const catalog = await fetchSourceCatalog(source, { force: true })
      http.sendJson(res, 200, { ok: true, source: publicSource(source), total: catalog.plugins.length, fetchedAt: catalog.at, warnings: catalog.warnings })
    } catch (err) {
      http.sendJson(res, 200, { ok: false, error: err?.message || String(err) })
    }
  })

  http.route('GET', '/api/market/plugins', async (req, res, params, url) => {
    await ensureSourceDefaults()
    const source = sourceById(url.searchParams.get('sourceId') || activeSourceId())
    if (!source) return http.sendJson(res, 200, { ok: false, error: '插件源不存在' })
    const force = parseBool(url.searchParams.get('refresh'))
    let catalog
    try {
      catalog = await getCatalog(source, { force })
    } catch (err) {
      return http.sendJson(res, 200, { ok: false, error: err?.message || String(err), source: publicSource(source), plugins: [], total: 0 })
    }
    const installed = await installedVersions()
    let list = catalog.plugins.map(plugin => withInstallState(plugin, installed))
    const q = String(url.searchParams.get('q') || '').trim().toLowerCase()
    if (q) {
      list = list.filter(plugin =>
        [plugin.id, plugin.name, plugin.displayName, plugin.description, plugin.author, ...(plugin.tags || [])]
          .filter(Boolean)
          .some(value => String(value).toLowerCase().includes(q)),
      )
    }
    const sort = String(url.searchParams.get('sort') || 'updated')
    const order = String(url.searchParams.get('order') || 'desc') === 'asc' ? 'asc' : 'desc'
    list = sortPlugins(list, sort, order)
    const pageSize = Math.max(1, Math.min(100, Number(url.searchParams.get('pageSize')) || 20))
    const total = list.length
    const totalPages = Math.max(1, Math.ceil(total / pageSize))
    const page = Math.max(1, Math.min(totalPages, Number(url.searchParams.get('page')) || 1))
    const start = (page - 1) * pageSize
    http.sendJson(res, 200, {
      ok: true,
      source: publicSource(source),
      plugins: list.slice(start, start + pageSize),
      total,
      page,
      pageSize,
      totalPages,
      fetchedAt: catalog.at,
      warnings: catalog.warnings || [],
      stale: catalog.stale === true,
    })
  })

  http.route('GET', '/api/market/plugin/:id', async (req, res, params, url) => {
    await ensureSourceDefaults()
    const source = sourceById(url.searchParams.get('sourceId') || activeSourceId())
    if (!source) return http.sendJson(res, 200, { ok: false, error: '插件源不存在' })
    let catalog
    try {
      catalog = await getCatalog(source)
    } catch (err) {
      return http.sendJson(res, 200, { ok: false, error: err?.message || String(err) })
    }
    let plugin = catalog.plugins.find(item => item.id === params.id)
    if (!plugin) {
      try {
        catalog = await getCatalog(source, { force: true })
        plugin = catalog.plugins.find(item => item.id === params.id)
      } catch (_) {
        /* ignore */
      }
    }
    if (!plugin) return http.sendJson(res, 404, { ok: false, error: '没有找到该插件' })
    const enriched = withInstallState(plugin, await installedVersions())
    const repoInfo = plugin.repo ? await fetchRepoInfo(plugin.repo, source).catch(() => null) : null
    const branch = plugin.branch || repoInfo?.defaultBranch || MARKET_DEFAULT_BRANCH
    const readmeCandidates = []
    if (plugin.path) {
      readmeCandidates.push(`${plugin.path}/README.md`, `${plugin.path}/readme.md`)
    }
    readmeCandidates.push('README.md', 'readme.md')
    let readme = ''
    for (const file of readmeCandidates) {
      const readmeUrl = /^https?:\/\//i.test(file) ? file : githubRaw(plugin.repo, branch, file)
      if (!readmeUrl) continue
      try {
        const result = await fetchTextFirst(mirrorUrlCandidates(readmeUrl, source), {
          headers: { ...JSON_HEADERS, Accept: 'text/plain, text/markdown, */*' },
          timeoutMs: 10000,
          maxBytes: 500000,
        })
        if (result.text.trim()) {
          readme = result.text
          break
        }
      } catch (_) {
        /* 试下一个 README 文件名 */
      }
    }
    http.sendJson(res, 200, {
      ok: true,
      plugin: enriched,
      repo: repoInfo || plugin.repoInfo || null,
      readme,
      warnings: catalog.warnings || [],
    })
  })

  http.route('GET', '/api/market/installed-meta', async (req, res) => {
    http.sendJson(res, 200, { ok: true, installed: await readInstalledMeta() })
  })

  /** 批量查询插件市场元数据（作者 / Star / 仓库 / 版本），用于插件管理页小字标注。 */
  http.route('GET', '/api/market/lookup', async (req, res, params, url) => {
    const source = sourceById(url.searchParams.get('sourceId') || activeSourceId())
    if (!source) return http.sendJson(res, 200, { ok: false, error: '插件源不存在', plugins: {} })
    const ids = String(url.searchParams.get('ids') || '')
      .split(',')
      .map(item => safePluginId(item))
      .filter(Boolean)
      .slice(0, 300)
    if (!ids.length) return http.sendJson(res, 200, { ok: true, source: publicSource(source), plugins: {} })
    let catalog
    try {
      catalog = await getCatalog(source)
    } catch (err) {
      return http.sendJson(res, 200, { ok: false, error: err?.message || String(err), plugins: {} })
    }
    const wanted = new Set(ids)
    const plugins = {}
    for (const plugin of catalog.plugins) {
      if (!wanted.has(plugin.id)) continue
      plugins[plugin.id] = {
        id: plugin.id,
        name: plugin.displayName || plugin.name || plugin.id,
        version: plugin.version,
        author: plugin.author || '',
        authorFallback: plugin.manifestAuthor || '',
        stars: Number.isFinite(Number(plugin.stars)) ? Number(plugin.stars) : null,
        repo: plugin.repo || '',
        homepage: plugin.homepage || plugin.repo || '',
        sha256: plugin.sha256 || '',
        updatedAt: plugin.updatedAt || 0,
        sourceId: plugin.sourceId || source.id,
        sourceName: plugin.sourceName || source.name,
      }
    }
    http.sendJson(res, 200, { ok: true, source: publicSource(source), plugins })
  })

  http.route('POST', '/api/market/install', async (req, res) => {
    await ensureSourceDefaults()
    const body = await http.readBody(req)
    const source = sourceById(body?.sourceId || activeSourceId())
    if (!source) return http.sendJson(res, 200, { ok: false, error: '插件源不存在' })
    const id = safePluginId(body?.id || '')
    if (!id) return http.sendJson(res, 200, { ok: false, error: '缺少插件 id' })
    let catalog
    try {
      catalog = await getCatalog(source)
    } catch (err) {
      return http.sendJson(res, 200, { ok: false, error: err?.message || String(err) })
    }
    let plugin = catalog.plugins.find(item => item.id === id)
    if (!plugin) {
      try {
        catalog = await getCatalog(source, { force: true })
        plugin = catalog.plugins.find(item => item.id === id)
      } catch (_) {
        /* ignore */
      }
    }
    if (!plugin) return http.sendJson(res, 200, { ok: false, error: '没有找到该插件' })
    if (!plugin.sha256 && body?.allowUnverified !== true) {
      return http.sendJson(res, 200, {
        ok: false,
        requiresConfirmation: true,
        plugin: { id: plugin.id, name: plugin.name, version: plugin.version },
        error: '该插件未在清单中提供 SHA-256 哈希，无法验证内容是否被篡改。',
      })
    }

    const downloaded = await downloadPluginArchive(plugin, source).catch(err => ({ ok: false, error: err?.message || String(err) }))
    if (!downloaded.ok) return http.sendJson(res, 200, downloaded)

    let archiveHashVerified = false
    const archiveHash = normalizeHash(plugin.release?.sha256 || '')
    if (plugin.hashType === 'archive-sha256' && plugin.sha256) {
      const actual = sha256Hex(downloaded.buffer)
      if (actual !== plugin.sha256) {
        return http.sendJson(res, 200, {
          ok: false,
          hashMismatch: true,
          expectedHash: plugin.sha256,
          actualHash: actual,
          error: '插件压缩包哈希校验失败：下载内容与市场清单不一致，已拒绝安装。',
        })
      }
      archiveHashVerified = true
    } else if (archiveHash) {
      const actual = sha256Hex(downloaded.buffer)
      if (actual !== archiveHash) {
        return http.sendJson(res, 200, {
          ok: false,
          hashMismatch: true,
          expectedHash: archiveHash,
          actualHash: actual,
          error: '插件 release 压缩包哈希校验失败，已拒绝安装。',
        })
      }
      archiveHashVerified = true
    }

    let entries = []
    try {
      entries = listZipEntries(downloaded.buffer)
    } catch (err) {
      return http.sendJson(res, 200, { ok: false, error: `zip 解析失败：${err?.message || err}` })
    }
    const filtered = filterEntriesForPlugin(entries, plugin)
    if (!filtered.entries.some(entry => String(entry.name).replace(/\\/g, '/') === String(plugin.entry || 'index.mjs').replace(/^\.?\//, ''))) {
      return http.sendJson(res, 200, { ok: false, error: '压缩包里没有找到插件的入口文件 index.mjs' })
    }

    const result = await registry.installEntries({
      entries: filtered.entries,
      filename: `${plugin.id}-${plugin.version}.zip`,
      overwrite: body?.overwrite === true || parseBool(body?.overwrite),
      expected: {
        id: plugin.id,
        version: plugin.version,
        sha256: plugin.hashType === 'content-sha256' ? plugin.sha256 : '',
      },
    })
    if (!result.ok) return http.sendJson(res, 200, result)

    await writeInstalledMeta(plugin.id, {
      id: plugin.id,
      name: plugin.name,
      version: plugin.version,
      author: plugin.author || '',
      stars: Number.isFinite(Number(plugin.stars)) ? Number(plugin.stars) : null,
      repo: plugin.repo || '',
      homepage: plugin.homepage || '',
      sourceId: source.id,
      sourceName: source.name,
      sha256: plugin.sha256 || '',
      hashType: plugin.hashType || '',
      installedAt: Date.now(),
    })
    ctx.emit('market:installed', { id: plugin.id, version: plugin.version })
    http.sendJson(res, 200, {
      ...result,
      hashVerified: archiveHashVerified || result.hashVerified === true,
      plugin: { id: plugin.id, name: plugin.name, version: plugin.version },
    })
  })

  http.registerCapability?.('plugin-market')

  // 启动后后台预热一次官方索引（不阻塞后端启动）；失败只写 debug 日志。
  const warmupTimer = setTimeout(() => {
    fetchSourceCatalog(mirrorSource(), { force: true }).catch(err => {
      ctx.logger.debug(`插件市场预热失败（可能当前离线）：${err?.message || err}`)
    })
  }, 1800)
  warmupTimer?.unref?.()

  ctx.logger.info('插件市场服务就绪')
}
