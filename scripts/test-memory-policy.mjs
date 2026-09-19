/*
 * 念风chat · 群聊记忆渠道开关回归测试
 * 用法：node scripts/test-memory-policy.mjs
 *
 * 重点验证：
 *   - 总开关关闭时所有群聊都不生成新记忆；
 *   - 总开关开启但渠道未显式开启时，默认不生成；
 *   - 显式开启后允许提交；
 *   - 旧的 groupSummaryDisabled 配置能正确迁移（true=禁用、false=曾显式允许）。
 */
import * as memoryStorePlugin from '../plugins/domain/memory-store/index.mjs'
import { createChecker } from './test-utils.mjs'

const { check, summarize } = createChecker()

function createHarness(values = {}) {
  const configValues = new Map(Object.entries(values))
  const config = {
    get: (key, fallback) => (configValues.has(key) ? configValues.get(key) : fallback),
    set: (key, value) => {
      configValues.set(key, value)
      return value
    },
  }
  const store = {
    messagesOf: () => [],
    channelForConversation: () => ({ channelId: 'napcat:ch-group-1', group: 'group', roleId: 'role-group-1' }),
  }
  const sessions = {
    get: () => ({ id: 'conv-group-1', meta: {} }),
    ensureMessages: async () => null,
  }
  const events = { on: () => () => {} }
  const services = {
    config,
    'chat-store': store,
    'session-service': sessions,
    'event-bus': events,
  }
  let service = null
  const ctx = {
    inject: name => services[name],
    provide: (name, value) => {
      if (name === 'memory-store') service = value
    },
    registry: { get: () => ({}) },
    effect: () => {},
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  }
  memoryStorePlugin.apply(ctx)
  return { service, configValues }
}

const isSkipped = result => result?.skipped === true

async function main() {
  console.log('\n① 总开关关闭：全部群聊不生成')
  {
    const harness = createHarness({
      'memory.enabled': true,
      'memory.autoSummarize': true,
      'memory.groupSummaryEnabled': false,
      'memory.groupChannelSummaryEnabled': { 'ch-group-1': true },
    })
    const result = await harness.service.ingestConversation('conv-group-1')
    check('总开关关闭时即使渠道开启也不生成', isSkipped(result), JSON.stringify(result))
  }

  console.log('\n② 总开关开启：未显式开启的渠道默认不生成')
  {
    const harness = createHarness({
      'memory.enabled': true,
      'memory.autoSummarize': true,
      'memory.groupSummaryEnabled': true,
      'memory.groupChannelSummaryEnabled': {},
    })
    const result = await harness.service.ingestConversation('conv-group-1')
    check('渠道未开启时返回 skipped', isSkipped(result), JSON.stringify(result))
  }

  console.log('\n③ 显式开启：允许进入后续概括流程')
  {
    const harness = createHarness({
      'memory.enabled': true,
      'memory.autoSummarize': true,
      'memory.groupSummaryEnabled': true,
      'memory.groupChannelSummaryEnabled': { 'ch-group-1': true },
    })
    const result = await harness.service.ingestConversation('conv-group-1')
    check('渠道显式开启后不再被 skipped 拦截', !isSkipped(result), JSON.stringify(result))
  }

  console.log('\n④ 渠道 id 带类型前缀 / 裸 id 都能命中')
  {
    const harness = createHarness({
      'memory.enabled': true,
      'memory.autoSummarize': true,
      'memory.groupSummaryEnabled': true,
      'memory.groupChannelSummaryEnabled': { 'napcat:ch-group-1': true },
    })
    const result = await harness.service.ingestConversation('conv-group-1')
    check('chat-store 带前缀、配置写裸 id 时仍命中', !isSkipped(result), JSON.stringify(result))
  }

  console.log('\n⑤ 旧配置迁移')
  {
    const allowed = createHarness({
      'memory.enabled': true,
      'memory.autoSummarize': true,
      'memory.groupSummaryEnabled': true,
      'memory.groupSummaryDisabled': { 'ch-group-1': false },
    })
    check(
      '旧 false（曾显式允许）迁移为新表 true',
      allowed.configValues.get('memory.groupChannelSummaryEnabled')?.['ch-group-1'] === true,
      JSON.stringify(allowed.configValues.get('memory.groupChannelSummaryEnabled')),
    )
    const allowedResult = await allowed.service.ingestConversation('conv-group-1')
    check('旧“允许”渠道迁移后仍允许生成', !isSkipped(allowedResult), JSON.stringify(allowedResult))

    const disabled = createHarness({
      'memory.enabled': true,
      'memory.autoSummarize': true,
      'memory.groupSummaryEnabled': true,
      'memory.groupSummaryDisabled': { 'ch-group-1': true },
    })
    check(
      '旧 true（曾禁用）迁移后不生成',
      disabled.configValues.get('memory.groupChannelSummaryEnabled')?.['ch-group-1'] === false,
      JSON.stringify(disabled.configValues.get('memory.groupChannelSummaryEnabled')),
    )
    const disabledResult = await disabled.service.ingestConversation('conv-group-1')
    check('旧“禁用”渠道迁移后仍不生成', isSkipped(disabledResult), JSON.stringify(disabledResult))
    check('旧字段已清空', JSON.stringify(disabled.configValues.get('memory.groupSummaryDisabled')) === '{}')
  }

  summarize()
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
