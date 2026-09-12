/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/** rail 样式 */
export const RAIL_CSS = `
  .rail{
    width:var(--rail-w);
    display:flex;flex-direction:column;align-items:center;
    padding:10px 0 8px;
    background:transparent;
    min-height:0;
  }
  .rail-top,.rail-middle,.rail-bottom{
    display:flex;flex-direction:column;gap:4px;align-items:center;
    width:100%;flex:0 0 auto;
  }
  .rail-middle{flex:1 1 auto;justify-content:flex-start;margin-top:6px;overflow-y:auto;overflow-x:hidden;}
  .rail-bottom{margin-top:auto;}
  .rail-middle::-webkit-scrollbar{width:0;}
  .rail-btn{
    width:38px;height:38px;
    border:none;background:transparent;border-radius:10px;
    display:flex;align-items:center;justify-content:center;
    color:var(--text-3);cursor:pointer;
    transition:background .18s ease, color .18s ease, transform .18s ease;
    position:relative;flex:0 0 auto;
  }
  .rail-btn svg{width:18px;height:18px;}
  .rail-btn:hover{background:rgba(255,255,255,.78);color:var(--text);}
  .rail-btn:active{transform:scale(.94);}
  .rail-btn.active{background:var(--accent-soft);color:var(--accent);}
  .rail-btn .rail-badge{
    position:absolute;top:6px;right:6px;
    min-width:8px;height:8px;border-radius:50%;
    background:#e0574c;box-shadow:0 0 0 2px rgba(255,255,255,.8);
  }
  html[data-theme="dark"] .rail-btn:hover{background:rgba(255,255,255,.1);}
`
