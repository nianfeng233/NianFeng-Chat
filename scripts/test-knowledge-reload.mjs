/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * 知识库 / 外部 bridge 热重载回归：
 *   - 安装外部 knowledge-base 插件；
 *   - 写入一条知识；
 *   - 触发插件目录 rescan（bridge 会被 dispose 并重新加载）；
 *   - 再次写入，验证不会命中已关闭的 SQLite 连接（database is not open）。
 */
import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startBackend } from '../server/index.mjs'

const checks = []
const check = (name, ok, detail = '') => {
  checks.push({ name, ok: !!ok, detail })
  console.log(`${ok ? '  ✔' : '  ✗'} ${name}${!ok && detail ? `  → ${detail}` : ''}`)
}

const dataDir = await mkdtemp(join(tmpdir(), 'nianfeng-kb-reload-'))
await cp('extensions/knowledge-base', join(dataDir, 'plugins', 'knowledge-base'), { recursive: true })
const backend = await startBackend({ port: 0, host: '127.0.0.1', dataDir })
const base = `${backend.url}/api`
const post = async (path, body) => {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  })
  return { status: res.status, body: await res.text() }
}

try {
  const first = await post('/knowledge/write', { path: '测试', title: '条目1', content: '内容1' })
  check('知识库首次写入成功', first.status === 200 && first.body.includes('"ok":true'), first.body.slice(0, 240))

  const rescan = await post('/plugins/rescan')
  check('插件重新扫描成功', rescan.status === 200, `HTTP ${rescan.status}`)
  await new Promise(resolve => setTimeout(resolve, 400))

  const second = await post('/knowledge/write', { path: '测试', title: '条目2', content: '内容2' })
  check(
    '重扫后写入不再命中已关闭数据库',
    second.status === 200 && second.body.includes('"ok":true') && !second.body.includes('database is not open'),
    second.body.slice(0, 300),
  )

  const list = await (await fetch(`${base}/knowledge/entries`)).json()
  check('两条知识都持久化成功', (list?.entries || []).length >= 2, JSON.stringify(list?.entries?.map(item => item.title)))
} finally {
  await backend.close().catch(() => {})
  await rm(dataDir, { recursive: true, force: true }).catch(() => {})
}

const failed = checks.filter(item => !item.ok)
console.log(`\n结果：${checks.length - failed.length}/${checks.length} 项通过`)
if (failed.length) process.exit(1)
process.exit(0)
