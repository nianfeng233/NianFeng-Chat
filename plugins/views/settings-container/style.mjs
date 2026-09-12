/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/** settings-container 样式：卡片 / 行 / 开关 / 分段控件（取自 demo 的设置页样式） */
export const SETTINGS_CONTAINER_CSS = `
  .settings-nav-search{display:flex;align-items:center;gap:7px;height:34px;margin:0 2px 12px;padding:0 10px;border-radius:9px;background:rgba(255,255,255,.72);border:1px solid rgba(0,0,0,.06);color:var(--text-4);box-sizing:border-box;}
  .settings-nav-search span{font-size:15px;line-height:1;}
  .settings-nav-search input{flex:1;min-width:0;border:0;outline:0;background:transparent;font:inherit;font-size:12.5px;color:var(--text);}
  .settings-nav-search input::placeholder{color:var(--text-4);}
  .settings-nav-group[hidden]{display:none;}
  .settings-nav-item[hidden]{display:none;}
  .settings-title-row{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;margin-bottom:26px}
  .settings-title{font-size:20px;line-height:1.3;font-weight:650;letter-spacing:.1px;color:var(--text)}
  .settings-desc{margin-top:6px;font-size:12.5px;line-height:1.55;color:var(--text-3)}
  .settings-section{margin-top:26px}
  .settings-section-title{font-size:12px;font-weight:600;color:var(--text-2);margin:0 0 9px 2px}
  .settings-card{background:rgba(255,255,255,.72);border:1px solid rgba(0,0,0,.055);border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(30,60,20,.035)}
  .setting-row{min-height:58px;padding:12px 15px;display:flex;align-items:center;gap:16px;border-bottom:1px solid rgba(0,0,0,.045)}
  .setting-row:last-child{border-bottom:0}
  .setting-main{flex:1;min-width:0}
  .setting-name{font-size:13px;color:var(--text);font-weight:500}
  .setting-help{font-size:11.5px;color:var(--text-3);margin-top:3px;line-height:1.45}
  .setting-control{flex:0 0 auto;display:flex;align-items:center;gap:8px}
  .setting-select,.setting-input{height:34px;border:1px solid rgba(0,0,0,.09);background:rgba(255,255,255,.86);border-radius:8px;padding:0 10px;color:var(--text);font:inherit;font-size:12.5px;outline:none;box-sizing:border-box}
  .setting-select:focus,.setting-input:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
  .setting-input[type="number"]{-moz-appearance:textfield;appearance:textfield}
  .setting-input[type="number"]::-webkit-outer-spin-button,
  .setting-input[type="number"]::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}
  .setting-select{min-width:132px;cursor:pointer}
  .switch{width:40px;height:23px;border:0;border-radius:99px;background:#d5d9de;position:relative;cursor:pointer;padding:0;transition:background .18s}
  .switch::after{content:"";position:absolute;left:3px;top:3px;width:17px;height:17px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.16);transition:transform .18s}
  .switch.on{background:#75b957}
  .switch.on::after{transform:translateX(17px)}
  .segmented{display:flex;padding:3px;background:rgba(235,239,234,.8);border-radius:9px;gap:2px}
  .segmented button{height:28px;border:0;background:transparent;border-radius:7px;padding:0 12px;color:var(--text-3);font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}
  .segmented button.active{background:#fff;color:var(--text);box-shadow:0 1px 3px rgba(0,0,0,.07)}
  .color-dot{width:24px;height:24px;border-radius:50%;box-shadow:0 0 0 3px rgba(59,108,246,.12);cursor:pointer;padding:0;border:0;-webkit-appearance:none;appearance:none;background:transparent}
  .color-dot::-webkit-color-swatch-wrapper{padding:0}
  .color-dot::-webkit-color-swatch{border:0;border-radius:50%}
  .color-dot::-moz-color-swatch{border:0;border-radius:50%}
  .settings-note{padding:11px 13px;margin-top:10px;border-radius:9px;background:rgba(235,246,226,.72);color:#66805b;font-size:11.5px;line-height:1.55}
  .outline-btn{height:32px;border:1px solid rgba(0,0,0,.09);background:#fff;border-radius:8px;padding:0 11px;font:inherit;font-size:12px;color:var(--text-2);cursor:pointer}
  .outline-btn:hover{background:#f7f8f6;color:var(--text)}
  .file-picker{position:relative;display:inline-flex;align-items:center;gap:8px;height:34px;max-width:min(320px,100%);padding:0 10px 0 4px;border:1px solid rgba(0,0,0,.09);border-radius:8px;background:rgba(255,255,255,.86);cursor:pointer;box-sizing:border-box;transition:background .15s,border-color .15s,box-shadow .15s}
  .file-picker input[type="file"]{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
  .file-picker-face{display:inline-flex;align-items:center;height:26px;padding:0 10px;border-radius:6px;background:var(--accent-soft);color:var(--accent);font-size:12px;font-weight:500;white-space:nowrap;transition:background .15s}
  .file-picker:hover{border-color:var(--accent-soft-2);background:#fff}
  .file-picker:hover .file-picker-face{background:var(--accent-soft-2)}
  .file-picker:focus-within{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
  .file-picker-name{min-width:0;max-width:150px;font-size:11.5px;color:var(--text-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  html[data-theme="dark"] .file-picker{background:rgba(255,255,255,.06)}
  html[data-theme="dark"] .file-picker:hover{background:rgba(255,255,255,.1)}
  .glass-alpha-control{display:inline-flex;align-items:center;gap:10px;min-width:190px;max-width:100%}
  .glass-alpha-range{flex:1;min-width:110px;height:4px;border-radius:99px;background:rgba(0,0,0,.1);accent-color:var(--accent);cursor:pointer}
  .glass-alpha-control b{flex:0 0 46px;text-align:right;font:11.5px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--text-3);font-weight:400}
  html[data-theme="dark"] .glass-alpha-range{background:rgba(255,255,255,.14)}
  .glass-panel-list{display:flex;flex-direction:column;gap:8px}
  .glass-panel{border:1px solid rgba(0,0,0,.06);border-radius:11px;background:rgba(255,255,255,.55);overflow:hidden}
  .glass-panel[open]{background:transparent;border-color:transparent}
  .glass-panel summary{cursor:pointer;list-style:none;display:flex;align-items:center;justify-content:space-between;gap:10px;padding:11px 13px;font-size:12.5px;color:var(--text)}
  .glass-panel summary::-webkit-details-marker{display:none}
  .glass-panel summary b{font-weight:600}
  .glass-panel summary span{font-size:11px;color:var(--text-4);min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .glass-panel-reset{flex:0 0 auto;height:24px;padding:0 8px;font-size:10.5px;color:var(--text-3)}
  .glass-panel-reset:hover{color:var(--text);background:#f7f8f6}
  .glass-panel-toolbar{display:flex;align-items:center;gap:10px;margin-bottom:8px;flex-wrap:wrap}
  .glass-panel-toolbar span{font-size:11px;color:var(--text-4)}
  .glass-panel summary::after{content:"▾";color:var(--text-4);font-size:11px;transition:transform .15s}
  .glass-panel[open] summary::after{transform:rotate(180deg)}
  html[data-theme="dark"] .glass-panel{background:rgba(255,255,255,.05);border-color:rgba(255,255,255,.08)}
  .danger-btn{color:#c65b5b;border-color:rgba(198,91,91,.22)}
  .danger-btn:hover{background:rgba(198,91,91,.06)}
  .shortcut-key{display:inline-flex;align-items:center;justify-content:center;min-width:48px;height:27px;padding:0 7px;border-radius:6px;background:#f5f6f5;border:1px solid rgba(0,0,0,.08);box-shadow:0 1px 0 rgba(0,0,0,.04);font:11px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--text-2)}
  .about-mark{width:58px;height:58px;border-radius:15px;background:linear-gradient(135deg,#edf7e7,#d9efcb);display:flex;align-items:center;justify-content:center;color:#70a15a;font-size:25px;font-weight:700;box-shadow:inset 0 1px 0 rgba(255,255,255,.9)}
  .about-head{display:flex;gap:15px;align-items:center}
  .about-version{font-size:12px;color:var(--text-3);margin-top:4px}
  .mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px}
  .text-good{color:#70a15a;font-size:12px}
  .text-warn{color:#c9a227;font-size:12px}
  .text-bad{color:#c65b5b;font-size:12px}
  .plugin-row{display:flex;align-items:center;gap:10px;padding:12px 14px;border-bottom:1px solid rgba(0,0,0,.045)}
  /* 气泡样式与消息列表样式补充：提供商卡片 */
  .provider-card{margin-bottom:10px;}
  .provider-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 15px;border-bottom:1px solid rgba(0,0,0,.045);}
  .provider-title{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0;}
  .provider-name{font-size:13.5px;font-weight:600;color:var(--text);}
  .provider-status{flex:0 0 auto;font-size:11.5px;}`
