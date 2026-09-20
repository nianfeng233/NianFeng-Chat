/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/** welcome-view 样式：首次启动欢迎页（项目介绍 / 官方资源 / 免费开源声明）。 */
export const WELCOME_CSS = `
  .welcome-page{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;padding:30px 44px 52px 40px;}
  .welcome-inner{width:100%;max-width:1040px;margin:0 auto;}

  .welcome-hero{display:flex;align-items:center;gap:20px;padding:6px 2px 26px;}
  .welcome-logo{
    width:76px;height:76px;flex:0 0 76px;border-radius:20px;object-fit:cover;
    border:1px solid rgba(255,255,255,.72);
    background:rgba(255,255,255,.5);
    box-shadow:0 10px 24px rgba(70,120,50,.16);
  }
  .welcome-headline{min-width:0;}
  .welcome-kicker{font-size:10.5px;font-weight:700;letter-spacing:.24em;text-transform:uppercase;color:#70a15a;}
  .welcome-title{margin:5px 0 6px;font-size:26px;line-height:1.2;font-weight:700;color:var(--text);letter-spacing:.01em;}
  .welcome-sub{margin:0;font-size:13px;line-height:1.8;color:var(--text-2);}
  .welcome-tags{display:flex;flex-wrap:wrap;gap:6px;margin-top:12px;}
  .welcome-tag{
    display:inline-flex;align-items:center;height:22px;padding:0 9px;border-radius:999px;
    border:1px solid var(--border);background:rgba(255,255,255,.56);
    color:var(--text-3);font-size:11px;white-space:nowrap;
  }
  .welcome-tag.accent{border-color:rgba(112,161,90,.34);background:rgba(237,247,231,.78);color:#5c8a45;}
  .welcome-firstrun-tip{margin:0 0 22px 2px;font-size:11.5px;line-height:1.7;color:var(--text-4);}

  .welcome-section{margin-top:24px;}
  .welcome-section-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:11px;}
  .welcome-section-title{font-size:14.5px;font-weight:700;color:var(--text);}
  .welcome-section-desc{font-size:11.5px;color:var(--text-4);}

  .welcome-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(235px,1fr));gap:12px;}
  .welcome-card{
    border:1px solid var(--border);border-radius:14px;background:rgba(255,255,255,.44);
    padding:16px 17px 17px;
    transition:border-color .16s ease,box-shadow .16s ease,transform .16s ease;
  }
  .welcome-card:hover{border-color:var(--accent-soft-2);box-shadow:0 10px 24px rgba(31,41,55,.06);transform:translateY(-1px);}
  .welcome-card-icon{
    display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;flex:0 0 30px;
    border-radius:10px;background:rgba(237,247,231,.9);font-size:16px;line-height:1;margin-bottom:10px;
  }
  .welcome-card-title{margin:0 0 7px;font-size:13.5px;font-weight:700;color:var(--text);}
  .welcome-card-text{margin:0;font-size:12.5px;line-height:1.8;color:var(--text-3);}

  .welcome-resource-card{display:flex;flex-direction:column;align-items:flex-start;gap:10px;}
  .welcome-resource-head{display:flex;align-items:flex-start;gap:11px;}
  .welcome-resource-head .welcome-card-icon{margin-bottom:0;}
  .welcome-resource-head .welcome-card-title{margin-bottom:2px;}
  .welcome-resource-desc{margin:0;font-size:11.5px;line-height:1.7;color:var(--text-4);}
  .welcome-link{font-size:12.5px;line-height:1.7;color:var(--accent);text-decoration:none;word-break:break-all;}
  .welcome-link:hover{text-decoration:underline;}
  .welcome-link:visited{color:var(--accent);}
  .welcome-qq{font-family:Consolas,"Cascadia Mono",ui-monospace,SFMono-Regular,Menlo,monospace;font-size:22px;font-weight:700;line-height:1.2;letter-spacing:.04em;color:var(--text);}
  .welcome-copy{
    height:28px;padding:0 12px;border-radius:8px;cursor:pointer;
    border:1px solid var(--border-strong);background:rgba(255,255,255,.8);
    color:var(--text-2);font:inherit;font-size:11.5px;
    transition:color .15s ease,border-color .15s ease,background .15s ease;
  }
  .welcome-copy:hover{color:var(--accent);border-color:var(--accent-soft-2);background:var(--accent-soft);}
  .welcome-copy.copied{color:#5c8a45;border-color:rgba(112,161,90,.4);background:rgba(237,247,231,.9);}

  .welcome-notice{
    border:1px solid rgba(112,161,90,.36);border-radius:16px;padding:20px 22px;
    background:linear-gradient(135deg,rgba(237,247,231,.92),rgba(255,255,255,.6));
    box-shadow:inset 0 1px 0 rgba(255,255,255,.8);
  }
  .welcome-notice-title{display:flex;align-items:center;gap:9px;flex-wrap:wrap;margin-bottom:11px;}
  .welcome-notice-badge{
    display:inline-flex;align-items:center;height:22px;padding:0 10px;border-radius:999px;
    background:#70a15a;color:#fff;font-size:11px;font-weight:700;letter-spacing:.06em;
  }
  .welcome-notice-title h2{margin:0;font-size:15px;font-weight:700;color:var(--text);}
  .welcome-notice p{margin:0 0 9px;font-size:12.5px;line-height:1.85;color:var(--text-2);}
  .welcome-notice-warn{color:#c65b5b;font-weight:700;}
  .welcome-notice-list{margin:2px 0 0;padding-left:18px;font-size:12.5px;line-height:1.95;color:var(--text-2);}
  .welcome-notice-list li::marker{color:#70a15a;}

  .welcome-footer{
    display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;
    margin-top:30px;padding-top:14px;border-top:1px dashed var(--border);
    font-size:11.5px;color:var(--text-4);
  }

  html[data-theme="dark"] .welcome-tag,
  html[data-theme="dark"] .welcome-card,
  html[data-theme="dark"] .welcome-copy{background:rgba(255,255,255,.06);border-color:rgba(255,255,255,.12);}
  html[data-theme="dark"] .welcome-tag.accent{background:rgba(112,161,90,.16);border-color:rgba(112,161,90,.3);color:#a8cf8f;}
  html[data-theme="dark"] .welcome-card-icon{background:rgba(112,161,90,.16);}
  html[data-theme="dark"] .welcome-notice{
    border-color:rgba(112,161,90,.3);
    background:linear-gradient(135deg,rgba(112,161,90,.14),rgba(255,255,255,.04));
    box-shadow:none;
  }
  html[data-theme="dark"] .welcome-link{color:#9ecbff;}
  html[data-theme="dark"] .welcome-copy.copied{color:#b8d9a6;border-color:rgba(112,161,90,.38);background:rgba(112,161,90,.18);}

  @media(max-width:820px){
    .welcome-page{padding:20px 16px 40px;}
    .welcome-hero{align-items:flex-start;gap:14px;padding-bottom:20px;}
    .welcome-logo{width:58px;height:58px;flex-basis:58px;border-radius:16px;}
    .welcome-title{font-size:21px;}
    .welcome-footer{flex-direction:column;align-items:flex-start;}
  }
  @media(max-width:480px){
    .welcome-hero{flex-direction:column;}
  }
`
