/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * V? · welcome-view
 * 「欢迎」独立视图：项目本体介绍、官方仓库 / 官方 QQ 群、免费开源声明。
 *
 * 首次部署且首次打开 WebUI 时自动切换到本页；之后可从侧栏「欢迎」入口随时查看。
 * 首次标记只写入本机 storage，不上报到后端 preferences，避免不同浏览器 / 设备
 * 因为共享偏好而互相覆盖。
 */
export const name = 'welcome-view'
export const version = '1.1.0'
export const displayName = '视图 · 欢迎'
export const description = '独立视图：项目介绍、本体版本更新 / 重启、官方仓库 / QQ 群与免费开源声明。'
export const author = '念风内核'
export const icon = '👋'
export const core = true
export const enabled = true
export const depends = {
  'backend-client': '^1.0.0',
  'modal-host': '^1.0.0',
  'storage': '^1.0.0',
  'view-router': '^1.0.0',
}
export const optionalDepends = {}
export const inject = ['api', 'modal', 'storage', 'view-router']
export const provides = [{ name: 'welcome-view', type: 'singleton' }]

import { useStyle } from '../../../src/util/style.mjs'
import { escapeHtml } from '../../../src/util/format.mjs'
import { BRAND_LOGO } from '../../../src/util/identity.mjs'
import { compareVersions } from '../../../src/runtime/semver.mjs'
import {
  PROJECT_FULL_NAME,
  PROJECT_LICENSE,
  PROJECT_NAME,
  PROJECT_QQ_GROUP,
  PROJECT_REPO,
  PROJECT_TAGLINE,
} from '../../../src/shared/project-info.mjs'
import { WELCOME_CSS } from './style.mjs'

const SEEN_NS = 'onboarding'
const SEEN_KEY = 'welcomeSeen'
const UPDATE_SOURCE_KEY = 'appUpdate.source'
const MAINTENANCE_KEY = 'nianfeng:maintenance'

const formatBytes = value => {
  const size = Number(value) || 0
  if (size <= 0) return ''
  if (size >= 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`
  if (size >= 1024) return `${Math.round(size / 1024)} KB`
  return `${size} B`
}

const readUpdateSource = () => {
  try {
    return localStorage.getItem(UPDATE_SOURCE_KEY) === 'official' ? 'official' : 'mirror'
  } catch (_) {
    return 'mirror'
  }
}

const saveUpdateSource = source => {
  try {
    localStorage.setItem(UPDATE_SOURCE_KEY, source === 'official' ? 'official' : 'mirror')
  } catch (_) {
    /* storage 不可用时仅当前会话生效 */
  }
}

const writeMaintenance = (type, kind) => {
  try {
    localStorage.setItem(MAINTENANCE_KEY, JSON.stringify({ type, kind, at: Date.now() }))
  } catch (_) {
    /* ignore */
  }
}

const clearMaintenance = () => {
  try {
    localStorage.removeItem(MAINTENANCE_KEY)
  } catch (_) {
    /* ignore */
  }
}

let maintenanceOverlay = null

const removeMaintenanceOverlay = () => {
  try {
    maintenanceOverlay?.remove?.()
  } catch (_) {
    /* ignore */
  }
  maintenanceOverlay = null
}

const showMaintenanceOverlay = (title, tip) => {
  removeMaintenanceOverlay()
  const overlay = document.createElement('div')
  overlay.className = 'app-maintenance-overlay'
  overlay.innerHTML = `
    <div class="app-maintenance-card">
      <div class="app-maintenance-spinner"></div>
      <div class="app-maintenance-title">${escapeHtml(title)}</div>
      <div class="app-maintenance-tip">${escapeHtml(tip)}</div>
    </div>`
  document.body.appendChild(overlay)
  maintenanceOverlay = overlay
}

const pollBackendAndReload = kind => {
  let sawOffline = false
  const startedAt = Date.now()
  const tick = async () => {
    if (Date.now() - startedAt > 30 * 60 * 1000) return
    try {
      const response = await fetch(`/api/health?ts=${Date.now()}`, {
        cache: 'no-store',
        signal: typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(4000) : undefined,
      })
      if (response.ok) {
        // 正常情况下至少会看到旧服务离线一次；6 秒内既没离线也没重启完成，
        // 说明本次操作没有真正触发，直接恢复页面而不是无限停在加载动画里。
        if (kind === 'desktop' || sawOffline || Date.now() - startedAt > 6000) {
          clearMaintenance()
          removeMaintenanceOverlay()
          location.reload()
          return
        }
      } else {
        sawOffline = true
      }
    } catch (_) {
      sawOffline = true
    }
    setTimeout(tick, 1500)
  }
  setTimeout(tick, 1000)
}

/** 本项目本体的主要组成部分；按需求不介绍外部扩展插件。 */
const PROJECT_PARTS = [
  {
    icon: '🧩',
    title: '前端 WebUI',
    text: '真实 cordis v4 内核驱动的插件化界面：视图、侧栏、设置、主题、快捷键、插槽与通知都由插件注册，外观和交互可以按插件组合替换。',
  },
  {
    icon: '🖥️',
    title: 'Node 本地后端',
    text: 'Node.js + cordis 组成的本地后端，提供模型接入、会话与消息持久化、HTTP / SSE 通信，以及文档、图片和文件服务。',
  },
  {
    icon: '🤖',
    title: '服务端常驻代聊',
    text: '后端内置服务端代聊：关闭 WebUI 后仍会继续接收、处理并回复消息，聊天链路、记忆和渠道收发不会中断。',
  },
  {
    icon: '🧠',
    title: '对话与记忆',
    text: '消息全量落盘；工作记忆按最近轮次注入，长期记忆压缩后做向量 / 关键词混合检索，长资料按需分段读取。',
  },
  {
    icon: '🔌',
    title: '渠道接入框架',
    text: '内置渠道接入框架，可把聊天接入微信 clawbot、NapCat / OneBot、QQ 机器人等平台，并逐渠道配置权限与触发规则。',
  },
  {
    icon: '🔒',
    title: '数据与隐私',
    text: '数据目录可外置，API Key、会话、记忆和配置都由用户自行保存；默认仅监听本机，模型服务在设置中按需配置。',
  },
]

const renderProjectParts = () =>
  PROJECT_PARTS.map(
    part => `
      <article class="welcome-card">
        <div class="welcome-card-icon">${part.icon}</div>
        <h3 class="welcome-card-title">${part.title}</h3>
        <p class="welcome-card-text">${part.text}</p>
      </article>`,
  ).join('')

/** 复制文本：优先 Clipboard API，不可用时退回 textarea + execCommand。 */
async function copyText(text) {
  const value = String(text ?? '')
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value)
      return
    } catch (_) {
      // 无权限 / 非安全上下文时继续走下面的 textarea 兜底。
    }
  }
  const area = document.createElement('textarea')
  area.value = value
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.left = '-9999px'
  area.style.opacity = '0'
  document.body.appendChild(area)
  area.select()
  let ok = false
  try {
    ok = document.execCommand?.('copy') === true
  } finally {
    area.remove()
  }
  if (!ok) throw new Error('当前环境不支持自动复制')
}

export function apply(ctx) {
  const router = ctx.inject('view-router')
  const storage = ctx.inject('storage')
  const api = ctx.inject('api')
  const modal = ctx.inject('modal')

  useStyle(ctx, WELCOME_CSS)

  router.register('welcome', {
    label: '欢迎',
    // 放在会话 / 渠道前面，作为首次启动的引导入口。
    order: 5,
    icon: '👋',
    rail: true,
    // 与记忆库 / 日志页一致：直接使用整个主面板，不显示左侧空列表。
    fullWidth: true,
    // 第一次切到欢迎页时才渲染内容，避免启动阶段做无用工作。
    lazy: true,
    main(container) {
      const appVersion = String(ctx.registry.get('app')?.version || '').trim()
      const versionLabel = appVersion ? `v${appVersion}` : '开发版'

      // 页面一旦真正展示，即视为用户已经看过欢迎页。
      try {
        storage.set(SEEN_NS, SEEN_KEY, true)
      } catch (err) {
        ctx.logger.debug(`写入欢迎页浏览标记失败：${err?.message || err}`)
      }

      container.innerHTML = `
        <div class="welcome-page">
          <div class="welcome-inner">
            <header class="welcome-hero">
              <img class="welcome-logo" src="${BRAND_LOGO}" alt="${escapeHtml(PROJECT_NAME)} logo" />
              <div class="welcome-headline">
                <div class="welcome-kicker">NIANFENG-CHAT</div>
                <h1 class="welcome-title">${PROJECT_NAME}</h1>
                <p class="welcome-sub">${PROJECT_TAGLINE} · cordis v4 内核 + Node 本地后端</p>
                <div class="welcome-tags">
                  <span class="welcome-tag accent">${escapeHtml(versionLabel)}</span>
                  <span class="welcome-tag">${PROJECT_LICENSE}</span>
                  <span class="welcome-tag">本地优先</span>
                  <span class="welcome-tag">插件化</span>
                  <span class="welcome-tag">免费开源</span>
                </div>
              </div>
            </header>

            <p class="welcome-firstrun-tip">首次部署打开 WebUI 时会自动跳转到本页；之后可随时从侧栏「欢迎」入口再次打开。</p>

            <section class="welcome-section welcome-update-section">
              <div class="welcome-section-head">
                <div class="welcome-section-title">版本与更新</div>
                <div class="welcome-section-desc">默认国内镜像源；可切换 GitHub 官方源，按 Release 升级或降级；自动识别 Web / EXE</div>
              </div>
              <div class="welcome-update-card">
                <div class="welcome-update-row">
                  <div class="welcome-update-label">更新源</div>
                  <select class="welcome-update-select" data-update-source>
                    <option value="mirror">国内 GitHub 镜像源（默认）</option>
                    <option value="official">GitHub 官方源</option>
                  </select>
                  <button class="welcome-copy" type="button" data-update-refresh>刷新版本</button>
                </div>
                <div class="welcome-update-row">
                  <div class="welcome-update-label">当前版本</div>
                  <div class="welcome-update-current" data-update-current>读取中…</div>
                </div>
                <div class="welcome-update-row">
                  <div class="welcome-update-label">目标版本</div>
                  <select class="welcome-update-select" data-update-release disabled><option value="">正在读取 Releases…</option></select>
                  <button class="welcome-update-run" type="button" data-update-run disabled>更新</button>
                </div>
                <div class="welcome-update-note" data-update-note>正在读取当前版本与 Release 列表…</div>
                <div class="welcome-update-actions">
                  <button class="welcome-update-restart" type="button" data-app-restart>重启念风</button>
                  <span class="welcome-update-actions-tip">更新 / 重启会完全关闭当前项目，随后自动重新运行</span>
                </div>
                <div class="welcome-update-repo">
                  <a class="welcome-link" href="${PROJECT_REPO}/releases" target="_blank" rel="noopener noreferrer">${PROJECT_REPO}/releases</a>
                </div>
              </div>
            </section>

            <section class="welcome-section">
              <div class="welcome-section-head">
                <div class="welcome-section-title">项目本体</div>
                <div class="welcome-section-desc">下面只介绍念风本体的各个组成部分</div>
              </div>
              <div class="welcome-grid">${renderProjectParts()}</div>
            </section>

            <section class="welcome-section">
              <div class="welcome-section-head">
                <div class="welcome-section-title">资源与交流</div>
                <div class="welcome-section-desc">请从官方渠道获取源码与安装包</div>
              </div>
              <div class="welcome-grid">
                <article class="welcome-card welcome-resource-card">
                  <div class="welcome-resource-head">
                    <span class="welcome-card-icon">🐙</span>
                    <div>
                      <h3 class="welcome-card-title">GitHub 仓库</h3>
                      <p class="welcome-resource-desc">源码、版本更新、功能建议与问题反馈</p>
                    </div>
                  </div>
                  <a class="welcome-link" href="${PROJECT_REPO}" target="_blank" rel="noopener noreferrer">${PROJECT_REPO}</a>
                  <button class="welcome-copy" type="button" data-welcome-copy="${PROJECT_REPO}">复制仓库地址</button>
                </article>

                <article class="welcome-card welcome-resource-card">
                  <div class="welcome-resource-head">
                    <span class="welcome-card-icon">💬</span>
                    <div>
                      <h3 class="welcome-card-title">官方 QQ 群</h3>
                      <p class="welcome-resource-desc">使用答疑、版本通知与问题反馈</p>
                    </div>
                  </div>
                  <div class="welcome-qq">${PROJECT_QQ_GROUP}</div>
                  <button class="welcome-copy" type="button" data-welcome-copy="${PROJECT_QQ_GROUP}">复制群号</button>
                </article>
              </div>
            </section>

            <section class="welcome-section">
              <div class="welcome-notice">
                <div class="welcome-notice-title">
                  <span class="welcome-notice-badge">免费开源</span>
                  <h2>本项目完全免费，请勿付费购买</h2>
                </div>
                <p>念风 Chat 的全部代码均以 ${PROJECT_LICENSE} 免费开源发布，官方不提供任何收费版本，也不会以个人收款等方式售卖安装包或部署服务。</p>
                <p class="welcome-notice-warn">如果你是通过付费购买获得本项目，请立即申请退款，并向交易平台和卖家举报；遇到倒卖、捆绑收费或冒充官方，欢迎向我们提供线索。</p>
                <ul class="welcome-notice-list">
                  <li>安装包请只从官方 GitHub 仓库或官方 QQ 群获取，谨防二次打包和木马捆绑。</li>
                  <li>发现倒卖、收费代部署或冒充官方收费的行为，可通过 GitHub Issue 或官方 QQ 群举报。</li>
                  <li>开源项目维护不易，如果念风对你有帮助，欢迎到仓库点一个 Star 支持。</li>
                </ul>
              </div>
            </section>

            <footer class="welcome-footer">
              <span>${PROJECT_FULL_NAME}</span>
              <span>${PROJECT_LICENSE} · 免费开源发布</span>
            </footer>
          </div>
        </div>`

        const updateEls = {
          source: container.querySelector('[data-update-source]'),
          refresh: container.querySelector('[data-update-refresh]'),
          current: container.querySelector('[data-update-current]'),
          release: container.querySelector('[data-update-release]'),
          run: container.querySelector('[data-update-run]'),
          note: container.querySelector('[data-update-note]'),
          restart: container.querySelector('[data-app-restart]'),
        }
        const updateState = {
          info: null,
          source: readUpdateSource(),
          releases: [],
          selectedTag: '',
          loading: false,
          loadSeq: 0,
          busy: false,
        }

        const setUpdateNote = text => {
          if (updateEls.note) updateEls.note.textContent = String(text || '')
        }

        const selectedRelease = () => updateState.releases.find(item => item.tag === updateState.selectedTag) || null
        const currentVersion = () => String(updateState.info?.version || appVersion || '').replace(/^v/i, '')
        const kindLabel = () => updateState.info?.kindLabel || '当前版本'
        const runtimeKind = () =>
          updateState.info?.kind || (typeof window.windHost?.window === 'function' ? 'desktop' : 'web')

        const renderCurrent = () => {
          if (!updateEls.current) return
          if (!updateState.info) {
            updateEls.current.textContent = versionLabel
            return
          }
          updateEls.current.textContent = `v${updateState.info.version || appVersion} · ${updateState.info.kindLabel || 'Web'}`
          if (updateEls.restart) updateEls.restart.disabled = updateState.info.restartSupported === false
        }

        const syncUpdateButtons = () => {
          const release = selectedRelease()
          const target = String(release?.version || '').replace(/^v/i, '')
          const current = currentVersion()
          const canRun = updateState.info?.updateSupported !== false
          const runnable = canRun && !!release && release.compatible !== false && target !== current
          if (updateEls.run) {
            updateEls.run.disabled = !runnable
            if (!release) updateEls.run.textContent = '更新'
            else if (!release.compatible) updateEls.run.textContent = '无安装包'
            else if (target === current) updateEls.run.textContent = '已是当前版本'
            else {
              const compared = compareVersions(target, current)
              updateEls.run.textContent = Number.isFinite(compared) && compared < 0 ? `降级到 ${release.tag}` : `更新到 ${release.tag}`
            }
          }
          if (!release) {
            setUpdateNote('请选择要安装的 Release。')
            return
          }
          if (!release.compatible) {
            setUpdateNote(`Release ${release.tag} 没有适配当前运行方式（${kindLabel()}）的安装包。`)
            return
          }
          if (!canRun) {
            setUpdateNote(`当前运行方式（${kindLabel()}）仅支持查看版本，请手动替换安装。`)
            return
          }
          const compared = compareVersions(target, current)
          const action = Number.isFinite(compared) && compared < 0 ? '降级' : '更新'
          const assetSize = formatBytes(release.asset?.size)
          const assetInfo = release.asset?.name ? ` · 安装包 ${release.asset.name}${assetSize ? `（${assetSize}）` : ''}` : ''
          setUpdateNote(`目标 ${release.tag}（${action}）${assetInfo}；点击按钮后会自动关闭当前项目，完成后自动重新运行。`)
        }

        const renderReleases = () => {
          if (!updateEls.release) return
          const select = updateEls.release
          const releases = updateState.releases
          select.innerHTML = ''
          if (!releases.length) {
            const option = document.createElement('option')
            option.value = ''
            option.textContent = '没有读取到可用 Release'
            select.appendChild(option)
            select.disabled = true
            updateState.selectedTag = ''
            syncUpdateButtons()
            return
          }
          const versionOfCurrent = currentVersion()
          if (!updateState.selectedTag || !releases.some(item => item.tag === updateState.selectedTag)) {
            const preferred =
              releases.find(item => item.version === versionOfCurrent && item.compatible) ||
              releases.find(item => item.compatible) ||
              releases[0]
            updateState.selectedTag = preferred?.tag || ''
          }
          for (const release of releases) {
            const option = document.createElement('option')
            option.value = release.tag
            option.disabled = release.compatible === false
            const flags = []
            if (release.version === versionOfCurrent) flags.push('当前')
            if (release.prerelease) flags.push('预览')
            if (release.compatible === false) flags.push('无当前平台安装包')
            option.textContent = `${release.tag}${flags.length ? ` · ${flags.join(' · ')}` : ''}`
            select.appendChild(option)
          }
          select.disabled = false
          select.value = updateState.selectedTag
          syncUpdateButtons()
        }

        const loadVersions = async (force = false) => {
          const seq = ++updateState.loadSeq
          updateState.loading = true
          if (updateEls.release) {
            updateEls.release.disabled = true
            updateEls.release.innerHTML = '<option value="">正在读取 Releases…</option>'
          }
          setUpdateNote(force ? '正在刷新 GitHub Release 列表…' : '正在读取 GitHub Release 列表…')
          try {
            const data = await api.appReleases(updateState.source, force)
            if (seq !== updateState.loadSeq) return
            updateState.releases = Array.isArray(data?.releases) ? data.releases : []
            renderReleases()
            if (data?.stale) setUpdateNote(`网络暂时不可用，展示的是缓存版本列表：${data.warning || '请稍后刷新'}`)
          } catch (err) {
            if (seq !== updateState.loadSeq) return
            updateState.releases = []
            renderReleases()
            setUpdateNote(`读取 GitHub Release 失败：${err?.message || err}`)
          } finally {
            if (seq === updateState.loadSeq) updateState.loading = false
          }
        }

        const initUpdate = async () => {
          if (updateEls.source) updateEls.source.value = updateState.source
          try {
            updateState.info = await api.appUpdateInfo()
          } catch (err) {
            updateState.releases = []
            renderCurrent()
            renderReleases()
            setUpdateNote(`读取当前版本信息失败：${err?.message || err}（旧后端可能尚未加载本体更新服务，请重启后再试）`)
            return
          }
          renderCurrent()
          await loadVersions(false)
        }

        const updateErrorMessage = err => String(err?.message || err || '未知错误')

        const beginUpdate = async () => {
          if (updateState.busy) return
          const release = selectedRelease()
          if (!release || release.compatible === false) return
          const compared = compareVersions(String(release.version).replace(/^v/i, ''), currentVersion())
          const downgrade = Number.isFinite(compared) && compared < 0
          const answer = await modal.confirm(
            downgrade ? '降级念风？' : '更新念风？',
            `将完全关闭当前${kindLabel()}，${downgrade ? '降级' : '更新'}到 ${release.tag}，完成后自动重新运行。\n\n更新期间请保持此页面打开，加载动画结束后会自动刷新。`,
          )
          if (!answer?.ok) return
          updateState.busy = true

          writeMaintenance('update', runtimeKind())
          showMaintenanceOverlay(
            downgrade ? '正在降级念风' : '正在更新念风',
            `当前项目已完全关闭，正在下载并替换为 ${release.tag}；完成后会自动加载新版本…`,
          )
          if (updateEls.run) updateEls.run.disabled = true
          try {
            await api.appUpdate({ tag: release.tag, source: updateState.source })
          } catch (err) {
            if (err?.status) {
              updateState.busy = false
              clearMaintenance()
              removeMaintenanceOverlay()
              await modal.open({ title: '更新未开始', description: updateErrorMessage(err), hideCancel: true, confirmText: '知道了' })
              syncUpdateButtons()
              return
            }
            // 连接被旧进程主动切断属于预期流程，继续等待新后端恢复。
          }
          pollBackendAndReload(runtimeKind())
        }

        const restartApp = async () => {
          if (updateState.busy) return
          const answer = await modal.confirm('重启念风？', '将完全关闭当前项目，然后自动重新运行。\n\n重启期间请保持此页面打开，服务恢复后会自动刷新。')
          if (!answer?.ok) return
          updateState.busy = true
          const kind = runtimeKind()
          writeMaintenance('restart', kind)
          showMaintenanceOverlay('正在重启念风', '当前项目已完全关闭，正在等待服务恢复；完成后会自动加载…')

          if (kind === 'desktop' && typeof window.windHost?.restart === 'function') {
            try {
              window.windHost.restart()
              return
            } catch (err) {
              ctx.logger.debug(`桌面宿主重启调用失败，改用后端接口：${err?.message || err}`)
            }
          }

          try {
            await api.appRestart()
          } catch (err) {
            if (err?.status) {
              updateState.busy = false
              clearMaintenance()
              removeMaintenanceOverlay()
              await modal.open({ title: '重启未开始', description: updateErrorMessage(err), hideCancel: true, confirmText: '知道了' })
              return
            }
          }
          pollBackendAndReload(kind)
        }

        const onUpdateClick = event => {
          const target = event.target.closest('[data-update-refresh], [data-update-run], [data-app-restart]')
          if (!target || !container.contains(target)) return
          if (target.matches('[data-update-refresh]')) {
            loadVersions(true)
            return
          }
          if (target.matches('[data-update-run]')) {
            beginUpdate().catch(err => ctx.logger.error(`触发更新失败：${err?.message || err}`))
            return
          }
          if (target.matches('[data-app-restart]')) {
            restartApp().catch(err => ctx.logger.error(`触发重启失败：${err?.message || err}`))
          }
        }

        const onUpdateChange = event => {
          if (event.target.matches('[data-update-source]')) {
            updateState.source = event.target.value === 'official' ? 'official' : 'mirror'
            saveUpdateSource(updateState.source)
            updateState.selectedTag = ''
            loadVersions(true)
            return
          }
          if (event.target.matches('[data-update-release]')) {
            updateState.selectedTag = event.target.value
            syncUpdateButtons()
          }
        }

        container.addEventListener('click', onUpdateClick)
        container.addEventListener('change', onUpdateChange)
        initUpdate()

        const copyTimers = new Map()
        const onClick = async event => {
        const button = event.target.closest('[data-welcome-copy]')
        if (!button) return
        const text = button.dataset.welcomeCopy || ''
        if (!text) return

        const previous = copyTimers.get(button)
        if (previous) {
          clearTimeout(previous.timer)
          button.textContent = previous.label
          button.classList.remove('copied')
          copyTimers.delete(button)
        }

        try {
          await copyText(text)
        } catch (err) {
          ctx.logger.debug(`复制失败：${err?.message || err}`)
          return
        }

        const label = button.textContent
        button.textContent = '已复制'
        button.classList.add('copied')
        const timer = setTimeout(() => {
          button.textContent = label
          button.classList.remove('copied')
          copyTimers.delete(button)
        }, 1600)
        copyTimers.set(button, { timer, label })
      }

      container.addEventListener('click', onClick)
      return () => {
        container.removeEventListener('click', onClick)
        container.removeEventListener('click', onUpdateClick)
        container.removeEventListener('change', onUpdateChange)
        for (const { timer } of copyTimers.values()) clearTimeout(timer)
        copyTimers.clear()
      }
    },
  })

  ctx.provide('welcome-view', { name: 'welcome-view' }, { type: 'singleton' })

  /**
   * 首次部署且首次打开 WebUI 时自动跳到欢迎页。
   * 标记写在 storage（浏览器 localStorage），刷新后不再重复跳转；
   * 欢迎页本身始终保留在侧栏，用户可随时手动打开。
   */
  let opened = false
  const openFirstRunWelcome = () => {
    if (opened) return
    if (storage.get(SEEN_NS, SEEN_KEY, false) === true) return
    if (!router.has('welcome')) return
    opened = true
    if (router.active() === 'welcome') return
    try {
      router.switch('welcome')
    } catch (err) {
      opened = false
      ctx.logger.debug(`首次打开欢迎页失败：${err?.message || err}`)
    }
  }

  ctx.on('app:ready', openFirstRunWelcome)
  // 兜底：某些启动路径不会广播 app:ready，直接在插件加载完成后尝试一次。
  queueMicrotask(openFirstRunWelcome)

  ctx.logger.debug('欢迎页就绪')
}
