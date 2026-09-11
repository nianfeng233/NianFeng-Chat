/** titlebar 样式：demo 的 .titlebar / 品牌 / 用户 / 窗口按钮 */
export const TITLEBAR_CSS = `
  .titlebar{
    height:var(--titlebar-h);
    display:flex;align-items:center;gap:0;
    padding-left:12px;
    border-bottom:1px solid rgba(0,0,0,.05);
    border-bottom-width:var(--glass-titlebar-border-width, .5px);
    background:rgba(var(--glass-rgb), var(--glass-titlebar-alpha, .42));
    -webkit-backdrop-filter:blur(var(--glass-titlebar-blur, 14px)) saturate(var(--glass-titlebar-saturate, 150%)) brightness(var(--glass-titlebar-brightness, 100%));
    backdrop-filter:blur(var(--glass-titlebar-blur, 14px)) saturate(var(--glass-titlebar-saturate, 150%)) brightness(var(--glass-titlebar-brightness, 100%));
    user-select:none;
    overflow:hidden;
    position:relative;z-index:5;
    -webkit-app-region:drag;app-region:drag;
  }
  .tb-left,.tb-right{display:flex;align-items:center;min-width:0;flex:0 0 auto;}
  .tb-center{flex:1 1 auto;min-width:0;display:flex;align-items:center;overflow:hidden;}
  .tb-right{margin-left:auto;}
  .tb-left,.tb-center,.tb-right{-webkit-app-region:no-drag;app-region:no-drag;}

  .tb-brand{display:flex;align-items:center;gap:7px;flex:0 0 auto;padding-right:12px;-webkit-app-region:no-drag;app-region:no-drag;}
  .tb-logo{width:20px;height:20px;flex:0 0 20px;display:block;object-fit:contain;border-radius:5px;}
  .tb-name{font-size:13.5px;font-weight:600;letter-spacing:.4px;color:var(--text);white-space:nowrap;}

  .tb-divider{
    width:1px;height:16px;
    background:rgba(0,0,0,.08);
    flex:0 0 1px;
    margin:0 12px 0 4px;
  }

  .tb-user{display:flex;align-items:center;gap:8px;flex:1 1 auto;min-width:0;overflow:hidden;padding-right:8px;-webkit-app-region:no-drag;app-region:no-drag;}
  .tb-avatar{
    width:22px;height:22px;flex:0 0 22px;
    border:0;padding:0;cursor:pointer;font:inherit;
    border-radius:50%;
    background:linear-gradient(135deg,#a8b6ff 0%,#5a8dff 100%);color:#fff;
    display:flex;align-items:center;justify-content:center;
    font-size:10.5px;font-weight:600;letter-spacing:.3px;
    box-shadow:0 1px 2px rgba(30,60,20,.18);user-select:none;overflow:hidden;
  }
  .tb-avatar:focus-visible{outline:2px solid var(--accent);outline-offset:2px;}
  .tb-avatar:hover{box-shadow:0 2px 6px rgba(30,60,20,.24);}
  .tb-avatar-logo{background:rgba(255,255,255,.92);}
  .tb-avatar-logo img{width:100%;height:100%;object-fit:contain;display:block;padding:2px;box-sizing:border-box;}
  .tb-avatar:not(.tb-avatar-logo) img{width:100%;height:100%;object-fit:cover;display:block;}
  .tb-signature{flex:1 1 auto;min-width:0;display:flex;align-items:center;position:relative;}
  .sig-input{
    width:100%;min-width:0;
    border:none;background:transparent;outline:none;
    font-family:inherit;font-size:12px;color:var(--text-3);
    padding:3px 8px;border-radius:6px;
    text-overflow:ellipsis;
    transition:background .15s ease,color .15s ease,box-shadow .15s ease;
  }
  .sig-input::placeholder{color:var(--text-4);}
  .sig-input:hover{background:rgba(255,255,255,.78);color:var(--text-2);}
  .sig-input:focus{background:#fff;color:var(--text);box-shadow:0 0 0 3px var(--accent-soft);}
  /* 桌面端：签名仍整段展示，但只有左侧 1/3 是输入区，右侧 2/3 用于拖动窗口 */
  .sig-drag-zone{
    position:absolute;left:33.333%;right:0;top:0;bottom:0;
    display:block;pointer-events:none;
  }
  body[data-env="app"] .sig-drag-zone{
    pointer-events:auto;cursor:default;
    -webkit-app-region:drag;app-region:drag;
  }

  .tb-winbtns{
    display:flex;align-self:stretch;align-items:stretch;
    height:var(--titlebar-h);min-height:var(--titlebar-h);
    -webkit-app-region:no-drag;app-region:no-drag;
  }
  body[data-env="web"] .tb-winbtns{display:none;}
  .win-btn{
    width:46px;height:100%;min-height:var(--titlebar-h);
    padding:0;border:none;border-radius:0;box-sizing:border-box;background:transparent;
    color:var(--text-2);cursor:pointer;outline:none;
    display:flex;align-items:center;justify-content:center;
    transition:background .14s ease,color .14s ease;
  }
  .win-btn svg{width:10px;height:10px;display:block;}
  .win-btn:hover{background:rgba(0,0,0,.06);color:var(--text);}
  .win-btn:active{background:rgba(0,0,0,.1);}
  .win-btn.close:hover{background:#e81123;color:#fff;}
  .win-btn.close:active{background:#c50f1f;color:#fff;}
  html[data-theme="dark"] .titlebar{background:rgba(28,33,26,.5);}
  html[data-theme="dark"] .win-btn:hover{background:rgba(255,255,255,.08);}
  html[data-theme="dark"] .sig-input:focus{background:rgba(255,255,255,.12);}
  html[data-theme="dark"] .tb-divider{background:rgba(255,255,255,.14);}
`
