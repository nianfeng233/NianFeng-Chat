/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * 更新助手回归测试：验证旧启动窗口的收尾逻辑。
 *
 * 用法：node scripts/test-update-helper.mjs
 *
 * 重点覆盖：
 *   - 发布脚本标记 NIANFENG_LAUNCHER=1 时，旧实例退出后会关闭专用启动窗口；
 *   - 未标记的终端（源码 / 手动启动）在等待后不会被误杀。
 */
import { spawn } from 'node:child_process'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isProcessAlive, settleLauncherShell } from '../server/update-helper.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const dataDir = join(ROOT, '.tmp', `update-helper-test-${Date.now()}`)
let failed = 0
const results = []

const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail })
  if (!ok) failed++
  console.log(`${ok ? '  ✔' : '  ✗'} ${name}${ok ? '' : `  → ${detail}`}`)
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const waitFor = async (fn, timeout = 5000) => {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeout) {
    if (await fn()) return true
    await sleep(60)
  }
  return false
}

const spawnFakeShell = async () => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.on('error', () => {})
  child.unref()
  await waitFor(() => isProcessAlive(child.pid), 3000)
  return child
}

const killQuietly = pid => {
  try {
    process.kill(pid, 'SIGKILL')
  } catch (_) {
    /* ignore */
  }
}

await mkdir(dataDir, { recursive: true })
const logFile = join(dataDir, 'update.log')

console.log('\n① 专用启动窗口：旧实例退出后自动关闭')
const managedShell = await spawnFakeShell()
try {
  check('测试用旧启动窗口已运行', isProcessAlive(managedShell.pid), String(managedShell.pid))
  const result = await settleLauncherShell({
    parentPid: managedShell.pid,
    nodePid: 0,
    closeParentShell: true,
    logFile,
  })
  const gone = await waitFor(() => !isProcessAlive(managedShell.pid), 4000)
  check('带 NIANFENG_LAUNCHER=1 标记的旧窗口会被关闭', result === true && gone, JSON.stringify({ result, alive: isProcessAlive(managedShell.pid) }))
} finally {
  killQuietly(managedShell.pid)
}

console.log('\n② 普通终端：不会被误关')
const plainShell = await spawnFakeShell()
try {
  check('测试用普通终端已运行', isProcessAlive(plainShell.pid), String(plainShell.pid))
  const result = await settleLauncherShell({
    parentPid: plainShell.pid,
    nodePid: 0,
    closeParentShell: false,
    logFile,
  })
  check('未标记的终端等待后仍保留', result === false && isProcessAlive(plainShell.pid), JSON.stringify({ result, alive: isProcessAlive(plainShell.pid) }))
} finally {
  killQuietly(plainShell.pid)
}

console.log('\n③ 旧窗口已经自然退出时不再处理')
const alreadyGone = await spawnFakeShell()
const alreadyGonePid = alreadyGone.pid
killQuietly(alreadyGonePid)
await waitFor(() => !isProcessAlive(alreadyGonePid), 3000)
const resultGone = await settleLauncherShell({
  parentPid: alreadyGonePid,
  nodePid: 0,
  closeParentShell: true,
  logFile,
})
check('旧窗口已经退出时返回成功且不影响后续更新', resultGone === true, JSON.stringify({ result: resultGone }))

console.log('\n④ 自动拉起窗口的防残留回归（源码约束）')
const packageReleaseSource = await readFile(join(ROOT, 'scripts/package-release.mjs'), 'utf8')
const updateHelperSource = await readFile(join(ROOT, 'server/update-helper.mjs'), 'utf8')
check(
  '发布包启动脚本：更新助手拉起的窗口退出后关闭控制台',
  packageReleaseSource.includes("if defined NIANFENG_UPDATE_HELPER exit %NIANFENG_EXIT%"),
)
check(
  '更新助手拉起可见窗口时使用 cmd /C，避免留下旧提示符窗口',
  updateHelperSource.includes("['/c', 'start', '', 'cmd.exe', '/c', script]"),
)
check(
  '旧启动窗口未关闭时跳过替换启动脚本，避免旧 cmd 内存报错',
  updateHelperSource.includes('keepLauncherScripts') && updateHelperSource.includes('本次跳过替换启动脚本'),
)

await rm(dataDir, { recursive: true, force: true }).catch(() => {})

const failedChecks = results.filter(item => !item.ok)
console.log(`\n结果：${results.length - failedChecks.length}/${results.length} 项通过`)
process.exit(failedChecks.length ? 1 : 0)
