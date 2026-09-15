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

const CONFIG_KEY = 'nianfeng:config'

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


/**
 * 插件清单优先从后端取（内置 + 外部插件目录合并）。
 * 如果后端没起来或能力较旧，回退到打包时生成的 registry.mjs，
 * 保证纯静态/离线场景仍能启动。
 */
async function loadPluginEntries() {
  try {
    const base = pluginApiBase()
    const href = typeof location !== 'undefined' && location.href ? location.href : 'http://127.0.0.1/'
    const url = new URL(`${base}/plugins`, href)
    const timeout = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(3500) : undefined
    const res = await fetch(url.href, { cache: 'no-store', signal: timeout })
    if (!res.ok) return builtinPluginEntries
    const data = await res.json()
    if (!Array.isArray(data?.plugins) || !data.plugins.length) return builtinPluginEntries
    const entries = data.plugins
      .filter(entry => entry && entry.path)
      .map(entry => {
        // 外部插件路径是 /user-plugins/...；按「页面同源」转成绝对 URL。
        // 官方启动方式（start.mjs / 单端口 / 桌面壳）都会把 /user-plugins 代理到后端，
        // 这样插件内部的 ../../../src/... 相对引用也能落到同源的 /src 上。
        if (entry.external && entry.path.startsWith('/')) {
          try {
            const origin = typeof location !== 'undefined' && location.origin ? location.origin : url.origin
            return { ...entry, path: origin + entry.path }
          } catch (_) {
            return entry
          }
        }
        return entry
      })
      // 服务端代聊是 Node 环境，不认 http(s) 模块；外部插件改成同机 file:// 路径加载。
      if (globalThis.__NIANFENG_SERVER_AGENT__ === true) {
        return mapAgentExternalEntries(entries, `${base}/plugins/dirs`, href)
      }
      return entries
  } catch (_) {
    return builtinPluginEntries
  }
}

export async function boot() {
  const t0 = performance.now()
  const entries = await loadPluginEntries()
  const app = new App({ baseUrl: new URL('../', import.meta.url) })
  const { disabled, removed, enabled } = readBootConfig()

  window.__wind = app.rootCompat
  window.__wind_app = app
  window.__wind_debug = createDebug(app)

  await app.loadAll(entries, { disabled, removed, enabled })

  const ms = Math.round(performance.now() - t0)
  console.log(
    `%c念风%c 已启动 · ${app.activeCount}/${entries.length} 个插件激活 · cordis v4 · ${ms}ms`,
    'color:#70a15a;font-weight:600',
    'color:#8b919c',
  )
  app.emit('app:ready', { ms, count: app.activeCount, total: entries.length, version: VERSION })

  writeDiagnostics(app)
  hideBootScreen()
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
