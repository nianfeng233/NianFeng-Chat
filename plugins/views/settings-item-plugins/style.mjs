/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/** 插件管理页样式（取自 demo 的 plugin-toolbar / plugin-item） */
export const PLUGIN_PAGE_CSS = `
  .plugin-toolbar{display:flex;gap:8px;margin-bottom:14px;align-items:center;flex-wrap:wrap;}
  .plugin-toolbar-btn{
    height:34px;padding:0 14px;
    border:1px solid rgba(0,0,0,.09);background:rgba(255,255,255,.72);
    border-radius:8px;font:inherit;font-size:12.5px;color:var(--text);cursor:pointer;
    transition:background .14s, border-color .14s;
    display:inline-flex;align-items:center;gap:6px;
  }
  .plugin-toolbar-btn:hover{background:#fff;border-color:rgba(0,0,0,.15);}
  .plugin-toolbar-btn.primary{background:var(--accent);color:#fff;border-color:var(--accent);box-shadow:0 2px 8px rgba(59,108,246,.24);}
  .plugin-toolbar-btn.primary:hover{background:var(--accent-hover);}
  .plugin-toolbar-btn svg{width:14px;height:14px;}
  .plugin-toolbar-right{margin-left:auto;display:flex;align-items:center;gap:6px;font-size:12px;color:var(--text-3);}
  .plugin-sort-select{
    height:32px;border:1px solid rgba(0,0,0,.09);background:rgba(255,255,255,.72);
    border-radius:7px;padding:0 26px 0 10px;font:inherit;font-size:12px;color:var(--text);
    cursor:pointer;outline:none;-webkit-appearance:none;appearance:none;
    background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'><path d='M1 1l4 4 4-4' fill='none' stroke='%235c6370' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/></svg>");
    background-repeat:no-repeat;background-position:right 8px center;
  }
  .plugin-sort-order{
    width:32px;height:32px;border:1px solid rgba(0,0,0,.09);background:rgba(255,255,255,.72);
    border-radius:7px;cursor:pointer;font:inherit;font-size:13px;color:var(--text-2);
    display:inline-flex;align-items:center;justify-content:center;
  }
  .plugin-stats{font-size:11.5px;color:var(--text-3);margin-bottom:10px;}
  .plugin-list{display:flex;flex-direction:column;gap:8px;}
  .plugin-item{
    display:flex;align-items:center;gap:12px;padding:12px 14px;
    background:rgba(255,255,255,.72);border:1px solid rgba(0,0,0,.055);border-radius:12px;
    box-shadow:0 2px 8px rgba(30,60,20,.035);
    transition:border-color .14s, box-shadow .14s, opacity .14s;
  }
  .plugin-item:hover{border-color:rgba(0,0,0,.09);box-shadow:0 4px 12px rgba(30,60,20,.06);}
  .plugin-item.disabled{opacity:.56;}
  .plugin-item.core{background:rgba(255,255,255,.56);border-style:dashed;}
  .plugin-icon{
    width:40px;height:40px;flex:0 0 40px;border-radius:11px;
    background:linear-gradient(135deg,#edf7e7,#d9efcb);
    display:flex;align-items:center;justify-content:center;
    color:#70a15a;font-size:17px;box-shadow:inset 0 1px 0 rgba(255,255,255,.9);
    user-select:none;line-height:1;
  }
  .plugin-icon svg{width:18px;height:18px;}
  .plugin-icon.core{background:linear-gradient(135deg,#e7f0fb,#d3e5fa);color:#5a8dff;}
  .plugin-info{flex:1;min-width:0;}
  .plugin-name{font-size:13px;font-weight:500;color:var(--text);display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
  .plugin-id{
    font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10.5px;color:var(--text-3);
    background:rgba(0,0,0,.045);padding:1px 6px;border-radius:4px;font-weight:400;letter-spacing:.2px;
  }
  .plugin-tag{font-size:10.5px;padding:1px 6px;border-radius:4px;font-weight:500;}
  .plugin-tag.enabled{color:#70a15a;background:rgba(112,161,90,.12);}
  .plugin-tag.disabled{color:#999;background:rgba(0,0,0,.05);}
  .plugin-tag.core-tag{color:#5a8dff;background:rgba(90,141,255,.12);}
  .plugin-desc{
    font-size:11.5px;color:var(--text-3);margin-top:3px;line-height:1.45;word-break:break-word;
    display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;
  }
  .plugin-dev-meta{font-size:10.5px;color:var(--text-4);margin-top:3px;line-height:1.5;word-break:break-word;}
  /* ---------- 插件详情（rich modal） ---------- */
  .plugin-detail{display:flex;flex-direction:column;gap:14px;}
  .plugin-detail-hero{display:flex;align-items:flex-start;gap:13px;}
  .plugin-detail-icon{
    width:48px;height:48px;flex:0 0 48px;border-radius:14px;display:flex;align-items:center;justify-content:center;
    background:rgba(237,247,231,.9);font-size:23px;line-height:1;
  }
  .plugin-detail-icon.core{background:linear-gradient(135deg,#e7f0fb,#d3e5fa);}
  .plugin-detail-hero-main{flex:1;min-width:0;}
  .plugin-detail-name{font-size:17px;font-weight:700;color:var(--text);line-height:1.35;word-break:break-word;}
  .plugin-detail-badges{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:5px;}
  .plugin-detail-desc{margin-top:6px;font-size:12.5px;line-height:1.75;color:var(--text-3);word-break:break-word;}
  .plugin-detail-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:8px;}
  .plugin-detail-stat{
    border:1px solid var(--border);border-radius:10px;background:rgba(255,255,255,.52);
    padding:9px 11px;min-width:0;
  }
  .plugin-detail-stat span{display:block;font-size:10.5px;color:var(--text-4);margin-bottom:3px;}
  .plugin-detail-stat b{font-size:12.5px;font-weight:600;color:var(--text);word-break:break-word;}
  .plugin-detail-fallback{display:block;margin-top:2px;font-style:normal;font-size:10px;color:var(--text-4);}
  .plugin-detail-repo{grid-column:span 2;}
  .plugin-detail-link{font-size:12px;color:var(--accent);text-decoration:none;word-break:break-all;}
  .plugin-detail-link:hover{text-decoration:underline;}
  .plugin-detail-section{border-top:1px solid var(--border);padding-top:12px;}
  .plugin-detail-section-title{font-size:12.5px;font-weight:700;color:var(--text);margin-bottom:8px;}
  .plugin-detail-readme{font-size:12.5px;line-height:1.85;color:var(--text-2);word-break:break-word;}
  .plugin-detail-readme .md-h1,
  .plugin-detail-readme .md-h2,
  .plugin-detail-readme .md-h3,
  .plugin-detail-readme .md-h4{color:var(--text);font-weight:700;margin:13px 0 6px;}
  .plugin-detail-readme .md-p{margin:5px 0;}
  .plugin-detail-readme .md-list{margin:6px 0;padding-left:20px;}
  .plugin-detail-readme .md-code{margin:8px 0;padding:9px 11px;border-radius:9px;background:rgba(0,0,0,.055);overflow:auto;}
  .plugin-detail-readme .md-inline{padding:1px 4px;border-radius:4px;background:rgba(0,0,0,.055);}
  .plugin-detail-readme blockquote{margin:7px 0;padding:5px 10px;border-left:3px solid var(--accent-soft-2);color:var(--text-3);}
  .plugin-readme-plain{margin:0;white-space:pre-wrap;word-break:break-word;font-size:12px;line-height:1.75;color:var(--text-2);font-family:Consolas,"Cascadia Mono",ui-monospace,monospace;}
  .plugin-detail-empty{padding:24px 10px;text-align:center;border:1px dashed var(--border);border-radius:10px;color:var(--text-4);font-size:12px;}
  .plugin-detail-tech{border-top:1px dashed var(--border);padding-top:9px;font-size:11.5px;color:var(--text-3);}
  .plugin-detail-tech summary{cursor:pointer;user-select:none;color:var(--text-3);outline:none;}
  .plugin-detail-tech pre{
    margin:8px 0 0;padding:10px 11px;border-radius:10px;background:rgba(0,0,0,.045);
    white-space:pre-wrap;word-break:break-word;font-size:11px;line-height:1.7;color:var(--text-2);
    font-family:Consolas,"Cascadia Mono",ui-monospace,monospace;
  }
  html[data-theme="dark"] .plugin-detail-stat{background:rgba(255,255,255,.05);border-color:rgba(255,255,255,.1);}
  html[data-theme="dark"] .plugin-detail-icon{background:rgba(112,161,90,.16);}
  html[data-theme="dark"] .plugin-detail-icon.core{background:rgba(90,141,255,.16);}
  html[data-theme="dark"] .plugin-detail-readme .md-code,
  html[data-theme="dark"] .plugin-detail-readme .md-inline,
  html[data-theme="dark"] .plugin-detail-tech pre{background:rgba(255,255,255,.08);}
  .plugin-actions{flex:0 0 auto;display:flex;gap:6px;}
  .plugin-action-btn{
    height:30px;padding:0 11px;border:1px solid rgba(0,0,0,.09);background:#fff;border-radius:7px;
    font:inherit;font-size:11.5px;color:var(--text-2);cursor:pointer;
    display:inline-flex;align-items:center;gap:4px;white-space:nowrap;
    transition:background .14s, color .14s, border-color .14s;
  }
  .plugin-action-btn:hover{background:#f7f8f6;color:var(--text);}
  .plugin-action-btn.danger{color:#c65b5b;border-color:rgba(198,91,91,.2);}
  .plugin-action-btn.danger:hover{background:rgba(198,91,91,.06);color:#b54a4a;}
  .plugin-action-btn.primary{color:var(--accent);border-color:var(--accent-soft-2);background:var(--accent-soft);}
  .plugin-action-btn.primary:hover{background:var(--accent-soft-2);color:var(--accent-hover);}
  .plugin-core-hint{font-size:11.5px;color:var(--text-4);padding-right:4px;}
  html[data-theme="dark"] .plugin-item,
  html[data-theme="dark"] .plugin-action-btn,
  html[data-theme="dark"] .plugin-toolbar-btn{background:rgba(255,255,255,.06);color:var(--text);}
  /* ---------- 自检 / 健康状态 ---------- */
  .plugin-summary{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px;}
  .plugin-chip{
    display:inline-flex;align-items:center;gap:4px;
    height:24px;padding:0 9px;border-radius:7px;
    background:rgba(255,255,255,.7);border:1px solid rgba(0,0,0,.05);
    font-size:11.5px;color:var(--text-2);
  }
  .plugin-chip b{font-weight:600;color:var(--text);}
  .plugin-chip.ok{color:#70a15a;background:rgba(112,161,90,.1);border-color:transparent;}
  .plugin-chip.ok b{color:#4d7d3c;}
  .plugin-chip.warn{color:#a5721a;background:rgba(201,162,39,.12);border-color:transparent;}
  .plugin-chip.warn b{color:#8a5f10;}
  .plugin-chip.error{color:#c65b5b;background:rgba(198,91,91,.12);border-color:transparent;}
  .plugin-chip.error b{color:#a94343;}

  .plugin-tag.warn{color:#a5721a;background:rgba(201,162,39,.14);}
  .plugin-tag.error{color:#c65b5b;background:rgba(198,91,91,.14);}
  .plugin-health{font-size:11px;color:#70a15a;}

  .plugin-item.error{
    border-color:rgba(198,91,91,.45);
    background:rgba(255,244,244,.9);
    box-shadow:0 2px 10px rgba(198,91,91,.08);
  }
  .plugin-item.warning{
    border-color:rgba(201,162,39,.4);
    background:rgba(255,250,236,.85);
  }
  .plugin-item.disabled{opacity:.72;}
  .plugin-icon.error{background:linear-gradient(135deg,#fde8e8,#f8d3d3);color:#c65b5b;}

  .plugin-issue{font-size:11.5px;line-height:1.5;margin-top:4px;word-break:break-word;}
  .plugin-issue.error{color:#c0392b;}
  .plugin-issue.warning{color:#a5721a;}
  .plugin-issue.muted{color:var(--text-3);}
  .plugin-footnote{font-size:11px;color:var(--text-4);margin-top:14px;}
  html[data-theme="dark"] .plugin-item.error{background:rgba(198,91,91,.14);}
  html[data-theme="dark"] .plugin-item.warning{background:rgba(201,162,39,.12);}

  /* ---------- 插件目录卡片：输入框 / 按钮不再挤成一行 ---------- */
  .plugin-dirs{margin-bottom:4px;}
  .plugin-dirs .settings-section{padding:0;}
  .plugin-dirs .settings-section-title{margin:0 0 8px;}
  .plugin-dirs .settings-card{padding:14px 16px;display:flex;flex-direction:column;gap:12px;}
  .plugin-dirs .setting-row{padding:0;align-items:flex-start;gap:12px;}
  .plugin-dirs .setting-main{flex:0 1 300px;min-width:200px;}
  .plugin-dirs .setting-control.plugin-dir-controls{
    display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:flex-end;
    flex:1 1 360px;min-width:0;
  }
  .plugin-dirs .plugin-dir-input{flex:1 1 260px;min-width:180px;width:auto !important;}
  .plugin-dirs .plugin-dir-controls .outline-btn{white-space:nowrap;flex:0 0 auto;}
  .plugin-dirs .plugin-upload-btn{border-color:var(--accent-soft-2);background:var(--accent-soft);color:var(--accent);font-weight:500;}
  .plugin-dirs .plugin-upload-btn:hover{background:var(--accent-soft-2);color:var(--accent-hover);}
  @media (max-width:760px){
    .plugin-dirs .setting-row{flex-direction:column;gap:8px;}
    .plugin-dirs .setting-main,
    .plugin-dirs .setting-control.plugin-dir-controls{flex:1 1 auto;width:100%;justify-content:flex-start;}
  }
  html[data-theme="dark"] .plugin-chip{background:rgba(255,255,255,.06);}
  /* ---------- 新插件：默认启用范围选择 ---------- */
  .plugin-scope-prompt-mask{position:fixed;inset:0;z-index:1160;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(18,28,38,.34);backdrop-filter:blur(2px);}
  .plugin-scope-prompt{width:min(520px,94vw);padding:18px 20px;border-radius:16px;background:var(--panel-solid,#fff);box-shadow:0 24px 70px rgba(20,40,60,.3);display:flex;flex-direction:column;gap:12px;}
  .plugin-scope-prompt-title{font-size:15px;font-weight:650;color:var(--text);}
  .plugin-scope-prompt-desc{font-size:12.5px;line-height:1.7;color:var(--text-3);}
  .plugin-scope-prompt-actions{display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-end;}
"
`
