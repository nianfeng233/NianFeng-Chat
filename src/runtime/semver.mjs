/**
 * 极简 semver（与插件 depends 声明的写法对应）
 */
function parse(v) {
  const m = String(v ?? '')
    .trim()
    .replace(/^[v=\s]+/, '')
    .match(/^(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?(?:-([\w.-]+))?/)
  if (!m) return null
  return {
    major: Number(m[1]),
    minor: m[2] === undefined || m[2] === 'x' || m[2] === '*' ? null : Number(m[2]),
    patch: m[3] === undefined || m[3] === 'x' || m[3] === '*' ? null : Number(m[3]),
  }
}

function cmp(a, b) {
  if (a.major !== b.major) return a.major - b.major
  const am = a.minor ?? 0
  const bm = b.minor ?? 0
  if (am !== bm) return am - bm
  return (a.patch ?? 0) - (b.patch ?? 0)
}

export function satisfies(version, range) {
  const v = parse(version)
  if (!v) return false
  const r = String(range ?? '*').trim() || '*'
  if (r === '*' || r === 'x' || r === '') return true

  return r.split(/\s*\|\|\s*|\s*,\s*/).some(part => {
    part = part.trim()
    if (!part) return true

    const terms = part.split(/\s+/).filter(Boolean)
    if (terms.length > 1) return terms.every(t => satisfies(version, t))

    if (part.startsWith('^')) {
      const base = parse(part.slice(1))
      if (!base) return false
      if (cmp(v, base) < 0) return false
      if (base.major > 0) return v.major === base.major
      if (base.minor !== null && base.minor > 0) return v.major === 0 && v.minor === base.minor
      return v.major === 0 && v.minor === (base.minor ?? 0) && v.patch === (base.patch ?? 0)
    }
    if (part.startsWith('~')) {
      const base = parse(part.slice(1))
      if (!base) return false
      return cmp(v, base) >= 0 && v.major === base.major && (base.minor === null || v.minor === base.minor)
    }
    for (const [op, fn] of [
      ['>=', c => c >= 0],
      ['<=', c => c <= 0],
      ['>', c => c > 0],
      ['<', c => c < 0],
      ['=', c => c === 0],
    ]) {
      if (part.startsWith(op)) {
        const base = parse(part.slice(op.length))
        return base ? fn(cmp(v, base)) : false
      }
    }
    const base = parse(part)
    if (!base) return false
    if (base.minor === null) return v.major === base.major
    if (base.patch === null) return v.major === base.major && v.minor === base.minor
    return cmp(v, base) === 0
  })
}
