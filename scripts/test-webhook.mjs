/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * Webhook 低延迟订阅回归：
 *   - 外部 bridge 可以注册免念风访问令牌的 `/api/webhooks/*` 公共路由；
 *   - GitHub HMAC-SHA256 签名校验通过后，事件进入与轮询相同的去重 / 通知链路；
 *   - 签名错误直接拒绝；
 *   - 收到回调后，轮询自动降频为兜底模式。
 */
import { cp, mkdtemp, rm } from 'node:fs/promises'
import { createHmac } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startBackend } from '../server/index.mjs'

const checks = []
const check = (name, ok, detail = '') => {
  checks.push({ name, ok: !!ok, detail })
  console.log(`${ok ? '  ✔' : '  ✗'} ${name}${!ok && detail ? `  → ${detail}` : ''}`)
}

const accessToken = 'nf-wh-test'
const dataDir = await mkdtemp(join(tmpdir(), 'nianfeng-webhook-'))
const pluginsDir = join(dataDir, 'plugins')
await cp(new URL('../extensions/github-hub', import.meta.url), join(pluginsDir, 'github-hub'), { recursive: true })
process.env.NIANFENG_PLUGINS_DIR = pluginsDir
const backend = await startBackend({ port: 0, host: '127.0.0.1', dataDir, accessToken })
const base = backend.url
const api = (path, options = {}) =>
  fetch(base + path, {
    ...options,
    headers: { 'X-NianFeng-Token': accessToken, 'Content-Type': 'application/json', ...(options.headers || {}) },
  })

try {
  let response = await api('/api/github-hub/status')
  let status = await response.json()
  check('外部 bridge 加载成功', response.status === 200 && status.ok !== false, `${response.status}`)
  check('状态包含公开 Webhook 能力', status.webhook?.supported === true, JSON.stringify(status.webhook || {}))

  response = await api('/api/github-hub/subscriptions/test-channel', {
    method: 'PUT',
    body: JSON.stringify({ name: 'Webhook 测试渠道', type: 'napcat', enabled: true, repos: [{ repo: 'a/b' }] }),
  })
  check('测试订阅保存成功', response.status === 200, String(response.status))

  response = await api('/api/github-hub/config', {
    method: 'PUT',
    body: JSON.stringify({
      webhook: { enabled: true, publicBaseUrl: 'https://example.com', fallbackPollMs: 900000, healthyWindowMs: 900000 },
    }),
  })
  check('Webhook 配置保存成功', response.status === 200, String(response.status))

  status = await (await api('/api/github-hub/status')).json()
  const endpoint = String(status.webhook?.endpoint || '')
  const secret = String(status.webhook?.secret || '')
  check('回调 URL 与 Secret 已生成', endpoint.startsWith('/api/webhooks/github-hub/') && secret.length >= 16, JSON.stringify({ endpoint, secretLength: secret.length }))
  check('回调基地址已保存', status.webhook?.publicBaseUrl === 'https://example.com', String(status.webhook?.publicBaseUrl))

  const payload = {
    action: 'opened',
    repository: { full_name: 'a/b', url: 'https://api.github.com/repos/a/b' },
    sender: { login: 'alice', avatar_url: '' },
    issue: {
      id: 9,
      number: 3,
      title: 'webhook low latency test',
      body: 'hello',
      html_url: 'https://github.com/a/b/issues/3',
      state: 'open',
      updated_at: new Date().toISOString(),
    },
  }
  const bodyText = JSON.stringify(payload)
  const signature = `sha256=${createHmac('sha256', secret).update(bodyText).digest('hex')}`
  const webhookResponse = await fetch(base + endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-GitHub-Event': 'issues',
      'X-GitHub-Delivery': 'delivery-test-1',
      'X-Hub-Signature-256': signature,
    },
    body: bodyText,
  })
  const webhookResult = await webhookResponse.json().catch(() => ({}))
  check(
    'Webhook 无需念风令牌即可抵达后端并验签通过',
    webhookResponse.status === 202 && webhookResult.accepted === 1,
    `${webhookResponse.status} ${JSON.stringify(webhookResult)}`,
  )

  status = await (await api('/api/github-hub/status')).json()
  check('成功回调计入运行状态', Number(status.webhook?.deliveries) === 1, JSON.stringify(status.webhook || {}))
  check('收到回调后轮询降频为兜底间隔', status.effectivePollIntervalMs === 900000, String(status.effectivePollIntervalMs))

  const events = await (await api('/api/github-hub/events')).json()
  check(
    'Webhook 事件进入最近动态列表',
    (events.events || []).some(item => item.title === 'webhook low latency test'),
    JSON.stringify(events.events?.[0] || {}),
  )

  const duplicateResponse = await fetch(base + endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-GitHub-Event': 'issues',
      'X-GitHub-Delivery': 'delivery-test-1-redelivery',
      'X-Hub-Signature-256': signature,
    },
    body: bodyText,
  })
  const duplicateResult = await duplicateResponse.json().catch(() => ({}))
  check('同内容重复投递不会重复产生事件', duplicateResponse.status === 202 && duplicateResult.accepted === 0, JSON.stringify(duplicateResult))

  const badResponse = await fetch(base + endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-GitHub-Event': 'issues',
      'X-GitHub-Delivery': 'delivery-test-2',
      'X-Hub-Signature-256': 'sha256=deadbeef',
    },
    body: bodyText,
  })
  check('错误签名被拒绝', badResponse.status === 401, String(badResponse.status))
} finally {
  await backend.close().catch(() => {})
  delete process.env.NIANFENG_PLUGINS_DIR
  await rm(dataDir, { recursive: true, force: true }).catch(() => {})
}

const failed = checks.filter(item => !item.ok)
console.log(`\n结果：${checks.length - failed.length}/${checks.length} 项通过`)
if (failed.length) process.exit(1)
process.exit(0)
