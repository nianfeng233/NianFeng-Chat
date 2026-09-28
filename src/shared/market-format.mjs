/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * 插件市场公共格式（库，不是插件）。
 *
 * 约定：
 *   - 索引文件：记录允许上架的插件仓库列表，支持 {repos:[...]} 或纯数组；
 *   - 仓库清单：每个仓库根目录放一份 market.json / nianfeng-market.json，
 *     声明仓库内的一个或多个插件；单仓库单插件也可以直接放根 manifest.json，
 *     程序会按「无市场清单」回退读取。
 *   - 每条插件记录至少包含 id / version / path / hash，安装前后用 hash 校验内容。
 */

export const OFFICIAL_MARKET_REPO = 'https://github.com/nianfeng233/NianFeng-Chat-Plugins'
export const OFFICIAL_MARKET_BRANCH = 'main'
export const OFFICIAL_MARKET_INDEX_URL =
  'https://raw.githubusercontent.com/nianfeng233/NianFeng-Chat-Plugins/main/index.json'
export const MARKET_INDEX_FILENAME = 'index.json'
export const MARKET_MANIFEST_FILENAMES = ['nianfeng-market.json', 'market.json', 'plugins.json']
export const MARKET_DEFAULT_BRANCH = 'main'

const ID_PATTERN = /[^a-zA-Z0-9._-]+/g

export function safePluginId(value) {
  return String(value ?? '')
    .trim()
    .replace(ID_PATTERN, '-')
    .replace(/^[.\-\s]+|[.\-\s]+$/g, '')
    .slice(0, 120)
}

export function normalizePluginPath(value) {
  const text = String(value ?? '')
    .replace(/\\/g, '/')
    .trim()
  const segments = text
    .split('/')
    .map(segment => segment.trim())
    .filter(segment => segment && segment !== '.')
  if (segments.some(segment => segment === '..' || segment.includes('\0'))) return ''
  return segments.join('/')
}

export function normalizeHash(value) {
  const text = String(value ?? '').trim()
  if (!text) return ''
  const hex = text.replace(/^sha(?:256)?[:-]/i, '').replace(/[^a-f0-9]/gi, '')
  return /^[a-f0-9]{64}$/i.test(hex) ? hex.toLowerCase() : ''
}

export function isGithubRepoUrl(value) {
  try {
    const url = new URL(String(value || ''))
    return url.protocol === 'https:' && /^(www\.)?github\.com$/i.test(url.hostname)
  } catch (_) {
    return false
  }
}

export function parseGithubRepo(value) {
  if (!isGithubRepoUrl(value)) return null
  try {
    const url = new URL(String(value))
    const parts = url.pathname.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean)
    if (parts.length < 2) return null
    return {
      owner: parts[0],
      repo: parts[1].replace(/\.git$/i, ''),
    }
  } catch (_) {
    return null
  }
}

export function githubRawUrl(repoUrl, branch, file) {
  const parsed = parseGithubRepo(repoUrl)
  if (!parsed) return ''
  const ref = encodeURIComponent(String(branch || MARKET_DEFAULT_BRANCH).trim() || MARKET_DEFAULT_BRANCH).replace(/%2F/gi, '/')
  const path = String(file || '')
    .replace(/^\/+/, '')
    .split('/')
    .map(segment => encodeURIComponent(segment))
    .join('/')
  if (!path) return ''
  return `https://raw.githubusercontent.com/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/${ref}/${path}`
}

function normalizeRepoEntry(raw, fallbackUrl = '') {
  if (typeof raw === 'string') {
    const url = raw.trim()
    return url ? { url, branch: '', manifest: '', name: '', official: false } : null
  }
  if (!raw || typeof raw !== 'object') return null
  const url = String(raw.url || raw.repo || raw.repository || raw.source || fallbackUrl || '').trim()
  if (!url) return null
  return {
    url,
    branch: String(raw.branch || raw.ref || '').trim(),
    manifest: String(raw.manifest || raw.catalog || raw.indexFile || '').trim(),
    name: String(raw.name || raw.title || '').trim(),
    official: raw.official === true,
    enabled: raw.enabled !== false,
  }
}

/**
 * 解析市场索引文件。支持：
 *   - [{url, branch, manifest}, ...]
 *   - { repos: [...] }
 *   - { sources: [...] }
 *   - { url / repo: 'https://github.com/owner/repo' }
 *   - { plugins: [...] } 直接把索引当成插件清单（单文件源）。
 */
export function parseMarketIndex(text, fallbackUrl = '') {
  let parsed
  try {
    parsed = JSON.parse(String(text || ''))
  } catch (_) {
    return { repos: [], directPlugins: [], error: '索引文件不是合法 JSON' }
  }
  if (Array.isArray(parsed)) {
    return { repos: parsed.map(item => normalizeRepoEntry(item)).filter(Boolean), directPlugins: [] }
  }
  if (!parsed || typeof parsed !== 'object') {
    return { repos: [], directPlugins: [], error: '索引文件结构不正确' }
  }
  const rawRepos = Array.isArray(parsed.repos)
    ? parsed.repos
    : Array.isArray(parsed.repositories)
      ? parsed.repositories
      : Array.isArray(parsed.sources)
        ? parsed.sources
        : parsed.repo || parsed.url
          ? [parsed]
          : []
  const repos = rawRepos.map(item => normalizeRepoEntry(item, fallbackUrl)).filter(item => item?.enabled !== false)
  const directPlugins = Array.isArray(parsed.plugins) ? parsed.plugins : []
  return { repos, directPlugins }
}

/** 统一把仓库清单 / 单插件清单里的原始记录规范化。 */
export function normalizeMarketPlugin(raw, context = {}) {
  const fallbackId = safePluginId(context.fallbackId || '')
  const id = safePluginId(raw?.id || raw?.name || raw?.displayName || fallbackId)
  if (!id) return null
  const path = normalizePluginPath(raw?.path || raw?.dir || '')
  const repo = String(raw?.repo || raw?.repository || context.repo || '').trim()
  const branch = String(raw?.branch || raw?.ref || context.branch || '').trim()
  const release = raw?.release
  const releaseUrl = String(
    (release && typeof release === 'object' ? release.url || release.assetUrl : '') || raw?.releaseUrl || '',
  ).trim()
  const tags = Array.isArray(raw?.tags)
    ? raw.tags.map(tag => String(tag || '').trim()).filter(Boolean)
    : String(raw?.tags || '')
        .split(/[,，\s]+/)
        .map(tag => tag.trim())
        .filter(Boolean)
  const stars = Number(raw?.stars)
  return {
    id,
    name: String(raw?.name || raw?.displayName || raw?.title || id).trim(),
    displayName: String(raw?.displayName || raw?.name || raw?.title || id).trim(),
    description: String(raw?.description || '').trim(),
    version: String(raw?.version || '0.0.0').trim(),
    author: String(raw?.author || context.author || '').trim(),
    icon: String(raw?.icon || context.icon || '').trim(),
    tags,
    path,
    entry: String(raw?.entry || 'index.mjs').replace(/^\.?\//, '') || 'index.mjs',
    repo,
    branch,
    archiveUrl: String(raw?.archiveUrl || raw?.downloadUrl || raw?.download || '').trim(),
    commit: String(raw?.commit || '').trim(),
    homepage: String(raw?.homepage || raw?.home || raw?.html_url || repo || '').trim(),
    license: String(raw?.license || '').trim(),
    minAppVersion: String(raw?.minAppVersion || raw?.minVersion || '').trim(),
    scope: String(raw?.scope || raw?.runtime || '').trim(),
    permissions: Array.isArray(raw?.permissions) ? raw.permissions : [],
    sha256: normalizeHash(raw?.sha256 || raw?.hash || raw?.integrity),
    hashType: ['archive-sha256', 'content-sha256'].includes(String(raw?.hashType || raw?.hashType || '').trim())
      ? String(raw.hashType).trim()
      : 'content-sha256',
    release: releaseUrl || (release && typeof release === 'object') ? { ...(release && typeof release === 'object' ? release : {}), url: releaseUrl } : null,
    releaseTag: String((release && typeof release === 'object' ? release.tag : '') || raw?.releaseTag || '').trim(),
    updatedAt: raw?.updatedAt || raw?.updated_at || raw?.pushedAt || raw?.pushed_at || 0,
    stars: Number.isFinite(stars) ? Math.max(0, Math.floor(stars)) : null,
    sourceId: context.sourceId || '',
    sourceName: context.sourceName || '',
    sourceUrl: context.sourceUrl || '',
    official: context.official === true,
  }
}
