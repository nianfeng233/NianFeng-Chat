/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * 关闭正在运行的「念风」实例（按端口找进程）。
 *
 *   npm run stop              # 关闭默认的 5173 / 8788
 *   node scripts/stop.mjs 5173 8788 18099
 *   node scripts/stop.mjs --dry-run
 *
 * 只按端口匹配；如果某个端口被其他程序占用也会被结束，
 * 请确认这些端口属于你自己的念风实例再用。
 */
import { findListeningPids, killProcess } from '../server/port-utils.mjs'

const args = process.argv.slice(2).filter(arg => arg !== '--dry-run')
const dryRun = process.argv.includes('--dry-run')
const ports = (args.length ? args : [process.env.WEB_PORT || 5173, process.env.BACKEND_PORT || 8788])
  .map(value => Number(value))
  .filter(port => Number.isInteger(port) && port > 0)

if (!ports.length) {
  console.error('没有可关闭的端口（可执行 npm run stop 使用默认 5173 / 8788）')
  process.exit(1)
}

const listeners = findListeningPids(ports)
if (!listeners) {
  console.error('无法枚举端口（netstat 不可用）。可以手动结束 node.exe，或使用 stop.ps1。')
  process.exit(1)
}
if (!listeners.size) {
  console.log(`没有发现监听中的念风实例（端口：${ports.join(' / ')}）`)
  process.exit(0)
}

let killed = 0
const killedPids = new Set()
for (const [port, pid] of listeners) {
  if (dryRun) {
    console.log(`[dry-run] 端口 ${port} 由 PID ${pid} 监听`)
    continue
  }
  if (killedPids.has(pid)) {
    killed++
    continue
  }
  try {
    killProcess(pid)
    killedPids.add(pid)
    console.log(`已关闭端口 ${port}（PID ${pid}）`)
    killed++
  } catch (err) {
    console.error(`关闭端口 ${port}（PID ${pid}）失败：${err.message}`)
  }
}

if (dryRun) console.log(`\n共发现 ${listeners.size} 个监听进程（未执行关闭）`)
else console.log(`\n完成：关闭 ${killed}/${listeners.size} 个实例。${
  killed === listeners.size && listeners.size ? '现在可以重新运行 start.cmd 启动新版。' : '如仍有残留，请重试或手动结束 node.exe。'
}`)
