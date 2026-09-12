/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/** notification 样式：右下角通知中心，按系统通知 / 角色消息 / 其他通知三种样式渲染 */
export const NOTIFICATION_CSS = `
  .notify-center{
    position:fixed;right:18px;bottom:18px;z-index:520;
    display:flex;flex-direction:column;align-items:stretch;gap:10px;
    width:min(360px, calc(100vw - 36px));
    pointer-events:none;
  }
  .notify-card{
    pointer-events:auto;position:relative;
    display:flex;align-items:flex-start;gap:10px;
    padding:12px 34px 12px 12px;
    background:rgba(255,255,255,.96);
    -webkit-backdrop-filter:blur(16px);backdrop-filter:blur(16px);
    border:1px solid rgba(255,255,255,.75);border-radius:13px;
    box-shadow:0 14px 36px rgba(30,60,20,.18), 0 2px 8px rgba(30,60,20,.07);
    color:var(--text);
    opacity:0;transform:translateY(10px);
    transition:opacity .22s ease, transform .22s ease;
    cursor:pointer;overflow:hidden;
  }
  .notify-card.show{opacity:1;transform:none;}
  .notify-card::before{
    content:'';position:absolute;left:0;top:0;bottom:0;width:3px;
    background:var(--accent);
  }
  .notify-card.notify-kind-character::before{background:#70a15a;}
  .notify-card.notify-kind-other::before{background:#c9a227;}
  .notify-avatar{
    width:38px;height:38px;flex:0 0 38px;border-radius:50%;
    display:flex;align-items:center;justify-content:center;
    color:#fff;font-size:14px;font-weight:700;overflow:hidden;
    background:linear-gradient(135deg,var(--c1,#b9c2cf),var(--c2,#8d99ab));
    background-size:cover;background-position:center;
  }
  .notify-avatar.avatar-img{color:transparent;}
  .notify-logo{
    width:38px;height:38px;flex:0 0 38px;border-radius:50%;
    display:flex;align-items:center;justify-content:center;
    background:rgba(255,255,255,.92);
    border:1px solid rgba(0,0,0,.06);overflow:hidden;
  }
  .notify-logo img{width:100%;height:100%;object-fit:contain;display:block;padding:4px;box-sizing:border-box;}
  .notify-emoji{
    width:38px;height:38px;flex:0 0 38px;border-radius:50%;
    display:flex;align-items:center;justify-content:center;
    background:var(--accent-soft);color:var(--accent);
  }
  .notify-emoji svg{width:19px;height:19px;}
  .notify-body{flex:1 1 auto;min-width:0;}
  .notify-title{
    font-size:12.5px;font-weight:700;color:var(--text);
    line-height:1.35;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  }
  .notify-desc{
    margin-top:3px;font-size:12px;color:var(--text-3);line-height:1.5;
    word-break:break-word;
    display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;
  }
  .notify-close{
    position:absolute;top:6px;right:7px;
    width:22px;height:22px;border:0;border-radius:7px;
    background:transparent;color:var(--text-4);font-size:14px;line-height:1;
    cursor:pointer;display:flex;align-items:center;justify-content:center;
  }
  .notify-close:hover{background:rgba(0,0,0,.06);color:var(--text-2);}
`
