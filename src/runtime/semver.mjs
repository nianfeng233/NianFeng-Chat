/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * 极简 semver（与插件 depends / optionalDepends 声明对应）
 *
 * 支持写法：
 *   * / x / latest / 空字符串          任意版本（无所谓哪个版本）
 *   1.2.3 / =1.2.3                     精确锁定某个版本（硬限制）
 *   >=1.2.0 / >1.2 / <=1.2 / <1.2      比较范围
 *   ^1.2.3 / ~1.2.3                    npm 风格兼容范围
 *   1 / 1.2 / 1.2.x                    主版本 / 次版本前缀
 *   1.2.3 - 2.3.4                      连字符范围
 *   >=1 <2 || >=3                      || 为或，空格 / 逗号为且
 */
const ANY_TOKENS = new Set(['', '*', 'x', 'X', 'latest', 'any'])
const OPERATORS = ['>=', '<=', '!=', '==', '=', '>', '<', '^', '~']

function wildcard(value) {
  return value === undefined || value === null || value === '' || value === 'x' || value === 'X' || value === '*'
}

function normalizeVersion(value) {
  let text = String(value ?? '').trim()
  if (!text) return ''
  text = text.replace(/^[v=\s]+/i, '')
  const buildIndex = text.indexOf('+')
  return buildIndex >= 0 ? text.slice(0, buildIndex) : text
}

export function parseVersion(value) {
  const text = normalizeVersion(value)
  if (!text || ANY_TOKENS.has(text)) return null
  const match = text.match(/^(\d+)(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z.-]+))?$/)
  if (!match) return null
  const part = raw => (wildcard(raw) ? null : Number(raw))
  return {
    major: Number(match[1]),
    minor: part(match[2]),
    patch: part(match[3]),
    prerelease: match[4] ? match[4].split('.').filter(Boolean) : [],
  }
}

function comparePrerelease(a, b) {
  if (!a.length && !b.length) return 0
  if (!a.length) return 1
  if (!b.length) return -1
  const size = Math.max(a.length, b.length)
  for (let index = 0; index < size; index++) {
    const left = a[index]
    const right = b[index]
    if (left === undefined) return -1
    if (right === undefined) return 1
    const leftNumber = /^\d+$/.test(left) ? Number(left) : null
    const rightNumber = /^\d+$/.test(right) ? Number(right) : null
    if (leftNumber !== null && rightNumber !== null) {
      if (leftNumber !== rightNumber) return leftNumber - rightNumber
    } else if (leftNumber !== null) {
      return -1
    } else if (rightNumber !== null) {
      return 1
    } else if (left !== right) {
      return left < right ? -1 : 1
    }
  }
  return 0
}

function compareParsed(a, b) {
  if (a.major !== b.major) return a.major - b.major
  const aMinor = a.minor ?? 0
  const bMinor = b.minor ?? 0
  if (aMinor !== bMinor) return aMinor - bMinor
  const aPatch = a.patch ?? 0
  const bPatch = b.patch ?? 0
  if (aPatch !== bPatch) return aPatch - bPatch
  return comparePrerelease(a.prerelease, b.prerelease)
}

export function compareVersions(left, right) {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (!a || !b) return NaN
  return compareParsed(a, b)
}

function prefixEqual(version, base) {
  if (version.major !== base.major) return false
  if (base.minor === null) return true
  if (version.minor !== base.minor) return false
  if (base.patch === null) return true
  if (version.patch !== base.patch) return false
  return comparePrerelease(version.prerelease, base.prerelease) === 0
}

function matchCaret(version, base) {
  if (compareParsed(version, base) < 0) return false
  if (base.major > 0) return version.major === base.major
  if (base.minor === null) return version.major === 0
  if (base.minor > 0) return version.major === 0 && version.minor === base.minor
  if (base.patch === null) return version.major === 0 && version.minor === 0
  return version.major === 0 && version.minor === 0 && version.patch === base.patch
}

function matchTilde(version, base) {
  if (compareParsed(version, base) < 0) return false
  if (base.minor === null) return version.major === base.major
  if (base.patch === null) return version.major === base.major && version.minor === base.minor
  return version.major === base.major && version.minor === base.minor
}

function matchGreater(version, base) {
  if (base.minor === null) return version.major > base.major
  if (base.patch === null) {
    return version.major > base.major || (version.major === base.major && (version.minor ?? 0) > base.minor)
  }
  return compareParsed(version, base) > 0
}

function matchGreaterEqual(version, base) {
  return compareParsed(version, base) >= 0
}

function matchLess(version, base) {
  if (base.minor === null) return version.major < base.major
  if (base.patch === null) {
    return version.major < base.major || (version.major === base.major && (version.minor ?? 0) < base.minor)
  }
  return compareParsed(version, base) < 0
}

function matchLessEqual(version, base) {
  if (base.minor === null) return version.major <= base.major
  if (base.patch === null) {
    return version.major < base.major || (version.major === base.major && (version.minor ?? 0) <= base.minor)
  }
  return compareParsed(version, base) <= 0
}

function matchTerm(version, rawTerm) {
  const term = String(rawTerm ?? '').trim()
  if (ANY_TOKENS.has(term)) return true
  const operator = OPERATORS.find(item => term.startsWith(item)) || ''
  const body = operator ? term.slice(operator.length).trim() : term
  const base = parseVersion(body)
  if (!base) return false
  if (!operator) return prefixEqual(version, base)
  switch (operator) {
    case '=':
    case '==':
      return prefixEqual(version, base)
    case '!=':
      return !prefixEqual(version, base)
    case '>':
      return matchGreater(version, base)
    case '>=':
      return matchGreaterEqual(version, base)
    case '<':
      return matchLess(version, base)
    case '<=':
      return matchLessEqual(version, base)
    case '^':
      return matchCaret(version, base)
    case '~':
      return matchTilde(version, base)
    default:
      return false
  }
}

function normalizeGroup(group) {
  return String(group ?? '').replace(/([<>=~^!]+)\s+/g, '$1').trim()
}

function splitTerms(group) {
  return normalizeGroup(group).split(/\s*,\s*|\s+/).filter(Boolean)
}

function matchHyphen(version, group) {
  const match = normalizeGroup(group).match(/^(\S+)\s+-\s+(\S+)$/)
  if (!match) return null
  return matchTerm(version, `>=${match[1]}`) && matchTerm(version, `<=${match[2]}`)
}

export function satisfies(version, range) {
  const parsed = parseVersion(version)
  if (!parsed) return false
  const text = String(range ?? '*').trim()
  if (!text || ANY_TOKENS.has(text)) return true
  return text.split('||').some(group => {
    const part = normalizeGroup(group)
    if (!part) return false
    const hyphen = matchHyphen(parsed, part)
    if (hyphen !== null) return hyphen
    return splitTerms(part).every(term => matchTerm(parsed, term))
  })
}

function isValidTerm(term) {
  const text = String(term ?? '').trim()
  if (ANY_TOKENS.has(text)) return true
  const operator = OPERATORS.find(item => text.startsWith(item)) || ''
  const body = operator ? text.slice(operator.length).trim() : text
  return !!parseVersion(body)
}

export function isValidRange(range) {
  const text = String(range ?? '*').trim()
  if (!text || ANY_TOKENS.has(text)) return true
  return text.split('||').every(group => {
    const part = normalizeGroup(group)
    if (!part) return false
    const hyphen = part.match(/^(\S+)\s+-\s+(\S+)$/)
    if (hyphen) return isValidTerm(`>=${hyphen[1]}`) && isValidTerm(`<=${hyphen[2]}`)
    return splitTerms(part).every(isValidTerm)
  })
}