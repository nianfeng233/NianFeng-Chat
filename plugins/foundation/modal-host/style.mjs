/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/** modal-host 样式：出自 demo 的 .modal-* 与 .btn */
export const MODAL_CSS = `
  .modal-mask{
    position:fixed;inset:0;background:rgba(30,50,20,.24);
    /* 必须高于各渠道插件自己的遮罩（当前最高的渠道遮罩为 1200），
       否则「重新扫码绑定」这类二次确认会被压在接入弹窗下层。 */
    display:none;align-items:center;justify-content:center;z-index:1300;
    -webkit-backdrop-filter: blur(4px);backdrop-filter: blur(4px);
  }
  .modal-mask.show{display:flex;}
  .modal{
    width:380px;max-width:calc(100vw - 48px);
    background:#fff;border-radius:14px;
    padding:24px 26px 20px;
    box-shadow:var(--shadow-lg);
    animation:modalIn .18s cubic-bezier(.16,1,.3,1);
  }
  @keyframes modalIn{from{opacity:0;transform:translateY(-8px) scale(.97);}to{opacity:1;transform:none;}}
  .modal-title{font-size:15px;font-weight:600;text-align:center;margin-bottom:14px;}
  .modal-desc{font-size:12.5px;line-height:1.6;color:var(--text-3);text-align:center;margin:-8px 0 16px;white-space:pre-wrap;}
  .modal-input{
    width:100%;height:42px;border:1px solid var(--border-strong);border-radius:10px;
    padding:0 14px;font-size:13px;font-family:inherit;color:var(--text);
    outline:none;transition:border-color .16s ease, box-shadow .16s ease;
    background:transparent;box-sizing:border-box;
  }
  .modal-input::placeholder{color:var(--text-4);}
  .modal-input:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft-2);}
  .modal-actions{display:flex;gap:12px;margin-top:22px;}
  .modal .btn{
    flex:1;height:40px;border-radius:10px;border:1px solid var(--border-strong);background:#fff;
    font-size:13px;color:var(--text);cursor:pointer;font-family:inherit;
    transition:background .15s ease, border-color .15s ease, color .15s ease;
  }
  .modal .btn:hover{background:#f5f7f2;}
  .modal .btn.primary{background:var(--accent);border-color:var(--accent);color:#fff;}
  .modal .btn.primary:hover{background:var(--accent-hover);}
  .modal .btn.primary:disabled{background:#b8c9fb;border-color:#b8c9fb;cursor:not-allowed;}
`
