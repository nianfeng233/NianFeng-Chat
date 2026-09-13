/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/** settings-item-logs 样式：运行日志控制台 */
export const LOGS_CSS = `
  .logs-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:8px 0 12px;}
  .logs-toolbar select,.logs-toolbar input:not([type="checkbox"]){height:32px;border:1px solid rgba(0,0,0,.09);background:rgba(255,255,255,.86);border-radius:8px;padding:0 9px;color:var(--text);font:inherit;font-size:12px;outline:none;box-sizing:border-box;}
  .logs-toolbar select:focus,.logs-toolbar input:not([type="checkbox"]):focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft);}
  .logs-toolbar input[data-logs-search]{flex:1 1 170px;min-width:120px;}
  .logs-levels{display:flex;align-items:center;gap:2px;height:32px;padding:0 8px;border:1px solid rgba(0,0,0,.09);background:rgba(255,255,255,.86);border-radius:8px;box-sizing:border-box;}
  .logs-level-option{display:inline-flex;align-items:center;gap:4px;padding:0 4px;font-size:12px;color:var(--text);cursor:pointer;user-select:none;white-space:nowrap;}
  .logs-level-option input[type="checkbox"]{margin:0;width:13px;height:13px;accent-color:var(--accent);cursor:pointer;}
  .logs-toolbar .outline-btn.on{background:var(--accent-soft);color:var(--accent);border-color:var(--accent-soft-2);}
  .logs-stats{font-size:11.5px;color:var(--text-4);margin-left:auto;white-space:nowrap;}
  .logs-list{border:1px solid #2b2b2b;border-radius:10px;background:#1e1e1e;overflow:auto;height:min(62vh,680px);min-height:260px;box-shadow:inset 0 1px 0 rgba(255,255,255,.06);padding:6px 0;}
  .logs-row{display:grid;grid-template-columns:104px 150px minmax(0,1fr);gap:8px;padding:3px 11px;border-bottom:1px solid rgba(255,255,255,.05);font:12px/1.6 Consolas,"Cascadia Mono",ui-monospace,SFMono-Regular,Menlo,monospace;color:#d4d4d4;align-items:start;}
  .logs-row:last-child{border-bottom:0;}
  .logs-row.level-warn{background:rgba(220,170,60,.10);}
  .logs-row.level-error{background:rgba(220,80,80,.13);}
  .logs-row.level-debug{color:#9a9a9a;}
  .logs-row.timeout{box-shadow:inset 3px 0 0 #e06c75;}
  .logs-time{color:#7f8c8d;white-space:nowrap;}
  .logs-src{color:#7dcfff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
  .logs-row.level-warn .logs-src{color:#e5c07b;}
  .logs-row.level-error .logs-src{color:#e06c75;}
  .logs-row.level-debug .logs-src{color:#9a9a9a;}
  .logs-text{white-space:pre-wrap;word-break:break-word;min-width:0;color:#e6e6e6;}
  .logs-row.level-warn .logs-text{color:#f0d9a8;}
  .logs-row.level-error .logs-text{color:#ffb4b4;}
  .logs-row.level-debug .logs-text{color:#b8b8b8;}
  .logs-text b{font-weight:600;}
  .logs-empty{padding:40px 20px;text-align:center;color:#8a8a8a;font-size:12.5px;}
  .logs-note{margin-top:10px;font-size:11.5px;color:var(--text-4);line-height:1.6;}
  html[data-theme="dark"] .logs-list{background:#1e1e1e;border-color:#2b2b2b;}
  html[data-theme="dark"] .logs-toolbar select,html[data-theme="dark"] .logs-toolbar input:not([type="checkbox"]),html[data-theme="dark"] .logs-levels{background:rgba(255,255,255,.06);border-color:rgba(255,255,255,.12);}
`
