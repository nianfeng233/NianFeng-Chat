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
export const depends = {
  'config': '^1.0.0',
  'event-bus': '*',
  'model-registry': '^1.0.0',
}
export const optionalDepends = {}
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
      const requestedKey = options.model || registry.activeKey()
      const startedAt = Date.now()
      const elapsed = () => Date.now() - startedAt
      const fallbackKey = String(config.get('model.failoverKey', '') || '').trim()
      const failoverEnabled = config.get('model.failoverEnabled', false) === true && !!fallbackKey && fallbackKey !== requestedKey
      const maxFallbacks = failoverEnabled ? Math.max(0, Math.min(3, Number(config.get('model.failoverRetries', 1)) || 0)) : 0

      let aborted = false
      let finished = false
      let emitted = false
      let attemptIndex = 0
      let currentKey = requestedKey
      let currentController = null
      const outerController = new AbortController()
      const signal = options.signal || outerController.signal

      const emitError = error => {
        if (aborted || finished) return
        // 只有“还没输出任何内容”时才适合自动切换，避免已经显示的半截回复被另一模型重写。
        if (!emitted && attemptIndex < maxFallbacks) {
          attemptIndex += 1
          const nextKey = fallbackKey
          events.emit('model:fallback', {
            from: currentKey,
            to: nextKey,
            error,
            attempt: attemptIndex,
          })
          ctx.logger.warn(`[model-service] 模型 ${currentKey} 失败，自动切换备用模型 ${nextKey}：${error?.message || error}`)
          startAttempt(nextKey)
          return
        }
        finished = true
        callbacks.onError?.(error)
        events.emit('model:error', { key: currentKey, error, elapsedMs: elapsed() })
      }

      const startAttempt = key => {
        const resolved = registry.resolve(key)
        if (!resolved?.providerImpl?.stream) {
          const err = new Error(
            registry.list().length === 0
              ? '尚未配置模型提供商：请到「设置 → 模型」接入 Ollama（本地）或 OpenAI 兼容接口'
              : `模型未就绪：${key || '未选择模型'}`,
          )
          emitError(err)
          return
        }
        currentKey = key
        emitted = false
        currentController = new AbortController()
        const abortCurrent = () => {
          try {
            currentController.abort(signal.reason)
          } catch (_) {
            /* ignore */
          }
        }
        if (signal.aborted) abortCurrent()
        else signal.addEventListener('abort', abortCurrent, { once: true })

        try {
          callbacks.onStart?.({ key, model: resolved.model, attempt: attemptIndex })
          events.emit('model:start', { key, model: resolved.model, at: startedAt, messages, attempt: attemptIndex })
          Promise.resolve(
            resolved.providerImpl.stream({
              messages,
              model: resolved.model,
              provider: resolved.provider,
              options: { ...resolved.providerImpl.defaults, ...options },
              signal: currentController.signal,
              onChunk: delta => {
                if (aborted) return
                emitted = true
                callbacks.onChunk?.(delta)
              },
              onToolCall: call => {
                if (aborted) return
                emitted = true
                callbacks.onToolCall?.(call)
              },
              onReasoning: delta => {
                if (aborted) return
                emitted = true
                callbacks.onReasoning?.(delta)
              },
              onDone: summary => {
                if (aborted || finished) return
                finished = true
                callbacks.onDone?.(summary || {})
                events.emit('model:done', {
                  key,
                  model: resolved.model,
                  usage: summary?.usage || null,
                  finishReason: summary?.reason || null,
                  elapsedMs: elapsed(),
                  attempt: attemptIndex,
                })
              },
              onError: emitError,
            }),
          ).catch(emitError)
        } catch (err) {
          emitError(err)
        }
      }

      startAttempt(requestedKey)

      return {
        abort() {
          if (aborted || finished) return
          aborted = true
          try {
            currentController?.abort()
            outerController.abort()
          } catch (_) {
            /* ignore */
          }
          events.emit('model:aborted', { key: currentKey })
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
