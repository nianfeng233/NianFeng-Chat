/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * 静态资源缓存回归：
 *   - ETag / Last-Modified -> 304，不再每次整包重下；
 *   - gzip 压缩（远程部署首屏关键）；
 *   - 带版本号的资源可以 immutable 强缓存。
 */
import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { serveStaticFile, isVersionedRequest, stripBuildPrefix } from '../server/static-cache.mjs'

const checks = []
const check = (name, ok, detail = '') => {
  checks.push({ name, ok: !!ok, detail })
  console.log(`${ok ? '  ✔' : '  ✗'} ${name}${!ok && detail ? `  → ${detail}` : ''}`)
}

const bodyText = `/* ${'念风静态缓存 '.repeat(200)} */\nconsole.log('cache-test')\n`

async function requestJson(port, path, headers = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers })
  const buffer = Buffer.from(await res.arrayBuffer())
  return { status: res.status, headers: res.headers, buffer }
}

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'nianfeng-static-'))
  const file = join(root, 'app.mjs')
  await writeFile(file, bodyText, 'utf8')
  const mime = { '.mjs': 'text/javascript; charset=utf-8' }

  const server = createServer((req, res) => {
    serveStaticFile(req, res, file, {
      mime,
      immutable: isVersionedRequest(req),
    }).then(served => {
      if (!served) {
        res.writeHead(404).end('not found')
      }
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port

  try {
    console.log('\n① 条件请求')
    const first = await requestJson(port, '/app.mjs')
    const etag = first.headers.get('etag')
    check('首次请求返回 200 + 完整内容', first.status === 200 && first.buffer.toString('utf8') === bodyText)
    check('响应带 ETag / Last-Modified / no-cache', !!etag && !!first.headers.get('last-modified') && /no-cache/.test(first.headers.get('cache-control') || ''))
    const second = await requestJson(port, '/app.mjs', { 'If-None-Match': etag })
    check('携带 If-None-Match 时返回 304 且无正文', second.status === 304 && second.buffer.length === 0)

    console.log('\n② gzip 压缩')
    const gz = await requestJson(port, '/app.mjs', { 'Accept-Encoding': 'gzip' })
    let decodedBuffer = gz.buffer
    if (gz.headers.get('content-encoding') === 'gzip') {
      try {
        decodedBuffer = gunzipSync(gz.buffer)
      } catch (_) {
        // Node 20+ 的 fetch 会自动解压，但请求仍带着 Content-Encoding: gzip；
        // 这种情况下 body 已经是原文，直接用即可。
      }
    }
    check('Accept-Encoding: gzip 时返回 Content-Encoding: gzip', gz.status === 200 && gz.headers.get('content-encoding') === 'gzip')
    check('压缩后内容可完整还原', decodedBuffer.toString('utf8') === bodyText)
    check('响应体积没有超过未压缩体积', gz.buffer.length <= Buffer.byteLength(bodyText))

    console.log('\n③ 版本化资源强缓存')
    const versioned = await requestJson(port, '/app.mjs?v=abc123')
    check('带 ?v= 的资源返回 immutable 强缓存', /immutable/.test(versioned.headers.get('cache-control') || ''), versioned.headers.get('cache-control') || '')
    check('isVersionedRequest 识别 ?v= / ?__nfv=', isVersionedRequest({ url: '/app.mjs?v=1' }) && isVersionedRequest({ url: '/app.mjs?__nfv=x' }))

    console.log('\n④ WebUI 构建前缀 / 外部插件版本路径')
    const parsed = stripBuildPrefix('/__nfv/2.2.1-abc123/src/main.mjs')
    check(
      'stripBuildPrefix 剥掉构建前缀并保留原始路径',
      parsed.versioned === true && parsed.build === '2.2.1-abc123' && parsed.pathname === '/src/main.mjs',
      JSON.stringify(parsed),
    )
    check(
      'stripBuildPrefix 不影响普通路径',
      stripBuildPrefix('/src/main.mjs').versioned === false && stripBuildPrefix('/src/main.mjs').pathname === '/src/main.mjs',
    )
    check(
      'isVersionedRequest 识别构建前缀 / 外部插件版本前缀',
      isVersionedRequest({ url: '/__nfv/build1/src/main.mjs' }) &&
        isVersionedRequest({ url: '/user-plugins/__nfv/rev1/github-hub/index.mjs' }),
    )
    const buildVersioned = await requestJson(port, '/__nfv/build1/app.mjs')
    check('构建前缀请求同样 immutable', /immutable/.test(buildVersioned.headers.get('cache-control') || ''), buildVersioned.headers.get('cache-control') || '')
  } finally {
    await new Promise(resolve => server.close(resolve))
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }

  const failed = checks.filter(item => !item.ok)
  console.log(`\n结果：${checks.length - failed.length}/${checks.length} 项通过`)
  if (failed.length) process.exit(1)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
