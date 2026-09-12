/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/** chat-header 样式 */
export const CHAT_HEADER_CSS = `
  .chat-header{
    height:58px;flex:0 0 58px;display:flex;align-items:center;gap:12px;
    padding:0 20px;border-bottom:1px solid var(--border);
    background:transparent;
  }
  .chat-title{font-size:15px;font-weight:600;color:var(--text);letter-spacing:.2px;}
  .chat-sub{
    font-size:12px;color:var(--text-3);margin-left:2px;
    display:inline-flex;align-items:center;gap:5px;
    transition:color .15s ease;white-space:nowrap;
  }
  .chat-sub.idle{color:var(--text-4);}
  .chat-sub.thinking{color:#8a6d1f;}
  .chat-sub.tool{color:#3b6cf6;}
  .chat-sub.typing{color:#2f9e44;}
  .chat-sub[data-live="1"]::before{
    content:'';width:6px;height:6px;border-radius:50%;background:currentColor;
    animation:chat-status-pulse 1.15s ease-in-out infinite;
  }
  @keyframes chat-status-pulse{0%,100%{opacity:.35;transform:scale(.82)}50%{opacity:1;transform:scale(1.08)}}
  html[data-theme="dark"] .chat-sub.thinking{color:#d9b84a;}
  html[data-theme="dark"] .chat-sub.tool{color:#7da2ff;}
  html[data-theme="dark"] .chat-sub.typing{color:#69cf7d;}
  .chat-actions{margin-left:auto;display:flex;gap:2px;}
  .icon-btn{
    width:34px;height:34px;border:none;background:transparent;border-radius:9px;
    color:var(--text-3);cursor:pointer;display:flex;align-items:center;justify-content:center;
    transition:background .14s ease, color .14s ease;
  }
  .icon-btn:hover{background:rgba(255,255,255,.78);color:var(--text);}
  .icon-btn svg{width:18px;height:18px;}
`
