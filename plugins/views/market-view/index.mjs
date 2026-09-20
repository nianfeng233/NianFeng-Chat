/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * V? · market-view
 * 插件市场独立视图：
 *   - 官方源 / 自定义源切换与源预设管理；
 *   - 搜索、按更新时间 / Star / 名称 / 版本排序，支持正序倒序；
 *   - 分页展示，避免一次渲染大量插件；
 *   - 详情展开 README、作者、Star、仓库与哈希状态；
 *   - 一键安装 / 更新，安装前由后端校验插件 id、版本与 SHA-256。
 *
 * 插件源格式与安装安全策略见 src/shared/market-format.mjs 与 server/plugins/market.mjs。
 */
export const name = 'market-view'
export const version = '1.0.0'
export const displayName = '视图 · 插件市场'
export const description = '独立视图：浏览官方 / 自定义插件源，搜索、排序、查看详情并一键安装更新。'
export const author = '念风内核'
export const icon = '🛍️'
export const core = true
export const enabled = true
export const depends = {
  'backend-client': '>=1.0.0',
  'modal-host': '>=1.0.0',
  'toast-host': '>=1.0.0',
  'view-router': '^1.0.0',
}
export const optionalDepends = {
  'markdown-enhancer': '>=1.0.0',
}
export const inject = ['view-router', 'api', 'toast', 'modal', 'markdown?']
export const provides = [{ name: 'market-view', type: 'singleton' }]

import { useStyle } from '../../../src/util/style.mjs'
import { escapeHtml } from '../../../src/util/format.mjs'
import { MARKET_CSS } from './style.mjs'

const formatNumber = value => {
  const number = Number(value)
  if (!Number.isFinite(number)) return '—'
  if (number >= 10000) return `${(number / 10000).toFixed(1)}w`
  if (number >= 1000) return `${(number / 1000).toFixed(1)}k`
  return String(number)
}

const formatTime = value => {
  const timestamp = typeof value === 'number' ? value : Date.parse(String(value || ''))
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '—'
  const date = new Date(timestamp)
  const pad = n => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

const safeHttpUrl = value => {
  try {
    const url = new URL(String(value || ''))
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : ''
  } catch (_) {
    return ''
  }
}

const installLabelOf = plugin => {
  if (plugin.status === 'update') return `更新到 ${plugin.version}`
  if (plugin.status === 'installed') return '重新安装'
  if (plugin.status === 'newer') return '本地版本更高'
  return '安装'
}

export function apply(ctx) {
  const router = ctx.inject('view-router')
  const api = ctx.inject('api')
  const toast = ctx.inject('toast')
  const modal = ctx.inject('modal')
  const markdown = ctx.inject('markdown?')

  useStyle(ctx, MARKET_CSS)

  // 每次运行 / 打开 WebUI 后尝试刷新一次当前源（后台进行，失败不影响使用）。
  let refreshScheduled = false
  const scheduleStartupRefresh = () => {
    if (refreshScheduled) return
    refreshScheduled = true
    ctx.setTimeout(async () => {
      if (typeof api.marketSources !== 'function') return
      try {
        const info = await api.marketSources()
        if (info?.activeSourceId) await api.marketRefresh(info.activeSourceId)
      } catch (_) {
        /* 离线 / 自定义源不可达时忽略 */
      }
    }, 1400)
  }
  ctx.on('app:ready', scheduleStartupRefresh)
  queueMicrotask(scheduleStartupRefresh)

  router.register('market', {
    label: '插件市场',
    icon: '🛍️',
    // 顶层入口：排在渠道 / 记忆库前面，插件管理相关操作可以从这里直接进入。
    order: 27,
    rail: true,
    fullWidth: true,
    lazy: true,
    main(container) {
      container.innerHTML = `
        <div class="market-page">
          <div class="market-inner">
            <header class="market-header">
              <div>
                <div class="market-title">插件市场</div>
                <div class="market-sub">从官方源或自定义源浏览、安装与更新插件。安装前会校验插件 id、版本与 SHA-256，拒绝内容与市场清单不一致的压缩包。</div>
              </div>
              <div class="market-header-actions">
                <select class="market-source-select" data-market-source title="选择插件源"></select>
                <button class="market-btn" data-market-action="add-source">添加源</button>
                <button class="market-btn" data-market-action="edit-source">编辑源</button>
                <button class="market-btn" data-market-action="remove-source">删除源</button>
                <button class="market-btn" data-market-action="refresh">刷新</button>
              </div>
            </header>

            <div class="market-toolbar">
              <input class="market-search" data-market-search type="search" placeholder="搜索插件 id / 名称 / 作者 / 描述…" />
              <select class="market-select" data-market-sort title="排序方式">
                <option value="updated">按更新时间</option>
                <option value="stars">按 GitHub Star</option>
                <option value="name">按名称</option>
                <option value="version">按版本</option>
              </select>
              <button class="market-btn market-order" data-market-order title="切换正序 / 倒序">↓</button>
              <select class="market-select" data-market-page-size title="每页数量">
                <option value="12">每页 12 个</option>
                <option value="24">每页 24 个</option>
                <option value="48">每页 48 个</option>
              </select>
              <span class="market-stats" data-market-stats></span>
            </div>

            <div class="market-warning" data-market-warning hidden></div>
            <div class="market-list" data-market-list></div>
            <div class="market-pager">
              <button class="market-btn" data-market-page="prev">上一页</button>
              <span data-market-page-info></span>
              <button class="market-btn" data-market-page="next">下一页</button>
            </div>
          </div>
        </div>

        <div class="market-detail-mask" data-market-detail hidden>
          <div class="market-detail" role="dialog" aria-modal="true">
            <div class="market-detail-head">
              <div>
                <div class="market-detail-title" data-market-detail-title>插件详情</div>
                <div class="market-detail-sub" data-market-detail-sub></div>
              </div>
              <button class="market-icon-btn" data-market-detail-close title="关闭">×</button>
            </div>
            <div class="market-detail-meta" data-market-detail-meta></div>
            <div class="market-detail-body" data-market-detail-body></div>
            <div class="market-detail-actions" data-market-detail-actions></div>
          </div>
        </div>`

      const el = {
        source: container.querySelector('[data-market-source]'),
        search: container.querySelector('[data-market-search]'),
        sort: container.querySelector('[data-market-sort]'),
        order: container.querySelector('[data-market-order]'),
        pageSize: container.querySelector('[data-market-page-size]'),
        stats: container.querySelector('[data-market-stats]'),
        warning: container.querySelector('[data-market-warning]'),
        list: container.querySelector('[data-market-list]'),
        pageInfo: container.querySelector('[data-market-page-info]'),
        detail: container.querySelector('[data-market-detail]'),
        detailTitle: container.querySelector('[data-market-detail-title]'),
        detailSub: container.querySelector('[data-market-detail-sub]'),
        detailMeta: container.querySelector('[data-market-detail-meta]'),
        detailBody: container.querySelector('[data-market-detail-body]'),
        detailActions: container.querySelector('[data-market-detail-actions]'),
      }

      const state = {
        // 先放一个官方源占位：即使 /api/market/sources 还没返回或读取失败，
        // 下拉框也不会变成空白。
        sources: [{ id: 'official', name: '念风官方插件源（读取中…）', official: true, builtin: true }],
        activeSourceId: 'official',
        loading: false,
        error: '',
        plugins: [],
        total: 0,
        page: 1,
        pageSize: 20,
        totalPages: 1,
        q: '',
        sort: 'updated',
        order: 'desc',
        fetchedAt: 0,
        stale: false,
        warnings: [],
        source: null,
        detail: null,
        detailLoading: false,
        detailError: '',
        busyId: '',
      }

      let searchTimer = null

      const pluginOf = id =>
        state.plugins.find(plugin => plugin.id === id) || (state.detail?.plugin?.id === id ? state.detail.plugin : null)

      const renderSources = () => {
        if (!el.source) return
        el.source.innerHTML = state.sources
          .map(
            source =>
              `<option value="${escapeHtml(source.id)}"${source.id === state.activeSourceId ? ' selected' : ''}>${escapeHtml(source.name || source.id)}${source.official ? ' · 官方' : ''}</option>`,
          )
          .join('')
        const custom = state.activeSourceId !== 'official'
        const editBtn = container.querySelector('[data-market-action="edit-source"]')
        const removeBtn = container.querySelector('[data-market-action="remove-source"]')
        if (editBtn) editBtn.disabled = !custom
        if (removeBtn) removeBtn.disabled = !custom
      }

      const cardHtml = plugin => {
        const name = escapeHtml(plugin.displayName || plugin.name || plugin.id)
        const source = plugin.status === 'update' ? '可更新' : plugin.status === 'installed' ? '已安装' : ''
        const tags = (plugin.tags || []).slice(0, 6).map(tag => `<span class="market-tag">${escapeHtml(tag)}</span>`).join('')
        const hashTag = plugin.sha256
          ? '<span class="market-tag good">SHA-256 已标注</span>'
          : '<span class="market-tag warn">未提供哈希</span>'
        const installDisabled = state.busyId === plugin.id || plugin.status === 'newer'
        const installText = state.busyId === plugin.id ? '处理中…' : installLabelOf(plugin)
        const repoUrl = safeHttpUrl(plugin.homepage || plugin.repo || '')
        return `
          <article class="market-card" data-market-plugin="${escapeHtml(plugin.id)}">
            <div class="market-card-head">
              <div class="market-card-icon">${escapeHtml(plugin.icon || '🧩')}</div>
              <div class="market-card-main">
                <div class="market-card-title">
                  <span>${name}</span>
                  <span class="market-id">${escapeHtml(plugin.id)}@${escapeHtml(plugin.version || '0.0.0')}</span>
                  ${source ? `<span class="market-tag good">${source}${plugin.installedVersion ? ` · 本地 ${escapeHtml(plugin.installedVersion)}` : ''}</span>` : ''}
                </div>
                <div class="market-card-meta">
                  <span>作者：${escapeHtml(plugin.author || '未标注')}</span>
                  <span>⭐ ${plugin.stars === null || plugin.stars === undefined ? '—' : escapeHtml(formatNumber(plugin.stars))}</span>
                  <span>更新：${escapeHtml(formatTime(plugin.updatedAt))}</span>
                  ${hashTag}
                </div>
                <div class="market-card-desc">${escapeHtml(plugin.description || '暂无描述')}</div>
                ${tags ? `<div class="market-card-tags">${tags}</div>` : ''}
              </div>
              <div class="market-card-actions">
                <button class="market-btn ${plugin.status === 'update' || plugin.status === 'not-installed' ? 'primary' : ''}" data-market-install="${escapeHtml(plugin.id)}"${installDisabled ? ' disabled' : ''}>${installText}</button>
                <button class="market-btn" data-market-open-detail="${escapeHtml(plugin.id)}">详情</button>
                ${repoUrl ? `<a class="market-link" href="${escapeHtml(repoUrl)}" target="_blank" rel="noopener noreferrer">仓库</a>` : ''}
              </div>
            </div>
          </article>`
      }

      const renderList = () => {
        if (!el.list) return
        if (state.loading) {
          el.list.innerHTML = '<div class="market-loading">正在读取插件市场…</div>'
          return
        }
        if (state.error) {
          el.list.innerHTML = `<div class="market-error">${escapeHtml(state.error)}<br /><button class="market-btn" data-market-action="retry">重试</button></div>`
          return
        }
        if (!state.plugins.length) {
          el.list.innerHTML = '<div class="market-empty">没有找到插件。可以切换源、调整搜索条件，或点右上角「刷新」。</div>'
          return
        }
        el.list.innerHTML = state.plugins.map(cardHtml).join('')
      }

      const renderStats = () => {
        const source = state.source
        if (el.stats) {
          const parts = [`共 ${formatNumber(state.total)} 个插件`]
          if (source?.name) parts.push(`源：${source.name}`)
          if (state.fetchedAt) parts.push(`同步：${formatTime(state.fetchedAt)}`)
          if (state.stale) parts.push('当前为缓存数据')
          el.stats.textContent = parts.join(' · ')
        }
        if (el.warning) {
          if (state.warnings?.length) {
            el.warning.hidden = false
            el.warning.textContent = state.warnings.slice(0, 4).join('；')
          } else {
            el.warning.hidden = true
            el.warning.textContent = ''
          }
        }
      }

      const renderPager = () => {
        if (el.pageInfo) el.pageInfo.textContent = `第 ${state.page} / ${state.totalPages} 页`
        const prev = container.querySelector('[data-market-page="prev"]')
        const next = container.querySelector('[data-market-page="next"]')
        if (prev) prev.disabled = state.loading || state.page <= 1
        if (next) next.disabled = state.loading || state.page >= state.totalPages
      }

      const renderDetail = () => {
        if (!el.detail) return
        const detail = state.detail
        el.detail.hidden = !detail
        if (!detail) return
        if (state.detailLoading) {
          el.detailTitle.textContent = detail.name || detail.id || '插件详情'
          el.detailSub.textContent = ''
          el.detailMeta.innerHTML = ''
          el.detailBody.innerHTML = '<div class="market-loading">正在读取仓库 README 与作者信息…</div>'
          el.detailActions.innerHTML = ''
          return
        }
        const plugin = detail.plugin || detail
        const repo = detail.repo || plugin.repoInfo || null
        el.detailTitle.textContent = `${plugin.displayName || plugin.name || plugin.id}`
        el.detailSub.textContent = `${plugin.id}@${plugin.version || '0.0.0'}`
        el.detailMeta.innerHTML = [
          `作者：${escapeHtml(plugin.author || repo?.author || '未标注')}`,
          `⭐ ${plugin.stars === null || plugin.stars === undefined ? '—' : escapeHtml(formatNumber(plugin.stars))}`,
          `更新：${escapeHtml(formatTime(plugin.updatedAt))}`,
          plugin.license ? `许可证：${escapeHtml(plugin.license)}` : '',
          plugin.sha256 ? '<span class="market-tag good">SHA-256 已标注</span>' : '<span class="market-tag warn">未提供哈希</span>',
          plugin.repo && safeHttpUrl(plugin.repo) ? `<a class="market-link" href="${escapeHtml(safeHttpUrl(plugin.repo))}" target="_blank" rel="noopener noreferrer">仓库</a>` : '',
        ]
          .filter(Boolean)
          .map(item => (item.startsWith('<') ? item : `<span>${item}</span>`))
          .join('')
        if (state.detailError) {
          el.detailBody.innerHTML = `<div class="market-error">${escapeHtml(state.detailError)}</div>`
        } else if (detail.readme) {
          el.detailBody.innerHTML = markdown?.render ? markdown.render(detail.readme) : `<pre class="market-readme-plain">${escapeHtml(detail.readme)}</pre>`
        } else {
          el.detailBody.innerHTML = '<div class="market-empty">该插件暂未提供 README。</div>'
        }
        const installDisabled = state.busyId === plugin.id || plugin.status === 'newer'
        el.detailActions.innerHTML = `
          <button class="market-btn primary" data-market-install="${escapeHtml(plugin.id)}"${installDisabled ? ' disabled' : ''}>
            ${state.busyId === plugin.id ? '处理中…' : installLabelOf(plugin)}
          </button>
          <button class="market-btn" data-market-detail-close>关闭</button>`
      }

      const renderAll = () => {
        renderSources()
        renderList()
        renderStats()
        renderPager()
        renderDetail()
      }

      const loadSources = async () => {
        try {
          const info = await api.marketSources()
          if (Array.isArray(info?.sources) && info.sources.length) state.sources = info.sources
          else if (!state.sources.length) state.sources = [{ id: 'official', name: '念风官方插件源', official: true, builtin: true }]
          state.activeSourceId = info?.activeSourceId || 'official'
          renderSources()
        } catch (err) {
          if (!state.sources.length) state.sources = [{ id: 'official', name: '念风官方插件源', official: true, builtin: true }]
          state.error = `读取插件源失败：${err?.message || err}`
          renderSources()
        }
      }

      const loadPlugins = async ({ force = false, silent = false } = {}) => {
        if (!silent) {
          state.loading = true
          state.error = ''
          renderList()
          renderPager()
        }
        try {
          const data = await api.marketPlugins({
            sourceId: state.activeSourceId,
            q: state.q,
            sort: state.sort,
            order: state.order,
            page: state.page,
            pageSize: state.pageSize,
            refresh: force,
          })
          if (!data?.ok) throw new Error(data?.error || '加载插件列表失败')
          state.plugins = Array.isArray(data.plugins) ? data.plugins : []
          state.total = Number(data.total) || 0
          state.page = Number(data.page) || 1
          state.pageSize = Number(data.pageSize) || state.pageSize
          state.totalPages = Math.max(1, Number(data.totalPages) || 1)
          state.warnings = Array.isArray(data.warnings) ? data.warnings : []
          state.stale = data.stale === true
          state.fetchedAt = Number(data.fetchedAt) || 0
          state.source = data.source || null
          state.error = ''
        } catch (err) {
          state.error = `读取插件市场失败：${err?.message || err}`
          state.plugins = []
          state.total = 0
          state.totalPages = 1
        } finally {
          state.loading = false
          renderAll()
        }
      }

      const reloadActiveSource = async ({ force = false } = {}) => {
        await Promise.all([loadSources(), loadPlugins({ force })])
      }

      const openDetail = async id => {
        if (!id) return
        const existing = pluginOf(id)
        state.detail = { id, name: existing?.name || id, plugin: existing }
        state.detailLoading = true
        state.detailError = ''
        renderDetail()
        try {
          const data = await api.marketPlugin(id, state.activeSourceId)
          if (!data?.ok) throw new Error(data?.error || '读取插件详情失败')
          state.detail = { plugin: data.plugin, repo: data.repo || null, readme: String(data.readme || '') }
        } catch (err) {
          state.detailError = err?.message || String(err)
          state.detail = { plugin: existing || { id, name: id }, repo: null, readme: '' }
        } finally {
          state.detailLoading = false
          renderDetail()
        }
      }

      const installPlugin = async (id, options = {}) => {
        if (!id) return
        const plugin = pluginOf(id)
        if (!plugin) return
        if (state.busyId) return
        state.busyId = id
        renderList()
        renderDetail()
        try {
          const result = await api.marketInstall({
            sourceId: state.activeSourceId,
            id,
            overwrite: options.overwrite === true,
            allowUnverified: options.allowUnverified === true,
          })
          if (result?.requiresConfirmation) {
            state.busyId = ''
            renderList()
            renderDetail()
            const confirmed = await modal.confirm(
              '插件未提供哈希',
              `${result.error || '该插件未提供 SHA-256 哈希。'}\n\n继续安装将无法验证内容是否被篡改，是否仍要继续？`,
            )
            if (confirmed?.ok) return installPlugin(id, { ...options, allowUnverified: true })
            return
          }
          if (result?.exists) {
            state.busyId = ''
            renderList()
            renderDetail()
            const confirmed = await modal.confirm(
              '插件已存在',
              `${result.error || '插件目录已存在。'}\n\n覆盖安装会先删除同名的外部插件目录，是否继续？`,
            )
            if (confirmed?.ok) return installPlugin(id, { ...options, overwrite: true })
            return
          }
          if (!result?.ok) {
            if (result?.hashMismatch) toast.error(result.error || '插件哈希校验失败，已拒绝安装')
            else toast.error(result?.error || '插件安装失败')
            return
          }
          toast.success(`已安装「${plugin.displayName || plugin.name}」${plugin.version}${result.hashVerified ? ' · 哈希校验通过' : ' · 未校验哈希'}`)
          state.detail = null
          await loadPlugins({ silent: true })
        } catch (err) {
          toast.error(`插件安装失败：${err?.message || err}`)
        } finally {
          state.busyId = ''
          renderList()
          renderDetail()
        }
      }

      const addSource = async () => {
        const nameResult = await modal.prompt({ title: '添加插件源', placeholder: '例如：我的插件源', maxlength: 40 })
        if (!nameResult?.ok) return
        const urlResult = await modal.prompt({ title: '插件源地址', placeholder: '市场索引 JSON 或插件仓库地址', maxlength: 400 })
        if (!urlResult?.ok) return
        try {
          const result = await api.addMarketSource({ name: nameResult.value.trim(), url: urlResult.value.trim() })
          if (!result?.ok) {
            toast.error(result?.error || '添加插件源失败')
            return
          }
          toast.success('插件源已保存')
          await loadSources()
          await loadPlugins({ force: true })
        } catch (err) {
          toast.error(`添加插件源失败：${err?.message || err}`)
        }
      }

      const editSource = async () => {
        if (state.activeSourceId === 'official') {
          toast.info('官方源由程序内置，不能编辑')
          return
        }
        const current = state.sources.find(source => source.id === state.activeSourceId)
        if (!current) return
        const nameResult = await modal.prompt({ title: '编辑插件源名称', value: current.name || '', maxlength: 40 })
        if (!nameResult?.ok) return
        const urlResult = await modal.prompt({ title: '编辑插件源地址', value: current.url || '', maxlength: 400 })
        if (!urlResult?.ok) return
        try {
          const result = await api.updateMarketSource(current.id, { name: nameResult.value.trim(), url: urlResult.value.trim() })
          if (!result?.ok) {
            toast.error(result?.error || '保存插件源失败')
            return
          }
          toast.success('插件源已更新')
          await loadSources()
          await loadPlugins({ force: true })
        } catch (err) {
          toast.error(`保存插件源失败：${err?.message || err}`)
        }
      }

      const removeSource = async () => {
        if (state.activeSourceId === 'official') {
          toast.info('官方源不能删除')
          return
        }
        const current = state.sources.find(source => source.id === state.activeSourceId)
        if (!current) return
        const confirmed = await modal.confirm('删除插件源', `确定删除插件源「${current.name || current.id}」吗？不会卸载已经安装的插件。`)
        if (!confirmed?.ok) return
        try {
          const result = await api.removeMarketSource(current.id)
          if (!result?.ok) {
            toast.error(result?.error || '删除插件源失败')
            return
          }
          toast.success('插件源已删除')
          await loadSources()
          await loadPlugins({ force: true })
        } catch (err) {
          toast.error(`删除插件源失败：${err?.message || err}`)
        }
      }

      const refreshSource = async () => {
        try {
          const source = state.sources.find(item => item.id === state.activeSourceId)
          toast.info(`正在刷新「${source?.name || state.activeSourceId}」…`)
          const result = await api.marketRefresh(state.activeSourceId)
          if (!result?.ok) {
            toast.error(result?.error || '刷新插件源失败')
            return
          }
          await loadPlugins({ silent: true })
          toast.success(`刷新完成：共 ${result.total ?? state.total} 个插件`)
        } catch (err) {
          toast.error(`刷新插件源失败：${err?.message || err}`)
        }
      }

      const onClick = event => {
        const target = event.target
        if (!target?.closest) return
        const pageButton = target.closest('[data-market-page]')
        if (pageButton) {
          const action = pageButton.dataset.marketPage
          if (state.loading) return
          if (action === 'prev' && state.page > 1) {
            state.page -= 1
            loadPlugins({ silent: true })
          } else if (action === 'next' && state.page < state.totalPages) {
            state.page += 1
            loadPlugins({ silent: true })
          }
          return
        }
        const installButton = target.closest('[data-market-install]')
        if (installButton) {
          const id = String(installButton.dataset.marketInstall || '').trim()
          if (!id) return
          const plugin = pluginOf(id)
          installPlugin(id, { overwrite: plugin?.status !== 'not-installed' })
          return
        }
        const detailButton = target.closest('[data-market-open-detail]')
        if (detailButton) {
          const detailId = String(detailButton.dataset.marketOpenDetail || '').trim()
          if (detailId) openDetail(detailId)
          return
        }
        if (target.closest('[data-market-detail-close]')) {
          state.detail = null
          state.detailError = ''
          renderDetail()
          return
        }
        // 点击详情遮罩空白处也关闭，避免挡住后面的列表操作。
        if (el.detail && !el.detail.hidden && target === el.detail) {
          state.detail = null
          state.detailError = ''
          renderDetail()
          return
        }
        const actionButton = target.closest('[data-market-action]')
        if (!actionButton) return
        const action = actionButton.dataset.marketAction
        if (action === 'refresh') refreshSource()
        else if (action === 'add-source') addSource()
        else if (action === 'edit-source') editSource()
        else if (action === 'remove-source') removeSource()
        else if (action === 'retry') loadPlugins()
      }

      const onSourceChange = async () => {
        const id = el.source.value
        if (!id || id === state.activeSourceId) return
        try {
          const result = await api.activateMarketSource(id)
          if (!result?.ok) {
            toast.error(result?.error || '切换插件源失败')
            return
          }
          state.activeSourceId = id
          state.page = 1
          renderSources()
          await loadPlugins({ force: true })
          toast.success(`已切换到「${state.sources.find(source => source.id === id)?.name || id}」`)
        } catch (err) {
          toast.error(`切换插件源失败：${err?.message || err}`)
        }
      }

      const onSearchInput = () => {
        state.q = String(el.search.value || '').trim()
        state.page = 1
        if (searchTimer) clearTimeout(searchTimer)
        searchTimer = setTimeout(() => loadPlugins({ silent: true }), 320)
      }

      const onSortChange = () => {
        state.sort = el.sort.value
        state.page = 1
        loadPlugins({ silent: true })
      }

      const onOrderClick = () => {
        state.order = state.order === 'asc' ? 'desc' : 'asc'
        el.order.textContent = state.order === 'asc' ? '↑' : '↓'
        state.page = 1
        loadPlugins({ silent: true })
      }

      const onPageSizeChange = () => {
        state.pageSize = Number(el.pageSize.value) || 20
        state.page = 1
        loadPlugins({ silent: true })
      }

      container.addEventListener('click', onClick)
      el.source?.addEventListener('change', onSourceChange)
      el.search?.addEventListener('input', onSearchInput)
      el.sort?.addEventListener('change', onSortChange)
      el.order?.addEventListener('click', onOrderClick)
      el.pageSize?.addEventListener('change', onPageSizeChange)

      const bootstrap = async () => {
        if (typeof api.marketSources !== 'function' || typeof api.marketPlugins !== 'function') {
          state.error = '当前后端尚未加载插件市场服务，请重启念风后端后再试。'
          renderList()
          return
        }
        await loadSources()
        await loadPlugins({ force: true })
      }
      bootstrap()

      return () => {
        container.removeEventListener('click', onClick)
        el.source?.removeEventListener('change', onSourceChange)
        el.search?.removeEventListener('input', onSearchInput)
        el.sort?.removeEventListener('change', onSortChange)
        el.order?.removeEventListener('click', onOrderClick)
        el.pageSize?.removeEventListener('change', onPageSizeChange)
        if (searchTimer) clearTimeout(searchTimer)
      }
    },
  })

  ctx.provide('market-view', { name: 'market-view' }, { type: 'singleton' })
  ctx.logger.debug('插件市场视图就绪')
}
