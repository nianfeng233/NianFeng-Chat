/**
 * 风语运行时错误类型
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
