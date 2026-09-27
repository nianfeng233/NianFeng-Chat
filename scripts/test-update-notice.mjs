/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * 更新弹窗回归测试。
 *
 * 用法：node scripts/test-update-notice.mjs
 *
 * 覆盖：
 *   - 检测到新版本时弹出更新公告，标题 / 更新内容 / 交流群 / 免费声明齐全；
 *   - 点击「暂不更新」后记住该 Release tag；
 *   - 同一个 tag 再次进入页面不再弹窗；
 *   - 发布更新的 tag 后仍会重新弹窗。
 */
import '../src/headless/dom-shim.mjs'
import { apply as applyWelcomeView } from '../plugins/views/welcome-view/index.mjs'

let failed = 0
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail })
  if (!ok) failed++
  console.log(`${ok ? '  ✔' : '  ✗'} ${name}${ok ? '' : `  → ${detail}`}`)
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const waitFor = async (fn, timeout = 5000) => {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeout) {
    const value = await fn()
    if (value) return value
    await sleep(40)
  }
  return null
}

const RELEASE_BODY = [
  '## 本次更新',
  '- 新增：更新公告弹窗，可滚动查看完整更新内容。',
  '- 修复：旧版本更新后残留启动窗口的问题。',
].join('\n')

const makeStorage = data => ({
  get(ns, key, fallback) {
    const bag = data[ns]
    return bag && Object.prototype.hasOwnProperty.call(bag, key) ? bag[key] : fallback
  },
  set(ns, key, value) {
    data[ns] = data[ns] || {}
    data[ns][key] = value
  },
  remove(ns, key) {
    if (data[ns]) delete data[ns][key]
  },
  has(ns, key) {
    return !!data[ns] && Object.prototype.hasOwnProperty.call(data[ns], key)
  },
  keys(ns) {
    return Object.keys(data[ns] || {})
  },
})

const makeRelease = (version, publishedAt = Date.now()) => ({
  tag: `v${version}`,
  version,
  name: `念风Chat v${version}`,
  prerelease: /-/.test(version),
  compatible: true,
  publishedAt,
  body: RELEASE_BODY,
  htmlUrl: `https://example.com/releases/v${version}`,
  asset: { name: `nianfeng-web-source-v${version}.zip`, size: 1024, url: 'https://example.com/a.zip' },
})

const createHarness = ({ storageData, releases, appVersion = '2.2.1-preview.5' }) => {
  const listeners = new Map()
  let registered = null
  const storage = makeStorage(storageData)
  const api = {
    get: async path => (path === '/version' ? { build: 'test-build' } : {}),
    appUpdateInfo: async () => ({ ok: true, version: appVersion, kind: 'web-source', kindLabel: 'Web 源码运行' }),
    appReleases: async () => ({ ok: true, releases, kindLabel: 'Web 源码运行' }),
    health: async () => ({ build: 'test-build' }),
  }
  const router = {
    active: () => 'welcome',
    has: () => true,
    get: () => ({ label: '欢迎', fullWidth: true, lazy: true }),
    list: () => [],
    switch: () => true,
    ready: () => {},
    isFullWidth: () => true,
    register: (id, definition) => {
      registered = definition
      return () => true
    },
  }
  const ctx = {
    id: 'welcome-view',
    meta: { plugin: { name: 'welcome-view' } },
    inject(name) {
      if (name === 'view-router') return router
      if (name === 'storage') return storage
      if (name === 'api') return api
      if (name === 'modal') return { confirm: async () => ({ ok: true }), open: async () => ({ ok: true }) }
      return undefined
    },
    provide() {},
    on(event, fn) {
      const list = listeners.get(event) || []
      list.push(fn)
      listeners.set(event, list)
      return () => {}
    },
    effect(fn) {
      try {
        const dispose = fn()
        return typeof dispose === 'function' ? dispose : () => {}
      } catch (_) {
        return () => {}
      }
    },
    emit() {},
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    registry: {
      get(id) {
        if (id === 'app') return { version: appVersion }
        return null
      },
    },
  }
  return {
    ctx,
    storage,
    mount() {
      const container = document.createElement('div')
      document.body.appendChild(container)
      applyWelcomeView(ctx)
      registered?.main?.(container, ctx)
      for (const fn of listeners.get('app:ready') || []) fn()
      return container
    },
  }
}

console.log('\n① 新版本弹出更新公告')
const firstData = { onboarding: { freeNoticeBuild: 'test-build', welcomeSeen: true } }
const firstReleases = () => [makeRelease('2.2.1', Date.now() - 60000), makeRelease('2.2.1-preview.6', Date.now())]
const first = createHarness({ storageData: firstData, releases: firstReleases() })
first.mount()
const firstMask = await waitFor(() => document.querySelector('[data-update-notice]'), 5000)
check('检测到新版本时弹出更新公告', !!firstMask)
const firstText = String(firstMask?.textContent || '')
check('弹窗标题包含新版本 tag', firstText.includes('v2.2.1-preview.6'), firstText.slice(0, 120))
check('弹窗展示可滚动更新内容', firstText.includes('新增：更新公告弹窗') && firstText.includes('修复：旧版本更新后残留启动窗口'))
check('弹窗顶部固定交流群号', firstText.includes('1109357470'))
check('弹窗顶部声明项目完全免费', firstText.includes('完全免费') && firstText.includes('付费购买'))
check('弹窗包含「暂不更新」和「前往更新」按钮', !!firstMask?.querySelector('[data-update-notice-close]') && !!firstMask?.querySelector('[data-update-notice-go]'))

console.log('\n② 暂不更新后记住该版本')
firstMask?.querySelector('[data-update-notice-close]')?.dispatchEvent({ type: 'click' })
await sleep(80)
check('点击暂不更新后弹窗关闭', !document.querySelector('[data-update-notice]'))
check('已记住当前提示的 Release tag', firstStorageTag(firstData) === 'v2.2.1-preview.6', firstStorageTag(firstData))

console.log('\n③ 同一版本再次进入不再弹窗')
const second = createHarness({ storageData: firstData, releases: firstReleases() })
second.mount()
await sleep(700)
check('同一 tag 第二次进入不再弹窗', !document.querySelector('[data-update-notice]'))

console.log('\n④ 发布更新的 tag 后重新弹窗')
const third = createHarness({ storageData: firstData, releases: [makeRelease('2.2.1-preview.7')] })
third.mount()
const thirdMask = await waitFor(() => document.querySelector('[data-update-notice]'), 5000)
check('更新的 tag 会重新弹窗', !!thirdMask)
check('弹窗标题切换到了新 tag', String(thirdMask?.textContent || '').includes('v2.2.1-preview.7'))

function firstStorageTag(data) {
  return String(data?.onboarding?.updateNoticeDismissedTag || '')
}

const failedChecks = results.filter(item => !item.ok)
console.log(`\n结果：${results.length - failedChecks.length}/${results.length} 项通过`)
process.exit(failedChecks.length ? 1 : 0)
