/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/** settings-item-logs 样式：运行日志控制台 */
export const LOGS_CSS = `
  .logs-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:8px 0 12px;}
  .logs-toolbar select,.logs-toolbar input{height:32px;border:1px solid rgba(0,0,0,.09);background:rgba(255,255,255,.86);border-radius:8px;padding:0 9px;color:var(--text);font:inherit;font-size:12px;outline:none;box-sizing:border-box;}
  .logs-toolbar select:focus,.logs-toolbar input:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft);}
  .logs-toolbar input[data-logs-search]{flex:1 1 170px;min-width:120px;}
  .logs-toolbar .outline-btn.on{background:var(--accent-soft);color:var(--accent);border-color:var(--accent-soft-2);}
  .logs-stats{font-size:11.5px;color:var(--text-4);margin-left:auto;white-space:nowrap;}
  .logs-list{border:1px solid rgba(0,0,0,.07);border-radius:12px;background:rgba(255,255,255,.58);overflow:auto;height:min(62vh,620px);min-height:260px;box-shadow:inset 0 1px 0 rgba(255,255,255,.7);}
  .logs-row{display:grid;grid-template-columns:78px 76px minmax(0,1fr);gap:8px;padding:5px 11px;border-bottom:1px solid rgba(0,0,0,.045);font:11.5px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--text-2);}
  .logs-row:last-child{border-bottom:0;}
  .logs-row.level-warn{background:rgba(255,243,224,.55);}
  .logs-row.level-error{background:rgba(255,235,235,.62);}
  .logs-row.level-debug{opacity:.72;}
  .logs-row.timeout{box-shadow:inset 3px 0 0 #c65b5b;}
  .logs-time{color:var(--text-4);white-space:nowrap;}
  .logs-src{color:#5b8c47;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
  .logs-row.level-warn .logs-src{color:#a5721a;}
  .logs-row.level-error .logs-src{color:#c65b5b;}
  .logs-text{white-space:pre-wrap;word-break:break-word;min-width:0;}
  .logs-text b{font-weight:600;}
  .logs-empty{padding:40px 20px;text-align:center;color:var(--text-4);font-size:12.5px;}
  .logs-note{margin-top:10px;font-size:11.5px;color:var(--text-4);line-height:1.6;}
  html[data-theme="dark"] .logs-list{background:rgba(255,255,255,.04);border-color:rgba(255,255,255,.1);}
  html[data-theme="dark"] .logs-toolbar select,html[data-theme="dark"] .logs-toolbar input{background:rgba(255,255,255,.06);border-color:rgba(255,255,255,.12);}
`
