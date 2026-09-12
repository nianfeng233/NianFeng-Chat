/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目：念风 Chat（NianFeng-Chat）
 *
 * NapCatQQ 渠道插件样式：设置窗口、实例管理、渠道详情与群聊规则。
 */
export const NAPCAT_CSS = `
  .nc-mask{position:fixed;inset:0;z-index:1200;display:flex;align-items:center;justify-content:center;background:rgba(18,28,38,.36);backdrop-filter:blur(22px);}
  .nc-dialog{width:min(620px,94vw);max-height:90vh;overflow:auto;padding:18px 20px;border-radius:18px;background:var(--panel-solid,#fff);box-shadow:0 24px 70px rgba(20,40,60,.3);display:flex;flex-direction:column;gap:13px;color:var(--text);}
  .nc-dialog h3{margin:0;font-size:16px;}
  .nc-dialog .nc-sub{font-size:12px;color:var(--text-3);line-height:1.6;margin-top:-7px;}
  .nc-field{display:flex;flex-direction:column;gap:5px;font-size:12.5px;color:var(--text-3);}
  .nc-field input,.nc-field select,.nc-field textarea{width:100%;box-sizing:border-box;padding:8px 10px;border-radius:9px;border:1px solid var(--border);background:rgba(255,255,255,.75);color:var(--text);font-size:13px;outline:none;font-family:inherit;}
  .nc-field input,.nc-field select{height:34px;padding:0 10px;}
  .nc-field textarea{min-height:62px;resize:vertical;line-height:1.5;}
  .nc-field input:focus,.nc-field select:focus,.nc-field textarea:focus{border-color:var(--accent);}
  /* 复选框 / 单选 / 滑杆不能吃 .nc-field input 的 100% 宽度样式，否则权限区会被撑坏 */
  .nc-field input[type="checkbox"],.nc-field input[type="radio"],
  .nc-checks input[type="checkbox"],.nc-perms input[type="checkbox"]{
    width:16px;height:16px;min-width:16px;padding:0;border:0;background:transparent;
    border-radius:3px;flex:0 0 auto;accent-color:#0099ff;
  }
  .nc-field input[type="range"]{width:auto;height:26px;padding:0;border:0;background:transparent;}
  .nc-perms input[type="checkbox"]{margin-top:2px;}
  .nc-field-help{font-size:11px;color:var(--text-4);line-height:1.55;}
  .nc-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;}
  .nc-grid-3{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;align-items:start;}
  .nc-grid-3 .outline-btn{height:34px;padding:0 12px;white-space:nowrap;}
  .nc-checks{display:flex;gap:14px;flex-wrap:wrap;font-size:12.5px;color:var(--text-2);}
  .nc-checks label{display:flex;align-items:center;gap:6px;}
  .nc-checks input{accent-color:#0099ff;}
  .nc-note{padding:8px 11px;border-radius:9px;background:rgba(0,153,255,.08);border:1px solid rgba(0,153,255,.26);font-size:11.5px;color:#31708f;line-height:1.65;}
  .nc-note code{padding:1px 5px;border-radius:5px;background:rgba(0,0,0,.06);font-size:11px;word-break:break-all;}
  .nc-error{padding:8px 11px;border-radius:9px;background:rgba(198,91,91,.1);border:1px solid rgba(198,91,91,.3);color:#c65b5b;font-size:12px;line-height:1.6;word-break:break-all;}
  .nc-actions{display:flex;justify-content:flex-end;gap:9px;margin-top:2px;flex-wrap:wrap;}
  .nc-detail-head{display:flex;align-items:center;gap:14px;}
  .nc-detail-avatar{width:48px;height:48px;border-radius:14px;display:flex;align-items:center;justify-content:center;font-size:22px;color:#fff;background:linear-gradient(135deg,#4db8ff,#0077cc);box-shadow:0 3px 10px rgba(0,119,204,.25);}
  .nc-detail-name{font-size:19px;font-weight:650;color:var(--text);}
  .nc-detail-sub{font-size:12.5px;color:var(--text-3);margin-top:4px;word-break:break-all;}
  .nc-badge{display:inline-flex;align-items:center;gap:5px;padding:2px 9px;border-radius:999px;font-size:11.5px;background:rgba(0,0,0,.05);color:var(--text-3);white-space:nowrap;}
  .nc-detail-actions{display:flex;gap:9px;flex-wrap:wrap;margin-top:14px;}
  .nc-detail-actions .outline-btn{height:34px;padding:0 14px;}
  .nc-kv{display:grid;grid-template-columns:110px 1fr;gap:7px 12px;font-size:12.5px;color:var(--text-2);}
  .nc-kv .k{color:var(--text-4);}
  .nc-kv .v{word-break:break-all;}
  .nc-row{display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px dashed var(--border);}
  .nc-row:last-child{border-bottom:none;}
  .nc-row-main{flex:1;min-width:0;}
  .nc-row-name{font-size:12.5px;color:var(--text-2);display:flex;align-items:center;gap:6px;flex-wrap:wrap;}
  .nc-row-id{font-size:11px;color:var(--text-4);margin-top:3px;word-break:break-all;}
  .nc-row-actions{display:flex;align-items:center;gap:7px;flex:0 0 auto;flex-wrap:wrap;justify-content:flex-end;}
  .nc-row-actions .outline-btn{height:30px;padding:0 10px;}
  .nc-row-actions input:not([type="checkbox"]){width:92px;height:30px;padding:0 8px;border-radius:8px;border:1px solid var(--border);background:rgba(255,255,255,.75);color:var(--text);font-size:12px;outline:none;}
  .nc-tag{display:inline-flex;align-items:center;padding:1px 7px;border-radius:999px;font-size:10.5px;background:rgba(0,153,255,.14);color:#0077cc;}
  .nc-tag.warn{background:rgba(201,162,39,.14);color:#a5721a;}
  .nc-tag.err{background:rgba(198,91,91,.14);color:#c65b5b;}
  .nc-tag.ok{background:rgba(112,161,90,.14);color:#4d7d3c;}
  .nc-empty{font-size:11.5px;color:var(--text-4);line-height:1.7;}
  .nc-perms{display:grid;grid-template-columns:1fr 1fr;gap:7px;padding:10px;border:1px solid var(--border);border-radius:12px;background:rgba(255,255,255,.42);}
  .nc-perm{display:flex;align-items:flex-start;gap:8px;font-size:12.5px;color:var(--text-2);line-height:1.4;}
  .nc-perm input{margin-top:2px;accent-color:#0099ff;}
  .nc-perm small{display:block;color:var(--text-4);font-size:10.5px;margin-top:2px;}
  .nc-rule-card{padding:10px 12px;border:1px solid var(--border);border-radius:12px;background:rgba(255,255,255,.42);display:flex;flex-direction:column;gap:10px;}
  .nc-range-row{display:flex;align-items:center;gap:8px;}
  .nc-range-row input[type="range"]{flex:1;padding:0;height:26px;}
  .nc-range-row input.nc-range-num{width:68px;height:32px;padding:0 8px;border-radius:8px;border:1px solid var(--border);background:rgba(255,255,255,.75);color:var(--text);font-size:12.5px;text-align:right;outline:none;box-sizing:border-box;}
  .nc-range-row input.nc-range-num:focus{border-color:var(--accent);}
  .nc-range-unit{font-size:12px;color:var(--text-3);}
  .nc-status{display:flex;align-items:center;gap:7px;font-size:12.5px;color:var(--text-2);}
  .nc-status .dot{width:8px;height:8px;border-radius:50%;flex:0 0 auto;}
  .nc-picker{display:flex;flex-direction:column;gap:8px;max-height:52vh;overflow:auto;}
  .nc-picker-row{display:flex;align-items:center;gap:10px;padding:9px 11px;border:1px solid var(--border);border-radius:10px;background:rgba(255,255,255,.5);cursor:pointer;}
  .nc-picker-row:hover{border-color:#0099ff;background:rgba(0,153,255,.06);}
  .nc-picker-main{flex:1;min-width:0;}
  .nc-picker-name{font-size:12.5px;color:var(--text-2);}
  .nc-picker-sub{font-size:11px;color:var(--text-4);margin-top:3px;word-break:break-all;}
  @media (max-width:560px){.nc-grid,.nc-grid-3,.nc-perms{grid-template-columns:1fr;}.nc-row{flex-direction:column;align-items:flex-start;}.nc-row-actions{justify-content:flex-start;}}
`
