/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/** library-view 样式：记忆与知识库浏览页 */
export const LIBRARY_CSS = `
  .lib-page{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;padding:28px 42px 56px 38px;}
  .lib-header{display:flex;align-items:flex-start;justify-content:space-between;gap:18px;flex-wrap:wrap;margin-bottom:18px;}
  .lib-title{font-size:22px;font-weight:700;color:var(--text);letter-spacing:.02em;}
  .lib-sub{margin-top:6px;font-size:12.5px;color:var(--text-4);line-height:1.7;max-width:760px;}
  .lib-tabs{display:inline-flex;align-items:center;gap:4px;padding:4px;border-radius:12px;border:1px solid var(--border);background:rgba(255,255,255,.5);}
  .lib-tab{border:0;background:transparent;color:var(--text-3);font:inherit;font-size:13px;padding:7px 14px;border-radius:9px;cursor:pointer;white-space:nowrap;}
  .lib-tab:hover{color:var(--text);}
  .lib-tab.active{background:var(--accent-soft);color:var(--accent);font-weight:600;}
  .lib-panel[hidden]{display:none !important;}
  .lib-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:4px 0 14px;}
  .lib-toolbar select,.lib-toolbar input{height:34px;border:1px solid rgba(0,0,0,.09);background:rgba(255,255,255,.88);border-radius:9px;padding:0 10px;color:var(--text);font:inherit;font-size:12.5px;outline:none;box-sizing:border-box;}
  .lib-toolbar select:focus,.lib-toolbar input:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft);}
  .lib-toolbar [data-lib-memory-q],.lib-toolbar [data-lib-knowledge-q]{flex:1 1 190px;min-width:140px;}
  .lib-toolbar [data-lib-knowledge-path]{flex:0 1 170px;min-width:130px;}
  .lib-stats{font-size:11.5px;color:var(--text-4);margin-left:auto;white-space:nowrap;}
  .lib-list{display:flex;flex-direction:column;gap:10px;}
  .lib-empty{padding:54px 18px;text-align:center;border:1px dashed var(--border);border-radius:14px;color:var(--text-4);font-size:12.5px;line-height:1.9;background:rgba(255,255,255,.22);}
  .lib-empty b{color:var(--text-2);}
  .lib-card{border:1px solid var(--border);border-radius:14px;background:rgba(255,255,255,.42);overflow:hidden;transition:border-color .15s ease,box-shadow .15s ease;}
  .lib-card:hover{border-color:var(--accent-soft-2);}
  .lib-card.open{box-shadow:0 10px 26px rgba(31,41,55,.08);border-color:var(--accent-soft-2);}
  .lib-card-head{display:flex;align-items:flex-start;gap:12px;padding:14px 16px 12px;}
  .lib-card-main{flex:1;min-width:0;}
  .lib-card-title{font-size:13.5px;line-height:1.7;color:var(--text);word-break:break-word;}
  .lib-card-meta{margin-top:6px;font-size:11.5px;line-height:1.7;color:var(--text-4);word-break:break-word;}
  .lib-card-actions{display:flex;align-items:center;gap:6px;flex:0 0 auto;}
  .lib-card-detail{border-top:1px dashed var(--border);padding:14px 16px 16px;background:rgba(255,255,255,.22);}
  .lib-label{font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--text-4);margin:2px 0 8px;}
  .lib-summary-text{font-size:13px;line-height:1.85;color:var(--text);white-space:pre-wrap;word-break:break-word;}
  .lib-ball{display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:10px;background:rgba(255,255,255,.5);border:1px solid var(--border);font-size:12px;color:var(--text-3);line-height:1.6;word-break:break-word;}
  .lib-ball b{color:var(--text);font-weight:600;}
  .lib-message{border:1px solid var(--border);border-radius:11px;background:rgba(255,255,255,.56);padding:9px 11px;margin-top:8px;}
  .lib-message-assistant{background:rgba(237,247,231,.72);border-color:rgba(112,161,90,.28);}
  .lib-message-user{background:rgba(255,255,255,.72);}
  .lib-message-system{background:rgba(148,163,184,.12);}
  .lib-message-head{display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:11px;color:var(--text-4);margin-bottom:5px;}
  .lib-message-body{font-size:12.5px;line-height:1.8;color:var(--text);white-space:pre-wrap;word-break:break-word;}
  .lib-message-tags{display:flex;flex-wrap:wrap;gap:5px;margin-top:7px;}
  .lib-tag{display:inline-flex;align-items:center;padding:2px 8px;border-radius:999px;font-size:10.5px;line-height:1.6;color:var(--text-3);background:rgba(255,255,255,.66);border:1px solid var(--border);}
  .lib-tag.accent{color:var(--accent);background:var(--accent-soft);border-color:var(--accent-soft-2);}
  .lib-content{font-size:12.5px;line-height:1.85;color:var(--text);white-space:pre-wrap;word-break:break-word;max-height:520px;overflow:auto;padding:10px 12px;border:1px solid var(--border);border-radius:11px;background:rgba(255,255,255,.6);}
  .lib-detail-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:7px;margin:0 0 10px;}
  .lib-more{display:flex;justify-content:center;padding:16px 0 6px;}
  .lib-error{margin:0 0 12px;padding:10px 12px;border-radius:10px;border:1px solid rgba(198,91,91,.32);background:rgba(198,91,91,.08);color:#c65b5b;font-size:12px;line-height:1.7;}
  .lib-loading{display:flex;align-items:center;gap:8px;padding:18px 4px;color:var(--text-4);font-size:12px;}
  .lib-loading i{width:14px;height:14px;border-radius:50%;border:2px solid var(--accent-soft-2);border-top-color:var(--accent);animation:lib-spin .8s linear infinite;}
  @keyframes lib-spin{to{transform:rotate(360deg);}}
  .lib-history{display:flex;flex-direction:column;gap:6px;margin-top:8px;}
  .lib-history-item{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:7px 10px;border-radius:9px;border:1px solid var(--border);background:rgba(255,255,255,.5);font-size:11.5px;color:var(--text-3);}
  html[data-theme="dark"] .lib-tabs,
  html[data-theme="dark"] .lib-toolbar select,
  html[data-theme="dark"] .lib-toolbar input,
  html[data-theme="dark"] .lib-card,
  html[data-theme="dark"] .lib-ball,
  html[data-theme="dark"] .lib-message,
  html[data-theme="dark"] .lib-content,
  html[data-theme="dark"] .lib-history-item{background:rgba(255,255,255,.06);border-color:rgba(255,255,255,.12);}
  html[data-theme="dark"] .lib-message-assistant{background:rgba(112,161,90,.12);}
  html[data-theme="dark"] .lib-card:hover{border-color:rgba(94,234,212,.3);}
  @media(max-width:820px){
    .lib-page{padding:20px 16px 42px;}
    .lib-header{flex-direction:column;gap:10px;}
    .lib-stats{margin-left:0;width:100%;}
    .lib-card-head{flex-wrap:wrap;}
    .lib-card-actions{width:100%;justify-content:flex-end;}
  }
`
