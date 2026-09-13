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
const META_KEY = 'meta'
// 每次页面启动一个随机客户端 ID，用于偏好同步的冲突提示 / 调试。
const CLIENT_ID = `c_${Math.random().toString(36).slice(2, 10)}`

/**
 * 只属于当前设备的偏好，不写入后端共享 preferences：
 *  - backend.url：各端可能用不同后端地址 / 代理路径；
 *  - chat.composerHeight：输入框高度由本机窗口尺寸决定；
 *  - view.active / view.width.*：本机最后打开的视图与分栏宽度。
 */
function isLocalOnlyPreference(key) {
  const path = String(key || '')
  return (
    path === 'backend.url' ||
    path === 'chat.composerHeight' ||
    path === 'view.active' ||
    path.startsWith('view.width.')
  )
}

/** 递归删除目标对象里的本机偏好，得到可上报后端的快照。 */
function pruneLocalOnlyPreferences(target, prefix = '') {
  if (!target || typeof target !== 'object' || Array.isArray(target)) return target
  for (const key of Object.keys(target)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (isLocalOnlyPreference(path)) {
      delete target[key]
      continue
    }
    pruneLocalOnlyPreferences(target[key], path)
  }
  return target
}

function cloneMetaEntry(entry) {
  if (!entry || typeof entry !== 'object') return { at: Number(entry) || 0, by: '' }
  return { at: Number(entry.at) || 0, by: String(entry.by || '') }
}

const DEFAULTS = {
  'app.name': '念风',
  'app.version': '0.42.0',
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
  'general.restore': false,
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
  'model.failoverEnabled': false,
  'model.failoverKey': '',
  'model.failoverRetries': 1,
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
  // 图片策略：自动上下文最多带几张、单条消息最多带几张、每张图按固定 token 估算
  'chat.imagesPerRequest': 2,
  'chat.imagesPerMessage': 2,
  'chat.imageTokens': 800,
  'chat.confirmSensitive': true,
  'chat.simulateTyping': true,
  'chat.typingMinMs': 500,
  'chat.typingMaxMs': 5000,
  'chat.typingPerCharMs': 35,
  // 渠道输入状态：NapCat 输入中会很快消失，需要定时重报；微信原生输入中可以持续到整轮结束
  'napcat.inputState.enabled': true,
  'napcat.inputState.intervalMs': 3000,
  'napcat.inputState.timeoutMs': 10 * 60 * 1000,
  'chat.requireToolCall': true,
  // 严格模式最多纠正一次；之后直接把正文当回复发出，避免 DeepSeek 等模型
  // 不返回 tool_calls 时一次普通聊天连续等待数分钟。
  'chat.toolRetryLimit': 1,
  'chat.emptyRetryLimit': 2,
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

  let meta = storage.get(NS, META_KEY, null)
  if (!meta || typeof meta !== 'object') meta = {}

  const persist = () => storage.set(NS, KEY, data)
  const persistMeta = () => storage.set(NS, META_KEY, meta)

  const syncablePreferences = () => pruneLocalOnlyPreferences(structuredClone(data))
  const syncableMeta = () => {
    const out = {}
    for (const [key, entry] of Object.entries(meta)) {
      if (isLocalOnlyPreference(key)) continue
      out[key] = cloneMetaEntry(entry)
    }
    return out
  }

  let syncTimer = null
  let syncing = false
  let readyForPush = false

  const pushPreferences = async () => {
    const api = getApi()
    if (!api?.setConfig || !api?.configured?.()) return false
    try {
      await api.setConfig({ preferences: syncablePreferences(), preferencesMeta: syncableMeta() })
      return true
    } catch (err) {
      ctx.logger.debug(`偏好写入后端失败：${err.message}`)
      return false
    }
  }

  /**
   * 把远端共享偏好合并进本地：
   *  - 远端带有更新的 per-key 时间戳时覆盖本机旧值；
   *  - 本机本次会话刚改过、且比远端新的键保持不变，等推送完成后自然收敛；
   *  - 不再使用“本地值是默认值才采纳远端”的旧规则，否则手机上默认 off 会
   *    一直挡住电脑端同步过来的 high（旧版本推理等级显示不更新的根因）。
   */
  const applyRemotePreferences = (preferences, remoteMeta = {}, source = 'remote') => {
    if (!preferences || typeof preferences !== 'object') return 0
    const merged = mergePreferenceSnapshot(data, meta, preferences, remoteMeta, { isLocalOnly: isLocalOnlyPreference })
    const metaChanged = !deepEqual(merged.meta, meta)
    data = merged.data
    meta = merged.meta
    if (merged.changes.length || metaChanged) {
      persist()
      persistMeta()
    }
    for (const change of merged.changes) ctx.emit('config:changed', change)
    if (merged.changes.length) ctx.logger.debug(`已应用远端偏好 ${merged.changes.length} 项（${source}）`)
    return merged.changes.length
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
   * 后端上线 / 重连后同步一次偏好：
   * 远端与本地都带 per-key 时间戳，按“谁更新听谁的”合并；合并完成后再把
   * 本地快照推回后端，保证启动期默认值不会覆盖远端历史值，同时本机修改
   * 也会尽快收敛到共享配置。
   */
  const syncFromBackend = async () => {
    const api = getApi()
    if (syncing || !api?.getConfig || !api?.configured?.()) return
    syncing = true
    let pulled = false
    try {
      const remote = await api.getConfig()
      const remotePrefs = remote?.preferences
      const remoteMeta = remote?.preferencesMeta
      if (remotePrefs && typeof remotePrefs === 'object' && Object.keys(remotePrefs).length) {
        applyRemotePreferences(remotePrefs, remoteMeta, 'pull')
      }
      pulled = true
      // 通知需要把本地数据合并到共享数据目录的插件（例如渠道注册中心）：
      // remotePrefs 为 null 表示后端从未保存过对应数据，可安全把本机数据首次发布过去。
      ctx.emit('config:remote-synced', {
        remote: remotePrefs && typeof remotePrefs === 'object' ? structuredClone(remotePrefs) : null,
      })
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
      if (isLocalOnlyPreference(key)) {
        delete meta[key]
        persist()
        persistMeta()
        ctx.emit('config:changed', { key, value })
        return value
      }
      meta[key] = { at: Date.now(), by: CLIENT_ID }
      persist()
      persistMeta()
      ctx.emit('config:changed', { key, value })
      schedulePush()
      return value
    },
    remove(key) {
      removePath(data, key)
      delete meta[key]
      persist()
      persistMeta()
      ctx.emit('config:changed', { key, value: undefined })
      if (!isLocalOnlyPreference(key)) schedulePush()
    },
    /** 应用一次远端共享偏好；主要由 SSE settings/updated 与后端重连拉取调用。 */
    applyRemote: (preferences, remoteMeta, source = 'remote') => applyRemotePreferences(preferences, remoteMeta, source),
    meta: () => structuredClone(meta),
    has(key) {
      return hasPath(data, key)
    },
    watch(key, callback) {
      return ctx.on('config:changed', payload => {
        // key === '*' 表示整份偏好被替换（例如从后端合并恢复），
        // 此时所有具体键的 watcher 都应该收到该键的最新值。
        if (payload.key === '*') {
          const value = key && payload.value && typeof payload.value === 'object' ? getPath(payload.value, key) : payload.value
          callback(value, key || '*')
          return
        }
        if (!key || payload.key === key || payload.key?.startsWith(key + '.')) callback(payload.value, payload.key)
      })
    },
    all() {
      return structuredClone(data)
    },
    reset() {
      data = structuredClone(DEFAULTS)
      const at = Date.now()
      meta = {}
      for (const path of flattenValues(data).keys()) {
        if (path === 'app.channels' || path.startsWith('app.channels.')) continue
        if (!isLocalOnlyPreference(path)) meta[path] = { at, by: CLIENT_ID }
      }
      persist()
      persistMeta()
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
  // 后端 SSE settings/updated：任何一端的修改都会立即广播到所有在线页面，
  // 这是手机 / 电脑设置实时同步的链路；真正的冲突取舍在合并函数里按时间戳处理。
  ctx.effect(
    events.on('backend:event', payload => {
      if (payload?.event !== 'settings/updated') return
      const remote = payload.data?.preferences
      if (!remote || typeof remote !== 'object') return
      applyRemotePreferences(remote, payload.data?.preferencesMeta, 'sse')
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

function deepEqual(a, b) {
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch (_) {
    return false
  }
}

/** 把对象/数组里的所有叶子路径展开；数组作为整体，不继续下钻 */
function flattenValues(target, prefix = '', out = new Map()) {
  for (const [key, value] of Object.entries(target || {})) {
    const path = prefix ? `${prefix}.${key}` : key
    if (value && typeof value === 'object' && !Array.isArray(value)) flattenValues(value, path, out)
    else out.set(path, value)
  }
  return out
}

/**
 * 纯函数版偏好合并，便于测试和复用：
 *   local / localMeta    当前页面本地快照与 per-key 时间戳
 *   remote / remoteMeta  后端共享快照与 per-key 时间戳
 * 返回 { data, meta, changes }；changes 里是真正发生变化的键，供 watch / UI 更新。
 *
 * 时间戳规则：
 *   1. 两端时间不同时，新的赢；
 *   2. 都没有时间戳（旧版本数据）时远端优先，保证共享配置能修好旧页面上的本地默认值；
 *   3. app.channels 仍然按整份渠道数据的 updatedAt 比较，避免把两组渠道搅在一起。
 */
export function mergePreferenceSnapshot(local, localMeta = {}, remote = {}, remoteMeta = {}, { isLocalOnly = isLocalOnlyPreference } = {}) {
  const data = structuredClone(local && typeof local === 'object' ? local : {})
  const meta = structuredClone(localMeta && typeof localMeta === 'object' ? localMeta : {})
  const remoteObj = remote && typeof remote === 'object' ? remote : {}
  const remoteMetaObj = remoteMeta && typeof remoteMeta === 'object' ? remoteMeta : {}
  const changes = []

  const remoteChannels = remoteObj.app?.channels
  if (remoteChannels && typeof remoteChannels === 'object' && !Array.isArray(remoteChannels)) {
    const localChannels = data.app?.channels
    const remoteAt = Number(remoteChannels.updatedAt) || 0
    const localAt = Number(localChannels?.updatedAt) || 0
    if ((!localChannels || remoteAt >= localAt) && !deepEqual(localChannels, remoteChannels)) {
      setPath(data, 'app.channels', structuredClone(remoteChannels))
      meta['app.channels'] = cloneMetaEntry(remoteMetaObj['app.channels'])
      changes.push({ key: 'app.channels', value: structuredClone(remoteChannels) })
    }
  }

  for (const [key, remoteValue] of flattenValues(remoteObj)) {
    // app.channels 已按整份渠道数据处理，避免叶子级合并把渠道数据搅乱。
    if (key === 'app.channels' || key.startsWith('app.channels.')) continue
    if (isLocalOnly(key)) continue
    const localHas = hasPath(data, key)
    const localValue = localHas ? getPath(data, key) : undefined
    const localAt = Number(meta[key]?.at) || 0
    const entry = cloneMetaEntry(remoteMetaObj[key])
    const remoteAt = entry.at
    const same = localHas && deepEqual(localValue, remoteValue)
    if (!same) {
      // 本机本次会话刚改过、且时间更新：先保留本机值，等待推送完成。
      if (localHas && localAt > remoteAt) continue
      setPath(data, key, structuredClone(remoteValue))
      meta[key] = entry
      changes.push({ key, value: structuredClone(remoteValue) })
    } else if (remoteAt >= localAt) {
      // 值虽然一样，也采用远端的更新时间，避免之后本机反向覆盖。
      meta[key] = entry
    }
  }

  return { data, meta, changes }
}
