/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/** context-menu-host 样式：出自 demo 的 .context-menu / .menu-item */
export const CONTEXT_MENU_CSS = `
  .context-menu{
    position:fixed;min-width:148px;padding:5px;
    background:rgba(255,255,255,.95);
    -webkit-backdrop-filter: blur(14px);backdrop-filter: blur(14px);
    border:1px solid rgba(255,255,255,.6);border-radius:10px;
    box-shadow:var(--shadow-lg);
    display:none;z-index:200;
  }
  .context-menu.show{display:block;animation:menuIn .12s ease;}
  @keyframes menuIn{from{opacity:0;transform:translateY(-3px);}to{opacity:1;transform:none;}}
  .context-menu .menu-item{
    display:flex;align-items:center;gap:8px;
    padding:8px 12px;border-radius:6px;font-size:13px;color:var(--text);
    cursor:pointer;white-space:nowrap;transition:background .12s ease;
  }
  .context-menu .menu-item:hover{background:rgba(59,108,246,.1);}
  .context-menu .menu-item.disabled{color:#c7cbd1;cursor:not-allowed;}
  .context-menu .menu-item.disabled:hover{background:transparent;}
  .context-menu .menu-item.danger{color:#c65b5b;}
  .context-menu .menu-ico{display:inline-flex;width:15px;height:15px;color:currentColor;opacity:.85;}
  .context-menu .menu-ico svg{width:15px;height:15px;}
  .context-menu .menu-sep{height:1px;margin:5px 8px;background:var(--border);}
  .context-menu .menu-group{font-size:10.5px;font-weight:600;letter-spacing:.03em;color:var(--text-4);padding:7px 12px 3px;user-select:none}
`
