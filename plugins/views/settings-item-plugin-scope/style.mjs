/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/** 「插件启用」设置页样式。 */
export const PLUGIN_SCOPE_CSS = `
  .ps-plugin-tabs{display:flex;flex-wrap:wrap;gap:8px;margin:10px 0 14px}
  .ps-plugin-tab{display:inline-flex;align-items:center;gap:7px;padding:7px 12px;border:1px solid var(--border);border-radius:10px;background:var(--card-bg,rgba(255,255,255,.55));color:var(--text-2);font:inherit;font-size:12.5px;cursor:pointer}
  .ps-plugin-tab:hover{border-color:var(--accent);color:var(--accent)}
  .ps-plugin-tab.active{border-color:var(--accent);background:var(--accent-soft);color:var(--accent);font-weight:650}
  .ps-plugin-tab .ps-dot{width:7px;height:7px;border-radius:50%;background:var(--accent)}
  .ps-default-row{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:10px 0;border-bottom:1px solid var(--border-soft,rgba(0,0,0,.06))}
  .ps-default-main{flex:1;min-width:220px}
  .ps-default-name{font-size:13px;font-weight:650;color:var(--text)}
  .ps-help{font-size:11.5px;line-height:1.6;color:var(--text-3);margin-top:3px}
  .ps-list{display:flex;flex-direction:column;gap:8px;margin-top:10px}
  .ps-role{border:1px solid var(--border-soft,rgba(0,0,0,.06));border-radius:11px;padding:10px 11px;background:rgba(255,255,255,.42)}
  html[data-theme="dark"] .ps-role{background:rgba(255,255,255,.045)}
  .ps-role-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
  .ps-role-name{font-size:13px;font-weight:650;color:var(--text)}
  .ps-spacer{flex:1;min-width:8px}
  .ps-dim{font-size:11.5px;color:var(--text-4)}
  .ps-badge{display:inline-flex;align-items:center;border-radius:999px;padding:1px 7px;font-size:11px;background:rgba(110,119,129,.12);color:var(--text-3)}
  .ps-badge.warn{background:rgba(154,103,0,.14);color:#9a6700}
  .ps-channels{display:flex;flex-direction:column;gap:5px;margin-top:8px;padding-left:10px;border-left:2px solid var(--border-soft,rgba(0,0,0,.07))}
  .ps-channel{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:5px 0}
  .ps-channel-name{font-size:12.5px;color:var(--text-2)}
  .ps-select{height:30px;font-size:12px;padding:0 8px}
  .ps-no-channel{padding:6px 0 2px}
  .ps-bulk{display:flex;gap:7px;flex-wrap:wrap;align-items:center;margin-top:12px}
  .ps-empty{padding:22px 4px;color:var(--text-3);font-size:12.5px;line-height:1.7}
`
