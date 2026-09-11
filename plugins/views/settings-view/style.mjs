/** settings-view 样式：设置页外框与导航（取自 demo） */
export const SETTINGS_VIEW_CSS = `
  .settings-view{
    position:absolute;
    left:var(--rail-w);right:0;top:var(--titlebar-h);bottom:0;
    display:none;
    z-index:20;
    grid-template-columns:248px minmax(0,1fr);
    min-width:0;min-height:0;overflow:hidden;
    background:transparent;
  }
  .settings-view.show{display:grid;animation:settingsIn .18s ease;}
  @keyframes settingsIn{from{opacity:0;transform:translateY(4px);}to{opacity:1;transform:none;}}

  .settings-nav{
    --glass-alpha: var(--glass-settings-nav-alpha, .47);
    --glass-blur: var(--glass-settings-nav-blur, 22px);
    --glass-saturate: var(--glass-settings-nav-saturate, 150%);
    --glass-brightness: var(--glass-settings-nav-brightness, 100%);
    --glass-border-width: var(--glass-settings-nav-border-width, .5px);
    margin:10px 0 10px 0;
    padding:12px 10px;
    min-width:0;overflow-y:auto;overflow-x:hidden;
    border-radius:16px 0 0 16px;
    background:rgba(var(--glass-rgb), var(--glass-alpha, .47));
    -webkit-backdrop-filter:blur(var(--glass-blur, 22px)) saturate(var(--glass-saturate, 150%)) brightness(var(--glass-brightness, 100%));
    backdrop-filter:blur(var(--glass-blur, 22px)) saturate(var(--glass-saturate, 150%)) brightness(var(--glass-brightness, 100%));
    border:1px solid rgba(255,255,255,.68);
    border-width:var(--glass-border-width, .5px);
    border-right:none;
    box-shadow:0 14px 36px rgba(30,60,20,.08), inset 0 1px 0 rgba(255,255,255,.8);
  }
  .settings-nav::-webkit-scrollbar{width:6px}
  .settings-nav::-webkit-scrollbar-thumb{background:rgba(120,170,90,.16);border-radius:3px}
  .settings-nav-head{font-size:11px;color:var(--text-4);padding:3px 10px 9px;letter-spacing:.2px;}
  .settings-nav-group{margin-bottom:10px}
  .settings-nav-group:last-child{margin-bottom:0}
  .settings-nav-item{
    width:100%;height:38px;border:0;background:transparent;border-radius:9px;
    display:flex;align-items:center;gap:10px;padding:0 10px;color:var(--text-2);
    font:inherit;font-size:13px;text-align:left;cursor:pointer;transition:background .14s,color .14s,transform .14s;
  }
  .settings-nav-item:hover{background:rgba(255,255,255,.72);color:var(--text)}
  .settings-nav-item.active{background:rgba(255,255,255,.92);color:var(--accent);box-shadow:0 1px 4px rgba(30,60,20,.07)}
  .settings-nav-item svg{width:16px;height:16px;flex:0 0 16px;color:currentColor}
  .settings-nav-item .nav-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

  .settings-content-wrap{
    --glass-alpha: var(--glass-settings-content-alpha, .56);
    --glass-blur: var(--glass-settings-content-blur, 22px);
    --glass-saturate: var(--glass-settings-content-saturate, 150%);
    --glass-brightness: var(--glass-settings-content-brightness, 100%);
    --glass-border-width: var(--glass-settings-content-border-width, .5px);
    margin:10px 10px 10px 0;min-width:0;min-height:0;overflow:hidden;
    border-radius:0 16px 16px 0;
    background:rgba(var(--glass-rgb), var(--glass-alpha, .56));
    -webkit-backdrop-filter:blur(var(--glass-blur, 22px)) saturate(var(--glass-saturate, 150%)) brightness(var(--glass-brightness, 100%));
    backdrop-filter:blur(var(--glass-blur, 22px)) saturate(var(--glass-saturate, 150%)) brightness(var(--glass-brightness, 100%));
    border:1px solid rgba(255,255,255,.7);
    border-width:var(--glass-border-width, .5px);
    box-shadow:0 14px 36px rgba(30,60,20,.12), inset 0 1px 0 rgba(255,255,255,.85);
    display:flex;flex-direction:column;
  }
  .settings-content{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;padding:30px 46px 50px 42px;}
  .settings-content::-webkit-scrollbar{width:8px}
  .settings-content::-webkit-scrollbar-thumb{background:rgba(120,170,90,.18);border-radius:4px;border:2px solid transparent;background-clip:content-box}

  @media(max-width:820px){
    .settings-view{grid-template-columns:190px minmax(0,1fr)}
    .settings-content{padding:25px 26px 40px}
    .settings-nav-item{padding:0 8px}
  }
`
