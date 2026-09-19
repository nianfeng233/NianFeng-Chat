/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * 备用模型列表回归测试（不需要网络 / 浏览器）：
 *   - 按 model.failoverKeys 的顺序逐个尝试，成功即停；
 *   - 旧版单值 model.failoverKey 仍可兼容；
 *   - 列表循环轮数、缺失模型跳过；
 *   - 已经输出内容后失败不切换，避免重复气泡；
 *   - model:fallback 事件带足顺序信息供日志页展示。
 *
 * 用法：npm run test:failover
 */
import * as modelServicePlugin from '../plugins/domain/model-service/index.mjs'
import { createChecker } from './test-utils.mjs'

const { check, summarize } = createChecker()

function createHarness({ streams, configValues = {}, registryKeys = [] } = {}) {
  const values = new Map(Object.entries(configValues))
  const calls = []
  const events = []
  const config = {
    get: (key, fallback) => (values.has(key) ? values.get(key) : fallback),
    set: (key, value) => values.set(key, value),
  }
  const eventBus = { emit: (name, payload) => events.push({ name, payload }) }
  const registry = {
    activeKey: () => 'p/primary',
    list: () => registryKeys.map(key => ({ key })),
    resolve: key => {
      const stream = streams[key]
      if (!stream) return null
      return { key, provider: 'p', model: { id: String(key).split('/').slice(1).join('/') }, providerImpl: { stream } }
    },
  }
  const valuesByName = { config, 'event-bus': eventBus, 'model-registry': registry }
  let service = null
  const ctx = {
    inject: name => valuesByName[name],
    provide: (name, value) => {
      if (name === 'model-service') service = value
    },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  }
  modelServicePlugin.apply(ctx)
  return {
    service,
    calls,
    events,
    values,
    run(options = {}, callbacks = {}) {
      return new Promise(resolve => {
        const collected = []
        service.stream([{ role: 'user', content: 'hi' }], options, {
          onStart: info => {
            calls.push(info.key)
            callbacks.onStart?.(info)
          },
          onChunk: delta => {
            collected.push(delta)
            callbacks.onChunk?.(delta)
          },
          onDone: summary => resolve({ done: true, text: collected.join(''), summary }),
          onError: error => resolve({ done: false, error: String(error?.message || error) }),
          ...callbacks,
        })
      })
    },
  }
}

async function main() {
  console.log('\n① 列表按顺序逐个降级，成功后停止')
  {
    const harness = createHarness({
      streams: {
        'p/primary': ({ onError }) => queueMicrotask(() => onError(new Error('primary down'))),
        'p/backup-a': ({ onError }) => queueMicrotask(() => onError(new Error('backup-a down'))),
        'p/backup-b': ({ onChunk, onDone }) => {
          onChunk('backup-b-ok')
          onDone({})
        },
      },
      registryKeys: ['p/primary', 'p/backup-a', 'p/backup-b'],
      configValues: {
        'model.failoverEnabled': true,
        'model.failoverKeys': ['p/backup-a', 'p/backup-b'],
        'model.failoverPasses': 1,
      },
    })
    const result = await harness.run({ model: 'p/primary' })
    check('按列表顺序尝试直到成功', JSON.stringify(harness.calls) === JSON.stringify(['p/primary', 'p/backup-a', 'p/backup-b']), JSON.stringify(harness.calls))
    check('最终使用成功模型的内容', result.done && result.text === 'backup-b-ok', JSON.stringify(result))
    const fallbacks = harness.events.filter(item => item.name === 'model:fallback')
    check(
      'model:fallback 事件包含 from / to / 顺序',
      fallbacks.length === 2 &&
        fallbacks[0].payload.from === 'p/primary' &&
        fallbacks[0].payload.to === 'p/backup-a' &&
        fallbacks[1].payload.from === 'p/backup-a' &&
        fallbacks[1].payload.to === 'p/backup-b' &&
        fallbacks[1].payload.total === 2,
      JSON.stringify(fallbacks.map(item => item.payload)),
    )
  }

  console.log('\n② 拖拽调整后的顺序就是尝试顺序')
  {
    const harness = createHarness({
      streams: {
        'p/primary': ({ onError }) => queueMicrotask(() => onError(new Error('primary down'))),
        'p/backup-a': ({ onError }) => queueMicrotask(() => onError(new Error('backup-a down'))),
        'p/backup-b': ({ onChunk, onDone }) => {
          onChunk('b')
          onDone({})
        },
      },
      registryKeys: ['p/primary', 'p/backup-a', 'p/backup-b'],
      configValues: {
        'model.failoverEnabled': true,
        'model.failoverKeys': ['p/backup-b', 'p/backup-a'],
        'model.failoverPasses': 1,
      },
    })
    const result = await harness.run({ model: 'p/primary' })
    check('先尝试拖到前面的模型', JSON.stringify(harness.calls) === JSON.stringify(['p/primary', 'p/backup-b']), JSON.stringify(harness.calls))
    check('成功后不再尝试后面的模型', result.done && result.text === 'b', JSON.stringify(result))
  }

  console.log('\n③ 旧版单值 failoverKey 兼容')
  {
    const harness = createHarness({
      streams: {
        'p/primary': ({ onError }) => queueMicrotask(() => onError(new Error('primary down'))),
        'p/backup-a': ({ onChunk, onDone }) => {
          onChunk('legacy-ok')
          onDone({})
        },
      },
      registryKeys: ['p/primary', 'p/backup-a'],
      configValues: {
        'model.failoverEnabled': true,
        'model.failoverKey': 'p/backup-a',
        'model.failoverPasses': 1,
      },
    })
    const result = await harness.run({ model: 'p/primary' })
    check('旧字段仍可驱动降级', result.done && JSON.stringify(harness.calls) === JSON.stringify(['p/primary', 'p/backup-a']), JSON.stringify(harness.calls))
  }

  console.log('\n④ 缺失模型自动跳过')
  {
    const harness = createHarness({
      streams: {
        'p/primary': ({ onError }) => queueMicrotask(() => onError(new Error('primary down'))),
        'p/backup-b': ({ onChunk, onDone }) => {
          onChunk('skip-ok')
          onDone({})
        },
      },
      registryKeys: ['p/primary', 'p/backup-b'],
      configValues: {
        'model.failoverEnabled': true,
        'model.failoverKeys': ['p/missing', 'p/backup-b'],
        'model.failoverPasses': 1,
      },
    })
    const result = await harness.run({ model: 'p/primary' })
    check('列表中不可用的模型会被跳过', result.done && JSON.stringify(harness.calls) === JSON.stringify(['p/primary', 'p/backup-b']), JSON.stringify(harness.calls))
    const skipFallbacks = harness.events.filter(item => item.name === 'model:fallback')
    check(
      '跳过不可用模型时 fallback 事件的起点正确',
      skipFallbacks.length === 2 && skipFallbacks[0].payload.to === 'p/missing' && skipFallbacks[1].payload.from === 'p/missing',
      JSON.stringify(skipFallbacks.map(item => item.payload)),
    )
  }

  console.log('\n⑤ 已经输出内容后失败不降级')
  {
    let primaryCalls = 0
    const harness = createHarness({
      streams: {
        'p/primary': ({ onChunk, onError }) => {
          primaryCalls += 1
          onChunk('半截回复')
          onError(new Error('stream broke'))
        },
        'p/backup-a': ({ onChunk, onDone }) => {
          onChunk('不应该出现')
          onDone({})
        },
      },
      registryKeys: ['p/primary', 'p/backup-a'],
      configValues: {
        'model.failoverEnabled': true,
        'model.failoverKeys': ['p/backup-a'],
        'model.failoverPasses': 1,
      },
    })
    const result = await harness.run({ model: 'p/primary' })
    check('输出内容后不再切换模型', primaryCalls === 1 && !result.done && harness.calls.length === 1, JSON.stringify({ calls: harness.calls, result }))
  }

  console.log('\n⑥ 列表循环轮数生效')
  {
    const harness = createHarness({
      streams: {
        'p/primary': ({ onError }) => queueMicrotask(() => onError(new Error('primary down'))),
        'p/backup-a': ({ onError }) => queueMicrotask(() => onError(new Error('backup-a down'))),
      },
      registryKeys: ['p/primary', 'p/backup-a'],
      configValues: {
        'model.failoverEnabled': true,
        'model.failoverKeys': ['p/backup-a'],
        'model.failoverPasses': 2,
      },
    })
    const result = await harness.run({ model: 'p/primary' })
    check('列表失败后按设置循环重试', JSON.stringify(harness.calls) === JSON.stringify(['p/primary', 'p/backup-a', 'p/backup-a']), JSON.stringify(harness.calls))
    check('全部失败后回调 onError', !result.done && /backup-a down/.test(result.error), JSON.stringify(result))
  }

  console.log('\n⑦ 未启用开关时不降级')
  {
    const harness = createHarness({
      streams: {
        'p/primary': ({ onError }) => queueMicrotask(() => onError(new Error('primary down'))),
        'p/backup-a': ({ onChunk, onDone }) => {
          onChunk('不应该出现')
          onDone({})
        },
      },
      registryKeys: ['p/primary', 'p/backup-a'],
      configValues: {
        'model.failoverEnabled': false,
        'model.failoverKeys': ['p/backup-a'],
        'model.failoverPasses': 1,
      },
    })
    const result = await harness.run({ model: 'p/primary' })
    check('关闭开关时只调用当前模型', JSON.stringify(harness.calls) === JSON.stringify(['p/primary']) && !result.done, JSON.stringify({ calls: harness.calls }))
  }

  console.log('\n⑧ 旧版 failoverRetries 兼容读取')
  {
    const harness = createHarness({
      streams: {
        'p/primary': ({ onError }) => queueMicrotask(() => onError(new Error('primary down'))),
        'p/backup-a': ({ onError }) => queueMicrotask(() => onError(new Error('backup-a down'))),
      },
      registryKeys: ['p/primary', 'p/backup-a'],
      configValues: {
        'model.failoverEnabled': true,
        'model.failoverKeys': ['p/backup-a'],
        'model.failoverRetries': 2,
      },
    })
    const result = await harness.run({ model: 'p/primary' })
    check(
      '未迁移的新字段时仍读旧 failoverRetries',
      JSON.stringify(harness.calls) === JSON.stringify(['p/primary', 'p/backup-a', 'p/backup-a']) && !result.done,
      JSON.stringify(harness.calls),
    )
  }


  console.log('\n⑨ 角色级指定备用模型（优先于全局）')
  {
    const harness = createHarness({
      streams: {
        'p/primary': ({ onError }) => queueMicrotask(() => onError(new Error('primary down'))),
        'p/backup-a': ({ onChunk, onDone }) => {
          onChunk('role-a-ok')
          onDone({})
        },
        'p/backup-b': ({ onChunk, onDone }) => {
          onChunk('global-b')
          onDone({})
        },
      },
      registryKeys: ['p/primary', 'p/backup-a', 'p/backup-b'],
      configValues: {
        'model.failoverEnabled': false,
        'model.failoverKeys': ['p/backup-b'],
        'model.failoverPasses': 1,
      },
    })
    const result = await harness.run({ model: 'p/primary', backupModel: 'p/backup-a' })
    check(
      '角色指定备用模型时，即使全局关闭也按角色配置降级',
      result.done && JSON.stringify(harness.calls) === JSON.stringify(['p/primary', 'p/backup-a']) && result.text === 'role-a-ok',
      JSON.stringify({ calls: harness.calls, result }),
    )
  }

  console.log('\n⑩ 角色级不启用备用模型（优先于全局）')
  {
    const harness = createHarness({
      streams: {
        'p/primary': ({ onError }) => queueMicrotask(() => onError(new Error('primary down'))),
        'p/backup-a': ({ onChunk, onDone }) => {
          onChunk('不应该出现')
          onDone({})
        },
      },
      registryKeys: ['p/primary', 'p/backup-a'],
      configValues: {
        'model.failoverEnabled': true,
        'model.failoverKeys': ['p/backup-a'],
        'model.failoverPasses': 1,
      },
    })
    const result = await harness.run({ model: 'p/primary', backupModel: 'off' })
    check(
      '角色选择“不启用”时，即使全局开启也不降级',
      JSON.stringify(harness.calls) === JSON.stringify(['p/primary']) && !result.done,
      JSON.stringify({ calls: harness.calls, result }),
    )
  }

  console.log('\n⑪ 角色级跟随全局')
  {
    const harness = createHarness({
      streams: {
        'p/primary': ({ onError }) => queueMicrotask(() => onError(new Error('primary down'))),
        'p/backup-a': ({ onChunk, onDone }) => {
          onChunk('global-ok')
          onDone({})
        },
      },
      registryKeys: ['p/primary', 'p/backup-a'],
      configValues: {
        'model.failoverEnabled': true,
        'model.failoverKeys': ['p/backup-a'],
        'model.failoverPasses': 1,
      },
    })
    const result = await harness.run({ model: 'p/primary', backupModel: 'global' })
    check(
      '角色选择“跟随全局”时使用全局备用列表',
      result.done && JSON.stringify(harness.calls) === JSON.stringify(['p/primary', 'p/backup-a']) && result.text === 'global-ok',
      JSON.stringify({ calls: harness.calls, result }),
    )
  }

  summarize()
}

main().catch(err => {
  console.error('备用模型测试失败：', err)
  process.exit(1)
})
