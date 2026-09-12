/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/** chat-view 骨架样式 */
export const CHAT_VIEW_CSS = `
  .chat-main{position:relative;}
  .chat-list-slot{flex:1;min-height:0;display:flex;flex-direction:column;}
  .chat-messages{flex:1 1 0;min-height:0;display:flex;flex-direction:column;}
  #chatMain > [data-slot="chat:composer"]{margin-top:auto;}
`
