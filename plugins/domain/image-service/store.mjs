/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目：念风 Chat（NianFeng-Chat）
 *
 * 图片文件存储（纯 Node 模块，可被其它后端 bridge 直接 import）：
 *   <数据目录>/images/<id>.<ext>   图片原文件
 *   <数据目录>/images.json         索引（无 base64，只有元信息）
 *
 * 前端插件与 /api/images 路由在 index.mjs / bridge.mjs，这里只负责落盘、读取与裁剪。
 */
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024
export const IMAGE_INDEX_FILE = 'images.json'
/** 本地图片文件保留数量：超过后按最旧优先删除，避免硬盘无限增长。 */
export const DEFAULT_IMAGE_KEEP = 30

const INDEX_VERSION = 1
const queues = new Map()
const cache = new Map()

const trimSlash = value => String(value || '').replace(/[/\\]+$/, '')
const imagesDir = dataDir => join(trimSlash(dataDir) || '.', 'images')
const indexPath = dataDir => join(trimSlash(dataDir) || '.', IMAGE_INDEX_FILE)

const withQueue = (key, fn) => {
  const previous = queues.get(key) || Promise.resolve()
  const run = previous.catch(() => {}).then(fn)
  queues.set(key, run.catch(() => {}))
  return run
}

function stateFor(dataDir) {
  const key = trimSlash(dataDir) || '.'
  let state = cache.get(key)
  if (!state) {
    state = { records: {}, loaded: false, loading: null }
    cache.set(key, state)
  }
  return state
}

function detectMime(buffer) {
  if (!buffer || buffer.length < 4) return ''
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg'
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png'
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) return 'image/gif'
  if (buffer[0] === 0x42 && buffer[1] === 0x4d) return 'image/bmp'
  if (buffer.length > 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  if (buffer.length > 12 && buffer.toString('ascii', 4, 8) === 'ftyp' && /avif/i.test(buffer.toString('ascii', 8, 12))) return 'image/avif'
  return ''
}

const normalizeMime = (mime, buffer) => {
  const value = String(mime || '').toLowerCase().split(';')[0].trim()
  if (value.startsWith('image/')) return value
  return detectMime(buffer) || 'image/jpeg'
}

const extFromMime = mime => {
  const value = String(mime || '').toLowerCase()
  if (value.includes('png')) return 'png'
  if (value.includes('gif')) return 'gif'
  if (value.includes('webp')) return 'webp'
  if (value.includes('bmp')) return 'bmp'
  if (value.includes('avif')) return 'avif'
  if (value.includes('svg')) return 'svg'
  return 'jpg'
}

async function loadIndexLocked(dataDir) {
  const state = stateFor(dataDir)
  if (state.loaded) return state.records
  if (state.loading) {
    await state.loading
    return state.records
  }
  state.loading = (async () => {
    try {
      const raw = await readFile(indexPath(dataDir), 'utf8')
      const parsed = JSON.parse(raw)
      state.records = parsed && typeof parsed === 'object' && parsed.images && typeof parsed.images === 'object' ? parsed.images : {}
    } catch (_) {
      state.records = {}
    }
    state.loaded = true
  })()
  await state.loading
  state.loading = null
  return state.records
}

async function persistIndex(dataDir, records) {
  await mkdir(trimSlash(dataDir) || '.', { recursive: true })
  const payload = JSON.stringify({ version: INDEX_VERSION, images: records }, null, 2)
  const tmp = `${indexPath(dataDir)}.${process.pid}.tmp`
  await writeFile(tmp, payload, 'utf8')
  await rename(tmp, indexPath(dataDir))
}

export function imagePublicRecord(record) {
  if (!record) return null
  return {
    id: record.id,
    mime: record.mime,
    name: record.name || '',
    width: Number(record.width) || 0,
    height: Number(record.height) || 0,
    size: Number(record.size) || 0,
    createdAt: Number(record.createdAt) || 0,
  }
}

/** 保存一张图片，返回 { id, file, mime, size, ... }；同一 id 会覆盖旧文件。 */
export async function saveImageBuffer(dataDir, buffer, meta = {}, options = {}) {
  if (!buffer?.length) throw Object.assign(new Error('图片内容为空'), { status: 400 })
  if (buffer.length > MAX_IMAGE_BYTES) throw Object.assign(new Error(`图片超过 ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)}MB 限制`), { status: 413 })
  const key = trimSlash(dataDir) || '.'
  return withQueue(key, async () => {
    const records = await loadIndexLocked(dataDir)
    const id = String(meta.id || '').trim() || `img_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`
    const mime = normalizeMime(meta.mime, buffer)
    const file = `${id}.${extFromMime(mime)}`
    await mkdir(imagesDir(dataDir), { recursive: true })
    const tmp = join(imagesDir(dataDir), `${file}.${process.pid}.tmp`)
    await writeFile(tmp, buffer)
    await rename(tmp, join(imagesDir(dataDir), file))
    const record = {
      id,
      file,
      mime,
      size: buffer.length,
      name: String(meta.name || '').slice(0, 120),
      width: Number(meta.width) || 0,
      height: Number(meta.height) || 0,
      createdAt: Date.now(),
    }
    records[id] = record
    // 自动裁剪：默认只保留最近 DEFAULT_IMAGE_KEEP 张，旧文件同步删掉，避免硬盘无限增长。
    const configuredKeep = Number(options.keep ?? process.env.NIANFENG_IMAGE_KEEP)
    const keep = Math.max(1, Math.min(5000, Number.isFinite(configuredKeep) && configuredKeep > 0 ? configuredKeep : DEFAULT_IMAGE_KEEP))
    const all = Object.values(records).sort((a, b) => (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0))
    if (all.length > keep) {
      for (const stale of all.slice(0, all.length - keep)) {
        delete records[stale.id]
        try {
          await unlink(join(imagesDir(dataDir), stale.file))
        } catch (_) {
          /* 文件已不存在时以索引为准 */
        }
      }
    }
    await persistIndex(dataDir, records)
    return record
  })
}

export async function getImageRecord(dataDir, id) {
  const key = String(id || '').trim()
  if (!key) return null
  const records = await loadIndexLocked(dataDir)
  return records[key] || null
}

export async function readImageBuffer(dataDir, id) {
  const record = await getImageRecord(dataDir, id)
  if (!record?.file) return null
  try {
    return { record, buffer: await readFile(join(imagesDir(dataDir), record.file)) }
  } catch (_) {
    return null
  }
}

/** 删除一张图片（索引 + 文件）。 */
export async function removeImage(dataDir, id) {
  const key = trimSlash(dataDir) || '.'
  return withQueue(key, async () => {
    const records = await loadIndexLocked(dataDir)
    const record = records[String(id || '').trim()]
    if (!record) return false
    delete records[record.id]
    try {
      await unlink(join(imagesDir(dataDir), record.file))
    } catch (_) {
      /* 文件不存在也算删除成功 */
    }
    await persistIndex(dataDir, records)
    return true
  })
}

/** 裁剪：超过 keep 条时删除最旧的图片，避免无限增长。 */
export async function pruneImages(dataDir, { keep = 2000 } = {}) {
  const key = trimSlash(dataDir) || '.'
  return withQueue(key, async () => {
    const records = await loadIndexLocked(dataDir)
    const list = Object.values(records).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
    if (list.length <= keep) return { removed: 0, total: list.length }
    const removed = list.slice(0, list.length - keep)
    for (const record of removed) {
      delete records[record.id]
      try {
        await unlink(join(imagesDir(dataDir), record.file))
      } catch (_) {
        /* ignore */
      }
    }
    await persistIndex(dataDir, records)
    return { removed: removed.length, total: Object.keys(records).length }
  })
}
