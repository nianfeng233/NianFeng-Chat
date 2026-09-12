/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * F2 · config
 * 用户偏好持久化。点号路径读写（selectable.theme.activeId / plugins.disabled …），
 * 变更后广播 config:changed，任何插件都可以 watch。
 * 后端在线时会把整份偏好同步到当前数据目录的 config.json（preferences 字段），
 * 这样浏览器版 / 桌面版 / 不同 WebView2 数据目录之间都能恢复历史偏好。
 */
export const name = 'config'
export const version = '1.1.0'
export const displayName = '配置中心'
export const description = '基础服务 · 用户偏好持久化（本地 + 后端 preferences），支持点号路径与 watch。'
export const author = '念风内核'
export const icon = '⚙️'
export const core = true
export const depends = { storage: '^1.0.0' }
export const inject = ['storage', 'event-bus']
export const provides = [{ name: 'config', type: 'singleton' }]

const NS = 'config'
const KEY = 'data'

const DEFAULTS = {
  'app.name': '念风',
  'app.version': '0.40.0',
  'ui.compact': false,
  'ui.animation': true,
  'ui.signature': '',
  'ui.nickname': '',
  'ui.backgroundImage': '',
  // 每块玻璃板的外观参数：透明度 / 模糊 / 饱和度 / 亮度 / 边框宽度
  'ui.glass': {
    chatList: { alpha: 0.55, blur: 22, saturate: 150, brightness: 100, borderWidth: 1 },
    channelList: { alpha: 0.55, blur: 22, saturate: 150, brightness: 100, borderWidth: 1 },
    chatMain: { alpha: 0.55, blur: 22, saturate: 150, brightness: 100, borderWidth: 1 },
    channelMain: { alpha: 0.55, blur: 22, saturate: 150, brightness: 100, borderWidth: 1 },
    settingsNav: { alpha: 0.47, blur: 22, saturate: 150, brightness: 100, borderWidth: 0.5 },
    settingsContent: { alpha: 0.56, blur: 22, saturate: 150, brightness: 100, borderWidth: 0.5 },
    titlebar: { alpha: 0.42, blur: 14, saturate: 150, brightness: 100, borderWidth: 0.5 },
  },
  'general.restore': true,
  'general.minimizeOnClose': false,
  'debug': false,
  'plugins.disabled': [],
  'plugins.removed': [],
  'selectable.theme.activeId': 'light',
  'selectable.bg.activeId': 'bg-aurora',
  'selectable.bubble-styles.activeId': 'bubble-default',
  'selectable.model.activeId': '',
  'backend.url': '/api',
  // 模型页：内置模型开关（默认开启）与内置模型的请求参数
  'model.useBuiltin': true,
  'model.timeoutMs': 60000,
  'model.requestBody': '',
  'chat.stream': true,
  // 推理等级：DeepSeek 官方 off / low / high / max
  'chat.reasoningEffort': 'off',
  // 随机性：0 - 2 连续值（与推理等级相互独立）
  'chat.temperature': 1,
  // 时间戳分隔线：连续聊天时最多每 30 分钟补一条；消息间隔超过 10 分钟则重新插入
  'chat.dividerGapMs': 10 * 60 * 1000,
  'chat.dividerIntervalMs': 30 * 60 * 1000,
  // 聊天链路（文档：工具调用 / 记忆 / 权限 / 确认）
  'chat.toolsEnabled': true,
  'chat.toolChoice': 'required',
  'chat.maxToolRounds': 10,
  'chat.contextTokens': 4096,
  'chat.memoryRounds': 5,
  'chat.channelRounds': 5,
  'chat.readTokens': 1500,
  'chat.confirmSensitive': true,
  'chat.simulateTyping': true,
  'chat.typingMinMs': 500,
  'chat.typingMaxMs': 5000,
  'chat.typingPerCharMs': 35,
  'chat.requireToolCall': true,
  'chat.toolRetryLimit': 2,
  'chat.composerHeight': 0,
  'chat.userId': 'web-user',
  // 插件权限中心
  'permissions.preset': 'standard',
  'permissions.grants': {},
  'translator.enabled': false,
  'translator.target': 'en',
  'notify.system': true,
  'notify.sound': true,
  // 角色消息通知：收到新消息时在右下角展示提示（默认开启）
  'notify.messages': true,
  // 后台活动：页面不可见时仍发送通知（默认开启；旧版默认关闭会由 notification 插件迁移）
  'notify.background': true,
  // 旧版「后台活动默认关闭」的一次性迁移标记
  'notify.backgroundDefaultMigrated': false,
  'notify.pluginAllowed': true,
}

export function apply(ctx) {
  const storage = ctx.inject('storage')
  const events = ctx.inject('event-bus')
  // 不把 api 写进 inject：backend-client 本身依赖 config，静态注入会形成循环。
  // 这里按需从服务注册表取，后端就绪后 backend:status 会触发同步。
  const getApi = () => ctx.registry.get('api')
  let data = storage.get(NS, KEY, null)
  if (!data || typeof data !== 'object') data = {}
  let dirty = false
  for (const [key, value] of Object.entries(DEFAULTS)) {
    if (!hasPath(data, key)) {
      setPath(data, key, value)
      dirty = true
    }
  }
  if (dirty) storage.set(NS, KEY, data)

  const persist = () => storage.set(NS, KEY, data)

  let syncTimer = null
  let syncing = false
  let readyForPush = false

  const pushPreferences = async () => {
    const api = getApi()
    if (!api?.setConfig || !api?.configured?.()) return false
    try {
      await api.setConfig({ preferences: data })
      return true
    } catch (err) {
      ctx.logger.debug(`偏好写入后端失败：${err.message}`)
      return false
    }
  }

  const schedulePush = () => {
    if (!readyForPush) return
    if (syncTimer) ctx.clearTimeout(syncTimer)
    syncTimer = ctx.setTimeout(async () => {
      syncTimer = null
      await pushPreferences()
    }, 600)
  }

  /**
   * 后端上线后同步一次偏好：
   * 本地已经设置过的键优先；本地仍是默认值、后端有历史值的键采用后端值。
   * 这样既能把历史签名恢复回来，也不会覆盖当前设备上刚刚改过的设置。
   */
  const syncFromBackend = async () => {
    const api = getApi()
    if (syncing || !api?.getConfig || !api?.configured?.()) return
    syncing = true
    let pulled = false
    try {
      const remote = await api.getConfig()
      const remotePrefs = remote?.preferences
      if (remotePrefs && typeof remotePrefs === 'object' && Object.keys(remotePrefs).length) {
        const merged = mergeRemotePreferences(data, remotePrefs)
        if (!deepEqual(merged, data)) {
          data = merged
          persist()
          ctx.emit('config:changed', { key: '*', value: data })
        }
      }
      pulled = true
    } catch (err) {
      ctx.logger.debug(`偏好读取后端失败：${err.message}`)
    } finally {
      syncing = false
      if (pulled) {
        // 首次拉取 / 合并完成后才允许写回，避免启动期的默认值覆盖后端历史偏好。
        readyForPush = true
        await pushPreferences()
      }
    }
  }

  const service = {
    name: 'config',
    get(key, fallback = undefined) {
      if (key === undefined || key === '') return structuredClone(data)
      return hasPath(data, key) ? structuredClone(getPath(data, key)) : fallback
    },
    set(key, value) {
      if (key === undefined) return
      setPath(data, key, value)
      persist()
      ctx.emit('config:changed', { key, value })
      schedulePush()
      return value
    },
    remove(key) {
      removePath(data, key)
      persist()
      ctx.emit('config:changed', { key, value: undefined })
      schedulePush()
    },
    has(key) {
      return hasPath(data, key)
    },
    watch(key, callback) {
      return ctx.on('config:changed', payload => {
        if (!key || payload.key === key || payload.key?.startsWith(key + '.')) callback(payload.value, payload.key)
      })
    },
    all() {
      return structuredClone(data)
    },
    reset() {
      data = structuredClone(DEFAULTS)
      persist()
      ctx.emit('config:changed', { key: '*', value: data })
      schedulePush()
    },
    defaults: () => structuredClone(DEFAULTS),
  }

  ctx.effect(
    events.on('backend:status', payload => {
      if (payload?.online) syncFromBackend()
    }),
  )
  if (getApi()?.configured?.()) syncFromBackend()

  ctx.provide('config', service, { type: 'singleton' })
  ctx.logger.debug('配置中心就绪（本地 + 后端 preferences 同步）')
}

/* ---------------- 点号路径工具 ---------------- */
function toPath(key) {
  return String(key).split('.').filter(Boolean)
}
function hasPath(obj, key) {
  let cur = obj
  for (const part of toPath(key)) {
    if (cur === null || typeof cur !== 'object' || !(part in cur)) return false
    cur = cur[part]
  }
  return true
}
function getPath(obj, key) {
  let cur = obj
  for (const part of toPath(key)) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = cur[part]
  }
  return cur
}
function setPath(obj, key, value) {
  const parts = toPath(key)
  const last = parts.pop()
  let cur = obj
  for (const part of parts) {
    if (cur[part] === null || typeof cur[part] !== 'object') cur[part] = {}
    cur = cur[part]
  }
  cur[last] = value
}
function removePath(obj, key) {
  const parts = toPath(key)
  const last = parts.pop()
  let cur = obj
  for (const part of parts) {
    cur = cur?.[part]
    if (cur === undefined) return
  }
  if (cur && typeof cur === 'object') delete cur[last]
}

/** 把 DEFAULTS 展开成叶子路径，便于只对“仍是默认值”的键采用远端历史值 */
function flattenDefaults(obj, prefix = '', out = new Map()) {
  for (const [key, value] of Object.entries(obj || {})) {
    const path = prefix ? `${prefix}.${key}` : key
    if (value && typeof value === 'object' && !Array.isArray(value)) flattenDefaults(value, path, out)
    else out.set(path, value)
  }
  return out
}

function deepEqual(a, b) {
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch (_) {
    return false
  }
}

function mergeRemotePreferences(local, remote) {
  const merged = structuredClone(local)
  for (const [key, defaultValue] of flattenDefaults(DEFAULTS)) {
    if (!hasPath(remote, key)) continue
    const remoteValue = getPath(remote, key)
    const localValue = hasPath(merged, key) ? getPath(merged, key) : undefined
    if (deepEqual(localValue, defaultValue) && !deepEqual(remoteValue, defaultValue)) {
      setPath(merged, key, remoteValue)
    }
  }
  return merged
}
