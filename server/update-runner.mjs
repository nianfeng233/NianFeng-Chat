/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * 本体更新 / 重启助手启动器。
 *
 * 把 server/update-helper.mjs 复制到系统临时目录后 detached 启动；这样即使
 * 后续整个 app 目录被 release 包替换，助手也能继续运行。
 */
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HELPER_FILE = fileURLToPath(new URL('./update-helper.mjs', import.meta.url))

export async function spawnUpdateHelper(plan = {}) {
  const workDir = await mkdtemp(join(tmpdir(), 'nianfeng-update-'))
  const source = await readFile(HELPER_FILE, 'utf8')
  const script = join(workDir, 'update-helper.mjs')
  const planFile = join(workDir, 'plan.json')
  const nextPlan = {
    ...plan,
    workDir,
    planFile,
    logFile: join(workDir, 'update.log'),
  }
  await writeFile(script, source, 'utf8')
  await writeFile(planFile, JSON.stringify(nextPlan, null, 2), 'utf8')

  const child = spawn(process.execPath, [script, planFile], {
    cwd: workDir,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, NIANFENG_UPDATE_HELPER: '1' },
  })

  // 等 spawn 成功事件再返回：失败时抛给调用方，绝不能先关旧项目再发现助手没起来。
  await new Promise((resolve, reject) => {
    const onSpawn = () => {
      child.off('error', onError)
      resolve()
    }
    const onError = err => {
      child.off('spawn', onSpawn)
      reject(err)
    }
    child.once('spawn', onSpawn)
    child.once('error', onError)
  })
  child.on('error', () => {})
  child.unref()
  return { workDir, script, planFile, pid: child.pid, plan: nextPlan }
}
