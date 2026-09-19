/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目：念风 Chat（NianFeng-Chat）
 *
 * QQ 官方机器人渠道插件样式：设置窗口、接入弹窗、渠道详情与会话绑定列表。
 */
export const QQBOT_CSS = `
  .wc-mask{position:fixed;inset:0;z-index:1200;display:flex;align-items:center;justify-content:center;background:rgba(18,28,38,.36);backdrop-filter:blur(22px);}
  .wc-dialog{width:min(560px,94vw);max-height:90vh;overflow:auto;padding:18px 20px;border-radius:18px;background:var(--panel-solid,#fff);box-shadow:0 24px 70px rgba(20,40,60,.3);display:flex;flex-direction:column;gap:13px;color:var(--text);}
  .wc-dialog h3{margin:0;font-size:16px;}
  .wc-dialog .wc-sub{font-size:12px;color:var(--text-3);line-height:1.6;margin-top:-7px;}
  .wc-field{display:flex;flex-direction:column;gap:5px;font-size:12.5px;color:var(--text-3);}
  .wc-field input,.wc-field select{height:34px;padding:0 10px;border-radius:9px;border:1px solid var(--border);background:rgba(255,255,255,.75);color:var(--text);font-size:13px;outline:none;}
  .wc-field textarea{padding:8px 10px;border-radius:9px;border:1px solid var(--border);background:rgba(255,255,255,.75);color:var(--text);font-size:12.5px;line-height:1.5;outline:none;resize:vertical;min-height:52px;font-family:inherit;}
  .wc-field input:focus,.wc-field select:focus,.wc-field textarea:focus{border-color:var(--accent);}
  .wc-field-help{font-size:11px;color:var(--text-4);line-height:1.65;}
  details.wc-details[open]{display:flex;flex-direction:column;gap:9px;}
  details.wc-details > summary{font-weight:500;}
  .wc-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;}
  .wc-access{display:flex;gap:14px;flex-wrap:wrap;font-size:12.5px;color:var(--text-2);}
  .wc-access label{display:flex;align-items:center;gap:6px;}
  .wc-access input{accent-color:var(--accent);}
  .wc-details{border:1px solid var(--border);border-radius:11px;padding:8px 11px;background:rgba(255,255,255,.4);}
  .wc-details summary{cursor:pointer;font-size:12px;color:var(--text-3);}
  .wc-details[open] summary{margin-bottom:9px;}
  .wc-perms{display:grid;grid-template-columns:1fr 1fr;gap:7px;padding:10px;border:1px solid var(--border);border-radius:12px;background:rgba(255,255,255,.42);}
  .wc-perm{display:flex;align-items:flex-start;gap:8px;font-size:12.5px;color:var(--text-2);line-height:1.4;}
  .wc-perm input{margin-top:2px;accent-color:var(--accent);}
  .wc-perm small{display:block;color:var(--text-4);font-size:10.5px;margin-top:2px;}
  .wc-actions{display:flex;justify-content:flex-end;gap:9px;margin-top:2px;}
  .wc-note{padding:8px 11px;border-radius:9px;background:rgba(18,183,245,.08);border:1px solid rgba(18,183,245,.26);font-size:11.5px;color:#31708f;line-height:1.65;}
  .wc-note code{padding:1px 5px;border-radius:5px;background:rgba(0,0,0,.06);font-size:11px;word-break:break-all;}
  .wc-error{padding:8px 11px;border-radius:9px;background:rgba(198,91,91,.1);border:1px solid rgba(198,91,91,.3);color:#c65b5b;font-size:12px;line-height:1.6;word-break:break-all;}
  .wc-qr{display:flex;flex-direction:column;align-items:center;gap:10px;padding:14px;border-radius:14px;background:rgba(255,255,255,.6);border:1px solid var(--border);}
  .wc-qr svg,.wc-qr img{width:240px;height:240px;border-radius:10px;background:#fff;}
  .wc-qr .wc-qr-fallback{font-size:12px;color:var(--text-3);line-height:1.7;word-break:break-all;text-align:center;}
  .wc-status{display:flex;align-items:center;gap:7px;font-size:12.5px;color:var(--text-2);}
  .wc-status .dot{width:8px;height:8px;border-radius:50%;flex:0 0 auto;}
  .wc-tabs{display:flex;gap:8px;border-bottom:1px solid var(--border);padding-bottom:9px;}
  .wc-tab{height:30px;padding:0 13px;border-radius:9px;border:1px solid transparent;background:transparent;color:var(--text-3);font-size:12.5px;cursor:pointer;}
  .wc-tab.active{background:rgba(18,183,245,.12);color:#1786b3;border-color:rgba(18,183,245,.3);}
  .wc-detail-head{display:flex;align-items:center;gap:14px;}
  .wc-detail-avatar{width:48px;height:48px;border-radius:14px;display:flex;align-items:center;justify-content:center;font-size:22px;color:#fff;background:linear-gradient(135deg,#4fc3f7,#0b74b8);box-shadow:0 3px 10px rgba(11,116,184,.25);}
  .wc-detail-name{font-size:19px;font-weight:650;color:var(--text);}
  .wc-detail-sub{font-size:12.5px;color:var(--text-3);margin-top:4px;}
  .wc-badge{display:inline-flex;align-items:center;gap:5px;padding:2px 9px;border-radius:999px;font-size:11.5px;background:rgba(0,0,0,.05);color:var(--text-3);}
  .wc-detail-actions{display:flex;gap:9px;flex-wrap:wrap;margin-top:14px;}
  .wc-detail-actions .outline-btn{height:34px;padding:0 14px;}
  .wc-kv{display:grid;grid-template-columns:120px 1fr;gap:7px 12px;font-size:12.5px;color:var(--text-2);}
  .wc-kv .k{color:var(--text-4);}
  .wc-kv .v{word-break:break-all;}
  .wc-bind-row{display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px dashed var(--border);}
  .wc-bind-row:last-child{border-bottom:none;}
  .wc-bind-main{flex:1;min-width:0;}
  .wc-bind-name{font-size:12.5px;color:var(--text-2);display:flex;align-items:center;gap:6px;}
  .wc-bind-id{font-size:11px;color:var(--text-4);margin-top:3px;word-break:break-all;}
  .wc-bind-actions{display:flex;align-items:center;gap:7px;flex:0 0 auto;}
  .wc-bind-actions input{width:92px;height:30px;padding:0 8px;border-radius:8px;border:1px solid var(--border);background:rgba(255,255,255,.75);color:var(--text);font-size:12px;outline:none;}
  .wc-bind-actions select{height:30px;padding:0 6px;border-radius:8px;border:1px solid var(--border);background:rgba(255,255,255,.75);color:var(--text);font-size:12px;}
  .wc-bind-actions .outline-btn{height:30px;padding:0 10px;}
  .wc-bind-empty{font-size:11.5px;color:var(--text-4);line-height:1.7;}
  .wc-tag{display:inline-flex;align-items:center;padding:1px 7px;border-radius:999px;font-size:10.5px;background:rgba(18,183,245,.14);color:#1786b3;}
  @media (max-width:520px){.wc-grid,.wc-perms{grid-template-columns:1fr;}.wc-bind-row{flex-direction:column;align-items:flex-start;}}
`
