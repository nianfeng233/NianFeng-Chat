/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 *
 * 本体更新方向回归：
 *   - 同号稳定版与预览版不能按 semver 被判成降级（例如 2.2.1 ↔ 2.2.1-preview.2）；
 *   - 同号预览之间仍按 preview.N 排序；
 *   - 不同 X.Y.Z 仍按标准 semver 判断升级 / 降级。
 * 不联网：
 *   node scripts/test-update-policy.mjs
 */
import { updateDirection } from '../src/runtime/update-policy.mjs'

let failed = 0
let total = 0
const check = (name, actual, expected) => {
  total += 1
  const ok = actual === expected
  if (!ok) failed += 1
  console.log(`${ok ? '  ✔' : '  ✗'} ${name}${ok ? '' : `  → ${actual}（期望 ${expected}）`}`)
}

console.log('\n① 同号稳定版 ↔ 预览版：视为可更新构建')
check('v2.2.1 → v2.2.1-preview.2', updateDirection('2.2.1-preview.2', '2.2.1'), 'update')
check('v2.2.1 → v2.2.1-preview.1', updateDirection('2.2.1-preview.1', '2.2.1'), 'update')
check('v2.2.1-preview.2 → v2.2.1（转正）', updateDirection('2.2.1', '2.2.1-preview.2'), 'update')

console.log('\n② 同号预览之间：按 preview.N 排序')
check('preview.1 → preview.2', updateDirection('2.2.1-preview.2', '2.2.1-preview.1'), 'update')
check('preview.2 → preview.1', updateDirection('2.2.1-preview.1', '2.2.1-preview.2'), 'downgrade')
check('preview.10 → preview.2', updateDirection('2.2.1-preview.10', '2.2.1-preview.2'), 'update')

console.log('\n③ 不同 X.Y.Z：继续走标准 semver')
check('v2.2.0 → v2.2.1', updateDirection('2.2.1', '2.2.0'), 'update')
check('v2.2.1 → v2.2.0', updateDirection('2.2.0', '2.2.1'), 'downgrade')
check('v2.2.1 → v2.2.2-preview.1', updateDirection('2.2.2-preview.1', '2.2.1'), 'update')
check('v2.2.2 → v2.2.1-preview.2', updateDirection('2.2.1-preview.2', '2.2.2'), 'downgrade')
check('同版本', updateDirection('2.2.1-preview.2', '2.2.1-preview.2'), 'current')
check('未知版本', updateDirection('', '2.2.1'), 'unknown')

console.log(`\n${failed ? '✘' : '✔'} 更新方向测试：${total - failed}/${total} 通过`)
process.exit(failed ? 1 : 0)
