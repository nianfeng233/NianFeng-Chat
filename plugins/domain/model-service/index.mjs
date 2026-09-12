/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * D4 · model-service
 * 模型抽象接口：stream / complete（文档 §8.1）。
 * chat-flow 只认这个服务，不认任何具体适配器。
 */
export const name = 'model-service'
export const version = '1.0.0'
export const displayName = '模型服务'
export const description = '业务服务 · 模型抽象接口与调度，具体由适配器插件实现。'
export const author = '念风内核'
export const icon = '🤖'
export const core = true
export const depends = { 'model-registry': '^1.0.0', config: '^1.0.0' }
export const inject = ['model-registry', 'config', 'event-bus']
export const provides = [{ name: 'model-service', type: 'singleton' }]

export function apply(ctx) {
  const registry = ctx.inject('model-registry')
  const config = ctx.inject('config')
  const events = ctx.inject('event-bus')

  const service = {
    name: 'model-service',

    providers: () => registry.providers(),
    models: () => registry.list(),
    activeKey: () => registry.activeKey(),
    active: () => registry.active(),
    select: key => registry.select(key),

    /**
     * 流式补全。
     * @param {Array<{role:string, content:string}>} messages
     * @param {{ model?: string, temperature?: number, signal?: AbortSignal }} options
     * @param {{ onStart?:Function, onChunk:Function, onDone:Function, onError:Function }} callbacks
     * @returns {{ abort: Function }}
     */
    stream(messages, options = {}, callbacks = {}) {
      const key = options.model || registry.activeKey()
      const resolved = registry.resolve(key)
      if (!resolved?.providerImpl?.stream) {
        const err = new Error(
        registry.list().length === 0
          ? '尚未配置模型提供商：请到「设置 → 模型」接入 Ollama（本地）或 OpenAI 兼容接口'
          : `模型未就绪：${key || '未选择模型'}`,
      )
        callbacks.onError?.(err)
        events.emit('model:error', { key, error: err })
        return { abort() {} }
      }

      const controller = new AbortController()
      const signal = options.signal || controller.signal
      let aborted = false

      const finishError = error => {
        if (aborted) return
        aborted = true
        callbacks.onError?.(error)
        events.emit('model:error', { key, error })
      }

      try {
        callbacks.onStart?.({ key, model: resolved.model })
        events.emit('model:start', { key, messages })
        Promise.resolve(
          resolved.providerImpl.stream({
            messages,
            model: resolved.model,
            provider: resolved.provider,
            options: { ...resolved.providerImpl.defaults, ...options },
            signal,
            onChunk: delta => {
              if (aborted) return
              callbacks.onChunk?.(delta)
            },
            onToolCall: call => {
              if (aborted) return
              callbacks.onToolCall?.(call)
            },
            onReasoning: delta => {
              if (aborted) return
              callbacks.onReasoning?.(delta)
            },
            onDone: summary => {
              if (aborted) return
              aborted = true
              callbacks.onDone?.(summary || {})
              events.emit('model:done', { key, usage: summary?.usage || null, finishReason: summary?.reason || null })
            },
            onError: finishError,
          }),
        ).catch(finishError)
      } catch (err) {
        finishError(err)
      }

      return {
        abort() {
          if (aborted) return
          aborted = true
          controller.abort()
          events.emit('model:aborted', { key })
        },
      }
    },

    /** 非流式，返回完整文本 */
    complete(messages, options = {}) {
      return new Promise((resolve, reject) => {
        let text = ''
        service.stream(messages, { ...options, stream: false }, {
          onChunk: delta => {
            text += delta
          },
          onDone: () => resolve(text),
          onError: reject,
        })
      })
    },
  }

  ctx.provide('model-service', service, { type: 'singleton' })
  ctx.logger.debug(`模型服务就绪 · 当前模型 ${registry.activeKey()}`)
}
