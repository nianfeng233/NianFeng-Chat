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

/** 把二进制转成 base64：浏览器用 btoa，服务端代聊的 Node 垫片回退 Buffer。 */
const bytesToBase64 = bytes => {
  if (typeof Buffer !== 'undefined' && typeof Buffer.from === 'function') {
    try {
      return Buffer.from(bytes).toString('base64')
    } catch (_) {
      /* 继续尝试浏览器方案 */
    }
  }
  let binary = ''
  const chunk = 0x8000
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(index, index + chunk))
  }
  if (typeof btoa === 'function') return btoa(binary)
  throw new Error('当前环境不支持 base64 转换')
}

/**
 * Blob -> data URL。
 * 浏览器有 FileReader；服务端常驻代聊（Node DOM 垫片）没有 FileReader，
 * 这里统一走 arrayBuffer fallback。NapCat / QQ / 微信入站图片只带 imageId，
 * 全部依赖这条 hydration 链路，因此不能再把 FileReader 当作唯一实现。
 */
const blobToDataUrl = (blob, fallbackMime = '') =>
  new Promise((resolve, reject) => {
    const fallback = async () => {
      if (typeof blob?.arrayBuffer !== 'function') throw new Error('图片对象不可读取')
      const buffer = await blob.arrayBuffer()
      const bytes = new Uint8Array(buffer)
      const mime = String(blob?.type || fallbackMime || 'image/jpeg').split(';')[0] || 'image/jpeg'
      resolve(`data:${mime};base64,${bytesToBase64(bytes)}`)
    }
    if (typeof FileReader === 'function') {
      try {
        const reader = new FileReader()
        reader.onload = () => {
          const result = String(reader.result || '')
          if (/^data:image\//i.test(result)) resolve(result)
          else fallback().catch(reject)
        }
        reader.onerror = () => fallback().catch(reject)
        reader.readAsDataURL(blob)
        return
      } catch (_) {
        /* FileReader 存在但不可用时继续走 fallback */
      }
    }
    fallback().catch(reject)
  })

export function apply(ctx) {
  const api = ctx.inject('api?')
  const sessions = ctx.inject('session-service?')

  /** imageId -> dataUrl；只存在内存，用于模型与本地预览。 */
  const cache = new Map()
  let cacheBytes = 0
  /** imageId -> 重试时间戳；图片被裁剪后避免每轮都重复请求 404。 */
  const missingImages = new Map()
  const MISSING_RETRY_MS = 5 * 60 * 1000

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
    missingImages.delete(id)
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
    if (missingImages.size > 1000) missingImages.clear()
    for (const image of list) {
      if (!image?.id || image.dataUrl || dataUrlOf(image)) continue
      const retryAt = Number(missingImages.get(image.id)) || 0
      if (retryAt > Date.now()) continue
      const url = urlOf(image)
      if (!url) continue
      try {
        // 与 backend-client 保持一致：远程 / 跨端口部署时 Cookie 令牌也要带上。
        const response = await fetch(url, { credentials: 'include' })
        if (!response.ok) {
            missingImages.set(image.id, Date.now() + MISSING_RETRY_MS)
            continue
          }
        const contentType = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
        // 受保护实例返回登录页 / 网关错误页时 content-type 不是图片，不能把 HTML 当图片塞给模型。
        if (contentType && !contentType.startsWith('image/')) {
            missingImages.set(image.id, Date.now() + MISSING_RETRY_MS)
            continue
          }
        const blob = await response.blob()
        cacheSet(image.id, await blobToDataUrl(blob, image.mime || contentType))
      } catch (err) {
        missingImages.set(image.id, Date.now() + MISSING_RETRY_MS)
          // 单张失败不影响这一轮上下文；记录一次方便排查远程 / 代聊环境的图片读取问题。
        try {
          ctx.logger?.debug?.(`[image-service] 图片 ${image.id} 预加载失败：${err?.message || err}`)
        } catch (_) {
          /* ignore */
        }
      }
    }
  }

  /** 一条消息直接/间接引用的图片：普通图片 + 合并转发预览里已自动附带的图片。 */
  const messageImageRefs = message => {
    const out = Array.isArray(message?.meta?.images) ? message.meta.images.filter(Boolean) : []
    if (Array.isArray(message?.meta?.quote?.images)) out.push(...message.meta.quote.images.filter(Boolean))
    const preview = Array.isArray(message?.meta?.forward?.preview) ? message.meta.forward.preview : []
    for (const item of preview) {
      if (Array.isArray(item?.preview_images)) out.push(...item.preview_images.filter(Boolean))
      if (Array.isArray(item?.images)) out.push(...item.images.filter(Boolean))
    }
    return out
  }

  /** 会话里是否存在“只有 imageId、还没进缓存”的图片（决定是否需要异步预加载）。 */
  function needsHydration(conversationId) {
    const conversation = sessions?.get?.(conversationId)
    if (!conversation) return false
    for (const message of conversation.messages || []) {
      for (const image of messageImageRefs(message)) {
        if (!image?.id || image.dataUrl || dataUrlOf(image)) continue
          const retryAt = Number(missingImages.get(image.id)) || 0
          if (retryAt > Date.now()) continue
          return true
      }
    }
    return false
  }

  /** 把某个会话里所有 imageId 预加载到内存，供 context-builder 同步取用。 */
  async function hydrateConversation(conversationId) {
    const conversation = sessions?.get?.(conversationId)
    if (!conversation) return
    const images = []
    for (const message of conversation.messages || []) images.push(...messageImageRefs(message))
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
