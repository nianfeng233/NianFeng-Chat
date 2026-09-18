/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * 插件运行范围（scope）
 *
 * 目标：
 *   - server  插件只在服务端常驻代聊 Worker / 后端终端加载；
 *   - webui   插件只在浏览器 WebUI 加载，负责界面、视觉、交互；
 *   - both    两边都需要（kernel / 基础服务 / 数据适配层 / 渠道桥等）。
 *
 * 这样 WebUI 打开时不需要再加载 chat-flow / context-builder / chat-tools /
 * memory-store 等实质性业务执行代码；业务统一由后端终端完成。
 *
 * 外部插件可以通过 manifest 字段 `scope` / `runtime` 声明：
 *   "scope": "server" | "webui" | "both"
 * 未声明时默认 both，保持第三方插件兼容。
 */

/** 只应加载在后端 / 服务端代聊 Worker 的核心业务插件。 */
const SERVER_ONLY_IDS = new Set([
  'chat-flow',
  'context-builder',
  'chat-tools',
  'document-service',
  'memory-store',
  'model-service',
  'chat-queue',
])

/** 只应加载在浏览器 WebUI 的视觉 / 交互 / 前端运维插件。 */
const WEBUI_ONLY_IDS = new Set([
  'view-router',
  'search-service',
  'export-service',
  'plugin-manager',
  'character-editor',
  'chat-notify',
  'plugin-health-guard',
  'agent-client',
  'lang-zh-cn',
  'markdown-enhancer',
  'napcat-input-state',
])

/** 目录规则：这些目录下的插件天然属于 WebUI。 */
const WEBUI_ONLY_DIRS = [
  /^plugins\/views\//,
  /^plugins\/shell\//,
  /^plugins\/extras\//,
]

export function pluginScopeOf(entry = {}) {
  const explicit = String(entry.scope || entry.runtime || '').trim().toLowerCase()
  if (explicit === 'server' || explicit === 'backend') return 'server'
  if (explicit === 'webui' || explicit === 'client' || explicit === 'frontend') return 'webui'
  if (explicit === 'both' || explicit === 'all') return 'both'

  const id = String(entry.id || entry.name || '').trim()
  if (SERVER_ONLY_IDS.has(id)) return 'server'
  if (WEBUI_ONLY_IDS.has(id)) return 'webui'

  const dir = String(entry.dir || '').replace(/\\/g, '/')
  if (WEBUI_ONLY_DIRS.some(pattern => pattern.test(dir))) return 'webui'

  // 外部插件 / 未知来源默认两边都可用，避免把第三方插件误伤成不可用。
  return 'both'
}

/**
 * 当前运行范围是否允许加载该插件。
 * @param {object} entry /api/plugins 清单条目
 * @param {'all'|'server'|'webui'} scope 当前运行范围
 */
export function isPluginInScope(entry, scope = 'all') {
  if (!scope || scope === 'all') return true
  const pluginScope = pluginScopeOf(entry)
  if (pluginScope === 'both') return true
  return pluginScope === scope
}
