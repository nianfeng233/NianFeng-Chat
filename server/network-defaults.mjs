/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * 后端 Node 网络兼容默认值。
 *
 * Windows 上经常出现“浏览器能打开，但 exe 内的 Node fetch 报 fetch failed”的情况：
 *   - DNS 默认 verbatim 会优先返回 IPv6，部分网络只有 IPv4 出口；
 *   - 一些代理 / 双栈环境没有可靠的 IPv6 回退。
 * Node 的原生 fetch 不一定会像浏览器一样自动 Happy Eyeballs，因此统一在这里把
 * DNS 解析改为 IPv4 优先，并确保自动地址族回退开启，避免桌面版 / 网页版表现不一致。
 */
import { setDefaultResultOrder } from 'node:dns'
import { getDefaultAutoSelectFamily, setDefaultAutoSelectFamily } from 'node:net'

let applied = false

export function applyNetworkDefaults() {
  if (applied) return
  applied = true
  try {
    setDefaultResultOrder('ipv4first')
  } catch (_) {
    /* 旧版 Node 不支持时忽略，不影响启动 */
  }
  try {
    if (typeof getDefaultAutoSelectFamily === 'function' && typeof setDefaultAutoSelectFamily === 'function' && getDefaultAutoSelectFamily() !== true) {
      setDefaultAutoSelectFamily(true)
    }
  } catch (_) {
    /* ignore */
  }
}
