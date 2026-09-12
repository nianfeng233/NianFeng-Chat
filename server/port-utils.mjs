/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * 端口 / 旧实例工具（后端与启动脚本共用）。
 *
 * 念风在开发模式会占用 WEB_PORT(5173) 与 BACKEND_PORT(8788)。
 * 用户重复双击 start.cmd / serve.cmd / backend.cmd 时，新进程不应该
 * 直接报"端口被占用"，而是先确认占用者是不是旧的念风实例：
 *   - 是念风：自动结束旧实例后继续启动
 *   - 是别的程序：明确报错，不误杀
 */
import { execFileSync } from 'node:child_process'

export function parseNetstatListeners(output, ports) {
  const wanted = new Set(ports.map(Number))
  const found = new Map()
  for (const line of String(output || '').split(/\r?\n/)) {
    const match = line.match(/^\s*TCP\s+\S*:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i)
    if (!match) continue
    const port = Number(match[1])
    if (!wanted.has(port)) continue
    found.set(port, Number(match[2]))
  }
  return found
}

/** 返回 Map<port, pid>；无法枚举时返回 null（调用方自行降级） */
export function findListeningPids(ports) {
  const list = ports.map(Number)
  try {
    if (process.platform === 'win32') {
      const output = execFileSync('netstat', ['-ano'], { encoding: 'utf8' })
      return parseNetstatListeners(output, list)
    }
    const found = new Map()
    for (const port of list) {
      try {
        const output = execFileSync('lsof', ['-ti', `tcp:${port}`, '-s', 'TCP:LISTEN'], { encoding: 'utf8' }).trim()
        if (output) found.set(port, Number(output.split(/\s+/)[0]))
      } catch (_) {
        /* 没有监听时 lsof 退出码非 0 */
      }
    }
    return found
  } catch (_) {
    return null
  }
}

export function killProcess(pid) {
  if (!pid) return false
  if (process.platform === 'win32') {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  } else {
    process.kill(pid, 'SIGTERM')
  }
  return true
}

/** 这个端口后面是不是一个念风实例？后端端口看 /api/health，Web 端口看页面标题 */
export async function looksLikeNianFeng(port) {
  const timeout = ms => AbortSignal.timeout(ms)
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: timeout(1200) })
    if (res.ok) {
      const data = await res.json().catch(() => null)
      if (data && (String(data.name || '').includes('念风') || data.ok === true)) return true
    }
  } catch (_) {
    /* 继续尝试页面 */
  }
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, { signal: timeout(1000) })
    const text = await res.text()
    return text.includes('念风')
  } catch (_) {
    return false
  }
}

/**
 * 确保端口可用；被旧念风占用时自动关闭，被其他程序占用时抛错。
 * @returns {Promise<{stopped:number[]}>}
 */
export async function ensurePortsFree(ports, { autoStop = true, log = console } = {}) {
  const list = [...new Set(ports.map(Number).filter(Boolean))]
  const listeners = findListeningPids(list)
  if (!listeners || listeners.size === 0) return { stopped: [] }
  const stopped = []
  const killedPids = new Set()
  for (const [port, pid] of listeners) {
    if (!autoStop) throw new Error(`端口 ${port} 已被进程 ${pid} 占用`)
    // dev 模式下 Web 端口与后端端口常常属于同一个进程，只关一次
    if (killedPids.has(pid)) {
      stopped.push(port)
      continue
    }
    if (!(await looksLikeNianFeng(port))) {
      throw new Error(`端口 ${port} 被其他程序占用（PID ${pid}），请先关闭它或改用 BACKEND_PORT / WEB_PORT`)
    }
    try {
      killProcess(pid)
      killedPids.add(pid)
      stopped.push(port)
      log.warn?.(`检测到旧的念风实例，已自动关闭：端口 ${port}（PID ${pid}）`)
    } catch (err) {
      throw new Error(`端口 ${port} 被旧念风实例占用，自动关闭失败：${err.message}；请运行 npm run stop 或双击 stop.cmd`)
    }
  }
  if (stopped.length) await new Promise(resolve => setTimeout(resolve, 400))
  return { stopped }
}
