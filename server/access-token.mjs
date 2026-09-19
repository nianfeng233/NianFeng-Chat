/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * 访问令牌启动解析。
 *
 * 设计目标：
 *   - 首次运行（数据目录里还没有 config.json）自动生成高强度随机令牌，
 *     明文只在本次进程内存和终端里出现，落盘只写 nf1$盐$摘要；
 *   - 后续启动优先读取哈希做校验，无需也无法回显明文；
 *   - 旧版本 config.json 里的明文 network.webuiToken 会在启动时迁移为哈希，
 *     原字段随后删除；
 *   - 环境变量 NIANFENG_WEBUI_TOKEN / FENGYU_WEBUI_TOKEN 作为显式覆盖，
 *     只在当前进程生效，不写入磁盘。
 *
 * 本模块只依赖数据目录与 config.json，不依赖 cordis 插件，因此可以在
 * startBackend 之前被 start.mjs / server/index.mjs 安全调用。
 */
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createAccessTokenHash, isAccessTokenHash } from './security-utils.mjs'

export const ACCESS_TOKEN_ENV_NAMES = ['NIANFENG_WEBUI_TOKEN', 'FENGYU_WEBUI_TOKEN']
export const MIN_ACCESS_TOKEN_LENGTH = 12

/** 生成 24 字节随机令牌；前缀仅用于让用户一眼认出这是念风访问令牌。 */
export function generateAccessToken() {
  return `nf_${randomBytes(24).toString('base64url')}`
}

/** 读取 config.json 里的访问令牌相关状态（缺失 / 损坏时返回空默认值）。 */
export async function readAccessTokenState(dataDir) {
  const file = join(dataDir, 'config.json')
  let config = null
  try {
    config = JSON.parse(await readFile(file, 'utf8'))
  } catch (_) {
    config = null
  }
  const network = config && typeof config === 'object' && !Array.isArray(config) && config.network && typeof config.network === 'object'
    ? config.network
    : {}
  return {
    file,
    exists: !!config && typeof config === 'object' && !Array.isArray(config),
    hash: String(network.webuiTokenHash || '').trim(),
    legacyToken: String(network.webuiToken || '').trim(),
    updatedAt: Number(network.webuiTokenUpdatedAt) || 0,
  }
}

/**
 * 把访问令牌哈希写入 config.json。
 *
 * 只合并 network 段，保留 providers / preferences 等已有字段（包括已经加密的
 * API Key 密文），并删除可能残留的明文 webuiToken。
 */
export async function persistAccessTokenHash(dataDir, hash) {
  const file = join(dataDir, 'config.json')
  let config = {}
  let raw = null
  try {
    raw = await readFile(file, 'utf8')
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err
  }
  if (raw !== null) {
    try {
      const parsed = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('配置根节点必须是对象')
      config = parsed
    } catch (err) {
      // 配置损坏时不能静默重建，否则会覆盖用户的提供商 / 偏好配置。
      throw new Error(`无法写入访问令牌摘要：config.json 解析失败（${err.message}）`)
    }
  }
  const network = config.network && typeof config.network === 'object' && !Array.isArray(config.network) ? config.network : (config.network = {})
  if (hash) {
    network.webuiTokenHash = String(hash)
    network.webuiTokenUpdatedAt = Date.now()
  } else {
    delete network.webuiTokenHash
    network.webuiTokenUpdatedAt = 0
  }
  delete network.webuiToken
  await mkdir(dataDir, { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, JSON.stringify(config, null, 2) + '\n', 'utf8')
  await rename(tmp, file)
}

/**
 * 把 patch.network.webuiToken 这种“明文写令牌”的请求转换成只含摘要的 patch。
 * 明文只在本次函数调用里短暂存在，不进入配置对象，也不会被保存。
 */
export function normalizeAccessTokenPatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch
  const network = patch.network
  if (!network || typeof network !== 'object' || Array.isArray(network)) return patch
  if (!Object.prototype.hasOwnProperty.call(network, 'webuiToken')) return patch
  const next = structuredClone(patch)
  const token = String(next.network.webuiToken ?? '').trim()
  delete next.network.webuiToken
  if (token) {
    if (token.length < MIN_ACCESS_TOKEN_LENGTH) {
      const error = new Error(`访问令牌至少需要 ${MIN_ACCESS_TOKEN_LENGTH} 位，避免被轻易猜到`)
      error.status = 400
      throw error
    }
    next.network.webuiTokenHash = createAccessTokenHash(token)
    next.network.webuiTokenUpdatedAt = Date.now()
  } else {
    // 显式传入空字符串 = 清除访问令牌；由调用方决定是否真的提交这个字段。
    next.network.webuiTokenHash = ''
    next.network.webuiTokenUpdatedAt = 0
  }
  return next
}

/**
 * 迁移旧版 / 手工写入的明文访问令牌：
 *   - 合法 `nf1$...` 摘要保持不动；
 *   - 非法哈希字段按明文处理并重新摘要（兼容极端历史数据）；
 *   - 旧字段 network.webuiToken 删除，只保留 webuiTokenHash。
 * 返回是否有改动。
 */
export function migrateAccessTokenData(target) {
  if (!target || typeof target !== 'object') return false
  const network = target.network && typeof target.network === 'object' && !Array.isArray(target.network) ? target.network : (target.network = {})
  let changed = false
  const legacy = String(network.webuiToken ?? '').trim()
  const existing = String(network.webuiTokenHash ?? '').trim()
  if (existing && !isAccessTokenHash(existing)) {
    network.webuiTokenHash = createAccessTokenHash(existing)
    network.webuiTokenUpdatedAt = Date.now()
    changed = true
  } else if (legacy && !existing) {
    network.webuiTokenHash = createAccessTokenHash(legacy)
    network.webuiTokenUpdatedAt = Date.now()
    changed = true
  }
  if (Object.prototype.hasOwnProperty.call(network, 'webuiToken')) {
    delete network.webuiToken
    changed = true
  }
  return changed
}


/**
 * 解析本次启动应使用的访问令牌。
 *
 * 返回值：
 *   { token, hash, required, source, generated, migrated, firstRun }
 *   - token 是仅存在于当前进程内存的明文（可能为空）；为空时仍可用 hash 校验用户输入；
 *   - hash 是常量时间校验用的落盘摘要；
 *   - required 为 true 表示需要启用访问令牌；
 *   - source 取值：env / config / legacy / generated / none；
 *   - generated 为 true 表示这是自动生成、只在本次终端打印一次的令牌。
 *
 * generateIfMissing 只对“config.json 尚不存在”的真首次运行生效；
 * generateIfUnset 则允许调用方在“监听非本机地址但历史上没设过令牌”时
 * 强制补一个随机令牌并打印，避免公网/局域网裸奔。
 */
export async function resolveStartupAccessToken(dataDir, { generateIfMissing = false, generateIfUnset = false, env = process.env } = {}) {
  const state = await readAccessTokenState(dataDir)
  const envToken = String(ACCESS_TOKEN_ENV_NAMES.map(name => env[name]).find(Boolean) || '').trim()
  if (envToken) {
    return {
      token: envToken,
      hash: createAccessTokenHash(envToken),
      required: true,
      source: 'env',
      generated: false,
      migrated: false,
      firstRun: false,
    }
  }

  if (state.hash) {
    return {
      token: '',
      hash: state.hash,
      required: true,
      source: 'config',
      generated: false,
      migrated: false,
      firstRun: false,
    }
  }

  if (state.legacyToken) {
    const hash = createAccessTokenHash(state.legacyToken)
    await persistAccessTokenHash(dataDir, hash)
    return {
      token: state.legacyToken,
      hash,
      required: true,
      source: 'legacy',
      generated: false,
      migrated: true,
      firstRun: false,
    }
  }

  const shouldGenerate = !state.hash && !state.legacyToken && ((generateIfMissing && !state.exists) || generateIfUnset)
  if (shouldGenerate) {
    const token = generateAccessToken()
    const hash = createAccessTokenHash(token)
    await persistAccessTokenHash(dataDir, hash)
    return {
      token,
      hash,
      required: true,
      source: 'generated',
      generated: true,
      migrated: false,
      firstRun: !state.exists,
    }
  }

  return {
    token: '',
    hash: '',
    required: false,
    source: 'none',
    generated: false,
    migrated: false,
    firstRun: !state.exists,
  }
}
