/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * 设置项 · 数据（真实版）
 *   - 数据目录：可在设置里选择（Windows 文件夹对话框）/ 手动填写 / 恢复默认
 *   - 空目录 = 全新空白实例；已有数据的目录 = 加载该实例
 *   - 数据目录指针会写本机 AppData，其他新部署首次启动可找回；本部署之后只认自己的记录
 */
export const name = 'settings-item-data'
export const version = '3.0.0'
export const displayName = '设置项 · 数据'
export const description = '设置页 · 数据目录选择与本地数据操作。'
export const author = '念风内核'
export const icon = '💾'
export const core = false
export const depends = {
  'backend-client': '>=1.0.0',
  'modal-host': '>=1.0.0',
  'permissions': '^1.0.0',
  'session-service': '>=2.0.0',
  'settings-container': '^1.0.0',
  'storage': '*',
  'toast-host': '>=1.0.0',
}
export const optionalDepends = {}
export const inject = ['settings-container', 'storage', 'session-service', 'toast', 'modal', 'api']

import { page, section, card, row } from '../../../src/util/settings.mjs'
import { icons } from '../../../src/util/icons.mjs'
import { escapeHtml } from '../../../src/util/format.mjs'
import { useStyle } from '../../../src/util/style.mjs'
import { DATA_PAGE_CSS } from './style.mjs'

export function apply(ctx) {
  useStyle(ctx, DATA_PAGE_CSS)
  const pages = ctx.inject('settings-container')
  const storage = ctx.inject('storage')
  const sessions = ctx.inject('session-service')
  const toast = ctx.inject('toast')
  const modal = ctx.inject('modal')
  const api = ctx.inject('api')

  pages.register({
    id: 'data',
    group: '系统',
    groupOrder: 40,
    label: '数据',
    icon: icons.database,
    order: 80,
    render(container) {
      let dirInfo = null
      let health = null
      let busy = false
      let disposed = false

      const supportsDataDir = () => !!health?.capabilities?.includes('data-dir')
      const readSelect = el => {
        if (!el) return ''
        if (el.value) return el.value
        const option = el.querySelector('option[selected]')
        return option ? option.getAttribute('value') || '' : ''
      }
      const pathInput = (value, extra = '') =>
        `<input class="setting-input data-path" readonly value="${escapeHtml(value)}" ${extra} />`

      const load = async () => {
        try {
          health = await api.health()
        } catch (_) {
          health = null
        }
        try {
          dirInfo = await api.getDataDir()
        } catch (_) {
          dirInfo = null
        }
        if (!disposed) render()
      }

      const render = () => {
        if (disposed) return
        const stats = sessions.stats?.() || { conversations: sessions.count(), messages: 0 }
        const online = !!health
        const canSwitch = online && supportsDataDir()
        const currentDir = dirInfo?.dataDir || health?.dataDir || '—'
        const defaultDir = dirInfo?.homeDir || dirInfo?.defaultDataDir || '—'

        container.innerHTML = page('数据', '持久化数据默认保存在项目根目录的 user_data 里；也可以选择任意目录开始一个全新的实例。', `
          ${section('存储位置', card(
            row(
              '当前数据目录',
              '可以直接修改路径；点「选择目录」调起系统文件夹对话框。目标为空目录 = 全新空白实例，目标已有数据 = 加载该实例。',
              `<input class="setting-input data-path" data-field="data-dir" value="${escapeHtml(currentDir)}" placeholder="例如 D:\\你的数据目录" />
               <button class="outline-btn" data-action="pick-dir" ${canSwitch ? '' : 'disabled'}>选择目录</button>
               <button class="outline-btn" data-action="apply-dir" ${canSwitch ? '' : 'disabled'}>应用</button>`,
            ) +
              row('默认目录', '点「恢复默认」后实例会指回这里（为空则是全新实例）', `${pathInput(defaultDir)}<button class="outline-btn" data-action="reset-dir" ${canSwitch ? '' : 'disabled'}>恢复默认</button>`) +
              row('配置文件', '提供商 / 网络等后端配置', pathInput(dirInfo?.current?.configFile || health?.configFile || '—')) +
              row('会话文件', '会话与消息记录', pathInput(dirInfo?.current?.sessionsFile || '—')) +
              row('本机共享指针', '首次启动时其他部署会从这里找回数据目录；本部署之后只认自己的记录', pathInput(dirInfo?.appInstanceFile || dirInfo?.instanceFile || '—')),
          ))}
          ${
            online && !supportsDataDir()
              ? '<div class="settings-note data-warn">检测到正在运行的后端没有「数据目录」能力：这是个旧进程。请完全关闭念风后重新运行 start.cmd 或 npm start。</div>'
              : online
                ? ''
                : '<div class="settings-note data-warn">本地后端未连接：数据目录暂时无法读取或切换。</div>'
          }
          ${section('当前数据量', card(
            row('会话 / 消息', '本地保存的会话与消息数量', `<span class="mono">${stats.conversations} / ${stats.messages}</span>`) +
              row('存储后端', '浏览器端偏好使用 localStorage（不可用时降级内存）', `<span class="mono">${escapeHtml(storage.backend || 'localStorage')}</span>`) +
              row('后端状态', 'WebUI ↔ 本地后端', online ? '<span class="text-good">● 已连接</span>' : '<span class="text-bad">● 未连接</span>'),
          ))}
          ${section('数据操作', card(
            row(
              '导出全部会话',
              '由 export-service 提供；会话头部「更多」菜单还支持单会话 HTML / CSV / PDF',
              `<select class="setting-select" data-field="export-format"><option value="json">JSON</option><option value="txt">TXT</option><option value="html">HTML</option></select>
               <button class="outline-btn" data-action="export">导出</button>`,
            ) +
              row('从后端重新同步', '当其他设备 / 进程修改过数据时使用', `<button class="outline-btn" data-action="sync" ${online ? '' : 'disabled'}>同步</button>`) +
              row('清空所有会话', '删除本实例里的全部会话与消息，不可恢复', '<button class="outline-btn danger-btn" data-action="clear-sessions">清空</button>') +
              row('清理缓存', '删除插件临时缓存，不影响会话与配置', '<button class="outline-btn danger-btn" data-action="clean">清理</button>'),
          ))}
          <div class="settings-note">
            数据只保存在本机。选择空目录后会从空白配置开始；选择已有 config.json / sessions.json 的目录会直接加载那里的数据。
            本机共享指针写在 AppData，但本部署一旦解析过目录，之后就只使用自己的记录，不会被其他部署改动影响。
          </div>`)

        container.querySelector('[data-action="pick-dir"]')?.addEventListener('click', pickDir)
        container.querySelector('[data-action="apply-dir"]')?.addEventListener('click', applyDir)
        container.querySelector('[data-action="reset-dir"]')?.addEventListener('click', resetDir)
        container.querySelector('[data-action="export"]')?.addEventListener('click', exportAll)
        container.querySelector('[data-action="sync"]')?.addEventListener('click', syncNow)
        container.querySelector('[data-action="clear-sessions"]')?.addEventListener('click', clearSessions)
        container.querySelector('[data-action="clean"]')?.addEventListener('click', cleanCache)
      }

      const pickDir = async () => {
        if (busy) return
        busy = true
        try {
          toast.info('请在系统窗口里选择数据目录…')
          const result = await api.pickDataDir()
          const input = container.querySelector('[data-field="data-dir"]')
          if (result?.path && input) {
            input.value = result.path
            toast.success('已选择目录，点「应用」生效')
          } else if (!result?.path) {
            toast.info('没有选择目录')
          }
        } catch (err) {
          toast.error(`打开目录选择器失败：${err.message}。也可以手动填写路径。`)
        } finally {
          busy = false
        }
      }

      const applyDir = async () => {
        if (busy) return
        const input = container.querySelector('[data-field="data-dir"]')
        const dir = String(input?.value || '').trim()
        if (!dir) {
          toast.warn('请先填写或选择数据目录')
          return
        }
        const answer = await modal.confirm('切换数据目录', `实例将指向：${dir}\n\n空目录 = 全新空白实例（不会复制当前数据）；已有数据的目录 = 直接加载该实例。`)
        if (!answer?.ok) return
        busy = true
        try {
          const result = await api.setDataDir(dir, false)
          toast.success(`数据目录已切换：${result.dataDir}`)
          dirInfo = result
          await sessions.sync().catch(() => {})
        } catch (err) {
          toast.error(`切换失败：${err.message}`)
        } finally {
          busy = false
          render()
        }
      }

      const resetDir = async () => {
        if (busy) return
        const target = dirInfo?.homeDir || dirInfo?.defaultDataDir
        if (!target) return
        const answer = await modal.confirm('恢复默认数据目录', `实例将指回默认目录：${target}\n\n该目录为空时会从空白实例开始。`)
        if (!answer?.ok) return
        busy = true
        try {
          const result = await api.setDataDir(target, false)
          toast.success('已恢复默认数据目录')
          dirInfo = result
          await sessions.sync().catch(() => {})
        } catch (err) {
          toast.error(`恢复失败：${err.message}`)
        } finally {
          busy = false
          render()
        }
      }

      const exportAll = () => {
        const format = readSelect(container.querySelector('[data-field="export-format"]')) || 'json'
        const exportService = ctx.registry.get('export-service')
        if (exportService) {
          Promise.resolve(exportService.exportAll(format)).catch(() => {})
          return
        }
        const data = { version: '0.42.0', exportedAt: new Date().toISOString(), ...storage.exportAll() }
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `nianfeng-export-${Date.now()}.json`
        a.click()
        URL.revokeObjectURL(url)
        toast.success('已导出为 JSON')
      }

      const syncNow = async () => {
        try {
          const result = await sessions.sync()
          toast.success(`已从后端同步 ${result?.count ?? sessions.count()} 个会话`)
        } catch (err) {
          toast.error(`同步失败：${err.message}`)
        }
        render()
      }

      const clearSessions = async () => {
        const count = sessions.count()
        if (!count) {
          toast.info('当前没有会话')
          return
        }
        const answer = await modal.confirm('清空所有会话', `将删除本实例的 ${count} 个会话与全部消息，且不可恢复。确定继续吗？`)
        if (!answer?.ok) return
        for (const conv of [...sessions.list()]) sessions.remove(conv.id)
        toast.success('会话已清空')
        render()
      }

      const cleanCache = async () => {
        const answer = await modal.confirm('清理缓存', '将清理插件缓存与临时数据，不会删除会话和配置。')
        if (!answer?.ok) return
        storage.clear('cache')
        toast.success('缓存已清理')
      }

      render()
      load()

      return () => {
        disposed = true
      }
    },
  })
}
