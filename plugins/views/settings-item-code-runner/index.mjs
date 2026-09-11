/**
 * 设置项 · 代码运行器
 *
 * 在浏览器 Web Worker 里运行 JavaScript 片段：
 *   - 独立线程，无 DOM
 *   - 禁用 fetch / XMLHttpRequest / WebSocket / Worker / importScripts，不产生网络请求
 *   - 5 秒超时自动终止，可手动停止
 *
 * 不提供 Python / Node / 系统命令执行——那需要真正的系统级沙箱。
 */
export const name = 'settings-item-code-runner'
export const version = '1.0.0'
export const displayName = '设置项 · 代码运行器'
export const description = '设置页 · 在无 DOM / 无网络的 Web Worker 沙箱里运行 JavaScript 片段。'
export const author = '风语内核'
export const icon = '⚡'
export const core = false
export const depends = { 'settings-container': '^1.0.0', permissions: '^1.0.0' }
export const inject = ['settings-container', 'toast']
export const permissions = ["code-execution"]
export const provides = []

import { page, section, card } from '../../../src/util/settings.mjs'
import { icons } from '../../../src/util/icons.mjs'
import { escapeHtml } from '../../../src/util/format.mjs'
import { useStyle } from '../../../src/util/style.mjs'
import { CODE_RUNNER_CSS } from './style.mjs'

const SAMPLE = `// 运行在 Worker 沙箱：无 DOM、无网络、5 秒超时
const fib = n => (n < 2 ? n : fib(n - 1) + fib(n - 2))
console.log('fib(10) =', fib(10))
console.warn('这里是一条 warn')
console.error('这里是一条 error')
JSON.stringify({ ok: true, items: [1, 2, 3], time: new Date().toISOString() })`

const WORKER_SOURCE = `
self.onmessage = event => {
  const fmt = value => {
    if (typeof value === 'string') return value
    try { return JSON.stringify(value, null, 2) } catch (_) { return String(value) }
  }
  const post = (type, text) => self.postMessage({ type, text })
  console.log = (...args) => post('log', args.map(fmt).join(' '))
  console.warn = (...args) => post('warn', args.map(fmt).join(' '))
  console.error = (...args) => post('error', args.map(fmt).join(' '))
  self.fetch = () => { throw new Error('沙箱禁止网络请求（fetch）') }
  self.XMLHttpRequest = function () { throw new Error('沙箱禁止网络请求（XMLHttpRequest）') }
  self.importScripts = () => { throw new Error('沙箱禁止加载外部脚本（importScripts）') }
  const blocked = name => function () { throw new Error('沙箱禁止网络能力（' + name + '）') }
  self.WebSocket = blocked('WebSocket')
  self.EventSource = blocked('EventSource')
  self.Worker = blocked('Worker')
  self.SharedWorker = blocked('SharedWorker')
  try { self.navigator.sendBeacon = blocked('sendBeacon') } catch (_) {}
  try {
    const result = (0, eval)(event.data.code)
    if (result !== undefined) post('result', fmt(result))
    post('done', '')
  } catch (err) {
    post('error', String((err && err.stack) || err))
    post('done', '')
  }
}
`

export function apply(ctx) {
  const pages = ctx.inject('settings-container')
  const toast = ctx.inject('toast')

  useStyle(ctx, CODE_RUNNER_CSS)

  pages.register({
    id: 'code-runner',
    group: '其他',
    groupOrder: 50,
    label: '代码运行器',
    icon: icons.bolt,
    order: 115,
    render(container) {
      let worker = null
      let workerUrl = ''
      let timer = null

      container.innerHTML = page('代码运行器', '在独立 Worker 沙箱里运行 JavaScript 片段；没有 DOM，也发不出网络请求。', `
        ${section('JavaScript 沙箱', card(`
          <div class="coder-toolbar">
            <span class="coder-hint">Worker 沙箱 · 无 DOM · 禁止网络 · 5 秒超时</span>
            <div class="coder-actions">
              <button class="outline-btn" data-action="clear">清空输出</button>
              <button class="outline-btn danger-btn" data-action="stop" disabled>停止</button>
              <button class="outline-btn primary-soft" data-action="run">运行</button>
            </div>
          </div>
          <textarea class="coder-editor" data-role="code" spellcheck="false">${escapeHtml(SAMPLE)}</textarea>
          <div class="coder-output-head"><span>输出</span><span data-role="status">就绪</span></div>
          <pre class="coder-output" data-role="output" data-empty="运行结果会显示在这里"></pre>`))}
        <div class="settings-note">
          这是浏览器内可安全终止的 JavaScript 片段运行器：适合算例、JSON 处理、正则验证等。
          不提供 Python / Node / 系统命令执行——那需要独立的操作系统级沙箱，目前不在客户端内实现。
        </div>`)

      const output = container.querySelector('[data-role="output"]')
      const status = container.querySelector('[data-role="status"]')
      const code = container.querySelector('[data-role="code"]')
      const stopBtn = container.querySelector('[data-action="stop"]')
      const runBtn = container.querySelector('[data-action="run"]')

      const setStatus = text => {
        if (status) status.textContent = text
      }
      const append = text => {
        if (!output) return
        output.dataset.empty = ''
        output.textContent += text
        output.scrollTop = output.scrollHeight
      }
      const cleanupWorker = (updateButtons = true) => {
        if (timer) {
          clearTimeout(timer)
          timer = null
        }
        if (worker) {
          try {
            worker.terminate()
          } catch (_) {
            /* ignore */
          }
          worker = null
        }
        if (workerUrl) {
          try {
            URL.revokeObjectURL(workerUrl)
          } catch (_) {
            /* ignore */
          }
          workerUrl = ''
        }
        if (updateButtons) {
          if (stopBtn) stopBtn.disabled = true
          if (runBtn) runBtn.disabled = false
        }
      }

      const stop = (updateButtons = true) => {
        cleanupWorker(updateButtons)
        setStatus('已停止')
      }

      const run = () => {
        const permissions = ctx.registry.get('permissions')
        const pluginId = ctx.meta?.plugin?.name || 'settings-item-code-runner'
        if (permissions && !permissions.isGranted(pluginId, 'code-execution')) {
          toast.error('「代码运行器」的运行权限被拒绝：可在 设置 → 隐私 → 插件权限 中允许。')
          return
        }
        if (typeof Worker === 'undefined' || typeof Blob === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
          toast.error('当前环境不支持 Web Worker，无法运行代码片段')
          return
        }
        cleanupWorker()
        if (output) {
          output.textContent = ''
          output.dataset.empty = ''
        }
        setStatus('运行中…')
        if (stopBtn) stopBtn.disabled = false
        if (runBtn) runBtn.disabled = true
        try {
          const blob = new Blob([WORKER_SOURCE], { type: 'text/javascript' })
          workerUrl = URL.createObjectURL(blob)
          worker = new Worker(workerUrl)
          timer = setTimeout(() => {
            append('\n⏱ 运行超过 5 秒，已自动终止\n')
            cleanupWorker()
            setStatus('超时终止')
          }, 5000)
          worker.onmessage = event => {
            const data = event.data || {}
            if (data.type === 'done') {
              cleanupWorker()
              setStatus('完成')
              return
            }
            const prefix = data.type === 'error' ? '✗ ' : data.type === 'warn' ? '⚠ ' : ''
            append(`${prefix}${data.text}\n`)
          }
          worker.onerror = event => {
            append(`✗ ${event.message || '运行出错'}\n`)
            cleanupWorker()
            setStatus('出错')
          }
          worker.postMessage({ code: code ? code.value : '' })
        } catch (err) {
          cleanupWorker()
          setStatus('启动失败')
          toast.error(`无法启动沙箱：${err.message}`)
        }
      }

      runBtn?.addEventListener('click', run)
      stopBtn?.addEventListener('click', () => stop())
      container.querySelector('[data-action="clear"]')?.addEventListener('click', () => {
        if (output) {
          output.textContent = ''
          output.dataset.empty = '运行结果会显示在这里'
        }
        setStatus('就绪')
      })

      return () => {
        stop(false)
      }
    },
  })
}
