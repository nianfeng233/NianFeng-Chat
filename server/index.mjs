/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * 后端启动器：用真实 cordis 组装后端插件。
 *
 *   node server/index.mjs                 # 只启动后端（8788）
 *   startBackend({ staticDir: 'dist' })   # 后端同时托管 WebUI（单端口部署）
 */
import { Context } from 'cordis'
import { readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join, resolve } from 'node:path'

import { resolveDataDir } from './data-dir.mjs'
import { ensurePortsFree } from './port-utils.mjs'
import * as settingsPlugin from './plugins/settings.mjs'
import * as sessionsPlugin from './plugins/sessions.mjs'
import * as hubPlugin from './plugins/hub.mjs'
import * as modelsPlugin from './plugins/models.mjs'
import * as instancePlugin from './plugins/instance.mjs'
import * as pluginRegistryPlugin from './plugins/plugin-registry.mjs'
import * as httpPlugin from './plugins/http.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/**
 * 通用插件后端桥加载器：
 *   - 内置：扫描 plugins 目录下所有 bridge.mjs（渠道桥、图片服务等后端能力统一走这里）
 *   - 外部：扫描数据目录 / 环境变量插件目录里的 bridge.mjs
 * 后端桥是普通 Node cordis 插件，可以 inject httpApi / settings / hub 等，
 * 自行注册自己的 /api/... 路由，因此新增渠道 / 服务无需改 server/index.mjs 本体逻辑。
 *
 * 安全提示：外部插件的 bridge.mjs 是后端 Node 代码，权限大于前端插件；只加载可信插件。
 */
async function collectBridgeFiles(root, depth = 0, out = []) {
  if (!root || depth > 5) return out
  let entries = []
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (_) {
    return out
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'release' || entry.name === 'target') continue
    const full = join(root, entry.name)
    if (entry.isDirectory()) await collectBridgeFiles(full, depth + 1, out)
    else if (entry.isFile() && entry.name === 'bridge.mjs') out.push(full)
  }
  return out
}

async function loadChannelBridges(roots, ctx) {
  const seen = new Set()
  for (const root of roots) {
    const files = (await collectBridgeFiles(root)).sort()
    for (const file of files) {
      if (seen.has(file)) continue
      seen.add(file)
      try {
        const mod = await import(pathToFileURL(file).href + `?v=${Date.now()}`)
        if (typeof mod.apply === 'function') ctx.plugin(mod, {})
      } catch (err) {
        console.warn(`[channel-bridge] 加载 ${file} 失败：${err?.message || err}`)
      }
    }
  }
}

export async function startBackend({ port = 8788, host = '127.0.0.1', dataDir, staticDir, logLevel, accessToken = '', onRestart = null } = {}) {
  const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'))
  const ctx = new Context()

  ctx.provide('info', {
    name: '念风chat 后端',
    version: pkg.version,
    node: process.version,
    startedAt: Date.now(),
  })

  const listening = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('后端启动超时（8 秒）')), 8000)
    ctx.once('http/listening', info => {
      clearTimeout(timer)
      resolve(info)
    })
    ctx.once('http/error', err => {
      clearTimeout(timer)
      reject(new Error(err?.code === 'EADDRINUSE' ? `端口 ${port} 已被占用：可运行「npm run stop」或双击 stop.cmd 关闭旧实例，也可用 BACKEND_PORT 换端口` : err?.message || String(err)))
    })
  })

  // 测试 / 嵌入场景可以显式指定 dataDir；此时实例指针也隔离在该目录里，
  // 不污染项目自己的 user_data/instance.json。
  const paths = dataDir
    ? {
        root: ROOT,
        homeDir: dataDir,
        instanceFile: join(dataDir, 'instance.json'),
        legacyDir: join(ROOT, 'data'),
        dataDir,
        migrated: false,
        envOverride: false,
        appDir: join(ROOT, '.tmp', 'app-config'),
        appInstanceFile: join(ROOT, '.tmp', 'app-config', 'instance.json'),
        source: 'explicit',
      }
    : await resolveDataDir(ROOT)

  const plugins = [
    [settingsPlugin, { dataDir: paths.dataDir, logLevel }],
    [sessionsPlugin, { dataDir: paths.dataDir }],
    [hubPlugin, {}],
    [modelsPlugin, {}],
    [instancePlugin, paths],
    [pluginRegistryPlugin, { builtinDir: join(ROOT, 'plugins') }],
    [httpPlugin, { port, host, staticDir: staticDir ? join(ROOT, staticDir) : null, accessToken, onRestart }],
  ]
  for (const [plugin, config] of plugins) ctx.plugin(plugin, config)

  const info = await listening
  // 等配置与会话都完成加载后再开始对外服务（避免请求撞上初始化写盘）
  await Promise.all([ctx.sessions.ready(), ctx.settings?.ready?.()])
  paths.dataDir = ctx.instance?.info?.().dataDir || paths.dataDir

  // HTTP 服务已就绪、httpApi 已 provide 后，再自动加载渠道后端桥（无需逐个写进本文件）。
  // 外部插件目录优先级：环境变量 > 设置页配置 > 默认 <数据目录>/plugins。
  const configuredPluginDir = String(ctx.settings?.get?.()?.plugins?.dir || '').trim()
  const externalPluginDir =
    process.env.NIANFENG_PLUGINS_DIR ||
    process.env.FENGYU_PLUGINS_DIR ||
    configuredPluginDir ||
    join(paths.dataDir || dataDir || join(ROOT, 'user_data'), 'plugins')
  await loadChannelBridges([join(ROOT, 'plugins'), externalPluginDir], ctx)
  await new Promise(resolve => setTimeout(resolve, 0))

  return {
    ctx,
    port: info.port,
    host: info.host,
    url: info.url,
    dataDir: paths.dataDir,
    homeDir: paths.homeDir,
    instanceFile: paths.instanceFile,
    /** 优雅关闭：先落盘，再关 HTTP */
    async close() {
      try {
        await ctx.sessions.flush()
      } catch (_) {
        /* ignore */
      }
      // 先保存 server 引用：插件卸载后 http 服务会被一起释放，不能再从 ctx 上取。
      let httpServer = null
      try {
        httpServer = ctx.http?.server || null
      } catch (_) {
        httpServer = null
      }
      // 先卸载插件，让渠道 bridge 有机会关闭 reverse WebSocket / 定时器等资源，
      // 否则 server.close() 会被仍挂着的 upgrade 连接卡住。
      try {
        await Promise.race([
          ctx.root.fiber?.dispose?.(),
          new Promise(resolve => setTimeout(resolve, 2000)),
        ])
      } catch (_) {
        /* ignore */
      }
      if (httpServer) {
        try {
          httpServer.closeIdleConnections?.()
          httpServer.closeAllConnections?.()
        } catch (_) {
          /* 旧版 Node 没有这两个方法 */
        }
        await Promise.race([
          new Promise(resolve => httpServer.close(resolve)),
          new Promise(resolve => setTimeout(resolve, 2500)),
        ])
        try {
          httpServer.closeAllConnections?.()
        } catch (_) {
          /* ignore */
        }
      }
    },
  }
}

// 直接运行：node server/index.mjs
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // WebUI 监听与访问令牌来自当前数据目录的 config.json（明文 network 段）。
  // 桌面壳会把 NIANFENG_HOME_DIR 传进来，token 会额外写入 <HOME>/.webui-token，
  // 交给 Rust 在创建 WebView 时带 ?token= 打开，避免启用 token 后桌面白屏。
  const resolved = await resolveDataDir(ROOT)
  let network = {}
  try {
    network = JSON.parse(await readFile(join(resolved.dataDir, 'config.json'), 'utf8'))?.network || {}
  } catch (_) {
    network = {}
  }
  const accessToken = String(process.env.NIANFENG_WEBUI_TOKEN || process.env.FENGYU_WEBUI_TOKEN || network.webuiToken || '').trim()
  const host = String(process.env.NIANFENG_WEBUI_HOST || process.env.FENGYU_WEBUI_HOST || network.webuiHost || '127.0.0.1').trim() || '127.0.0.1'
  const configuredPort = Number(network.webuiPort) > 0 ? Number(network.webuiPort) : 0
  const port = configuredPort || Number(process.env.PORT || 8788)
  await ensurePortsFree([port], { autoStop: true, log: console })
  const homeEnv = process.env.NIANFENG_HOME_DIR || process.env.FENGYU_HOME_DIR
  if (homeEnv) {
    const tokenFile = join(resolve(homeEnv), '.webui-token')
    try {
      if (accessToken) await writeFile(tokenFile, accessToken, 'utf8')
      else await rm(tokenFile, { force: true })
    } catch (_) {
      /* 写不了 token 文件不影响协议本身 */
    }
  }

  const backend = await startBackend({
    port,
    host,
    staticDir: process.env.NIANFENG_STATIC_DIR || process.env.FENGYU_STATIC_DIR || undefined,
    dataDir: process.env.NIANFENG_DATA_DIR || process.env.FENGYU_DATA_DIR || undefined,
    accessToken,
  })
  console.log('')
  console.log(`  ┌──────────────────────────────────────────────┐`)
  console.log(`  │  念风chat 后端 · cordis v4                        │`)
  console.log(`  │  ${backend.url.padEnd(44, ' ')} │`)
  console.log(`  └──────────────────────────────────────────────┘`)
  console.log(`  数据目录：${backend.dataDir}`)
  if (homeEnv) {
    try {
      await writeFile(join(resolve(homeEnv), '.webui-port'), String(backend.port), 'utf8')
    } catch (_) {
      /* 端口文件仅用于桌面壳导航，写不了不影响服务 */
    }
  }
  console.log('  按 Ctrl+C 停止')
  // 桌面壳 / 部署脚本通过这一行判断服务已就绪
  console.log(`NIANFENG_READY ${backend.url}`)
  const shutdown = async () => {
    console.log('\n正在关闭…')
    await backend.close()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
