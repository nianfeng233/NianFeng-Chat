/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目：念风 Chat（NianFeng-Chat）
 *
 * Clawbot 登录二维码渲染：使用内置的 QRCode for JavaScript（MIT）生成 SVG，
 * 不依赖任何在线二维码服务，离线环境也能正常显示登录二维码。
 */
import QRCode from './QRCode.mjs'
import QRErrorCorrectLevel from './QRErrorCorrectLevel.mjs'

const LEVELS = { L: QRErrorCorrectLevel.L, M: QRErrorCorrectLevel.M, Q: QRErrorCorrectLevel.Q, H: QRErrorCorrectLevel.H }

/** 微信返回的 qrcode_img_content 有时本身就是 data URL / 图片地址 / 裸 base64 图片。 */
export function isQrImageContent(value) {
  const text = String(value || '').trim()
  if (!text) return false
  if (/^data:image\//i.test(text)) return true
  if (/^https?:\/\//i.test(text) && /\.(png|jpe?g|gif|webp|bmp|avif)(\?|#|$)/i.test(text)) return true
  const compact = text.replace(/\s+/g, '')
  return compact.length > 80 && /^[A-Za-z0-9+/]+={0,2}$/.test(compact) && /^(iVBORw0KGgo|\/9j\/|R0lGOD|UklGR)/.test(compact)
}

/** 渲染二维码为 SVG 字符串；内容为空时返回空串。 */
export function renderQrSvg(content, { size = 260, margin = 4, ecl = 'M', dark = '#101418', light = '#ffffff' } = {}) {
  const text = String(content || '').trim()
  if (!text) return ''
  const qr = new QRCode(-1, LEVELS[ecl] ?? QRErrorCorrectLevel.M)
  qr.addData(text)
  qr.make()
  const count = qr.getModuleCount()
  const span = size / (count + margin * 2)
  const cells = []
  for (let row = 0; row < count; row += 1) {
    let start = -1
    for (let col = 0; col <= count; col += 1) {
      const darkCell = col < count && qr.isDark(row, col)
      if (darkCell && start < 0) start = col
      if (!darkCell && start >= 0) {
        cells.push(`<rect x="${(start + margin) * span}" y="${(row + margin) * span}" width="${(col - start) * span}" height="${span}" fill="${dark}"/>`)
        start = -1
      }
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="登录二维码"><rect width="${size}" height="${size}" fill="${light}"/>${cells.join('')}</svg>`
}
