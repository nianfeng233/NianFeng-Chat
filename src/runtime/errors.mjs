/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * 念风运行时错误类型
 */
export class ConflictError extends Error {
  constructor(message, { service, owner, existOwner } = {}) {
    super(message)
    this.name = 'ConflictError'
    this.service = service
    this.owner = owner
    this.existOwner = existOwner
  }
}

export class PluginError extends Error {
  constructor(message, { id, phase } = {}) {
    super(message)
    this.name = 'PluginError'
    this.id = id
    this.phase = phase
  }
}
