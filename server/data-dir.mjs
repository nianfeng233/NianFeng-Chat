/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * 实例数据目录解析（库，不是插件）。
 *
 * 三层优先级：
 *   1. 环境变量 NIANFENG_DATA_DIR
 *   2. 本部署自己的 user_data/instance.json（首次解析后会写入并固定下来）
 *   3. 本机 AppData 里的 nianfeng/instance.json（跨部署共享的“当前数据目录”指针）
 *   4. 默认 <root>/user_data（首次会迁移旧 data/ 里的数据）
 *
 * 关键约定：AppData 只在“本部署还没有自己的数据目录记录”时读取一次；
 * 之后这个部署只认自己 user_data/instance.json。这样在 C 盘新部署可以
 * 恢复 D 盘的数据，而在 D 盘旧部署里切回时仍然使用 D 盘自己的目录。
 */
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { homedir } from 'node:os'

export const DEFAULT_DIR_NAME = 'user_data'

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch (_) {
    return false
  }
}

/** 本机共享的应用配置目录（Windows: %APPDATA%/nianfeng） */
export function appConfigDir() {
  const appDir = process.env.NIANFENG_APP_DIR || process.env.FENGYU_APP_DIR
  if (appDir) return resolve(appDir)
  if (process.platform === 'win32' && process.env.APPDATA) return join(process.env.APPDATA, 'nianfeng')
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'nianfeng')
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'nianfeng')
}

/** 旧品牌目录（仅用于一次性读取指针 / 迁移，不写入） */
export function legacyAppConfigDir() {
  if (process.env.FENGYU_APP_DIR) return resolve(process.env.FENGYU_APP_DIR)
  if (process.platform === 'win32' && process.env.APPDATA) return join(process.env.APPDATA, 'fengyu')
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'fengyu')
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'fengyu')
}

/** 把用户输入规范成绝对路径；空值返回 null */
export function normalizeDataDir(input, root) {
  const raw = String(input ?? '').trim()
  if (!raw) return null
  const expanded = raw === '~' ? (process.env.USERPROFILE || process.env.HOME || root) : raw.replace(/^~(?=[\\/])/, process.env.USERPROFILE || process.env.HOME || '~')
  return isAbsolute(expanded) ? resolve(expanded) : resolve(root, expanded)
}

export async function writeInstanceFile(instanceFile, dataDir) {
  await mkdir(dirname(instanceFile), { recursive: true })
  const payload = { dataDir: resolve(dataDir), updatedAt: new Date().toISOString() }
  await writeFile(instanceFile, JSON.stringify(payload, null, 2), 'utf8')
  return payload
}

export async function readInstanceFile(instanceFile) {
  try {
    const raw = await readFile(instanceFile, 'utf8')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch (_) {
    return null
  }
}

/** 本机共享指针：新部署首次启动时用来找回上次使用的数据目录 */
export async function writeAppPointer(dataDir) {
  return writeInstanceFile(join(appConfigDir(), 'instance.json'), dataDir)
}

export async function readAppPointer() {
  const current = await readInstanceFile(join(appConfigDir(), 'instance.json'))
  if (current) return current
  // 兼容旧版本目录：只读一次并迁移为念风指针，避免升级后丢历史数据目录。
  try {
    const legacy = await readInstanceFile(join(legacyAppConfigDir(), 'instance.json'))
    if (legacy?.dataDir) {
      await writeAppPointer(legacy.dataDir).catch(() => {})
      return legacy
    }
  } catch (_) {
    /* ignore */
  }
  return null
}

async function copyLegacy(legacyDir, homeDir) {
  let migrated = false
  for (const name of ['config.json', 'sessions.json', '.secret-key']) {
    const from = join(legacyDir, name)
    const to = join(homeDir, name)
    try {
      if ((await exists(from)) && !(await exists(to))) {
        await copyFile(from, to)
        migrated = true
      }
    } catch (_) {
      /* 复制失败继续，下面会创建空文件 */
    }
  }
  return migrated
}

/**
 * 解析当前部署应该使用的数据目录。
 * @returns {Promise<object>}
 */
export async function resolveDataDir(root, { legacyDirName = 'data' } = {}) {
  const resolvedRoot = resolve(root)
  // NIANFENG_HOME_DIR 允许宿主（例如桌面 exe）把「本部署的数据目录指针」放到
  // 独立、持久的目录中，同时仍复用 AppData 首次引导逻辑。
  const homeEnv = process.env.NIANFENG_HOME_DIR || process.env.FENGYU_HOME_DIR
  const homeRoot = homeEnv ? resolve(homeEnv) : resolvedRoot
  const homeDir = join(homeRoot, DEFAULT_DIR_NAME)
  const instanceFile = join(homeDir, 'instance.json')
  const legacyDir = join(resolvedRoot, legacyDirName)
  const appDir = appConfigDir()
  const appInstanceFile = join(appDir, 'instance.json')
  await mkdir(homeDir, { recursive: true })

  const envOverride = String(process.env.NIANFENG_DATA_DIR || process.env.FENGYU_DATA_DIR || '').trim()
  const localPointer = await readInstanceFile(instanceFile)
  const appPointer = await readAppPointer()
  const homeHasData = (await exists(join(homeDir, 'config.json'))) || (await exists(join(homeDir, 'sessions.json')))
  const legacyHasData = (await exists(join(legacyDir, 'config.json'))) || (await exists(join(legacyDir, 'sessions.json')))

  let dataDir = null
  let source = 'default'
  let migrated = false

  if (envOverride) {
    dataDir = normalizeDataDir(envOverride, resolvedRoot)
    source = 'env'
  } else if (localPointer?.dataDir) {
    dataDir = normalizeDataDir(localPointer.dataDir, resolvedRoot)
    source = 'local-pointer'
  } else if (homeHasData || legacyHasData) {
    if (!homeHasData && legacyHasData) migrated = await copyLegacy(legacyDir, homeDir)
    dataDir = homeDir
    source = 'local-data'
    await writeInstanceFile(instanceFile, dataDir)
  } else {
    if (appPointer?.dataDir) {
      dataDir = normalizeDataDir(appPointer.dataDir, resolvedRoot)
      source = 'appdata'
    } else {
      dataDir = homeDir
      source = 'default'
    }
    // 首次解析后固定到本部署，后续 AppData 变化不会再影响它
    await writeInstanceFile(instanceFile, dataDir)
  }

  try {
    await mkdir(dataDir, { recursive: true })
    dataDir = resolve(dataDir)
  } catch (err) {
    dataDir = homeDir
    source = 'default-fallback'
    await mkdir(dataDir, { recursive: true }).catch(() => {})
    await writeInstanceFile(instanceFile, dataDir).catch(() => {})
  }

  // 保证本机共享指针存在：默认 / 本地数据首次解析时写入；
  // 已有指针、或本次就是从 AppData 采用的目录，则不覆盖（避免 D 盘部署反过来改掉 C 盘刚选的新目录）。
  if (!appPointer && source !== 'appdata') {
    await writeInstanceFile(appInstanceFile, dataDir).catch(() => {})
  }

  return {
    root: resolvedRoot,
    homeDir,
    instanceFile,
    legacyDir,
    dataDir,
    migrated,
    envOverride: !!envOverride,
    pointer: localPointer,
    appDir,
    appInstanceFile,
    source,
  }
}
