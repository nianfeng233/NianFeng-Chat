/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * scripts/test-*.mjs 公共小工具。
 *
 * 不引入测试框架：目标是让新测试用最少样板代码获得一致的
 * “✔ / ✗ + 汇总 + 退出码”输出，也方便后续逐步把旧脚本迁移过来。
 */
export function createChecker() {
  const results = []
  let failed = 0
  const check = (name, ok, detail = '') => {
    results.push({ name, ok })
    if (!ok) failed++
    console.log(`${ok ? '  ✔' : '  ✗'} ${name}${ok ? '' : '  → ' + detail}`)
  }
  const summarize = () => {
    console.log(`\n结果：${results.length - failed}/${results.length} 项通过`)
    if (failed) process.exitCode = 1
    return failed
  }
  return { check, summarize, results, get failed() { return failed } }
}

export const sleep = ms => new Promise(resolve => setTimeout(resolve, Math.max(0, Number(ms) || 0)))

export async function waitFor(fn, { timeout = 8000, interval = 25 } = {}) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    const value = await fn()
    if (value) return value
    await sleep(interval)
  }
  return null
}

/** JSON fetch 小封装；body 传对象时自动 stringify。 */
export const jsonApi = (base, path, options = {}) =>
  fetch(`${base}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    body: options.body && typeof options.body !== 'string' ? JSON.stringify(options.body) : options.body,
  })
