/**
 * D3 · model-registry
 * 注册所有可用模型。模型适配器插件（B7~B9）把 provider 注册进来，
 * 每个模型同时会进入可选中服务 `model`（文档 §4.5）。
 */
export const name = 'model-registry'
export const version = '1.0.0'
export const displayName = '模型注册表'
export const description = '业务服务 · 注册所有可用模型与提供商。'
export const author = '风语内核'
export const icon = '📚'
export const core = true
export const depends = { 'service-container': '^1.0.0' }
export const inject = ['event-bus', 'service-container']
export const provides = [{ name: 'model-registry', type: 'singleton' }]

export function apply(ctx) {
  const container = ctx.inject('service-container')
  const events = ctx.inject('event-bus')

  /** providerId -> { id, name, kind, description, meta, models: Map } */
  const providers = new Map()
  const models = container.createSelectable('model', { displayName: '模型', fallback: null })

  /** 没有任何真实模型时，给出明确引导而不是假装能回复 */
  const requireModel = () => {
    if (models.list().length === 0) {
      throw new Error('尚未配置模型提供商：请到「设置 → 模型」接入 Ollama 或 OpenAI 兼容接口')
    }
  }

  const service = {
    name: 'model-registry',
    selectable: models,

    /**
     * 注册提供商。
     * @param {string} id
     * @param {{name:string, kind:string, description?:string, models:Array, defaults?:object}} provider
     */
    registerProvider(id, provider) {
      if (providers.has(id)) throw new Error(`模型提供商已注册：${id}`)
      const record = {
        id,
        name: provider.name || id,
        kind: provider.kind || 'custom',
        description: provider.description || '',
        defaults: provider.defaults || {},
        models: new Map(),
        raw: provider,
      }
      for (const model of provider.models || []) {
        record.models.set(model.id, model)
        models.register(`${id}/${model.id}`, { provider: id, model, ...provider, models: undefined }, {
          label: model.name || model.id,
          provider: id,
          providerName: record.name,
          description: model.description || record.description,
          tags: model.tags || [],
        })
      }
      providers.set(id, record)
      events.emit('model:provider-registered', { id, provider: record })
      ctx.logger.debug(`模型提供商 ${id} 已注册（${record.models.size} 个模型）`)
      return () => service.unregisterProvider(id)
    },

    unregisterProvider(id) {
      const record = providers.get(id)
      if (!record) return false
      for (const modelId of record.models.keys()) models.unregister(`${id}/${modelId}`)
      providers.delete(id)
      return true
    },

    providers: () => [...providers.values()],
    provider: id => providers.get(id) || null,

    /** 后端刷新模型列表后同步进来（保持 provider 对象不变） */
    replaceModels(id, nextModels = []) {
      const record = providers.get(id)
      if (!record) return false
      for (const modelId of [...record.models.keys()]) {
        record.models.delete(modelId)
        models.unregister(`${id}/${modelId}`)
      }
      for (const model of nextModels) {
        record.models.set(model.id, model)
        models.register(
          `${id}/${model.id}`,
          { provider: id, model, ...record.raw, models: undefined },
          {
            label: model.name || model.id,
            provider: id,
            providerName: record.name,
            description: model.description || record.description,
            tags: model.tags || [],
          },
        )
      }
      events.emit('model:models-updated', { id, count: record.models.size })
      return true
    },

    /** 全部模型：[{ key, id, name, provider, ... }] */
    list() {
      return [...providers.values()].flatMap(provider =>
        [...provider.models.values()].map(model => ({
          key: `${provider.id}/${model.id}`,
          id: model.id,
          name: model.name || model.id,
          provider: provider.id,
          providerName: provider.name,
          description: model.description || '',
          tags: model.tags || [],
          context: model.context || 0,
        })),
      )
    },

    /** 拿到某个模型所属的 provider 原始对象（含 stream 实现） */
    resolve(key) {
      if (!key) return null
      const active = models.getActive()
      const useKey = key || models.getActiveId()
      const found = models.get(useKey)
      if (!found) return null
      return { key: useKey, provider: found.provider, model: found.model, providerImpl: providers.get(found.provider)?.raw }
    },

    get: key => service.resolve(key),
    select: key => models.select(key),
    activeKey: () => models.getActiveId(),
    active: () => service.resolve(models.getActiveId()),
    requireModel,
  }

  ctx.provide('model-registry', service, { type: 'singleton' })
  ctx.logger.debug('模型注册表就绪')
}
