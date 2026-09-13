/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * V18 · settings-item-model（V4 改版）
 *
 * 模型页分成两套面板，由顶层开关「使用念风内置模型」（默认开启）切换：
 *
 *  1) 开启：内置模型列表 + 请求参数（自定义请求体 / 超时时间）。
 *     内置模型来自官方服务端。官方服务端是独立的官网项目、尚未发布，
 *     因此这里如实展示空状态与原因，不提供假模型、也不假装登录。
 *
 *  2) 关闭：AstrBot 风格的自定义提供商配置页。
 *     左栏：提供商列表（新增 / 选择 / 删除、Base URL、Key 状态、启停状态）
 *     右栏：当前提供商详情（ID / Key / Base URL）、测试连接、获取模型列表、
 *           模型增删改与每个模型的参数（显示名 / 上下文 / temperature /
 *           max_tokens / 额外请求体）、折叠的高级配置（超时 / 代理 / 请求头覆盖）。
 *
 * 所有提供商配置都落在本机后端当前数据目录（默认 user_data/config.json），API Key 不回传浏览器。
 */
export const name = 'settings-item-model'
export const version = '4.0.0'
export const displayName = '设置项 · 模型'
export const description = '设置页 · 内置模型开关与自定义提供商管理。'
export const author = '念风内核'
export const icon = '🤖'
export const core = true
export const depends = { 'settings-container': '^1.0.0', 'backend-client': '^1.0.0' }
export const inject = ['settings-container', 'api', 'model-registry', 'model-adapter?', 'config', 'toast', 'modal']
export const permissions = ["network"]
export const provides = []

import { page, section, card, row, switchBtn, bindConfigControls } from '../../../src/util/settings.mjs'
import { icons } from '../../../src/util/icons.mjs'
import { escapeHtml } from '../../../src/util/format.mjs'
import { useStyle } from '../../../src/util/style.mjs'
import { MODEL_PAGE_CSS } from './style.mjs'

const TYPE_LABELS = {
  openai: 'OpenAI 兼容',
  deepseek: 'DeepSeek 官方',
  anthropic: 'Anthropic Claude',
  ollama: 'Ollama（本地）',
  gemini: 'Google Gemini',
}

const typeLabel = type => TYPE_LABELS[type] || type || '自定义'

/**
 * 推理等级：对标 DeepSeek 官方 / deepseek-harness 的四档。
 * off -> thinking:{type:'disabled'}
 * low / high / max -> thinking:{type:'enabled'} + reasoning_effort:<level>
 */
const REASONING_LEVELS = [
  { id: 'off', label: '无', hint: '关闭思考（thinking disabled）' },
  { id: 'low', label: '低', hint: '开启思考，reasoning_effort=low' },
  { id: 'high', label: '高', hint: '开启思考，reasoning_effort=high' },
  { id: 'max', label: '最高', hint: '开启思考，reasoning_effort=max' },
]

const reasoningIndexFor = effort => {
  const index = REASONING_LEVELS.findIndex(level => level.id === effort)
  return index < 0 ? 0 : index
}

const REASONING_CSS = {
  off: { color: '#b7c0b4', white: '0' },
  low: { color: '#7ed07a', white: '0.88' },
  high: { color: '#3b82f6', white: '0.42' },
  max: { color: '#ec4899', white: '0.16' },
}

/** 温度 0-2 → 填充色（越热绿色越深、白色权重越低） */
const temperatureColor = value => {
  const t = Math.max(0, Math.min(1, Number(value) / 2))
  const mix = (a, b) => Math.round(a + (b - a) * t)
  const r = mix(214, 20)
  const g = mix(240, 101)
  const b = mix(202, 66)
  return { color: `rgb(${r},${g},${b})`, white: (0.92 - t * 0.78).toFixed(2) }
}

const toNumber = value => {
  if (value === '' || value === null || value === undefined) return undefined
  const num = Number(value)
  return Number.isFinite(num) ? num : undefined
}

export function apply(ctx) {
  const pages = ctx.inject('settings-container')
  const api = ctx.inject('api')
  const registry = ctx.inject('model-registry')
  const adapter = ctx.inject('model-adapter')
  const config = ctx.inject('config')
  const toast = ctx.inject('toast')
  const modal = ctx.inject('modal')

  useStyle(ctx, MODEL_PAGE_CSS)

  pages.register({
    id: 'model',
    group: '核心',
    groupOrder: 20,
    label: '模型',
    icon: icons.cpu,
    order: 20,
    render(container) {
      /* ---------------- 页面状态 ---------------- */
      let providerPayload = { providers: [], adapters: [], defaultProvider: '', defaultModel: '' }
      let health = null
      let builtin = null
      let builtinLoading = false
      let selectedId = ''
      let editingModelId = ''
      let addingModel = false
      let creatingProvider = false
      let advancedOpen = false
      let refreshingProvider = ''
      let unbindConfig = null
      let unbindSliderConfig = null
      let disposed = false

      /** 官方服务插件是否存在；禁用它后内置模型区域会整体消失 */
      const officialService = () => ctx.registry.get('official-service')

      /* ---------------- 小工具 ---------------- */
      const fieldValue = el => (el ? (el.value !== '' ? el.value : el.textContent || '') : '')
      const hasFlag = (el, name) => !!el && (typeof el.hasAttribute === 'function' ? el.hasAttribute(name) : false)

      const readSelect = el => {
        if (!el) return ''
        if (el.value) return el.value
        const option = el.querySelector('option[selected]')
        return option ? option.getAttribute('value') || '' : ''
      }

      const selectedProvider = () => (providerPayload.providers || []).find(p => p.id === selectedId) || null

      const statusBadge = status => {
        if (!status || status.ok === null || status.ok === undefined) return '<span class="model-status-text idle">● 未测试</span>'
        return status.ok
          ? `<span class="model-status-text ok">● 正常${status.latency ? ` ${status.latency}ms` : ''}</span>`
          : `<span class="model-status-text bad">● 失败</span>`
      }

      /* ---------------- 内置模型面板 ---------------- */
      const builtinEmpty = () => `
        <div class="model-empty">
          <div class="model-empty-icon">${icons.bolt}</div>
          <div class="model-empty-title">官方服务尚未接入</div>
          <div class="model-empty-desc">${escapeHtml(
            builtin?.reason ||
              '「念风内置模型」由官方服务端提供（登录 / 计费 / 官方模型都在官网侧）。官方服务端是独立项目、当前尚未发布，因此这里没有可用的内置模型。',
          )}</div>
          <div class="model-empty-actions">
            <button class="outline-btn" data-action="reload-builtin">重新检测</button>
            <button class="outline-btn" data-action="use-custom">改用自定义提供商</button>
          </div>
        </div>`

      const builtinList = () => {
        const models = builtin?.models || []
        if (!models.length) return builtinEmpty()
        return models
          .map(
            model => `
            <div class="model-item">
              <div class="model-item-main-row">
                <div class="model-item-info">
                  <div class="model-item-name">${escapeHtml(model.name || model.id)}<span class="model-tag">内置</span></div>
                  <div class="model-item-id">${escapeHtml(model.id)}</div>
                  ${model.description ? `<div class="model-item-id">${escapeHtml(model.description)}</div>` : ''}
                </div>
              </div>
            </div>`,
          )
          .join('')
      }

      const builtinPanel = () => {
        const timeout = config.get('model.timeoutMs', 60000)
        const requestBody = config.get('model.requestBody', '')
        const count = builtin?.models?.length || 0
        return `
          ${section(
            `内置模型${count ? `（${count}）` : ''}`,
            card(
              builtinLoading && !builtin
                ? '<div class="model-empty"><div class="model-empty-desc">正在检测官方服务…</div></div>'
                : builtinList(),
            ),
          )}
          ${section(
            '请求参数',
            card(`
              <div class="setting-row">
                <div class="setting-main">
                  <div class="setting-name">自定义请求体</div>
                  <div class="setting-help">以 JSON 形式追加到内置模型请求体；官方服务接入后生效，当前仅保存在本机。</div>
                </div>
              </div>
              <div class="model-block">
                <textarea class="model-textarea" data-field="request-body" placeholder='{"reasoning_effort":"high"}'>${escapeHtml(requestBody)}</textarea>
                <div class="model-inline-actions">
                  <span class="model-json-hint" data-role="request-body-hint">JSON 对象，留空表示不附加</span>
                  <button class="outline-btn" data-action="save-request-body">保存请求体</button>
                </div>
              </div>
              <div class="setting-row">
                <div class="setting-main">
                  <div class="setting-name">超时时间</div>
                  <div class="setting-help">等待内置模型响应的最长时间，单位毫秒（默认 60000）。</div>
                </div>
                <div class="setting-control">
                  <input class="setting-input" type="number" min="1000" step="1000" style="width:130px" data-field="builtin-timeout" value="${escapeHtml(String(timeout ?? 60000))}" />
                  <button class="outline-btn" data-action="save-timeout">保存</button>
                </div>
              </div>`),
          )}`
      }

      /* ---------------- 自定义提供商面板 ---------------- */
      const providerItem = (provider, activeId) => {
        const glyphClass = provider.managed ? 'managed' : provider.configured ? 'ok' : 'warn'
        return `
          <div class="model-provider-item ${provider.id === activeId ? 'active' : ''} ${provider.enabled === false ? 'dim' : ''}"
            data-provider-id="${escapeHtml(provider.id)}" role="button" tabindex="0" title="${escapeHtml(provider.name || provider.id)}">
            <span class="model-provider-glyph ${glyphClass}">${escapeHtml((provider.name || provider.id || '?').slice(0, 1).toUpperCase())}</span>
            <span class="model-provider-meta">
              <span class="model-provider-name">${escapeHtml(provider.name || provider.id)}${provider.managed ? '<em>托管</em>' : ''}</span>
              <span class="model-provider-url">${escapeHtml(provider.baseURL || '未设置地址')}</span>
              <span class="model-provider-flags">
                ${provider.managed ? '' : provider.configured ? '<span class="model-flag">就绪</span>' : '<span class="model-flag bad">缺凭据</span>'}
                ${provider.enabled === false ? '<span class="model-flag">停用</span>' : ''}
                <i class="model-status-dot ${provider.status?.ok === true ? 'ok' : provider.status?.ok === false ? 'bad' : ''}"></i>
              </span>
            </span>
            ${
              provider.managed
                ? ''
                : `<button class="model-provider-del" data-provider-delete="${escapeHtml(provider.id)}" title="删除提供商">${icons.trash}<span>删除</span></button>`
            }
          </div>`
      }

      const providerSide = () => {
        const providers = providerPayload.providers || []
        const activeId = selectedId || providers[0]?.id || ''
        return `
          <div class="model-provider-side">
            <div class="model-side-head">
              <span class="model-side-title">提供商（${providers.length}）</span>
              <button class="outline-btn model-mini-btn" data-action="new-provider">${icons.plus}<span>新增</span></button>
            </div>
            <div class="model-provider-list">
              ${providers.length ? providers.map(p => providerItem(p, activeId)).join('') : '<div class="model-side-empty">还没有提供商<br />点击「新增」开始配置</div>'}
            </div>
            <div class="model-side-foot">支持 OpenAI 兼容接口、DeepSeek 官方、Anthropic Claude、Google Gemini 与本地 Ollama；配置保存在本机当前数据目录（默认 user_data）。</div>
          </div>`
      }

      const createProviderForm = () => {
        const adapters = providerPayload.adapters?.length ? providerPayload.adapters : ['openai', 'anthropic', 'ollama']
        const options = adapters
          .map(type => `<option value="${escapeHtml(type)}" ${type === 'openai' ? 'selected' : ''}>${escapeHtml(typeLabel(type))}</option>`)
          .join('')
        return `
          <div class="model-detail-head">
            <div>
              <div class="model-detail-title">新增提供商</div>
              <div class="model-detail-sub">填写后即可在左侧列表中管理；API Key 只保存在本机后端。</div>
            </div>
          </div>
          <div class="model-form-grid">
            <label class="model-form-field"><span>ID（唯一，创建后不可改）</span><input class="setting-input" data-create="id" placeholder="my-provider" /></label>
            <label class="model-form-field"><span>显示名</span><input class="setting-input" data-create="name" placeholder="我的模型服务" /></label>
            <label class="model-form-field"><span>类型</span><select class="setting-select" data-create="type">${options}</select></label>
            <label class="model-form-field"><span>Base URL</span><input class="setting-input" data-create="baseURL" placeholder="https://api.example.com/v1" /></label>
            <label class="model-form-field"><span>API Key（可稍后填写）</span><input class="setting-input" type="password" data-create="apiKey" placeholder="sk-..." autocomplete="off" /></label>
          </div>
          <div class="model-form-actions">
            <button class="outline-btn model-mini-btn primary-soft" data-action="create-provider">创建</button>
            <button class="outline-btn model-mini-btn" data-action="cancel-new-provider">取消</button>
          </div>`
      }

      const modelParamChips = model => {
        const params = model.params || {}
        const chips = []
        if (params.contextLength) chips.push(`上下文 ${params.contextLength}`)
        if (params.temperature !== undefined) chips.push(`temp ${params.temperature}`)
        if (params.maxTokens !== undefined) chips.push(`max_tokens ${params.maxTokens}`)
        if (params.extraBody) chips.push('额外请求体')
        if (params.priceInput !== undefined || params.priceOutput !== undefined) chips.push('已配置计费')
        return chips.length ? `<div class="model-param-chips">${chips.map(c => `<span class="model-chip">${escapeHtml(c)}</span>`).join('')}</div>` : ''
      }

      const modelEditor = model => {
        const params = model.params || {}
        return `
          <div class="model-editor">
            <div class="model-editor-grid">
              <label class="model-field"><span>显示名</span><input class="setting-input" data-model-field="name" value="${escapeHtml(model.name || model.id)}" /></label>
              <label class="model-field"><span>上下文长度</span><input class="setting-input" type="number" min="0" step="1" data-model-field="contextLength" value="${escapeHtml(String(params.contextLength ?? ''))}" placeholder="如 128000" /></label>
              <label class="model-field"><span>temperature</span><input class="setting-input" type="number" min="0" max="2" step="0.1" data-model-field="temperature" value="${escapeHtml(String(params.temperature ?? ''))}" placeholder="默认 0.7" /></label>
              <label class="model-field"><span>max_tokens</span><input class="setting-input" type="number" min="1" step="1" data-model-field="maxTokens" value="${escapeHtml(String(params.maxTokens ?? ''))}" placeholder="如 4096" /></label>
              <label class="model-field"><span>输入价格（元/百万）</span><input class="setting-input" type="number" min="0" step="0.0001" data-model-field="priceInput" value="${escapeHtml(String(params.priceInput ?? ''))}" placeholder="用于估算本轮开销" /></label>
              <label class="model-field"><span>输出价格（元/百万）</span><input class="setting-input" type="number" min="0" step="0.0001" data-model-field="priceOutput" value="${escapeHtml(String(params.priceOutput ?? ''))}" placeholder="用于估算本轮开销" /></label>
              <label class="model-field"><span>缓存价格（元/百万）</span><input class="setting-input" type="number" min="0" step="0.0001" data-model-field="priceCached" value="${escapeHtml(String(params.priceCached ?? ''))}" placeholder="默认同输入价" /></label>
            </div>
            <label class="model-editor-block">
              <span>额外请求体（JSON 对象，会合并进请求）</span>
              <textarea class="model-textarea" data-model-field="extraBody" placeholder='{"top_p":0.95}'>${escapeHtml(params.extraBody ? JSON.stringify(params.extraBody, null, 2) : '')}</textarea>
            </label>
            <div class="model-editor-actions">
              <button class="outline-btn model-mini-btn" data-model-cancel>取消</button>
              <button class="outline-btn model-mini-btn primary-soft" data-model-save>保存参数</button>
            </div>
          </div>`
      }

      const modelRow = (provider, model) => {
        const editing = editingModelId === model.id
        const enabled = model.enabled !== false
        return `
          <div class="model-item ${enabled ? '' : 'dim'} ${editing ? 'open' : ''}" data-model-id="${escapeHtml(model.id)}">
            <div class="model-item-main-row">
              ${
                provider.managed
                  ? `<span class="model-status-dot ${enabled ? 'ok' : ''}"></span>`
                  : `<button class="switch ${enabled ? 'on' : ''}" data-model-toggle title="${enabled ? '停用' : '启用'}"></button>`
              }
              <div class="model-item-info">
                <div class="model-item-name">${escapeHtml(model.name || model.id)}${model.custom ? '<span class="model-tag">自定义</span>' : ''}</div>
                <div class="model-item-id">${escapeHtml(model.id)}</div>
                ${modelParamChips(model)}
              </div>
              <div class="model-item-actions">
                ${
                  provider.managed
                    ? ''
                    : `<button class="outline-btn model-mini-btn" data-model-edit>${editing ? '收起' : '编辑'}</button>
                       <button class="outline-btn model-mini-btn model-danger-text" data-model-delete>删除</button>`
                }
              </div>
            </div>
            ${editing ? modelEditor(model) : ''}
          </div>`
      }

      const modelsSection = provider => {
        const models = provider.models || []
        return `
          <div class="model-list-head">
            <div>
              <div class="model-list-title">模型（${models.length}）</div>
              <div class="model-list-sub">启用的模型会出现在聊天模型选择中；参数会随对话请求一起发送。</div>
            </div>
            ${
              provider.managed
                ? ''
                : `<div class="model-list-actions">
                     <button class="outline-btn model-mini-btn" data-action="refresh">${icons.bolt}<span>获取模型列表</span></button>
                     <button class="outline-btn model-mini-btn primary-soft" data-action="add-model">${icons.plus}<span>自定义模型</span></button>
                   </div>`
            }
          </div>
          ${
            addingModel && !provider.managed
              ? `<div class="model-add-form">
                   <input class="setting-input" data-new-model="id" placeholder="模型 ID，如 gpt-4o-mini" />
                   <input class="setting-input" data-new-model="name" placeholder="显示名（可选）" />
                   <button class="outline-btn model-mini-btn primary-soft" data-action="confirm-add-model">添加</button>
                   <button class="outline-btn model-mini-btn" data-action="cancel-add-model">取消</button>
                 </div>`
              : ''
          }
          ${
            models.length
              ? models.map(model => modelRow(provider, model)).join('')
              : '<div class="model-empty"><div class="model-empty-desc">还没有模型。点击「获取模型列表」从远端真实拉取，或添加一个自定义模型。</div></div>'
          }`
      }

      const providerForm = provider => {
        if (provider.managed) {
          return `
            <div class="setting-row">
              <div class="setting-main"><div class="setting-name">ID</div><div class="setting-help">托管提供商由官方服务维护</div></div>
              <div class="setting-control"><span class="mono">${escapeHtml(provider.id)}</span></div>
            </div>
            <div class="setting-row">
              <div class="setting-main"><div class="setting-name">Base URL</div></div>
              <div class="setting-control"><span class="mono">${escapeHtml(provider.baseURL || '—')}</span></div>
            </div>
            <div class="setting-row">
              <div class="setting-main"><div class="setting-name">模型（${provider.models?.length || 0}）</div><div class="setting-help">托管提供商不可编辑</div></div>
            </div>`
        }
        const adapters = providerPayload.adapters?.length ? providerPayload.adapters.slice() : [provider.type]
        if (!adapters.includes(provider.type)) adapters.push(provider.type)
        const typeOptions = adapters
          .map(type => `<option value="${escapeHtml(type)}" ${type === provider.type ? 'selected' : ''}>${escapeHtml(typeLabel(type))}</option>`)
          .join('')
        const defaultOptions = [`<option value="" ${!provider.defaultModel ? 'selected' : ''}>（跟随全局默认）</option>`]
          .concat(
            (provider.models || []).map(
              model =>
                `<option value="${escapeHtml(model.id)}" ${provider.defaultModel === model.id ? 'selected' : ''}>${escapeHtml(model.name || model.id)}</option>`,
            ),
          )
          .join('')
        return `
          <div class="setting-row">
            <div class="setting-main"><div class="setting-name">显示名</div><div class="setting-help">仅用于界面展示</div></div>
            <div class="setting-control"><input class="setting-input" style="width:100%;max-width:250px" data-provider-field="name" value="${escapeHtml(provider.name || '')}" /></div>
          </div>
          <div class="setting-row">
            <div class="setting-main"><div class="setting-name">ID</div><div class="setting-help">唯一标识，创建后不可修改</div></div>
            <div class="setting-control"><span class="mono">${escapeHtml(provider.id)}</span></div>
          </div>
          <div class="setting-row">
            <div class="setting-main"><div class="setting-name">类型</div><div class="setting-help">决定请求协议与地址格式</div></div>
            <div class="setting-control"><select class="setting-select" data-provider-field="type">${typeOptions}</select></div>
          </div>
          <div class="setting-row">
            <div class="setting-main"><div class="setting-name">Base URL</div><div class="setting-help">${provider.type === 'anthropic' ? 'Anthropic 接口根地址，默认 https://api.anthropic.com' : provider.type === 'deepseek' ? 'DeepSeek 接口根地址，默认 https://api.deepseek.com' : provider.type === 'gemini' ? 'Google Gemini 接口根地址，默认 https://generativelanguage.googleapis.com' : 'OpenAI 兼容 / Ollama 接口根地址'}</div></div>
            <div class="setting-control"><input class="setting-input" style="width:100%;max-width:320px" data-provider-field="baseURL" value="${escapeHtml(provider.baseURL || '')}" placeholder="https://..." /></div>
          </div>
          <div class="setting-row">
            <div class="setting-main">
              <div class="setting-name">API Key</div>
              <div class="setting-help">${
                provider.hasKey ? `已保存：${escapeHtml(provider.maskedKey || '••••')}（留在本机当前数据目录，默认 user_data/config.json）` : '未配置；Ollama 本地通常不需要'
              }</div>
            </div>
            <div class="setting-control"><input class="setting-input" style="width:100%;max-width:320px" type="password" data-provider-field="apiKey" value="" placeholder="${provider.hasKey ? '输入新 Key 可覆盖' : 'sk-...'}" autocomplete="off" /></div>
          </div>
          <div class="setting-row">
            <div class="setting-main"><div class="setting-name">启用</div><div class="setting-help">停用后不会出现在聊天模型选择中</div></div>
            <div class="setting-control"><button class="switch ${provider.enabled !== false ? 'on' : ''}" data-action="toggle-provider-enabled"></button></div>
          </div>
          <div class="setting-row">
            <div class="setting-main"><div class="setting-name">默认模型</div><div class="setting-help">跟随全局默认时，由「当前生效」决定</div></div>
            <div class="setting-control"><select class="setting-select" data-provider-field="defaultModel" style="min-width:220px">${defaultOptions}</select></div>
          </div>
          <div class="setting-row">
            <div class="setting-main"><div class="setting-name">高级配置</div><div class="setting-help">超时 / 代理 / 请求头覆盖</div></div>
            <div class="setting-control">
              <button class="outline-btn model-mini-btn" data-action="toggle-advanced">${advancedOpen ? '收起' : '展开'}</button>
              <button class="outline-btn model-mini-btn primary-soft" data-action="save-provider">保存配置</button>
            </div>
          </div>
          <div class="model-advanced ${advancedOpen ? '' : 'hidden'}">
            <div class="model-advanced-grid">
              <label class="model-form-field"><span>请求超时（毫秒，留空跟随全局）</span><input class="setting-input" type="number" min="0" step="1000" data-provider-field="timeoutMs" value="${escapeHtml(provider.timeoutMs ? String(provider.timeoutMs) : '')}" placeholder="60000" /></label>
              <label class="model-form-field"><span>代理地址（http://host:port，可选）</span><input class="setting-input" data-provider-field="proxy" value="${escapeHtml(provider.proxy || '')}" placeholder="http://127.0.0.1:7890" /></label>
            </div>
            <label class="model-editor-block">
              <span>请求头覆盖（JSON 对象，同名会覆盖默认请求头）</span>
              <textarea class="model-textarea" data-provider-field="headers" placeholder='{"X-Custom":"1"}'>${escapeHtml(
                provider.headers && Object.keys(provider.headers).length ? JSON.stringify(provider.headers, null, 2) : '',
              )}</textarea>
            </label>
            <div class="model-editor-actions">
              <button class="outline-btn model-mini-btn primary-soft" data-action="save-advanced">保存高级配置</button>
            </div>
          </div>`
      }

      const providerDetail = provider => `
        <div class="model-detail-head">
          <div>
            <div class="model-detail-title">${escapeHtml(provider.name || provider.id)}${provider.managed ? '<em class="model-tag">托管</em>' : ''}</div>
            <div class="model-detail-sub">${escapeHtml(typeLabel(provider.type))} · ${escapeHtml(provider.baseURL || '未设置地址')}</div>
          </div>
          <div class="model-detail-actions">
            ${statusBadge(provider.status)}
            <button class="outline-btn model-mini-btn" data-action="test">测试连接</button>
            ${provider.managed ? '<button class="outline-btn model-mini-btn" data-action="refresh">获取模型列表</button>' : ''}
            ${
              provider.managed
                ? ''
                : `<button class="outline-btn model-delete-provider" data-action="delete-provider">${icons.trash}<span>删除提供商</span></button>`
            }
          </div>
        </div>
        ${providerForm(provider)}
        ${modelsSection(provider)}
        ${provider.managed ? '<div class="model-note">托管提供商由官方服务维护，不能直接修改。</div>' : ''}`

      const customPanel = () => {
        const providers = providerPayload.providers || []
        // 只做展示兜底，不改写 selectedId：新建提供商后的中间态渲染
        // 可能还在用旧 payload，提前改写会把刚选中的提供商丢掉。
        const provider = selectedProvider() || providers[0] || null
        return `
          <div class="model-provider-layout">
            ${providerSide()}
            <div class="model-provider-main">
              ${
                creatingProvider
                  ? createProviderForm()
                  : provider
                    ? providerDetail(provider)
                    : '<div class="model-empty"><div class="model-empty-title">还没有提供商</div><div class="model-empty-desc">点击左上角「新增」接入第一个模型服务。</div></div>'
              }
            </div>
          </div>`
      }

      /* ---------------- 当前生效（两套面板共用） ---------------- */
      const reasoningSliderHtml = () => {
        const effort = config.get('chat.reasoningEffort', 'off')
        const index = reasoningIndexFor(effort)
        const level = REASONING_LEVELS[index]
        const style = REASONING_CSS[level.id]
        const percent = (index / (REASONING_LEVELS.length - 1)) * 100
        return `
          <div class="param-slider reasoning-${level.id}" data-slider="reasoning" style="--p:${percent}%;--c:${style.color};--white:${style.white}">
            <div class="param-slider-track">
              <div class="param-slider-rail"></div>
              <div class="param-slider-fill"></div>
              <div class="param-slider-flow"></div>
              <div class="param-slider-sparkles"><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>
              <div class="param-slider-knob"></div>
              <input type="range" min="0" max="${REASONING_LEVELS.length - 1}" step="1" value="${index}"
                data-slider-range aria-label="推理等级" title="${escapeHtml(level.hint)}" />
            </div>
            <span class="param-slider-value" data-slider-value>${escapeHtml(level.label)}</span>
          </div>`
      }

      const temperatureSliderHtml = () => {
        const value = Math.max(0, Math.min(2, Number(config.get('chat.temperature', 1)) || 0))
        const { color, white } = temperatureColor(value)
        const percent = (value / 2) * 100
        return `
          <div class="param-slider temp-slider" data-slider="temperature" style="--p:${percent}%;--c:${color};--white:${white}">
            <div class="param-slider-track">
              <div class="param-slider-rail"></div>
              <div class="param-slider-fill"></div>
              <div class="param-slider-flow"></div>
              <div class="param-slider-knob"></div>
              <input type="range" min="0" max="2" step="0.05" value="${value}"
                data-slider-range aria-label="随机性 temperature" title="0 - 2 连续可调" />
            </div>
            <span class="param-slider-value" data-slider-value>${value.toFixed(2)}</span>
          </div>`
      }

      const currentSection = () => {
        const activeKey = registry.activeKey()
        const modelList = registry.list()
        const modelControl = modelList.length
          ? `<select class="setting-select" data-active-model style="min-width:230px">${modelList
              .map(
                item =>
                  `<option value="${escapeHtml(item.key)}" ${item.key === activeKey ? 'selected' : ''}>${escapeHtml(item.name || item.id)}（${escapeHtml(item.providerName || item.provider)}）</option>`,
              )
              .join('')}</select>`
          : '<span class="text-warn">● 没有可用模型</span>'
        const failoverOptions =
          `<option value="">（不启用备用模型）</option>` +
          modelList
            .map(
              item =>
                `<option value="${escapeHtml(item.key)}" ${String(config.get('model.failoverKey', '')) === item.key ? 'selected' : ''}>${escapeHtml(item.name || item.id)}（${escapeHtml(item.providerName || item.provider)}）</option>`,
            )
            .join('')
        const reasoningLevel = REASONING_LEVELS[reasoningIndexFor(config.get('chat.reasoningEffort', 'off'))]
        return section(
          '当前生效',
          card(
            row('模型', '从当前启用 / 已配置的模型里选择，发送消息时使用', modelControl) +
              `<div class="setting-row">
                 <div class="setting-main">
                   <div class="setting-name">推理等级</div>
                   <div class="setting-help" data-reasoning-help>off / low / high / max，对应 DeepSeek thinking + reasoning_effort；当前：${escapeHtml(reasoningLevel.label)}（${escapeHtml(reasoningLevel.id)}）</div>
                 </div>
                 <div class="setting-control">${reasoningSliderHtml()}</div>
               </div>
               <div class="setting-row">
                 <div class="setting-main">
                   <div class="setting-name">随机性 temperature</div>
                   <div class="setting-help">0 - 2 连续可调，和推理等级相互独立（temperature 不等于思考强度）；这里是全局默认值，模型列表里单独设置过 temperature 的模型优先使用模型参数</div>
                 </div>
                 <div class="setting-control">${temperatureSliderHtml()}</div>
               </div>` +
              row('流式输出', '实时显示模型输出', switchBtn('chat.stream', true)) +
              row('失败自动切换模型', '当前模型在输出任何内容前报错时，自动尝试备用模型；已输出内容不重试，避免重复气泡', switchBtn('model.failoverEnabled', false)) +
              row(
                '备用模型',
                '失败时按此模型重试；建议选择另一个提供商或另一个可用模型',
                `<select class="setting-select" data-config-select="model.failoverKey" style="min-width:230px">${failoverOptions}</select>`,
              ) +
              row(
                '备用模型重试次数',
                '0 = 不重试；默认 1 次',
                `<input class="setting-input" type="number" min="0" max="3" style="width:70px" data-config-input="model.failoverRetries" value="${escapeHtml(String(config.get('model.failoverRetries', 1)))}" />`,
              ),
          ),
        )
      }

      /* ---------------- 渲染 ---------------- */
      const render = () => {
        // 设置容器会在切页时复用同一个 .settings-content 节点；
        // 离开本页后，任何迟到的异步 render 都不能再写进来。
        if (disposed) return
        const official = officialService()
        const useBuiltin = !!official && config.get('model.useBuiltin', true) !== false
        const backendOnline = !!health
        const staleBackend = backendOnline && !(health?.capabilities || []).includes('provider-crud')
        unbindConfig?.()
        unbindSliderConfig?.()
        container.innerHTML = page(
          '模型',
          official
            ? '统一管理模型来源：默认可使用念风内置模型；关闭开关后可配置任意 OpenAI 兼容 / Anthropic / Ollama 提供商。'
            : '配置任意 OpenAI 兼容 / Anthropic / Ollama 提供商。',
          `
          ${
            official
              ? card(
                  row(
                    '使用念风内置模型',
                    '由「念风官方服务」插件提供；官方服务端尚未制作时，下方会如实展示空状态。禁用该插件后本区块会一起隐藏。',
                    `<span class="model-mode-hint">${
                      useBuiltin ? '<span class="model-mode-pill">默认开启</span>' : '<span class="model-mode-pill" style="background:rgba(0,0,0,.05);color:var(--text-3)">已关闭</span>'
                    }<button class="switch ${useBuiltin ? 'on' : ''}" data-action="toggle-builtin"></button></span>`,
                  ),
                )
              : ''
          }
          ${
            staleBackend
              ? '<div class="settings-note model-stale">检测到正在运行的后端进程缺少最新接口（provider-crud 等）。请完全关闭念风（旧窗口 / 终端）后重新运行 start.cmd 或 npm start，再回来配置模型。</div>'
              : ''
          }
          ${useBuiltin ? builtinPanel() : customPanel()}
          ${currentSection()}
          <div class="settings-note">
            ${
              backendOnline
                ? `自定义提供商的地址 / Key / 模型参数保存在本机后端（${escapeHtml(health?.dataDir || 'user_data')}），API Key 不会下发到浏览器。`
                : '本地后端未连接：提供商配置暂时不可读写，请检查后端是否已启动。'
            }
          </div>`,
        )

        unbindConfig = bindConfigControls(container, ctx)
        bindActions()
        bindCompactSliders()
      }

      /* ---------------- 数据加载 ---------------- */
      const loadBuiltin = async ({ notify = false } = {}) => {
        const official = officialService()
        if (!official) {
          builtin = null
          builtinLoading = false
          render()
          return
        }
        builtinLoading = true
        render()
        try {
          builtin = await official.builtin?.({ force: notify })
          if (!builtin) builtin = { available: false, models: [], reason: '官方服务插件未提供内置模型接口。' }
          if (notify) {
            builtin?.available ? toast.success('内置模型已刷新') : toast.info('官方服务尚未接入，暂时没有内置模型')
          }
        } catch (err) {
          builtin = { available: false, models: [], reason: `无法连接本地后端：${err.message}` }
          if (notify) toast.error(`检测失败：${err.message}`)
        } finally {
          builtinLoading = false
          render()
        }
      }

      const loadProviders = async ({ notify = false } = {}) => {
        try {
          health = await api.health()
          providerPayload = await api.providers()
          const list = providerPayload.providers || []
          // 只有拿到最新列表后才校正选中项；新建表单打开期间保持当前选择
          if (!creatingProvider && (!selectedId || !list.some(p => p.id === selectedId))) {
            selectedId = list[0]?.id || ''
          }
          await adapter?.sync?.({ silent: true })
          render()
          if (notify) toast.success('提供商列表已刷新')
        } catch (err) {
          health = null
          providerPayload = { providers: [], adapters: [], defaultProvider: '', defaultModel: '' }
          render()
          if (notify) toast.error(`后端不可用：${err.message}`)
        }
      }

      const syncAndReload = async () => {
        await adapter?.sync?.({ silent: true })
        await loadProviders()
      }

      /* ---------------- 表单读取 ---------------- */
      const readProviderPatch = ({ includeAdvanced = true } = {}) => {
        const q = sel => container.querySelector(`[data-provider-field="${sel}"]`)
        const patch = {
          name: fieldValue(q('name')).trim(),
          type: readSelect(q('type')),
          baseURL: fieldValue(q('baseURL')).trim(),
          enabled: q('provider-enabled') ? q('provider-enabled').classList.contains('on') : undefined,
          defaultModel: readSelect(q('defaultModel')),
        }
        if (!patch.name) delete patch.name
        if (!patch.type) delete patch.type
        if (!patch.baseURL) delete patch.baseURL
        if (patch.enabled === undefined) delete patch.enabled
        if (patch.defaultModel === undefined) delete patch.defaultModel
        const apiKey = fieldValue(q('apiKey')).trim()
        if (apiKey) patch.apiKey = apiKey
        if (includeAdvanced) {
          const timeout = toNumber(fieldValue(q('timeoutMs')).trim())
          patch.timeoutMs = timeout ?? 0
          patch.proxy = fieldValue(q('proxy')).trim()
          const headersText = fieldValue(q('headers')).trim()
          if (!headersText) patch.headers = {}
          else {
            let data
            try {
              data = JSON.parse(headersText)
            } catch (_) {
              throw new Error('请求头覆盖不是合法 JSON')
            }
            if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('请求头覆盖必须是 JSON 对象')
            patch.headers = data
          }
        }
        return patch
      }

      const readNewModel = () => {
        const q = sel => container.querySelector(`[data-new-model="${sel}"]`)
        const id = fieldValue(q('id')).trim()
        if (!id) throw new Error('模型 ID 不能为空')
        return { id, name: fieldValue(q('name')).trim() || id }
      }

      /* ---------------- 操作分发 ---------------- */
      const selectProviderById = id => {
        if (!id || selectedId === id) return
        selectedId = id
        editingModelId = ''
        addingModel = false
        creatingProvider = false
        advancedOpen = false
        render()
      }

      /** 渲染后给每个控件挂直接监听（不依赖事件冒泡，Node DOM 垫片同样可用） */
      const bindActions = () => {
        container.querySelectorAll('[data-action]').forEach(el => el.addEventListener('click', () => handleAction(el.dataset.action, el)))
        container.querySelectorAll('[data-provider-id]').forEach(el => {
          if (el.dataset.action) return
          el.addEventListener('click', () => selectProviderById(el.dataset.providerId))
          el.addEventListener('keydown', event => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              selectProviderById(el.dataset.providerId)
            }
          })
        })
        container.querySelectorAll('[data-provider-delete]').forEach(el =>
          el.addEventListener('click', event => {
            event.stopPropagation()
            deleteProviderFlow(el.dataset.providerDelete)
          }),
        )
        for (const flag of ['data-model-toggle', 'data-model-edit', 'data-model-delete', 'data-model-cancel', 'data-model-save']) {
          container.querySelectorAll(`[${flag}]`).forEach(el => el.addEventListener('click', () => handleAction('', el)))
        }
        container.querySelectorAll('[data-active-model]').forEach(select => {
          select.addEventListener('change', () => {
            try {
              registry.select(select.value)
              const item = registry.list().find(entry => entry.key === select.value)
              toast.success(`已切换模型：${item?.name || select.value}`)
              render()
            } catch (err) {
              toast.error(`切换模型失败：${err.message}`)
            }
          })
        })
      }

      /**
       * 紧凑参数滑块：拖动只更新视觉，松手才写 config（不整页重渲染，交互顺滑）。
       * 推理等级 4 档；temperature 0-2 连续。
       *
       * 除了本机拖动，这里还订阅 config 的推理 / temperature：电脑端修改后
       * 后端 SSE 推送过来时，手机页面上已经打开的参数面板会立刻更新，不再
       * 需要刷新页面才看到新值。
       */
      const bindCompactSliders = () => {
        unbindSliderConfig?.()
        const offs = []
        const reasoning = container.querySelector('[data-slider="reasoning"]')
        if (reasoning) {
          const input = reasoning.querySelector('[data-slider-range]')
          const valueLabel = reasoning.querySelector('[data-slider-value]')
          const help = container.querySelector('[data-reasoning-help]')
          const applyValue = effort => {
            const index = reasoningIndexFor(effort)
            const level = REASONING_LEVELS[index]
            input.value = String(index)
            const style = REASONING_CSS[level.id]
            const percent = (index / (REASONING_LEVELS.length - 1)) * 100
            reasoning.className = `param-slider reasoning-${level.id}`
            reasoning.style.setProperty('--p', `${percent}%`)
            reasoning.style.setProperty('--c', style.color)
            reasoning.style.setProperty('--white', style.white)
            if (valueLabel) valueLabel.textContent = level.label
            input.title = level.hint
            if (help) {
              help.textContent = `off / low / high / max，对应 DeepSeek thinking + reasoning_effort；当前：${level.label}（${level.id}）`
            }
          }
          const preview = () => applyValue(REASONING_LEVELS[Number(input.value) || 0]?.id || 'off')
          input.addEventListener('input', preview)
          input.addEventListener('change', () => {
            const index = Math.max(0, Math.min(REASONING_LEVELS.length - 1, Number(input.value) || 0))
            config.set('chat.reasoningEffort', REASONING_LEVELS[index].id)
          })
          offs.push(config.watch('chat.reasoningEffort', applyValue))
        }

        const temperature = container.querySelector('[data-slider="temperature"]')
        if (temperature) {
          const input = temperature.querySelector('[data-slider-range]')
          const valueLabel = temperature.querySelector('[data-slider-value]')
          const applyValue = next => {
            const value = Math.max(0, Math.min(2, Number(next) || 0))
            input.value = String(value)
            const { color, white } = temperatureColor(value)
            temperature.style.setProperty('--p', `${(value / 2) * 100}%`)
            temperature.style.setProperty('--c', color)
            temperature.style.setProperty('--white', white)
            if (valueLabel) valueLabel.textContent = value.toFixed(2)
          }
          const preview = () => applyValue(input.value)
          input.addEventListener('input', preview)
          input.addEventListener('change', () => {
            const value = Math.max(0, Math.min(2, Number(input.value) || 0))
            config.set('chat.temperature', Number(value.toFixed(2)))
          })
          offs.push(config.watch('chat.temperature', applyValue))
        }

        unbindSliderConfig = () => offs.forEach(off => off?.())
      }

      const deleteProviderFlow = async id => {
        const provider = (providerPayload.providers || []).find(p => p.id === id)
        if (!provider) return
        if (provider.managed) {
          toast.info('托管提供商由官方服务维护，不能删除')
          return
        }
        const answer = await modal.confirm('删除提供商', `确定删除「${provider.name || provider.id}」吗？它的模型配置也会一并移除，且不可恢复。`)
        if (!answer?.ok) return
        try {
          await api.removeProvider(provider.id)
          toast.success('提供商已删除')
          if (selectedId === provider.id) {
            selectedId = ''
            editingModelId = ''
          }
          await syncAndReload()
        } catch (err) {
          toast.error(friendlyError(err))
        }
      }

      const friendlyError = err => {
        const message = err?.message || String(err)
        return /接口不存在/.test(message) ? `${message}（看起来是旧版后端进程，请完全退出后重新启动念风）` : message
      }

      const handleAction = async (action, target) => {
        const provider = selectedProvider()
        const modelItem = target?.closest ? target.closest('[data-model-id]') : null
        const modelId = modelItem?.dataset.modelId || ''

        try {
          switch (action) {
            case 'toggle-builtin': {
              if (!officialService()) {
                toast.warn('念风官方服务插件未启用，内置模型入口不可用')
                break
              }
              const next = !(config.get('model.useBuiltin', true) !== false)
              config.set('model.useBuiltin', next)
              render()
              if (next) loadBuiltin()
              else if (!providerPayload.providers.length) loadProviders()
              break
            }
            case 'reload-builtin':
              if (!officialService()) {
                toast.warn('念风官方服务插件未启用，内置模型入口不可用')
                break
              }
              await loadBuiltin({ notify: true })
              break
            case 'use-custom':
              config.set('model.useBuiltin', false)
              render()
              await loadProviders()
              break
            case 'save-request-body': {
              const raw = fieldValue(container.querySelector('[data-field="request-body"]')).trim()
              if (raw) {
                try {
                  const parsed = JSON.parse(raw)
                  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('必须是 JSON 对象')
                } catch (err) {
                  container.querySelector('[data-role="request-body-hint"]')?.classList.add('bad')
                  toast.error(`请求体不是合法 JSON：${err.message}`)
                  break
                }
              }
              config.set('model.requestBody', raw)
              toast.success('自定义请求体已保存')
              render()
              break
            }
            case 'save-timeout': {
              const value = Number(fieldValue(container.querySelector('[data-field="builtin-timeout"]')).trim() || 60000)
              if (!Number.isFinite(value) || value < 1000) {
                toast.error('超时时间至少为 1000 毫秒')
                break
              }
              config.set('model.timeoutMs', Math.round(value))
              toast.success('超时时间已保存')
              render()
              break
            }
            case 'new-provider':
              creatingProvider = true
              addingModel = false
              render()
              break
            case 'cancel-new-provider':
              creatingProvider = false
              render()
              break
            case 'create-provider': {
              const body = {
                id: fieldValue(container.querySelector('[data-create="id"]')).trim(),
                name: fieldValue(container.querySelector('[data-create="name"]')).trim(),
                type: readSelect(container.querySelector('[data-create="type"]')) || 'openai',
                baseURL: fieldValue(container.querySelector('[data-create="baseURL"]')).trim(),
                apiKey: fieldValue(container.querySelector('[data-create="apiKey"]')).trim(),
              }
              if (!body.id) throw new Error('请填写提供商 ID')
              const result = await api.addProvider(body)
              selectedId = result?.provider?.id || body.id
              creatingProvider = false
              toast.success(`已新增提供商「${body.name || body.id}」`)
              await syncAndReload()
              break
            }
            case 'save-provider':
            case 'save-advanced': {
              if (!provider) break
              if (provider.managed) {
                toast.info('托管提供商不可编辑')
                break
              }
              const patch = readProviderPatch()
              await api.updateProvider(provider.id, patch)
              if (patch.defaultModel) {
                try {
                  registry.select(`${provider.id}/${patch.defaultModel}`)
                } catch (_) {
                  /* 模型可能已被停用，保持当前选择 */
                }
              }
              toast.success(`已保存「${provider.name || provider.id}」`)
              await syncAndReload()
              break
            }
            case 'delete-provider': {
              if (!provider) break
              await deleteProviderFlow(provider.id)
              break
            }

            case 'test': {
              if (!provider) break
              toast.info(`正在测试「${provider.name || provider.id}」…`)
              const result = await api.testProvider(provider.id)
              if (result?.ok) toast.success(`连接正常${result.latency ? `（${result.latency}ms）` : ''}：${result.detail || ''}`)
              else toast.error(`连接失败：${result?.detail || '未知错误'}`)
              await loadProviders()
              break
            }
            case 'refresh': {
              if (!provider || refreshingProvider) break
              refreshingProvider = provider.id
              container.querySelectorAll('[data-action="refresh"]').forEach(button => {
                button.disabled = true
              })
              if (target) target.textContent = '获取中…'
              toast.info(`正在获取「${provider.name || provider.id}」的模型列表…`)
              try {
                const result = await api.refreshProvider(provider.id)
                if (result?.ok) toast.success(result.detail || `已更新 ${result.models?.length || 0} 个模型`)
                else toast.error(`获取失败：${result?.detail || '未知错误'}`)
              } catch (err) {
                toast.error(`获取失败：${err.message}`)
              } finally {
                refreshingProvider = ''
              }
              await syncAndReload()
              break
            }
            case 'add-model':
              addingModel = true
              editingModelId = ''
              render()
              break
            case 'cancel-add-model':
              addingModel = false
              render()
              break
            case 'confirm-add-model': {
              if (!provider) break
              const model = readNewModel()
              await api.addModel(provider.id, model)
              addingModel = false
              toast.success(`已添加模型「${model.name}」`)
              await syncAndReload()
              break
            }
            case 'toggle-provider-enabled': {
              if (!provider || provider.managed) break
              const next = !target.classList.contains('on')
              target.classList.toggle('on', next)
              await api.updateProvider(provider.id, { enabled: next })
              await syncAndReload()
              break
            }
            case 'toggle-advanced':
              advancedOpen = !advancedOpen
              render()
              break
          }
        } catch (err) {
          toast.error(friendlyError(err))
        }

        // 模型级操作（按钮不带 data-action，单独分发）
        if (target.dataset.modelToggle !== undefined || hasFlag(target, 'data-model-toggle')) {
          if (!provider || !modelId) return
          if (provider.managed) {
            toast.info('托管提供商的模型不可编辑')
            return
          }
          const next = !target.classList.contains('on')
          target.classList.toggle('on', next)
          try {
            await api.updateModel(provider.id, modelId, { enabled: next })
            await syncAndReload()
          } catch (err) {
            toast.error(friendlyError(err))
          }
          return
        }
        if (hasFlag(target, 'data-model-edit')) {
          editingModelId = editingModelId === modelId ? '' : modelId
          addingModel = false
          render()
          return
        }
        if (hasFlag(target, 'data-model-delete')) {
          if (!provider || !modelId) return
          const answer = await modal.confirm('删除模型', `确定删除模型「${modelId}」吗？`)
          if (!answer?.ok) return
          try {
            await api.removeModel(provider.id, modelId)
            if (editingModelId === modelId) editingModelId = ''
            toast.success('模型已删除')
            await syncAndReload()
          } catch (err) {
            toast.error(friendlyError(err))
          }
          return
        }
        if (hasFlag(target, 'data-model-cancel')) {
          editingModelId = ''
          render()
          return
        }
        if (hasFlag(target, 'data-model-save')) {
          if (!provider || !modelId) return
          const q = sel => modelItem.querySelector(`[data-model-field="${sel}"]`)
          try {
            const params = {
              temperature: fieldValue(q('temperature')).trim(),
              maxTokens: fieldValue(q('maxTokens')).trim(),
              contextLength: fieldValue(q('contextLength')).trim(),
              priceInput: fieldValue(q('priceInput')).trim(),
              priceOutput: fieldValue(q('priceOutput')).trim(),
              priceCached: fieldValue(q('priceCached')).trim(),
            }
            const extraRaw = fieldValue(q('extraBody')).trim()
            if (extraRaw) {
              const parsed = JSON.parse(extraRaw)
              if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('额外请求体必须是 JSON 对象')
              params.extraBody = parsed
            } else {
              params.extraBody = null
            }
            await api.updateModel(provider.id, modelId, {
              name: fieldValue(q('name')).trim(),
              params,
            })
            editingModelId = ''
            toast.success('模型参数已保存')
            await syncAndReload()
          } catch (err) {
            toast.error(`保存失败：${friendlyError(err)}`)
          }
        }
      }

      /* ---------------- 启动 ---------------- */
      const offs = [
        ctx.on('models:synced', render),
        ctx.on('model:models-updated', render),
        ctx.on('backend:status', () => loadProviders()),
        // 该开关不是 data-config-* 常规控件；电脑端修改后同样实时刷新手机上的模型页。
        config.watch('model.useBuiltin', () => {
          if (!disposed) render()
        }),
        ctx.on('plugin:enabled', payload => {
          if (payload?.id !== 'official-service') return
          render()
          if (config.get('model.useBuiltin', true) !== false) loadBuiltin()
        }),
        ctx.on('plugin:disabled', payload => {
          if (payload?.id !== 'official-service') return
          builtin = null
          builtinLoading = false
          render()
        }),
      ]

      render()
      loadProviders()
      if (officialService() && config.get('model.useBuiltin', true) !== false) loadBuiltin()

      return () => {
        disposed = true
        offs.forEach(off => off?.())
        unbindConfig?.()
        unbindSliderConfig?.()
      }
    },
  })
}
