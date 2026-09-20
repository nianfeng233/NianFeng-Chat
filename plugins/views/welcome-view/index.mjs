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
export const version = '1.0.0'
export const displayName = '视图 · 欢迎'
export const description = '独立视图：项目介绍、官方仓库 / QQ 群与免费开源声明，首次打开 WebUI 自动进入。'
export const author = '念风内核'
export const icon = '👋'
export const core = true
export const enabled = true
export const depends = {
  'storage': '^1.0.0',
  'view-router': '^1.0.0',
}
export const optionalDepends = {}
export const inject = ['storage', 'view-router']
export const provides = [{ name: 'welcome-view', type: 'singleton' }]

import { useStyle } from '../../../src/util/style.mjs'
import { escapeHtml } from '../../../src/util/format.mjs'
import { BRAND_LOGO } from '../../../src/util/identity.mjs'
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
