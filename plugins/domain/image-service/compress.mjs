/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 浏览器端图片压缩：上传前把大图压到目标体积，降低存储与上下文压力。
 */

const readAsDataUrl = file =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(reader.error || new Error('读取图片失败'))
    reader.readAsDataURL(file)
  })

const loadImage = raw =>
  new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('图片解码失败'))
    image.src = raw
  })

export async function compressImageFile(file, { maxSide = 1280, targetBytes = 720 * 1024 } = {}) {
  if (!file) throw new Error('缺少图片文件')
  const raw = await readAsDataUrl(file)
  if (!/^data:image\//i.test(raw)) throw new Error('不是图片文件')
  if (Number(file.size) > 0 && Number(file.size) <= 480 * 1024) {
    return { dataUrl: raw, mime: file.type || 'image/jpeg', name: String(file.name || ''), size: Number(file.size) }
  }
  const image = await loadImage(raw)
  const width0 = image.naturalWidth || image.width || 1
  const height0 = image.naturalHeight || image.height || 1
  const scale = Math.min(1, maxSide / Math.max(width0, height0))
  const width = Math.max(1, Math.round(width0 * scale))
  const height = Math.max(1, Math.round(height0 * scale))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('当前环境不支持图片压缩')
  context.drawImage(image, 0, 0, width, height)
  let quality = 0.84
  let dataUrl = canvas.toDataURL('image/jpeg', quality)
  while (dataUrl.length > targetBytes && quality > 0.42) {
    quality -= 0.12
    dataUrl = canvas.toDataURL('image/jpeg', quality)
  }
  return {
    dataUrl,
    mime: 'image/jpeg',
    name: String(file.name || ''),
    width,
    height,
    size: Math.round((dataUrl.length - String(dataUrl).indexOf(',') - 1) * 0.75),
  }
}

export function dataUrlToBlob(dataUrl) {
  const match = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/.exec(String(dataUrl || ''))
  if (!match) return null
  const mime = match[1] || 'image/jpeg'
  const binary = match[2] ? atob(match[3]) : decodeURIComponent(match[3])
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return new Blob([bytes], { type: mime })
}
