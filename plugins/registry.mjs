/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 *
 * 由 scripts/sync-plugins.mjs 自动生成，请勿手改。
 * 重新生成：npm run sync-plugins
 *
 * 共 98 个插件，按目录名排序；真正的加载顺序由
 * plugin-loader 依据 depends / inject 做拓扑排序决定。
 */
export const plugins = [
  {
    "id": "napcat",
    "version": "1.0.1",
    "displayName": "NapCat",
    "description": "渠道插件 · NapCatQQ / OneBot 11：私聊、群聊、隐私、连接复用与群聊规则。",
    "author": "念风插件",
    "core": false,
    "enabled": true,
    "icon": "🐱",
    "unavailable": false,
    "unavailableReason": "",
    "depends": {
      "channel-base": "^1.0.0",
      "channel-detail-host": "^3.0.0",
      "channel-list": "^1.0.0",
      "channel-registry": ">=1.0.0",
      "config": ">=1.1.0",
      "event-bus": "*",
      "session-service": "^2.0.0",
      "toast-host": ">=1.0.0"
    },
    "optionalDepends": {
      "backend-client": ">=1.0.0",
      "chat-store": ">=1.0.0",
      "message-service": ">=1.0.0",
      "plugin-manager": ">=1.0.0"
    },
    "inject": [
      "channel-base",
      "channel-registry",
      "session-service",
      "event-bus",
      "toast",
      "config",
      "api?",
      "message-service?",
      "chat-store?",
      "plugin-manager?"
    ],
    "provides": [
      {
        "name": "napcat-channel",
        "type": "singleton"
      }
    ],
    "permissions": [
      "network"
    ],
    "slots": [],
    "path": "./plugins/channels/napcat/index.mjs",
    "dir": "plugins/channels/napcat"
  },
  {
    "id": "qqbot",
    "version": "1.5.0",
    "displayName": "QQ官方机器人",
    "description": "渠道插件 · QQ 官方机器人扫码/凭据接入、本地沙箱免白名单、私聊与群聊绑定、群规则、多机器人联动、SILK 语音与被动回复。",
    "author": "念风插件",
    "core": false,
    "enabled": true,
    "icon": "🐧",
    "unavailable": false,
    "unavailableReason": "",
    "depends": {
      "channel-base": ">=1.0.0",
      "channel-detail-host": "^3.0.0",
      "channel-list": ">=1.0.0",
      "channel-registry": ">=1.0.0",
      "config": ">=1.1.0",
      "event-bus": "*",
      "session-service": "^2.0.0",
      "toast-host": ">=1.0.0"
    },
    "optionalDepends": {
      "backend-client": ">=1.0.0",
      "chat-store": ">=1.0.0",
      "message-service": ">=1.0.0",
      "plugin-manager": ">=1.0.0"
    },
    "inject": [
      "channel-base",
      "channel-registry",
      "session-service",
      "event-bus",
      "toast",
      "config",
      "api?",
      "message-service?",
      "chat-store?",
      "plugin-manager?"
    ],
    "provides": [
      {
        "name": "qqbot-channel",
        "type": "singleton"
      }
    ],
    "permissions": [
      "network"
    ],
    "slots": [],
    "path": "./plugins/channels/qqbot/index.mjs",
    "dir": "plugins/channels/qqbot"
  },
  {
    "id": "wechat-clawbot",
    "version": "1.0.1",
    "displayName": "微信clawbot",
    "description": "渠道插件 · 微信 Clawbot 扫码接入、消息收发与 typing 状态。",
    "author": "念风插件",
    "core": false,
    "enabled": true,
    "icon": "💬",
    "unavailable": false,
    "unavailableReason": "",
    "depends": {
      "channel-base": "^1.0.0",
      "channel-detail-host": "^3.0.0",
      "channel-list": "^1.0.0",
      "channel-registry": ">=1.0.0",
      "config": ">=1.1.0",
      "event-bus": "*",
      "session-service": "^2.0.0",
      "toast-host": ">=1.0.0"
    },
    "optionalDepends": {
      "backend-client": ">=1.0.0",
      "chat-store": ">=1.0.0",
      "message-service": ">=1.0.0",
      "plugin-manager": ">=1.0.0"
    },
    "inject": [
      "channel-base",
      "channel-registry",
      "session-service",
      "event-bus",
      "toast",
      "config",
      "api?",
      "message-service?",
      "chat-store?",
      "plugin-manager?"
    ],
    "provides": [],
    "permissions": [
      "network"
    ],
    "slots": [],
    "path": "./plugins/channels/wechat-clawbot/index.mjs",
    "dir": "plugins/channels/wechat-clawbot"
  },
  {
    "id": "channel-registry",
    "version": "1.0.0",
    "displayName": "渠道注册中心",
    "description": "业务服务 · 渠道类型注册与渠道实例管理。",
    "author": "念风内核",
    "core": true,
    "enabled": true,
    "icon": "📡",
    "unavailable": false,
    "unavailableReason": "",
    "depends": {
      "config": ">=1.1.0",
      "event-bus": "*",
      "storage": "^1.0.0"
    },
    "optionalDepends": {},
    "inject": [
      "storage",
      "event-bus",
      "config"
    ],
    "provides": [
      {
        "name": "channel-registry",
        "type": "singleton"
      }
    ],
    "permissions": [],
    "slots": [],
    "path": "./plugins/domain/channel-registry/index.mjs",
    "dir": "plugins/domain/channel-registry"
  },
  {
    "id": "chat-permissions",
    "version": "1.0.0",
    "displayName": "聊天权限",
    "description": "业务服务 · 渠道读写权限表、跨渠道校验、敏感确认与审计。",
    "author": "念风内核",
    "core": true,
    "enabled": true,
    "icon": "🛡️",
    "unavailable": false,
    "unavailableReason": "",
    "depends": {
      "chat-store": "^1.0.0",
      "config": "^1.0.0",
      "event-bus": "^1.0.0",
      "session-service": ">=2.0.0",
      "storage": "*"
    },
    "optionalDepends": {
      "channel-registry": ">=1.0.0",
      "toast-host": ">=1.0.0",
      "user-identity": ">=1.0.0"
    },
    "inject": [
      "chat-store",
      "session-service",
      "config",
      "event-bus",
      "storage",
      "toast?",
      "user-identity?",
      "channel-registry?"
    ],
    "provides": [
      {
        "name": "chat-permissions",
        "type": "singleton"
      }
    ],
    "permissions": [],
    "slots": [],
    "path": "./plugins/domain/chat-permissions/index.mjs",
    "dir": "plugins/domain/chat-permissions"
  },
  {
    "id": "chat-queue",
    "version": "1.0.0",
    "displayName": "聊天串行队列",
    "description": "业务服务 · 每个角色一条 FIFO 队列，保证同一角色同一时刻只跑一轮。",
    "author": "念风内核",
    "core": true,
    "enabled": true,
    "icon": "🚦",
    "unavailable": false,
    "unavailableReason": "",
    "depends": {
      "event-bus": "^1.0.0"
    },
    "optionalDepends": {},
    "inject": [
      "event-bus"
    ],
    "provides": [
      {
        "name": "chat-queue",
        "type": "singleton"
      }
    ],
    "permissions": [],
    "slots": [],
    "path": "./plugins/domain/chat-queue/index.mjs",
    "dir": "plugins/domain/chat-queue"
  },
  {
    "id": "chat-store",
    "version": "1.0.0",
    "displayName": "聊天记录库",
    "description": "业务服务 · 渠道消息元数据、序号、工作记忆与 Nova 渠道识别。",
    "author": "念风内核",
    "core": true,
    "enabled": true,
    "icon": "🗂️",
    "unavailable": false,
    "unavailableReason": "",
    "depends": {
      "config": ">=1.1.0",
      "event-bus": "*",
      "message-service": "^1.0.0",
      "session-service": "^2.0.0",
      "storage": "*"
    },
    "optionalDepends": {
      "user-identity": ">=1.0.0"
    },
    "inject": [
      "session-service",
      "message-service",
      "storage",
      "event-bus",
      "config",
      "user-identity?"
    ],
    "provides": [
      {
        "name": "chat-store",
        "type": "singleton"
      }
    ],
    "permissions": [],
    "slots": [],
    "path": "./plugins/domain/chat-store/index.mjs",
    "dir": "plugins/domain/chat-store"
  },
  {
    "id": "document-service",
    "version": "1.0.0",
    "displayName": "资料库",
    "description": "业务服务 · 长资料原文存储与分段读取，聊天记录只存引用。",
    "author": "念风内核",
    "core": true,
    "enabled": true,
    "icon": "📚",
    "unavailable": false,
    "unavailableReason": "",
    "depends": {
      "config": ">=1.1.0",
      "event-bus": "*",
      "storage": "^1.0.0"
    },
    "optionalDepends": {},
    "inject": [
      "storage",
      "event-bus",
      "config"
    ],
    "provides": [
      {
        "name": "document-service",
        "type": "singleton"
      }
    ],
    "permissions": [],
    "slots": [],
    "path": "./plugins/domain/document-service/index.mjs",
    "dir": "plugins/domain/document-service"
  },
  {
    "id": "export-service",
    "version": "2.0.0",
    "displayName": "导出服务",
    "description": "业务服务 · 会话导出（Markdown / JSON / TXT / HTML / CSV / PDF）。",
    "author": "念风内核",
    "core": false,
    "enabled": true,
    "icon": "📤",
    "unavailable": false,
    "unavailableReason": "",
    "depends": {
      "event-bus": "*",
      "session-service": ">=2.0.0",
      "toast-host": ">=1.0.0"
    },
    "optionalDepends": {},
    "inject": [
      "session-service",
      "event-bus",
      "toast"
    ],
    "provides": [
      {
        "name": "export-service",
        "type": "singleton"
      }
    ],
    "permissions": [],
    "slots": [],
    "path": "./plugins/domain/export-service/index.mjs",
    "dir": "plugins/domain/export-service"
  },
  {
    "id": "image-service",
    "version": "1.0.0",
    "displayName": "图片服务",
    "description": "基础服务 · 图片文件存储（消息只存 imageId）、压缩与按需转 data URL。",
    "author": "念风内核",
    "core": false,
    "enabled": true,
    "icon": "🖼️",
    "unavailable": false,
    "unavailableReason": "",
    "depends": {},
    "optionalDepends": {
      "backend-client": ">=1.0.0",
      "session-service": ">=2.0.0",
      "toast-host": ">=1.0.0"
    },
    "inject": [
      "api?",
      "session-service?",
      "toast?"
    ],
    "provides": [
      {
        "name": "image-service",
        "type": "singleton"
      }
    ],
    "permissions": [],
    "slots": [],
    "path": "./plugins/domain/image-service/index.mjs",
    "dir": "plugins/domain/image-service"
  },
  {
    "id": "memory-store",
    "version": "1.1.0",
    "displayName": "长期记忆库",
    "description": "业务服务 · 每 10 轮概括、向量语义 + 关键词 + 时间混合检索。",
    "author": "念风内核",
    "core": false,
    "enabled": true,
    "icon": "🧠",
    "unavailable": false,
    "unavailableReason": "",
    "depends": {
      "chat-store": "^1.0.0",
      "config": ">=1.1.0",
      "event-bus": "*",
      "session-service": "^2.0.0"
    },
    "optionalDepends": {
      "backend-client": ">=1.0.0",
      "model-registry": ">=1.0.0"
    },
    "inject": [
      "chat-store",
      "session-service",
      "config",
      "event-bus",
      "api?",
      "model-registry?"
    ],
    "provides": [
      {
        "name": "memory-store",
        "type": "singleton"
      }
    ],
    "permissions": [],
    "slots": [],
    "path": "./plugins/domain/memory-store/index.mjs",
    "dir": "plugins/domain/memory-store"
  },
  {
    "id": "message-service",
    "version": "1.0.0",
    "displayName": "消息服务",
    "description": "业务服务 · 消息增删改与流式状态管理。",
    "author": "念风内核",
    "core": true,
    "enabled": true,
    "icon": "✉️",
    "unavailable": false,
    "unavailableReason": "",
    "depends": {
      "config": "^1.0.0",
      "event-bus": "*",
      "session-service": "^2.0.0"
    },
    "optionalDepends": {},
    "inject": [
      "session-service",
      "event-bus",
      "config"
    ],
    "provides": [
      {
        "name": "message-service",
        "type": "singleton"
      }
    ],
    "permissions": [],
    "slots": [],
    "path": "./plugins/domain/message-service/index.mjs",
    "dir": "plugins/domain/message-service"
  },
  {
    "id": "model-registry",
    "version": "1.0.0",
    "displayName": "模型注册表",
    "description": "业务服务 · 注册所有可用模型与提供商。",
    "author": "念风内核",
    "core": true,
    "enabled": true,
    "icon": "📚",
    "unavailable": false,
    "unavailableReason": "",
    "depends": {
      "event-bus": "*",
      "service-container": "^1.0.0"
    },
    "optionalDepends": {},
    "inject": [
      "event-bus",
      "service-container"
    ],
    "provides": [
      {
        "name": "model-registry",
        "type": "singleton"
      }
    ],
    "permissions": [],
    "slots": [],
    "path": "./plugins/domain/model-registry/index.mjs",
    "dir": "plugins/domain/model-registry"
  },
  {
    "id": "model-service",
    "version": "1.3.0",
    "displayName": "模型服务",
    "description": "业务服务 · 模型抽象接口与调度，支持全局 / 角色级备用模型，具体由适配器插件实现。",
    "author": "念风内核",
    "core": true,
    "enabled": true,
    "icon": "🤖",
    "unavailable": false,
    "unavailableReason": "",
    "depends": {
      "config": "^1.0.0",
      "event-bus": "*",
      "model-registry": "^1.0.0"
    },
    "optionalDepends": {},
    "inject": [
      "model-registry",
      "config",
      "event-bus"
    ],
    "provides": [
      {
        "name": "model-service",
        "type": "singleton"
      }
    ],
    "permissions": [],
    "slots": [],
    "path": "./plugins/domain/model-service/index.mjs",
    "dir": "plugins/domain/model-service"
  },
  {
    "id": "plugin-manager",
    "version": "1.0.0",
    "displayName": "插件管理器",
    "description": "业务服务 · 插件启停 / 安装 / 卸载与状态整理。",
    "author": "念风内核",
    "core": true,
    "enabled": true,
    "icon": "🧰",
    "unavailable": false,
    "unavailableReason": "",
    "depends": {
      "config": "^1.0.0",
      "event-bus": "*",
      "modal-host": ">=1.0.0",
      "plugin-loader": "^1.0.0",
      "toast-host": ">=1.0.0"
    },
    "optionalDepends": {},
    "inject": [
      "plugin-loader",
      "config",
      "event-bus",
      "toast",
      "modal"
    ],
    "provides": [
      {
        "name": "plugin-manager",
        "type": "singleton"
      }
    ],
    "permissions": [],
    "slots": [],
    "path": "./plugins/domain/plugin-manager/index.mjs",
    "dir": "plugins/domain/plugin-manager"
  },
  {
    "id": "plugin-scope",
    "version": "1.0.1",
    "displayName": "插件启用范围",
    "description": "业务服务 · 按角色 / 渠道统一管理外部插件的启用范围。",
    "author": "念风内核",
    "core": true,
    "enabled": true,
    "icon": "🎛️",
    "unavailable": false,
    "unavailableReason": "",
    "depends": {
      "config": "^1.0.0",
      "event-bus": "*",
      "session-service": "^2.0.0",
      "channel-registry": "^1.0.0"
    },
    "optionalDepends": {},
    "inject": [
      "config",
      "event-bus",
      "session-service",
      "channel-registry"
    ],
    "provides": [
      {
        "name": "plugin-scope",
        "type": "singleton"
      }
    ],
    "permissions": [],
    "slots": [],
    "path": "./plugins/domain/plugin-scope/index.mjs",
    "dir": "plugins/domain/plugin-scope"
  },
  {
    "id": "search-service",
    "version": "1.0.1",
    "displayName": "全局搜索服务",
    "description": "业务服务 · 跨会话 / 渠道 / 插件的全局搜索。",
    "author": "念风内核",
    "core": false,
    "enabled": true,
    "icon": "🔍",
    "unavailable": false,
    "unavailableReason": "",
    "depends": {
      "event-bus": "*",
      "session-service": "^2.0.0"
    },
    "optionalDepends": {},
    "inject": [
      "session-service",
      "event-bus"
    ],
    "provides": [
      {
        "name": "search-service",
        "type": "singleton"
      }
    ],
    "permissions": [],
    "slots": [],
    "path": "./plugins/domain/search-service/index.mjs",
    "dir": "plugins/domain/search-service"
  },
  {
    "id": "session-service",
    "version": "2.0.0",
    "displayName": "会话服务",
    "description": "业务服务 · 会话管理、上下文组装、后端持久化与离线降级。",
    "author": "念风内核",
    "core": true,
    "enabled": true,
    "icon": "💬",
    "unavailable": false,
    "unavailableReason": "",
    "depends": {
      "config": "^1.0.0",
      "storage": "^1.0.0",
      "event-bus": "*"
    },
    "optionalDepends": {
      "backend-client": ">=1.0.0"
    },
    "inject": [
      "storage",
      "config",
      "event-bus",
      "api?"
    ],
    "provides": [
      {
        "name": "session-service",
        "type": "singleton"
      }
    ],
    "permissions": [],
    "slots": [],
    "path": "./plugins/domain/session-service/index.mjs",
    "dir": "plugins/domain/session-service"
  },
  {
    "id": "tool-registry",
    "version": "1.1.0",
    "displayName": "工具注册表",
    "description": "业务服务 · OpenAI function-calling 工具的注册、编目与执行调度。",
    "author": "念风内核",
    "core": true,
    "enabled": true,
    "icon": "🧰",
    "unavailable": false,
    "unavailableReason": "",
    "depends": {
      "event-bus": "^1.0.0"
    },
    "optionalDepends": {},
    "inject": [
      "event-bus"
    ],
    "provides": [
      {
        "name": "tool-registry",
        "type": "singleton"
      }
    ],
    "permissions": [],
    "slots": [],
    "path": "./plugins/domain/tool-registry/index.mjs",
    "dir": "plugins/domain/tool-registry"
  },
  {
    "id": "user-identity",
    "version": "1.0.0",
    "displayName": "用户身份",
    "description": "业务服务 · 统一用户标识（本地配置默认值 + 未来联网账号提供者接口）。",
    "author": "念风内核",
    "core": true,
    "enabled": true,
    "icon": "🪪",
    "unavailable": false,
    "unavailableReason": "",
    "depends": {
      "config": "^1.1.0",
      "event-bus": "*"
    },
    "optionalDepends": {},
    "inject": [
      "config",
      "event-bus"
    ],
    "provides": [
      {
        "name": "user-identity",
        "type": "singleton"
      }
    ],
    "permissions": [],
    "slots": [],
    "path": "./plugins/domain/user-identity/index.mjs",
    "dir": "plugins/domain/user-identity"
  },
  {
    "id": "view-router",
    "version": "1.0.0",
    "displayName": "视图路由",
    "description": "业务服务 · 当前视图、列表宽度记忆与视图注册。",
    "author": "念风内核",
    "core": true,
    "enabled": true,
    "icon": "🧭",
    "unavailable": false,
    "unavailableReason": "",
    "depends": {
      "config": "^1.0.0",
      "event-bus": "*"
    },
    "optionalDepends": {},
    "inject": [
      "config",
      "event-bus"
    ],
    "provides": [
      {
        "name": "view-router",
        "type": "singleton"
      }
    ],
    "permissions": [],
    "slots": [],
    "path": "./plugins/domain/view-router/index.mjs",
    "dir": "plugins/domain/view-router"
  },
  {
    "id": "lang-zh-cn",
    "version": "1.0.0",
    "displayName": "语言包 · 简体中文",
    "description": "语言包 · 内置简体中文；复制本插件目录并修改翻译表即可新增其他语种。",
    "author": "念风内核",
    "core": true,
    "enabled": true,
    "icon": "🀄",
    "unavailable": false,
    "unavailableReason": "",
    "depends": {
      "i18n": "^2.0.0"
    },
    "optionalDepends": {},
    "inject": [
      "i18n"
    ],
    "provides": [],
    "permissions": [],
    "slots": [],
    "path": "./plugins/extras/lang-zh-cn/index.mjs",
    "dir": "plugins/extras/lang-zh-cn"
  },
  {
    "id": "markdown-enhancer",
    "version": "1.0.0",
    "displayName": "Markdown 增强",
    "description": "可选扩展 · 为气泡提供 Markdown 渲染服务。",
    "author": "念风社区",
    "core": false,
    "enabled": true,
    "icon": "📝",
    "unavailable": false,
    "unavailableReason": "",
    "depends": {},
    "optionalDepends": {},
    "inject": [],
    "provides": [
      {
        "name": "markdown",
        "type": "singleton"
      }
    ],
    "permissions": [],
    "slots": [],
    "path": "./plugins/extras/markdown-enhancer/index.mjs",
    "dir": "plugins/extras/markdown-enhancer"
  },
  {
    "id": "napcat-input-state",
    "version": "1.0.0",
    "displayName": "NapCat 输入状态",
    "description": "扩展 · NapCat 私聊在模型调用期间持续显示“正在输入中”（定时刷新，整轮结束停止）。",
    "author": "念风插件",
    "core": false,
    "enabled": true,
    "icon": "⌨️",
    "unavailable": false,
    "unavailableReason": "",
    "depends": {
      "channel-registry": "^1.0.0",
      "config": "^1.0.0",
      "event-bus": "*"
    },
    "optionalDepends": {
      "napcat": "^1.0.0",
      "plugin-manager": ">=1.0.0"
    },
    "inject": [
      "channel-registry",
      "event-bus",
      "config",
      "napcat-channel?",
      "plugin-manager?"
    ],
    "provides": [],
    "permissions": [
      "network"
    ],
    "slots": [],
    "path": "./plugins/extras/napcat-input-state/index.mjs",
    "dir": "plugins/extras/napcat-input-state"
  },
  {
    "id": "agent-client",
    "version": "1.0.0",
    "displayName": "远程代聊通道",
    "description": "WebUI 代理 · 把浏览器消息转发给后端终端代聊 Worker，并同步轮次状态。",
    "author": "念风内核",
    "core": false,
    "enabled": true,
    "icon": "🛰️",
    "unavailable": false,
    "unavailableReason": "",
    "depends": {
      "backend-client": ">=1.0.0",
      "event-bus": "*",
      "message-service": "^1.0.0"
    },
    "optionalDepends": {
      "config": ">=1.1.0",
      "session-service": ">=2.0.0",
      "toast-host": ">=1.0.0"
    },
    "inject": [
      "api",
      "event-bus",
      "message-service",
      "config?",
      "session-service?",
      "toast?"
    ],
    "provides": [
      {
        "name": "agent-client",
        "type": "singleton"
      }
    ],
    "permissions": [],
    "slots": [],
    "path": "./plugins/features/agent-client/index.mjs",
    "dir": "plugins/features/agent-client"
  },
  {
    "id": "channel-base",
    "version": "1.0.0",
    "displayName": "渠道基座",
    "description": "业务功能 · 渠道插件公共基座，负责连接状态与消息落库。",
    "author": "念风内核",
    "core": true,
    "enabled": true,
    "icon": "🛠️",
    "unavailable": false,
    "unavailableReason": "",
    "depends": {
      "channel-registry": "^1.0.0",
      "event-bus": "*",
      "message-service": "^1.0.0",
      "session-service": "^2.0.0",
      "toast-host": ">=1.0.0"
    },
    "optionalDepends": {},
    "inject": [
      "channel-registry",
      "session-service",
      "message-service",
      "event-bus",
      "toast"
    ],
    "provides": [
      {
        "name": "channel-base",
        "type": "singleton"
      }
    ],
    "permissions": [],
    "slots": [],
    "path": "./plugins/features/channel-base/index.mjs",
    "dir": "plugins/features/channel-base"
  },
  {
    "id": "character-editor",
    "version": "1.2.0",
    "displayName": "角色编辑",
    "description": "功能插件 · 新建 / 编辑会话角色（人格、主模型、备用模型、头像）。",
    "author": "念风内核",
    "core": true,
    "enabled": true,
    "icon": "🎭",
    "unavailable": false,
    "unavailableReason": "",
    "depends": {
      "model-registry": "^1.0.0",
      "session-service": "^2.0.0",
      "toast-host": ">=1.0.0"
    },
    "optionalDepends": {},
    "inject": [
      "session-service",
      "model-registry",
      "toast"
    ],
    "provides": [
      {
        "name": "character-editor",
        "type": "singleton"
      }
    ],
    "permissions": [],
    "slots": [],
    "path": "./plugins/features/character-editor/index.mjs",
    "dir": "plugins/features/character-editor"
  },
  {
    "id": "chat-flow",
    "version": "2.2.0",
    "displayName": "聊天流程",
    "description": "业务功能 · 串联\"发送 → 存 → 工具循环 → 回显\"主链路，支持角色级主模型 / 备用模型。",
    "author": "念风内核",
    "core": true,
    "enabled": true,
    "icon": "🔀",
    "unavailable": false,
    "unavailableReason": "",
    "depends": {
      "config": ">=1.1.0",
      "event-bus": "*",
      "message-service": "^1.0.0",
      "model-service": "^1.0.0",
      "session-service": "^2.0.0",
      "toast-host": ">=1.0.0"
    },
    "optionalDepends": {
      "backend-client": ">=1.0.0",
      "chat-permissions": "^1.0.0",
      "chat-queue": "^1.0.0",
      "chat-store": "^1.0.0",
      "chat-tools": "^1.0.0",
      "context-builder": "^1.0.0",
      "user-identity": ">=1.0.0"
    },
    "inject": [
      "event-bus",
      "session-service",
      "message-service",
      "model-service",
      "config",
      "toast",
      "api?",
      "user-identity?",
      "chat-store?",
      "chat-tools?",
      "context-builder?",
      "chat-queue?",
      "chat-permissions?"
    ],
    "provides": [
      {
        "name": "chat-flow",
        "type": "singleton"
      }
    ],
    "permissions": [],
    "slots": [],
    "path": "./plugins/features/chat-flow/index.mjs",
    "dir": "plugins/features/chat-flow"
  },
  {
    "id": "chat-notify",
    "version": "1.0.0",
    "displayName": "角色消息提醒",
    "description": "业务功能 · 后台或非当前会话收到角色消息时，发送带角色头像与预览的通知。",
    "author": "念风内核",
    "core": false,
    "enabled": true,
    "icon": "🔔",
    "unavailable": false,
    "unavailableReason": "",
    "depends": {
      "config": "^1.0.0",
      "event-bus": "*",
      "message-service": "^1.0.0",
      "session-service": "^2.0.0"
    },
    "optionalDepends": {
      "notification": "^2.1.0"
    },
    "inject": [
      "message-service",
      "session-service",
      "config",
      "event-bus",
      "notification?"
    ],
    "provides": [],
    "permissions": [],
    "slots": [],
    "path": "./plugins/features/chat-notify/index.mjs",
    "dir": "plugins/features/chat-notify"
  },
  {
    "id": "chat-tools",
    "version": "1.1.0",
    "displayName": "聊天工具集",
    "description": "业务功能 · read_messages / chat_send / send_document / read_document。",
    "author": "念风内核",
    "core": true,
    "enabled": true,
    "icon": "🧰",
    "unavailable": false,
    "unavailableReason": "",
    "depends": {
      "chat-permissions": "^1.0.0",
      "chat-store": "^1.0.0",
      "config": "^1.0.0",
      "context-builder": "^1.0.0",
      "document-service": "^1.0.0",
      "event-bus": "*",
      "session-service": ">=2.0.0",
      "tool-registry": "^1.0.0"
    },
    "optionalDepends": {
      "napcat": "^1.0.0",
      "backend-client": ">=1.0.0",
      "image-service": ">=1.0.0"
    },
    "inject": [
      "tool-registry",
      "chat-store",
      "document-service",
      "chat-permissions",
      "context-builder",
      "session-service",
      "config",
      "event-bus",
      "api?",
      "napcat-channel?",
      "image-service?"
    ],
    "provides": [
      {
        "name": "chat-tools",
        "type": "singleton"
      }
    ],
    "permissions": [],
    "slots": [],
    "path": "./plugins/features/chat-tools/index.mjs",
    "dir": "plugins/features/chat-tools"
  },
  {
    "id": "context-builder",
    "version": "1.0.0",
    "displayName": "上下文构建",
    "description": "业务功能 · 工作记忆 + 渠道记忆合并、去重、排序与 token 预算截断。",
    "author": "念风内核",
    "core": true,
    "enabled": true,
    "icon": "🧩",
    "unavailable": false,
    "unavailableReason": "",
    "depends": {
      "chat-store": "^1.0.0",
      "config": "^1.0.0"
    },
    "optionalDepends": {
      "tool-registry": ">=1.0.0"
    },
    "inject": [
      "chat-store",
      "config",
      "tool-registry?"
    ],
    "provides": [
      {
        "name": "context-builder",
        "type": "singleton"
      }
    ],
    "permissions": [],
    "slots": [],
    "path": "./plugins/features/context-builder/index.mjs",
    "dir": "plugins/features/context-builder"
  },
  {
    "id": "model-adapter-backend",
    "version": "2.0.0",
    "displayName": "后端模型适配器",
    "description": "模型适配器 · 通过本地后端接入真实模型（OpenAI 兼容 / Anthropic / Ollama）。",
    "author": "念风内核",
    "core": true,
    "enabled": true,
    "icon": "🔌",
    "unavailable": false,
    "unavailableReason": "",
    "depends": {
      "backend-client": "^1.0.0",
      "config": ">=1.1.0",
      "model-registry": "^1.0.0",
      "toast-host": ">=1.0.0"
    },
    "optionalDepends": {},
    "inject": [
      "api",
      "model-registry",
      "config",
      "toast"
    ],
    "provides": [
      {
        "name": "model-adapter",
        "type": "singleton"
      }
    ],
    "permissions": [],
    "slots": [],
    "path": "./plugins/features/model-adapter-backend/index.mjs",
    "dir": "plugins/features/model-adapter-backend"
  },
  {
    "id": "plugin-health-guard",
    "version": "1.0.0",
    "displayName": "插件健康守卫",
    "description": "启动检查 · 发现插件错误时弹窗提醒，并引导到插件设置。",
    "author": "念风内核",
    "core": false,
    "enabled": true,
    "icon": "🩺",
    "unavailable": false,
    "unavailableReason": "",
    "depends": {
      "event-bus": "*",
      "modal-host": ">=1.0.0",
      "plugin-manager": "^1.0.0"
    },
    "optionalDepends": {
      "toast-host": ">=1.0.0"
    },
    "inject": [
      "plugin-manager",
      "modal",
      "event-bus",
      "toast?"
    ],
    "provides": [],
    "permissions": [],
    "slots": [],
    "path": "./plugins/features/plugin-health-guard/index.mjs",
    "dir": "plugins/features/plugin-health-guard"
  },
  {
    "id": "backend-client",
    "version": "1.0.0",
    "displayName": "后端连接",
    "description": "基础服务 · WebUI ↔ 本地后端的 REST / SSE 通道与在线状态。",
    "author": "念风内核",
    "core": true,
    "enabled": true,
    "icon": "🔌",
    "unavailable": false,
    "unavailableReason": "",
    "depends": {
      "config": ">=1.1.0"
    },
    "optionalDepends": {},
    "inject": [
      "config"
    ],
    "provides": [
      {
        "name": "api",
        "type": "singleton"
      }
    ],
    "permissions": [
      "network"
    ],
    "slots": [],
    "path": "./plugins/foundation/backend-client/index.mjs",
    "dir": "plugins/foundation/backend-client"
  },
  {
    "id": "config",
    "version": "1.3.0",
    "displayName": "配置中心",
    "description": "基础服务 · 用户偏好持久化（本地 + 后端 preferences），支持点号路径与 watch。",
    "author": "念风内核",
    "core": true,
    "enabled": true,
    "icon": "⚙️",
    "unavailable": false,
    "unavailableReason": "",
    "depends": {
      "event-bus": "*",
      "storage": "^1.0.0"
    },
    "optionalDepends": {},
    "inject": [
      "storage",
      "event-bus"
    ],
    "provides": [
      {
        "name": "config",
        "type": "singleton"
      }
    ],
    "permissions": [],
    "slots": [],
    "path": "./plugins/foundation/config/index.mjs",
    "dir": "plugins/foundation/config"
  },
  {
    "id": "context-menu-host",
    "version": "1.0.0",
    "displayName": "右键菜单宿主",
    "description": "基础服务 · 统一的右键上下文菜单。",
    "author": "念风内核",
    "core": true,
    "enabled": true,
    "icon": "🖱️",
    "unavailable": false,
    "unavailableReason": "",
    "depends": {
      "event-bus": "*"
    },
    "optionalDepends": {},
    "inject": [
      "event-bus"
    ],
    "provides": [
      {
        "name": "context-menu",
        "type": "singleton"
      }
    ],
    "permissions": [],
    "slots": [],
    "path": "./plugins/foundation/context-menu-host/index.mjs",
    "dir": "plugins/foundation/context-menu-host"
  },
  {
    "id": "error-reporter",
    "version": "1.0.0",
    "displayName": "错误上报",
    "description": "基础服务 · 捕获运行期错误，集中记录与提示。",
    "author": "念风内核",
    "core": false,
    "enabled": true,
    "icon": "🚨",
    "unavailable": false,
    "unavailableReason": "",
    "depends": {
      "event-bus": "*"
    },
    "optionalDepends": {},
    "inject": [
      "event-bus"
    ],
    "provides": [
      {
        "name": "error-reporter",
        "type": "singleton"
      }
    ],
    "permissions": [],
    "slots": [],
    "path": "./plugins/foundation/error-reporter/index.mjs",
    "dir": "plugins/foundation/error-reporter"
  },
  {
    "id": "i18n",
    "version": "2.0.0",
    "displayName": "多语言",
    "description": "基础服务 · 语言包注册与切换；具体语种由独立语言包插件提供。",
    "author": "念风内核",
    "core": true,
    "enabled": true,
    "icon": "🌏",
    "unavailable": false,
    "unavailableReason": "",
    "depends": {
      "config": "^1.0.0",
      "event-bus": "*"
    },
    "optionalDepends": {},
    "inject": [
      "config",
      "event-bus"
    ],
    "provides": [
      {
        "name": "i18n",
        "type": "singleton"
      }
    ],
    "permissions": [],
    "slots": [],
    "path": "./plugins/foundation/i18n/index.mjs",
    "dir": "plugins/foundation/i18n"
  },
  {
    "id": "keyboard-shortcuts",
    "version": "1.0.0",
    "displayName": "快捷键",
    "description": "基础服务 · 快捷键注册与分发，冲突检测。",
    "author": "念风内核",
    "core": true,
    "enabled": true,
    "icon": "⌨️",
    "unavailable": false,
    "unavailableReason": "",
    "depends": {
      "event-bus": "*"
    },
    "optionalDepends": {},
    "inject": [
      "event-bus"
    ],
    "provides": [
      {
        "name": "shortcuts",
        "type": "singleton"
      }
    ],
    "permissions": [],
    "slots": [],
    "path": "./plugins/foundation/keyboard-shortcuts/index.mjs",
    "dir": "plugins/foundation/keyboard-shortcuts"
  },
  {
    "id": "logger",
    "version": "1.0.0",
    "displayName": "日志",
    "description": "基础服务 · cordis 日志导出器：控制台输出、历史记录与订阅。",
    "author": "念风内核",
    "core": true,
    "enabled": true,
    "icon": "📝",
    "unavailable": false,
    "unavailableReason": "",
    "depends": {},
    "optionalDepends": {
      "config": ">=1.1.0"
    },
    "inject": [
      "config?"
    ],
    "provides": [
      {
        "name": "logs",
        "type": "singleton"
      }
    ],
    "permissions": [],
    "slots": [],
    "path": "./plugins/foundation/logger/index.mjs",
    "dir": "plugins/foundation/logger"
  },
  {
    "id": "modal-host",
    "version": "1.0.0",
    "displayName": "弹窗宿主",
    "description": "基础服务 · 统一的模态弹窗（确认 / 输入 / 提示）。",
    "author": "念风内核",
    "core": true,
    "enabled": true,
    "icon": "🪟",
    "unavailable": false,
    "unavailableReason": "",
    "depends": {
      "event-bus": "*"
    },
    "optionalDepends": {},
    "inject": [
      "event-bus"
    ],
    "provides": [
      {
        "name": "modal",
        "type": "singleton"
      }
    ],
    "permissions": [],
    "slots": [],
    "path": "./plugins/foundation/modal-host/index.mjs",
    "dir": "plugins/foundation/modal-host"
  },
  {
    "id": "notification",
    "version": "2.1.0",
    "displayName": "消息通知",
    "description": "基础服务 · 右下角通知中心（系统通知 / 角色消息 / 其他）、系统通知头像、自定义提示音。",
    "author": "念风内核",
    "core": false,
    "enabled": true,
    "icon": "🔔",
    "unavailable": false,
    "unavailableReason": "",
    "depends": {
      "config": "^1.0.0",
      "event-bus": "*"
    },
    "optionalDepends": {
      "backend-client": ">=1.0.0"
    },
    "inject": [
      "config",
      "event-bus",
      "api?"
    ],
    "provides": [
      {
        "name": "notification",
        "type": "singleton"
      }
    ],
    "permissions": [],
    "slots": [],
    "path": "./plugins/foundation/notification/index.mjs",
    "dir": "plugins/foundation/notification"
  },
  {
    "id": "permissions",
    "version": "1.0.0",
    "displayName": "插件权限",
    "description": "基础服务 · 插件权限声明、预设与真实的服务访问拦截。",
    "author": "念风内核",
    "core": true,
    "enabled": true,
    "icon": "🛡️",
    "unavailable": false,
    "unavailableReason": "",
    "depends": {
      "config": "^1.0.0",
      "event-bus": "^1.0.0"
    },
    "optionalDepends": {},
    "inject": [
      "config",
      "app",
      "event-bus"
    ],
    "provides": [
      {
        "name": "permissions",
        "type": "singleton"
      }
    ],
    "permissions": [],
    "slots": [],
    "path": "./plugins/foundation/permissions/index.mjs",
    "dir": "plugins/foundation/permissions"
  },
  {
    "id": "slots",
    "version": "1.0.0",
    "displayName": "插槽注册中心",
    "description": "基础服务 · UI 插槽注册与管理，插件内容挂载点。",
    "author": "念风内核",
    "core": true,
    "enabled": true,
    "icon": "🧩",
    "unavailable": false,
    "unavailableReason": "",
    "depends": {
      "event-bus": "*"
    },
    "optionalDepends": {},
    "inject": [
      "event-bus"
    ],
    "provides": [
      {
        "name": "slots",
        "type": "singleton"
      }
    ],
    "permissions": [],
    "slots": [],
    "path": "./plugins/foundation/slots/index.mjs",
    "dir": "plugins/foundation/slots"
  },
  {
    "id": "storage",
    "version": "1.0.0",
    "displayName": "数据存储",
    "description": "基础服务 · 会话与配置的本地持久化（localStorage + 内存降级）。",
    "author": "念风内核",
    "core": true,
    "enabled": true,
    "icon": "💾",
    "unavailable": false,
    "unavailableReason": "",
    "depends": {},
    "optionalDepends": {},
    "inject": [],
    "provides": [
      {
        "name": "storage",
        "type": "singleton"
      }
    ],
    "permissions": [],
    "slots": [],
    "path": "./plugins/foundation/storage/index.mjs",
    "dir": "plugins/foundation/storage"
  },
  {
    "id": "theme-tokens",
    "version": "1.0.0",
    "displayName": "主题变量",
    "description": "基础服务 · 全局 CSS 变量管理，支持浅色 / 深色 / 跟随系统切换。",
    "author": "念风内核",
    "core": true,
    "enabled": true,
    "icon": "🎨",
    "unavailable": false,
    "unavailableReason": "",
    "depends": {
      "config": "^1.0.0",
      "event-bus": "*",
      "service-container": "*"
    },
    "optionalDepends": {},
    "inject": [
      "config",
      "event-bus",
      "service-container"
    ],
    "provides": [
      {
        "name": "theme",
        "type": "selectable"
      },
      {
        "name": "theme-tokens",
        "type": "singleton"
      }
    ],
    "permissions": [],
    "slots": [],
    "path": "./plugins/foundation/theme-tokens/index.mjs",
    "dir": "plugins/foundation/theme-tokens"
  },
  {
    "id": "toast-host",
    "version": "1.0.0",
    "displayName": "轻提示宿主",
    "description": "基础服务 · 右下角浮动提示（info / success / warn / error）。",
    "author": "念风内核",
    "core": true,
    "enabled": true,
    "icon": "💬",
    "unavailable": false,
    "unavailableReason": "",
    "depends": {
      "event-bus": "*"
    },
    "optionalDepends": {},
    "inject": [
      "event-bus"
    ],
    "provides": [
      {
        "name": "toast",
        "type": "singleton"
      }
    ],
    "permissions": [],
    "slots": [],
    "path": "./plugins/foundation/toast-host/index.mjs",
    "dir": "plugins/foundation/toast-host"
  },
  {
    "id": "tooltip-host",
    "version": "1.0.0",
    "displayName": "Tooltip 宿主",
    "description": "基础服务 · data-tip 全局悬浮提示。",
    "author": "念风内核",
    "core": false,
    "enabled": true,
    "icon": "🔖",
    "unavailable": false,
    "unavailableReason": "",
    "depends": {
      "event-bus": "*"
    },
    "optionalDepends": {},
    "inject": [
      "event-bus"
    ],
    "provides": [
      {
        "name": "tooltip",
        "type": "singleton"
      }
    ],
    "permissions": [],
    "slots": [],
    "path": "./plugins/foundation/tooltip-host/index.mjs",
    "dir": "plugins/foundation/tooltip-host"
  },
  {
    "id": "dependency-resolver",
    "version": "1.0.0",
    "displayName": "依赖解析器",
    "description": "内核层 · 拓扑排序依赖、检测循环依赖、版本兼容性检查。",
    "author": "念风内核",
    "core": true,
    "enabled": true,
    "icon": "🧮",
    "unavailable": false,
    "unavailableReason": "",
    "depends": {},
    "optionalDepends": {},
    "inject": [],
    "provides": [
      {
        "name": "dependency-resolver",
        "type": "singleton"
      }
    ],
    "permissions": [],
    "slots": [],
    "path": "./plugins/kernel/dependency-resolver/index.mjs",
    "dir": "plugins/kernel/dependency-resolver"
  },
  {
    "id": "event-bus",
    "version": "1.0.0",
    "displayName": "事件总线",
    "description": "内核层 · 插件间通信的基础设施，提供 emit / on / provide / inject。",
    "author": "念风内核",
    "core": true,
    "enabled": true,
    "icon": "⚡",
    "unavailable": false,
    "unavailableReason": "",
    "depends": {},
    "optionalDepends": {},
    "inject": [],
    "provides": [
      {
        "name": "event-bus",
        "type": "singleton"
      }
    ],
    "permissions": [],
    "slots": [],
    "path": "./plugins/kernel/event-bus/index.mjs",
    "dir": "plugins/kernel/event-bus"
  },
  {
    "id": "lifecycle",
    "version": "1.0.0",
    "displayName": "生命周期",
    "description": "内核层 · 提供 setup / start / stop / dispose 钩子与阶段统计。",
    "author": "念风内核",
    "core": true,
    "enabled": true,
    "icon": "♻️",
    "unavailable": false,
    "unavailableReason": "",
    "depends": {
      "event-bus": "*"
    },
    "optionalDepends": {},
    "inject": [
      "event-bus"
    ],
    "provides": [
      {
        "name": "lifecycle",
        "type": "singleton"
      }
    ],
    "permissions": [],
    "slots": [],
    "path": "./plugins/kernel/lifecycle/index.mjs",
    "dir": "plugins/kernel/lifecycle"
  },
  {
    "id": "plugin-loader",
    "version": "1.0.0",
    "displayName": "插件加载器",
    "description": "内核层 · 扫描插件目录、读取 manifest、按依赖顺序加载与启停插件。",
    "author": "念风内核",
    "core": true,
    "enabled": true,
    "icon": "🧩",
    "unavailable": false,
    "unavailableReason": "",
    "depends": {
      "dependency-resolver": "=1.0.0",
      "event-bus": "^1.0.0"
    },
    "optionalDepends": {},
    "inject": [
      "event-bus"
    ],
    "provides": [
      {
        "name": "plugin-loader",
        "type": "singleton"
      }
    ],
    "permissions": [],
    "slots": [],
    "path": "./plugins/kernel/plugin-loader/index.mjs",
    "dir": "plugins/kernel/plugin-loader"
  },
  {
    "id": "service-container",
    "version": "1.0.0",
    "displayName": "服务容器",
    "description": "内核层 · provide / inject 服务注册与注入，支持单体 / 聚合 / 可选中三种类型。",
    "author": "念风内核",
    "core": true,
    "enabled": true,
    "icon": "📦",
    "unavailable": false,
    "unavailableReason": "",
    "depends": {
      "config": ">=1.1.0",
      "event-bus": "*"
    },
    "optionalDepends": {},
    "inject": [
      "event-bus",
      "config"
    ],
    "provides": [
      {
        "name": "service-container",
        "type": "singleton"
      }
    ],
    "permissions": [],
    "slots": [],
    "path": "./plugins/kernel/service-container/index.mjs",
    "dir": "plugins/kernel/service-container"
  },
  {
    "id": "app-shell",
    "version": "1.0.0",
    "displayName": "应用外壳",
    "description": "视觉框架 · 整体 grid 骨架与挂载点。",
    "author": "念风内核",
    "core": true,
    "enabled": true,
    "icon": "🪟",
    "unavailable": false,
    "unavailableReason": "",
    "depends": {
      "slots": "*"
    },
    "optionalDepends": {},
    "inject": [
      "slots"
    ],
    "provides": [
      {
        "name": "app-shell",
        "type": "singleton"
      }
    ],
    "permissions": [],
    "slots": [],
    "path": "./plugins/shell/app-shell/index.mjs",
    "dir": "plugins/shell/app-shell"
  },
  {
    "id": "bg-aurora",
    "version": "1.0.0",
    "displayName": "绿雾背景",
    "description": "可选中背景 · 漂浮渐变光团 · 呼吸式动态效果。",
    "author": "念风内核",
    "core": false,
    "enabled": true,
    "icon": "🫧",
    "unavailable": false,
    "unavailableReason": "",
    "depends": {
      "bg-provider": "^1.0.0"
    },
    "optionalDepends": {},
    "inject": [
      "bg-provider"
    ],
    "provides": [],
    "permissions": [],
    "slots": [],
    "path": "./plugins/shell/bg-aurora/index.mjs",
    "dir": "plugins/shell/bg-aurora"
  },
  {
    "id": "bg-image",
    "version": "1.0.0",
    "displayName": "自定义背景图",
    "description": "可选中背景 · 用户上传的图片，自动压缩后保存在本机。",
    "author": "念风内核",
    "core": false,
    "enabled": true,
    "icon": "🖼️",
    "unavailable": false,
    "unavailableReason": "",
    "depends": {
      "bg-provider": "^1.0.0",
      "config": ">=1.1.0"
    },
    "optionalDepends": {},
    "inject": [
      "bg-provider",
      "config"
    ],
    "provides": [],
    "permissions": [],
    "slots": [],
    "path": "./plugins/shell/bg-image/index.mjs",
    "dir": "plugins/shell/bg-image"
  },
  {
    "id": "bg-provider",
    "version": "1.0.0",
    "displayName": "背景接口",
    "description": "视觉框架 · 背景可选中服务，用户可在已安装实现间切换。",
    "author": "念风内核",
    "core": true,
    "enabled": true,
    "icon": "🌫️",
    "unavailable": false,
    "unavailableReason": "",
    "depends": {
      "event-bus": "*",
      "service-container": "^1.0.0"
    },
    "optionalDepends": {},
    "inject": [
      "service-container",
      "event-bus"
    ],
    "provides": [
      {
        "name": "bg-provider",
        "type": "singleton"
      }
    ],
    "permissions": [],
    "slots": [],
    "path": "./plugins/shell/bg-provider/index.mjs",
    "dir": "plugins/shell/bg-provider"
  },
  {
    "id": "bg-solid",
    "version": "1.0.0",
    "displayName": "纯色背景",
    "description": "可选中背景 · 极简纯色，无动画。",
    "author": "念风内核",
    "core": false,
    "enabled": true,
    "icon": "⬜",
    "unavailable": false,
    "unavailableReason": "",
    "depends": {
      "bg-provider": "^1.0.0"
    },
    "optionalDepends": {},
    "inject": [
      "bg-provider"
    ],
    "provides": [],
    "permissions": [],
    "slots": [],
    "path": "./plugins/shell/bg-solid/index.mjs",
    "dir": "plugins/shell/bg-solid"
  },
  {
    "id": "left-list-panel",
    "version": "1.0.0",
    "displayName": "左列表容器",
    "description": "视觉框架 · 左列表玻璃板容器，负责视图列表切换与宽度记忆。",
    "author": "念风内核",
    "core": true,
    "enabled": true,
    "icon": "📋",
    "unavailable": false,
    "unavailableReason": "",
    "depends": {
      "app-shell": "^1.0.0",
      "event-bus": "*",
      "slots": "*",
      "view-router": "^1.0.0"
    },
    "optionalDepends": {},
    "inject": [
      "slots",
      "view-router",
      "app-shell",
      "event-bus"
    ],
    "provides": [
      {
        "name": "left-list-panel",
        "type": "singleton"
      }
    ],
    "permissions": [],
    "slots": [],
    "path": "./plugins/shell/left-list-panel/index.mjs",
    "dir": "plugins/shell/left-list-panel"
  },
  {
    "id": "mobile-shell",
    "version": "1.0.0",
    "displayName": "手机界面",
    "description": "视觉框架 · 手机访问自动切换到单栏界面、底部导航与全屏设置。",
    "author": "念风内核",
    "core": true,
    "enabled": true,
    "icon": "📱",
    "unavailable": false,
    "unavailableReason": "",
    "depends": {
      "app-shell": "^1.0.0",
      "event-bus": "*",
      "session-service": "^2.0.0",
      "view-router": "^1.0.0"
    },
    "optionalDepends": {
      "channel-registry": ">=1.0.0",
      "settings-view": ">=1.0.0"
    },
    "inject": [
      "app-shell",
      "view-router",
      "session-service",
      "event-bus",
      "channel-registry?",
      "settings-view?"
    ],
    "provides": [
      {
        "name": "mobile-shell",
        "type": "singleton"
      }
    ],
    "permissions": [],
    "slots": [],
    "path": "./plugins/shell/mobile-shell/index.mjs",
    "dir": "plugins/shell/mobile-shell"
  },
  {
    "id": "rail",
    "version": "1.0.0",
    "displayName": "侧边栏",
    "description": "视觉框架 · 侧边栏容器与三段插槽。",
    "author": "念风内核",
    "core": true,
    "enabled": true,
    "icon": "📎",
    "unavailable": false,
    "unavailableReason": "",
    "depends": {
      "app-shell": "^1.0.0",
      "slots": "*"
    },
    "optionalDepends": {},
    "inject": [
      "slots"
    ],
    "provides": [
      {
        "name": "rail",
        "type": "singleton"
      }
    ],
    "permissions": [],
    "slots": [],
    "path": "./plugins/shell/rail/index.mjs",
    "dir": "plugins/shell/rail"
  },
  {
    "id": "right-main-panel",
    "version": "1.0.0",
    "displayName": "右主面板",
    "description": "视觉框架 · 右主面板玻璃板容器与视图切换。",
    "author": "念风内核",
    "core": true,
    "enabled": true,
    "icon": "🗂️",
    "unavailable": false,
    "unavailableReason": "",
    "depends": {
      "app-shell": "^1.0.0",
      "event-bus": "*",
      "slots": "*",
      "view-router": "^1.0.0"
    },
    "optionalDepends": {},
    "inject": [
      "slots",
      "view-router",
      "app-shell",
      "event-bus"
    ],
    "provides": [
      {
        "name": "right-main-panel",
        "type": "singleton"
      }
    ],
    "permissions": [],
    "slots": [],
    "path": "./plugins/shell/right-main-panel/index.mjs",
    "dir": "plugins/shell/right-main-panel"
  },
  {
    "id": "titlebar",
    "version": "1.0.0",
    "displayName": "顶层栏",
    "description": "视觉框架 · 顶层栏容器与三段插槽。",
    "author": "念风内核",
    "core": true,
    "enabled": true,
    "icon": "🔝",
    "unavailable": false,
    "unavailableReason": "",
    "depends": {
      "app-shell": "^1.0.0",
      "slots": "*"
    },
    "optionalDepends": {},
    "inject": [
      "slots"
    ],
    "provides": [
      {
        "name": "titlebar",
        "type": "singleton"
      }
    ],
    "permissions": [],
    "slots": [],
    "path": "./plugins/shell/titlebar/index.mjs",
    "dir": "plugins/shell/titlebar"
  },
  {
    "id": "brand-widget",
    "version": "1.0.0",
    "displayName": "品牌标识",
    "description": "顶层栏内容 · logo + 名称。",
    "author": "念风内核",
    "core": true,
    "enabled": true,
    "icon": "🌬️",
    "unavailable": false,
    "unavailableReason": "",
    "depends": {
      "slots": "*",
      "titlebar": "^1.0.0"
    },
    "optionalDepends": {},
    "inject": [
      "slots"
    ],
    "provides": [],
    "permissions": [],
    "slots": [],
    "path": "./plugins/views/brand-widget/index.mjs",
    "dir": "plugins/views/brand-widget"
  },
  {
    "id": "bubble-default",
    "version": "1.0.0",
    "displayName": "默认气泡",
    "description": "可选中气泡 · Telegram 风格，双勾 / 时间戳智能摆放。",
    "author": "念风内核",
    "core": true,
    "enabled": true,
    "icon": "💠",
    "unavailable": false,
    "unavailableReason": "",
    "depends": {
      "config": ">=1.1.0",
      "event-bus": "*",
      "i18n": ">=2.0.0",
      "message-list": "^1.0.0"
    },
    "optionalDepends": {
      "image-service": ">=1.0.0"
    },
    "inject": [
      "bubble-styles",
      "event-bus",
      "i18n",
      "config",
      "image-service?"
    ],
    "provides": [],
    "permissions": [],
    "slots": [],
    "path": "./plugins/views/bubble-default/index.mjs",
    "dir": "plugins/views/bubble-default"
  },
  {
    "id": "channel-detail-host",
    "version": "3.0.0",
    "displayName": "渠道详情",
    "description": "视觉内容 · 渠道详情与基础操作入口。",
    "author": "念风内核",
    "core": true,
    "enabled": true,
    "icon": "🔎",
    "unavailable": false,
    "unavailableReason": "",
    "depends": {
      "channel-registry": "^1.0.0",
      "channel-view": "^1.0.0",
      "i18n": ">=2.0.0",
      "session-service": ">=2.0.0",
      "slots": "*",
      "toast-host": ">=1.0.0"
    },
    "optionalDepends": {},
    "inject": [
      "slots",
      "channel-registry",
      "session-service",
      "toast",
      "i18n"
    ],
    "provides": [],
    "permissions": [],
    "slots": [],
    "path": "./plugins/views/channel-detail-host/index.mjs",
    "dir": "plugins/views/channel-detail-host"
  },
  {
    "id": "channel-list",
    "version": "1.0.0",
    "displayName": "渠道列表",
    "description": "视觉内容 · 渠道分组列表、拖拽排序与添加渠道。",
    "author": "念风内核",
    "core": true,
    "enabled": true,
    "icon": "🗂️",
    "unavailable": false,
    "unavailableReason": "",
    "depends": {
      "channel-registry": "^1.0.0",
      "context-menu-host": ">=1.0.0",
      "event-bus": "*",
      "i18n": ">=2.0.0",
      "left-list-panel": "^1.0.0",
      "modal-host": ">=1.0.0",
      "slots": "*",
      "toast-host": ">=1.0.0"
    },
    "optionalDepends": {},
    "inject": [
      "slots",
      "channel-registry",
      "event-bus",
      "context-menu",
      "modal",
      "toast",
      "i18n"
    ],
    "provides": [
      {
        "name": "channel-list",
        "type": "singleton"
      }
    ],
    "permissions": [],
    "slots": [],
    "path": "./plugins/views/channel-list/index.mjs",
    "dir": "plugins/views/channel-list"
  },
  {
    "id": "channel-view",
    "version": "1.0.0",
    "displayName": "渠道视图",
    "description": "视觉内容 · 渠道视图入口。",
    "author": "念风内核",
    "core": true,
    "enabled": true,
    "icon": "📡",
    "unavailable": false,
    "unavailableReason": "",
    "depends": {
      "event-bus": "*",
      "left-list-panel": "^1.0.0",
      "right-main-panel": "^1.0.0",
      "slots": "*",
      "view-router": "^1.0.0"
    },
    "optionalDepends": {},
    "inject": [
      "slots",
      "view-router",
      "event-bus"
    ],
    "provides": [
      {
        "name": "channel-view",
        "type": "singleton"
      }
    ],
    "permissions": [],
    "slots": [],
    "path": "./plugins/views/channel-view/index.mjs",
    "dir": "plugins/views/channel-view"
  },
  {
    "id": "chat-header",
    "version": "1.0.0",
    "displayName": "会话头部",
    "description": "视觉内容 · 会话标题、模型运行状态与操作区。",
    "author": "念风内核",
    "core": true,
    "enabled": true,
    "icon": "📌",
    "unavailable": false,
    "unavailableReason": "",
    "depends": {
      "chat-view": "^1.0.0",
      "context-menu-host": ">=1.0.0",
      "event-bus": "*",
      "i18n": ">=2.0.0",
      "modal-host": ">=1.0.0",
      "session-service": ">=2.0.0",
      "slots": "*",
      "toast-host": ">=1.0.0"
    },
    "optionalDepends": {},
    "inject": [
      "slots",
      "session-service",
      "event-bus",
      "context-menu",
      "toast",
      "modal",
      "i18n"
    ],
    "provides": [],
    "permissions": [],
    "slots": [],
    "path": "./plugins/views/chat-header/index.mjs",
    "dir": "plugins/views/chat-header"
  },
  {
    "id": "chat-view",
    "version": "1.0.0",
    "displayName": "会话视图",
    "description": "视觉内容 · 会话视图入口与主面板骨架。",
    "author": "念风内核",
    "core": true,
    "enabled": true,
    "icon": "💬",
    "unavailable": false,
    "unavailableReason": "",
    "depends": {
      "event-bus": "*",
      "left-list-panel": "^1.0.0",
      "right-main-panel": "^1.0.0",
      "session-service": ">=2.0.0",
      "slots": "*",
      "view-router": "^1.0.0"
    },
    "optionalDepends": {},
    "inject": [
      "slots",
      "view-router",
      "session-service",
      "event-bus"
    ],
    "provides": [
      {
        "name": "chat-view",
        "type": "singleton"
      }
    ],
    "permissions": [],
    "slots": [],
    "path": "./plugins/views/chat-view/index.mjs",
    "dir": "plugins/views/chat-view"
  },
  {
    "id": "composer",
    "version": "1.0.0",
    "displayName": "输入区",
    "description": "视觉内容 · 消息输入、工具条与高度拖拽。",
    "author": "念风内核",
    "core": true,
    "enabled": true,
    "icon": "⌨️",
    "unavailable": false,
    "unavailableReason": "",
    "depends": {
      "chat-view": "^1.0.0",
      "config": ">=1.1.0",
      "event-bus": "*",
      "i18n": ">=2.0.0",
      "message-service": "^1.0.0",
      "session-service": ">=2.0.0",
      "slots": "*",
      "toast-host": ">=1.0.0"
    },
    "optionalDepends": {
      "image-service": ">=1.0.0"
    },
    "inject": [
      "slots",
      "session-service",
      "message-service",
      "event-bus",
      "toast",
      "i18n",
      "config",
      "image-service?"
    ],
    "provides": [
      {
        "name": "composer",
        "type": "singleton"
      }
    ],
    "permissions": [],
    "slots": [],
    "path": "./plugins/views/composer/index.mjs",
    "dir": "plugins/views/composer"
  },
  {
    "id": "global-search",
    "version": "1.0.0",
    "displayName": "全局搜索",
    "description": "视觉内容 · 跨会话 / 消息 / 渠道 / 插件 / 设置的搜索浮层。",
    "author": "念风内核",
    "core": false,
    "enabled": true,
    "icon": "🔍",
    "unavailable": false,
    "unavailableReason": "",
    "depends": {
      "event-bus": "*",
      "rail": "^1.0.0",
      "search-service": "^1.0.0",
      "slots": "*",
      "toast-host": ">=1.0.0"
    },
    "optionalDepends": {
      "keyboard-shortcuts": ">=1.0.0"
    },
    "inject": [
      "slots",
      "search-service",
      "event-bus",
      "shortcuts?",
      "toast"
    ],
    "provides": [
      {
        "name": "global-search",
        "type": "singleton"
      }
    ],
    "permissions": [],
    "slots": [],
    "path": "./plugins/views/global-search/index.mjs",
    "dir": "plugins/views/global-search"
  },
  {
    "id": "library-view",
    "version": "1.0.0",
    "displayName": "视图 · 记忆与知识库",
    "description": "独立视图：浏览长期记忆条目与对应消息原文，以及知识库条目全文与历史。",
    "author": "念风内核",
    "core": false,
    "enabled": true,
    "icon": "🧠",
    "unavailable": false,
    "unavailableReason": "",
    "depends": {
      "event-bus": "*",
      "view-router": "^1.0.0"
    },
    "optionalDepends": {
      "backend-client": ">=1.0.0",
      "session-service": ">=2.0.0"
    },
    "inject": [
      "view-router",
      "event-bus",
      "api?",
      "session-service?"
    ],
    "provides": [
      {
        "name": "library-view",
        "type": "singleton"
      }
    ],
    "permissions": [],
    "slots": [],
    "path": "./plugins/views/library-view/index.mjs",
    "dir": "plugins/views/library-view"
  },
  {
    "id": "message-list",
    "version": "1.1.0",
    "displayName": "消息列表",
    "description": "视觉内容 · 消息滚动区容器、大历史窗口化与渲染调度。",
    "author": "念风内核",
    "core": true,
    "enabled": true,
    "icon": "📜",
    "unavailable": false,
    "unavailableReason": "",
    "depends": {
      "chat-view": "^1.0.0",
      "config": ">=1.1.0",
      "context-menu-host": ">=1.0.0",
      "event-bus": "*",
      "message-service": "^1.0.0",
      "service-container": "*",
      "session-service": ">=2.0.0",
      "slots": "*",
      "toast-host": ">=1.0.0"
    },
    "optionalDepends": {
      "modal-host": ">=1.0.0"
    },
    "inject": [
      "slots",
      "session-service",
      "message-service",
      "service-container",
      "event-bus",
      "context-menu",
      "modal?",
      "toast",
      "config"
    ],
    "provides": [
      {
        "name": "message-list",
        "type": "singleton"
      },
      {
        "name": "bubble-styles",
        "type": "selectable"
      }
    ],
    "permissions": [],
    "slots": [],
    "path": "./plugins/views/message-list/index.mjs",
    "dir": "plugins/views/message-list"
  },
  {
    "id": "rail-nav-buttons",
    "version": "1.0.0",
    "displayName": "侧栏导航",
    "description": "侧边栏内容 · 会话 / 渠道 / 设置切换。",
    "author": "念风内核",
    "core": true,
    "enabled": true,
    "icon": "🧭",
    "unavailable": false,
    "unavailableReason": "",
    "depends": {
      "keyboard-shortcuts": ">=1.0.0",
      "rail": "^1.0.0",
      "slots": "*",
      "view-router": "^1.0.0"
    },
    "optionalDepends": {},
    "inject": [
      "slots",
      "view-router",
      "shortcuts"
    ],
    "provides": [],
    "permissions": [],
    "slots": [],
    "path": "./plugins/views/rail-nav-buttons/index.mjs",
    "dir": "plugins/views/rail-nav-buttons"
  },
  {
    "id": "rail-plugin-slot",
    "version": "1.0.0",
    "displayName": "插件挂载点",
    "description": "侧边栏内容 · 用户插件图标挂载点（rail:middle）。",
    "author": "念风内核",
    "core": true,
    "enabled": true,
    "icon": "🪝",
    "unavailable": false,
    "unavailableReason": "",
    "depends": {
      "rail": "^1.0.0",
      "slots": "*"
    },
    "optionalDepends": {},
    "inject": [
      "slots"
    ],
    "provides": [
      {
        "name": "rail-plugin-slot",
        "type": "singleton"
      }
    ],
    "permissions": [],
    "slots": [],
    "path": "./plugins/views/rail-plugin-slot/index.mjs",
    "dir": "plugins/views/rail-plugin-slot"
  },
  {
    "id": "session-list",
    "version": "1.0.0",
    "displayName": "会话列表",
    "description": "视觉内容 · 会话列表与搜索。",
    "author": "念风内核",
    "core": true,
    "enabled": true,
    "icon": "📋",
    "unavailable": false,
    "unavailableReason": "",
    "depends": {
      "context-menu-host": ">=1.0.0",
      "event-bus": "*",
      "i18n": ">=2.0.0",
      "left-list-panel": "^1.0.0",
      "modal-host": ">=1.0.0",
      "session-service": "^2.0.0",
      "slots": "*",
      "toast-host": ">=1.0.0"
    },
    "optionalDepends": {},
    "inject": [
      "slots",
      "session-service",
      "event-bus",
      "modal",
      "context-menu",
      "toast",
      "i18n"
    ],
    "provides": [],
    "permissions": [],
    "slots": [],
    "path": "./plugins/views/session-list/index.mjs",
    "dir": "plugins/views/session-list"
  },
  {
    "id": "settings-container",
    "version": "1.0.0",
    "displayName": "设置容器",
    "description": "视觉内容 · 设置页注册表、导航渲染与页面调度。",
    "author": "念风内核",
    "core": true,
    "enabled": true,
    "icon": "🧱",
    "unavailable": false,
    "unavailableReason": "",
    "depends": {
      "event-bus": "*",
      "settings-view": "^1.0.0",
      "slots": "*"
    },
    "optionalDepends": {
      "i18n": ">=2.0.0"
    },
    "inject": [
      "slots",
      "event-bus",
      "i18n?"
    ],
    "provides": [
      {
        "name": "settings-container",
        "type": "singleton"
      }
    ],
    "permissions": [],
    "slots": [],
    "path": "./plugins/views/settings-container/index.mjs",
    "dir": "plugins/views/settings-container"
  },
  {
    "id": "settings-item-about",
    "version": "1.1.0",
    "displayName": "设置项 · 关于",
    "description": "设置页 · 版本与插件系统信息。",
    "author": "念风内核",
    "core": true,
    "enabled": true,
    "icon": "ℹ️",
    "unavailable": false,
    "unavailableReason": "",
    "depends": {
      "event-bus": "*",
      "plugin-manager": "^1.0.0",
      "settings-container": "^1.0.0",
      "toast-host": ">=1.0.0"
    },
    "optionalDepends": {},
    "inject": [
      "settings-container",
      "plugin-manager",
      "event-bus",
      "toast"
    ],
    "provides": [],
    "permissions": [],
    "slots": [],
    "path": "./plugins/views/settings-item-about/index.mjs",
    "dir": "plugins/views/settings-item-about"
  },
  {
    "id": "settings-item-bubble",
    "version": "1.0.0",
    "displayName": "设置项 · 气泡",
    "description": "设置页 · 在已安装的气泡实现之间切换。",
    "author": "念风内核",
    "core": true,
    "enabled": true,
    "icon": "💠",
    "unavailable": false,
    "unavailableReason": "",
    "depends": {
      "event-bus": "*",
      "message-list": "^1.0.0",
      "settings-item-theme": "^1.0.0",
      "toast-host": ">=1.0.0"
    },
    "optionalDepends": {},
    "inject": [
      "appearance-page",
      "bubble-styles",
      "event-bus",
      "toast"
    ],
    "provides": [],
    "permissions": [],
    "slots": [],
    "path": "./plugins/views/settings-item-bubble/index.mjs",
    "dir": "plugins/views/settings-item-bubble"
  },
  {
    "id": "settings-item-chat-auth",
    "version": "1.0.0",
    "displayName": "设置项 · 渠道授权",
    "description": "设置页 · 跨渠道读取 / 发送策略、授权记录与审计日志。",
    "author": "念风内核",
    "core": false,
    "enabled": true,
    "icon": "🔐",
    "unavailable": false,
    "unavailableReason": "",
    "depends": {
      "chat-permissions": "^1.0.0",
      "chat-store": "^1.0.0",
      "event-bus": "*",
      "session-service": ">=2.0.0",
      "settings-container": "^1.0.0",
      "toast-host": ">=1.0.0"
    },
    "optionalDepends": {},
    "inject": [
      "settings-container",
      "chat-permissions",
      "chat-store",
      "session-service",
      "event-bus",
      "toast"
    ],
    "provides": [],
    "permissions": [],
    "slots": [],
    "path": "./plugins/views/settings-item-chat-auth/index.mjs",
    "dir": "plugins/views/settings-item-chat-auth"
  },
  {
    "id": "settings-item-chat-records",
    "version": "2.0.0",
    "displayName": "设置项 · 聊天记录",
    "description": "设置页 · 图形化 / JSON 双模式查看与编辑聊天记录，草稿式保存。",
    "author": "念风内核",
    "core": true,
    "enabled": true,
    "icon": "🗂️",
    "unavailable": false,
    "unavailableReason": "",
    "depends": {
      "chat-store": "^1.0.0",
      "event-bus": "*",
      "session-service": "^2.0.0",
      "settings-container": "^1.0.0",
      "toast-host": ">=1.0.0"
    },
    "optionalDepends": {
      "modal-host": ">=1.0.0"
    },
    "inject": [
      "settings-container",
      "chat-store",
      "session-service",
      "toast",
      "modal?",
      "event-bus"
    ],
    "provides": [],
    "permissions": [],
    "slots": [],
    "path": "./plugins/views/settings-item-chat-records/index.mjs",
    "dir": "plugins/views/settings-item-chat-records"
  },
  {
    "id": "settings-item-code-runner",
    "version": "1.0.0",
    "displayName": "设置项 · 代码运行器",
    "description": "设置页 · 在无 DOM / 无网络的 Web Worker 沙箱里运行 JavaScript 片段。",
    "author": "念风内核",
    "core": false,
    "enabled": true,
    "icon": "⚡",
    "unavailable": false,
    "unavailableReason": "",
    "depends": {
      "permissions": "^1.0.0",
      "settings-container": "^1.0.0",
      "toast-host": ">=1.0.0"
    },
    "optionalDepends": {},
    "inject": [
      "settings-container",
      "toast"
    ],
    "provides": [],
    "permissions": [
      "code-execution"
    ],
    "slots": [],
    "path": "./plugins/views/settings-item-code-runner/index.mjs",
    "dir": "plugins/views/settings-item-code-runner"
  },
  {
    "id": "settings-item-data",
    "version": "3.0.0",
    "displayName": "设置项 · 数据",
    "description": "设置页 · 数据目录选择与本地数据操作。",
    "author": "念风内核",
    "core": false,
    "enabled": true,
    "icon": "💾",
    "unavailable": false,
    "unavailableReason": "",
    "depends": {
      "backend-client": ">=1.0.0",
      "modal-host": ">=1.0.0",
      "permissions": "^1.0.0",
      "session-service": ">=2.0.0",
      "settings-container": "^1.0.0",
      "storage": "*",
      "toast-host": ">=1.0.0"
    },
    "optionalDepends": {},
    "inject": [
      "settings-container",
      "storage",
      "session-service",
      "toast",
      "modal",
      "api"
    ],
    "provides": [],
    "permissions": [],
    "slots": [],
    "path": "./plugins/views/settings-item-data/index.mjs",
    "dir": "plugins/views/settings-item-data"
  },
  {
    "id": "settings-item-general",
    "version": "1.0.0",
    "displayName": "设置项 · 通用",
    "description": "设置页 · 应用行为与基础偏好。",
    "author": "念风内核",
    "core": true,
    "enabled": true,
    "icon": "🔧",
    "unavailable": false,
    "unavailableReason": "",
    "depends": {
      "config": ">=1.1.0",
      "i18n": ">=2.0.0",
      "settings-container": "^1.0.0"
    },
    "optionalDepends": {},
    "inject": [
      "settings-container",
      "config",
      "i18n"
    ],
    "provides": [],
    "permissions": [],
    "slots": [],
    "path": "./plugins/views/settings-item-general/index.mjs",
    "dir": "plugins/views/settings-item-general"
  },
  {
    "id": "settings-item-logs",
    "version": "1.0.0",
    "displayName": "视图 · 运行日志",
    "description": "独立运行日志视图：模型调用阶段、工具 / 渠道消息 / 权限确认与后端运行日志。",
    "author": "念风内核",
    "core": false,
    "enabled": true,
    "icon": "📝",
    "unavailable": false,
    "unavailableReason": "",
    "depends": {
      "event-bus": "*",
      "view-router": "^1.0.0"
    },
    "optionalDepends": {
      "backend-client": ">=1.0.0",
      "config": ">=1.1.0",
      "logger": "^1.0.0",
      "toast-host": ">=1.0.0"
    },
    "inject": [
      "view-router",
      "logs?",
      "api?",
      "event-bus",
      "config?",
      "toast?"
    ],
    "provides": [],
    "permissions": [],
    "slots": [],
    "path": "./plugins/views/settings-item-logs/index.mjs",
    "dir": "plugins/views/settings-item-logs"
  },
  {
    "id": "settings-item-model",
    "version": "4.2.0",
    "displayName": "设置项 · 模型",
    "description": "设置页 · 内置模型开关与自定义提供商管理。",
    "author": "念风内核",
    "core": true,
    "enabled": true,
    "icon": "🤖",
    "unavailable": false,
    "unavailableReason": "",
    "depends": {
      "backend-client": "^1.0.0",
      "config": ">=1.1.0",
      "modal-host": ">=1.0.0",
      "model-registry": ">=1.0.0",
      "settings-container": "^1.0.0",
      "toast-host": ">=1.0.0"
    },
    "optionalDepends": {
      "model-adapter-backend": ">=2.0.0",
      "channel-registry": ">=1.0.0"
    },
    "inject": [
      "settings-container",
      "api",
      "model-registry",
      "model-adapter?",
      "config",
      "toast",
      "modal",
      "channel-registry?"
    ],
    "provides": [],
    "permissions": [
      "network"
    ],
    "slots": [],
    "path": "./plugins/views/settings-item-model/index.mjs",
    "dir": "plugins/views/settings-item-model"
  },
  {
    "id": "settings-item-network",
    "version": "2.1.0",
    "displayName": "设置项 · 网络",
    "description": "设置页 · 后端连接状态与模型请求超时。",
    "author": "念风内核",
    "core": false,
    "enabled": true,
    "icon": "🌐",
    "unavailable": false,
    "unavailableReason": "",
    "depends": {
      "backend-client": ">=1.0.0",
      "config": "^1.0.0",
      "event-bus": "*",
      "modal-host": ">=1.0.0",
      "permissions": "^1.0.0",
      "settings-container": "^1.0.0",
      "toast-host": ">=1.0.0"
    },
    "optionalDepends": {},
    "inject": [
      "settings-container",
      "api",
      "config",
      "toast",
      "event-bus",
      "modal"
    ],
    "provides": [],
    "permissions": [
      "network"
    ],
    "slots": [],
    "path": "./plugins/views/settings-item-network/index.mjs",
    "dir": "plugins/views/settings-item-network"
  },
  {
    "id": "settings-item-notifications",
    "version": "2.1.0",
    "displayName": "设置项 · 通知",
    "description": "设置页 · 消息提醒、系统通知权限、提示音与测试。",
    "author": "念风内核",
    "core": false,
    "enabled": true,
    "icon": "🔔",
    "unavailable": false,
    "unavailableReason": "",
    "depends": {
      "config": ">=1.1.0",
      "event-bus": "*",
      "notification": "^2.1.0",
      "permissions": "^1.0.0",
      "settings-container": "^1.0.0",
      "toast-host": ">=1.0.0"
    },
    "optionalDepends": {},
    "inject": [
      "settings-container",
      "notification",
      "config",
      "toast",
      "event-bus"
    ],
    "provides": [],
    "permissions": [
      "notify"
    ],
    "slots": [],
    "path": "./plugins/views/settings-item-notifications/index.mjs",
    "dir": "plugins/views/settings-item-notifications"
  },
  {
    "id": "settings-item-plugin-scope",
    "version": "1.0.0",
    "displayName": "设置项 · 插件启用",
    "description": "设置页 · 按角色 / 渠道控制外部插件的启用范围。",
    "author": "念风内核",
    "core": true,
    "enabled": true,
    "icon": "🎛️",
    "unavailable": false,
    "unavailableReason": "",
    "depends": {
      "plugin-manager": "^1.0.0",
      "plugin-scope": "^1.0.0",
      "settings-container": "^1.0.0",
      "toast-host": ">=1.0.0"
    },
    "optionalDepends": {},
    "inject": [
      "settings-container",
      "plugin-manager",
      "plugin-scope",
      "toast"
    ],
    "provides": [],
    "permissions": [],
    "slots": [],
    "path": "./plugins/views/settings-item-plugin-scope/index.mjs",
    "dir": "plugins/views/settings-item-plugin-scope"
  },
  {
    "id": "settings-item-plugins",
    "version": "3.1.0",
    "displayName": "设置项 · 插件",
    "description": "设置页 · 插件自检、健康状态、启停与详情。",
    "author": "念风内核",
    "core": true,
    "enabled": true,
    "icon": "🧰",
    "unavailable": false,
    "unavailableReason": "",
    "depends": {
      "backend-client": ">=1.0.0",
      "modal-host": ">=1.0.0",
      "plugin-manager": "^1.0.0",
      "plugin-scope": "^1.0.0",
      "settings-container": "^1.0.0",
      "toast-host": ">=1.0.0"
    },
    "optionalDepends": {},
    "inject": [
      "settings-container",
      "plugin-manager",
      "plugin-scope",
      "toast",
      "modal",
      "api"
    ],
    "provides": [],
    "permissions": [],
    "slots": [],
    "path": "./plugins/views/settings-item-plugins/index.mjs",
    "dir": "plugins/views/settings-item-plugins"
  },
  {
    "id": "settings-item-privacy",
    "version": "3.0.0",
    "displayName": "设置项 · 隐私",
    "description": "设置页 · 插件权限预设、按插件授权与本地数据说明。",
    "author": "念风内核",
    "core": false,
    "enabled": true,
    "icon": "🛡️",
    "unavailable": false,
    "unavailableReason": "",
    "depends": {
      "permissions": "^1.0.0",
      "settings-container": "^1.0.0",
      "toast-host": ">=1.0.0"
    },
    "optionalDepends": {},
    "inject": [
      "settings-container",
      "permissions",
      "toast"
    ],
    "provides": [],
    "permissions": [],
    "slots": [],
    "path": "./plugins/views/settings-item-privacy/index.mjs",
    "dir": "plugins/views/settings-item-privacy"
  },
  {
    "id": "settings-item-shortcuts",
    "version": "1.0.0",
    "displayName": "设置项 · 快捷键",
    "description": "设置页 · 快捷键列表与冲突提示。",
    "author": "念风内核",
    "core": true,
    "enabled": true,
    "icon": "⌨️",
    "unavailable": false,
    "unavailableReason": "",
    "depends": {
      "event-bus": "*",
      "keyboard-shortcuts": "^1.0.0",
      "settings-container": "^1.0.0"
    },
    "optionalDepends": {},
    "inject": [
      "settings-container",
      "shortcuts",
      "event-bus"
    ],
    "provides": [],
    "permissions": [],
    "slots": [],
    "path": "./plugins/views/settings-item-shortcuts/index.mjs",
    "dir": "plugins/views/settings-item-shortcuts"
  },
  {
    "id": "settings-item-theme",
    "version": "1.0.0",
    "displayName": "设置项 · 外观",
    "description": "设置页 · 主题、背景与界面细节，支持插件继续追加区块。",
    "author": "念风内核",
    "core": true,
    "enabled": true,
    "icon": "🎨",
    "unavailable": false,
    "unavailableReason": "",
    "depends": {
      "bg-provider": "^1.0.0",
      "config": ">=1.1.0",
      "event-bus": "*",
      "settings-container": "^1.0.0",
      "theme-tokens": "^1.0.0",
      "toast-host": ">=1.0.0"
    },
    "optionalDepends": {},
    "inject": [
      "settings-container",
      "theme",
      "bg-provider",
      "theme-tokens",
      "config",
      "event-bus",
      "toast"
    ],
    "provides": [
      {
        "name": "appearance-page",
        "type": "singleton"
      }
    ],
    "permissions": [],
    "slots": [],
    "path": "./plugins/views/settings-item-theme/index.mjs",
    "dir": "plugins/views/settings-item-theme"
  },
  {
    "id": "settings-item-unimplemented",
    "version": "1.0.0",
    "displayName": "设置项 · 未实现清单",
    "description": "设置页 · 如实列出尚未实现的功能与原因。",
    "author": "念风内核",
    "core": false,
    "enabled": true,
    "icon": "🚧",
    "unavailable": false,
    "unavailableReason": "",
    "depends": {
      "settings-container": "^1.0.0"
    },
    "optionalDepends": {},
    "inject": [
      "settings-container"
    ],
    "provides": [],
    "permissions": [],
    "slots": [],
    "path": "./plugins/views/settings-item-unimplemented/index.mjs",
    "dir": "plugins/views/settings-item-unimplemented"
  },
  {
    "id": "settings-view",
    "version": "1.0.0",
    "displayName": "设置视图",
    "description": "视觉内容 · 设置页外壳、导航槽与内容槽。",
    "author": "念风内核",
    "core": true,
    "enabled": true,
    "icon": "⚙️",
    "unavailable": false,
    "unavailableReason": "",
    "depends": {
      "app-shell": "^1.0.0",
      "event-bus": "*",
      "slots": "*"
    },
    "optionalDepends": {},
    "inject": [
      "slots",
      "event-bus"
    ],
    "provides": [
      {
        "name": "settings-view",
        "type": "singleton"
      }
    ],
    "permissions": [],
    "slots": [],
    "path": "./plugins/views/settings-view/index.mjs",
    "dir": "plugins/views/settings-view"
  },
  {
    "id": "user-widget",
    "version": "1.1.0",
    "displayName": "用户信息",
    "description": "顶层栏内容 · 用户头像（可更换）与可编辑签名。",
    "author": "念风内核",
    "core": true,
    "enabled": true,
    "icon": "🙋",
    "unavailable": false,
    "unavailableReason": "",
    "depends": {
      "config": "^1.0.0",
      "slots": "*",
      "titlebar": "^1.0.0"
    },
    "optionalDepends": {},
    "inject": [
      "slots",
      "config"
    ],
    "provides": [],
    "permissions": [],
    "slots": [],
    "path": "./plugins/views/user-widget/index.mjs",
    "dir": "plugins/views/user-widget"
  },
  {
    "id": "win-buttons",
    "version": "1.0.0",
    "displayName": "窗口按钮",
    "description": "顶层栏内容 · 最小化 / 最大化 / 关闭。",
    "author": "念风内核",
    "core": true,
    "enabled": true,
    "icon": "🔲",
    "unavailable": false,
    "unavailableReason": "",
    "depends": {
      "slots": "*",
      "titlebar": "^1.0.0",
      "toast-host": ">=1.0.0"
    },
    "optionalDepends": {},
    "inject": [
      "slots",
      "toast"
    ],
    "provides": [],
    "permissions": [],
    "slots": [],
    "path": "./plugins/views/win-buttons/index.mjs",
    "dir": "plugins/views/win-buttons"
  }
]

export default plugins
