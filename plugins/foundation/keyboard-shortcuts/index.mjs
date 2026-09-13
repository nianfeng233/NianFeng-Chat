/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * F11 · keyboard-shortcuts
 * 快捷键注册与分发。其他插件把快捷键交给它统一管理，
 * 设置页的「快捷键」列表直接来自这里。
 */
export const name = 'keyboard-shortcuts'
export const version = '1.0.0'
export const displayName = '快捷键'
export const description = '基础服务 · 快捷键注册与分发，冲突检测。'
export const author = '念风内核'
export const icon = '⌨️'
// 核心视图导航（rail-nav-buttons 等）依赖快捷键服务提供；它属于基础服务，
// 不允许被单独禁用，否则导航快捷键会整体失效。
export const core = true
export const depends = {
  'event-bus': '*',
}
export const optionalDepends = {}
export const inject = ['event-bus']
export const provides = [{ name: 'shortcuts', type: 'singleton' }]

export function apply(ctx) {
  const bindings = []

  const parse = combo => {
    const parts = String(combo)
      .replace(/\s+/g, '')
      .split('+')
      .filter(Boolean)
    const mods = { ctrl: false, shift: false, alt: false, meta: false }
    let key = ''
    for (const part of parts) {
      const p = part.toLowerCase()
      if (p === 'ctrl' || p === 'control') mods.ctrl = true
      else if (p === 'shift') mods.shift = true
      else if (p === 'alt' || p === 'option') mods.alt = true
      else if (p === 'meta' || p === 'cmd' || p === 'command' || p === 'super') mods.meta = true
      else key = normalizeKey(part)
    }
    return { ...mods, key, raw: parts.join('+') }
  }

  const normalizeKey = part => {
    const map = { esc: 'Escape', escape: 'Escape', enter: 'Enter', return: 'Enter', space: ' ', tab: 'Tab' }
    const p = part.toLowerCase()
    if (map[p]) return map[p]
    if (p.startsWith('arrow')) return 'Arrow' + p.slice(5)[0].toUpperCase() + p.slice(6)
    if (p.length === 1) return p.toUpperCase()
    return part
  }

  const matches = (e, combo) => {
    if (combo.ctrl !== e.ctrlKey) return false
    if (combo.shift !== e.shiftKey) return false
    if (combo.alt !== e.altKey) return false
    if (combo.meta !== e.metaKey) return false
    const key = e.key === ' ' ? ' ' : e.key.length === 1 ? e.key.toUpperCase() : e.key
    return key === combo.key
  }

  const hasModifier = combo => combo.ctrl || combo.alt || combo.meta

  const onKeydown = e => {
    if (e.isComposing) return
    const target = e.target
    const typing = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable
    for (const binding of [...bindings]) {
      if (!matches(e, binding.combo)) continue
      if (typing && !hasModifier(binding.combo) && binding.combo.key !== 'Escape') continue
      if (binding.preventDefault !== false) e.preventDefault()
      try {
        binding.handler(e)
      } catch (err) {
        ctx.logger.error(`快捷键 ${binding.raw} 执行失败`, err)
      }
      ctx.emit('shortcut:triggered', { combo: binding.raw, label: binding.label })
      if (binding.once) service.unregister(binding.raw)
    }
  }
  document.addEventListener('keydown', onKeydown)
  ctx.effect(() => document.removeEventListener('keydown', onKeydown))

  const service = {
    name: 'shortcuts',
    register(combo, handler, options = {}) {
      const combos = Array.isArray(combo) ? combo : [combo]
      const disposers = combos.map(raw => {
        const parsed = parse(raw)
        const existing = bindings.find(b => b.raw === parsed.raw)
        if (existing) {
          ctx.emit('shortcuts:conflict', { combo: parsed.raw, a: existing.label, b: options.label })
          ctx.logger.warn(`快捷键冲突：${parsed.raw}（${existing.label} vs ${options.label || '未命名'}）`)
        }
        const binding = {
          raw: parsed.raw,
          combo: parsed,
          handler,
          label: options.label || parsed.raw,
          owner: options.owner || ctx.id,
          preventDefault: options.preventDefault !== false,
          once: !!options.once,
        }
        bindings.push(binding)
        return () => {
          const i = bindings.indexOf(binding)
          if (i >= 0) bindings.splice(i, 1)
        }
      })
      return () => disposers.forEach(fn => fn())
    },
    unregister(raw) {
      const i = bindings.findIndex(b => b.raw === parse(raw).raw)
      if (i >= 0) bindings.splice(i, 1)
    },
    list() {
      return bindings.map(b => ({ combo: b.raw, label: b.label, owner: b.owner }))
    },
    /** 在设置页手动触发一次 */
    trigger(raw) {
      const binding = bindings.find(b => b.raw === parse(raw).raw)
      if (binding) binding.handler(new KeyboardEvent('keydown', { key: binding.combo.key }))
    },
    /** 判断一个组合键当前是否被占用 */
    isTaken: raw => bindings.some(b => b.raw === parse(raw).raw),
  }

  ctx.provide('shortcuts', service, { type: 'singleton' })
  ctx.logger.debug('快捷键服务就绪')
}
