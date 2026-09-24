/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * 本体更新的“升级 / 降级”判定。
 *
 * 不能直接拿 semver 给用户展示升级 / 降级，因为同一版的稳定版和预览版是两条构建线：
 *   - v2.2.1 是稳定版，v2.2.1-preview.2 是后续补丁预览；
 *   - 按 semver 比较，2.2.1-preview.2 < 2.2.1，会在更新页被误报成“降级”；
 *   - 但用户选择的预期是安装这个预览构建，属于更新而不是倒退。
 *
 * 规则：
 *   1. 主版本.次版本.补丁完全相同：
 *      - 同号预览之间（preview.1 / preview.2）按序号判断；
 *      - 稳定版与预览版之间视为可更新构建（例如 2.2.1 → 2.2.1-preview.2，
 *        或预览验证通过后 2.2.1-preview.2 → 2.2.1 正式版）。
 *   2. 主版本.次版本.补丁不同：仍按 semver，高版本为更新，低版本为降级。
 */
import { compareVersions } from './semver.mjs'

const normalize = value => String(value || '').trim().replace(/^[vV]/, '')
const baseVersion = value => normalize(value).split('-')[0]
const hasPrerelease = value => normalize(value).includes('-')

/**
 * @returns {'current'|'update'|'downgrade'|'unknown'}
 */
export function updateDirection(targetVersion, currentVersion) {
  const target = normalize(targetVersion)
  const current = normalize(currentVersion)
  if (!target || !current) return 'unknown'
  const compared = compareVersions(target, current)
  if (!Number.isFinite(compared)) return 'unknown'
  if (compared === 0) return 'current'

  const sameBase = baseVersion(target) === baseVersion(current)
  if (sameBase) {
    const targetPre = hasPrerelease(target)
    const currentPre = hasPrerelease(current)
    // 同号预览之间继续按 preview.N 排序：preview.2 > preview.1。
    if (targetPre && currentPre) return compared > 0 ? 'update' : 'downgrade'
    // 同号稳定版 ↔ 预览版属于构建线切换，不按 semver 预发布顺序判降级。
    if (targetPre || currentPre) return 'update'
  }

  return compared > 0 ? 'update' : 'downgrade'
}
