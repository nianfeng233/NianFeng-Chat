/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * 应用入口：创建基于真实 cordis 的运行时 → 加载插件 → 启动 → 暴露调试对象。
 *
 * cordis 负责：插件生命周期（fiber）、依赖注入、事件总线、日志、服务注册。
 * 念风运行时负责：插件清单、状态视图、启停策略、诊断信息。
 */
import { App, VERSION, STATUS } from './runtime/app.mjs'
import { plugins as builtinPluginEntries } from '../plugins/registry.mjs'
import { isPluginInScope } from './runtime/plugin-scope.mjs'
import { installEventSourceMultiplexer } from './util/event-source-multiplex.mjs'

// 浏览器同一 host 的 HTTP/1.1 连接池有限，多个插件各开一条 /api/events 会占满；
// 入口统一复用相同 origin + pathname 的 EventSource，避免刷新后 WebUI 排队卡加载。
installEventSourceMultiplexer()

const CONFIG_KEY = 'nianfeng:config'

/**
 * 后端 /api/plugins 会附带共享 preferences 里的插件启停状态。
 * 服务端代聊 Worker 的 localStorage 是空的，必须靠它来决定是否加载外部插件；
 * 普通 WebUI 也会与本地缓存取并集，保证“页面卸载后所有运行时都停用”。
 */
const PLUGIN_CACHE_KEY = 'nianfeng:plugin-snapshot'

let remotePluginState = null
let remotePluginEntries = null

function readRemotePluginState(data) {
  const list = value => (Array.isArray(value) ? value.map(item => String(item || '').trim()).filter(Boolean) : null)
  const disabled = list(data?.disabled)
  const removed = list(data?.removed)
  const enabled = list(data?.enabled)
  if (!disabled && !removed && !enabled) return null
  return { disabled: disabled || [], removed: removed || [], enabled: enabled || [] }
}

function mergePluginIds(...lists) {
  const out = new Set()
  for (const list of lists) {
    if (!Array.isArray(list)) continue
    for (const id of list) {
      const value = String(id || '').trim()
      if (value) out.add(value)
    }
  }
  return [...out]
}

function readBootConfig() {
  try {
    const raw = localStorage.getItem(CONFIG_KEY)
    const parsed = raw ? JSON.parse(raw) : {}
    // config 服务把点号路径存成嵌套对象：plugins.disabled → { plugins: { disabled: [...] } }
    const data = parsed?.data && typeof parsed.data === 'object' ? parsed.data : parsed || {}
    const plugins = data.plugins || {}
    return {
      disabled: Array.isArray(plugins.disabled) ? plugins.disabled : [],
      removed: Array.isArray(plugins.removed) ? plugins.removed : [],
      enabled: Array.isArray(plugins.enabled) ? plugins.enabled : [],
    }
  } catch (_) {
    return { disabled: [], removed: [], enabled: [] }
  }
}

/** 与 backend-client 一样，优先读 config['backend.url']，默认走同源 /api */
function pluginApiBase() {
  try {
    const parsed = JSON.parse(localStorage.getItem(CONFIG_KEY) || '{}')
    const data = parsed?.data && typeof parsed.data === 'object' ? parsed.data : parsed || {}
    return String(data?.backend?.url || '/api').replace(/\/+$/, '')
  } catch (_) {
    return '/api'
  }
}

/** 最近一次 /api/plugins 结果缓存：远程部署刷新时先用缓存秒开，再后台校验增量。 */
function readPluginCache() {
  try {
    const raw = localStorage.getItem(PLUGIN_CACHE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed?.entries) || !parsed.entries.length) return null
    return parsed
  } catch (_) {
    return null
  }
}

function writePluginCache(snapshot) {
  try {
    localStorage.setItem(
      PLUGIN_CACHE_KEY,
      JSON.stringify({
        entries: snapshot.entries,
        state: snapshot.state || null,
        at: snapshot.at || Date.now(),
      }),
    )
  } catch (_) {
    /* localStorage 满了也不影响启动 */
  }
}

/**
 * 服务端代聊 Worker 运行在 Node 中，默认 ESM loader 不支持 import('http(s)://...')，
 * 外部插件如果继续用 /user-plugins 的 HTTP 地址会在代聊里加载失败（浏览器 WebUI 不受影响）。
 * 代聊与后端同机，这里从后端拿到外部插件目录，把外部插件路径改写成本地 file:// URL。
 */
async function mapAgentExternalEntries(entries, dirsPath, href) {
  try {
    const res = await fetch(new URL(dirsPath, href).href, { cache: 'no-store' })
    if (!res.ok) return entries
    const dirs = await res.json()
    const externalDir = String(dirs?.externalDir || '').trim()
    if (!externalDir) return entries
    const [{ join }, { pathToFileURL }] = await Promise.all([import('node:path'), import('node:url')])
    return entries.map(entry => {
      if (!entry?.external) return entry
      const folder = String(entry.dir || entry.id || '').trim()
      if (!folder) return entry
      try {
        return { ...entry, path: pathToFileURL(join(externalDir, folder, 'index.mjs')).href }
      } catch (_) {
        return entry
      }
    })
  } catch (err) {
    console.warn(`[agent] 外部插件目录解析失败，外部插件在代聊中不可用：${err?.message || err}`)
    return entries
  }
}

/** 拉取一次后端插件清单并归一化路径；失败时抛错，由调用方决定回退策略。 */
export async function fetchPluginSnapshot({ timeoutMs = 8000 } = {}) {
  const base = pluginApiBase()
  const href = typeof location !== 'undefined' && location.href ? location.href : 'http://127.0.0.1/'
  const url = new URL(`${base}/plugins`, href)
  const signal =
    typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined
  const res = await fetch(url.href, { cache: 'no-store', signal })
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
  const data = await res.json()
  if (!Array.isArray(data?.plugins) || !data.plugins.length) throw new Error('后端未返回插件清单')

  const origin = typeof location !== 'undefined' && location.origin ? location.origin : url.origin
  let entries = data.plugins
    .filter(entry => entry && entry.path)
    .map(entry => {
      // 外部插件路径是 /user-plugins/...；按「页面同源」转成绝对 URL。
      // 官方启动方式（start.mjs / 单端口 / 桌面壳）都会把 /user-plugins 代理到后端，
      // 这样插件内部的 ../../../src/... 相对引用也能落到同源的 /src 上。
      if (entry.external && entry.path.startsWith('/')) {
        try {
          return { ...entry, path: origin + entry.path }
        } catch (_) {
          return entry
        }
      }
      return entry
    })
  // 服务端代聊是 Node 环境，不认 http(s) 模块；外部插件改成同机 file:// 路径加载。
  if (globalThis.__NIANFENG_SERVER_AGENT__ === true) {
    entries = await mapAgentExternalEntries(entries, `${base}/plugins/dirs`, href)
  }
  return {
    entries,
    state: readRemotePluginState(data) || { disabled: [], removed: [], enabled: [] },
    dirs: {
      builtinDir: data.builtinDir,
      externalDir: data.externalDir,
      externalCount: data.externalCount,
      count: data.count,
      warnings: data.warnings || [],
    },
    at: Date.now(),
  }
}

/**
 * 兼容旧调用：优先从后端取；拿不到就用内置清单先启动，
 * 之后 scheduleRemotePluginSync 会在后台补上外部插件。
 */
async function loadPluginEntries() {
  const snapshot = await fetchPluginSnapshot({ timeoutMs: 4000 })
  remotePluginState = snapshot.state
  remotePluginEntries = snapshot.entries
  writePluginCache(snapshot)
  return snapshot
}

/** 启动进度条文案：让“加载插件”从黑盒等待变成可见的 N/M。 */
function updateBootProgress(progress) {
  try {
    const tip = document.getElementById('bootTip')
    if (!tip || !progress) return
    if (progress.phase === 'import') tip.textContent = `正在加载插件… ${progress.loaded}/${progress.total}`
    else if (progress.phase === 'ready') tip.textContent = '正在启动界面…'
  } catch (_) {
    /* 测试环境无 DOM 时忽略 */
  }
}

let remoteSyncTimer = null
let remoteSyncRetry = 0
/**
 * 运行期插件清单同步：新增 / 更新 / 删除 / 启停都由 App.syncEntries 热完成，
 * 不再用 location.reload()，也不再重启服务端代聊 Worker。
 * 失败按 1.5s ~ 30s 退避重试；页面重新可见 / 后端恢复在线时也会触发。
 */
export function scheduleRemotePluginSync(app, { delay = 0, reason = 'background', scope = null } = {}) {
  if (!app) return null
  const activeScope = scope || app.scope || 'all'
  if (remoteSyncTimer) clearTimeout(remoteSyncTimer)
  remoteSyncTimer = setTimeout(async () => {
    remoteSyncTimer = null
    try {
      const snapshot = await fetchPluginSnapshot({ timeoutMs: 10000 })
      remotePluginState = snapshot.state
      remotePluginEntries = snapshot.entries
      writePluginCache(snapshot)
      const scopedEntries = snapshot.entries.filter(entry => isPluginInScope(entry, activeScope))
      const result = await app.syncEntries(scopedEntries, {
        ...snapshot.state,
        reason,
        scope: activeScope,
        onProgress: updateBootProgress,
      })
      remoteSyncRetry = 0
      app.emit('plugins:remote-synced', { reason, changed: result?.changed || [], active: result?.active })
      return result
    } catch (err) {
      remoteSyncRetry += 1
      const wait = Math.min(30000, 1500 * 2 ** Math.min(remoteSyncRetry, 4))
      console.debug(`[plugins] 远程插件清单同步失败，${wait}ms 后重试：${err?.message || err}`)
      scheduleRemotePluginSync(app, { delay: wait, reason: 'retry', scope: activeScope })
      return null
    }
  }, Math.max(0, Number(delay) || 0))
  remoteSyncTimer?.unref?.()
  return remoteSyncTimer
}

export async function boot({ awaitRemote = false, scope = 'all' } = {}) {
  const t0 = performance.now()
  const activeScope = scope || 'all'
  const cached = readPluginCache()
  // 普通 WebUI：有缓存就直接用缓存启动；没有缓存时最多等后端 1.2 秒拿清单，
  // 拿不到就先用内置清单把界面拉起来，外部插件通过后台热同步补上。
  let snapshot = cached || { entries: builtinPluginEntries, state: null, at: 0 }
  if (awaitRemote) {
    try {
      snapshot = await loadPluginEntries()
    } catch (err) {
      console.warn(`[plugins] 启动时读取后端插件清单失败，先用内置清单启动：${err?.message || err}`)
      snapshot = snapshot || { entries: builtinPluginEntries, state: null, at: 0 }
    }
  } else if (!cached) {
    try {
      const remote = await new Promise(resolve => {
        const timer = setTimeout(() => resolve(null), 1200)
        loadPluginEntries()
          .then(value => {
            clearTimeout(timer)
            resolve(value)
          })
          .catch(() => {
            clearTimeout(timer)
            resolve(null)
          })
      })
      if (remote) snapshot = remote
    } catch (_) {
      /* 用内置清单启动即可 */
    }
  }

  const rawEntries = Array.isArray(snapshot.entries) && snapshot.entries.length ? snapshot.entries : builtinPluginEntries
  const entries = rawEntries.filter(entry => isPluginInScope(entry, activeScope))
  const app = new App({ baseUrl: new URL('../', import.meta.url) })
  const localPluginState = readBootConfig()
  // 并入后端共享状态：本机 localStorage 为空（代聊 Worker）或新设备首次打开时，
  // 也能立刻得到“卸载 / 禁用”结果，而不是先加载再等偏好同步。
  const remoteState = snapshot.state || remotePluginState
  const disabled = mergePluginIds(localPluginState.disabled, remoteState?.disabled)
  const removed = mergePluginIds(localPluginState.removed, remoteState?.removed)
  const enabled = mergePluginIds(localPluginState.enabled, remoteState?.enabled)

  window.__wind = app.rootCompat
  window.__wind_app = app
  window.__wind_debug = createDebug(app)

  await app.loadAll(entries, { disabled, removed, enabled, onProgress: updateBootProgress, scope: activeScope })

  const ms = Math.round(performance.now() - t0)
  console.log(
    `%c念风%c 已启动 · ${app.activeCount}/${entries.length} 个插件激活 · cordis v4 · ${ms}ms`,
    'color:#70a15a;font-weight:600',
    'color:#8b919c',
  )
  app.emit('app:ready', { ms, count: app.activeCount, total: entries.length, version: VERSION })

  // 先让外壳渲染出来，再在后台同步远程清单 / 外部插件。
  writeDiagnostics(app)
  hideBootScreen()
  try {
    app.rootCompat.on('plugins:changed', payload => scheduleRemotePluginSync(app, { delay: 120, reason: payload?.data?.action || 'event', scope: activeScope }))
    app.rootCompat.on('backend:status', status => {
      if (status?.online) scheduleRemotePluginSync(app, { delay: 80, reason: 'backend-online', scope: activeScope })
    })
    if (typeof document !== 'undefined') {
      const onVisible = () => {
        if (!document.hidden) scheduleRemotePluginSync(app, { delay: 120, reason: 'visible', scope: activeScope })
      }
      document.addEventListener('visibilitychange', onVisible)
      if (typeof window !== 'undefined') window.__nianfengPluginVisibility = onVisible
    }
  } catch (err) {
    console.debug('[plugins] 安装后台同步监听失败：', err)
  }
  scheduleRemotePluginSync(app, { delay: awaitRemote ? 60 : 900, reason: awaitRemote ? 'headless-initial' : 'initial', scope: activeScope })
  return { app, ctx: app.rootCompat, cordis: app.cordis, loader: app, version: VERSION }
}

function summaryDependencyIssue(item) {
  return { name: item.name, range: item.range, status: item.status, reason: item.reason }
}

function writeDiagnostics(app) {
  try {
    const list = app.list()
    const diag = document.createElement('div')
    diag.id = 'wind-diag'
    diag.hidden = true
    diag.dataset.runtime = 'cordis'
    diag.dataset.active = String(app.activeCount)
    diag.dataset.total = String(list.length)
    diag.dataset.services = String(app.serviceList().length)
    diag.dataset.errors = JSON.stringify(list.filter(r => r.status === STATUS.ERROR).map(r => ({ id: r.id, reason: r.reason })))
    diag.dataset.inactive = JSON.stringify(list.filter(r => r.status === STATUS.INACTIVE).map(r => ({ id: r.id, reason: r.reason })))
    diag.dataset.disabled = JSON.stringify(list.filter(r => r.status === STATUS.DISABLED).map(r => r.id))
    diag.dataset.dependencyErrors = JSON.stringify(
      list
        .filter(r => r.dependencyHealth === 'error')
        .map(r => ({ id: r.id, issues: (r.dependencyIssues || []).filter(item => item.required).map(item => summaryDependencyIssue(item)) })),
    )
    diag.dataset.dependencyWarnings = JSON.stringify(
      list
        .filter(r => r.dependencyHealth === 'warning')
        .map(r => ({ id: r.id, issues: (r.dependencyIssues || []).filter(item => !item.required).map(item => summaryDependencyIssue(item)) })),
    )
    diag.dataset.warnings = JSON.stringify(app.warnings)
    diag.dataset.plugins = JSON.stringify(list.map(r => ({ id: r.id, status: r.status })))
    document.body.appendChild(diag)
  } catch (err) {
    console.warn('[nianfeng] 诊断信息写入失败', err)
  }
}

function hideBootScreen() {
  const bootEl = document.getElementById('boot')
  if (!bootEl) return
  bootEl.classList.add('fade')
  setTimeout(() => bootEl.remove(), 420)
}

function createDebug(app) {
  return {
    runtime: 'cordis',
    ctx: app.cordis,
    app,
    loader: app,
    status: () => app.list(),
    services: () => app.serviceList(),
    events: () => app.eventsFacade.eventNames().map(name => ({ name, listeners: app.eventsFacade.listeners(name) })),
    trace(on = true) {
      app.trace = on ? (phase, name, payload, owner) => console.log(`[${phase}] ${name}`, owner, payload) : null
      return on
    },
    enable: id => app.enable(id),
    disable: id => app.disable(id),
    emit: (event, payload) => app.emit(event, payload),
    warnings: () => app.warnings,
    graph: () => app.graph(),
    heuristics: () => app.detectSemanticConflicts(),
    fibers: () => [...app.records.values()].map(r => ({ id: r.id, state: r.fiber?.state, name: r.fiber?.name })),
    reload: () => location.reload(),
  }
}
