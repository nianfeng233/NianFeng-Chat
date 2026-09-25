/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * 后端 · models
 * 真实的模型接入层：OpenAI 兼容接口 / Ollama / Anthropic。
 * 所有请求都从服务端发出，API Key 只保存在本地 config，不会下发到浏览器。
 *
 * 能力：
 *   - listModels(providerId)  真实拉取可用模型列表
 *   - test(providerId)        真实连通性测试（延迟 / 错误信息）
 *   - stream(...)             真实流式补全（SSE / NDJSON 解析）
 *   - complete(...)           非流式聚合
 *   - translate(...)          通过已配置模型做真实翻译
 *   - 提供商 / 模型的增删改   （settings.providers，供设置页使用）
 */
import http from 'node:http'
import https from 'node:https'
import tls from 'node:tls'
import { Readable } from 'node:stream'
import { toGeminiSchema } from '../../src/util/tool-schema.mjs'

export const name = 'models'
export const inject = ['settings', 'hub']

/* ------------------------------------------------------------------ */
/* 适配器                                                              */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* 适配器                                                              */
/* ------------------------------------------------------------------ */

/** DeepSeek 官方建议目录（API /models 不可用时作为兜底提示） */
const DEEPSEEK_ADVISORY_MODELS = [
  { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
  { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
  { id: 'deepseek-v4-flash-vision-exp', name: 'DeepSeek V4 Flash Vision (exp)' },
]

function isDeepseekProvider(provider, model) {
  return provider?.type === 'deepseek' || /deepseek/i.test(provider?.baseURL || '') || /^deepseek/i.test(model || '')
}

const toFiniteNumber = value => {
  if (value === null || value === undefined || value === '') return null
  const num = Number(value)
  return Number.isFinite(num) ? num : null
}

/**
 * 把不同提供商返回的 usage 归一化为前端气泡可展示的字段。
 * 兼容 OpenAI / DeepSeek / Anthropic / Gemini / Ollama 的常见字段名。
 */
function normalizeUsage(raw) {
  if (!raw || typeof raw !== 'object') return null
  const promptDetails = raw.prompt_tokens_details || raw.input_tokens_details || {}
  const completionDetails = raw.completion_tokens_details || raw.output_tokens_details || {}
  const input =
    toFiniteNumber(raw.prompt_tokens) ??
    toFiniteNumber(raw.input_tokens) ??
    toFiniteNumber(raw.inputTokens) ??
    toFiniteNumber(raw.promptTokenCount) ??
    toFiniteNumber(raw.prompt_eval_count)
  const output =
    toFiniteNumber(raw.completion_tokens) ??
    toFiniteNumber(raw.output_tokens) ??
    toFiniteNumber(raw.outputTokens) ??
    toFiniteNumber(raw.candidatesTokenCount) ??
    toFiniteNumber(raw.eval_count)
  const cached =
    toFiniteNumber(raw.prompt_cache_hit_tokens) ??
    toFiniteNumber(promptDetails.cached_tokens) ??
    toFiniteNumber(raw.cache_read_input_tokens) ??
    toFiniteNumber(raw.cachedContentTokenCount) ??
    toFiniteNumber(raw.cached_tokens) ??
    toFiniteNumber(raw.cachedTokens)
  const reasoning =
    toFiniteNumber(completionDetails.reasoning_tokens) ??
    toFiniteNumber(raw.reasoning_tokens) ??
    toFiniteNumber(raw.reasoningTokens) ??
    toFiniteNumber(raw.thoughtsTokenCount) ??
    toFiniteNumber(completionDetails.thoughtsTokenCount)
  const total =
    toFiniteNumber(raw.total_tokens) ??
    toFiniteNumber(raw.totalTokenCount) ??
    toFiniteNumber(raw.totalTokens) ??
    toFiniteNumber(raw.total) ??
    (input !== null && output !== null ? input + output : null)
  const cost =
    toFiniteNumber(raw.cost) ??
    toFiniteNumber(raw.total_cost) ??
    toFiniteNumber(raw.totalCost) ??
    toFiniteNumber(raw.cost_cny) ??
    toFiniteNumber(raw.total_cost_cny)

  if (input === null && output === null && cached === null && total === null && cost === null) return null
  const usage = {
    inputTokens: input ?? 0,
    outputTokens: output ?? 0,
    cachedTokens: cached ?? 0,
    totalTokens: total ?? (input ?? 0) + (output ?? 0),
  }
  if (reasoning !== null) usage.reasoningTokens = reasoning
  if (cost !== null) usage.cost = cost
  return usage
}

/**
 * 可选费用估算：模型参数里配置 priceInput / priceOutput / priceCached
 * （元 / 百万 token）时，用本次 usage 算出本轮开销。提供商直接返回 cost 时优先使用。
 */
function applyUsagePricing(usage, params = {}) {
  if (!usage) return usage
  if (toFiniteNumber(usage.cost) !== null) return usage
  const priceInput = toFiniteNumber(params.priceInput)
  const priceOutput = toFiniteNumber(params.priceOutput)
  const priceCached = toFiniteNumber(params.priceCached)
  if (priceInput === null && priceOutput === null && priceCached === null) return usage
  const effectiveInput = priceInput ?? 0
  const effectiveOutput = priceOutput ?? effectiveInput
  const effectiveCached = priceCached ?? effectiveInput
  const input = Math.max(0, Number(usage.inputTokens) || 0)
  const cached = Math.min(input, Math.max(0, Number(usage.cachedTokens) || 0))
  const output = Math.max(0, Number(usage.outputTokens) || 0)
  const cost = (Math.max(0, input - cached) * effectiveInput + cached * effectiveCached + output * effectiveOutput) / 1_000_000
  return { ...usage, cost }
}

/**
 * OpenAI 兼容 chat/completions 适配器工厂。
 * DeepSeek 官方只是它的一个特化：thinking / reasoning_effort、reasoning_content
 * 回传、不发送 tool_choice（官方 harness 明确不映射该字段）。
 */
function createOpenAICompatibleAdapter({ label, defaultBaseURL, deepseek = false, advisoryModels = [] }) {
  const adapter = {
    label,
    defaultBaseURL,
    advisoryModels,

    async listModels(provider, ctx) {
      const base = trimSlash(provider.baseURL || defaultBaseURL)
      const res = await request(ctx, `${base}/models`, {
        headers: authHeaders(provider),
        timeoutMs: providerTimeout(provider),
        proxy: provider.proxy,
      })
      const json = await res.json()
      const list = (json.data || json.models || [])
        .map(item => ({ id: item.id || item.name, name: item.name || item.id, ownedBy: item.owned_by || item.ownedBy }))
        .filter(item => item.id)
      // DeepSeek 等端点如果暂时无法给出目录，回退到官方建议模型，避免设置页空状态
      return list.length ? list : advisoryModels.map(item => ({ ...item }))
    },

    async test(provider, ctx) {
      const models = await adapter.listModels(provider, ctx)
      return { detail: `${label} 可用模型 ${models.length} 个` }
    },

    /** OpenAI 兼容的 /embeddings 接口（DeepSeek 官方可能不支持，错误会原样上报）。 */
    async embed({ provider, model, input }, ctx) {
      const base = trimSlash(provider.baseURL || defaultBaseURL)
      const res = await request(ctx, `${base}/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(provider) },
        timeoutMs: providerTimeout(provider),
        proxy: provider.proxy,
        body: JSON.stringify({ model, input }),
      })
      const json = await res.json()
      const list = Array.isArray(json.data) ? json.data : Array.isArray(json.embeddings) ? json.embeddings : []
      const embeddings = list
        .map(item => (Array.isArray(item) ? item : item?.embedding))
        .filter(item => Array.isArray(item) && item.length)
      if (!embeddings.length) throw createError(502, `${label} 未返回 embedding 向量`)
      return embeddings
    },

    async stream({ provider, model, messages, options, signal, onChunk, onToolCall, onReasoning, onDone }, ctx) {
      const base = trimSlash(provider.baseURL || defaultBaseURL)
      const deepseekMode = deepseek || isDeepseekProvider(provider, model)
      const toolDefs = options?.toolChoice === 'none' ? [] : Array.isArray(options?.tools) ? options.tools.filter(Boolean) : []
      // DeepSeek 思考模式明确拒绝 tool_choice，但显式 thinking=disabled 时支持
      // tool_choice=required；关闭思考时强制工具能显著降低模型直出正文的概率。
      const deepseekThinkingDisabled = !deepseekMode || options?.reasoningEffort === 'off'
      const flags = {
        toolChoice: !!options?.toolChoice && deepseekThinkingDisabled,
        maxTokensField: 'max_tokens',
        temperature: options?.temperature !== undefined,
        streamOptions: true,
        thinking: deepseekMode,
        // 400 明确提到 reasoning_content 时，降级为关闭思考 + 移除历史推理字段再试一次。
        forceNoThinking: false,
        stripReasoning: false,
      }
      const buildBody = current => {
        const forceNoThinking = current.forceNoThinking === true
        // 官方 harness 的序列化不按 thinking 开关删除历史 reasoning：只要历史 assistant
        // 带有推理块就原样回传，缺少字段的 tool_calls 则补空字符串。DeepSeek 在
        // 思考模式下会校验这个字段，缺失会直接 400。
        const keepReasoning = deepseekMode && !forceNoThinking && current.stripReasoning !== true
        const reasoningOptions = forceNoThinking ? { ...options, reasoningEffort: 'off' } : options
        const body = {
          model,
          messages: toOpenAIMessages(messages, { keepReasoning, padReasoning: keepReasoning }),
          stream: true,
          ...(current.streamOptions ? { stream_options: { include_usage: true } } : {}),
          ...(current.temperature ? { temperature: options.temperature } : {}),
          ...(options?.maxTokens !== undefined && current.maxTokensField ? { [current.maxTokensField]: options.maxTokens } : {}),
          ...(toolDefs.length ? { tools: toolDefs } : {}),
          ...(toolDefs.length && current.toolChoice ? { tool_choice: options.toolChoice } : {}),
          ...(current.thinking ? deepseekThinkingBody(provider, model, reasoningOptions) : {}),
          ...extraBody(options),
        }
        return body
      }

      const res = await postChatWithParamFallbacks(ctx, `${base}/chat/completions`, provider, buildBody, flags, signal)
      const toolCalls = new Map()
      let finishReason = null
      let usage = null
      await readSSE(res, data => {
        if (data?.usage) usage = normalizeUsage(data.usage) || usage
        const choice = data?.choices?.[0]
        const delta = choice?.delta
        if (typeof delta?.reasoning_content === 'string' && delta.reasoning_content) onReasoning?.(delta.reasoning_content)
        if (typeof delta?.reasoning === 'string' && delta.reasoning) onReasoning?.(delta.reasoning)
        if (delta?.content) onChunk(delta.content)
        for (const call of delta?.tool_calls || []) {
          const index = Number.isFinite(call?.index) ? call.index : toolCalls.size
          const record = toolCalls.get(index) || { id: '', type: 'function', function: { name: '', arguments: '' } }
          if (call?.id) record.id = call.id
          if (call?.type) record.type = call.type
          if (call?.function?.name) record.function.name += call.function.name
          const argDelta = call?.function?.arguments
          if (typeof argDelta === 'string') record.function.arguments += argDelta
          else if (argDelta && typeof argDelta === 'object') record.function.arguments += JSON.stringify(argDelta)
          toolCalls.set(index, record)
          onToolCall?.({
            index,
            id: record.id || undefined,
            name: record.function.name || undefined,
            argumentsDelta: typeof argDelta === 'string' ? argDelta : argDelta ? JSON.stringify(argDelta) : '',
          })
        }
        if (choice?.finish_reason) finishReason = choice.finish_reason
      })
      onDone({ reason: finishReason, toolCalls: [...toolCalls.values()], usage })
    },
  }
  return adapter
}

/**
 * 参数兼容兜底：不同 OpenAI 兼容网关对 tool_choice / max_tokens /
 * max_completion_tokens / temperature / stream_options 的支持差异很大。
 * 遇到明确的 400/422 参数错误时，逐项降级重试，而不是直接宣告模型不可用。
 */
async function postChatWithParamFallbacks(ctx, url, provider, buildBody, flags, signal) {
  let current = { ...flags }
  let lastError = null
  const providerLabel = provider?.name || provider?.id || '提供商'
  const brief = value => String(value || '').replace(/\s+/g, ' ').slice(0, 140)
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await request(ctx, url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(provider) },
        timeoutMs: providerTimeout(provider),
        proxy: provider.proxy,
        body: JSON.stringify(buildBody(current)),
        signal,
        stream: true,
      })
    } catch (err) {
      lastError = err
      const status = Number(err?.status)
      const message = String(err?.message || err)
      if (status !== 400 && status !== 422) throw err
      // DeepSeek 思考模式的 reasoning_content 校验：缺字段 / 历史字段冲突时，
      // 不向用户抛 400，而是关闭思考并移除历史推理字段重试一次。
      if (/reasoning_content/i.test(message)) {
        if (!current.forceNoThinking) {
          current = { ...current, forceNoThinking: true, stripReasoning: true }
          ctx.logger?.warn?.(
            `[models] ${providerLabel} 拒绝了 reasoning_content，已关闭思考并清理历史推理字段后重试：${brief(message)}`,
          )
          continue
        }
        throw err
      }
      if (current.toolChoice && /tool_choice/i.test(message)) {
        current = { ...current, toolChoice: false }
        ctx.logger?.warn?.(`[models] ${providerLabel} 不支持当前 tool_choice，已移除该参数后重试：${brief(message)}`)
        continue
      }
      if (current.maxTokensField === 'max_tokens' && /max_completion_tokens/i.test(message)) {
        current = { ...current, maxTokensField: 'max_completion_tokens' }
        ctx.logger?.warn?.(`[models] ${providerLabel} 要求 max_completion_tokens，已自动换用该字段重试：${brief(message)}`)
        continue
      }
      if (current.maxTokensField && /max_tokens/i.test(message)) {
        current = { ...current, maxTokensField: null }
        ctx.logger?.warn?.(`[models] ${providerLabel} 不接受 max_tokens，已移除输出上限参数后重试：${brief(message)}`)
        continue
      }
      if (current.temperature && /temperature/i.test(message)) {
        current = { ...current, temperature: false }
        ctx.logger?.warn?.(`[models] ${providerLabel} 不接受 temperature，已移除该参数后重试：${brief(message)}`)
        continue
      }
      // 部分 OpenAI 兼容网关不接受 stream_options；usage 是可选增强，去掉后重试一次。
      if (current.streamOptions) {
        current = { ...current, streamOptions: false }
        ctx.logger?.warn?.(`[models] ${providerLabel} 不接受 stream_options，已移除 usage 统计参数后重试：${brief(message)}`)
        continue
      }
      throw err
    }
  }
  throw lastError || new Error('模型请求失败')
}

/* ------------------------------------------------------------------ */
/* Anthropic / Claude                                                  */
/* ------------------------------------------------------------------ */

function toAnthropicToolChoice(choice) {
  if (choice === 'required') return { type: 'any' }
  if (choice === 'none') return { type: 'none' }
  return { type: 'auto' }
}

function anthropicThinkingBody(options) {
  const level = options?.reasoningEffort
  if (level !== 'low' && level !== 'high' && level !== 'max') return {}
  const budget = level === 'low' ? 2048 : level === 'high' ? 8192 : 16384
  const maxTokens = Number(options?.maxTokens) > 0 ? Number(options.maxTokens) : 8192
  return { thinking: { type: 'enabled', budget_tokens: Math.min(budget, Math.max(1024, maxTokens - 1)) } }
}

function parseObject(value) {
  if (value && typeof value === 'object') return value
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      return parsed && typeof parsed === 'object' ? parsed : {}
    } catch (_) {
      return {}
    }
  }
  return {}
}

function toAnthropicMessages(messages = []) {
  const out = []
  const push = (role, blocks) => {
    const normalized = Array.isArray(blocks) ? blocks : [{ type: 'text', text: stringifyContent(blocks) }]
    const last = out[out.length - 1]
    // Anthropic 的 tool_result 必须包在 user 消息里，且两条连续 user 消息需要合并
    if (last && last.role === role && role === 'user') last.content.push(...normalized)
    else out.push({ role, content: normalized })
  }
  for (const message of messages || []) {
    if (!message || message.role === 'system') continue
    if (message.role === 'tool') {
      push('user', [
        {
          type: 'tool_result',
          tool_use_id: message.tool_call_id || message.toolCallId || '',
          content: stringifyContent(message.content) || '(no output)',
        },
      ])
      continue
    }
    if (message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length) {
      const blocks = []
      const text = stringifyContent(message.content)
      if (text) blocks.push({ type: 'text', text })
      for (const call of message.tool_calls) {
        blocks.push({
          type: 'tool_use',
          id: call.id || `call_${Math.random().toString(36).slice(2, 10)}`,
          name: call.function?.name || call.name || '',
          input: parseObject(call.function?.arguments ?? call.arguments),
        })
      }
      push('assistant', blocks)
      continue
    }
    const role = message.role === 'assistant' ? 'assistant' : 'user'
    if (role === 'user' && Array.isArray(message.content)) {
      push(role, toAnthropicBlocks(message.content))
      continue
    }
    const text = stringifyContent(message.content)
    if (text || role === 'assistant') push(role, [{ type: 'text', text }])
  }
  return out.filter(item => item.content.length > 0)
}

/* ------------------------------------------------------------------ */
/* Google Gemini                                                       */
/* ------------------------------------------------------------------ */

function geminiApiBase(provider) {
  const base = trimSlash(provider?.baseURL || 'https://generativelanguage.googleapis.com')
  return /\/(?:v\d+(?:beta)?)$/i.test(base) ? base : `${base}/v1beta`
}

function toGeminiToolMode(choice) {
  if (choice === 'required') return 'ANY'
  if (choice === 'none') return 'NONE'
  return 'AUTO'
}

function toGeminiFunctionResponse(message) {
  const name = message.name || message.tool_name || ''
  const parsed = parseObject(message.content)
  return {
    functionResponse: {
      name,
      response: Object.keys(parsed).length ? parsed : { result: stringifyContent(message.content) },
    },
  }
}

function toGeminiContents(messages = []) {
  const contents = []
  let systemText = ''
  const push = (role, parts) => {
    const valid = parts.filter(Boolean)
    if (!valid.length) return
    const last = contents[contents.length - 1]
    if (last && last.role === role) last.parts.push(...valid)
    else contents.push({ role, parts: valid })
  }

  for (const message of messages || []) {
    if (!message) continue
    if (message.role === 'system') {
      systemText += (systemText ? '\n\n' : '') + stringifyContent(message.content)
      continue
    }
    if (message.role === 'tool') {
      push('user', [toGeminiFunctionResponse(message)])
      continue
    }
    if (message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length) {
      const parts = []
      const text = stringifyContent(message.content)
      if (text) parts.push({ text })
      if (message.thoughtSignature) parts.push({ thought: true, thoughtSignature: message.thoughtSignature })
      for (const call of message.tool_calls) {
        const part = { functionCall: { name: call.function?.name || call.name || '', args: parseObject(call.function?.arguments ?? call.arguments) } }
        if (call.thoughtSignature) part.thoughtSignature = call.thoughtSignature
        parts.push(part)
      }
      push('model', parts)
      continue
    }
    if (message.role !== 'assistant' && Array.isArray(message.content)) {
      push('user', toGeminiParts(message.content))
    } else {
      push(message.role === 'assistant' ? 'model' : 'user', [{ text: stringifyContent(message.content) }])
    }
  }

  return { contents, systemInstruction: systemText ? { parts: [{ text: systemText }] } : undefined }
}

function geminiHeaders(provider) {
  return {
    ...(provider?.apiKey ? { 'x-goog-api-key': provider.apiKey } : {}),
    ...customHeaders(provider),
  }
}

/* ------------------------------------------------------------------ */
/* 适配器实例                                                          */
/* ------------------------------------------------------------------ */

const adapters = {
  openai: createOpenAICompatibleAdapter({
    label: 'OpenAI 兼容接口',
    defaultBaseURL: 'https://api.openai.com/v1',
  }),

  deepseek: createOpenAICompatibleAdapter({
    label: 'DeepSeek 官方',
    defaultBaseURL: 'https://api.deepseek.com',
    deepseek: true,
    advisoryModels: DEEPSEEK_ADVISORY_MODELS,
  }),

  ollama: {
    label: 'Ollama（本地）',
    async listModels(provider, ctx) {
      const base = trimSlash(provider.baseURL || 'http://localhost:11434')
      const res = await request(ctx, `${base}/api/tags`, {
        headers: authHeaders(provider),
        timeoutMs: providerTimeout(provider),
        proxy: provider.proxy,
      })
      const json = await res.json()
      return (json.models || []).map(m => ({ id: m.name, name: m.name, size: m.size }))
    },
    async test(provider, ctx) {
      const models = await adapters.ollama.listModels(provider, ctx)
      return { detail: `本地模型 ${models.length} 个` }
    },
    /** 优先新版 /api/embed；旧版 Ollama 回退到 /api/embeddings。 */
    async embed({ provider, model, input }, ctx) {
      const base = trimSlash(provider.baseURL || 'http://localhost:11434')
      const texts = input.map(text => String(text ?? ''))
      try {
        const res = await request(ctx, `${base}/api/embed`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders(provider) },
          timeoutMs: providerTimeout(provider),
          proxy: provider.proxy,
          body: JSON.stringify({ model, input: texts }),
        })
        const json = await res.json()
        const embeddings = Array.isArray(json.embeddings) ? json.embeddings : []
        if (embeddings.length) return embeddings
      } catch (err) {
        if (!String(err?.message || err).includes('404')) throw err
      }
      const out = []
      for (const text of texts) {
        const res = await request(ctx, `${base}/api/embeddings`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders(provider) },
          timeoutMs: providerTimeout(provider),
          proxy: provider.proxy,
          body: JSON.stringify({ model, prompt: text }),
        })
        const json = await res.json()
        if (Array.isArray(json.embedding) && json.embedding.length) out.push(json.embedding)
      }
      if (!out.length) throw createError(502, 'Ollama 未返回 embedding 向量')
      return out
    },
    async stream({ provider, model, messages, options, signal, onChunk, onToolCall, onReasoning, onDone }, ctx) {
      const base = trimSlash(provider.baseURL || 'http://localhost:11434')
      const toolDefs = options?.toolChoice === 'none' ? [] : Array.isArray(options?.tools) ? options.tools.filter(Boolean) : []
      const res = await request(ctx, `${base}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(provider) },
        timeoutMs: providerTimeout(provider),
        proxy: provider.proxy,
        body: JSON.stringify({
          model,
          messages: toOllamaMessages(messages),
          stream: true,
          ...(toolDefs.length ? { tools: toolDefs.map(tool => ({ type: 'function', function: tool.function })) } : {}),
          options: {
            ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
            ...(options?.maxTokens ? { num_predict: options.maxTokens } : {}),
            ...extraBody(options),
          },
        }),
        signal,
        stream: true,
      })
      const toolCalls = []
      let finishReason = null
      let usage = null
      await readNDJSON(res, data => {
        if (typeof data?.message?.thinking === 'string' && data.message.thinking) onReasoning?.(data.message.thinking)
        if (data?.message?.content) onChunk(data.message.content)
        for (const call of data?.message?.tool_calls || []) {
          const record = normalizeToolCallRecord(call, toolCalls.length)
          toolCalls.push(record)
          onToolCall?.({
            index: record.index,
            id: record.id || undefined,
            name: record.function.name || undefined,
            argumentsDelta: record.function.arguments || '',
          })
        }
        if (data?.done) {
          finishReason = data.done_reason || finishReason
          usage =
            normalizeUsage({
              prompt_tokens: data.prompt_eval_count,
              completion_tokens: data.eval_count,
            }) || usage
        }
      })
      onDone({ reason: finishReason, toolCalls, usage })
    },
  },

  anthropic: {
    label: 'Anthropic Claude',
    async listModels(provider, ctx) {
      const base = trimSlash(provider.baseURL || 'https://api.anthropic.com')
      const res = await request(ctx, `${base}/v1/models`, {
        headers: anthropicHeaders(provider),
        timeoutMs: providerTimeout(provider),
        proxy: provider.proxy,
      })
      const json = await res.json()
      return (json.data || []).map(m => ({ id: m.id, name: m.display_name || m.id }))
    },
    async test(provider, ctx) {
      const models = await adapters.anthropic.listModels(provider, ctx)
      return { detail: `可用模型 ${models.length} 个` }
    },
    async stream({ provider, model, messages, options, signal, onChunk, onToolCall, onReasoning, onDone }, ctx) {
      const base = trimSlash(provider.baseURL || 'https://api.anthropic.com')
      const system = (messages || [])
        .filter(message => message?.role === 'system')
        .map(message => stringifyContent(message.content))
        .filter(Boolean)
        .join('\n\n')
      const toolDefs = Array.isArray(options?.tools) ? options.tools.filter(Boolean) : []
      const disableTools = options?.toolChoice === 'none'
      const thinking = anthropicThinkingBody(options)
      const body = {
        model,
        max_tokens: Number(options?.maxTokens) > 0 ? Number(options.maxTokens) : 4096,
        ...(system ? { system } : {}),
        messages: toAnthropicMessages(messages),
        stream: true,
        // Claude 扩展思考开启时必须使用 temperature=1，直接省略让官方默认值生效
        ...(options?.temperature !== undefined && !thinking.thinking ? { temperature: options.temperature } : {}),
        ...(!disableTools && toolDefs.length
          ? {
              tools: toolDefs.map(tool => ({
                name: tool.function?.name || tool.name,
                description: tool.function?.description || '',
                input_schema: tool.function?.parameters || { type: 'object', properties: {} },
              })),
              ...(options?.toolChoice && options.toolChoice !== 'auto' ? { tool_choice: toAnthropicToolChoice(options.toolChoice) } : {}),
            }
          : {}),
        ...thinking,
        ...extraBody(options),
      }
      const res = await request(ctx, `${base}/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...anthropicHeaders(provider) },
        timeoutMs: providerTimeout(provider),
        proxy: provider.proxy,
        body: JSON.stringify(body),
        signal,
        stream: true,
      })
      const toolCalls = new Map()
      let finishReason = null
      let streamError = null
      const anthropicUsage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 }
      await readSSE(res, data => {
        if (!data || typeof data !== 'object') return
        if (data.type === 'error') {
          streamError = new Error(data.error?.message || 'Anthropic 返回错误')
          return
        }
        if (data.type === 'message_start') {
          const raw = data.message?.usage || data.usage
          if (raw) {
            const cacheRead = toFiniteNumber(raw.cache_read_input_tokens) || 0
            const cacheCreate = toFiniteNumber(raw.cache_creation_input_tokens) || 0
            const baseInput = toFiniteNumber(raw.input_tokens) || 0
            anthropicUsage.inputTokens = baseInput + cacheRead + cacheCreate
            anthropicUsage.cachedTokens = cacheRead
            const cost = toFiniteNumber(raw.cost) ?? toFiniteNumber(data.message?.cost)
            if (cost !== null) anthropicUsage.cost = cost
          }
          return
        }
        if (data.type === 'content_block_start') {
          const block = data.content_block
          if (block?.type === 'tool_use') {
            toolCalls.set(data.index, {
              index: data.index,
              id: block.id || `call_claude_${data.index}`,
              type: 'function',
              function: { name: block.name || '', arguments: '' },
            })
          }
          return
        }
        if (data.type === 'content_block_delta') {
          const delta = data.delta || {}
          if (delta.type === 'text_delta' && delta.text) onChunk(delta.text)
          else if (delta.type === 'thinking_delta' && delta.thinking) onReasoning?.(delta.thinking)
          else if (delta.type === 'input_json_delta') {
            const record = toolCalls.get(data.index)
            if (record) {
              const fragment = delta.partial_json || ''
              record.function.arguments += fragment
              onToolCall?.({ index: data.index, id: record.id, name: record.function.name, argumentsDelta: fragment })
            }
          }
          return
        }
        if (data.type === 'message_delta') {
          if (data.delta?.stop_reason) finishReason = data.delta.stop_reason
          const raw = data.usage
          if (raw) {
            const output = toFiniteNumber(raw.output_tokens)
            if (output !== null) anthropicUsage.outputTokens = output
            const cost = toFiniteNumber(raw.cost)
            if (cost !== null) anthropicUsage.cost = cost
          }
        }
      })
      if (streamError) throw streamError
      onDone({
        reason: finishReason,
        toolCalls: [...toolCalls.values()],
        usage: normalizeUsage({
          prompt_tokens: anthropicUsage.inputTokens,
          completion_tokens: anthropicUsage.outputTokens,
          prompt_tokens_details: { cached_tokens: anthropicUsage.cachedTokens },
          ...(anthropicUsage.cost !== undefined ? { cost: anthropicUsage.cost } : {}),
        }),
      })
    },
  },

  gemini: {
    label: 'Google Gemini',
    async listModels(provider, ctx) {
      const apiBase = geminiApiBase(provider)
      const models = []
      const seenIds = new Set()
      let pageToken = ''
      let page = 0
      do {
        const params = new URLSearchParams({ pageSize: '100' })
        if (pageToken) params.set('pageToken', pageToken)
        const url = `${apiBase}/models?${params.toString()}`
        ctx.logger.info(`[models] Gemini 获取模型列表：GET ${url}`)
        const res = await request(ctx, url, {
          headers: { Accept: 'application/json', ...geminiHeaders(provider) },
          timeoutMs: providerTimeout(provider),
          proxy: provider.proxy,
          debug: true,
        })
        let json
        try {
          json = await res.json()
        } catch (err) {
          throw createError(502, `解析 ${url} 响应失败：${err.message}`)
        }
        const list = Array.isArray(json?.models) ? json.models : Array.isArray(json?.data) ? json.data : null
        if (!list) {
          throw createError(502, `${url} 未返回模型数组：${JSON.stringify(json).slice(0, 300)}`)
        }
        for (const item of list) {
          const methods = Array.isArray(item.supportedGenerationMethods) ? item.supportedGenerationMethods : null
          // 新模型可能只声明 streamGenerateContent；两种都算可聊模型，缺字段时按兼容处理。
          if (methods && !methods.includes('generateContent') && !methods.includes('streamGenerateContent')) continue
          const id = String(item.name || item.id || '').replace(/^models\//, '').trim()
          if (!id || seenIds.has(id)) continue
          seenIds.add(id)
          models.push({ id, name: item.displayName || item.name || id })
        }
        pageToken = String(json.nextPageToken || '')
        page += 1
      } while (pageToken && page < 10)
      ctx.logger.info(`[models] Gemini 模型列表响应：共 ${models.length} 个（${apiBase}/models）`)
      return models
    },
    async test(provider, ctx) {
      const models = await adapters.gemini.listModels(provider, ctx)
      return { detail: `可用模型 ${models.length} 个` }
    },
    /** Gemini embedContent：逐个文本请求，兼容纯文本 embedding 模型。 */
    async embed({ provider, model, input }, ctx) {
      const apiBase = geminiApiBase(provider)
      const out = []
      for (const text of input) {
        const res = await request(ctx, `${apiBase}/models/${encodeURIComponent(model)}:embedContent`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...geminiHeaders(provider) },
          timeoutMs: providerTimeout(provider),
          proxy: provider.proxy,
          body: JSON.stringify({ content: { parts: [{ text: String(text ?? '') }] } }),
        })
        const json = await res.json()
        const values = json?.embedding?.values
        if (Array.isArray(values) && values.length) out.push(values)
      }
      if (!out.length) throw createError(502, 'Gemini 未返回 embedding 向量')
      return out
    },
    async stream({ provider, model, messages, options, signal, onChunk, onToolCall, onReasoning, onDone }, ctx) {
      const apiBase = geminiApiBase(provider)
      const toolDefs = Array.isArray(options?.tools) ? options.tools.filter(Boolean) : []
      const disableTools = options?.toolChoice === 'none'
      const { contents, systemInstruction } = toGeminiContents(messages)
      const body = {
        contents,
        ...(systemInstruction ? { systemInstruction } : {}),
        generationConfig: {
          ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
          ...(options?.maxTokens ? { maxOutputTokens: options.maxTokens } : {}),
        },
        ...(!disableTools && toolDefs.length
          ? {
              tools: [
                {
                  functionDeclarations: toolDefs.map(tool => ({
                    name: tool.function?.name || tool.name,
                    description: tool.function?.description || '',
                    // Gemini 对 JSON Schema 的支持是子集：统一去掉联合类型、
                    // additionalProperties 等字段，并保证顶层/数组结构合法。
                    parameters: toGeminiSchema(tool.function?.parameters || { type: 'object', properties: {} }),
                  })),
                },
              ],
              ...(options?.toolChoice ? { toolConfig: { functionCallingConfig: { mode: toGeminiToolMode(options.toolChoice) } } } : {}),
            }
          : {}),
        ...extraBody(options),
      }
      const res = await request(ctx, `${apiBase}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...geminiHeaders(provider) },
        timeoutMs: providerTimeout(provider),
        proxy: provider.proxy,
        body: JSON.stringify(body),
        signal,
        stream: true,
      })
      const toolCalls = new Map()
      let finishReason = null
      let streamError = null
      let usage = null
      await readSSE(res, data => {
        if (data?.error) {
          streamError = new Error(data.error.message || 'Gemini 返回错误')
          return
        }
        if (data?.usageMetadata) {
          usage =
            normalizeUsage({
              prompt_tokens: data.usageMetadata.promptTokenCount,
              completion_tokens: data.usageMetadata.candidatesTokenCount,
              total_tokens: data.usageMetadata.totalTokenCount,
              cached_tokens: data.usageMetadata.cachedContentTokenCount,
              reasoning_tokens: data.usageMetadata.thoughtsTokenCount,
            }) || usage
        }
        const candidate = data?.candidates?.[0]
        for (const part of candidate?.content?.parts || []) {
          if (typeof part?.text === 'string' && part.text) {
            if (part.thought === true) onReasoning?.(part.text)
            else onChunk(part.text)
          }
          if (part?.functionCall) {
            const call = part.functionCall
            const index = toolCalls.size
            const record = {
              index,
              id: call.id || `call_gemini_${index}`,
              type: 'function',
              function: { name: call.name || '', arguments: JSON.stringify(call.args || {}) },
              ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
            }
            toolCalls.set(index, record)
            onToolCall?.({ index, id: record.id, name: record.function.name, argumentsDelta: record.function.arguments })
          }
        }
        if (candidate?.finishReason) finishReason = candidate.finishReason
      })
      if (streamError) throw streamError
      onDone({ reason: finishReason, toolCalls: [...toolCalls.values()], usage })
    },
  },
}

/* ------------------------------------------------------------------ */
/* 插件主体                                                            */
/* ------------------------------------------------------------------ */

export function apply(ctx) {
  const settings = ctx.settings
  const hub = ctx.hub
  const statusCache = new Map() // providerId -> { ok, at, latency, detail, error }
  const runtimeProviders = new Map() // 运行时提供商：预留给未来的托管服务（官方服务端是独立项目）

  /** 提供商没单独填代理 / 超时时，回落到 设置 → 网络 里的全局值 */
  const withNetworkDefaults = provider => {
    const network = settings.get().network || {}
    const providerTimeout = Number(provider.timeoutMs)
    const networkTimeout = Number(network.timeoutMs)
    return {
      ...provider,
      proxy: provider.proxy || network.proxy || '',
      timeoutMs: Number.isFinite(providerTimeout) && providerTimeout > 0 ? providerTimeout : Number.isFinite(networkTimeout) && networkTimeout > 0 ? networkTimeout : 60000,
    }
  }

  const getProvider = id => {
    if (runtimeProviders.has(id)) return runtimeProviders.get(id)
    const provider = settings.get().providers[id]
    if (!provider || provider.deleted) throw createError(404, `提供商不存在：${id}`)
    return withNetworkDefaults(provider)
  }

  /** 只允许编辑本地配置里的提供商（托管运行时提供商走另一条路） */
  const requireLocalProvider = id => {
    if (runtimeProviders.has(id)) throw createError(400, `「${id}」是托管提供商（由登录的官方服务提供），不能直接编辑`)
    const provider = settings.get().providers[id]
    if (!provider || provider.deleted) throw createError(404, `提供商不存在：${id}`)
    return provider
  }

  const needsKey = type => type === 'openai' || type === 'anthropic' || type === 'deepseek' || type === 'gemini'

  const summarizeProvider = (id, p, managed) => ({
    id,
    type: p.type,
    name: p.name || adapters[p.type]?.label || id,
    baseURL: p.baseURL,
    enabled: p.enabled !== false,
    configured: managed ? p.configured !== false : !needsKey(p.type) || !!p.apiKey,
    hasKey: managed ? false : !!p.apiKey,
    maskedKey: managed ? '' : maskKey(p.apiKey),
    managed,
    editable: !managed,
    description: p.description || '',
    models: (p.models || []).map(m => ({ enabled: m.enabled !== false, custom: m.custom === true, ...m })),
    defaultModel: p.defaultModel || '',
    timeoutMs: Number(p.timeoutMs) > 0 ? Number(p.timeoutMs) : 0,
    proxy: p.proxy || '',
    headers: sanitizeHeaders(p.headers),
    status: statusCache.get(id) || { ok: null, detail: '尚未测试' },
  })

  const service = {
    /** 提供商概览（含配置状态与最近一次测试结果） */
    list() {
      const data = settings.get()
      const local = Object.entries(data.providers)
        .filter(([, p]) => !p.deleted)
        .map(([id, p]) => summarizeProvider(id, p, false))
      const runtime = [...runtimeProviders.entries()].map(([id, p]) => summarizeProvider(id, p, true))
      return [...runtime, ...local]
    },

    /**
     * 真实拉取模型列表并写入配置。
     * 与已有模型按 id 合并：用户配置过的显示名 / 参数 / 启停状态不会被覆盖，
     * 远端新增的模型自动追加，远端删除的模型保留（避免误删用户的配置）。
     */
    async refresh(id) {
      const provider = getProvider(id)
      const adapter = requireAdapter(provider.type)
      try {
        const fetched = await adapter.listModels(provider, ctx)
        const existing = provider.models || []
        const seen = new Set(existing.map(m => m.id))
        const merged = existing.map(m => ({ ...m }))
        let added = 0
        for (const remote of fetched) {
          if (!remote?.id || seen.has(remote.id)) continue
          seen.add(remote.id)
          merged.push({
            id: remote.id,
            name: remote.name || remote.id,
            enabled: true,
            custom: false,
            ...(remote.ownedBy ? { ownedBy: remote.ownedBy } : {}),
            ...(remote.size ? { size: remote.size } : {}),
          })
          added++
        }
        if (runtimeProviders.has(id)) service.updateRuntimeProvider(id, { models: merged })
        else await settings.update({ providers: { [id]: { models: merged } } })
        const status = {
          ok: true,
          at: Date.now(),
          detail: added ? `新增 ${added} 个模型，共 ${merged.length} 个` : `没有新模型，共 ${merged.length} 个`,
        }
        statusCache.set(id, status)
        hub.broadcast('provider/status', { id, status, models: merged })
        return { ok: true, models: merged, added, detail: status.detail }
      } catch (err) {
        const detail = normalizeError(err)
        const status = { ok: false, at: Date.now(), detail }
        statusCache.set(id, status)
        hub.broadcast('provider/status', { id, status })
        ctx.logger.warn(`[${id}] 拉取模型失败：${detail}`)
        return { ok: false, detail, models: [] }
      }
    },
    /**
     * 只拉取远端模型候选，不写入配置。
     * 设置页「获取模型列表」使用它展示临时候选；用户点击某个候选后才调用
     * addModel 入库。这样不会像旧 refresh 那样把所有远端模型一次性变成启用状态。
     */
    async discover(id) {
      const provider = getProvider(id)
      const adapter = requireAdapter(provider.type)
      try {
        const fetched = await adapter.listModels(provider, ctx)
        const installedIds = new Set((provider.models || []).map(model => String(model.id)))
        const seen = new Set()
        const models = []
        for (const remote of fetched || []) {
          const modelId = String(remote?.id || '').trim()
          if (!modelId || seen.has(modelId)) continue
          seen.add(modelId)
          models.push({
            id: modelId,
            name: String(remote.name || modelId),
            installed: installedIds.has(modelId),
            ...(remote.ownedBy ? { ownedBy: String(remote.ownedBy) } : {}),
            ...(remote.size ? { size: Number(remote.size) || 0 } : {}),
          })
        }
        const status = {
          ok: true,
          at: Date.now(),
          detail: models.length ? `发现 ${models.length} 个模型（尚未添加）` : '远端没有返回可用模型',
        }
        statusCache.set(id, status)
        hub.broadcast('provider/status', { id, status })
        return { ok: true, models, count: models.length, detail: status.detail }
      } catch (err) {
        const detail = normalizeError(err)
        const status = { ok: false, at: Date.now(), detail }
        statusCache.set(id, status)
        hub.broadcast('provider/status', { id, status })
        ctx.logger.warn(`[${id}] 获取临时模型列表失败：${detail}`)
        return { ok: false, detail, models: [] }
      }
    },

    /** 真实连通性测试 */
    async test(id) {
      const provider = getProvider(id)
      const adapter = requireAdapter(provider.type)
      if (needsKey(provider.type) && !provider.apiKey) {
        const status = { ok: false, at: Date.now(), detail: '尚未配置 API Key' }
        statusCache.set(id, status)
        return status
      }
      const started = Date.now()
      try {
        const result = await adapter.test(provider, ctx)
        const status = { ok: true, at: Date.now(), latency: Date.now() - started, detail: result?.detail || '连接正常' }
        statusCache.set(id, status)
        hub.broadcast('provider/status', { id, status })
        return status
      } catch (err) {
        const detail = normalizeError(err)
        const status = { ok: false, at: Date.now(), latency: Date.now() - started, detail }
        statusCache.set(id, status)
        hub.broadcast('provider/status', { id, status })
        return status
      }
    },

    /* ---------------- 提供商 / 模型的增删改 ---------------- */

    /** 新增提供商（写 user_data/config.json） */
    async addProvider(descriptor = {}) {
      const entry = normalizeProviderDescriptor(descriptor)
      requireAdapter(entry.provider.type)
      const data = settings.get()
      const existing = data.providers[entry.id]
      if (existing && !existing.deleted) throw createError(409, `提供商 ID 已存在：${entry.id}`)
      if (runtimeProviders.has(entry.id)) throw createError(409, `提供商 ID 与托管提供商冲突：${entry.id}`)
      await settings.update({ providers: { [entry.id]: { ...entry.provider, deleted: false } } })
      statusCache.set(entry.id, { ok: null, detail: '尚未测试' })
      hub.broadcast('provider/status', { id: entry.id, status: { ok: null, detail: '已新增' } })
      ctx.logger.info(`已新增模型提供商：${entry.id}（${entry.provider.type}）`)
      return summarizeProvider(entry.id, settings.get().providers[entry.id], false)
    },

    /** 修改提供商（名称 / 类型 / 地址 / Key / 启停 / 默认模型 / 高级配置） */
    async updateProvider(id, patch = {}) {
      const provider = requireLocalProvider(id)
      const next = {}
      if (patch.name !== undefined) next.name = String(patch.name || '').trim() || provider.name || id
      if (patch.type !== undefined) {
        requireAdapter(String(patch.type))
        next.type = String(patch.type)
      }
      if (patch.baseURL !== undefined) next.baseURL = String(patch.baseURL || '').trim()
      if (patch.apiKey !== undefined && String(patch.apiKey) !== '') next.apiKey = String(patch.apiKey)
      if (patch.enabled !== undefined) next.enabled = patch.enabled !== false
      if (patch.timeoutMs !== undefined) next.timeoutMs = normalizeTimeout(patch.timeoutMs)
      if (patch.proxy !== undefined) next.proxy = String(patch.proxy || '').trim()
      if (patch.headers !== undefined) {
        const incoming = normalizeHeaders(patch.headers)
        const current = provider.headers || {}
        // 敏感请求头在接口里是打码值；原样提交表示"保持不变"
        for (const key of Object.keys(incoming)) {
          const oldKey = Object.keys(current).find(name => name.toLowerCase() === key.toLowerCase())
          if (oldKey && isSensitiveHeader(oldKey) && incoming[key] === maskKey(String(current[oldKey]))) {
            incoming[key] = current[oldKey]
          }
        }
        next.headers = incoming
      }

      const globalPatch = {}
      if (patch.defaultModel !== undefined) {
        next.defaultModel = String(patch.defaultModel || '')
        if (next.defaultModel) {
          const known = (provider.models || []).some(m => m.id === next.defaultModel)
          if (!known) throw createError(400, `模型不存在：${next.defaultModel}`)
          globalPatch.defaultProvider = id
          globalPatch.defaultModel = next.defaultModel
        }
      }
      await settings.replaceProvider(id, next)
      if (Object.keys(globalPatch).length) await settings.update(globalPatch)
      if (patch.apiKey !== undefined && String(patch.apiKey) !== '') {
        statusCache.set(id, { ok: null, detail: '凭据已更新，尚未测试' })
      }
      hub.broadcast('provider/status', { id, status: statusCache.get(id) || { ok: null, detail: '已更新' } })
      return summarizeProvider(id, settings.get().providers[id], false)
    },

    /** 删除提供商（打 deleted 标记，重启后不会复活） */
    async removeProvider(id) {
      requireLocalProvider(id)
      await settings.removeProvider(id)
      statusCache.delete(id)
      hub.broadcast('provider/status', { id, status: { ok: false, detail: '已删除' } })
      ctx.logger.info(`已删除模型提供商：${id}`)
      return true
    },

    /** 新增自定义模型 */
    async addModel(id, model = {}) {
      const provider = requireLocalProvider(id)
      const entry = normalizeModelEntry({ ...model, custom: model.custom !== false })
      const models = [...(provider.models || [])]
      if (models.some(m => m.id === entry.id)) throw createError(409, `模型已存在：${entry.id}`)
      models.push(entry)
      await settings.update({ providers: { [id]: { models } } })
      hub.broadcast('provider/status', { id, status: statusCache.get(id) || { ok: null, detail: '模型已新增' } })
      return entry
    },

    /** 修改模型（显示名 / 启停 / 参数） */
    async updateModel(id, modelId, patch = {}) {
      const provider = requireLocalProvider(id)
      const models = [...(provider.models || [])]
      const index = models.findIndex(m => m.id === modelId)
      if (index < 0) throw createError(404, `模型不存在：${modelId}`)
      const next = { ...models[index] }
      if (patch.name !== undefined) next.name = String(patch.name || '').trim() || next.id
      if (patch.enabled !== undefined) next.enabled = patch.enabled !== false
      if (patch.params !== undefined) next.params = mergeModelParams(next.params, patch.params)
      models[index] = next
      await settings.update({ providers: { [id]: { models } } })
      hub.broadcast('provider/status', { id, status: statusCache.get(id) || { ok: null, detail: '模型已更新' } })
      return next
    },

    /** 删除模型 */
    async removeModel(id, modelId) {
      const provider = requireLocalProvider(id)
      const list = provider.models || []
      const models = list.filter(m => m.id !== modelId)
      if (models.length === list.length) throw createError(404, `模型不存在：${modelId}`)
      const patch = { models }
      if (provider.defaultModel === modelId) patch.defaultModel = ''
      await settings.update({ providers: { [id]: patch } })
      const data = settings.get()
      if (data.defaultProvider === id && data.defaultModel === modelId) {
        await settings.update({ defaultProvider: '', defaultModel: '' })
      }
      hub.broadcast('provider/status', { id, status: statusCache.get(id) || { ok: null, detail: '模型已删除' } })
      return true
    },

    /** 内置模型：官方服务端（独立官网项目）尚未发布，这里如实返回空列表 */
    builtin() {
      return {
        available: false,
        provider: 'nianfeng-official',
        loginRequired: true,
        fetchedAt: Date.now(),
        reason:
          '「念风内置模型」由官方服务端提供（登录 / 计费 / 官方模型都在官网侧）。官方服务端是独立项目、当前尚未发布，所以这里还没有可用的内置模型。可以关闭上方开关，在本页配置自定义提供商。',
        models: [],
      }
    },

    /**
     * 真实流式补全。
     * 模型级参数（temperature / max_tokens / 额外请求体）在这里生效：
     * 请求里显式传入的 options 优先，其次是模型配置里的参数，最后才是适配器默认值。
     * @returns {Promise<{text: string}>}
     */
    async stream({ provider, model, messages, options, signal, onChunk, onToolCall, onReasoning }) {
      const providerId = provider
      const cfg = getProvider(providerId)
      const adapter = requireAdapter(cfg.type)
      if (needsKey(cfg.type) && !cfg.apiKey) throw createError(400, `提供商「${cfg.name}」尚未配置 API Key`)
      const useModel = model || cfg.defaultModel
      if (!useModel) throw createError(400, `请先为「${cfg.name}」选择一个模型`)

      const modelConfig = (cfg.models || []).find(m => m.id === useModel)
      const params = modelConfig?.params || {}
      const effectiveOptions = {
        ...options,
        ...(options?.temperature === undefined && params.temperature !== undefined ? { temperature: params.temperature } : {}),
        ...(options?.maxTokens === undefined && params.maxTokens !== undefined ? { maxTokens: params.maxTokens } : {}),
        ...(options?.extraBody === undefined && params.extraBody !== undefined ? { extraBody: params.extraBody } : {}),
      }
      // 后端最终图片预算：无论前端 / 工具 / 渠道怎么拼消息，一次请求只保留最近 N 张真图。
      const configuredImageLimit = Number(settings.get()?.preferences?.chat?.imagesPerRequest)
      const imageBudget = Number.isFinite(configuredImageLimit) ? Math.max(0, Math.min(8, configuredImageLimit)) : 2
      const requestMessages = enforceImageBudget(messages || [], imageBudget)


      const emptyResponseRetries = Math.max(
        0,
        Math.min(5, Number(cfg.emptyResponseRetries ?? settings.get().network?.emptyResponseRetries ?? 2) || 0),
      )
      const totalAttempts = emptyResponseRetries + 1
      const startedAt = Date.now()
      const controller = new AbortController()
      const timeoutMs = Number(cfg.timeoutMs) > 0 ? Number(cfg.timeoutMs) : settings.get().network.timeoutMs || 60000
      const timer = setTimeout(() => controller.abort(new Error('请求超时')), timeoutMs)
      signal?.addEventListener?.('abort', () => controller.abort(new Error('已取消')), { once: true })

      const toolCount = Array.isArray(options?.tools) ? options.tools.length : 0
      ctx.logger.info(`[models] 模型请求开始 · ${providerId} / ${useModel} · 超时 ${timeoutMs}ms · 工具 ${toolCount}`)
      hub.broadcast('chat/start', {
        provider: providerId,
        model: useModel,
        at: startedAt,
        timeoutMs,
        toolCount,
      })
      try {
        for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
          let attemptText = ''
          let attemptSummary = null
          const reasoningBuffer = []
          const attemptChunks = []
          let attemptCommitted = false
          await adapter.stream(
            {
              provider: cfg,
              model: useModel,
              messages: requestMessages,
              options: effectiveOptions,
              signal: controller.signal,
              onChunk: delta => {
                attemptText += delta
                // 空回复重试期间不要把空白 / 将被丢弃的内容流到界面；一旦出现非空白内容，
                // 说明这次一定成功，立刻把缓冲内容 flush 出去并恢复实时流式。
                if (attemptCommitted) {
                  onChunk?.(delta)
                  return
                }
                attemptChunks.push(delta)
                if (String(delta).trim()) {
                  attemptCommitted = true
                  for (const buffered of attemptChunks.splice(0)) onChunk?.(buffered)
                }
              },
              onToolCall: call => onToolCall?.(call),
              // 先缓冲思考内容：如果这次最终是空回复，重试时不会把重复思考播给前端。
              onReasoning: delta => reasoningBuffer.push(delta),
              // 适配器流读完后回传完整 tool_calls / finish_reason
              onDone: summary => {
                if (summary) attemptSummary = summary
              },
            },
            ctx,
          )
          const toolCalls = Array.isArray(attemptSummary?.toolCalls) ? attemptSummary.toolCalls : []
          if (attemptText.trim() || toolCalls.length) {
            if (!attemptCommitted && attemptChunks.length) {
              for (const buffered of attemptChunks.splice(0)) onChunk?.(buffered)
            }
            for (const delta of reasoningBuffer) onReasoning?.(delta)
            const elapsedMs = Date.now() - startedAt
            ctx.logger.info(
              `[models] 模型响应完成 · ${providerId} / ${useModel} · ${elapsedMs}ms · 输出 ${attemptText.length} 字 · 工具 ${toolCalls.length}`,
            )
            hub.broadcast('chat/done', {
              provider: providerId,
              model: useModel,
              length: attemptText.length,
              ms: elapsedMs,
              toolCalls: toolCalls.length,
              finishReason: attemptSummary?.reason || null,
              attempts: attempt,
            })
            return {
              text: attemptText,
              toolCalls,
              finishReason: attemptSummary?.reason || null,
              usage: applyUsagePricing(normalizeUsage(attemptSummary?.usage) || attemptSummary?.usage || null, params),
            }
          }

          // 空回复：DeepSeek 官方 harness 会把「finish=stop 且没有任何 block」视为
          // EMPTY_RESPONSE 错误并自动重试；这里采用相同策略，避免用户一直等一个不会来的消息。
          const finishReason = attemptSummary?.reason || 'stop'
          const reasonText =
            finishReason === 'length'
              ? '模型输出达到长度上限，既没有正文也没有工具调用；可提高最大输出 token、降低推理等级或更换模型'
              : '模型返回了空回复（既没有正文也没有工具调用）'
          if (attempt < totalAttempts) {
            ctx.logger?.warn?.(
              `[models] ${providerId} / ${useModel} 第 ${attempt}/${totalAttempts} 次返回为空（${reasonText}），${Math.round(400 * attempt)}ms 后自动重试`,
            )
            await abortableDelay(400 * attempt, controller.signal)
            continue
          }
          const emptyError = new Error(`${reasonText}；已自动重试 ${emptyResponseRetries} 次，请更换模型或稍后重试`)
          emptyError.code = 'EMPTY_RESPONSE'
          throw emptyError
        }
      } catch (err) {
        const detail = normalizeError(err)
        ctx.logger.error(`[models] 模型请求失败 · ${providerId} / ${useModel} · ${Date.now() - startedAt}ms：${detail}`)
        hub.broadcast('chat/error', {
          provider: providerId,
          model: useModel,
          detail,
          ms: Date.now() - startedAt,
          timedOut: /timeout|超时|aborted/i.test(String(err?.message || err)),
        })
        throw createError(502, detail)
      } finally {
        clearTimeout(timer)
      }
    },

    /** 非流式聚合 */
    async complete({ provider, model, messages, options, signal }) {
      let text = ''
      await service.stream({ provider, model, messages, options, signal, onChunk: delta => (text += delta) })
      return text
    },

    /**
     * 文本向量化。从已配置提供商里调用对应模型的 embedding 接口，
     * 返回 { embeddings, dimension, provider, model }；维度由接口实际返回自动决定。
     */
    async embed({ provider, model, input } = {}) {
      const providerId = provider || settings.get().defaultProvider
      if (!providerId) throw createError(400, '请先在「设置 → 模型」选择向量模型提供商')
      const cfg = getProvider(providerId)
      const adapter = requireAdapter(cfg.type)
      if (typeof adapter.embed !== 'function') throw createError(400, `提供商类型「${cfg.type}」不支持 embedding 接口`)
      if (needsKey(cfg.type) && !cfg.apiKey) throw createError(400, `提供商「${cfg.name}」尚未配置 API Key`)
      const useModel = model || cfg.defaultModel
      if (!useModel) throw createError(400, `请先为「${cfg.name}」选择向量模型`)
      const texts = (Array.isArray(input) ? input : [input]).map(value => String(value ?? '')).filter(value => value.trim())
      if (!texts.length) throw createError(400, 'embedding 输入不能为空')
      const raw = await adapter.embed({ provider: cfg, model: useModel, input: texts }, ctx)
      const embeddings = (Array.isArray(raw) ? raw : [])
        .map(vector => (Array.isArray(vector) ? vector.map(value => Number(value)).filter(Number.isFinite) : []))
        .filter(vector => vector.length)
      if (!embeddings.length) throw createError(502, `${cfg.name} / ${useModel} 未返回有效的 embedding 向量`)
      const dimension = embeddings[0].length
      if (embeddings.some(vector => vector.length !== dimension)) {
        throw createError(502, 'embedding 返回的向量维度不一致')
      }
      return { embeddings, dimension, provider: providerId, model: useModel }
    },

    /** 真实翻译（通过已配置模型；没有模型就明确报错） */
    async translate({ text, target = 'en', provider, model }) {
      const data = settings.get()
      const providerId = provider || data.defaultProvider
      const useModel = model || data.defaultModel || data.providers[providerId]?.defaultModel
      const content = await service.complete({
        provider: providerId,
        model: useModel,
        messages: [
          {
            role: 'system',
            content: `You are a professional translator. Translate the user's content into ${target}. Output the translation only, without explanation.`,
          },
          { role: 'user', content: text },
        ],
        options: { temperature: 0.2 },
      })
      return { text: content.trim(), provider: providerId, model: useModel }
    },

    adapters: () => Object.keys(adapters),
    statuses: () => Object.fromEntries(statusCache),

    /** 运行时提供商：预留给未来的托管服务（官方服务端为独立项目，本仓库不含云逻辑） */
    registerProvider(id, descriptor = {}) {
      runtimeProviders.set(id, {
        id,
        type: descriptor.type || 'runtime',
        name: descriptor.name || id,
        baseURL: descriptor.baseURL || '',
        description: descriptor.description || '',
        enabled: descriptor.enabled !== false,
        configured: descriptor.configured !== false,
        managed: true,
        models: descriptor.models || [],
        defaultModel: descriptor.defaultModel || '',
      })
      hub.broadcast('provider/status', { id, status: { ok: null, detail: '已注册' } })
      return () => {
        runtimeProviders.delete(id)
        statusCache.delete(id)
        hub.broadcast('provider/status', { id, status: { ok: false, detail: '已移除' } })
      }
    },
    updateRuntimeProvider(id, patch = {}) {
      const current = runtimeProviders.get(id)
      if (!current) return false
      Object.assign(current, patch)
      hub.broadcast('provider/status', { id, status: statusCache.get(id) || { ok: null, detail: '已更新' } })
      return true
    },
    runtimeProviders: () => [...runtimeProviders.keys()],

    /**
     * 注册自定义适配器（供插件生态 / 测试使用）。
     * adapter: { label, listModels(provider, ctx), test(provider, ctx), stream(args, ctx) }
     */
    registerAdapter(type, adapter) {
      if (adapters[type]) throw new Error(`适配器已存在：${type}`)
      adapters[type] = adapter
      ctx.logger.info(`已注册自定义模型适配器：${type}`)
      return () => delete adapters[type]
    },
  }

  ctx.provide('models', service)
  ctx.logger.info('模型接入层就绪（openai / anthropic / ollama）')
}

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

function requireAdapter(type) {
  const adapter = adapters[type]
  if (!adapter) throw createError(400, `不支持的提供商类型：${type}`)
  return adapter
}

function trimSlash(url) {
  return String(url).replace(/\/+$/, '')
}

/** 提供商自定义请求头覆盖（Authorization 也可以覆盖） */
function customHeaders(provider) {
  return provider?.headers && typeof provider.headers === 'object' && !Array.isArray(provider.headers) ? provider.headers : {}
}

function authHeaders(provider) {
  return { ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}), ...customHeaders(provider) }
}

function anthropicHeaders(provider) {
  return {
    'x-api-key': provider.apiKey || '',
    'anthropic-version': '2023-06-01',
    ...customHeaders(provider),
  }
}

function providerTimeout(provider) {
  const ms = Number(provider?.timeoutMs)
  return Number.isFinite(ms) && ms > 0 ? ms : 30000
}

/**
 * DeepSeek 官方思考参数：
 *   off  -> thinking:{type:'disabled'}
 *   low/high/max -> thinking:{type:'enabled'} + reasoning_effort:<level>
 * 只对 DeepSeek 兼容的提供商 / 模型附加，避免其他 OpenAI 兼容服务收到未知字段。
 */
function deepseekThinkingBody(provider, model, options) {
  const level = options?.reasoningEffort
  if (!level) return {}
  const isDeepseek = provider?.type === 'deepseek' || /deepseek/i.test(provider?.baseURL || '') || /deepseek/i.test(model || '')
  if (!isDeepseek) return {}
  if (level === 'off') return { thinking: { type: 'disabled' } }
  if (['low', 'high', 'max'].includes(level)) return { thinking: { type: 'enabled' }, reasoning_effort: level }
  return {}
}

/** 模型配置里的「额外请求体」，不允许覆盖核心字段 */
function extraBody(options) {
  const extra = options?.extraBody
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return {}
  const copy = { ...extra }
  for (const reserved of ['model', 'messages', 'stream', 'system']) delete copy[reserved]
  return copy
}

const PROVIDER_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/

function defaultBaseURL(type) {
  if (type === 'anthropic') return 'https://api.anthropic.com'
  if (type === 'ollama') return 'http://localhost:11434'
  if (type === 'deepseek') return 'https://api.deepseek.com'
  if (type === 'gemini') return 'https://generativelanguage.googleapis.com'
  return 'https://api.openai.com/v1'
}

function normalizeTimeout(value) {
  const ms = Number(value)
  if (!Number.isFinite(ms) || ms <= 0) return 0
  return Math.min(Math.round(ms), 30 * 60 * 1000)
}

function normalizeHeaders(input) {
  if (!input) return {}
  let data = input
  if (typeof input === 'string') {
    try {
      data = JSON.parse(input)
    } catch (_) {
      throw createError(400, '请求头覆盖不是合法 JSON')
    }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw createError(400, '请求头覆盖必须是 JSON 对象')
  const out = {}
  for (const [key, value] of Object.entries(data)) {
    const name = String(key).trim()
    if (!name) continue
    out[name] = String(value ?? '')
  }
  return out
}

function normalizeProviderDescriptor(descriptor = {}) {
  const id = String(descriptor.id || '').trim()
  if (!PROVIDER_ID_RE.test(id)) throw createError(400, '提供商 ID 只能包含字母、数字、点、下划线、短横线，且必须以字母或数字开头')
  const type = String(descriptor.type || 'openai').trim() || 'openai'
  const name = String(descriptor.name || '').trim() || id
  const baseURL = String(descriptor.baseURL || '').trim() || defaultBaseURL(type)
  return {
    id,
    provider: {
      type,
      name,
      baseURL,
      apiKey: String(descriptor.apiKey || ''),
      enabled: descriptor.enabled !== false,
      models: [],
      defaultModel: '',
      timeoutMs: normalizeTimeout(descriptor.timeoutMs),
      proxy: String(descriptor.proxy || '').trim(),
      headers: normalizeHeaders(descriptor.headers),
    },
  }
}

const NUMERIC_PARAMS = ['temperature', 'maxTokens', 'contextLength', 'priceInput', 'priceOutput', 'priceCached']

function normalizeModelParams(params) {
  const out = {}
  if (!params || typeof params !== 'object') return out
  for (const key of NUMERIC_PARAMS) {
    const raw = params[key]
    if (raw === undefined || raw === null || raw === '') continue
    const num = Number(raw)
    if (Number.isFinite(num)) out[key] = num
  }
  const extra = params.extraBody
  if (extra !== undefined && extra !== null && extra !== '') {
    let data = extra
    if (typeof extra === 'string') {
      try {
        data = JSON.parse(extra)
      } catch (_) {
        throw createError(400, '额外请求体不是合法 JSON')
      }
    }
    if (data && typeof data === 'object' && !Array.isArray(data)) out.extraBody = data
  }
  return out
}

/** 用 patch 更新参数：显式传 null / 空字符串表示清除该参数 */
function mergeModelParams(base = {}, patch = {}) {
  const next = normalizeModelParams(base)
  if (!patch || typeof patch !== 'object') return next
  for (const key of NUMERIC_PARAMS) {
    if (!(key in patch)) continue
    if (patch[key] === null || patch[key] === '') {
      delete next[key]
      continue
    }
    const num = Number(patch[key])
    if (Number.isFinite(num)) next[key] = num
    else delete next[key]
  }
  if ('extraBody' in patch) {
    if (patch.extraBody === null || patch.extraBody === '') {
      delete next.extraBody
    } else {
      let data = patch.extraBody
      if (typeof data === 'string') {
        try {
          data = JSON.parse(data)
        } catch (_) {
          throw createError(400, '额外请求体不是合法 JSON')
        }
      }
      if (data && typeof data === 'object' && !Array.isArray(data)) next.extraBody = data
      else delete next.extraBody
    }
  }
  return next
}

function normalizeModelEntry(model = {}) {
  const id = String(model.id || '').trim()
  if (!id) throw createError(400, '模型 ID 不能为空')
  const entry = {
    id,
    name: String(model.name || '').trim() || id,
    enabled: model.enabled !== false,
    custom: model.custom === true,
    params: normalizeModelParams(model.params),
  }
  if (model.ownedBy) entry.ownedBy = model.ownedBy
  if (model.size) entry.size = model.size
  return entry
}

function maskKey(key) {
  if (!key) return ''
  return key.length <= 8 ? '••••' : `${key.slice(0, 3)}…${key.slice(-4)}`
}

function isSensitiveHeader(name) {
  return /authorization|api[-_]?key|token|secret|cookie|password/i.test(String(name))
}

/** 请求头覆盖返回给前端时，敏感项打码（与 API Key 同一策略） */
function sanitizeHeaders(headers) {
  const out = {}
  if (!headers || typeof headers !== 'object') return out
  for (const [key, value] of Object.entries(headers)) {
    out[key] = isSensitiveHeader(key) ? maskKey(String(value)) : String(value)
  }
  return out
}

/* ---------------- 工具调用 / 多模态消息转换 ---------------- */

function stringifyContent(content) {
  if (content === null || content === undefined) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    // 多模态 content：任何不支持图片的旧路径统一降级为 [图片] 占位，
    // 避免把 base64 原样卷进 prompt 或日志里。
    const text = content
      .map(part => {
        if (typeof part === 'string') return part
        if (part?.type === 'text') return String(part.text ?? '')
        if (part?.type === 'image_url' || part?.type === 'image' || part?.inlineData || part?.image) return '[图片]'
        return ''
      })
      .filter(Boolean)
      .join('\n')
    return text || '[图片]'
  }
  return JSON.stringify(content)
}

/** 把前端多模态 content 转成 OpenAI 兼容格式（text / image_url）。 */
function toOpenAIContent(content) {
  if (!Array.isArray(content)) return stringifyContent(content)
  const parts = []
  for (const part of content) {
    if (typeof part === 'string') {
      if (part) parts.push({ type: 'text', text: part })
      continue
    }
    if (part?.type === 'text') {
      parts.push({ type: 'text', text: String(part.text ?? '') })
      continue
    }
    const imageUrl = part?.image_url?.url || part?.url || ''
    if (imageUrl) parts.push({ type: 'image_url', image_url: { url: String(imageUrl) } })
    else if (part?.type === 'image_url' || part?.type === 'image') parts.push({ type: 'text', text: '[图片]' })
  }
  return parts.length ? parts : stringifyContent(content)
}

/** 把前端多模态 content 转成 Anthropic blocks；外链图片无法直接给 Claude，降级为文本。 */
function toAnthropicBlocks(content) {
  if (!Array.isArray(content)) return [{ type: 'text', text: stringifyContent(content) }]
  const blocks = []
  for (const part of content) {
    if (typeof part === 'string') {
      if (part) blocks.push({ type: 'text', text: part })
      continue
    }
    if (part?.type === 'text') {
      blocks.push({ type: 'text', text: String(part.text ?? '') })
      continue
    }
    const url = String(part?.image_url?.url || part?.url || '')
    const match = /^data:([^;,]+);base64,([\s\S]+)$/.exec(url)
    if (match) {
      blocks.push({ type: 'image', source: { type: 'base64', media_type: match[1], data: match[2].replace(/\s+/g, '') } })
    } else if (url) {
      blocks.push({ type: 'text', text: '[图片：该模型不支持直接读取外链图片]' })
    }
  }
  return blocks.length ? blocks : [{ type: 'text', text: '[图片]' }]
}

/** 把前端多模态 content 转成 Gemini parts。 */
function toGeminiParts(content) {
  if (!Array.isArray(content)) return [{ text: stringifyContent(content) }]
  const parts = []
  for (const part of content) {
    if (typeof part === 'string') {
      if (part) parts.push({ text: part })
      continue
    }
    if (part?.type === 'text') {
      parts.push({ text: String(part.text ?? '') })
      continue
    }
    const url = String(part?.image_url?.url || part?.url || '')
    const match = /^data:([^;,]+);base64,([\s\S]+)$/.exec(url)
    if (match) parts.push({ inlineData: { mimeType: match[1], data: match[2].replace(/\s+/g, '') } })
    else if (url) parts.push({ text: '[图片：该模型不支持直接读取外链图片]' })
  }
  return parts.length ? parts : [{ text: '[图片]' }]
}

/** Ollama 的图片放在单独的 images 数组里（base64）。 */
function toOllamaContent(content) {
  if (!Array.isArray(content)) return { content: stringifyContent(content), images: [] }
  const texts = []
  const images = []
  for (const part of content) {
    if (typeof part === 'string') {
      texts.push(part)
      continue
    }
    if (part?.type === 'text') {
      texts.push(String(part.text ?? ''))
      continue
    }
    const url = String(part?.image_url?.url || part?.url || '')
    const match = /^data:[^;,]+;base64,([\s\S]+)$/.exec(url)
    if (match) images.push(match[1].replace(/\s+/g, ''))
    else if (url) texts.push('[图片]')
  }
  return { content: texts.filter(Boolean).join('\n') || '[图片]', images }
}

function normalizeArguments(args) {
  if (args === null || args === undefined) return '{}'
  if (typeof args === 'string') return args || '{}'
  try {
    return JSON.stringify(args)
  } catch (_) {
    return '{}'
  }
}

const isImageContentPart = part =>
  !!part && typeof part === 'object' && (part.type === 'image_url' || part.type === 'image' || part.type === 'input_image')

/**
 * 后端最终边界：一次模型请求最多保留最近 N 张真实图片，更早的图片统一降级为 [图片] 文本。
 * 前端 context-builder 已经做过一次；这里再兜一层，防止工具结果、渠道拼接、自定义
 * 适配器等路径绕过占位符，保证“只有最近两张原图进模型”的约定无论什么渠道都成立。
 */
function enforceImageBudget(messages = [], maxImages = 2) {
  const list = Array.isArray(messages) ? messages : []
  const limit = Math.max(0, Math.min(8, Number(maxImages) || 0))
  let remaining =
    list.reduce((count, message) => {
      if (!message || typeof message !== 'object' || !Array.isArray(message.content)) return count
      return count + message.content.filter(isImageContentPart).length
    }, 0) - limit
  if (remaining <= 0) return list
  return list.map(message => {
    if (!message || typeof message !== 'object' || !Array.isArray(message.content)) return message
    let changed = false
    const content = message.content.map(part => {
      if (!isImageContentPart(part)) return part
      if (remaining > 0) {
        remaining -= 1
        changed = true
        return { type: 'text', text: '[图片]' }
      }
      return part
    })
    return changed ? { ...message, content } : message
  })
}


/** 前端上下文 -> OpenAI 兼容 messages（保留 assistant.tool_calls / role=tool） */
function toOpenAIMessages(messages = [], { keepReasoning = false, padReasoning = false } = {}) {
  return (Array.isArray(messages) ? messages : []).map(message => {
    if (!message || typeof message !== 'object') return { role: 'user', content: '' }
    if (message.role === 'tool') {
      return {
        role: 'tool',
        tool_call_id: message.tool_call_id || message.toolCallId || '',
        content: stringifyContent(message.content),
      }
    }
    if (message.role === 'assistant') {
      const reasoning = message.reasoning_content ?? message.meta?.reasoningContent
      const hasToolCalls = Array.isArray(message.tool_calls) && message.tool_calls.length > 0
      const out = { role: 'assistant', content: stringifyContent(message.content) }
      if (hasToolCalls) {
        out.tool_calls = message.tool_calls.map(call => ({
          id: call.id || `call_${Math.random().toString(36).slice(2, 10)}`,
          type: call.type || 'function',
          function: {
            name: call.function?.name || call.name || '',
            arguments: normalizeArguments(call.function?.arguments ?? call.arguments),
          },
        }))
      }
      // DeepSeek thinking 模式要求把历史 assistant 的 reasoning_content 回传；
      // 如果历史里缺字段，带上空字符串也比整个字段缺失安全（官方校验只检查字段）。
      // 关闭思考（off / 降级重试）时会整体移除，避免非思考请求携带历史推理。
      if (keepReasoning) {
        if (reasoning) out.reasoning_content = String(reasoning)
        else if (padReasoning && hasToolCalls) out.reasoning_content = ''
      }
      return out
    }
    const role = message.role || 'user'
    return { role, content: role === 'user' ? toOpenAIContent(message.content) : stringifyContent(message.content) }
  })
}

/** 前端上下文 -> Ollama /api/chat messages */
function toOllamaMessages(messages = []) {
  return (Array.isArray(messages) ? messages : []).map(message => {
    if (!message || typeof message !== 'object') return { role: 'user', content: '' }
    if (message.role === 'tool') {
      return {
        role: 'tool',
        content: stringifyContent(message.content),
        ...(message.name ? { tool_name: message.name } : {}),
      }
    }
    if (message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length) {
      return {
        role: 'assistant',
        content: message.content ?? '',
        tool_calls: message.tool_calls.map(call => {
          let args = call.function?.arguments ?? call.arguments ?? {}
          if (typeof args === 'string') {
            try {
              args = JSON.parse(args)
            } catch (_) {
              args = {}
            }
          }
          return { function: { name: call.function?.name || call.name || '', arguments: args } }
        }),
      }
    }
    if ((message.role || 'user') === 'user' && Array.isArray(message.content)) {
      const { content, images } = toOllamaContent(message.content)
      return { role: 'user', content, ...(images.length ? { images } : {}) }
    }
    return { role: message.role || 'user', content: stringifyContent(message.content) }
  })
}

function normalizeToolCallRecord(call = {}, index = 0) {
  const fn = call.function || call
  let args = fn.arguments ?? call.arguments ?? {}
  if (typeof args !== 'string') {
    try {
      args = JSON.stringify(args ?? {})
    } catch (_) {
      args = '{}'
    }
  }
  return {
    index: Number.isFinite(call.index) ? call.index : index,
    id: call.id || `call_${index}`,
    type: 'function',
    function: { name: fn.name || call.name || '', arguments: args || '{}' },
  }
}

function createError(status, message) {
  const err = new Error(message)
  err.status = status
  return err
}

function abortableDelay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason || new Error('已取消'))
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort)
      resolve()
    }, Math.max(0, Number(ms) || 0))
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason || new Error('已取消'))
    }
    signal?.addEventListener?.('abort', onAbort, { once: true })
  })
}

function normalizeError(err) {
  if (!err) return '未知错误'
  if (err.name === 'AbortError' || err.code === 'ABORT_ERR') {
    const text = String(err.message || '').trim()
    // fetch 原生 abort 只会给 "This operation was aborted" 这类无意义文案；
    // 我们主动抛出的 AbortError 会带具体阶段（例如代理隧道 TLS 未完成）。
    return text && !/operation was aborted/i.test(text) ? text : '请求超时或被取消'
  }
  // Node fetch 的网络错误会被包成 TypeError('fetch failed')，真实原因在 cause 链里
  let cause = err.cause
  while (cause?.cause) cause = cause.cause
  if (cause || /fetch failed/i.test(err.message || '')) {
    const code = cause?.code || err.code || (cause?.errors?.[0]?.code ?? '')
    const detail = cause?.errors?.[0]?.message || cause?.message || err.message
    return `无法连接远端服务${code ? `（${code}）` : ''}：${detail}`
  }
  const status = err.status || err.statusCode
  if (status) {
    const text = String(err.message || '').trim()
    if (!text) return `HTTP ${status}`
    // 上游错误正文优先原样返回；只有消息里完全没有状态码时才补前缀。
    return /^\d{3}\b/.test(text) ? text : `HTTP ${status} · ${text}`
  }
  return err.message || String(err)
}

/**
 * 带超时的请求，返回 Response（流式时 body 由调用方继续消费）。
 * - 默认走全局 fetch；
 * - provider.proxy 配置了 http(s) 代理时，走真实代理隧道（CONNECT / absolute-form），
 *   轻量实现，无第三方依赖。
 * - 超时覆盖「建连 + 响应头」；非流式的 json()/text() 读取另有同一时长的兜底，
 *   避免上游隧道半死不活时请求永远不落地。
 */
async function request(ctx, url, { method = 'GET', headers = {}, body, signal, timeoutMs = 30000, proxy = '', debug = false } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('请求超时')), timeoutMs)
  const onAbort = () => controller.abort(signal?.reason || new Error('已取消'))
  signal?.addEventListener?.('abort', onAbort, { once: true })
  try {
    const res = proxy
      ? await proxyRequest(url, { method, headers, body, signal: controller.signal, proxy, debug, logger: ctx?.logger })
      : await fetch(url, { method, headers, body, signal: controller.signal })
    const wrapped = withResponseReadTimeout(res, controller, timeoutMs)
    if (!wrapped.ok) {
      const text = await wrapped.text().catch(() => '')
      const err = new Error(`${wrapped.status} ${wrapped.statusText || ''}${text ? ' · ' + text.slice(0, 600) : ''}`)
      err.status = wrapped.status
      throw err
    }
    return wrapped
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener?.('abort', onAbort)
  }
}

/**
 * 非流式响应体的兜底超时：json()/text() 超过 timeoutMs 仍未读完时，中止底层请求并抛错。
 * 之前超时只覆盖到响应头，body 读取阶段如果卡住（代理隧道半开、连接假死），Promise 会永远挂着。
 * 流式调用方直接消费 res.body，不经过 json()/text()，因此不会影响长连接聊天。
 */
function withResponseReadTimeout(res, controller, timeoutMs) {
  const wrap = method => {
    const original = typeof res[method] === 'function' ? res[method].bind(res) : null
    if (!original) return
    Object.defineProperty(res, method, {
      configurable: true,
      writable: true,
      value: (...args) =>
        new Promise((resolve, reject) => {
          let done = false
          const timer = setTimeout(() => {
            if (done) return
            done = true
            try {
              controller.abort(new Error('读取响应超时'))
            } catch (_) {
              /* ignore */
            }
            try {
              res.destroy?.()
            } catch (_) {
              /* ignore */
            }
            reject(Object.assign(new Error('响应读取超时'), { code: 'ETIMEDOUT' }))
          }, timeoutMs)
          Promise.resolve(original(...args)).then(
            value => {
              if (done) return
              done = true
              clearTimeout(timer)
              resolve(value)
            },
            err => {
              if (done) return
              done = true
              clearTimeout(timer)
              reject(err)
            },
          )
        }),
    })
  }
  wrap('json')
  wrap('text')
  return res
}

/** 把 Node IncomingMessage 包成 fetch Response 的最小可用子集 */
function wrapNodeResponse(res) {
  const body = Readable.toWeb(res)
  const tiny = {
    ok: res.statusCode >= 200 && res.statusCode < 300,
    status: res.statusCode,
    statusText: res.statusMessage || '',
    headers: { get: name => res.headers[String(name).toLowerCase()] ?? null },
    body,
    async text() {
      // 必须走同一个 web body 读，不能一边 Readable.toWeb(res) 一边 res.on('data')：
      // 两边抢同一条流时，真实网络下可能永远等不到 end，表现就是“响应头 200 后卡死”。
      const reader = body.getReader()
      const chunks = []
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          if (value) chunks.push(Buffer.from(value))
        }
      } finally {
        try {
          reader.releaseLock()
        } catch (_) {
          /* ignore */
        }
      }
      return Buffer.concat(chunks).toString('utf8')
    },
    destroy() {
      try {
        res.destroy()
      } catch (_) {
        /* ignore */
      }
    },
  }
  tiny.json = async () => JSON.parse(await tiny.text())
  return tiny
}

function proxyAuthorization(proxy) {
  if (!proxy.username && !proxy.password) return ''
  const token = Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')
  return `Basic ${token}`
}

/** 通过 http(s) 代理发起请求：http 目标用 absolute-form，https 目标用 CONNECT 隧道 */
function proxyRequest(url, { method = 'GET', headers = {}, body, signal, proxy, debug = false, logger = null } = {}) {
  const target = new URL(url)
  let proxyURL
  try {
    proxyURL = new URL(String(proxy))
  } catch (_) {
    return Promise.reject(new Error(`代理地址不合法：${proxy}`))
  }
  if (proxyURL.protocol !== 'http:' && proxyURL.protocol !== 'https:') {
    return Promise.reject(new Error(`不支持的代理协议：${proxyURL.protocol}`))
  }
  const proxyModule = proxyURL.protocol === 'https:' ? https : http
  const proxyPort = proxyURL.port || (proxyURL.protocol === 'https:' ? 443 : 80)
  const auth = proxyAuthorization(proxyURL)
  const log = debug && typeof logger?.info === 'function' ? message => logger.info(message) : () => {}

  return new Promise((resolve, reject) => {
    let settled = false
    let connectReq = null
    let tlsSocket = null
    let innerReq = null

    const detach = () => signal?.removeEventListener?.('abort', onAbort)
    const dispose = () => {
      try {
        innerReq?.destroy?.()
      } catch (_) {
        /* ignore */
      }
      if (tlsSocket) {
        try {
          tlsSocket.destroy()
        } catch (_) {
          /* ignore */
        }
      } else {
        try {
          connectReq?.destroy?.()
        } catch (_) {
          /* ignore */
        }
      }
    }
    const succeed = res => {
      if (settled) return
      settled = true
      detach()
      resolve(wrapNodeResponse(res))
    }
    const fail = err => {
      if (settled) return
      settled = true
      const error = err instanceof Error ? err : new Error(String(err))
      log(`[models][proxy] 失败：${error.message}`)
      detach()
      dispose()
      reject(error)
    }
    const onAbort = () => {
      const reason = signal?.reason
      const text = reason instanceof Error ? String(reason.message || '').trim() : ''
      const message = text && !/abort|cancel|取消/i.test(text) ? `代理隧道未在超时时间内完成：${text}` : text || '请求已取消'
      fail(Object.assign(new Error(message), { name: 'AbortError', code: 'ABORT_ERR' }))
    }
    if (signal?.aborted) return onAbort()
    signal?.addEventListener?.('abort', onAbort, { once: true })

    if (target.protocol === 'http:') {
      // 明文 HTTP 通过 absolute-form 直接发给代理；Host 用目标站点的
      const targetHeaders = { ...headers }
      if (!Object.keys(targetHeaders).some(key => key.toLowerCase() === 'host')) targetHeaders.Host = target.host
      const forwardHeaders = { ...(auth ? { 'Proxy-Authorization': auth } : {}), ...targetHeaders }
      log(`[models][proxy] HTTP ${method} ${url} via ${proxyURL.host}`)
      innerReq = proxyModule.request(
        {
          host: proxyURL.hostname,
          port: proxyPort,
          method,
          path: url,
          headers: forwardHeaders,
          signal,
        },
        res => succeed(res),
      )
      innerReq.on('error', fail)
      if (body) innerReq.write(body)
      innerReq.end()
      return
    }

    if (target.protocol !== 'https:') return fail(new Error(`不支持的协议：${target.protocol}`))
    const targetPort = target.port || 443
    // 和 curl 保持一致：CONNECT 的 Host 用目标 authority，并带 Proxy-Connection；
    // 某些代理实现（包括 Mihomo/Clash 的部分版本）会按这个头处理隧道。
    const connectHeaders = {
      Host: `${target.hostname}:${targetPort}`,
      'Proxy-Connection': 'Keep-Alive',
      ...(auth ? { 'Proxy-Authorization': auth } : {}),
    }
    log(`[models][proxy] CONNECT ${target.hostname}:${targetPort} via ${proxyURL.host}`)
    connectReq = proxyModule.request({
      host: proxyURL.hostname,
      port: proxyPort,
      method: 'CONNECT',
      path: `${target.hostname}:${targetPort}`,
      headers: connectHeaders,
      signal,
    })
    connectReq.on('error', fail)
    connectReq.on('connect', (res, socket, head) => {
      log(`[models][proxy] CONNECT 响应 HTTP ${res.statusCode}`)
      if (res.statusCode !== 200) {
        try {
          socket.destroy()
        } catch (_) {
          /* ignore */
        }
        return fail(new Error(`代理 CONNECT 失败：HTTP ${res.statusCode}`))
      }
      if (head?.length) socket.unshift(head)
      tlsSocket = tls.connect({ socket, servername: target.hostname }, () => {
        log('[models][proxy] TLS 握手完成')
        innerReq = https.request(
          {
            createConnection: () => tlsSocket,
            method,
            host: target.hostname,
            port: targetPort,
            path: `${target.pathname}${target.search}`,
            headers: { ...headers, Host: target.host },
            signal,
          },
          r => {
            log(`[models][proxy] 响应头 HTTP ${r.statusCode}`)
            succeed(r)
          },
        )
        innerReq.on('error', fail)
        if (body) innerReq.write(body)
        innerReq.end()
        log(`[models][proxy] 已发送 ${method} ${target.pathname}${target.search}`)
      })
      tlsSocket.on('error', fail)
      // CONNECT 成功但 TLS 握手一直不完成：close/超时都必须让 Promise 落地，避免“获取中”永久卡住。
      tlsSocket.once('close', () => {
        if (!settled) fail(new Error('代理隧道在 TLS 握手完成前关闭'))
      })
    })
    connectReq.end()
  })
}

/** 解析 SSE：`data: {...}` 行 */
async function readSSE(res, onData) {
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue
      const payload = trimmed.slice(5).trim()
      if (!payload || payload === '[DONE]') continue
      try {
        onData(JSON.parse(payload))
      } catch (_) {
        /* 忽略无法解析的行 */
      }
    }
  }
}

/** 解析 NDJSON（Ollama） */
async function readNDJSON(res, onData) {
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        onData(JSON.parse(line))
      } catch (_) {
        /* 忽略半行 */
      }
    }
  }
  if (buffer.trim()) {
    try {
      onData(JSON.parse(buffer))
    } catch (_) {
      /* ignore */
    }
  }
}

