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
import { flattenValues, getPath, hasPath, removePath, setPath } from '../../../src/shared/object-path.mjs'

export const name = 'config'
export const version = '1.2.0'
export const displayName = '配置中心'
export const description = '基础服务 · 用户偏好持久化（本地 + 后端 preferences），支持点号路径与 watch。'
export const author = '念风内核'
export const icon = '⚙️'
export const core = true
export const depends = {
  'event-bus': '*',
  'storage': '^1.0.0',
}
export const optionalDepends = {}
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
  'app.version': '2.0.0',
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
  // 运行日志页默认只勾选 info；用户勾选组合会通过 preferences 跨端 / 跨重启保留。
  'logs.levels': ['info'],
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
  // 备用模型列表：数组顺序即失败后的尝试顺序，设置页支持拖拽调整。
  'model.failoverKeys': [],
  // 列表循环轮数：1 = 每个备用模型依次尝试一次；2-3 = 全部失败后再从头循环。
  'model.failoverPasses': 1,
  'chat.stream': true,
  // 推理等级：DeepSeek 官方 off / low / high / max
  'chat.reasoningEffort': 'off',
  // 随机性：0 - 2 连续值（与推理等级相互独立）
  'chat.temperature': 1,
  // 时间戳分隔线：连续聊天时最多每 30 分钟补一条；消息间隔超过 10 分钟则重新插入
  'chat.dividerGapMs': 10 * 60 * 1000,
  'chat.dividerIntervalMs': 30 * 60 * 1000,
  // 大历史消息区窗口化（只限制 DOM 行数，不裁剪 conv.messages 数据）：
  // 首屏最近 N 条、向上/向下滚动每次补 N 条、DOM 最多保留 N 行。
  'chat.messageWindowInitial': 80,
  'chat.messageWindowStep': 80,
  'chat.messageWindowMax': 300,
  // 会话聊天页每次从后端拉取的可见消息条数（懒加载，不再首屏全量同步历史）。
  'chat.messagePageSize': 20,
  // 聊天链路（文档：工具调用 / 记忆 / 权限 / 确认）
  'chat.toolsEnabled': true,
  'chat.toolChoice': 'required',
  'chat.maxToolRounds': 10,
  'chat.contextTokens': 0,
  'chat.maxOutputTokens': 8192,
  'chat.memoryRounds': 5,
  'chat.channelRounds': 5,
  // 跨渠道工作记忆最多带几轮（来自同一角色的其它普通私聊渠道）。
  // 默认只取 2 轮，避免旧渠道话题污染当前对话；填 0 彻底关闭跨渠道工作记忆。
  'chat.crossChannelMemoryRounds': 2,
  // NapCat 群聊默认保留的最近消息“条数”；渠道里的 groupRules.contextMessages > 0 时单独覆盖。
  // 群聊不适合按“轮”推算，统一按逐条消息数量控制。
  'chat.groupMessages': 20,
  'chat.readTokens': 1500,
  // 长期记忆（参考 MemMachine）：私聊 / 隐私每 summaryRounds 轮完整对话压缩成一段短概括并向量化；
  // 群聊默认按最近 N 条消息窗口概括，可用 groupSummaryEnabled 总开关或
  // groupSummaryDisabled.<channelId> 逐群关闭。存储与检索都在后端完成，
  // 设置页「模型 → 记忆模型」选择向量 / 概括模型。
  'memory.enabled': true,
  'memory.autoSummarize': true,
  'memory.summaryRounds': 10,
  'memory.groupSummaryEnabled': true,
  'memory.embeddingProvider': '',
  'memory.embeddingModel': '',
  'memory.embeddingDimension': 0,
  'memory.summaryProvider': '',
  'memory.summaryModel': '',
  // 图片策略：自动上下文最多带几张、单条消息最多带几张、每张图按固定 token 估算
  'chat.imagesPerRequest': 2,
  'chat.imagesPerMessage': 2,
  'chat.imageTokens': 800,
  // 自动上下文内联图片的总字节预算（data URL 字符数近似）：超过后降级为 [图片] 占位，防止 /api/chat 请求体爆掉
  'chat.imageBytesPerRequest': 8 * 1024 * 1024,
    // 本地图片文件保留数量：超过后自动删除最旧的图片，避免硬盘无限增长
    'chat.imageStoreLimit': 30,
  'chat.confirmSensitive': true,
  'chat.simulateTyping': true,
  'chat.typingMinMs': 500,
  'chat.typingMaxMs': 5000,
  'chat.typingPerCharMs': 35,
  // 合并转发（QQ 聊天记录）：单条消息超过阈值字数后自动折叠，避免大段长文刷屏
  'chat.forwardThreshold': 1500,
  // 转发记录里单个节点的正文上限；超长正文拆成多个节点
  'chat.forwardNodeChars': 1500,
  // 单条转发记录最多多少个节点（超长资料会被截断并标注省略字数）
  'chat.forwardMaxNodes': 20,
  // 渠道输入状态：NapCat 输入中会很快消失，需要定时重报；微信原生输入中可以持续到整轮结束
  'napcat.inputState.enabled': true,
  'napcat.inputState.intervalMs': 3000,
  'napcat.inputState.timeoutMs': 10 * 60 * 1000,
  'chat.requireToolCall': true,
  // 严格模式的纠正次数；达到上限后经 chat_send 发送链兜底，不直发裸正文。
  'chat.toolRetryLimit': 3,
  // 每条 user 消息的 meta 里附一句“必须调用工具回复”的短提醒，缓解长上下文稀释。
  'chat.perMessageToolReminder': true,
  // 导入的旧聊天记录默认不自动进入最近上下文，只供 read_messages 检索；
  // 打开后按 user 起始的正常轮次规则，只带最近几轮。
  'chat.includeImportedHistory': false,
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
    // 服务器端系统通知兜底：远程 HTTP 访问浏览器禁止授权时，由后端所在机器弹系统通知
    'notify.serverToast': true,
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
  let meta = storage.get(NS, META_KEY, null)
  if (!meta || typeof meta !== 'object') meta = {}
  let dirty = false
  /**
   * 旧版单值 model.failoverKey -> 有序列表 model.failoverKeys。
   * 只在用户从未显式改过列表时迁移，避免把用户已清空的列表又复活。
   * 远端偏好同步后也可能带回来旧字段，因此封装成函数重复调用。
   */
  const migrateLegacyFailover = () => {
    const changed = []
    const legacyKey = String(getPath(data, 'model.failoverKey') || '').trim()
    const failoverKeysMetaAt = Number(meta['model.failoverKeys']?.at) || 0
    const currentKeys = getPath(data, 'model.failoverKeys')
    if (legacyKey && failoverKeysMetaAt === 0 && (!Array.isArray(currentKeys) || currentKeys.length === 0)) {
      setPath(data, 'model.failoverKeys', [legacyKey])
      changed.push({ key: 'model.failoverKeys', value: [legacyKey] })
    }
    if (hasPath(data, 'model.failoverKey')) {
      removePath(data, 'model.failoverKey')
      removePath(meta, 'model.failoverKey')
      changed.push({ key: 'model.failoverKey', value: undefined })
    }
    // 旧版 model.failoverRetries 语义接近“循环轮数”；只有用户没显式改过
    // model.failoverPasses 时才迁移，避免把新值覆盖掉。
    const legacyRetries = Math.floor(Number(getPath(data, 'model.failoverRetries')))
    const failoverPassesMetaAt = Number(meta['model.failoverPasses']?.at) || 0
    if (Number.isFinite(legacyRetries) && failoverPassesMetaAt === 0) {
      const passes = Math.max(1, Math.min(3, legacyRetries || 1))
      setPath(data, 'model.failoverPasses', passes)
      changed.push({ key: 'model.failoverPasses', value: passes })
    }
    if (hasPath(data, 'model.failoverRetries')) {
      removePath(data, 'model.failoverRetries')
      removePath(meta, 'model.failoverRetries')
      changed.push({ key: 'model.failoverRetries', value: undefined })
    }
    if (changed.length) {
      storage.set(NS, KEY, data)
      storage.set(NS, META_KEY, meta)
    }
    return changed
  }
  // 旧版群聊上下文按“轮”保存为 chat.groupRounds；新语义改为按消息“条”数。
  // 迁移一次旧值，避免自定义设置丢失。
  if (!hasPath(data, 'chat.groupMessages') && hasPath(data, 'chat.groupRounds')) {
    const legacyRounds = Number(getPath(data, 'chat.groupRounds'))
    setPath(data, 'chat.groupMessages', Number.isFinite(legacyRounds) ? Math.max(1, Math.min(1000, Math.floor(legacyRounds))) : 20)
    dirty = true
  }
  if (hasPath(data, 'chat.groupRounds')) {
    removePath(data, 'chat.groupRounds')
    removePath(meta, 'chat.groupRounds')
    dirty = true
  }
  for (const [key, value] of Object.entries(DEFAULTS)) {
    if (!hasPath(data, key)) {
      setPath(data, key, value)
      dirty = true
    }
  }
  migrateLegacyFailover()
  if (dirty) {
    storage.set(NS, KEY, data)
    storage.set(NS, META_KEY, meta)
  }

  const persist = () => storage.set(NS, KEY, data)
  const persistMeta = () => storage.set(NS, META_KEY, meta)

  /**
   * 旧默认值一次性迁移（只迁移“没有在设置里显式改过”的键）：
   *   - contextTokens 4096 会把输入上下文卡得很小（工具定义一多就没历史了），
   *     新默认 0 = 不做本地 token 截断；
   *   - 自动上下文图片旧默认 4 张，新默认只保留最近 2 张，其余用 [图片] 占位。
   */
  const LEGACY_DEFAULT_MIGRATIONS = [
    ['chat.contextTokens', 4096, 0],
    ['chat.imagesPerRequest', 4, 2],
    ['chat.imagesPerMessage', 4, 2],
    ['chat.toolRetryLimit', 1, 3],
  ]
  const migrateLegacyDefaults = () => {
    const changed = []
    for (const [key, oldValue, newValue] of LEGACY_DEFAULT_MIGRATIONS) {
      if (!hasPath(data, key)) continue
      if (getPath(data, key) !== oldValue) continue
      // 只有“用户真正改过”的键才跳过迁移；早期自动写入的 meta 可能是 {at:0}，
      // 不能让它挡住旧默认值（如 imagesPerRequest=4）升级到新默认 2。
      const metaAt = Number(meta[key]?.at)
      if (Number.isFinite(metaAt) && metaAt > 0) continue
      setPath(data, key, newValue)
      changed.push({ key, value: newValue })
    }
    if (changed.length) {
      persist()
      for (const change of changed) ctx.emit('config:changed', change)
      ctx.logger.debug(`已迁移旧默认值 ${changed.map(item => item.key).join('、')}`)
    }
    return changed.length
  }
  migrateLegacyDefaults()

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
    const migrated = migrateLegacyDefaults()
    const failoverMigration = migrateLegacyFailover()
    const changes = [...merged.changes, ...failoverMigration]
    if (changes.length || metaChanged || migrated) {
      persist()
      persistMeta()
    }
    for (const change of changes) ctx.emit('config:changed', change)
    if (changes.length) ctx.logger.debug(`已应用远端偏好 ${changes.length} 项（${source}）`)
    return changes.length
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
    /** 立即把当前偏好写入后端，绕过 schedulePush 的防抖；用于插件启停后同步状态。 */
    async flush() {
      if (syncTimer) {
        ctx.clearTimeout(syncTimer)
        syncTimer = null
      }
      return pushPreferences()
    },
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

function deepEqual(a, b) {
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch (_) {
    return false
  }
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
