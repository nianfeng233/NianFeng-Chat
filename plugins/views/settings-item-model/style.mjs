/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * settings-item-model 样式：内置模型面板 + AstrBot 风格的自定义提供商双栏布局。
 * 只使用 .model-* 前缀，避免污染其他设置页。
 */
export const MODEL_PAGE_CSS = `
  .model-mode-card{margin-bottom:6px}
  .model-mode-hint{display:inline-flex;align-items:center;gap:5px;font-size:11px;color:var(--text-3)}
  .model-mode-pill{font-size:10px;padding:1px 6px;border-radius:999px;background:rgba(117,185,87,.15);color:#5f8f4a}

  /* ---------- 内置模型空状态 ---------- */
  .model-empty{padding:28px 18px;display:flex;flex-direction:column;align-items:center;text-align:center;gap:7px}
  .model-empty-icon{width:42px;height:42px;border-radius:13px;background:var(--accent-soft);color:var(--accent);display:flex;align-items:center;justify-content:center}
  .model-empty-icon svg{width:20px;height:20px}
  .model-empty-title{font-size:13px;font-weight:600;color:var(--text)}
  .model-empty-desc{font-size:11.5px;line-height:1.65;color:var(--text-3);max-width:620px}
  .model-empty-actions{display:flex;gap:8px;margin-top:7px;flex-wrap:wrap;justify-content:center}
  .model-block{padding:0 15px 15px}
  .model-textarea{width:100%;min-height:66px;border:1px solid rgba(0,0,0,.09);background:rgba(255,255,255,.86);border-radius:8px;padding:8px 10px;color:var(--text);font:inherit;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;line-height:1.55;outline:none;box-sizing:border-box;resize:vertical}
  .model-textarea:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
  .model-inline-actions{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:7px}
  .model-json-hint{font-size:11px;color:var(--text-3)}
  .model-json-hint.bad{color:#c65b5b}

  /* ---------- 自定义提供商双栏 ---------- */
  .model-provider-layout{display:grid;grid-template-columns:252px minmax(0,1fr);gap:14px;align-items:stretch}
  .model-provider-side{display:flex;flex-direction:column;min-height:460px;background:rgba(255,255,255,.72);border:1px solid rgba(0,0,0,.055);border-radius:12px;padding:10px;box-shadow:0 2px 8px rgba(30,60,20,.035)}
  .model-side-head{display:flex;align-items:center;justify-content:space-between;padding:2px 4px 9px}
  .model-side-title{font-size:12px;font-weight:600;color:var(--text-2)}
  .model-provider-list{display:flex;flex-direction:column;gap:4px;flex:1 1 auto;min-height:0;overflow:auto;padding-right:2px}
  .model-provider-item{position:relative;display:flex;align-items:center;gap:9px;width:100%;padding:8px 66px 8px 9px;border:1px solid transparent;border-radius:9px;background:transparent;cursor:pointer;font:inherit;text-align:left;color:var(--text);user-select:none;transition:background .15s,border-color .15s}
  .model-provider-item:hover{background:rgba(0,0,0,.035)}
  .model-provider-item.active{background:var(--accent-soft);border-color:var(--accent-soft-2)}
  .model-provider-item.dim{opacity:.6}
  .model-provider-glyph{flex:0 0 auto;width:28px;height:28px;border-radius:9px;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#fff;background:linear-gradient(135deg,#9db4ff,#5a8dff)}
  .model-provider-glyph.ok{background:linear-gradient(135deg,#a7dd8f,#70b154)}
  .model-provider-glyph.warn{background:linear-gradient(135deg,#f3c98b,#dd9f45)}
  .model-provider-glyph.managed{background:linear-gradient(135deg,#c3b4f3,#8d74e0)}
  .model-provider-meta{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}
  .model-provider-name{font-size:12.5px;font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .model-provider-name em{font-style:normal;font-size:9.5px;font-weight:500;color:#8d74e0;background:rgba(141,116,224,.13);border-radius:4px;padding:1px 4px;margin-left:4px}
  .model-provider-url{font-size:10.5px;color:var(--text-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .model-provider-flags{display:flex;align-items:center;gap:5px;font-size:9.5px;color:var(--text-3);margin-top:1px;flex-wrap:wrap}
  .model-provider-del{position:absolute;right:7px;top:50%;transform:translateY(-50%);height:27px;padding:0 8px;display:inline-flex;align-items:center;gap:4px;border:1px solid rgba(198,91,91,.28);border-radius:8px;background:rgba(198,91,91,.09);color:#c65b5b;font:inherit;font-size:10.5px;cursor:pointer;white-space:nowrap;transition:background .15s,border-color .15s,color .15s}
  .model-provider-del svg{width:13px;height:13px}
  .model-provider-del:hover{background:rgba(198,91,91,.2);border-color:rgba(198,91,91,.45);color:#a94242}
  .model-delete-provider{height:32px;padding:0 12px;display:inline-flex;align-items:center;gap:5px;color:#c65b5b;border-color:rgba(198,91,91,.3);background:rgba(198,91,91,.08);font-weight:500}
  .model-delete-provider svg{width:14px;height:14px}
  .model-delete-provider:hover{background:rgba(198,91,91,.18);border-color:rgba(198,91,91,.45);color:#a94242}
  .model-flag{background:rgba(0,0,0,.05);border-radius:4px;padding:1px 4px;white-space:nowrap}
  .model-flag.bad{color:#b45f5f;background:rgba(198,91,91,.1)}
  .model-status-dot{width:7px;height:7px;border-radius:50%;background:#d5d9de;display:inline-block}
  .model-status-dot.ok{background:#75b957}
  .model-status-dot.bad{background:#c65b5b}
  .model-side-empty{padding:18px 8px;text-align:center;font-size:11.5px;color:var(--text-3)}
  .model-side-foot{padding:9px 5px 1px;font-size:10.5px;line-height:1.5;color:var(--text-4)}

  .model-provider-main{background:rgba(255,255,255,.72);border:1px solid rgba(0,0,0,.055);border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(30,60,20,.035);min-width:0}
  .model-detail-head{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;padding:14px 15px;border-bottom:1px solid rgba(0,0,0,.045);flex-wrap:wrap}
  .model-detail-title{font-size:14px;font-weight:650;color:var(--text);display:flex;align-items:center;gap:7px;flex-wrap:wrap}
  .model-detail-sub{font-size:11.5px;color:var(--text-3);margin-top:4px;word-break:break-all;line-height:1.5}
  .model-detail-actions{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
  .model-provider-main .setting-row{flex-wrap:wrap}
  .model-provider-main .setting-control{flex:1 1 240px;justify-content:flex-end;max-width:100%}
  .model-provider-main .setting-main{flex:1 1 150px}
  .model-status-text{font-size:11.5px;margin-right:2px}
  .model-status-text.ok{color:#70a15a}
  .model-status-text.bad{color:#c65b5b}
  .model-status-text.idle{color:var(--text-3)}

  .model-list-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 15px;border-bottom:1px solid rgba(0,0,0,.045);flex-wrap:wrap}
  .model-list-title{font-size:13px;font-weight:600;color:var(--text)}
  .model-list-sub{font-size:11px;color:var(--text-3);margin-top:3px}
  .model-list-actions{display:flex;gap:7px;flex-wrap:wrap}
  .model-item{border-bottom:1px solid rgba(0,0,0,.045)}
  .model-item:last-child{border-bottom:0}
  .model-item.open{background:rgba(59,108,246,.03)}
  .model-item.dim .model-item-info{opacity:.55}
  .model-item-main-row{display:flex;align-items:center;gap:11px;padding:10px 15px}
  .model-item-info{flex:1;min-width:0}
  .model-item-name{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:12.5px;font-weight:500;color:var(--text)}
  .model-item-id{font-size:10.5px;color:var(--text-3);margin-top:2px;word-break:break-all}
  .model-tag{font-size:10px;color:#66805b;background:rgba(117,185,87,.15);border-radius:4px;padding:1px 5px}
  .model-param-chips{display:flex;gap:5px;flex-wrap:wrap;margin-top:5px}
  .model-chip{font-size:10px;color:var(--text-2);background:rgba(0,0,0,.045);border-radius:5px;padding:1px 6px}
  .model-item-actions{display:flex;gap:6px;flex:0 0 auto}
  .model-discovered{background:rgba(59,108,246,.035);border-top:1px solid rgba(59,108,246,.12)}
  .model-discovered-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:11px 15px;flex-wrap:wrap}
  .model-discovered .model-item{background:rgba(255,255,255,.42)}
  .model-discovered .model-mini-btn[disabled]{opacity:.7;cursor:default}

  .model-editor{padding:2px 15px 15px 54px}
  .model-editor-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(132px,1fr));gap:9px}
  .model-field{display:flex;flex-direction:column;gap:4px;font-size:11px;color:var(--text-3)}
  .model-field .setting-input{width:100%}
  .model-editor-block{display:flex;flex-direction:column;gap:5px;margin-top:11px;font-size:11px;color:var(--text-3)}
  .model-editor-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:11px}
  .model-add-form{display:flex;gap:8px;align-items:center;padding:10px 15px;border-bottom:1px solid rgba(0,0,0,.045);flex-wrap:wrap}
  .model-add-form .setting-input{flex:1;min-width:140px;width:auto}
  .model-form-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:10px;padding:14px 15px 4px}
  .model-form-field{display:flex;flex-direction:column;gap:4px;font-size:11px;color:var(--text-3)}
  .model-form-field .setting-input,.model-form-field .setting-select{width:100%}
  .model-form-actions{display:flex;justify-content:flex-end;gap:8px;padding:12px 15px 15px}
  .model-advanced{padding:2px 15px 15px;border-top:1px dashed rgba(0,0,0,.06)}
  .model-advanced.hidden{display:none}
  .model-advanced-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:9px}
  .model-note{padding:12px 15px;font-size:11px;line-height:1.6;color:var(--text-3);background:rgba(0,0,0,.02)}
  .model-stale{background:rgba(255,244,222,.92);color:#9a7418}
  html[data-theme="dark"] .model-stale{background:rgba(201,162,39,.12);color:#d8b64e}

  /* ---------- 紧凑参数滑块（推理等级 / temperature） ---------- */
  .param-slider{display:inline-flex;align-items:center;gap:9px;justify-content:flex-end}
  .param-slider-track{position:relative;flex:0 0 auto;width:148px;height:10px}
  .param-slider-rail{position:absolute;inset:0;border-radius:999px;background:rgba(0,0,0,.08);box-shadow:inset 0 1px 2px rgba(0,0,0,.05)}
  .param-slider-fill{position:absolute;left:0;top:0;bottom:0;width:var(--p,0%);border-radius:999px;background:linear-gradient(90deg,rgba(255,255,255,var(--white,.85)),var(--c,#7ed07a));transition:width .1s linear,background .2s ease}
  .reasoning-off .param-slider-fill{opacity:.3}
  .param-slider-flow{position:absolute;left:0;top:0;bottom:0;width:var(--p,0%);border-radius:999px;overflow:hidden;pointer-events:none;opacity:0}
  .reasoning-low .param-slider-flow,
  .reasoning-high .param-slider-flow,
  .reasoning-max .param-slider-flow,
  .temp-slider .param-slider-flow{opacity:1}
  .param-slider-flow::after{content:"";position:absolute;top:0;bottom:0;width:52%;background:linear-gradient(90deg,transparent,rgba(255,255,255,.85),transparent);transform:translateX(-130%);animation:param-flow 2.6s linear infinite}
  .reasoning-high .param-slider-flow::after{animation-duration:2s}
  .reasoning-max .param-slider-flow::after{animation-duration:1.6s}
  .temp-slider .param-slider-flow::after{animation-duration:3.4s;opacity:.6}
  .param-slider-knob{position:absolute;top:50%;left:var(--p,0%);width:16px;height:16px;transform:translate(-50%,-50%);border-radius:50%;background:#fff;border:2px solid var(--c,#7ed07a);box-shadow:0 1px 5px rgba(0,0,0,.22);pointer-events:none;transition:left .1s linear,border-color .2s ease}
  .reasoning-off .param-slider-knob{border-color:#b7c0b4}
  .param-slider input[type="range"]{position:absolute;inset:-6px 0;width:100%;height:22px;margin:0;opacity:0;cursor:grab}
  .param-slider input[type="range"]:active{cursor:grabbing}
  .param-slider-value{min-width:36px;text-align:right;font-size:11.5px;color:var(--text-2);font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
  .param-slider-sparkles{position:absolute;left:0;top:0;bottom:0;width:var(--p,0%);border-radius:999px;overflow:hidden;pointer-events:none;opacity:0}
  .reasoning-max .param-slider-sparkles{opacity:1}
  .param-slider-sparkles i{position:absolute;width:3px;height:3px;border-radius:50%;background:#fff;box-shadow:0 0 4px #fff;animation:param-twinkle 1.6s ease-in-out infinite}
  .param-slider-sparkles i:nth-child(1){left:12%;top:25%}
  .param-slider-sparkles i:nth-child(2){left:28%;top:65%;animation-delay:.2s}
  .param-slider-sparkles i:nth-child(3){left:44%;top:30%;animation-delay:.45s}
  .param-slider-sparkles i:nth-child(4){left:58%;top:70%;animation-delay:.7s}
  .param-slider-sparkles i:nth-child(5){left:70%;top:22%;animation-delay:.95s}
  .param-slider-sparkles i:nth-child(6){left:82%;top:58%;animation-delay:1.2s}
  .param-slider-sparkles i:nth-child(7){left:92%;top:35%;animation-delay:1.45s}
  @keyframes param-flow{0%{transform:translateX(-130%)}100%{transform:translateX(240%)}}
  @keyframes param-twinkle{0%,100%{opacity:0;transform:scale(.55)}50%{opacity:1;transform:scale(1.25)}}
  @media (max-width: 720px){
    .param-slider-track{width:110px}
  }
  .model-mini-btn{height:28px;padding:0 9px;font-size:11.5px;display:inline-flex;align-items:center;gap:4px}
  .model-mini-btn svg{width:13px;height:13px}
  .model-mini-btn.primary-soft{background:var(--accent-soft);border-color:var(--accent-soft-2);color:var(--accent)}
  .model-mini-btn.primary-soft:hover{background:var(--accent-soft-2);color:var(--accent)}
  .model-danger-text{color:#c65b5b;border-color:rgba(198,91,91,.22)}
  .model-danger-text:hover{background:rgba(198,91,91,.06);color:#c65b5b}

  @media (max-width: 980px){
    .model-provider-layout{grid-template-columns:1fr}
    .model-provider-list{max-height:240px}
  }

  html[data-theme="dark"] .model-provider-side,
  html[data-theme="dark"] .model-provider-main{background:rgba(255,255,255,.05);border-color:rgba(255,255,255,.08)}
  html[data-theme="dark"] .model-textarea{background:rgba(255,255,255,.08);color:var(--text)}
  html[data-theme="dark"] .model-provider-item:hover{background:rgba(255,255,255,.07)}
  html[data-theme="dark"] .model-chip,
  html[data-theme="dark"] .model-flag{background:rgba(255,255,255,.09)}
  html[data-theme="dark"] .model-item.open{background:rgba(255,255,255,.04)}
  html[data-theme="dark"] .model-provider-del,
  html[data-theme="dark"] .model-delete-provider{background:rgba(198,91,91,.16);border-color:rgba(198,91,91,.4);color:#e08585}
  html[data-theme="dark"] .model-note{background:rgba(255,255,255,.035)}
`
