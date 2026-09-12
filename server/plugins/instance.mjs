/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * 后端 · instance
 * 管理「当前实例指向的数据目录」：
 *   - 默认 <项目根>/user_data
 *   - 首次启动会读本机 AppData 指针，之后固定在本部署的 user_data/instance.json
 *   - 设置 → 数据 可切换到任意目录（不存在自动创建；空目录=全新空白实例）
 */
import { mkdir } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { normalizeDataDir, writeInstanceFile } from '../data-dir.mjs'

export const name = 'instance'
export const inject = ['settings', 'sessions', 'hub']

export function apply(ctx, config = {}) {
  const settings = ctx.settings
  const sessions = ctx.sessions
  const hub = ctx.hub

  const paths = {
    root: config.root || process.cwd(),
    homeDir: config.homeDir,
    instanceFile: config.instanceFile,
    legacyDir: config.legacyDir,
    dataDir: config.dataDir,
    migrated: !!config.migrated,
    envOverride: !!config.envOverride,
    appDir: config.appDir,
    appInstanceFile: config.appInstanceFile,
    source: config.source || 'default',
  }

  const info = () => ({
    ok: true,
    root: paths.root,
    homeDir: paths.homeDir,
    defaultDataDir: paths.homeDir,
    instanceFile: paths.instanceFile,
    legacyDir: paths.legacyDir,
    dataDir: paths.dataDir,
    source: paths.source,
    appDir: paths.appDir,
    appInstanceFile: paths.appInstanceFile,
    current: {
      configFile: settings.file,
      sessionsFile: sessions.file,
      conversations: sessions.count(),
      totalMessages: sessions.totalMessages(),
    },
    envOverride: paths.envOverride,
    migrated: paths.migrated,
  })

  const service = {
    name: 'instance',
    info,

    /**
     * 切换数据目录。
     * 目标为空目录 = 全新空白实例（不会复制当前数据）；
     * 目标已有 config.json / sessions.json = 直接加载目标实例的数据。
     * @param {string} input
     * @param {{migrate?:boolean}} options 仅保留给旧调用方，默认 false
     */
    async setDataDir(input, { migrate = false } = {}) {
      const target = normalizeDataDir(input, paths.root)
      if (!target) throw createError(400, '数据目录不能为空')
      try {
        await mkdir(target, { recursive: true })
      } catch (err) {
        throw createError(400, `无法创建数据目录：${err.message}`)
      }
      if (target === paths.dataDir) return info()

      await settings.rehome(target, { migrate })
      await sessions.rehome(target, { migrate })
      paths.dataDir = target
      paths.migrated = false
      paths.source = 'local-pointer'
      await writeInstanceFile(paths.instanceFile, target)
      // 本机共享指针：供其他新部署首次启动时找回当前数据目录
      await writeInstanceFile(paths.appInstanceFile, target).catch(() => {})
      hub.broadcast('instance/data-dir-changed', info())
      ctx.logger.info(`实例数据目录已切换：${target}（${migrate ? '迁移当前数据' : '空白/加载目标数据'}）`)
      return info()
    },

    /** 恢复默认目录（user_data）；如果它为空则是一个全新实例 */
    async resetDataDir() {
      return service.setDataDir(paths.homeDir, { migrate: false })
    },

    /**
     * 调起操作系统目录选择器（Windows 的“选择文件夹”对话框）。
     * 只有用户真的选中并确认才返回路径；取消返回空字符串。
     */
    pickDirectory(options = {}) {
      if (process.platform !== 'win32') {
        return Promise.reject(createError(400, '当前平台暂不支持系统目录选择器，请手动填写路径'))
      }
      const description = String(options?.description || '选择念风的数据目录').replace(/'/g, "''")
      const script = [
        'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
        "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
        `$dialog.Description = '${description}'`,
        '$dialog.ShowNewFolderButton = $true',
        "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.SelectedPath) }",
      ].join('; ')
      return new Promise((resolvePromise, reject) => {
        const onDone = (err, stdout) => {
          if (err) return reject(createError(500, `打开目录选择器失败：${err.message}`))
          resolvePromise({ path: String(stdout || '').trim() })
        }
        try {
          execFile(
            'powershell.exe',
            ['-NoProfile', '-STA', '-Command', script],
            { timeout: 180000, windowsHide: false, maxBuffer: 1024 * 1024 },
            onDone,
          )
        } catch (err) {
          onDone(err)
        }
      })
    },
  }

  ctx.provide('instance', service)
  ctx.logger.info(`数据目录：${paths.dataDir}${paths.migrated ? '（已从旧 data/ 迁移）' : ''}（来源：${paths.source}）`)
}

function createError(status, message) {
  const err = new Error(message)
  err.status = status
  return err
}
