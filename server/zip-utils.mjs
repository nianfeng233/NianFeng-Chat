/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * 后端 · zip 解析工具（无第三方依赖）
 *
 * 用途：把用户在浏览器里选择的插件 zip 上传到后端后，在服务器上安全解压。
 * 只支持 store(0) / deflate(8)，拒绝加密包、ZIP64 大包、符号链接与危险路径，
 * 并限制条目数 / 单文件大小 / 解压总大小，避免 zip bomb 与路径穿越。
 */
import { inflateRawSync } from 'node:zlib'

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50

export const ZIP_LIMITS = {
  maxEntries: 512,
  maxFileBytes: 8 * 1024 * 1024,
  maxTotalBytes: 32 * 1024 * 1024,
}

export class ZipError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.name = 'ZipError'
    this.status = status
  }
}

function findEocd(buffer) {
  const min = Math.max(0, buffer.length - 0xffff - 22)
  for (let index = buffer.length - 22; index >= min; index--) {
    if (buffer.readUInt32LE(index) === EOCD_SIGNATURE) return index
  }
  return -1
}

/** zip 条目名安全校验：拒绝绝对路径、盘符、`..`、NUL 与空的危险名。 */
export function isSafeZipEntryName(name) {
  const text = String(name ?? '')
  if (!text || text.includes('\0')) return false
  const normalized = text.replace(/\\/g, '/')
  if (normalized.startsWith('/')) return false
  if (/^[a-zA-Z]:/.test(normalized)) return false
  const parts = normalized.split('/')
  if (parts.some(part => part === '..')) return false
  return true
}

function normalizeEntryName(name) {
  return String(name ?? '')
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/\/+/g, '/')
}

function isSymlinkEntry(externalAttr) {
  const unixMode = (externalAttr >>> 16) & 0xffff
  return unixMode && (unixMode & 0xf000) === 0xa000
}

/**
 * 解析 zip 并返回全部文件条目（目录条目会被忽略，但保留在返回中便于判断结构）。
 * 抛出的 ZipError 带 status=400/413，路由层可以直接转成 JSON 错误。
 */
export function listZipEntries(buffer, options = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) throw new ZipError('不是有效的 zip 文件')
  const limits = { ...ZIP_LIMITS, ...options }
  const eocd = findEocd(buffer)
  if (eocd < 0) throw new ZipError('没有找到 zip 结束记录')
  const entryCount = buffer.readUInt16LE(eocd + 10)
  const centralOffset = buffer.readUInt32LE(eocd + 16)
  if (entryCount === 0xffff || centralOffset === 0xffffffff) throw new ZipError('暂不支持 ZIP64 超大压缩包')
  if (entryCount > limits.maxEntries) throw new ZipError(`压缩包条目过多（${entryCount} > ${limits.maxEntries}）`)

  const entries = []
  let offset = centralOffset
  let totalBytes = 0

  for (let index = 0; index < entryCount; index++) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
      throw new ZipError('zip 中央目录损坏')
    }
    const flags = buffer.readUInt16LE(offset + 8)
    const method = buffer.readUInt16LE(offset + 10)
    let compressedSize = buffer.readUInt32LE(offset + 20)
    let uncompressedSize = buffer.readUInt32LE(offset + 24)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const externalAttr = buffer.readUInt32LE(offset + 38)
    let localOffset = buffer.readUInt32LE(offset + 42)
    const nameStart = offset + 46
    if (nameStart + nameLength > buffer.length) throw new ZipError('zip 条目名越界')
    const name = normalizeEntryName(buffer.subarray(nameStart, nameStart + nameLength).toString('utf8'))

    // Zip64 扩展字段：只解析大小 / 偏移，仍拒绝真正的 Zip64 EOCD。
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) {
      const extraStart = nameStart + nameLength
      const extraEnd = Math.min(extraStart + extraLength, buffer.length)
      let pos = extraStart
      while (pos + 4 <= extraEnd) {
        const headerId = buffer.readUInt16LE(pos)
        const dataSize = buffer.readUInt16LE(pos + 2)
        if (headerId === 0x0001) {
          let cursor = pos + 4
          if (uncompressedSize === 0xffffffff && cursor + 8 <= pos + 4 + dataSize) {
            uncompressedSize = Number(buffer.readBigUInt64LE(cursor))
            cursor += 8
          }
          if (compressedSize === 0xffffffff && cursor + 8 <= pos + 4 + dataSize) {
            compressedSize = Number(buffer.readBigUInt64LE(cursor))
            cursor += 8
          }
          if (localOffset === 0xffffffff && cursor + 8 <= pos + 4 + dataSize) {
            localOffset = Number(buffer.readBigUInt64LE(cursor))
          }
        }
        pos += 4 + dataSize
      }
    }

    if (flags & 0x1) throw new ZipError(`压缩包包含加密条目，无法安装：${name}`)
    if (method !== 0 && method !== 8) throw new ZipError(`不支持的压缩方式（method=${method}）：${name}`)
    if (!isSafeZipEntryName(name)) throw new ZipError(`压缩包包含不安全路径：${name}`)
    if (isSymlinkEntry(externalAttr)) throw new ZipError(`压缩包包含符号链接，已拒绝：${name}`)

    const isDirectory = /\/$/.test(name) || (uncompressedSize === 0 && compressedSize === 0 && /[\\/]$/.test(name))
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) {
      throw new ZipError(`zip 条目数据损坏：${name}`)
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26)
    const localExtraLength = buffer.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const dataEnd = dataStart + compressedSize
    if (dataEnd > buffer.length) throw new ZipError(`zip 条目数据不完整：${name}`)
    if (compressedSize > limits.maxFileBytes * 4 || uncompressedSize > limits.maxFileBytes) {
      throw new ZipError(`压缩包内文件过大：${name}`, 413)
    }

    let data = Buffer.alloc(0)
    if (!isDirectory) {
      const raw = buffer.subarray(dataStart, dataEnd)
      if (method === 0) {
        data = Buffer.from(raw)
      } else {
        try {
          data = inflateRawSync(raw, { maxOutputLength: limits.maxFileBytes })
        } catch (err) {
          throw new ZipError(`解压失败：${name}（${err?.message || err}）`)
        }
      }
      if (data.length !== uncompressedSize) throw new ZipError(`解压后大小不一致：${name}`)
    }

    totalBytes += data.length
    if (totalBytes > limits.maxTotalBytes) throw new ZipError('压缩包解压后总大小超过限制', 413)
    entries.push({ name, directory: isDirectory, data })
    offset = nameStart + nameLength + extraLength + commentLength
  }

  return entries
}

/** 供测试 / 调用方复用：把 zip 条目数据解出来（listZipEntries 已返回 data）。 */
export const readZipEntries = listZipEntries
