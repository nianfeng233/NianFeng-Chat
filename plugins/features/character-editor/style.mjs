/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/** 角色编辑（捏人窗口）样式。 */
export const CHARACTER_CSS = `
  .char-mask{position:fixed;inset:0;z-index:120;background:rgba(20,26,18,.34);display:flex;align-items:center;justify-content:center;padding:24px;animation:char-fade .16s ease}
  .char-dialog{width:min(560px,100%);max-height:calc(100vh - 48px);overflow:auto;border-radius:16px;background:rgba(255,255,255,.97);border:1px solid rgba(0,0,0,.06);box-shadow:0 24px 60px rgba(20,40,15,.28);animation:char-rise .18s ease}
  html[data-theme="dark"] .char-dialog{background:#232821;border-color:rgba(255,255,255,.08)}
  .char-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:16px 18px 12px;border-bottom:1px solid rgba(0,0,0,.05)}
  html[data-theme="dark"] .char-head{border-color:rgba(255,255,255,.07)}
  .char-title{font-size:15px;font-weight:650;color:var(--text)}
  .char-sub{font-size:11.5px;color:var(--text-3);margin-top:4px}
  .char-close{width:28px;height:28px;border:0;border-radius:8px;background:transparent;color:var(--text-3);cursor:pointer;font-size:13px}
  .char-close:hover{background:rgba(0,0,0,.05);color:var(--text)}
  .char-body{display:flex;flex-direction:column;gap:14px;padding:16px 18px}
  .char-avatar-row{display:flex;gap:14px;align-items:center}
  .char-avatar{flex:0 0 auto;width:56px;height:56px;border-radius:18px;display:flex;align-items:center;justify-content:center;color:#fff;font-size:22px;font-weight:700;background:linear-gradient(135deg,var(--c1),var(--c2));box-shadow:0 6px 16px rgba(30,60,20,.18);cursor:pointer;transition:transform .14s ease,box-shadow .14s ease}
  .char-avatar:hover{transform:translateY(-1px);box-shadow:0 8px 20px rgba(30,60,20,.24)}
  .char-avatar.has-image{color:transparent;background-size:cover;background-position:center}
  .char-color-clear{height:22px;padding:0 8px;border:1px solid rgba(0,0,0,.08);border-radius:7px;background:transparent;color:var(--text-3);font:inherit;font-size:10.5px;cursor:pointer}
  .char-color-clear:hover{background:rgba(0,0,0,.05);color:var(--text)}
  .char-avatar-side{flex:1;min-width:0;display:flex;flex-direction:column;gap:9px}
  .char-field{display:flex;flex-direction:column;gap:6px;font-size:12px;color:var(--text-2)}
  .char-field > span em{font-style:normal;font-size:11px;color:var(--text-4);margin-left:6px}
  .char-field .setting-input{width:100%}
  .char-name{height:36px}
  .char-persona{width:100%;min-height:104px;resize:vertical;border:1px solid rgba(0,0,0,.09);border-radius:10px;background:rgba(255,255,255,.86);padding:10px 12px;font:inherit;font-size:12.5px;line-height:1.6;color:var(--text);outline:none;box-sizing:border-box}
  .char-persona:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
  html[data-theme="dark"] .char-persona{background:rgba(255,255,255,.07);color:var(--text)}
  .char-colors{display:flex;flex-wrap:wrap;gap:6px}
  .char-color{width:22px;height:22px;border-radius:7px;border:2px solid transparent;background:linear-gradient(135deg,var(--c1),var(--c2));cursor:pointer;padding:0;box-shadow:0 1px 3px rgba(0,0,0,.12)}
  .char-color.active{border-color:#fff;box-shadow:0 0 0 2px var(--accent),0 1px 3px rgba(0,0,0,.16)}
  .char-model{width:100%}
  .char-backup-panel{display:flex;flex-direction:column;gap:7px;padding:8px;border:1px solid rgba(0,0,0,.07);border-radius:10px;background:rgba(0,0,0,.018)}
  html[data-theme="dark"] .char-backup-panel{border-color:rgba(255,255,255,.09);background:rgba(255,255,255,.035)}
  .char-backup-list{display:flex;flex-direction:column;gap:5px}
  .char-backup-row{display:flex;align-items:center;gap:8px;padding:6px 7px;border-radius:8px;background:rgba(255,255,255,.78);border:1px solid rgba(0,0,0,.05)}
  html[data-theme="dark"] .char-backup-row{background:rgba(255,255,255,.07);border-color:rgba(255,255,255,.08)}
  .char-backup-order{flex:0 0 auto;width:18px;text-align:center;font-size:11px;color:var(--text-4)}
  .char-backup-name{flex:1;min-width:0;font-size:12px;color:var(--text-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .char-backup-ops{display:inline-flex;align-items:center;gap:4px}
  .char-backup-op{height:22px;min-width:24px;padding:0 6px;border:1px solid rgba(0,0,0,.08);border-radius:7px;background:transparent;color:var(--text-3);font:inherit;font-size:11px;cursor:pointer}
  .char-backup-op:hover:not(:disabled){background:rgba(0,0,0,.05);color:var(--text)}
  .char-backup-op:disabled{opacity:.4;cursor:not-allowed}
  .char-backup-op.danger{color:#d9534f}
  .char-backup-empty{font-size:11.5px;color:var(--text-3);padding:4px 2px}
  .char-backup-add{display:flex;gap:6px;align-items:center}
  .char-backup-add select{flex:1;min-width:0}
  .char-backup-add-btn{flex:0 0 auto}
  .char-note{font-size:11px;line-height:1.6;color:var(--text-3);background:rgba(0,0,0,.025);border-radius:9px;padding:9px 11px}
  html[data-theme="dark"] .char-note{background:rgba(255,255,255,.05)}
  .char-foot{display:flex;justify-content:flex-end;gap:9px;padding:12px 18px 16px;border-top:1px solid rgba(0,0,0,.05)}
  html[data-theme="dark"] .char-foot{border-color:rgba(255,255,255,.07)}
  .primary-soft{background:var(--accent-soft);border-color:var(--accent-soft-2);color:var(--accent)}
  @keyframes char-fade{from{opacity:0}to{opacity:1}}
  @keyframes char-rise{from{opacity:0;transform:translateY(8px) scale(.985)}to{opacity:1;transform:none}}
`
