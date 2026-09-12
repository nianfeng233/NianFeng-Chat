/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * S1 · app-shell
 * 整体 grid 骨架（文档 §二 L3）。自身不画任何内容，
 * 只提供挂载点与结构服务，其余全部由后续插件往插槽里填。
 *
 * 结构：
 *   .app
 *     [app:titlebar]        ← S5 titlebar
 *     .app-main
 *       [app:rail]          ← S6 rail
 *       .body (grid: list | resizer | main)
 *         [app:list]        ← S7 left-list-panel
 *         .resizer
 *         [app:main]        ← S8 right-main-panel
 *     [app:overlay]         ← V15 settings-view
 */
export const name = 'app-shell'
export const version = '1.0.0'
export const displayName = '应用外壳'
export const description = '视觉框架 · 整体 grid 骨架与挂载点。'
export const author = '念风内核'
export const icon = '🪟'
export const core = true
export const inject = ['slots']
export const provides = [{ name: 'app-shell', type: 'singleton' }]

import { useStyle } from '../../../src/util/style.mjs'
import { APP_SHELL_CSS } from './style.mjs'

export function apply(ctx) {
  const mount = document.getElementById('app')
  if (!mount) throw new Error('缺少 #app 挂载点')

  mount.innerHTML = `
    <div class="app" id="windApp">
      <div class="slot-host" data-slot="app:titlebar"></div>
      <div class="app-main">
        <div class="slot-host" data-slot="app:rail"></div>
        <div class="body" id="windBody">
          <div class="slot-host" data-slot="app:list"></div>
          <div class="resizer" id="windResizer"></div>
          <div class="slot-host" data-slot="app:main"></div>
        </div>
      </div>
      <div class="slot-host" data-slot="app:overlay"></div>
    </div>`

  useStyle(ctx, APP_SHELL_CSS)

  const refs = {
    appEl: document.getElementById('windApp'),
    bodyEl: document.getElementById('windBody'),
    resizer: document.getElementById('windResizer'),
    listHost: document.querySelector('[data-slot="app:list"]'),
    mainHost: document.querySelector('[data-slot="app:main"]'),
    titlebarHost: document.querySelector('[data-slot="app:titlebar"]'),
    railHost: document.querySelector('[data-slot="app:rail"]'),
    overlayHost: document.querySelector('[data-slot="app:overlay"]'),
  }

  // 运行环境：Electron / Tauri / 自研 WebView 宿主视为桌面端，其余为 web
  // 与 demo 一致：web 环境隐藏窗口三按钮（titlebar 样式里有对应规则）
  const env =
    window.process?.versions?.electron || window.__TAURI__ || window.__TAURI_INTERNALS__ || window.windHost?.window
      ? 'app'
      : 'web'
  document.body.dataset.env = env

  const readyCallbacks = []
  const service = {
    name: 'app-shell',
    refs,
    version: '0.40.0',
    /** 外壳就绪：拿到 grid 各节点引用（拖拽调宽等行为挂这里） */
    onReady(cb) {
      if (refs.appEl) cb(refs)
      else readyCallbacks.push(cb)
    },
    /** 列表宽度（px），写入 CSS 变量 --list-w */
    setListWidth(width) {
      document.documentElement.style.setProperty('--list-w', `${width}px`)
    },
    setDragging(kind, on) {
      document.body.classList.toggle(`resizing-${kind}`, !!on)
    },
  }

  ctx.provide('app-shell', service, { type: 'singleton' })

  // 容器就绪后再通知一次（插件注册顺序不定）
  queueMicrotask(() => {
    for (const cb of readyCallbacks.splice(0)) cb(refs)
    ctx.emit('app:shell-ready', refs)
  })

  ctx.logger.debug('应用外壳就绪')
}
