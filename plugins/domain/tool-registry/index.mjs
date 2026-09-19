/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * D? · tool-registry
 * 通用工具注册表（文档 §6）：
 *   - 任何插件都可以 register 一个 OpenAI function-calling 格式的工具
 *   - chat-flow 每轮把 registry.definitions() 交给模型，收到 tool_calls 后交给 execute()
 *   - 工具实现与聊天主链路完全解耦，新增工具只加一个插件
 */
import { sanitizeToolSchema } from '../../../src/util/tool-schema.mjs'

export const name = 'tool-registry'
export const version = '1.1.0'
export const displayName = '工具注册表'
export const description = '业务服务 · OpenAI function-calling 工具的注册、编目与执行调度。'
export const author = '念风内核'
export const icon = '🧰'
export const core = true
export const depends = {
  'event-bus': '^1.0.0',
}
export const optionalDepends = {}
export const inject = ['event-bus']
export const provides = [{ name: 'tool-registry', type: 'singleton' }]

export function apply(ctx) {
  const events = ctx.inject('event-bus')
  /** name -> { name, definition, handler } */
  const tools = new Map()

  /**
   * scope 判定统一收敛：没有声明 scope 的工具始终可用；声明了 scope 但判定
   * 抛错时按不可用处理，避免坏规则把“限制”悄悄失效。
   * 只有调用方显式传入 context 时才参与过滤，旧调用 definitions() 保持全量
   * 返回，兼容设置页 / 自检 / 测试等不关心渠道的读取场景。
   */
  const scopeAllows = (record, context) => {
    if (typeof record?.scope !== 'function') return true
    try {
      return record.scope(context) !== false
    } catch (err) {
      ctx.logger.warn(`工具 ${record.name} 的作用域判定失败，已按不可用处理：${err?.message || err}`)
      return false
    }
  }

  /** 中心化插件启用范围：owner 为注册该工具的插件 id，无服务时不限制。 */
  const pluginScopeAllows = (record, context) => {
    if (!record?.owner || context === undefined || context === null) return true
    try {
      const scope = ctx.registry.get('plugin-scope')
      if (typeof scope?.allows !== 'function') return true
      return scope.allows(record.owner, context) !== false
    } catch (err) {
      ctx.logger.warn(`工具 ${record.name} 的插件启用范围判定失败，暂按可用处理：${err?.message || err}`)
      return true
    }
  }

  const allows = (record, context) => scopeAllows(record, context) && pluginScopeAllows(record, context)

  const toDefinition = (name, definition = {}) => {
    // 允许传 { description, parameters }、function 本体，或完整 { type, function } 定义
    const raw = definition.function && typeof definition.function === 'object' ? definition.function : definition
    const fnName = raw.name || (definition.function ? definition.function.name : undefined) || name
    if (!fnName) throw new Error('工具必须声明名称')
    if (fnName !== name) throw new Error(`工具名不一致：register("${name}") / function.name="${fnName}"`)
    return {
      type: 'function',
      function: {
        name: fnName,
        description: raw.description || '',
        parameters: sanitizeToolSchema(raw.parameters || { type: 'object', properties: {} }, { root: true }),
      },
    }
  }

  const service = {
    name: 'tool-registry',

    /**
     * 注册工具。
     * @param {string} name
     * @param {{description?:string, parameters?:object, function?:object}} definition
     * @param {(args:object, context:object)=>any} handler
     * @param {{scope?:(context?:object)=>boolean, owner?:string}} [options] scope 用于按角色 / 渠道动态过滤工具
     * @returns {Function} dispose
     */
    register(name, definition, handler, options = {}) {
      if (tools.has(name)) throw new Error(`工具已注册：${name}`)
      if (typeof handler !== 'function') throw new Error(`工具「${name}」缺少执行函数`)
      const scope = typeof options?.scope === 'function' ? options.scope : null
      const owner = String(options?.owner || '').trim().replace(/^plugin:/, '')
      const record = { name, definition: toDefinition(name, definition), handler, scope, owner }
      tools.set(name, record)
      events.emit('tool:registered', { name, description: record.definition.function.description })
      ctx.logger.debug(`工具已注册：${name}`)
      return () => {
        if (tools.get(name) === record) tools.delete(name)
        events.emit('tool:unregistered', { name })
      }
    },

    unregister(name) {
      return tools.delete(name)
    },
    has: name => tools.has(name),
    get: name => tools.get(name) || null,
    names: () => [...tools.keys()],
    list: () =>
      [...tools.values()].map(record => ({
        name: record.name,
        description: record.definition.function.description,
        parameters: record.definition.function.parameters,
      })),

    /**
     * 交给模型的 tools 数组（OpenAI / Ollama 兼容格式）。
     * 传入 context（conversationId / roleId / channelId）时按注册 scope 与
     * 中心化「插件启用范围」过滤；不传 context 时保持旧行为，返回全部工具。
     */
    definitions: context =>
      [...tools.values()]
        .filter(record => context === undefined || allows(record, context))
        .map(record => structuredClone(record.definition)),

    /**
     * 执行工具。参数可以是模型给的 JSON 字符串或已解析对象。
     * handler 抛错会被收敛为 { ok:false, error }，让模型能看懂并改方案。
     */
    async execute(name, args, context = {}) {
      const record = tools.get(name)
      if (!record) return { ok: false, error: `未知工具：${name}` }
      let parsed = args
      if (typeof args === 'string') {
        try {
          parsed = args.trim() ? JSON.parse(args) : {}
        } catch (err) {
          return { ok: false, error: `工具参数不是合法 JSON：${err.message}` }
        }
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) parsed = {}
      if (!allows(record, context)) {
        return { ok: false, code: 'TOOL_SCOPE_DENIED', error: `工具「${name}」未在当前角色 / 渠道启用。` }
      }
      try {
        const result = await record.handler(parsed, context)
        return result === undefined ? { ok: true } : result
      } catch (err) {
        ctx.logger.warn(`工具 ${name} 执行失败：${err?.message || err}`)
        return { ok: false, error: String(err?.message || err) }
      }
    },
  }

  ctx.provide('tool-registry', service, { type: 'singleton' })
  ctx.logger.debug('工具注册表就绪')
}
