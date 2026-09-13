/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * 后端安全回归测试（真实 HTTP 调用，临时数据目录）：
 *   - 静态目录前缀缺陷（public / public-secret 兄弟目录）
 *   - Origin / Host 校验与 CORS 白名单（DNS rebinding 防护）
 *   - /api/health 未认证时脱敏、配令牌后分层返回
 *   - ?token= 只做首屏 Cookie 引导，API 不再接受查询串令牌
 *   - /api/rss SSRF 拦截（本机 / 内网 / 云元数据 / 非 http）
 *   - 常量时间令牌比较
 *   - SSE 长连接不影响后端优雅关闭
 *
 * 用法：npm run test:security
 */
import http from 'node:http'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startBackend } from '../server/index.mjs'
import { timingSafeStringEqual } from '../server/security-utils.mjs'
import { requestPinned } from '../server/net-guard.mjs'
import { createWebServer, webuiOriginList } from '../start.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const TEMP = join(ROOT, '.tmp', `security-test-${Date.now()}`)

let failed = 0
const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  if (!ok) failed++
  console.log(`${ok ? '  ✔' : '  ✗'} ${name}${ok ? '' : '  → ' + detail}`)
}

function rawRequest(origin, path, { method = 'GET', headers = {} } = {}) {
  const target = new URL(origin)
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: target.hostname, port: target.port, path, method, headers },
      res => {
        const chunks = []
        res.on('data', chunk => chunks.push(chunk))
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }),
        )
      },
    )
    req.on('error', reject)
    req.end()
  })
}

function listen(server, port = 0, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => resolve(server.address().port))
  })
}

async function freePort() {
  const probe = http.createServer()
  const port = await listen(probe, 0)
  await new Promise(resolve => probe.close(resolve))
  return port
}

/** 测试用最小 zip 写入（store 方法；我们的解析器不校验 CRC）。 */
function makeZip(entries) {
  const localParts = []
  const centralParts = []
  let offset = 0
  for (const entry of entries) {
    const nameBuf = Buffer.from(String(entry.name), 'utf8')
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data ?? ''), 'utf8')
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt32LE(0, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)
    localParts.push(local, nameBuf, data)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt32LE(0, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt32LE(offset, 42)
    centralParts.push(central, nameBuf)
    offset += 30 + nameBuf.length + data.length
  }
  const local = Buffer.concat(localParts)
  const central = Buffer.concat(centralParts)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(central.length, 12)
  eocd.writeUInt32LE(local.length, 16)
  return Buffer.concat([local, central, eocd])
}


async function main() {
  const staticRoot = join(TEMP, 'static')
  const publicDir = join(staticRoot, 'public')
  const siblingDir = join(staticRoot, 'public-secret')
  await mkdir(publicDir, { recursive: true })
  await mkdir(siblingDir, { recursive: true })
  await writeFile(join(publicDir, 'ok.txt'), 'STATIC-OK', 'utf8')
  await writeFile(join(siblingDir, 'secret.txt'), 'SIBLING-SECRET', 'utf8')
  await mkdir(join(publicDir, 'user_data'), { recursive: true })
  await writeFile(join(publicDir, 'user_data', 'config.json'), '{"webuiToken":"STATIC-SECRET"}', 'utf8')
  await mkdir(join(publicDir, '.git'), { recursive: true })
  await writeFile(join(publicDir, '.git', 'config'), 'GIT-CONFIG-SECRET', 'utf8')

  console.log('\n① 静态资源目录边界')
  let backend = await startBackend({
    port: 0,
    host: '127.0.0.1',
    dataDir: join(TEMP, 'data-a'),
    staticDir: relative(ROOT, publicDir),
  })
  try {
    const normal = await rawRequest(backend.url, '/ok.txt')
    check('正常静态文件可访问', normal.status === 200 && normal.text === 'STATIC-OK', JSON.stringify(normal))

    const traversal = await rawRequest(backend.url, '/%2e%2e/public-secret/secret.txt')
    check('前缀兄弟目录不能越界读取', traversal.status !== 200 && !traversal.text.includes('SIBLING-SECRET'), JSON.stringify(traversal))

    const backslash = await rawRequest(backend.url, '/%2e%2e%5cpublic-secret%5csecret.txt')
    check('URL 编码反斜杠不能越界读取', backslash.status !== 200 && !backslash.text.includes('SIBLING-SECRET'), JSON.stringify(backslash))

    const staticConfig = await rawRequest(backend.url, '/user_data/config.json')
    check('静态服务不暴露 user_data 配置', staticConfig.status === 404 && !staticConfig.text.includes('STATIC-SECRET'), JSON.stringify(staticConfig))

    const staticGit = await rawRequest(backend.url, '/.git/config')
    check('静态服务不暴露版本库目录', staticGit.status === 404 && !staticGit.text.includes('GIT-CONFIG-SECRET'), JSON.stringify(staticGit))

    console.log('\n② Origin / Host / CORS / DNS rebinding')
    const evil = await rawRequest(backend.url, '/api/health', { headers: { Origin: 'http://evil.example' } })
    check(
      '未知 Origin 直接 403 且不回 CORS 头',
      evil.status === 403 && !evil.headers['access-control-allow-origin'],
      JSON.stringify({ status: evil.status, acao: evil.headers['access-control-allow-origin'] }),
    )

    const same = await rawRequest(backend.url, '/api/health', { headers: { Origin: backend.url } })
    check(
      '同源 Origin 精确回显（不是 *）',
      same.status === 200 && same.headers['access-control-allow-origin'] === backend.url,
      JSON.stringify({ status: same.status, acao: same.headers['access-control-allow-origin'] }),
    )

    const otherPort = await rawRequest(backend.url, '/api/health', { headers: { Origin: 'http://127.0.0.1:1' } })
    check('本机其它端口 Origin 默认不放行', otherPort.status === 403, JSON.stringify({ status: otherPort.status }))

    const preflightBad = await rawRequest(backend.url, '/api/config', {
      method: 'OPTIONS',
      headers: { Origin: 'http://evil.example', 'Access-Control-Request-Method': 'PUT' },
    })
    check('恶意 Origin 预检被拒绝', preflightBad.status === 403 && !preflightBad.headers['access-control-allow-origin'], JSON.stringify(preflightBad))

    const preflightOk = await rawRequest(backend.url, '/api/config', {
      method: 'OPTIONS',
      headers: { Origin: backend.url, 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'Content-Type, X-NianFeng-Token' },
    })
    check(
      '同源预检通过且允许自定义令牌头',
      preflightOk.status === 204 &&
        preflightOk.headers['access-control-allow-origin'] === backend.url &&
        String(preflightOk.headers['access-control-allow-headers']).toLowerCase().includes('x-nianfeng-token'),
      JSON.stringify(preflightOk.headers),
    )

    const hostGood = await rawRequest(backend.url, '/api/health', { headers: { Host: new URL(backend.url).host } })
    check('正常 Host 可访问', hostGood.status === 200, JSON.stringify({ status: hostGood.status }))

    const hostBad = await rawRequest(backend.url, '/api/health', { headers: { Host: 'evil.example' } })
    check('DNS rebinding 伪造 Host 被拒绝', hostBad.status === 403, JSON.stringify({ status: hostBad.status }))

    console.log('\n③ 令牌认证与 health 信息分层')
    const token = 'nf-sec-token'
    const secureBackend = await startBackend({
      port: 0,
      host: '127.0.0.1',
      dataDir: join(TEMP, 'data-b'),
      accessToken: token,
    })
    try {
      const unauth = await (await fetch(`${secureBackend.url}/api/health`)).json()
      check(
        '无令牌 health 只返回存活信息',
        unauth.ok === true && unauth.authRequired === true && unauth.authenticated === false && !unauth.dataDir && !unauth.configFile && !Array.isArray(unauth.providers),
        JSON.stringify(unauth),
      )
      check('无令牌 health 仍声明新防护能力', Array.isArray(unauth.capabilities) && unauth.capabilities.includes('ssrf-guard') && unauth.capabilities.includes('cors-origin-guard'), JSON.stringify(unauth.capabilities))

      const authRes = await fetch(`${secureBackend.url}/api/health`, { headers: { 'X-NianFeng-Token': token } })
      const authJson = await authRes.json()
      check(
        '请求头令牌可获得完整 health 详情',
        authRes.status === 200 && authJson.authenticated === true && authJson.dataDir === join(TEMP, 'data-b') && Array.isArray(authJson.providers),
        JSON.stringify({ status: authRes.status, authenticated: authJson.authenticated, dataDir: authJson.dataDir }),
      )

      const queryHealth = await (await fetch(`${secureBackend.url}/api/health?token=${encodeURIComponent(token)}`)).json()
      check('health 查询串令牌不再算认证', queryHealth.authenticated === false && !queryHealth.dataDir, JSON.stringify(queryHealth))

      const queryConfig = await fetch(`${secureBackend.url}/api/config?token=${encodeURIComponent(token)}`, { redirect: 'manual' })
      check('受保护 API 不接受 ?token= 查询串', queryConfig.status === 401, JSON.stringify({ status: queryConfig.status }))

      const bootstrap = await fetch(`${secureBackend.url}/?token=${encodeURIComponent(token)}`, {
        redirect: 'manual',
        headers: { Accept: 'text/html' },
      })
      const setCookie = String(bootstrap.headers.get('set-cookie') || '')
      const location = String(bootstrap.headers.get('location') || '')
      check(
        '首屏 ?token= 换取 HttpOnly Cookie 并跳转清理 URL',
        bootstrap.status === 302 && setCookie.includes('HttpOnly') && setCookie.includes('SameSite=Lax') && location === '/' && !location.includes('token'),
        JSON.stringify({ status: bootstrap.status, setCookie: setCookie.slice(0, 70), location }),
      )


      const bootstrapAgain = await fetch(secureBackend.url + '/?token=' + encodeURIComponent(token), {
        redirect: 'manual',
        headers: { Accept: 'text/html', Cookie: 'nianfeng_token=' + encodeURIComponent(token) },
      })
      check(
        '已有 Cookie 时再次带 ?token= 仍 302 清理地址栏',
        bootstrapAgain.status === 302 && String(bootstrapAgain.headers.get('location') || '') === '/',
        JSON.stringify({ status: bootstrapAgain.status, location: bootstrapAgain.headers.get('location') }),
      )

      const remoteHost = '110.42.14.109:12278'
      const remoteToken = await rawRequest(secureBackend.url, '/api/health', {
        headers: { Host: remoteHost, Origin: 'http://' + remoteHost, 'X-NianFeng-Token': token },
      })
      check(
        '携带有效令牌时远程 Host / Origin 可访问（公网部署回归）',
        remoteToken.status === 200,
        JSON.stringify({ status: remoteToken.status }),
      )
      const remoteNoToken = await rawRequest(secureBackend.url, '/api/health', {
        headers: { Host: remoteHost, Origin: 'http://' + remoteHost },
      })
      check(
        '无令牌的远程 Host / Origin 仍被拒绝（DNS rebinding 防护不回退）',
        remoteNoToken.status === 403,
        JSON.stringify({ status: remoteNoToken.status }),
      )


      console.log('\n④ /api/rss SSRF 拦截')
      const blocked = [
        'http://127.0.0.1:1/feed',
        'http://localhost:1/feed',
        'http://169.254.169.254/latest/meta-data/',
        'http://[::1]:1/feed',
        'file:///etc/passwd',
      ]
      for (const target of blocked) {
        const res = await fetch(`${secureBackend.url}/api/rss?url=${encodeURIComponent(target)}`, {
          headers: { 'X-NianFeng-Token': token },
        })
        const body = await res.json().catch(() => ({}))
        check(`SSRF 拦截 ${target}`, res.status === 400, JSON.stringify({ status: res.status, body }))
      }

      console.log('\n⑤ 常量时间令牌比较')
      check('相同令牌返回 true', timingSafeStringEqual(token, token) === true)
      check('不同长度令牌返回 false', timingSafeStringEqual(token, `${token}x`) === false)
      check('同长度不同内容返回 false', timingSafeStringEqual(token, token.replace(/.$/, 'x')) === false)

      console.log('\n⑤b 固定 DNS 请求客户端')
      const localFeed = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('PINNED-OK')
      })
      const localFeedPort = await listen(localFeed, 0)
      try {
        const pinned = await requestPinned(new URL(`http://127.0.0.1:${localFeedPort}/feed`), {
          addresses: [{ address: '127.0.0.1', family: 4 }],
          timeoutMs: 3000,
        })
        let pinnedText = ''
        for await (const chunk of pinned) pinnedText += chunk
        check('requestPinned 按已校验地址完成请求', pinned.statusCode === 200 && pinnedText === 'PINNED-OK', JSON.stringify({ status: pinned.statusCode, pinnedText }))
      } finally {
        await new Promise(resolve => localFeed.close(resolve))
      }
    } finally {
      await secureBackend.close()
    }

    console.log('\n⑥ SSE 长连接与关闭')
    const closeBackend = await startBackend({
      port: 0,
      host: '127.0.0.1',
      dataDir: join(TEMP, 'data-c'),
      accessToken: 'close-token',
    })
    const sse = await fetch(`${closeBackend.url}/api/events`, { headers: { 'X-NianFeng-Token': 'close-token' } })
    check('SSE 授权连接可建立', sse.status === 200 && String(sse.headers.get('content-type')).includes('text/event-stream'), JSON.stringify({ status: sse.status }))
    const startedClose = Date.now()
    await closeBackend.close()
    const closeMs = Date.now() - startedClose
    check('存在 SSE 时 close() 不再依赖 1.5s 兜底', closeMs < 1200, `close() 耗时 ${closeMs}ms`)

    console.log('\n⑦ 开发模式 WebUI 代理与 Origin 放行')
    const webPort = await freePort()
    const devBackend = await startBackend({
      port: 0,
      host: '127.0.0.1',
      dataDir: join(TEMP, 'data-dev'),
      accessToken: 'dev-token',
      allowedOrigins: webuiOriginList('127.0.0.1', webPort),
    })
    const web = createWebServer({ backendPort: devBackend.port, accessToken: 'dev-token' })
    await listen(web, webPort)
    try {
      const noToken = await fetch(`http://127.0.0.1:${webPort}/`, { redirect: 'manual' })
      check('WebUI 无令牌返回 401', noToken.status === 401, JSON.stringify({ status: noToken.status }))

      const bootstrap = await fetch(`http://127.0.0.1:${webPort}/?token=dev-token`, {
        redirect: 'manual',
        headers: { Accept: 'text/html' },
      })
      const cookie = String(bootstrap.headers.get('set-cookie') || '').split(';')[0]
      check('WebUI ?token= 换 Cookie 并清理 URL', bootstrap.status === 302 && cookie === 'nianfeng_token=dev-token' && bootstrap.headers.get('location') === '/', JSON.stringify({ status: bootstrap.status, cookie, location: bootstrap.headers.get('location') }))

      const home = await fetch(`http://127.0.0.1:${webPort}/`, { headers: { Cookie: cookie } })
      const homeHtml = await home.text()
      check('加固后 WebUI 正常首页仍可访问', home.status === 200 && homeHtml.includes('<title>念风chat</title>'), JSON.stringify({ status: home.status, length: homeHtml.length }))

      const health = await fetch(`http://127.0.0.1:${webPort}/api/health`, {
        headers: { Cookie: cookie, Origin: `http://127.0.0.1:${webPort}` },
      })
      const healthJson = await health.json()
      check(
        'WebUI 代理携带 Cookie 后 health 返回完整详情',
        health.status === 200 && healthJson.authenticated === true && !!healthJson.dataDir,
        JSON.stringify({ status: health.status, authenticated: healthJson.authenticated, acao: health.headers.get('access-control-allow-origin') }),
      )

      const put = await fetch(`http://127.0.0.1:${webPort}/api/config`, {
        method: 'PUT',
        headers: { Cookie: cookie, Origin: `http://127.0.0.1:${webPort}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ network: { timeoutMs: 12345 } }),
      })
      check('WebUI 代理的非简单请求通过 Origin 校验', put.status === 200, JSON.stringify({ status: put.status }))

      const evilPut = await fetch(`http://127.0.0.1:${webPort}/api/config`, {
        method: 'PUT',
        headers: { Cookie: cookie, Origin: 'http://evil.example', 'Content-Type': 'application/json' },
        body: JSON.stringify({ network: { timeoutMs: 54321 } }),
      })
      check('WebUI 代理不会替恶意 Origin 绕过校验', evilPut.status === 403, JSON.stringify({ status: evilPut.status }))

      const queryApi = await fetch(`http://127.0.0.1:${webPort}/api/config?token=dev-token`, { redirect: 'manual' })
      check('受保护 API 的查询串令牌在 WebUI 层也不放行', queryApi.status === 401, JSON.stringify({ status: queryApi.status }))

      const hostRebind = await rawRequest(`http://127.0.0.1:${webPort}`, '/', { headers: { Host: 'evil.example' } })
      check('WebUI 端口同样拒绝 DNS rebinding Host', hostRebind.status === 403, JSON.stringify({ status: hostRebind.status }))


      const remoteProxy = await rawRequest('http://127.0.0.1:' + webPort, '/api/health', {
        headers: { Host: '110.42.14.109:12278', Origin: 'http://110.42.14.109:12278', Cookie: cookie, Accept: 'application/json' },
      })
      let remoteProxyJson = {}
      try { remoteProxyJson = JSON.parse(remoteProxy.text || '{}') } catch (_) {}
      check(
        'WebUI 代理：远程 Host / Origin + Cookie 不再被后端 403',
        remoteProxy.status === 200 && remoteProxyJson.authenticated === true,
        JSON.stringify({ status: remoteProxy.status, text: String(remoteProxy.text || '').slice(0, 120) }),
      )
      const remoteProxyNoToken = await rawRequest('http://127.0.0.1:' + webPort, '/api/health', {
        headers: { Host: '110.42.14.109:12278', Origin: 'http://110.42.14.109:12278' },
      })
      check(
        'WebUI 代理：远程 Host / Origin 无令牌仍 403',
        remoteProxyNoToken.status === 403,
        JSON.stringify({ status: remoteProxyNoToken.status }),
      )


      const rootConfig = await rawRequest(`http://127.0.0.1:${webPort}`, '/user_data/config.json', { headers: { Cookie: cookie } })
      check('WebUI 静态服务不暴露 user_data 配置', rootConfig.status === 404, JSON.stringify({ status: rootConfig.status }))

      const rootGit = await rawRequest(`http://127.0.0.1:${webPort}`, '/.git/config', { headers: { Cookie: cookie } })
      check('WebUI 静态服务不暴露版本库目录', rootGit.status === 404, JSON.stringify({ status: rootGit.status }))
    } finally {
      await new Promise(resolve => {
        let done = false
        let timer = null
        const finish = () => {
          if (done) return
          done = true
          clearTimeout(timer)
          resolve()
        }
        web.close(() => finish())
        try {
          web.closeIdleConnections?.()
        } catch (_) {
          /* ignore */
        }
        timer = setTimeout(() => {
          try {
            web.closeAllConnections?.()
          } catch (_) {
            /* ignore */
          }
          finish()
        }, 250)
        timer.unref?.()
      })
      await devBackend.close()
    }

    console.log('\n⑧ 插件 zip 上传安装')
    const uploadJsonRequest = async payload => {
      const res = await fetch(backend.url + '/api/plugins/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = await res.json().catch(() => null)
      return { status: res.status, data }
    }
    const externalRoot = join(TEMP, 'data-a', 'plugins')
    const demoZip = makeZip([
      { name: 'demo-plugin/index.mjs', data: "export const name = 'demo-plugin'\nexport const version = '1.0.0'\nexport function apply() {}\n" },
      { name: 'demo-plugin/manifest.json', data: '{"id":"demo-plugin","name":"demo-plugin"}' },
    ])
    const install = await uploadJsonRequest({ filename: 'demo-plugin.zip', data: demoZip.toString('base64') })
    check('上传 zip 可安装外部插件', install.status === 200 && install.data?.installed?.[0]?.id === 'demo-plugin', JSON.stringify(install.data))
    const pluginsAfter = await (await fetch(backend.url + '/api/plugins')).json()
    check('安装后的插件出现在 /api/plugins', (pluginsAfter.plugins || []).some(item => item.id === 'demo-plugin' && item.external), JSON.stringify((pluginsAfter.plugins || []).map(item => item.id)))
    const installedFile = await readFile(join(externalRoot, 'demo-plugin', 'index.mjs'), 'utf8').catch(() => '')
    check('插件文件写入外部插件目录', installedFile.includes("name = 'demo-plugin'"), installedFile.slice(0, 60))

    const again = await uploadJsonRequest({ filename: 'demo-plugin.zip', data: demoZip.toString('base64') })
    check('同名插件默认拒绝覆盖（409）', again.status === 409, JSON.stringify(again.data))
    const overwrite = await uploadJsonRequest({ filename: 'demo-plugin.zip', data: demoZip.toString('base64'), overwrite: true })
    check('overwrite=true 时允许覆盖安装', overwrite.status === 200, JSON.stringify(overwrite.data))

    const escapeZip = makeZip([{ name: '../escaped.txt', data: 'ESCAPE-SECRET' }])
    const escape = await uploadJsonRequest({ filename: 'escape.zip', data: escapeZip.toString('base64') })
    check('zip-slip 路径被拒绝', escape.status === 400, JSON.stringify(escape.data))
    const escapedFile = await readFile(join(TEMP, 'escaped.txt'), 'utf8').catch(() => '')
    check('zip-slip 没有写出目标目录', !escapedFile.includes('ESCAPE-SECRET'), escapedFile)

    const blockedZip = makeZip([
      { name: 'demo-blocked/index.mjs', data: 'export const name = "demo-blocked"\nexport function apply() {}\n' },
      { name: 'demo-blocked/evil.exe', data: 'MZ' },
    ])
    const blockedInstall = await uploadJsonRequest({ filename: 'demo-blocked.zip', data: blockedZip.toString('base64') })
    const blockedFile = await readFile(join(externalRoot, 'demo-blocked', 'evil.exe')).catch(() => null)
    check('可执行文件被拒绝写入并报告', blockedInstall.status === 200 && Array.isArray(blockedInstall.data?.blocked) && blockedInstall.data.blocked.length === 1 && !blockedFile, JSON.stringify(blockedInstall.data))

    const noIndexZip = makeZip([{ name: 'readme.txt', data: 'nothing' }])
    const noIndex = await uploadJsonRequest({ filename: 'noindex.zip', data: noIndexZip.toString('base64') })
    check('没有 index.mjs 的压缩包被拒绝', noIndex.status === 400, JSON.stringify(noIndex.data))


  } finally {
    await backend.close().catch(() => {})
    await rm(TEMP, { recursive: true, force: true }).catch(() => {})
  }

  console.log(`\n结果：${results.length - failed}/${results.length} 项通过`)
  if (failed) process.exitCode = 1
}

main().catch(err => {
  console.error('\n安全测试失败：', err)
  process.exitCode = 1
})
