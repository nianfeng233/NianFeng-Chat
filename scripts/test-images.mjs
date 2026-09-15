/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目：念风 Chat（NianFeng-Chat）
 *
 * 图片文件服务测试：POST /api/images 保存 -> GET /api/images/:id 读取 ->
 * 索引中不出现 base64 -> 裁剪接口生效。
 */
import { readdir, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const dataDir = join(ROOT, '.tmp', `image-service-test-${Date.now()}`)
const PNG_1PX =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lK3Q6wAAAABJRU5ErkJggg=='
let failed = 0
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  if (!ok) failed++
  console.log(`${ok ? '  ✔' : '  ✗'} ${name}${ok ? '' : '  → ' + detail}`)
}
const api = (base, path, options = {}) =>
  fetch(`${base}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    body: options.body ? JSON.stringify(options.body) : undefined,
  })

async function main() {
  console.log('\n① 启动后端（加载 image-service bridge）')
  const { startBackend } = await import('../server/index.mjs')
  const backend = await startBackend({ port: 0, host: '127.0.0.1', dataDir })
  const base = backend.url
  check('后端已启动', backend.port > 0, base)

  try {
    console.log('\n② 保存 / 读取图片')
    const first = await (await api(base, '/api/images', { method: 'POST', body: { dataUrl: PNG_1PX, name: 'pixel.png' } })).json()
    check('POST /api/images 返回 imageId', first.ok === true && !!first.image?.id && first.image.mime === 'image/png', JSON.stringify(first))
    const imageId = first.image?.id
    const fileStat = await stat(join(dataDir, 'images', `${imageId}.png`))
    check('图片原文件已落盘', fileStat.size > 0, `${fileStat.size} bytes`)
    const fetched = await fetch(`${base}/api/images/${imageId}`)
    const bytes = Buffer.from(await fetched.arrayBuffer())
    check(
      'GET /api/images/:id 返回图片字节与类型',
      fetched.status === 200 && fetched.headers.get('content-type') === 'image/png' && bytes[0] === 0x89 && bytes[1] === 0x50,
      `${fetched.status} ${fetched.headers.get('content-type')} ${bytes.length}B`,
    )
    const indexRaw = await readFile(join(dataDir, 'images.json'), 'utf8')
    check('索引文件不包含 base64 原文', !indexRaw.includes(PNG_1PX) && !indexRaw.includes(PNG_1PX.split(',')[1].slice(0, 80)), indexRaw.slice(0, 200))

    console.log('\n③ 校验与裁剪')
    const invalid = await api(base, '/api/images', { method: 'POST', body: { dataUrl: 'data:text/plain;base64,aGVsbG8=' } })
    check('非图片 dataUrl 被拒绝', invalid.status >= 400, String(invalid.status))
    for (let index = 0; index < 2; index++) {
      await api(base, '/api/images', { method: 'POST', body: { dataUrl: PNG_1PX, name: `extra-${index}.png` } })
    }
    const pruned = await (await api(base, '/api/images/prune', { method: 'POST', body: { keep: 1 } })).json()
    check('裁剪接口删除旧图片', pruned.ok === true && pruned.removed >= 2 && pruned.total === 1, JSON.stringify(pruned))
    const missing = await fetch(`${base}/api/images/${imageId}`)
    check('被裁剪的图片 404', missing.status === 404, String(missing.status))

    console.log('\n④ 本地图片自动裁剪')
    for (let index = 0; index < 35; index++) {
      await api(base, '/api/images', { method: 'POST', body: { dataUrl: PNG_1PX, name: `auto-${index}.png` } })
    }
    const autoIndex = JSON.parse(await readFile(join(dataDir, 'images.json'), 'utf8'))
    const autoFiles = (await readdir(join(dataDir, 'images'))).filter(name => !name.endsWith('.tmp'))
    check(
      '超过 30 张后自动删除最旧图片（索引与磁盘文件一致）',
      Object.keys(autoIndex.images || {}).length === 30 && autoFiles.length === 30,
      JSON.stringify({ indexed: Object.keys(autoIndex.images || {}).length, files: autoFiles.length }),
    )

  } finally {
    await backend.close().catch(() => {})
    await new Promise(resolve => setTimeout(resolve, 60))
    await rm(dataDir, { recursive: true, force: true }).catch(() => {})
  }

  console.log(`\n${failed ? `✗ ${failed}/${results.length} 项失败` : `✔ 图片服务测试全部通过（${results.length}/${results.length}）`}`)
  process.exit(failed ? 1 : 0)
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
