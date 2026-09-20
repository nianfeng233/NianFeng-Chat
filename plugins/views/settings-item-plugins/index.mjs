/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * V21 · settings-item-plugins
 * 插件管理器：不只是列表，而是"可验证的运行状态"。
 *
 *  - 自检：调用 runtime 的 selfCheck()，验证每个插件是否真的在工作
 *    （状态 / 服务是否注册 / 插槽是否挂载 / 冲突与缺依赖）
 *  - 错误与冲突插件标红，未激活与提示标黄，并在卡片里直接写出原因
 *  - 「详情」弹窗展示 manifest、fiber 状态、依赖、提供的服务、告警
 *  - 禁用 / 启用 / 卸载（运行时生效，无需重启）
 */
export const name = 'settings-item-plugins'
export const version = '3.1.0'
export const displayName = '设置项 · 插件'
export const description = '设置页 · 插件自检、健康状态、启停与详情。'
export const author = '念风内核'
export const icon = '🧰'
export const core = true
export const depends = {
  'backend-client': '>=1.0.0',
  'modal-host': '>=1.0.0',
  'plugin-manager': '^1.0.0',
  'plugin-scope': '^1.0.0',
  'settings-container': '^1.0.0',
  'toast-host': '>=1.0.0',
  'view-router': '^1.0.0',
}
export const optionalDepends = {
  'markdown-enhancer': '>=1.0.0',
}
export const inject = ['settings-container', 'plugin-manager', 'plugin-scope', 'toast', 'modal', 'api', 'view-router', 'markdown?']

import { page, section, card, row } from '../../../src/util/settings.mjs'
import { useStyle } from '../../../src/util/style.mjs'
import { PLUGIN_PAGE_CSS } from './style.mjs'
import { escapeHtml } from '../../../src/util/format.mjs'
import { icons } from '../../../src/util/icons.mjs'

const STATUS_TAG = {
  active: { cls: 'enabled', text: '运行中' },
  disabled: { cls: 'disabled', text: '已禁用' },
  inactive: { cls: 'warn', text: '未激活' },
  error: { cls: 'error', text: '加载失败' },
  pending: { cls: 'warn', text: '加载中' },
}

const formatCount = value => {
  const number = Number(value)
  if (!Number.isFinite(number)) return '—'
  if (number >= 10000) return `${(number / 10000).toFixed(1)}w`
  if (number >= 1000) return `${(number / 1000).toFixed(1)}k`
  return String(number)
}

const safeHttpUrl = value => {
  try {
    const url = new URL(String(value || ''))
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : ''
  } catch (_) {
    return ''
  }
}

export function apply(ctx) {
  const pages = ctx.inject('settings-container')
  const manager = ctx.inject('plugin-manager')
  const scope = ctx.inject('plugin-scope')
  const toast = ctx.inject('toast')
  const modal = ctx.inject('modal')
  const router = ctx.inject('view-router')
  const markdown = ctx.inject('markdown?')

  useStyle(ctx, PLUGIN_PAGE_CSS)

  let sortKey = 'status'
  let sortOrder = 'asc'
  /**
   * 市场安装元数据：为已上架的外部插件标注开发者（如清单未带 author 时）与 Star。
   * 读取失败时保持为空，不影响插件管理页其它功能。
   */
  let marketMeta = {}
  let marketMetaLoaded = false
  let marketMetaLoading = false
  /** 本次页面会话里用户点了“稍后设置”的插件，避免反复弹选择框。 */
  const scopePromptLater = new Set()
  let scopePromptOpen = false

  pages.register({
    id: 'plugins',
    group: '核心',
    groupOrder: 20,
    label: '插件',
    icon: icons.plugin,
    order: 30,
    render(container) {
      container.innerHTML = page('插件', '念风的一切功能都由插件提供。这里可以查看每个插件是否真的在正常工作。', `
        <div class="plugin-toolbar">
          <button class="plugin-toolbar-btn primary" data-action="selfcheck">
            ${icons.check} 重新自检
          </button>
          <button class="plugin-toolbar-btn" data-action="export">导出诊断</button>
          <button class="plugin-toolbar-btn" data-action="market">🛍️ 插件市场</button>
          <div class="plugin-toolbar-right">
            <span>排序</span>
            <select class="plugin-sort-select" data-sort-key>
              <option value="status">按状态</option>
              <option value="name">按名称</option>
              <option value="health">按问题数</option>
            </select>
            <button class="plugin-sort-order" data-sort-order title="切换正序 / 倒序">↑</button>
          </div>
        </div>
        <div id="pluginDirsContainer" class="plugin-dirs"></div>
          <div data-plugin-summary class="plugin-summary"></div>
        <div id="pluginListContainer" data-plugin-list></div>
        <div class="plugin-footnote">外部插件放进「插件目录」里的子文件夹（每个插件一个目录，包含 index.mjs），点「重新扫描」后立即热加载生效；内置插件随版本发布，升级 exe 时会被替换。</div>`)

      const listEl = container.querySelector('[data-plugin-list]')
      const dirsEl = container.querySelector('#pluginDirsContainer')
      const summaryEl = container.querySelector('[data-plugin-summary]')
      const sortKeyEl = container.querySelector('[data-sort-key]')
      const sortOrderEl = container.querySelector('[data-sort-order]')

      /* ---------------- 自检 ---------------- */
      const issues = () => {
        try {
          return manager.selfCheck() || []
        } catch (err) {
          ctx.logger.warn('自检失败', err)
          return []
        }
      }
      const issuesOf = (id, list) => list.filter(i => i.id === id)

      /* ---------------- 状态与样式 ---------------- */
      const dependenciesOf = plugin => plugin.dependencies || []
      const dependencyIssuesOf = plugin =>
        dependenciesOf(plugin).filter(item => item.status !== 'ok' && item.status !== 'pending')
      const hasRequiredDependencyIssue = plugin =>
        dependenciesOf(plugin).some(item => item.required && item.severity === 'error')
      const hasOptionalDependencyIssue = plugin =>
        dependenciesOf(plugin).some(item => !item.required && item.severity === 'warning')

      const severityOf = (plugin, list) => {
        const own = issuesOf(plugin.id, list)
        const ownWarning = own.some(i => i.severity === 'warning' || i.severity === 'error')
        const recordWarning = (plugin.warnings || []).some(item => item?.severity && item.severity !== 'info')
        // 旧版外部插件主版本与内核不一致：明确标红，不再伪装成“正常”。
        if (plugin.legacy) return 'error'
        if (plugin.status === 'error' || plugin.conflict || own.some(i => i.severity === 'error')) return 'error'
        // 用户主动禁用的插件保持灰色，不因为它的依赖当前未启用而虚报红/黄。
        if (plugin.status === 'disabled') return 'disabled'
        if (plugin.dependencyHealth === 'error' || hasRequiredDependencyIssue(plugin)) return 'error'
        if (plugin.unavailable && plugin.status === 'active') return 'warning'
        if (
          plugin.status === 'inactive' ||
          recordWarning ||
          ownWarning ||
          plugin.dependencyHealth === 'warning' ||
          hasOptionalDependencyIssue(plugin)
        ) {
          return 'warning'
        }
        return 'ok'
      }

      const tagOf = (plugin, severity) => {
        if (plugin.legacy) return '<span class="plugin-tag error">旧版不兼容</span>'
        if (plugin.conflict) return '<span class="plugin-tag error">服务冲突</span>'
        if (plugin.status === 'disabled') {
          const tag = STATUS_TAG.disabled
          return `<span class="plugin-tag ${tag.cls}">${tag.text}</span>`
        }
        if (hasRequiredDependencyIssue(plugin)) return '<span class="plugin-tag error">缺少依赖</span>'
        if (severity === 'error') return '<span class="plugin-tag error">加载失败</span>'
        if (plugin.unavailable && plugin.status === 'active') return '<span class="plugin-tag warn">暂不可用</span>'
        if (hasOptionalDependencyIssue(plugin)) return '<span class="plugin-tag warn">可选依赖提示</span>'
        if (plugin.status === 'inactive') return '<span class="plugin-tag warn">未激活</span>'
        if (severity === 'warning') return '<span class="plugin-tag warn">有提示</span>'
        const tag = STATUS_TAG[plugin.status] || STATUS_TAG.pending
        return `<span class="plugin-tag ${tag.cls}">${tag.text}</span>`
      }

      const depIssueText = item => {
        const label = item.required
          ? item.status === 'version-mismatch'
            ? '依赖版本不匹配'
            : '缺少依赖'
          : item.status === 'version-mismatch'
            ? '可选依赖版本不匹配'
            : item.status === 'missing'
              ? '缺少可选依赖'
              : '可选依赖不可用'
        return `${item.severity === 'error' ? '✕' : '!'} ${label} ${item.name}@${item.range}：${item.reason || item.status}`
      }

      const reasonHtml = (plugin, list) => {
        const own = issuesOf(plugin.id, list)
        const depIssues = plugin.status === 'disabled' ? [] : dependencyIssuesOf(plugin)
        const lines = []
        if (plugin.legacy) lines.push(`<div class="plugin-issue error">✕ ${escapeHtml(plugin.legacyReason || '旧版插件未适配当前内核，请升级到 2.x 兼容版本')}</div>`)
        else if (plugin.status === 'error') lines.push(`<div class="plugin-issue error">✕ 运行失败：${escapeHtml(plugin.error || plugin.reason || '未知错误')}</div>`)
        else if (plugin.conflict) lines.push(`<div class="plugin-issue error">✕ 冲突：${escapeHtml(plugin.reason || '服务被占用')}</div>`)
        else if (plugin.status === 'inactive') {
          const cls = hasRequiredDependencyIssue(plugin) ? 'error' : 'warning'
          lines.push(`<div class="plugin-issue ${cls}">${cls === 'error' ? '✕' : '!'} 未激活：${escapeHtml(plugin.reason || '依赖未就绪')}</div>`)
        } else if (plugin.status === 'disabled') {
          lines.push(`<div class="plugin-issue muted">已禁用${plugin.reason ? '：' + escapeHtml(plugin.reason) : ''}</div>`)
        }
        if (plugin.unavailable && plugin.status === 'active') {
          lines.push(`<div class="plugin-issue warning">! ${escapeHtml(plugin.unavailableReason || '该插件依赖的官方服务暂未制作，功能暂不可用。')} 禁用后账号页与相关入口会一起隐藏。</div>`)
        }
        for (const item of depIssues) {
          const cls = item.severity === 'error' ? 'error' : 'warning'
          lines.push(`<div class="plugin-issue ${cls}">${escapeHtml(depIssueText(item))}</div>`)
        }
        for (const issue of own) {
          if (issue.message.includes('依赖')) continue
          const cls = issue.severity === 'error' ? 'error' : issue.severity === 'warning' ? 'warning' : 'muted'
          lines.push(`<div class="plugin-issue ${cls}">${issue.severity === 'error' ? '✕' : '!'} ${escapeHtml(issue.message)}</div>`)
        }
        for (const warning of plugin.warnings || []) {
          if (own.some(i => i.message === warning.message)) continue
          lines.push(`<div class="plugin-issue ${warning.severity === 'warning' ? 'warning' : 'muted'}">! ${escapeHtml(warning.message)}</div>`)
        }
        return lines.join('')
      }

      /* ---------------- 渲染 ---------------- */
      const itemHtml = (plugin, list) => {
        const severity = severityOf(plugin, list)
        const disabled = plugin.status !== 'active'
        const market = marketMeta[plugin.id] || null
        const developer = market?.author || plugin.author || ''
        const stars = Number.isFinite(Number(market?.stars)) ? Number(market.stars) : null
        const marketLine =
          developer || stars !== null
            ? `<div class="plugin-dev-meta">开发者：${escapeHtml(developer || '未标注')}${stars !== null ? ` · ⭐ ${escapeHtml(String(stars))}` : ''}</div>`
            : ''
        // 插件可以注册自己的设置面板；有面板时，无论内置 / 第三方都显示「设置」。
        const settingsBtn = plugin.hasSettings
          ? `<button class="plugin-action-btn" data-plugin-action="settings" data-plugin-id="${plugin.id}">设置</button>`
          : ''
        const actions = plugin.core
          ? `${settingsBtn}<span class="plugin-core-hint">系统内置</span>`
          : `
            ${settingsBtn}
            <button class="plugin-action-btn" data-plugin-action="detail" data-plugin-id="${plugin.id}">详情</button>
            <button class="plugin-action-btn" data-plugin-action="toggle" data-plugin-id="${plugin.id}">${plugin.status === 'active' ? '禁用' : '启用'}</button>
            <button class="plugin-action-btn danger" data-plugin-action="remove" data-plugin-id="${plugin.id}">卸载</button>
            ${plugin.external ? `<button class="plugin-action-btn danger" data-plugin-action="delete-external" data-plugin-id="${plugin.id}">删除文件</button>` : ''}`
        return `
          <div class="plugin-item ${severity === 'ok' ? '' : severity} ${plugin.core ? 'core' : ''} ${disabled ? 'disabled' : ''}" data-plugin-id="${plugin.id}">
            <div class="plugin-icon ${plugin.core ? 'core' : ''} ${severity === 'error' ? 'error' : ''}">${plugin.icon || icons.plugin}</div>
            <div class="plugin-info">
              <div class="plugin-name">
                <span>${escapeHtml(plugin.name)}</span>
                <span class="plugin-id">${escapeHtml(plugin.id)}${plugin.version ? '@' + plugin.version : ''}</span>
                ${tagOf(plugin, severity)}
                ${plugin.external ? '<span class="plugin-tag">外部</span>' : ''}
                ${severity === 'ok' && plugin.status === 'active' ? '<span class="plugin-health">● 正常</span>' : ''}
              </div>
              <div class="plugin-desc">${escapeHtml(plugin.description || '')}</div>
              ${marketLine}
              ${reasonHtml(plugin, list)}
            </div>
            <div class="plugin-actions">${actions}</div>
          </div>`
      }

      /** 已卸载插件：数据保留，因此必须给用户一个恢复入口 */
      const removedHtml = plugin => `
        <div class="plugin-item disabled removed" data-plugin-id="${plugin.id}">
          <div class="plugin-icon">${plugin.icon || icons.plugin}</div>
          <div class="plugin-info">
            <div class="plugin-name">
              <span>${escapeHtml(plugin.name)}</span>
              <span class="plugin-id">${escapeHtml(plugin.id)}${plugin.version ? '@' + plugin.version : ''}</span>
              <span class="plugin-tag disabled">已卸载</span>
            </div>
            <div class="plugin-desc">${escapeHtml(plugin.description || '')}</div>
            <div class="plugin-issue muted">数据已保留；恢复后会重新加载插件。</div>
          </div>
          <div class="plugin-actions">
            ${plugin.hasSettings ? `<button class="plugin-action-btn" data-plugin-action="settings" data-plugin-id="${plugin.id}">设置</button>` : ''}
            <button class="plugin-action-btn" data-plugin-action="detail" data-plugin-id="${plugin.id}">详情</button>
            <button class="plugin-action-btn primary" data-plugin-action="restore" data-plugin-id="${plugin.id}">恢复</button>
          </div>
        </div>`

      const sortList = (list, issueList) => {
        const arr = [...list]
        arr.sort((a, b) => {
          let cmp = 0
          if (sortKey === 'name') cmp = a.name.localeCompare(b.name, 'zh-Hans-CN')
          else if (sortKey === 'health') {
            const rank = p => (p.status === 'error' || p.conflict ? 0 : p.status === 'inactive' ? 1 : issuesOf(p.id, issueList).length ? 2 : p.status === 'active' ? 3 : 4)
            cmp = rank(a) - rank(b) || a.name.localeCompare(b.name, 'zh-Hans-CN')
          } else {
            const order = { error: 0, inactive: 1, disabled: 2, active: 3 }
            cmp = (order[a.status] ?? 9) - (order[b.status] ?? 9) || a.name.localeCompare(b.name, 'zh-Hans-CN')
          }
          return sortOrder === 'asc' ? cmp : -cmp
        })
        return arr
      }

      const render = () => {
        const list = manager.list({ includeCore: true, includeRemoved: true })
        const issueList = issues()
        const stats = manager.stats()
        const removed = sortList(list.filter(p => p.removed), issueList)
        const external = sortList(list.filter(p => p.external && !p.removed), issueList)
        const third = sortList(list.filter(p => !p.core && !p.external && !p.removed), issueList)
        const core = sortList(list.filter(p => p.core), issueList)
        const errorCount = list.filter(
          p => p.legacy || p.status === 'error' || p.conflict || (p.status !== 'disabled' && p.dependencyHealth === 'error'),
        ).length

        summaryEl.innerHTML = `
          <span class="plugin-chip">共 <b>${stats.total}</b></span>
          <span class="plugin-chip ok">运行中 <b>${stats.active}</b></span>
          <span class="plugin-chip ${errorCount ? 'error' : ''}">错误 / 冲突 <b>${errorCount}</b></span>
          <span class="plugin-chip ${stats.inactive ? 'warn' : ''}">未激活 <b>${stats.inactive}</b></span>
          <span class="plugin-chip ${stats.warnings ? 'warn' : ''}">自检提示 <b>${stats.warnings}</b></span>
          <span class="plugin-chip">服务 <b>${stats.services}</b></span>
          ${removed.length ? `<span class="plugin-chip">已卸载 <b>${removed.length}</b></span>` : ''}`

        listEl.innerHTML = `
          ${
            external.length
              ? `<div class="settings-section-title" style="margin-top:22px">外部插件</div>
                 <div class="plugin-list">${external.map(p => itemHtml(p, issueList)).join('')}</div>`
              : ''
          }
          <div class="plugin-list">${third.map(p => itemHtml(p, issueList)).join('')}</div>
          <div class="settings-section-title" style="margin-top:22px">核心插件（不可禁用）</div>
          <div class="plugin-list">${core.map(p => itemHtml(p, issueList)).join('')}</div>
          ${
            removed.length
              ? `<div class="settings-section-title" style="margin-top:22px">已卸载（数据保留，可恢复）</div>
                 <div class="plugin-list">${removed.map(removedHtml).join('')}</div>`
              : ''
          }`
        bindActionButtons()
        loadPluginDirs()
        loadMarketMeta()
        ctx.setTimeout(() => promptNewPluginScopes(), 180)
      }

      /** 读取市场安装元数据 + 批量市场目录元数据，用于小字标注开发者 / Star；只拉取一次。 */
      const loadMarketMeta = async () => {
        if (marketMetaLoaded || marketMetaLoading) return
        marketMetaLoading = true
        try {
          const api = ctx.inject('api')
          if (typeof api.marketInstalledMeta === 'function') {
            const result = await api.marketInstalledMeta()
            if (result?.installed && typeof result.installed === 'object') marketMeta = { ...result.installed }
          }
          if (typeof api.marketLookup === 'function') {
            const externalIds = manager
              .list({ includeCore: true, includeRemoved: true })
              .filter(plugin => plugin.external && plugin.id)
              .map(plugin => plugin.id)
              .slice(0, 200)
            if (externalIds.length) {
              const result = await api.marketLookup(externalIds)
              if (result?.ok && result.plugins && typeof result.plugins === 'object') {
                for (const [id, info] of Object.entries(result.plugins)) {
                  marketMeta[id] = { ...(marketMeta[id] || {}), ...info }
                }
              }
            }
          }
        } catch (err) {
          ctx.logger.debug(`读取插件市场元数据失败：${err?.message || err}`)
        } finally {
          marketMetaLoaded = true
          marketMetaLoading = false
        }
        render()
      }

      /* 运行期热同步 / 其它设备启停 / 安装卸载后，当前打开的插件页会通过
         offs 里的 plugin:list-changed 事件重绘列表，不再刷新页面。 */
      /**
       * 逐项直接绑定 click：极简 DOM 垫片没有事件冒泡，浏览器里也避免
       * “直接监听 + 容器委托”同时触发导致卸载/恢复执行两次。
       */
      const bindActionButtons = () => {
        const bind = el => {
          if (!el || el.dataset.clickBound === '1') return
          el.dataset.clickBound = '1'
          el.addEventListener('click', onClick)
        }
        container.querySelectorAll('[data-plugin-action]').forEach(bind)
        container.querySelectorAll('.plugin-toolbar [data-action]').forEach(bind)
      }

      /* ---------------- 详情 ---------------- */
      const showDetail = async id => {
        const plugin = manager.describe(id)
        if (!plugin) return
        const owns = ctx.registry.list().filter(s => s.owner === `plugin:${id}`).map(s => `${s.name}(${s.type})`)
        const dependencyReport = (plugin.dependencies || []).length
          ? plugin.dependencies
          : [
              ...Object.entries(plugin.depends || {}).map(([name, range]) => ({ name, range, required: true, status: 'ok', reason: '' })),
              ...Object.entries(plugin.optionalDepends || {}).map(([name, range]) => ({ name, range, required: false, status: 'ok', reason: '' })),
            ]
        const depDetail = item => {
          const mark = item.status === 'ok' || item.status === 'pending' ? '✓' : item.severity === 'error' ? '✕' : '!'
          const version = item.installedVersion ? `（实际 ${item.installedVersion}）` : ''
          const reason = item.reason ? ` · ${item.reason}` : ''
          return `${mark} ${item.name}@${item.range}${version}${reason}`
        }
        const requiredDeps = dependencyReport.filter(item => item.required)
        const optionalDeps = dependencyReport.filter(item => !item.required)
        const detailLines = [
          `id        ${plugin.id}@${plugin.version}`,
          `作者      ${plugin.author || '未标注'}`,
          `状态      ${plugin.statusLabel}${plugin.conflict ? '（服务冲突）' : ''}`,
          plugin.reason ? `原因      ${plugin.reason}` : '',
          `fiber     ${plugin.fiberState === null ? '—' : plugin.fiberState}（0=PENDING 2=ACTIVE 3=FAILED 4=DISPOSED）`,
          `来源      ${plugin.external ? '外部插件（可删除文件）' : '内置插件（随版本发布）'}`,
          `路径      ${plugin.path || plugin.dir || '—'}`,
          '',
          `必须依赖  ${requiredDeps.map(depDetail).join('、') || '无'}`,
          `可选依赖  ${optionalDeps.map(depDetail).join('、') || '无'}`,
          `注入服务  ${plugin.inject.join('、') || '无'}`,
          `提供声明  ${plugin.provides.map(p => (typeof p === 'string' ? p : p.name)).join('、') || '无'}`,
          `实际持有  ${owns.join('、') || '无'}`,
          `使用插槽  ${plugin.slots.join('、') || '未声明'}`,
          plugin.warnings?.length ? `\n告警\n${plugin.warnings.map(w => `· [${w.severity}] ${w.message}`).join('\n')}` : '',
        ].filter(Boolean)

        // 外部插件优先去插件市场补全真实 GitHub 作者 / Star / 仓库 / README；
        // 市场不可达时安静降级为插件内签名与空 README。
        let marketInfo = null
        let readme = ''
        if (plugin.external) {
          try {
            const api = ctx.inject('api')
            if (typeof api.marketPlugin === 'function') {
              const data = await api.marketPlugin(id, '', { timeoutMs: 8000, retries: 0 })
              if (data?.ok && data.plugin) {
                marketInfo = data.plugin
                readme = String(data.readme || '')
              }
            }
          } catch (err) {
            ctx.logger.debug(`读取插件市场详情失败：${err?.message || err}`)
          }
        }

        const fallbackMarket = marketMeta[plugin.id] || null
        const runtimeAuthor = plugin.author || '未标注'
        const author = marketInfo?.author || fallbackMarket?.author || runtimeAuthor
        const starsValue = Number(marketInfo?.stars ?? fallbackMarket?.stars)
        const stars = Number.isFinite(starsValue) ? starsValue : null
        const repo = safeHttpUrl(marketInfo?.repo || marketInfo?.homepage || fallbackMarket?.repo || '')
        const severity = severityOf(plugin, issues())
        const readmeHtml = readme
          ? markdown?.render
            ? markdown.render(readme)
            : `<pre class="plugin-readme-plain">${escapeHtml(readme)}</pre>`
          : '<div class="plugin-detail-empty">该插件暂未提供 README。</div>'
        const html = `
          <div class="plugin-detail">
            <div class="plugin-detail-hero">
              <div class="plugin-detail-icon ${plugin.core ? 'core' : ''}">${escapeHtml(plugin.icon || icons.plugin)}</div>
              <div class="plugin-detail-hero-main">
                <div class="plugin-detail-name">${escapeHtml(plugin.name || plugin.id)}</div>
                <div class="plugin-detail-badges">
                  <span class="plugin-id">${escapeHtml(plugin.id)}@${escapeHtml(plugin.version || '0.0.0')}</span>
                  ${tagOf(plugin, severity)}
                  ${plugin.external ? '<span class="plugin-tag">外部</span>' : ''}
                </div>
                <div class="plugin-detail-desc">${escapeHtml(plugin.description || '暂无描述')}</div>
              </div>
            </div>

            <div class="plugin-detail-stats">
              <div class="plugin-detail-stat">
                <span>开发者</span>
                <b>${escapeHtml(author)}</b>
                ${author !== runtimeAuthor ? `<em class="plugin-detail-fallback">插件签名：${escapeHtml(runtimeAuthor)}</em>` : ''}
              </div>
              <div class="plugin-detail-stat">
                <span>GitHub Star</span>
                <b>${stars !== null ? `⭐ ${escapeHtml(formatCount(stars))}` : '—'}</b>
              </div>
              <div class="plugin-detail-stat">
                <span>当前版本</span>
                <b>${escapeHtml(plugin.version || '—')}</b>
              </div>
              <div class="plugin-detail-stat">
                <span>来源</span>
                <b>${plugin.external ? '外部插件' : '内置插件'}</b>
              </div>
              ${
                repo
                  ? `<div class="plugin-detail-stat plugin-detail-repo">
                      <span>仓库</span>
                      <a class="plugin-detail-link" href="${escapeHtml(repo)}" target="_blank" rel="noopener noreferrer">${escapeHtml(repo.replace(/^https?:\/\//i, ''))}</a>
                    </div>`
                  : ''
              }
              ${
                marketInfo
                  ? `<div class="plugin-detail-stat"><span>市场版本</span><b>${escapeHtml(marketInfo.version || plugin.version || '—')}</b></div>`
                  : ''
              }
            </div>

            <div class="plugin-detail-section">
              <div class="plugin-detail-section-title">README</div>
              <div class="plugin-detail-readme" data-plugin-readme>${readmeHtml}</div>
            </div>

            <details class="plugin-detail-tech">
              <summary>技术详情</summary>
              <pre>${escapeHtml(detailLines.join('\n'))}</pre>
            </details>
          </div>`

        await modal.open({
          title: `插件详情 · ${plugin.name}`,
          html,
          wide: true,
          confirmText: '关闭',
          hideCancel: true,
        })
      }

      /* ---------------- 插件目录（内置 + 外部） ---------------- */
    // 先渲染“读取中”的目录骨架：添加插件 / 选择目录等按钮不依赖后端响应，
    // 刷新页面后不会再出现“顶部半天没有添加插件按钮”的空窗期。
    let dirsInfo = { loading: true, externalDir: '', builtinDir: '', count: 0, externalCount: 0, warnings: [] }
    /**
     * 安装 / 删除 / 重扫后的统一热同步：拉取最新 /api/plugins 并交给 runtime，
     * 新插件当场 import 激活、删除的当场释放；不刷新页面。
     */
    const hotSyncPlugins = async (reason, { refreshDirs = true } = {}) => {
      const api = ctx.inject('api')
      const result = await manager.sync({ reason })
      if (refreshDirs && api?.pluginDirs) {
        try {
          dirsInfo = await api.pluginDirs()
        } catch (err) {
          ctx.logger.debug(`插件目录刷新失败：${err?.message || err}`)
        }
      }
      render()
      return result
    }

    /**
     * 新安装的外部插件还没有启用范围配置时，弹一次“全体启用 / 全体关闭”。
     * 后续可在「设置 → 插件启用」里按角色 / 渠道细调；点“稍后设置”则本次会话不再打扰。
     */
    const pendingScopePromptPlugins = () =>
      manager
        .list({ includeCore: false })
        .filter(plugin => plugin.external && !plugin.removed && plugin.status === 'active' && !scope.has(plugin.id) && !scopePromptLater.has(plugin.id))

    const promptNewPluginScopes = () => {
      if (scopePromptOpen || ctx.__settingsSearchIndexing === true) return
      const plugin = pendingScopePromptPlugins()[0]
      if (!plugin) return
      scopePromptOpen = true
      const overlay = document.createElement('div')
      overlay.className = 'plugin-scope-prompt-mask'
      overlay.innerHTML = `
        <div class="plugin-scope-prompt" role="dialog" aria-modal="true">
          <div class="plugin-scope-prompt-title">新插件「${escapeHtml(plugin.name || plugin.id)}」</div>
          <div class="plugin-scope-prompt-desc">请选择这个插件在所有角色下的默认启用策略。之后可以在「设置 → 插件启用」里按角色 / 渠道单独调整，这里只影响默认值。</div>
          <div class="plugin-scope-prompt-actions">
            <button class="plugin-action-btn primary" data-plugin-scope-pick="all">默认为全体角色启用</button>
            <button class="plugin-action-btn" data-plugin-scope-pick="none">默认为全体角色关闭</button>
            <button class="plugin-action-btn" data-plugin-scope-pick="later">稍后设置</button>
          </div>
        </div>`
      document.body.appendChild(overlay)
      const finish = pick => {
        if (pick === 'all' || pick === 'none') {
          scope.setDefault(plugin.id, pick)
          toast.success(pick === 'all' ? `已默认对全体角色启用「${plugin.name || plugin.id}」` : `已默认对全体角色关闭「${plugin.name || plugin.id}」`)
        } else {
          scopePromptLater.add(plugin.id)
        }
        overlay.remove()
        scopePromptOpen = false
        ctx.setTimeout(promptNewPluginScopes, 120)
      }
      overlay.querySelectorAll('[data-plugin-scope-pick]').forEach(button => {
        button.addEventListener('click', () => finish(String(button.dataset.pluginScopePick || 'later')))
      })
    }
    const renderPluginDirs = () => {
      if (!dirsEl) return
      const api = ctx.inject('api')
      if (!api) {
        dirsEl.innerHTML = ''
        return
      }
      if (dirsInfo?.error) {
        dirsEl.innerHTML = section('插件目录', card(
          row('读取失败', escapeHtml(dirsInfo.error), '<button class="outline-btn" data-dir-action="reload">重试</button>'),
        ))
        dirsEl.querySelector('[data-dir-action="reload"]')?.addEventListener('click', () => loadPluginDirs())
        return
      }
      const loading = dirsInfo?.loading === true
      const external = dirsInfo?.externalDir || ''
      const warnings = (dirsInfo?.warnings || []).map(w => `${w.id}: ${w.message}`).join('；')
      dirsEl.innerHTML = section('插件目录', card(
        row('内置插件目录', loading ? '正在读取插件目录…' : '随版本发布，升级 exe 时会被整体替换；不要在这里长期放自己的插件',
          loading ? '' : `<span class="mono plugin-path">${escapeHtml(dirsInfo.builtinDir || '—')}</span>`) +
        `<div class="setting-row plugin-dir-item">
          <div class="setting-main">
            <div class="setting-name">外部插件目录</div>
            <div class="setting-help">${loading ? '正在读取插件目录，按钮已可使用。' : dirsInfo.envOverride ? '当前由环境变量 NIANFENG_PLUGINS_DIR 指定，设置页的修改不会生效' : '把插件文件夹放进这里（每个插件一个子目录，内含 index.mjs），也可以直接上传插件 zip 安装'}</div>
          </div>
          <div class="setting-control plugin-dir-controls">
            <input class="setting-input plugin-dir-input" id="pluginDirInput" value="${escapeHtml(external)}" />
            <button class="outline-btn plugin-upload-btn" data-dir-action="upload">添加插件</button>
            <button class="outline-btn" data-dir-action="pick"${loading ? ' disabled' : ''}>选择目录</button>
            <button class="outline-btn" data-dir-action="apply"${loading ? ' disabled' : ''}>应用并刷新</button>
            <button class="outline-btn" data-dir-action="open"${loading ? ' disabled' : ''}>打开目录</button>
            <button class="outline-btn" data-dir-action="rescan"${loading ? ' disabled' : ''}>重新扫描</button>
          </div>
        </div>` +
        row('扫描结果', loading ? '正在读取插件目录…' : '外部插件数量 / 插件总数',
          loading ? '' : `<span class="mono">外部 ${dirsInfo.externalCount ?? 0} 个 / 共 ${dirsInfo.count ?? 0} 个</span>`) +
        (!loading && warnings ? row('扫描提示', escapeHtml(warnings), '') : ''),
      ))
      dirsEl.querySelector('[data-dir-action="pick"]')?.addEventListener('click', async () => {
        try {
          const result = await api.pickPluginsDir()
          const input = dirsEl.querySelector('#pluginDirInput')
          if (result?.path && input) {
            input.value = result.path
            toast.info('已选择目录，点「应用并刷新」保存')
          } else {
            toast.info('没有选择目录')
          }
        } catch (err) {
          toast.error(`打开目录选择器失败：${err.message}。也可以手动填写路径。`)
        }
      })
      dirsEl.querySelector('[data-dir-action="apply"]')?.addEventListener('click', async () => {
        const input = dirsEl.querySelector('#pluginDirInput')
        const dir = String(input?.value || '').trim()
        try {
          await api.setPluginsDir(dir)
          toast.success('插件目录已保存，正在热加载插件…')
          await hotSyncPlugins('dir-changed')
        } catch (err) {
          toast.error(`保存失败：${err.message}`)
        }
      })
      dirsEl.querySelector('[data-dir-action="open"]')?.addEventListener('click', async () => {
        try {
          const result = await api.openPluginsDir()
          toast.info(`插件目录：${result?.dir || external}`)
        } catch (err) {
          toast.error(`打开目录失败：${err.message}`)
        }
      })
      dirsEl.querySelector('[data-dir-action="rescan"]')?.addEventListener('click', async () => {
        try {
          const result = await api.rescanPlugins()
          dirsInfo = result
          toast.success(`已重新扫描：外部 ${result?.externalCount ?? 0} 个插件，正在热加载…`)
          await hotSyncPlugins('rescan')
        } catch (err) {
          toast.error(`重新扫描失败：${err.message}`)
        }
      })
      /* 添加插件：浏览器选择本机 zip -> 上传到后端 -> 解压到外部插件目录。
         部署在远程服务器时，文件选择器依然读取“用户本机”的文件，再通过 HTTP 上传。 */
      const uploadBtn = dirsEl.querySelector('[data-dir-action="upload"]')
      if (uploadBtn) {
        const fileInput = document.createElement('input')
        fileInput.type = 'file'
        fileInput.accept = '.zip,application/zip'
        fileInput.style.display = 'none'
        uploadBtn.parentElement?.appendChild(fileInput)
        const fileToBase64 = file =>
          new Promise((resolve, reject) => {
            const reader = new FileReader()
            reader.onload = () => {
              const text = String(reader.result || '')
              resolve(text.includes(',') ? text.slice(text.indexOf(',') + 1) : text)
            }
            reader.onerror = () => reject(reader.error || new Error('读取文件失败'))
            reader.readAsDataURL(file)
          })
        const uploadFile = async (file, overwrite = false) => {
          try {

            toast.info(`正在上传 ${file.name}…`)
            const data = await fileToBase64(file)
            const result = await api.uploadPlugin({ filename: file.name, data, overwrite })
            const names = (result?.installed || []).map(item => item.id).join('、')
            toast.success(`插件已安装：${names || file.name}，正在热加载…`)
            await hotSyncPlugins('install')
          } catch (err) {
            if (err?.status === 409) {
              const confirmed = await modal.confirm('插件已存在', `${err.message} 覆盖安装会先删除服务器上同名的外部插件目录，是否继续？`)
              if (confirmed) return uploadFile(file, true)
              return
            }
            toast.error(`安装失败：${err?.message || err}`)
          }
        }
        uploadBtn.addEventListener('click', () => fileInput.click())
        fileInput.addEventListener('change', () => {
          const file = fileInput.files?.[0]
          fileInput.value = ''
          if (file) uploadFile(file, false)
        })
      }
    }
    const loadPluginDirs = async () => {
      const api = ctx.inject('api')
      if (!api) return
      // 先立即画出可用的目录 / 按钮骨架，再直接请求插件目录。
      // 不再先等 health（它最长 8 秒），否则远程部署刷新时“添加插件”区
      // 会一直停在空白 / 旧后端提示上。
      dirsInfo = { ...(dirsInfo || {}), loading: true, error: '' }
      renderPluginDirs()
      try {
        dirsInfo = await api.pluginDirs()
      } catch (err) {
        dirsInfo = { error: err.message }
      }
      renderPluginDirs()
    }
    /* ---------------- 交互 ---------------- */
      const onClick = async e => {
        const btn = e.target.closest('[data-plugin-action]')
        if (btn) {
          const { pluginAction: action, pluginId: id } = btn.dataset
          if (action === 'toggle') {
            const ok = await manager.toggle(id)
            if (ok) render()
          } else if (action === 'remove') {
            await manager.uninstall(id)
            render()
          } else if (action === 'delete-external') {
            const plugin = manager.describe(id)
            const answer = await modal.open({
              title: `删除外部插件「${plugin?.name || id}」`,
              description: '将删除外部插件目录中的文件，且不可恢复；内置插件不受影响。',
              confirmText: '删除',
            })
            if (answer?.ok) {
              try {
                await ctx.inject('api').removeExternalPlugin(id)
                toast.success('外部插件文件已删除，正在热卸载…')
                await hotSyncPlugins('delete-external')
              } catch (err) {
                toast.error(`删除失败：${err.message}`)
              }
            }
            return
          } else if (action === 'restore') {
            const ok = await manager.restore(id)
            if (ok) toast.success(`已恢复插件「${manager.describe(id)?.name || id}」`)
            render()
          } else if (action === 'settings') {
            manager.openSettings(id)
          } else if (action === 'detail') {
            await showDetail(id)
          }
          return
        }
        const action = e.target.closest('[data-action]')?.dataset.action
        if (action === 'selfcheck') {
          const found = issues()
          const errors = found.filter(i => i.severity === 'error').length
          const warns = found.length - errors
          render()
          errors ? toast.error(`自检完成：${errors} 个错误、${warns} 个提示`) : toast.success(`自检完成：一切正常（${warns} 个提示）`)
        } else if (action === 'export') {
          const payload = {
            at: new Date().toISOString(),
            version: ctx.inject('app')?.version,
            runtime: 'cordis',
            plugins: manager.list({ includeCore: true, includeRemoved: true }),
            issues: issues(),
            services: ctx.registry.list(),
          }
          const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
          const url = URL.createObjectURL(blob)
          const a = document.createElement('a')
          a.href = url
          a.download = `nianfeng-plugins-diagnostic-${Date.now()}.json`
          a.click()
          URL.revokeObjectURL(url)
          toast.success('诊断信息已导出')
        } else if (action === 'market' || action === 'install') {
          ctx.emit('settings:close', null)
          if (router.has('market')) router.switch('market')
          else toast.info('插件市场视图尚未就绪，请刷新页面后再试')
        }
      }

      const onSortKey = () => {
        sortKey = sortKeyEl.value
        render()
      }
      const onSortOrder = () => {
        sortOrder = sortOrder === 'asc' ? 'desc' : 'asc'
        sortOrderEl.textContent = sortOrder === 'asc' ? '↑' : '↓'
        render()
      }

      sortKeyEl.addEventListener('change', onSortKey)
      sortOrderEl.addEventListener('click', onSortOrder)

      const offs = [
        ctx.on('plugin:loaded', render),
        ctx.on('plugin:enabled', render),
        ctx.on('plugin:disabled', render),
        ctx.on('plugin:uninstalled', render),
        ctx.on('plugin:error', render),
        ctx.on('plugin:warning', render),
        ctx.on('plugin:settings-registered', render),
        ctx.on('plugin:list-changed', () => render()),
        ctx.on('plugin:reloaded', () => render()),
      ]

      sortKeyEl.value = sortKey
      sortOrderEl.textContent = sortOrder === 'asc' ? '↑' : '↓'
      render()
      return () => {
        offs.forEach(off => off())
        sortKeyEl.removeEventListener('change', onSortKey)
        sortOrderEl.removeEventListener('click', onSortOrder)
      }
    },
  })
}
