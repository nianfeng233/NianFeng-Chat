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
export const version = '1.2.0'
export const displayName = '模型服务'
export const description = '业务服务 · 模型抽象接口与调度，支持全局 / 角色级备用模型，具体由适配器插件实现。'
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
      // 角色级备用模型：
      //   'global'（默认）跟随全局失败转移设置；
      //   'off' 显式不启用备用模型；
      //   其它值 = 指定一个备用模型 key。
      // 角色编辑页的设置优先于全局设置。
      const backupSetting = String(options.backupModel || '').trim()
      const backupMode = !backupSetting || backupSetting === 'global' ? 'global' : backupSetting === 'off' ? 'off' : 'custom'
      const failoverEnabled =
        backupMode === 'custom' ? true : backupMode === 'global' ? config.get('model.failoverEnabled', false) === true : false
      const configuredKeys = (() => {
        if (backupMode === 'off') return []
        if (backupMode === 'custom') return [backupSetting]
        const raw = config.get('model.failoverKeys', [])
        const list = Array.isArray(raw) ? raw : []
        // 兼容旧版单值配置：迁移逻辑没跑到时也能工作。
        if (!list.length) {
          const legacy = String(config.get('model.failoverKey', '') || '').trim()
          if (legacy) list.push(legacy)
        }
        const out = []
        for (const item of list) {
          const key = String(item || '').trim()
          if (key && !out.includes(key)) out.push(key)
        }
        return out
      })()
      // failoverPasses = 备用列表循环几轮；旧版 failoverRetries 继续兼容读取。
      // 角色级指定备用模型时只尝试一轮，避免用户预期的“指定那个模型”变成反复重试。
      const passesRaw = config.get('model.failoverPasses', config.get('model.failoverRetries', 1))
      const passes = backupMode === 'custom' ? 1 : Math.max(1, Math.min(3, Math.floor(Number(passesRaw) || 1)))
      const fallbackQueue = []
      if (failoverEnabled) {
        for (let pass = 0; pass < passes; pass++) {
          for (const key of configuredKeys) {
            if (key !== requestedKey) fallbackQueue.push(key)
          }
        }
      }
      const attemptOrder = [requestedKey, ...fallbackQueue]
      const maxFallbacks = attemptOrder.length - 1

      let aborted = false
      let finished = false
      let emitted = false
      let attemptIndex = 0
      let currentKey = attemptOrder[0]
      let currentController = null
      let detachAbort = null
      const outerController = new AbortController()
      const signal = options.signal || outerController.signal

      const emitError = error => {
        if (aborted || finished) return
        // 只有“还没输出任何内容”时才适合自动切换，避免已经显示的半截回复被另一模型重写。
        if (!emitted && attemptIndex < maxFallbacks) {
          const failedKey = currentKey
          attemptIndex += 1
          const nextKey = attemptOrder[attemptIndex]
          events.emit('model:fallback', {
            from: failedKey,
            to: nextKey,
            error,
            attempt: attemptIndex,
            order: attemptIndex,
            total: maxFallbacks,
            keys: attemptOrder.slice(),
          })
          ctx.logger.warn(
            `模型 ${failedKey} 失败，自动切换备用模型 ${nextKey}（${attemptIndex}/${maxFallbacks}）：${error?.message || error}`,
          )
          startAttempt(nextKey)
          return
        }
        finished = true
        detachAbort?.()
        detachAbort = null
        ctx.logger.error(
          `模型 ${currentKey || '未选择'} 调用失败（${elapsed()}ms）：${error?.message || error}`,
        )
        callbacks.onError?.(error)
        events.emit('model:error', { key: currentKey, error, elapsedMs: elapsed() })
      }

      const startAttempt = key => {
        detachAbort?.()
        detachAbort = null
        currentKey = key
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
        else {
          signal.addEventListener('abort', abortCurrent, { once: true })
          detachAbort = () => signal.removeEventListener('abort', abortCurrent)
        }

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
                detachAbort?.()
                detachAbort = null
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

      startAttempt(attemptOrder[0])

      return {
        abort() {
          if (aborted || finished) return
          aborted = true
          detachAbort?.()
          detachAbort = null
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
