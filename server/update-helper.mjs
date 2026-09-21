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
import { Readable, Transform } from 'node:stream'
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

/** 更新进度窗口 PID；失败路径重新读取 plan 时也能靠它关掉残留窗口。 */
let activeProgressPid = 0

/** 等进度窗口读到最终状态自行关闭；超时则强制结束，避免残留后台窗口。 */
async function closeUpdateWindow(plan) {
  const pid = Number(plan?._progressPid) || activeProgressPid || 0
  if (!pid) return
  const deadline = Date.now() + 12000
  while (Date.now() < deadline && isProcessAlive(pid)) await sleep(250)
  if (isProcessAlive(pid)) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch (_) {
      /* ignore */
    }
  }
  activeProgressPid = 0
  if (plan) plan._progressPid = 0
}

function formatBytes(value) {
  const bytes = Math.max(0, Number(value) || 0)
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/** 写入一份给“更新进度窗口”读取的 JSON 状态；失败不影响更新本身。 */
async function writeUpdateStatus(plan, patch = {}) {
  if (!plan) return
  const next = {
    ...(plan._status || {}),
    ...patch,
    at: new Date().toISOString(),
  }
  plan._status = next
  const file = plan.statusFile
  if (!file) return
  try {
    await writeFile(file, JSON.stringify(next), 'utf8')
  } catch (_) {
    /* 进度窗口不是更新必经链路 */
  }
}

function buildProgressScript() {
  return [
    'param([string]$StatusPath)',
    "$ErrorActionPreference = 'SilentlyContinue'",
    "try { $Host.UI.RawUI.WindowTitle = '念风 Chat 更新' } catch {}",
    '$started = Get-Date',
    'while ((((Get-Date) - $started).TotalHours -lt 2)) {',
    '  $raw = Get-Content -LiteralPath $StatusPath -Raw',
    '  if ($raw) {',
    '    try { $s = $raw | ConvertFrom-Json } catch { $s = $null }',
    '    if ($s) {',
    '      Clear-Host',
    "      Write-Host ''",
    "      Write-Host '  念风 Chat 正在更新' -ForegroundColor Green",
    "      Write-Host ''",
    '      $phase = [string]$s.phaseText',
    '      if (-not $phase) { $phase = [string]$s.phase }',
    "      Write-Host ('  阶段：' + $phase)",
    '      $total = [double]$s.total',
    '      $received = [double]$s.received',
    '      if ($total -gt 0) {',
    '        $percent = [Math]::Min(100, [Math]::Round($received * 100 / $total, 1))',
    '        $width = 42',
    '        $filled = [Math]::Min($width, [int]($percent * $width / 100))',
    "        $bar = ('#' * $filled).PadRight($width, '-')",
    "        Write-Host ('  进度：[' + $bar + '] ' + $percent + '%')",
    "        Write-Host ('  大小：' + [Math]::Round($received / 1MB, 1) + ' MB / ' + [Math]::Round($total / 1MB, 1) + ' MB')",
    '      }',
    "      Write-Host ''",
    "      Write-Host ('  ' + [string]$s.message)",
    '      if ($s.phase -eq \"done\" -or $s.phase -eq \"error\") {',
    '        Start-Sleep -Seconds 5',
    '        break',
    '      }',
    '    }',
    '  }',
    '  Start-Sleep -Milliseconds 400',
    '}',
    '',
  ].join('\r\n')
}

/** 桌面版没有可见终端：另开一个精简控制台窗口显示阶段 / 百分比进度。 */
async function openUpdateWindow(plan) {
  if (process.platform !== 'win32') return null
  if (String(process.env.NIANFENG_NO_UPDATE_CONSOLE || '').trim() === '1') return null
  const dir = dirname(plan.planFile || process.argv[2] || plan.workDir || process.cwd())
  const script = join(dir, 'progress.ps1')
  try {
    await writeFile(script, `\uFEFF${buildProgressScript()}`, 'utf8')
    await writeUpdateStatus(plan, {
      phase: 'preparing',
      phaseText: '准备更新',
      message: '正在准备下载更新包…',
      received: 0,
      total: 0,
    })
    const child = await spawnDetachedChecked(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, plan.statusFile || ''],
      { cwd: dirname(dir) || process.cwd(), windowsHide: false },
    )
    child.on('error', () => {})
    child.unref()
    plan._progressPid = child.pid
    activeProgressPid = child.pid
    return child
  } catch (err) {
    await logLine(plan, `进度窗口启动失败（不影响更新）：${err?.message || err}`)
    return null
  }
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
  await logLine(plan, `等待进程 ${pid} 退出超时${alive ? '，将强制结束旧实例' : ''}`)
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
  const value = Number(pid)
  if (!value || !isProcessAlive(value)) return true
  const result = await runCommand(plan, 'taskkill', ['/PID', String(value), '/F'], { timeoutMs: 30000 })
  let code = result.code
  if (code !== 0 && isProcessAlive(value)) {
    // 部分受限环境 / 云服务器会拦截 taskkill（Access denied）。Node 的
    // process.kill 在 Windows 上走 TerminateProcess，可作为兜底。
    try {
      process.kill(value, 'SIGKILL')
      code = 0
      await logLine(plan, `taskkill 未成功（退出码 ${result.code}），已用 Node 原生方式结束旧${label} ${value}`)
    } catch (err) {
      await logLine(plan, `taskkill 结束旧${label} ${value} 失败，Node 兜底也失败：${err?.message || err}`)
    }
  }
  // taskkill 返回不代表进程已经完全退出（尤其图形程序），确认后再继续替换文件。
  const deadline = Date.now() + 10000
  while (Date.now() < deadline && isProcessAlive(value)) await sleep(200)
  const alive = isProcessAlive(value)
  await logLine(plan, `结束旧${label} ${value}${alive ? ' 失败：进程仍存在' : ' 成功'}`)
  if (alive) throw new Error(`无法关闭旧${label} ${value}，为避免更新后新旧实例冲突已停止`)
  return true
}

/**
 * 确保旧实例进程真正退出后再继续。
 *
 * 旧逻辑只是等待并在超时后继续下载 / 替换：如果旧终端里的后端没有正常退出，
 * 新版本会被提前拉起，表现为旧终端还开着、两个实例同时占内存和端口。
 * 这里超时后主动结束旧进程；仍然结束不了就中止更新，绝不让新旧实例并存。
 */
async function ensurePidGone(plan, pid, { timeoutMs = 90000, label = '旧实例' } = {}) {
  const value = Number(pid)
  if (!value) return true
  const gone = await waitPidGone(plan, value, timeoutMs)
  if (gone) return true
  await writeUpdateStatus(plan, {
    phase: 'stop',
    phaseText: '正在结束旧实例',
    message: `${label}（PID ${value}）没有按时退出，正在强制结束，稍后继续更新…`,
    received: plan?._status?.received || 0,
    total: plan?._status?.total || 0,
    percent: plan?._status?.percent || 0,
  })
  await killProcess(plan, value, label.replace(/^旧/, '') || '实例')
  if (isProcessAlive(value)) {
    throw new Error(`${label} ${value} 仍然没有退出，已停止更新以避免新旧实例冲突；请手动关闭旧窗口后重试`)
  }
  return true
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
      const total = Number(expectedSize) || Number(response.headers.get('content-length')) || 0
      let received = 0
      let lastStatusAt = 0
      let lastLogAt = 0
      const report = async () => {
        const percent = total > 0 ? Math.min(1, received / total) : 0
        await writeUpdateStatus(plan, {
          phase: 'download',
          phaseText: '正在下载更新包',
          message: total > 0 ? `已下载 ${formatBytes(received)} / ${formatBytes(total)}` : `已下载 ${formatBytes(received)}`,
          received,
          total,
          percent,
        })
        if (Date.now() - lastLogAt > 1500) {
          lastLogAt = Date.now()
          await logLine(
            plan,
            total > 0
              ? `下载进度 ${Math.round(percent * 100)}%（${formatBytes(received)} / ${formatBytes(total)}）`
              : `已下载 ${formatBytes(received)}`,
          )
        }
      }
      const progress = new Transform({
        async transform(chunk, _encoding, callback) {
          received += chunk.length
          const now = Date.now()
          if (now - lastStatusAt > 400 || (total > 0 && received >= total)) {
            lastStatusAt = now
            await report().catch(() => {})
          }
          callback(null, chunk)
        },
      })
      await writeUpdateStatus(plan, {
        phase: 'download',
        phaseText: '正在下载更新包',
        message: total > 0 ? `0 B / ${formatBytes(total)}` : '正在连接下载地址…',
        received: 0,
        total,
        percent: 0,
      })
      await pipeline(Readable.fromWeb(response.body), progress, createWriteStream(part))
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
    // 先优先用 .NET 的 ZipFile：它按流式读取，不会像 Expand-Archive 那样在
    // 大更新包 / 低内存机器上出现“内存不足”或长时间卡住。
    await rm(destDir, { recursive: true, force: true }).catch(() => {})
    const zipFileCommand =
      `$ErrorActionPreference='Stop'; ` +
      `Add-Type -AssemblyName System.IO.Compression.FileSystem; ` +
      `[System.IO.Compression.ZipFile]::ExtractToDirectory('${escapePowerShellLiteral(zipFile)}', '${escapePowerShellLiteral(destDir)}')`
    const zipFileResult = await runCommand(
      plan,
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', zipFileCommand],
      { timeoutMs: 15 * 60 * 1000 },
    )
    if (zipFileResult.code === 0) return

    await mkdir(destDir, { recursive: true })
    const command =
      `$ErrorActionPreference='Stop'; ` +
      `Expand-Archive -LiteralPath '${escapePowerShellLiteral(zipFile)}' -DestinationPath '${escapePowerShellLiteral(destDir)}' -Force`
    const result = await runCommand(
      plan,
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
      { timeoutMs: 15 * 60 * 1000 },
    )
    if (result.code !== 0) {
      throw new Error(`解压失败（tar=${tarResult.code}，zipfile=${zipFileResult.code}，expand=${result.code}）：${result.output.slice(-600)}`)
    }
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
  await logLine(plan, `准备启动新桌面版：${exePath}${args.length ? `（携带 ${args.length} 个参数）` : ''}`)
  const child = await spawnDetachedChecked(exePath, args, { cwd: dirname(exePath) })
  let exitInfo = null
  child.on('error', err => {
    void logLine(plan, `新桌面版启动报错：${err?.message || err}`)
  })
  child.once('exit', (code, signal) => {
    exitInfo = { code, signal }
    void logLine(plan, `新桌面版进程提前退出：code=${code} signal=${signal || ''}`)
  })
  child.unref()
  await logLine(plan, `已启动新桌面版：${exePath}`)
  // 正常桌面版启动后应保持运行；这里等一会儿捕获“进程秒退”的启动失败。
  await sleep(1800)
  if (exitInfo) {
    if (exitInfo.signal) throw new Error(`新桌面版启动后被信号 ${exitInfo.signal} 结束`)
    throw new Error(`新桌面版启动后立即退出：code=${exitInfo.code}`)
  }
  if (child.exitCode !== null) throw new Error(`新桌面版启动后立即退出：code=${child.exitCode}`)
  await sleep(200)
}

async function replaceDesktopExe(plan, downloaded) {
  const target = toText(plan.desktopExe).trim()
  if (!target) throw new Error('没有找到当前桌面 EXE 路径')
  // taskkill 返回后可能还有短暂的文件句柄残留，替换本身再自带重试。
  await sleep(800)

  let lastError = null
  let lastBackup = ''
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
        // 先保留旧版备份，等新桌面版确认启动成功后再删除；启动失败可回滚。
        lastBackup = backup
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
  try {
    await launchDesktopExe(plan, target)
  } catch (err) {
    if (lastBackup && existsSync(lastBackup)) {
      try {
        await rm(target, { force: true })
        await rename(lastBackup, target)
        await logLine(plan, `新桌面版启动失败，已恢复旧版本：${err?.message || err}`)
      } catch (restoreErr) {
        await logLine(plan, `旧版本恢复失败：${restoreErr?.message || restoreErr}`)
      }
    }
    throw err
  }
  if (lastBackup) await rm(lastBackup, { force: true }).catch(() => {})
}

async function applyDesktopUpdate(plan) {
  const workDir = dirname(plan.planFile || process.argv[2])
  const targetName = basename(toText(plan.assetName).trim() || 'update.exe')
  const downloaded = join(workDir, targetName.replace(/[\\/:*?"<>|]/g, '_'))
  // 先完整下载、校验，再关闭旧窗口并替换；下载期间进度窗口会一直显示。
  await downloadFile(plan, plan.downloadUrls, downloaded, plan.expectedSize)
  await writeUpdateStatus(plan, {
    phase: 'replace',
    phaseText: '正在替换旧版本',
    message: '下载完成，正在关闭旧窗口并替换文件…',
    received: plan.expectedSize || 0,
    total: plan.expectedSize || 0,
    percent: 1,
  })
  if (plan.desktopPid) await killProcess(plan, plan.desktopPid, '桌面进程')
  await replaceDesktopExe(plan, downloaded)
}

async function applyWebUpdate(plan) {
  const kind = toText(plan.kind).trim()
  const workDir = dirname(plan.planFile || process.argv[2])
  const zipFile = join(workDir, 'update.zip')
  const extractDir = join(workDir, 'extracted')
  await downloadFile(plan, plan.downloadUrls, zipFile, plan.expectedSize)
  await writeUpdateStatus(plan, {
    phase: 'extract',
    phaseText: '正在解压更新包',
    message: '下载完成，正在解压…',
    received: plan.expectedSize || 0,
    total: plan.expectedSize || 0,
    percent: 1,
  })
  await extractZip(plan, zipFile, extractDir)
  const sourceDir = await normalizeExtractRoot(extractDir)
  await writeUpdateStatus(plan, {
    phase: 'replace',
    phaseText: '正在替换程序文件',
    message: '解压完成，正在替换程序文件…',
    received: plan.expectedSize || 0,
    total: plan.expectedSize || 0,
    percent: 1,
  })

  if (kind === 'web-deploy') {
    const homeDir = resolve(toText(plan.homeDir).trim() || dirname(toText(plan.appRoot).trim()))
    const sourceApp = join(sourceDir, 'app')
    if (!existsSync(sourceApp)) throw new Error('Web 部署包中缺少 app 目录')
    await replaceEntry(plan, sourceApp, join(homeDir, 'app'), 'Web app 目录')
    await copyRootFiles(plan, sourceDir, homeDir, new Set(['app', 'runtime', 'user_data', 'data']))
    await logLine(plan, `Web 部署版已更新到：${homeDir}`)
    // 替换完成后再确认一次旧后端确实不在：避免极端情况下旧进程晚重启导致端口 / 内存冲突。
    await ensurePidGone(plan, plan.waitPid || plan.nodePid, { timeoutMs: 5000, label: '旧实例' })
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
  // 替换完成后再确认一次旧后端确实不在，再拉起新终端。
  await ensurePidGone(plan, plan.waitPid || plan.nodePid, { timeoutMs: 5000, label: '旧实例' })
  await launchVisible(plan, rootDir)
}

async function applyRestart(plan) {
  const kind = toText(plan.kind).trim()
  await ensurePidGone(plan, plan.waitPid || plan.nodePid, {
    timeoutMs: Number(plan.pidWaitMs) || 90000,
    label: '旧实例',
  })
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
    // 先开进度窗口，让用户明确知道下载还在继续；下载完成前不要关闭旧窗口 / 替换文件。
    await openUpdateWindow(plan)
    await writeUpdateStatus(plan, {
      phase: 'preparing',
      phaseText: '准备更新',
      message: '正在等待旧实例退出，准备下载更新包…',
      received: 0,
      total: 0,
      percent: 0,
    })
    await ensurePidGone(plan, plan.waitPid || plan.nodePid, {
      timeoutMs: Number(plan.pidWaitMs) || 90000,
      label: '旧实例',
    })
    if (toText(plan.kind).trim() === 'desktop') {
      // 先下载完并校验，再关闭旧窗口；下载期间用户能看到明确进度。
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
  await writeUpdateStatus(plan, {
    phase: 'done',
    phaseText: plan.action === 'restart' ? '重启完成' : '更新完成',
    message: plan.action === 'restart' ? '已重新启动念风。' : '更新完成，正在启动新版本…',
    received: plan.expectedSize || plan._status?.received || 0,
    total: plan.expectedSize || plan._status?.total || 0,
    percent: 1,
  })
  // 给新进程和进度窗口一点时间显示最终状态，然后结束助手本身。
  await closeUpdateWindow(plan)
  if (plan.workDir) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        await rm(plan.workDir, { recursive: true, force: true })
        break
      } catch (_) {
        await sleep(250)
      }
    }
  }
  process.exit(0)
}

async function recoverAfterFailure(plan) {
  if (!plan || !['update', 'restart'].includes(plan.action)) return
  try {
    const kind = toText(plan.kind).trim()
    if (kind === 'desktop') {
      const exePath = toText(plan.desktopExe).trim()
      if (plan.desktopPid && isProcessAlive(plan.desktopPid)) {
        try {
          await killProcess(plan, plan.desktopPid, '桌面进程')
        } catch (err) {
          await logLine(plan, `恢复前关闭旧桌面进程失败：${err?.message || err}`)
        }
      }
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
      await writeUpdateStatus(plan, {
        phase: 'error',
        phaseText: '更新失败',
        message: `更新失败：${err?.message || err}`,
        percent: plan._status?.percent || 0,
      })
      await closeUpdateWindow(plan).catch(() => {})
      await recoverAfterFailure(plan)
    } catch (_) {
      console.error(err)
    }
    process.exit(1)
  })
}
