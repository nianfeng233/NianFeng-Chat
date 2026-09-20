/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 *
 * WebUI 反向代理回归测试：
 *   - /api 代理正常透传；
 *   - 浏览器刷新 / 关闭导致 SSE 下游断开时，上游连接必须一起销毁，
 *     否则后端 hub 会不断堆积悬挂客户端，WebUI 越用越卡。
 */
import http from 'node:http'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startBackend } from '../server/index.mjs'
import { createWebServer } from '../start.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const dataDir = join(ROOT, '.tmp', `web-proxy-test-${Date.now()}`)

let failed = 0
const check = (name, ok, detail = '') => {
  if (!ok) failed += 1
  console.log(`${ok ? '  ✔' : '  ✗'} ${name}${ok ? '' : `  → ${detail}`}`)
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return server.address().port
}

async function getJson(url) {
  const response = await fetch(url, { cache: 'no-store' })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json()
}

async function openThenAbortSse(url) {
  return new Promise(resolve => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      resolve()
    }
    const request = http.get(url, response => {
      response.once('data', () => {
        setTimeout(() => {
          request.destroy()
          finish()
        }, 120)
      })
      response.on('end', finish)
      response.on('error', finish)
    })
    request.on('error', finish)
    setTimeout(() => {
      request.destroy()
      finish()
    }, 4000)
  })
}

async function main() {
  console.log('\n① 启动后端与 WebUI 代理')
  const backend = await startBackend({ port: 0, host: '127.0.0.1', dataDir })
  const web = createWebServer({
    backendPort: backend.port,
    accessToken: '',
    accessTokenHash: '',
    getAccessTokenHash: null,
    host: '127.0.0.1',
    allowedHosts: [],
  })
  const webPort = await listen(web)
  const webBase = `http://127.0.0.1:${webPort}`
  check('代理服务器监听成功', webPort > 0, String(webPort))

  console.log('\n② REST 代理')
  const health = await getJson(`${webBase}/api/health`)
  check('GET /api/health 经代理返回 ok', health.ok === true, JSON.stringify(health).slice(0, 160))

  console.log('\n③ SSE 下游断开时同步销毁上游')
  const before = await getJson(`${backend.url}/api/logs`)
  check('测试前后端没有悬挂 SSE 客户端', Number(before.clients) === 0, JSON.stringify(before))
  await openThenAbortSse(`${webBase}/api/events`)
  await sleep(600)
  const after = await getJson(`${backend.url}/api/logs`)
  check('浏览器断开 SSE 后后端客户端数回落为 0', Number(after.clients) === 0, JSON.stringify(after))

  await web.close?.()
  await backend.close?.()
  await rm(dataDir, { recursive: true, force: true }).catch(() => {})

  console.log(failed ? `\n结果：${failed} 项失败` : '\n✔ WebUI 代理回归测试全部通过')
  process.exitCode = failed ? 1 : 0
}

main().catch(err => {
  console.error(err?.stack || err)
  process.exitCode = 1
})
