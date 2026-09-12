/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * 后端 · hub
 * 面向 WebUI 的实时事件总线（Server-Sent Events）。
 * 渠道入站消息、模型状态变化等都会广播到所有已连接页面。
 */
export const name = 'hub'
export const inject = []

export function apply(ctx) {
  const clients = new Set()

  const service = {
    add(res) {
      clients.add(res)
      res.write(`event: hello\ndata: ${JSON.stringify({ time: Date.now(), clients: clients.size })}\n\n`)
      ctx.logger.debug(`SSE 客户端接入，当前 ${clients.size} 个`)
    },
    remove(res) {
      clients.delete(res)
    },
    count: () => clients.size,
    broadcast(event, data) {
      const payload = `event: ${event}\ndata: ${JSON.stringify(data ?? null)}\n\n`
      for (const client of [...clients]) {
        try {
          client.write(payload)
        } catch (_) {
          clients.delete(client)
        }
      }
    },
    snapshot: () => ({ clients: clients.size, time: Date.now() }),
  }

  const timer = setInterval(() => {
    for (const client of [...clients]) {
      try {
        client.write(`: ping ${Date.now()}\n\n`)
      } catch (_) {
        clients.delete(client)
      }
    }
  }, 25000)

  ctx.provide('hub', service)
  ctx.effect(
    () => () => {
      clearInterval(timer)
      for (const client of clients) {
        try {
          client.end()
        } catch (_) {
          /* ignore */
        }
      }
      clients.clear()
    },
  )
  ctx.logger.info('实时事件通道（SSE）就绪')
}
