/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/** toast-host 样式（demo 没有 toast，这里按同一套玻璃语言补齐） */
export const TOAST_CSS = `
  .toast-wrap{
    position:fixed;right:18px;bottom:18px;z-index:400;
    display:flex;flex-direction:column;align-items:flex-end;gap:8px;
    pointer-events:none;
  }
  .toast{
    pointer-events:auto;
    display:flex;align-items:center;gap:10px;
    max-width:340px;padding:10px 14px;
    background:rgba(255,255,255,.94);
    -webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);
    border:1px solid rgba(255,255,255,.7);border-radius:11px;
    box-shadow:0 10px 28px rgba(30,60,20,.16), 0 2px 6px rgba(30,60,20,.06);
    font-size:12.5px;color:var(--text);
    opacity:0;transform:translateY(8px);
    transition:opacity .2s ease, transform .2s ease;
    cursor:default;
  }
  .toast.show{opacity:1;transform:none;}
  .toast-main{display:flex;align-items:flex-start;gap:8px;flex:1;min-width:0;}
  .toast-ico{display:inline-flex;width:16px;height:16px;flex:0 0 16px;margin-top:1px;}
  .toast-ico svg{width:16px;height:16px;}
  .toast-text{line-height:1.5;word-break:break-word;white-space:pre-wrap;}
  .toast-action{
    flex:0 0 auto;height:26px;padding:0 10px;border:0;border-radius:7px;
    background:var(--accent-soft);color:var(--accent);font:inherit;font-size:12px;cursor:pointer;
  }
  .toast-info .toast-ico{color:var(--accent);}
  .toast-success .toast-ico{color:#70a15a;}
  .toast-warn .toast-ico{color:#c9a227;}
  .toast-error .toast-ico{color:#c65b5b;}
  .toast-error{border-color:rgba(198,91,91,.28);}
`
