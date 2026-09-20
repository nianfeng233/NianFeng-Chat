/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * 本体更新 / 重启助手（独立进程）。
 *
 * 后端完成校验后，会把本文件复制到系统临时目录，再以 detached 方式启动；
 * 因此即使当前 app / 运行目录随后被整体替换，助手进程也不会被影响。
 *
 * 助手只做三件事：
 *   1. 等待旧流程完全退出（必要时由宿主 shell 结束桌面 EXE）；
 *   2. 下载 release 附件并按当前运行方式替换 Web / EXE；
 *   3. 以“用户双击启动脚本”的方式重新拉起，或启动新的桌面 EXE。
 *
 * 更新过程故意做得简单直接，不跑包管理器、不改数据目录、不碰 user_data。
 */
import { spawn } from 'node:child_process'
import { createWriteStream, existsSync } from 'node:fs'
import { appendFile, cp, copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { pathToFileURL } from 'node:url'

const sleep = ms => new Promise(resolveDone => setTimeout(resolveDone, ms))

const toText = value => {
  if (value === undefined || value === null) return ''
  return String(value)
}

function logLine(plan, message) {
  const text = `[${new Date().toISOString()}] ${toText(message)}`
  console.log(text)
  const file = plan?.logFile
  if (!file) return Promise.resolve()
  return appendFile(file, `${text}\n`, 'utf8').catch(() => {})
}

function isProcessAlive(pid) {
  const value = Number(pid)
  if (!Number.isInteger(value) || value <= 0) return false
  try {
    process.kill(value, 0)
    return true
  } catch (err) {
    // 权限不足通常说明进程仍存在；真正退出时 Node 会报 ESRCH。
    return err?.code === 'EPERM'
  }
}

async function waitPidGone(plan, pid, timeoutMs = 90000) {
  if (!pid) return true
  const deadline = Date.now() + Math.max(1000, Number(timeoutMs) || 90000)
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true
    await sleep(350)
  }
  const alive = isProcessAlive(pid)
  await logLine(plan, `等待进程 ${pid} 退出超时${alive ? '，将继续执行' : ''}`)
  return !alive
}

function spawnDetachedChecked(file, args, { cwd = '', windowsHide = false } = {}) {
  return new Promise((resolve, reject) => {
    let child = null
    try {
      child = spawn(file, args, {
        cwd: cwd || undefined,
        detached: true,
        stdio: 'ignore',
        windowsHide,
      })
    } catch (err) {
      reject(err)
      return
    }
    const onSpawn = () => {
      child.off('error', onError)
      resolve(child)
    }
    const onError = err => {
      child.off('spawn', onSpawn)
      reject(err)
    }
    child.once('spawn', onSpawn)
    child.once('error', onError)
  })
}

function runCommand(plan, file, args, { cwd = '', timeoutMs = 10 * 60 * 1000 } = {}) {
  return new Promise(resolveDone => {
    let child = null
    try {
      // 助手自身是 detached 进程，stdin/out/err 统一丢弃即可；不接管道可以避开
      // 部分 Windows 安全软件 / 受限环境对子进程管道的拦截（spawn EPERM）。
      child = spawn(file, args, { cwd: cwd || undefined, stdio: 'ignore', windowsHide: true })
    } catch (err) {
      logLine(plan, `无法启动命令 ${file}：${err?.message || err}`).finally(() => resolveDone({ code: -1, output: '' }))
      return
    }

    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch (_) {
        /* ignore */
      }
      resolveDone({ code: -2, output: '命令执行超时' })
    }, Math.max(2000, Number(timeoutMs) || 10 * 60 * 1000))
    timer.unref?.()

    child.once('error', err => {
      clearTimeout(timer)
      resolveDone({ code: -1, output: err?.message || String(err) })
    })
    child.once('exit', code => {
      clearTimeout(timer)
      resolveDone({ code: code ?? -1, output: '' })
    })
  })
}

async function killProcess(plan, pid, label = '进程') {
  if (!pid || !isProcessAlive(pid)) return
  const result = await runCommand(plan, 'taskkill', ['/PID', String(pid), '/F'], { timeoutMs: 30000 })
  await logLine(plan, `结束旧${label} ${pid}${result.code === 0 ? ' 成功' : ` 结束（退出码 ${result.code}）`}`)
}

async function downloadFile(plan, urls, dest, expectedSize = 0) {
  const list = (Array.isArray(urls) ? urls : [urls]).map(value => toText(value).trim()).filter(Boolean)
  let lastError = null
  for (const url of list) {
    try {
      await logLine(plan, `开始下载：${url}`)
      const response = await fetch(url, {
        redirect: 'follow',
        headers: {
          'User-Agent': 'NianFeng-Chat-Updater/1.0',
          Accept: 'application/octet-stream, application/zip, */*',
        },
        signal: AbortSignal.timeout(15 * 60 * 1000),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      if (!response.body) throw new Error('响应没有内容')
      const part = `${dest}.part`
      await rm(part, { force: true }).catch(() => {})
      await pipeline(Readable.fromWeb(response.body), createWriteStream(part))
      const info = await stat(part)
      if (!info.isFile() || info.size < 1024) throw new Error(`文件过小（${info.size} 字节）`)
      const expected = Number(expectedSize) || 0
      if (expected > 0 && info.size !== expected) throw new Error(`文件大小不一致（${info.size} != ${expected}）`)
      await rename(part, dest)
      await logLine(plan, `下载完成：${info.size} 字节`)
      return info.size
    } catch (err) {
      lastError = err
      await logLine(plan, `下载失败：${err?.message || err}`)
    }
  }
  throw lastError || new Error('没有可用的下载地址')
}

function escapePowerShellLiteral(value) {
  return toText(value).replace(/'/g, "''")
}

async function extractZip(plan, zipFile, destDir) {
  await rm(destDir, { recursive: true, force: true }).catch(() => {})
  await mkdir(destDir, { recursive: true })

  // Windows 10/11 自带 tar.exe 可以解 zip，且比 PowerShell 启动更快、更少策略限制。
  const tarResult = await runCommand(plan, 'tar', ['-xf', zipFile, '-C', destDir], { timeoutMs: 15 * 60 * 1000 })
  if (tarResult.code === 0) return

  if (process.platform === 'win32') {
    const command =
      `$ErrorActionPreference='Stop'; ` +
      `Expand-Archive -LiteralPath '${escapePowerShellLiteral(zipFile)}' -DestinationPath '${escapePowerShellLiteral(destDir)}' -Force`
    const result = await runCommand(
      plan,
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
      { timeoutMs: 15 * 60 * 1000 },
    )
    if (result.code !== 0) throw new Error(`解压失败（tar=${tarResult.code}，powershell=${result.code}）：${result.output.slice(-600)}`)
    return
  }
  throw new Error(`解压失败（退出码 ${tarResult.code}）：${tarResult.output.slice(-600)}`)
}

async function normalizeExtractRoot(dir) {
  const entries = (await readdir(dir, { withFileTypes: true })).filter(entry => !/^(thumbs\.db|desktop\.ini)$/i.test(entry.name))
  if (entries.length !== 1 || !entries[0].isDirectory()) return dir
  const nested = join(dir, entries[0].name)
  if (
    existsSync(join(nested, 'app')) ||
    existsSync(join(nested, 'start.mjs')) ||
    existsSync(join(nested, 'package.json'))
  ) {
    return nested
  }
  return dir
}

async function replaceEntry(plan, source, target, label = '文件') {
  let lastError = null
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      await rm(target, { recursive: true, force: true })
      await cp(source, target, { recursive: true, force: true, errorOnExist: false })
      return
    } catch (err) {
      lastError = err
      if (attempt % 6 === 0) await logLine(plan, `替换${label}失败，正在重试：${err?.message || err}`)
      await sleep(500)
    }
  }
  throw lastError || new Error(`替换${label}失败`)
}

async function copyRootFiles(plan, sourceDir, targetDir, skipNames = new Set()) {
  let entries = []
  try {
    entries = await readdir(sourceDir, { withFileTypes: true })
  } catch (_) {
    return
  }
  for (const entry of entries) {
    if (skipNames.has(entry.name)) continue
    await replaceEntry(plan, join(sourceDir, entry.name), join(targetDir, entry.name), entry.name)
  }
}

function collectLaunchPlan(plan, fallbackCwd) {
  const cwd = toText(plan.launchCwd || fallbackCwd).trim() || fallbackCwd
  const script = toText(plan.launchScript).trim()
  return {
    cwd,
    script: script && existsSync(script) ? script : '',
    node: toText(plan.launchNode).trim(),
    args: Array.isArray(plan.launchArgs) ? plan.launchArgs.filter(value => typeof value === 'string') : [],
  }
}

function quoteForCmd(value) {
  const text = toText(value)
  return `"${text.replace(/"/g, '""')}"`
}

async function launchVisible(plan, fallbackCwd) {
  const target = collectLaunchPlan(plan, fallbackCwd)
  if (process.platform !== 'win32') {
    const command = target.node || target.script
    if (!command) throw new Error('没有可用的启动脚本')
    const child = await spawnDetachedChecked(command, target.node ? target.args : [], { cwd: target.cwd })
    child.on('error', () => {})
    child.unref()
    return
  }

  let script = target.script
  if (!script) {
    if (!target.node || !target.args.length) throw new Error('没有可用的启动脚本')
    script = join(dirname(plan.planFile || process.argv[2]), '启动念风-更新.cmd')
    const lines = [
      '@echo off',
      'chcp 65001 >nul',
      'setlocal',
      `cd /d ${quoteForCmd(target.cwd)}`,
      `${quoteForCmd(target.node)} ${target.args.map(quoteForCmd).join(' ')}`,
      'if errorlevel 1 pause',
      '',
    ]
    await writeFile(script, lines.join('\r\n'), 'utf8')
  }
  const child = await spawnDetachedChecked('cmd.exe', ['/c', 'start', '', script], { cwd: target.cwd })
  child.on('error', () => {})
  child.unref()
  await sleep(400)
}

async function launchDesktopExe(plan, exePath) {
  if (!exePath || !existsSync(exePath)) throw new Error(`桌面 EXE 不存在：${exePath}`)
  const args = Array.isArray(plan.launchArgs) ? plan.launchArgs.map(value => toText(value)).filter(Boolean) : []
  const child = await spawnDetachedChecked(exePath, args, { cwd: dirname(exePath) })
  child.on('error', () => {})
  child.unref()
  await logLine(plan, `已启动新桌面版：${exePath}`)
  await sleep(600)
}

async function replaceDesktopExe(plan, downloaded) {
  const target = toText(plan.desktopExe).trim()
  if (!target) throw new Error('没有找到当前桌面 EXE 路径')
  // taskkill 返回后可能还有短暂的文件句柄残留，替换本身再自带重试。
  await sleep(800)

  let lastError = null
  for (let attempt = 0; attempt < 180; attempt += 1) {
    const staged = `${target}.new`
    const backup = `${target}.old-${process.pid}`
    try {
      await rm(staged, { force: true }).catch(() => {})
      await copyFile(downloaded, staged)
      if (existsSync(target)) {
        await rm(backup, { force: true }).catch(() => {})
        try {
          await rename(target, backup)
        } catch (_) {
          await rm(target, { force: true })
        }
        try {
          await rename(staged, target)
        } catch (err) {
          if (!existsSync(target) && existsSync(backup)) await rename(backup, target).catch(() => {})
          throw err
        }
        await rm(backup, { force: true }).catch(() => {})
      } else {
        await rename(staged, target)
      }
      lastError = null
      break
    } catch (err) {
      lastError = err
      await rm(staged, { force: true }).catch(() => {})
      if (attempt % 6 === 0) await logLine(plan, `替换桌面 EXE 失败，正在重试：${err?.message || err}`)
      await sleep(500)
    }
  }
  if (lastError) throw lastError
  await logLine(plan, `桌面 EXE 已替换：${target}`)
  await launchDesktopExe(plan, target)
}

async function applyDesktopUpdate(plan) {
  const workDir = dirname(plan.planFile || process.argv[2])
  const targetName = basename(toText(plan.assetName).trim() || 'update.exe')
  const downloaded = join(workDir, targetName.replace(/[\\/:*?"<>|]/g, '_'))
  await downloadFile(plan, plan.downloadUrls, downloaded, plan.expectedSize)
  await replaceDesktopExe(plan, downloaded)
}

async function applyWebUpdate(plan) {
  const kind = toText(plan.kind).trim()
  const workDir = dirname(plan.planFile || process.argv[2])
  const zipFile = join(workDir, 'update.zip')
  const extractDir = join(workDir, 'extracted')
  await downloadFile(plan, plan.downloadUrls, zipFile, plan.expectedSize)
  await extractZip(plan, zipFile, extractDir)
  const sourceDir = await normalizeExtractRoot(extractDir)

  if (kind === 'web-deploy') {
    const homeDir = resolve(toText(plan.homeDir).trim() || dirname(toText(plan.appRoot).trim()))
    const sourceApp = join(sourceDir, 'app')
    if (!existsSync(sourceApp)) throw new Error('Web 部署包中缺少 app 目录')
    await replaceEntry(plan, sourceApp, join(homeDir, 'app'), 'Web app 目录')
    await copyRootFiles(plan, sourceDir, homeDir, new Set(['app', 'runtime', 'user_data', 'data']))
    await logLine(plan, `Web 部署版已更新到：${homeDir}`)
    await launchVisible(plan, homeDir)
    return
  }

  // 仓库源码运行（开发 / 源码部署）：覆盖项目源文件，但保留依赖、数据与本地构建目录。
  const rootDir = resolve(toText(plan.rootDir).trim() || toText(plan.appRoot).trim() || workDir)
  const preserve = new Set([
    '.git',
    '.local',
    '.tmp',
    'data',
    'extensions',
    'node_modules',
    'release',
    'tools',
    'user_data',
  ])
  await copyRootFiles(plan, sourceDir, rootDir, preserve)
  await logLine(plan, `Web 源码版已更新到：${rootDir}`)
  await launchVisible(plan, rootDir)
}

async function applyRestart(plan) {
  const kind = toText(plan.kind).trim()
  await waitPidGone(plan, plan.waitPid || plan.nodePid, 90000)
  if (kind === 'desktop') {
    if (plan.desktopPid) await killProcess(plan, plan.desktopPid, '桌面进程')
    const exePath = toText(plan.desktopExe).trim()
    if (!exePath) throw new Error('没有找到桌面 EXE 路径')
    await launchDesktopExe(plan, exePath)
    return
  }
  const cwd = toText(plan.rootDir || plan.homeDir || plan.appRoot).trim() || dirname(plan.planFile || process.argv[2])
  await launchVisible(plan, cwd)
}

async function main() {
  const planFile = process.argv[2]
  if (!planFile) throw new Error('缺少更新计划文件')
  const plan = JSON.parse(await readFile(planFile, 'utf8'))
  plan.planFile = planFile

  await logLine(plan, `更新助手启动：action=${plan.action || ''} kind=${plan.kind || ''} tag=${plan.tag || ''}`)
  if (plan.action === 'update') {
    await waitPidGone(plan, plan.waitPid || plan.nodePid, 90000)
    if (toText(plan.kind).trim() === 'desktop') {
      // EXE 版更新：先彻底关闭窗口 / 宿主，再开始下载；期间完全无提示。
      if (plan.desktopPid) await killProcess(plan, plan.desktopPid, '桌面进程')
      await applyDesktopUpdate(plan)
    } else {
      await applyWebUpdate(plan)
    }
  } else if (plan.action === 'restart') {
    await applyRestart(plan)
  } else {
    throw new Error(`未知助手操作：${plan.action || ''}`)
  }

  await logLine(plan, '助手执行完成')
  // 给新进程一点启动时间，然后结束助手本身；临时下载目录尽力清理。
  await sleep(300)
  if (plan.workDir) await rm(plan.workDir, { recursive: true, force: true }).catch(() => {})
  process.exit(0)
}

async function recoverAfterFailure(plan) {
  if (!plan || !['update', 'restart'].includes(plan.action)) return
  try {
    const kind = toText(plan.kind).trim()
    if (kind === 'desktop') {
      const exePath = toText(plan.desktopExe).trim()
      if (exePath && existsSync(exePath)) await launchDesktopExe(plan, exePath)
      return
    }
    const cwd = toText(plan.launchCwd || plan.homeDir || plan.rootDir || plan.appRoot).trim()
    const script = toText(plan.launchScript).trim()
    if (script && existsSync(script)) await launchVisible(plan, cwd)
  } catch (err) {
    await logLine(plan, `旧版本恢复启动失败：${err?.message || err}`)
  }
}

const isDirectRun = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

if (isDirectRun) {
  main().catch(async err => {
    const planFile = process.argv[2]
    try {
      const plan = planFile ? JSON.parse(await readFile(planFile, 'utf8')) : {}
      await logLine(plan, `助手执行失败：${err?.stack || err?.message || err}`)
      await recoverAfterFailure(plan)
    } catch (_) {
      console.error(err)
    }
    process.exit(1)
  })
}
