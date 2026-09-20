/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * 后端 · app-update
 * 本体版本选择与更新服务：
 *   - 从官方仓库 GitHub Releases 读取版本列表，默认走国内 GitHub 镜像；
 *   - 自动识别当前运行方式：Web 部署版 / Web 源码运行 / Windows 桌面 EXE；
 *   - 更新时先生成独立的 detached 助手进程，再完全关闭当前项目；
 *   - 助手下载对应 Release 附件、解压替换，并按“双击启动脚本”的方式重新拉起。
 *
 * 前端只负责选择版本和展示加载动画，更新是否成功以新后端能否被 /api/health
 * 探活为准，避免在页面侧堆一套状态机。
 */
import { existsSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PROJECT_REPO } from '../../src/shared/project-info.mjs'
import { compareVersions } from '../../src/runtime/semver.mjs'
import { fetchPublicText } from '../net-guard.mjs'
import { spawnUpdateHelper } from '../update-runner.mjs'

export const name = 'app-update'
export const version = '1.0.0'
export const displayName = '本体更新'
export const description = '业务服务 · 读取 GitHub Release、选择 Web / EXE 安装包并执行整体更新。'
export const author = '念风内核'
export const icon = '⬆️'
export const core = true
export const enabled = true
export const depends = {}
export const optionalDepends = {}
export const inject = ['httpApi']
export const provides = [{ name: 'appUpdate', type: 'singleton' }]

const DEFAULT_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const MIRROR_PROXIES = ['https://ghproxy.net/', 'https://gh-proxy.com/', 'https://ghfast.top/']
const RELEASES_TTL = 5 * 60 * 1000
const RELEASES_MAX_BYTES = 4 * 1024 * 1024
const GITHUB_HEADERS = {
  'User-Agent': 'NianFeng-Chat-Updater/1.0',
  Accept: 'application/vnd.github+json',
}

const KIND_LABELS = {
  desktop: 'EXE 桌面版',
  'web-deploy': 'Web 部署版',
  'web-source': 'Web 源码运行',
}

const KIND_ASSET = {
  desktop: { prefix: 'nianfeng-desktop', ext: '.exe' },
  'web-deploy': { prefix: 'nianfeng-web-deploy', ext: '.zip' },
  'web-source': { prefix: 'nianfeng-web-source', ext: '.zip' },
}

const normalizeSource = value => (String(value || '').trim().toLowerCase() === 'official' ? 'official' : 'mirror')

const cleanTag = value => String(value || '').trim()

function withTimeout(promise, timeoutMs, message = '请求超时') {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), Math.max(1000, Number(timeoutMs) || 10000))
    timer.unref?.()
    Promise.resolve(promise).then(
      value => {
        clearTimeout(timer)
        resolve(value)
      },
      err => {
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}

export function apply(ctx, config = {}) {
  const http = ctx.httpApi
  const root = resolve(String(config.root || '').trim() || DEFAULT_ROOT)
  const version = String(config.version || '').trim()
  const onStop = typeof config.onStop === 'function' ? config.onStop : null
  const onRestart = typeof config.onRestart === 'function' ? config.onRestart : null

  const repo = (() => {
    try {
      const url = new URL(PROJECT_REPO)
      const [owner, name] = url.pathname.split('/').filter(Boolean)
      if (owner && name) return { owner, name }
    } catch (_) {
      /* 使用下面的兜底仓库 */
    }
    return { owner: 'nianfeng233', name: 'NianFeng-Chat' }
  })()
  const releasesApi = `https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/releases?per_page=100`

  /** source -> { at, releases, error } */
  const releaseCache = new Map()
  let updating = false

  const currentKind = () => {
    if (String(process.env.NIANFENG_DESKTOP_EXE || '').trim()) return 'desktop'
    const homeDir = String(process.env.NIANFENG_HOME_DIR || '').trim()
    if (
      homeDir &&
      basename(root).toLowerCase() === 'app' &&
      (existsSync(join(homeDir, 'runtime', 'node.exe')) || existsSync(join(homeDir, '启动念风.cmd')))
    ) {
      return 'web-deploy'
    }
    return 'web-source'
  }

  const apiCandidates = source =>
    source === 'mirror'
      ? [...MIRROR_PROXIES.map(proxy => `${proxy}${releasesApi}`), releasesApi]
      : [releasesApi]

  const assetCandidates = (assetUrl, source) => {
    const raw = String(assetUrl || '').trim()
    if (!raw) return []
    const urls = source === 'mirror' ? [...MIRROR_PROXIES.map(proxy => `${proxy}${raw}`), raw] : [raw]
    return [...new Set(urls.filter(Boolean))]
  }

  const readReleaseJson = async source => {
    const candidates = apiCandidates(source)
    const attempts = candidates.map(async (url, index) => {
      const requestTimeout = index === candidates.length - 1 ? 15000 : 10000
      try {
        const result = await withTimeout(
          fetchPublicText(url, {
            headers: GITHUB_HEADERS,
            timeoutMs: requestTimeout,
            maxBytes: RELEASES_MAX_BYTES,
          }),
          requestTimeout + 2000,
        )
        return { ok: true, data: JSON.parse(result.text) }
      } catch (err) {
        ctx.logger.debug(`读取 Release 失败（${source} · ${url}）：${err?.message || err}`)
        return { ok: false, error: err }
      }
    })

    // 镜像 + 官方候选同时请求，谁先返回合法 JSON 就用谁：
    // 国内镜像个别线路卡住时不需要等到超时再试下一个。
    return new Promise((resolve, reject) => {
      let remaining = attempts.length
      let lastError = null
      if (!remaining) {
        reject(new Error('没有可用的 Release 地址'))
        return
      }
      for (const attempt of attempts) {
        Promise.resolve(attempt).then(
          result => {
            if (result?.ok) {
              resolve(result.data)
              return
            }
            lastError = result?.error || lastError
            remaining -= 1
            if (remaining <= 0) reject(lastError || new Error('读取 GitHub Release 失败'))
          },
          err => {
            lastError = err
            remaining -= 1
            if (remaining <= 0) reject(lastError || new Error('读取 GitHub Release 失败'))
          },
        )
      }
    })
  }

  const isTrustedAssetUrl = value => {
    try {
      const url = new URL(String(value || ''))
      const expectedPrefix = `/${repo.owner}/${repo.name}/releases/download/`.toLowerCase()
      return url.protocol === 'https:' && url.hostname.toLowerCase() === 'github.com' && url.pathname.toLowerCase().startsWith(expectedPrefix)
    } catch (_) {
      return false
    }
  }

  /** 在当前运行方式对应的附件里挑最匹配这个 tag 的文件。 */
  const pickAsset = (assets, kind, tag) => {
    const spec = KIND_ASSET[kind]
    if (!spec) return null
    const list = (Array.isArray(assets) ? assets : []).filter(asset => {
      const name = String(asset?.name || '').toLowerCase()
      return name.endsWith(spec.ext) && isTrustedAssetUrl(asset?.browser_download_url)
    })
    if (!list.length) return null
    const releaseVersion = tag.replace(/^v/i, '')
    const exactNames = [`${spec.prefix}-${releaseVersion}${spec.ext}`, `${spec.prefix}-v${releaseVersion}${spec.ext}`].map(item => item.toLowerCase())
    const exact = list.find(asset => exactNames.includes(String(asset.name).toLowerCase()))
    if (exact) return exact

    const versionMatch =
      list.find(asset => String(asset.name).toLowerCase().includes(`-${releaseVersion}${spec.ext}`)) ||
      list.find(asset => String(asset.name).toLowerCase().includes(`-v${releaseVersion}${spec.ext}`))
    if (versionMatch) return versionMatch

    const prefixed = list.filter(asset => String(asset.name).toLowerCase().startsWith(spec.prefix))
    if (prefixed.length === 1) return prefixed[0]
    if (prefixed.length > 1) {
      prefixed.sort((a, b) => String(a.name).length - String(b.name).length || String(a.name).localeCompare(String(b.name)))
      return prefixed[0]
    }
    return list.length === 1 ? list[0] : null
  }

  const normalizeRelease = (raw, kind) => {
    const tag = cleanTag(raw?.tag_name)
    if (!tag) return null
    const asset = pickAsset(raw?.assets, kind, tag)
    return {
      tag,
      name: String(raw?.name || tag),
      version: tag.replace(/^v/i, ''),
      prerelease: raw?.prerelease === true,
      publishedAt: Date.parse(raw?.published_at || '') || 0,
      compatible: !!asset,
      asset: asset
        ? {
            name: String(asset.name || ''),
            size: Number(asset.size) || 0,
            url: String(asset.browser_download_url || ''),
          }
        : null,
    }
  }

  const normalizeReleases = (rawList, kind) => {
    const list = (Array.isArray(rawList) ? rawList : [])
      .map(raw => normalizeRelease(raw, kind))
      .filter(Boolean)
    list.sort((left, right) => {
      const compared = compareVersions(left.version, right.version)
      if (Number.isFinite(compared) && compared !== 0) return -compared
      return right.publishedAt - left.publishedAt
    })
    return list
  }

  const fetchReleases = async (source, { force = false } = {}) => {
    const kind = currentKind()
    const key = `${source}:${kind}`
    const cached = releaseCache.get(key)
    if (!force && cached && Date.now() - cached.at < RELEASES_TTL) {
      return { source, kind, releases: cached.releases, fetchedAt: cached.at, stale: false }
    }
    try {
      const raw = await readReleaseJson(source)
      const releases = normalizeReleases(raw, kind)
      if (!releases.length) throw new Error('GitHub 上还没有可用的 Release')
      const data = { source, kind, releases, fetchedAt: Date.now(), stale: false }
      releaseCache.set(key, { at: data.fetchedAt, releases })
      return data
    } catch (err) {
      if (cached) {
        return { source, kind, releases: cached.releases, fetchedAt: cached.at, stale: true, warning: String(err?.message || err) }
      }
      throw err
    }
  }

  const buildUpdatePlan = ({ kind, source, release }) => {
    const homeDir = String(process.env.NIANFENG_HOME_DIR || '').trim()
    const desktopExe = String(process.env.NIANFENG_DESKTOP_EXE || '').trim()
    const shared = {
      action: 'update',
      kind,
      source,
      tag: release.tag,
      targetVersion: release.version,
      currentVersion: version,
      nodePid: process.pid,
      assetName: release.asset.name,
      expectedSize: release.asset.size,
      downloadUrls: assetCandidates(release.asset.url, source),
    }
    if (kind === 'desktop') {
      return {
        ...shared,
        desktopExe,
        desktopPid: Number(process.env.NIANFENG_DESKTOP_PID || process.ppid || 0),
      }
    }
    if (kind === 'web-deploy') {
      const installDir = homeDir || dirname(root)
      const noOpen = process.argv.includes('--no-open') || /^(1|true|yes|on)$/i.test(String(process.env.NIANFENG_NO_OPEN || '').trim())
      const noBrowserScript = join(installDir, '启动念风-无浏览器.cmd')
      return {
        ...shared,
        appRoot: root,
        homeDir: installDir,
        rootDir: installDir,
        launchCwd: installDir,
        launchScript: noOpen && existsSync(noBrowserScript) ? noBrowserScript : join(installDir, '启动念风.cmd'),
        launchNode: join(installDir, 'runtime', 'node.exe'),
        launchArgs: [join(root, 'start.mjs'), '--serve', ...(noOpen ? ['--no-open'] : [])],
      }
    }
    const singlePort = process.argv.includes('--serve') || process.argv.includes('--single-port')
    const noOpen = process.argv.includes('--no-open') || /^(1|true|yes|on)$/i.test(String(process.env.NIANFENG_NO_OPEN || '').trim())
    const serveScript = join(root, 'serve.cmd')
    return {
      ...shared,
      appRoot: root,
      rootDir: root,
      launchCwd: root,
      launchScript: singlePort && existsSync(serveScript) ? serveScript : join(root, 'start.cmd'),
      launchNode: process.execPath,
      launchArgs: [join(root, 'start.mjs'), ...(singlePort ? ['--serve'] : []), ...(noOpen ? ['--no-open'] : [])],
    }
  }

  const currentInfo = () => {
    const kind = currentKind()
    return {
      ok: true,
      repo: PROJECT_REPO,
      version,
      kind,
      kindLabel: KIND_LABELS[kind] || kind,
      defaultSource: 'mirror',
      updateSupported: !!onStop,
      restartSupported: !!onRestart,
      assetPrefix: KIND_ASSET[kind]?.prefix || '',
    }
  }

  /* ---------------- HTTP API ---------------- */

  http.route('GET', '/api/app/update/info', async (req, res) => {
    http.sendJson(res, 200, currentInfo())
  })

  http.route('GET', '/api/app/releases', async (req, res, params, url) => {
    const source = normalizeSource(url?.searchParams?.get('source'))
    const force = String(url?.searchParams?.get('refresh') || '') === '1'
    try {
      const data = await fetchReleases(source, { force })
      http.sendJson(res, 200, { ok: true, ...currentInfo(), ...data })
    } catch (err) {
      http.sendError(res, 502, `读取 GitHub Release 失败：${err?.message || err}`)
    }
  })

  http.route('POST', '/api/app/update', async (req, res) => {
    if (!onStop) return http.sendError(res, 501, '当前运行方式不支持自动更新，请手动下载新版后替换')
    if (updating) return http.sendError(res, 409, '已有更新任务正在进行，请不要重复提交')
    const body = await http.readBody(req)
    const tag = cleanTag(body?.tag)
    const source = normalizeSource(body?.source)
    if (!/^[A-Za-z0-9._-]{1,80}$/.test(tag)) return http.sendError(res, 400, '版本标签不合法')

    let release = null
    try {
      const data = await fetchReleases(source)
      release = data.releases.find(item => item.tag === tag || item.version === tag.replace(/^v/i, ''))
    } catch (err) {
      return http.sendError(res, 502, `读取 GitHub Release 失败：${err?.message || err}`)
    }
    if (!release) return http.sendError(res, 404, `没有找到 Release：${tag}`)
    if (!release.compatible || !release.asset?.url) return http.sendError(res, 400, '该 Release 没有适配当前运行方式的安装包')

    const kind = currentKind()
    const plan = buildUpdatePlan({ kind, source, release })
    if (!plan.downloadUrls.length) return http.sendError(res, 400, '安装包下载地址为空')
    if (kind === 'desktop' && !plan.desktopExe) return http.sendError(res, 500, '没有识别到当前桌面 EXE 路径')

    updating = true
    try {
      await spawnUpdateHelper(plan)
    } catch (err) {
      updating = false
      return http.sendError(res, 500, `更新助手启动失败：${err?.message || err}`)
    }

    ctx.logger.info(`本体更新已启动：${release.tag} · ${KIND_LABELS[kind] || kind} · ${release.asset.name}`)
    http.sendJson(res, 200, {
      ok: true,
      message: `正在更新到 ${release.tag}…`,
      kind,
      kindLabel: KIND_LABELS[kind] || kind,
      tag: release.tag,
      asset: release.asset.name,
    })

    const timer = setTimeout(() => {
      Promise.resolve()
        .then(onStop)
        .catch(err => ctx.logger.error(`关闭旧实例失败：${err?.message || err}`))
    }, 300)
    timer.unref?.()
  })

  http.route('POST', '/api/app/restart', async (req, res) => {
    if (!onRestart) return http.sendError(res, 501, '当前运行方式不支持自动重启，请手动关闭后重新启动')
    http.sendJson(res, 200, { ok: true, message: '正在重启念风…' })
    const timer = setTimeout(() => {
      Promise.resolve()
        .then(onRestart)
        .catch(err => ctx.logger.error(`重启失败：${err?.message || err}`))
    }, 180)
    timer.unref?.()
  })

  http.registerCapability?.('app-update')
  ctx.provide('appUpdate', { currentInfo, releases: fetchReleases }, { type: 'singleton' })
  ctx.logger.info('本体更新服务就绪')
}
