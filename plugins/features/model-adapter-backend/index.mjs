/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * 真实模型适配器：把本地后端的提供商（OpenAI 兼容 / Anthropic / Ollama）
 * 注册进前端 model-registry，聊天通过 /api/chat（SSE）流式返回。
 *
 * 这是当前唯一的模型适配器；没有配置任何提供商时，
 * 聊天会明确提示去「设置 → 模型」配置，而不是返回假回复。
 */
export const name = 'model-adapter-backend'
export const version = '2.0.0'
export const displayName = '后端模型适配器'
export const description = '模型适配器 · 通过本地后端接入真实模型（OpenAI 兼容 / Anthropic / Ollama）。'
export const author = '念风内核'
export const icon = '🔌'
export const core = true
export const depends = { 'model-registry': '^1.0.0', 'backend-client': '^1.0.0' }
export const inject = ['api', 'model-registry', 'config', 'toast']
export const provides = []

export function apply(ctx) {
  const api = ctx.inject('api')
  const registry = ctx.inject('model-registry')
  const config = ctx.inject('config')
  const toast = ctx.inject('toast')

  /** providerId -> 是否已注册 */
  const registered = new Set()
  /** providerId -> 注销函数（插件卸载 / provider 移除时释放，避免重新启用时“已注册”冲突） */
  const providerDisposers = new Map()

  const ensureProvider = (provider, defaults = {}) => {
    const models = (provider.models || [])
      .filter(model => model.enabled !== false)
      .map(model => ({
        id: model.id,
        name: model.name || model.id,
        description: [provider.type, model.ownedBy, model.size ? `${Math.round(model.size / 1024 / 1024)}MB` : '', model.custom ? '自定义' : '']
          .filter(Boolean)
          .join(' · '),
        tags: provider.configured ? [] : ['未配置'],
        params: model.params && typeof model.params === 'object' ? model.params : {},
      }))

    if (!registered.has(provider.id)) {
      const dispose = registry.registerProvider(provider.id, {
        name: provider.name,
        kind: `backend · ${provider.type}`,
        description: `${provider.baseURL}${provider.configured ? '' : ' · 未配置凭据'}`,
        baseURL: provider.baseURL,
        models,
        async stream({ messages, model, options, signal, onChunk, onToolCall, onReasoning, onDone, onError }) {
          const params = model?.params || {}
          await api.streamChat({
            provider: provider.id,
            model: model.id,
            messages,
            temperature: options?.temperature ?? params.temperature,
            maxTokens: options?.maxTokens ?? params.maxTokens,
            reasoningEffort: options?.reasoningEffort ?? params.reasoningEffort,
            extraBody: options?.extraBody ?? params.extraBody,
            tools: options?.tools,
            toolChoice: options?.toolChoice,
            signal,
            onChunk,
            onReasoning,
            onToolCall,
            onDone,
            onError,
          })
        },
      })
      providerDisposers.set(provider.id, dispose)
      registered.add(provider.id)
    } else {
      registry.replaceModels(provider.id, models)
    }

    return models.length
  }

  const sync = async ({ silent = false } = {}) => {
    try {
      const payload = await api.providers()
      const providers = (payload.providers || []).filter(p => p.enabled !== false)
      const ids = new Set(providers.map(p => p.id))
      // 后端删除 / 停用的提供商从前端注册表撤下
      for (const id of [...registered]) {
        if (!ids.has(id)) {
          const dispose = providerDisposers.get(id)
          if (typeof dispose === 'function') dispose()
          else registry.unregisterProvider(id)
          providerDisposers.delete(id)
          registered.delete(id)
        }
      }
      const persistedKey = String(config.get('selectable.model.activeId', '') || '')
      let total = 0
      for (const provider of providers) total += ensureProvider(provider, payload)

      // model-registry 在注册第一个模型时会自动选中它，这可能覆盖用户上次的选择。
      // 同步完成后按优先级恢复：用户持久化的模型（如果仍存在）→ 后端默认模型。
      const available = registry.list()
      const trySelect = key => {
        if (!key || !available.some(item => item.key === key)) return false
        try {
          registry.select(key)
          return true
        } catch (_) {
          return false
        }
      }
      if (persistedKey && available.some(item => item.key === persistedKey)) {
        trySelect(persistedKey)
      } else {
        const desired =
          payload.defaultProvider && payload.defaultModel
            ? `${payload.defaultProvider}/${payload.defaultModel}`
            : ''
        trySelect(desired)
      }
      ctx.emit('models:synced', { providers: providers.length, models: total })
      if (!silent && total === 0) {
        ctx.logger.info('后端已连接，但还没有可用模型：请在设置 → 模型中拉取模型列表')
      }
      return { ok: true, providers: providers.length, models: total }
    } catch (err) {
      if (!silent) ctx.logger.warn(`模型列表同步失败：${err.message}`)
      ctx.emit('models:sync-failed', { error: err.message })
      return { ok: false, error: err.message }
    }
  }

  // 后端模型列表刷新 / 提供商状态变化时同步
  const offBackend = ctx.on('backend:event', ({ event }) => {
    if (event === 'provider/status' || event === 'settings/updated') sync({ silent: true })
  })

  const offModelsUpdated = ctx.on('model:models-updated', () => {})

  // 首次同步 + 后端恢复连接后重试
  sync({ silent: true })
  const offStatus = ctx.on('backend:status', ({ online }) => {
    if (online) sync({ silent: true })
  })

  // 供设置页调用的手动刷新
  const service = {
    name: 'model-adapter',
    sync,
    async refresh(providerId) {
      const result = await api.refreshProvider(providerId)
      await sync({ silent: true })
      return result
    },
    toastReady() {
      toast.success('模型列表已更新')
    },
  }

  ctx.provide('model-adapter', service, { type: 'singleton' })
  ctx.effect(() => {
    for (const dispose of providerDisposers.values()) {
      try {
        dispose()
      } catch (_) {
        /* ignore */
      }
    }
    providerDisposers.clear()
    registered.clear()
  })
  ctx.effect(offBackend)
  ctx.effect(offStatus)
  ctx.effect(offModelsUpdated)

  ctx.logger.debug('后端模型适配器就绪')
}
