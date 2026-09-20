/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/** market-view 样式：插件市场列表、排序、源管理与详情面板。 */
export const MARKET_CSS = `
  .market-page{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;padding:26px 36px 46px 32px;}
  .market-inner{width:100%;max-width:1180px;margin:0 auto;}
  .market-header{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;flex-wrap:wrap;margin-bottom:14px;}
  .market-title{font-size:21px;font-weight:700;color:var(--text);letter-spacing:.01em;}
  .market-sub{margin-top:5px;font-size:12px;line-height:1.7;color:var(--text-4);max-width:720px;}
  .market-header-actions{display:flex;align-items:center;gap:7px;flex-wrap:wrap;}
  .market-source-select,.market-select,.market-search{
    height:32px;border:1px solid rgba(0,0,0,.1);background:rgba(255,255,255,.86);border-radius:8px;
    padding:0 9px;color:var(--text);font:inherit;font-size:12px;outline:none;box-sizing:border-box;
  }
  .market-source-select{max-width:210px;}
  .market-search{flex:1 1 230px;min-width:160px;}
  .market-source-select:focus,.market-select:focus,.market-search:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft);}
  .market-btn{
    height:32px;padding:0 12px;border-radius:8px;border:1px solid var(--border-strong);
    background:rgba(255,255,255,.82);color:var(--text-2);font:inherit;font-size:12px;cursor:pointer;
    transition:all .15s ease;white-space:nowrap;
  }
  .market-btn:hover{color:var(--accent);border-color:var(--accent-soft-2);background:var(--accent-soft);}
  .market-btn:disabled{opacity:.55;cursor:not-allowed;color:var(--text-4);background:rgba(255,255,255,.5);border-color:var(--border);}
  .market-btn.primary{background:var(--accent);border-color:var(--accent);color:#fff;}
  .market-btn.primary:hover{background:var(--accent-hover);color:#fff;}
  .market-btn.danger{color:#c65b5b;border-color:rgba(198,91,91,.35);background:rgba(198,91,91,.06);}
  .market-btn.danger:hover{background:rgba(198,91,91,.12);color:#c65b5b;}

  .market-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:4px 0 12px;}
  .market-stats{font-size:11.5px;color:var(--text-4);margin-left:auto;white-space:nowrap;}
  .market-warning{margin-bottom:10px;padding:9px 11px;border-radius:9px;border:1px solid rgba(198,91,91,.3);background:rgba(198,91,91,.07);color:#c65b5b;font-size:11.5px;line-height:1.7;}

  .market-list{display:flex;flex-direction:column;gap:10px;min-height:120px;}
  .market-card{
    border:1px solid var(--border);border-radius:14px;background:rgba(255,255,255,.44);
    padding:14px 16px;transition:border-color .15s ease,box-shadow .15s ease;
  }
  .market-card:hover{border-color:var(--accent-soft-2);box-shadow:0 8px 22px rgba(31,41,55,.06);}
  .market-card-head{display:flex;align-items:flex-start;gap:12px;}
  .market-card-icon{
    width:40px;height:40px;flex:0 0 40px;border-radius:12px;display:flex;align-items:center;justify-content:center;
    background:rgba(237,247,231,.9);font-size:20px;line-height:1;
  }
  .market-card-main{flex:1;min-width:0;}
  .market-card-title{display:flex;align-items:center;gap:7px;flex-wrap:wrap;font-size:13.5px;font-weight:700;color:var(--text);}
  .market-id{font-size:11px;font-weight:500;color:var(--text-4);font-family:Consolas,"Cascadia Mono",ui-monospace,monospace;}
  .market-card-meta{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:5px;font-size:11px;color:var(--text-4);}
  .market-card-desc{margin-top:6px;font-size:12.5px;line-height:1.8;color:var(--text-3);word-break:break-word;}
  .market-card-tags{display:flex;flex-wrap:wrap;gap:5px;margin-top:8px;}
  .market-tag{display:inline-flex;align-items:center;height:19px;padding:0 8px;border-radius:999px;background:rgba(255,255,255,.6);border:1px solid var(--border);color:var(--text-3);font-size:10.5px;}
  .market-tag.good{color:#5c8a45;border-color:rgba(112,161,90,.34);background:rgba(237,247,231,.78);}
  .market-tag.warn{color:#c65b5b;border-color:rgba(198,91,91,.32);background:rgba(198,91,91,.07);}
  .market-card-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap;justify-content:flex-end;flex:0 0 auto;}
  .market-link{font-size:11.5px;color:var(--accent);text-decoration:none;white-space:nowrap;}
  .market-link:hover{text-decoration:underline;}

  .market-loading,.market-empty,.market-error{
    padding:46px 20px;text-align:center;border:1px dashed var(--border);border-radius:14px;
    color:var(--text-4);font-size:12.5px;line-height:1.9;background:rgba(255,255,255,.22);
  }
  .market-error{color:#c65b5b;border-color:rgba(198,91,91,.26);}
  .market-pager{display:flex;align-items:center;justify-content:center;gap:10px;padding:16px 0 4px;font-size:12px;color:var(--text-3);}

  .market-detail-mask{
    position:fixed;inset:0;z-index:200;display:flex;align-items:center;justify-content:center;
    padding:34px;background:rgba(20,26,18,.36);backdrop-filter:blur(3px);
  }
  .market-detail-mask[hidden]{display:none !important;}
  .market-detail{
    width:min(900px,94vw);max-height:84vh;display:flex;flex-direction:column;
    border-radius:18px;border:1px solid var(--glass-border);background:rgba(255,255,255,.97);
    box-shadow:var(--shadow-lg);overflow:hidden;color:var(--text);
  }
  .market-detail-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:17px 19px 12px;border-bottom:1px solid var(--border);}
  .market-detail-title{font-size:15px;font-weight:700;color:var(--text);}
  .market-detail-sub{margin-top:4px;font-size:11.5px;color:var(--text-4);}
  .market-icon-btn{width:28px;height:28px;border:0;border-radius:8px;background:rgba(0,0,0,.045);color:var(--text-3);font-size:18px;line-height:1;cursor:pointer;}
  .market-icon-btn:hover{background:rgba(0,0,0,.08);color:var(--text);}
  .market-detail-meta{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:10px 19px 0;font-size:11.5px;color:var(--text-3);}
  .market-detail-body{flex:1;min-height:120px;overflow:auto;padding:12px 19px 18px;font-size:12.5px;line-height:1.85;}
  .market-detail-body .md-h1,.market-detail-body .md-h2,.market-detail-body .md-h3{font-weight:700;color:var(--text);margin:14px 0 6px;}
  .market-detail-body .md-p{margin:5px 0;}
  .market-detail-body .md-list{margin:6px 0;padding-left:20px;}
  .market-detail-body .md-code{margin:8px 0;padding:9px 11px;border-radius:9px;background:rgba(0,0,0,.055);overflow:auto;}
  .market-detail-body .md-inline{padding:1px 4px;border-radius:4px;background:rgba(0,0,0,.055);}
  .market-detail-body blockquote{margin:7px 0;padding:5px 10px;border-left:3px solid var(--accent-soft-2);color:var(--text-3);}
  .market-readme-plain{margin:0;white-space:pre-wrap;word-break:break-word;font-family:Consolas,"Cascadia Mono",ui-monospace,monospace;font-size:12px;line-height:1.75;color:var(--text-2);}
  .market-detail-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:11px 19px 15px;border-top:1px solid var(--border);flex-wrap:wrap;}

  html[data-theme="dark"] .market-source-select,
  html[data-theme="dark"] .market-select,
  html[data-theme="dark"] .market-search,
  html[data-theme="dark"] .market-btn,
  html[data-theme="dark"] .market-card,
  html[data-theme="dark"] .market-tag{background:rgba(255,255,255,.06);border-color:rgba(255,255,255,.12);color:var(--text-2);}
  html[data-theme="dark"] .market-card-icon{background:rgba(112,161,90,.16);}
  html[data-theme="dark"] .market-detail{background:rgba(28,33,26,.98);border-color:rgba(255,255,255,.1);}
  html[data-theme="dark"] .market-detail-body .md-code,
  html[data-theme="dark"] .market-detail-body .md-inline{background:rgba(255,255,255,.08);}
  html[data-theme="dark"] .market-icon-btn{background:rgba(255,255,255,.08);color:var(--text-2);}
  html[data-theme="dark"] .market-tag.good{background:rgba(112,161,90,.16);border-color:rgba(112,161,90,.3);color:#a8cf8f;}
  html[data-theme="dark"] .market-tag.warn{background:rgba(198,91,91,.12);border-color:rgba(198,91,91,.3);color:#e0a0a0;}

  @media(max-width:820px){
    .market-page{padding:18px 14px 38px;}
    .market-card-head{flex-wrap:wrap;}
    .market-card-actions{width:100%;justify-content:flex-start;}
    .market-stats{margin-left:0;width:100%;}
    .market-detail-mask{padding:12px;}
    .market-detail{width:100%;max-height:92vh;}
  }
`
