/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目：念风 Chat（NianFeng-Chat）
 *
 * 图片服务（前端）：
 *   - 消息里只保存 { id, mime, name, width, height, size }；
 *   - 图片原文件由后端 /api/images 保存与读取；
 *   - 模型上下文需要图片时，由 hydrate* 把 id 转成 data URL 放进内存缓存（不落聊天记录）。
 */
import { compressImageFile } from './compress.mjs'

export const name = 'image-service'
export const version = '1.0.0'
export const displayName = '图片服务'
export const description = '基础服务 · 图片文件存储（消息只存 imageId）、压缩与按需转 data URL。'
export const author = '念风内核'
export const icon = '🖼️'
export const core = false
export const depends = {}
export const optionalDepends = {
  'backend-client': '>=1.0.0',
  'session-service': '>=2.0.0',
  'toast-host': '>=1.0.0',
}
export const inject = ['api?', 'session-service?', 'toast?']
export const provides = [{ name: 'image-service', type: 'singleton' }]

const MAX_CACHE_BYTES = 20 * 1024 * 1024
const MAX_CACHE_ENTRIES = 48

const blobToDataUrl = blob =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(reader.error || new Error('读取图片失败'))
    reader.readAsDataURL(blob)
  })

export function apply(ctx) {
  const api = ctx.inject('api?')
  const sessions = ctx.inject('session-service?')

  /** imageId -> dataUrl；只存在内存，用于模型与本地预览。 */
  const cache = new Map()
  let cacheBytes = 0

  const tokenSuffix = () => {
    if (typeof location === 'undefined') return ''
    try {
      const token = new URLSearchParams(location.search).get('token')
      return token ? `?token=${encodeURIComponent(token)}` : ''
    } catch (_) {
      return ''
    }
  }

  const cacheSet = (id, dataUrl) => {
    if (!id || !dataUrl) return
    const previous = cache.get(id)
    if (previous) cacheBytes -= previous.length
    cache.delete(id)
    cache.set(id, dataUrl)
    cacheBytes += dataUrl.length
    while (cache.size > MAX_CACHE_ENTRIES || cacheBytes > MAX_CACHE_BYTES) {
      const oldestKey = cache.keys().next().value
      if (oldestKey === undefined) break
      const oldest = cache.get(oldestKey)
      cache.delete(oldestKey)
      cacheBytes -= oldest?.length || 0
    }
  }

  const urlOf = image => {
    if (!image) return ''
    if (image.dataUrl) return image.dataUrl
    if (image.url) return image.url
    if (image.id && api) return `${api.baseUrl()}/images/${encodeURIComponent(image.id)}${tokenSuffix()}`
    return ''
  }

  const dataUrlOf = image => (image?.dataUrl ? image.dataUrl : image?.id ? cache.get(image.id) || '' : '')

  const publicRecord = image => {
    if (!image) return null
    if (image.id || image.mime) {
      return {
        id: image.id || '',
        mime: image.mime || '',
        name: image.name || '',
        width: Number(image.width) || 0,
        height: Number(image.height) || 0,
        size: Number(image.size) || 0,
      }
    }
    return image
  }

  async function saveDataUrl(dataUrl, meta = {}) {
    const value = String(dataUrl || '')
    if (!/^data:image\//i.test(value)) throw new Error('不是图片数据')
    if (!api) return { dataUrl: value, mime: meta.mime || '', name: meta.name || '', width: meta.width || 0, height: meta.height || 0, size: meta.size || 0 }
    const result = await api.post('/images', {
      dataUrl: value,
      mime: meta.mime || '',
      name: meta.name || '',
      width: meta.width || 0,
      height: meta.height || 0,
    })
    const record = result?.image
    if (!record?.id) throw new Error(result?.error || '图片保存失败')
    cacheSet(record.id, value)
    return publicRecord(record)
  }

  /** 上传前压缩并保存，返回消息里要存的图片元信息。 */
  async function saveFile(file) {
    const compressed = await compressImageFile(file)
    return saveDataUrl(compressed.dataUrl, compressed)
  }

  async function hydrateImages(images = []) {
    const list = Array.isArray(images) ? images : []
    for (const image of list) {
      if (!image?.id || image.dataUrl || dataUrlOf(image)) continue
      const url = urlOf(image)
      if (!url) continue
      try {
        const response = await fetch(url, { credentials: 'same-origin' })
        if (!response.ok) continue
        const blob = await response.blob()
        cacheSet(image.id, await blobToDataUrl(blob))
      } catch (_) {
        /* 单张失败不影响这一轮上下文 */
      }
    }
  }

  /** 会话里是否存在“只有 imageId、还没进缓存”的图片（决定是否需要异步预加载）。 */
  function needsHydration(conversationId) {
    const conversation = sessions?.get?.(conversationId)
    if (!conversation) return false
    for (const message of conversation.messages || []) {
      for (const image of message.meta?.images || []) {
        if (image?.id && !image.dataUrl && !dataUrlOf(image)) return true
      }
    }
    return false
  }

  /** 把某个会话里所有 imageId 预加载到内存，供 context-builder 同步取用。 */
  async function hydrateConversation(conversationId) {
    const conversation = sessions?.get?.(conversationId)
    if (!conversation) return
    const images = []
    for (const message of conversation.messages || []) {
      if (Array.isArray(message.meta?.images)) images.push(...message.meta.images)
    }
    await hydrateImages(images)
  }

  async function prune(keep = 2000) {
    if (!api) return { ok: false }
    try {
      return await api.post('/images/prune', { keep })
    } catch (_) {
      return { ok: false }
    }
  }

  ctx.provide(
    'image-service',
    {
      name: 'image-service',
      urlOf,
      dataUrlOf,
      publicRecord,
      saveDataUrl,
      saveFile,
      hydrateImages,
      needsHydration,
      hydrateConversation,
      prune,
      cacheSize: () => cache.size,
    },
    { type: 'singleton' },
  )

  ctx.logger.debug('图片服务就绪（消息只存 imageId）')
}
