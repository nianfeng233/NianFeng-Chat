/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * 后端 · settings
 * 真实的本地配置文件读写（user_data/config.json）。
 *
 * 凭据保护：
 *   - API Key 与敏感请求头在 config.json 里以 AES-256-GCM 密文保存（enc:v1:...）
 *   - 密钥文件 .secret-key 与数据在同一目录（0600），备份数据时要一起带上
 *   - 接口返回时始终打码，明文只在后端进程内存里出现
 */
import { readFile, writeFile, mkdir, rename, chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto'

export const name = 'settings'
export const inject = []

const ENC_PREFIX = 'enc:v1:'
const SENSITIVE_HEADER = /authorization|api[-_]?key|token|secret|cookie|password/i
const KEY_FILE = '.secret-key'

const DEFAULTS = {
  version: 1,
  defaultProvider: 'ollama',
  defaultModel: '',
  providers: {
    openai: {
      type: 'openai',
      name: 'OpenAI 兼容接口',
      baseURL: 'https://api.openai.com/v1',
      apiKey: '',
      models: [],
      defaultModel: '',
      enabled: true,
      timeoutMs: 0,
      proxy: '',
      headers: {},
    },
    anthropic: {
      type: 'anthropic',
      name: 'Anthropic Claude',
      baseURL: 'https://api.anthropic.com',
      apiKey: '',
      models: [],
      defaultModel: '',
      enabled: false,
      timeoutMs: 0,
      proxy: '',
      headers: {},
    },
    ollama: {
      type: 'ollama',
      name: 'Ollama（本地）',
      baseURL: 'http://localhost:11434',
      apiKey: '',
      models: [],
      defaultModel: '',
      enabled: true,
      timeoutMs: 0,
      proxy: '',
      headers: {},
    },
  },
  network: {
    timeoutMs: 60000,
    proxy: '',
    // 模型返回空回复（既没有正文也没有工具调用）时自动重试次数；默认只重试一次，避免让外部渠道用户久等
    emptyResponseRetries: 1,
    // WebUI 对外监听：host 可为 127.0.0.1 / 0.0.0.0；port 为 0 表示使用启动默认端口；token 为空则不校验。
    webuiHost: '127.0.0.1',
    webuiPort: 0,
    webuiToken: '',
  },
  // 前端界面偏好（签名 / 玻璃参数等），由 WebUI config 服务同步进来，
  // 与模型配置放在同一个 config.json 中，跨浏览器 / 桌面宿主都可恢复。
  preferences: {},
  // 外部插件目录；为空则跟随当前数据目录下的 plugins/（见 server/plugins/plugin-registry.mjs）
  plugins: { dir: '' },
  logLevel: 'info',
}

/** 被删除的提供商用 deleted 标记（深合并会让缺省键复活，不能直接 delete） */
const isDeleted = provider => provider?.deleted === true

function deepMerge(base, patch) {
  if (patch === null || patch === undefined) return base
  if (Array.isArray(patch)) return patch.map(v => (v && typeof v === 'object' ? deepMerge({}, v) : v))
  if (typeof patch !== 'object') return patch
  const out = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    out[key] = value && typeof value === 'object' && !Array.isArray(value) ? deepMerge(base?.[key] ?? {}, value) : value
  }
  return out
}

export function apply(ctx, config = {}) {
  let dataDir = config.dataDir || join(process.cwd(), 'user_data')
  let file = join(dataDir, 'config.json')
  let data = structuredClone(DEFAULTS)
  let secretKey = null
  let ready = null

  const keyPath = () => join(dataDir, KEY_FILE)

  const readKey = async target => {
    try {
      const raw = (await readFile(target, 'utf8')).trim()
      const buf = Buffer.from(raw, 'base64')
      return buf.length === 32 ? buf : null
    } catch (_) {
      return null
    }
  }

  const writeKey = async (target, key) => {
    await writeFile(target, key.toString('base64'), 'utf8')
    try {
      await chmod(target, 0o600)
    } catch (_) {
      /* Windows 没有 POSIX 权限位，忽略即可 */
    }
  }

  const ensureKey = async () => {
    if (secretKey) return secretKey
    secretKey = (await readKey(keyPath())) || randomBytes(32)
    await writeKey(keyPath(), secretKey)
    return secretKey
  }

  const encryptValue = plain => {
    if (!secretKey) return plain
    if (!plain || typeof plain !== 'string') return plain
    if (plain.startsWith(ENC_PREFIX)) return plain
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', secretKey, iv)
    const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    return `${ENC_PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`
  }

  const decryptValue = stored => {
    if (!stored || typeof stored !== 'string') return stored
    if (!stored.startsWith(ENC_PREFIX)) return stored
    if (!secretKey) return ''
    try {
      const [ivB64, tagB64, dataB64] = stored.slice(ENC_PREFIX.length).split(':')
      const decipher = createDecipheriv('aes-256-gcm', secretKey, Buffer.from(ivB64, 'base64'))
      decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
      return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8')
    } catch (_) {
      ctx.logger.warn('凭据解密失败（缺少 .secret-key 或密钥不匹配），相关字段已清空')
      return ''
    }
  }

  const transformSecrets = (target, fn) => {
    for (const provider of Object.values(target.providers || {})) {
      if (!provider || typeof provider !== 'object') continue
      if (typeof provider.apiKey === 'string') provider.apiKey = fn(provider.apiKey)
      if (provider.headers && typeof provider.headers === 'object') {
        for (const [name, value] of Object.entries(provider.headers)) {
          if (SENSITIVE_HEADER.test(name)) provider.headers[name] = fn(value)
        }
      }
    }
    return target
  }

  const encryptSecrets = target => transformSecrets(structuredClone(target), value => encryptValue(value))
  const decryptSecrets = target => transformSecrets(target, value => decryptValue(value))

  // 写盘串行化：load / update / rehome 可能并发触发 save，
  // 共用同一个 .tmp 会导致 ENOENT，这里排队并保证原子替换。
  let saveChain = Promise.resolve()
  const save = () => {
    const task = async () => {
      await ensureKey()
      await mkdir(dataDir, { recursive: true })
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
      await writeFile(tmp, JSON.stringify(encryptSecrets(data), null, 2), 'utf8')
      await rename(tmp, file)
    }
    saveChain = saveChain.then(task, task)
    return saveChain
  }

  const load = async () => {
    await mkdir(dataDir, { recursive: true })
    await ensureKey()
    data = structuredClone(DEFAULTS)
    try {
      const raw = await readFile(file, 'utf8')
      data = decryptSecrets(deepMerge(structuredClone(DEFAULTS), JSON.parse(raw)))
    } catch (err) {
      if (err.code !== 'ENOENT') ctx.logger.warn(`配置文件读取失败，使用默认值：${err.message}`)
    }
    // 首次运行 / 从旧版明文配置升级：立即按加密格式重写
    await save()
    ctx.logger.info(`配置已加载（凭据加密存储）：${file}`)
  }

  /**
   * 把配置切换到另一个数据目录。
   * migrate=true 且目标没有 config.json 时，把当前配置写过去；
   * 否则加载目标目录已有的 config.json（没有则从默认值开始）。
   * 密钥文件也会随目录迁移；目标已有 .secret-key 时以目标为准。
   */
  const rehome = async (nextDir, { migrate = true } = {}) => {
    await ready
    await mkdir(nextDir, { recursive: true })
    const nextKeyPath = join(nextDir, KEY_FILE)
    let nextKey = await readKey(nextKeyPath)
    if (!nextKey) {
      nextKey = migrate ? await ensureKey() : randomBytes(32)
      await writeKey(nextKeyPath, nextKey)
    }
    const nextFile = join(nextDir, 'config.json')
    const targetExists = await readFile(nextFile, 'utf8').then(() => true).catch(() => false)

    secretKey = nextKey
    dataDir = nextDir
    file = nextFile

    if (migrate && !targetExists) {
      await save()
    } else {
      data = structuredClone(DEFAULTS)
      try {
        const raw = await readFile(file, 'utf8')
        data = decryptSecrets(deepMerge(structuredClone(DEFAULTS), JSON.parse(raw)))
      } catch (err) {
        if (err.code !== 'ENOENT') ctx.logger.warn(`新目录配置读取失败，使用默认值：${err.message}`)
      }
      await save()
    }
    ctx.logger.info(`配置目录已切换：${file}`)
    return service.get()
  }

  const mask = value => {
    if (!value) return ''
    const s = String(value)
    return s.length <= 8 ? '••••' : `${s.slice(0, 3)}…${s.slice(-4)}`
  }

  const service = {
    get file() {
      return file
    },
    get dataDir() {
      return dataDir
    },
    get keyFile() {
      return keyPath()
    },
    rehome,
    get: () => structuredClone(data),
    provider: id => data.providers[id],
    providers: () =>
      Object.entries(data.providers)
        .filter(([, p]) => !isDeleted(p))
        .map(([id, p]) => ({ id, ...structuredClone(p), apiKey: mask(p.apiKey) })),
    /** 合并写入（patch 可以包含明文 key，落盘时自动加密） */
    async update(patch) {
      data = deepMerge(data, patch)
      await save()
      ctx.emit('settings/updated', patch)
      return service.get()
    },
    /**
     * 精确写入提供商的顶层字段（不递归合并对象）。
     * 用于请求头覆盖这类“提交即完整替换”的配置，否则 deepMerge 会保留旧 key，
     * 导致用户从界面删掉的请求头永远删不掉。
     */
    async replaceProvider(id, patch = {}) {
      if (!data.providers[id]) return false
      data.providers[id] = { ...data.providers[id], ...structuredClone(patch) }
      await save()
      ctx.emit('settings/updated', { providers: { [id]: patch } })
      return service.get()
    },
    /**
     * 删除提供商。由于 deepMerge 会让 DEFAULTS 里的键复活，
     * 这里打 deleted 标记而不是真的删 key；对上层表现与删除一致。
     */
    async removeProvider(id) {
      if (!data.providers[id]) return false
      data.providers[id].deleted = true
      data.providers[id].enabled = false
      if (data.defaultProvider === id) {
        const next = Object.entries(data.providers).find(([pid, p]) => pid !== id && !isDeleted(p) && p.enabled !== false)
        data.defaultProvider = next ? next[0] : ''
        data.defaultModel = ''
      }
      await save()
      ctx.emit('settings/updated', { providers: { [id]: { deleted: true, enabled: false } } })
      return true
    },
    isDeleted,
    /** 给接口用的脱敏快照 */
    redacted() {
      const copy = service.get()
      for (const [id, provider] of Object.entries(copy.providers)) {
        if (isDeleted(provider)) {
          delete copy.providers[id]
          continue
        }
        provider.apiKey = mask(provider.apiKey)
        if (provider.headers && typeof provider.headers === 'object') {
          for (const [name, value] of Object.entries(provider.headers)) {
            if (SENSITIVE_HEADER.test(name)) provider.headers[name] = mask(value)
          }
        }
      }
      return copy
    },
    ready: () => ready,
  }

  ready = load()
  ctx.provide('settings', service)
}
