/**
 * 设置页的小工具（库，不是插件）：
 * 统一生成标题 / 卡片 / 行 / 开关，并把带 data-config-* 的控件自动绑定到 config。
 */

export function page(title, desc, html) {
  return `<div class="settings-title-row">
      <div><div class="settings-title">${title}</div><div class="settings-desc">${desc || ''}</div></div>
    </div>${html}`
}

export function section(title, content, { className = '' } = {}) {
  return `<div class="settings-section ${className}">${title ? `<div class="settings-section-title">${title}</div>` : ''}${content}</div>`
}

export function card(rows) {
  return `<div class="settings-card">${rows}</div>`
}

export function row(name, help, control) {
  return `<div class="setting-row">
      <div class="setting-main"><div class="setting-name">${name}</div>${help ? `<div class="setting-help">${help}</div>` : ''}</div>
      <div class="setting-control">${control}</div>
    </div>`
}

export function switchBtn(key, on = false) {
  return `<button class="switch ${on ? 'on' : ''}" data-config-toggle="${key}"></button>`
}

export function segmented(key, options, active) {
  return `<div class="segmented" data-config-segmented="${key}">${options
    .map(o => {
      const value = typeof o === 'string' ? o : o.value
      const label = typeof o === 'string' ? o : o.label
      return `<button data-value="${value}" class="${value === active ? 'active' : ''}">${label}</button>`
    })
    .join('')}</div>`
}

export function select(key, options, active) {
  return `<select class="setting-select" data-config-select="${key}">${options
    .map(o => {
      const value = typeof o === 'string' ? o : o.value
      const label = typeof o === 'string' ? o : o.label
      return `<option value="${value}" ${value === active ? 'selected' : ''}>${label}</option>`
    })
    .join('')}</select>`
}

export function input(key, value, { placeholder = '', width = 160, type = 'text' } = {}) {
  return `<input class="setting-input" type="${type}" data-config-input="${key}" value="${escapeAttr(value ?? '')}"
    placeholder="${escapeAttr(placeholder)}" style="width:${width}px" />`
}

/**
 * 把容器里所有 data-config-* 控件接到 config 服务。
 * 返回解绑函数。
 */
export function bindConfigControls(container, ctx, { onChange } = {}) {
  const config = ctx.inject('config')
  const offs = []

  for (const el of container.querySelectorAll('[data-config-toggle]')) {
    let value = config.get(el.dataset.configToggle, el.classList.contains('on'))
    el.classList.toggle('on', !!value)
    const fn = () => {
      value = !value
      el.classList.toggle('on', value)
      config.set(el.dataset.configToggle, value)
      onChange?.(el.dataset.configToggle, value)
    }
    el.addEventListener('click', fn)
    offs.push(() => el.removeEventListener('click', fn))
  }

  for (const el of container.querySelectorAll('[data-config-segmented]')) {
    const key = el.dataset.configSegmented
    let value = String(config.get(key, el.querySelector('.active')?.dataset.value ?? ''))
    const fn = e => {
      const btn = e.target.closest('button[data-value]')
      if (!btn) return
      value = btn.dataset.value
      el.querySelectorAll('button').forEach(b => b.classList.toggle('active', b === btn))
      config.set(key, value)
      onChange?.(key, value)
    }
    el.addEventListener('click', fn)
    offs.push(() => el.removeEventListener('click', fn))
  }

  for (const el of container.querySelectorAll('[data-config-select]')) {
    const key = el.dataset.configSelect
    el.value = String(config.get(key, el.value))
    const fn = () => {
      config.set(key, el.value)
      onChange?.(key, el.value)
    }
    el.addEventListener('change', fn)
    offs.push(() => el.removeEventListener('change', fn))
  }

  for (const el of container.querySelectorAll('[data-config-input]')) {
    const key = el.dataset.configInput
    el.value = String(config.get(key, el.value ?? ''))
    const fn = () => {
      config.set(key, el.value)
      onChange?.(key, el.value)
    }
    el.addEventListener('change', fn)
    offs.push(() => el.removeEventListener('change', fn))
  }

  return () => offs.forEach(off => off())
}

function escapeAttr(s) {
  return String(s ?? '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[m])
}
