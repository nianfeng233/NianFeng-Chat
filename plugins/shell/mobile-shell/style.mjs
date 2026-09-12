/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/** mobile-shell 样式：手机端自动切换为单栏 + 底部导航 */
export const MOBILE_SHELL_CSS = `
  html[data-mobile-layout="1"], html[data-mobile-layout="1"] body{overscroll-behavior:none;}
  html[data-mobile-layout="1"] .app{
    height:100vh;height:100dvh;box-sizing:border-box;
    padding-top:46px;padding-bottom:calc(54px + env(safe-area-inset-bottom, 0px));
    grid-template-rows:0 1fr;
  }
  html[data-mobile-layout="1"] [data-slot="app:titlebar"]{display:none !important;}
  html[data-mobile-layout="1"] .app-main{grid-template-columns:0 minmax(0,1fr);}
  html[data-mobile-layout="1"] .rail{display:none !important;}
  html[data-mobile-layout="1"] .body{grid-template-columns:minmax(0,1fr);}
  html[data-mobile-layout="1"] .resizer{display:none !important;}

  html[data-mobile-layout="1"] .list-pane{
    margin:0;border-radius:0;border:0;box-shadow:none;height:100%;
    -webkit-backdrop-filter:none;backdrop-filter:none;background:rgba(255,255,255,.92);
  }
  html[data-mobile-layout="1"] .content{padding:0;}
  html[data-mobile-layout="1"] .content > .pane-view{
    border-radius:0;border:0;box-shadow:none;
    -webkit-backdrop-filter:none;backdrop-filter:none;background:rgba(255,255,255,.92);
  }
  html[data-mobile-layout="1"] body.mobile-pane-main .list-pane{display:none !important;}
  html[data-mobile-layout="1"] body.mobile-pane-list .content{display:none !important;}

  .mobile-topbar{
    position:fixed;top:0;left:0;right:0;height:46px;z-index:60;
    display:none;align-items:center;gap:6px;padding:0 8px;box-sizing:border-box;
    background:rgba(255,255,255,.9);
    -webkit-backdrop-filter:blur(18px) saturate(160%);backdrop-filter:blur(18px) saturate(160%);
    border-bottom:1px solid rgba(0,0,0,.06);
    color:var(--text,#1a1d21);
  }
  html[data-mobile-layout="1"] .mobile-topbar{display:flex;}
  .mobile-topbar-btn{
    width:38px;height:38px;flex:0 0 38px;border:0;border-radius:10px;background:transparent;
    display:flex;align-items:center;justify-content:center;color:var(--text-2,var(--text,#1a1d21));
    cursor:pointer;font:inherit;
  }
  .mobile-topbar-btn:active{background:rgba(0,0,0,.06);}
  .mobile-topbar-btn svg{width:19px;height:19px;}
  .mobile-topbar-back{font-size:22px;line-height:1;padding-bottom:2px;}
  .mobile-topbar-title{
    flex:1;min-width:0;text-align:center;font-size:14.5px;font-weight:600;
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  }

  .mobile-tabbar{
    position:fixed;bottom:0;left:0;right:0;height:calc(54px + env(safe-area-inset-bottom, 0px));z-index:60;
    display:none;align-items:stretch;padding:2px 6px calc(2px + env(safe-area-inset-bottom, 0px));box-sizing:border-box;
    background:rgba(255,255,255,.94);
    -webkit-backdrop-filter:blur(18px) saturate(160%);backdrop-filter:blur(18px) saturate(160%);
    border-top:1px solid rgba(0,0,0,.07);
  }
  html[data-mobile-layout="1"] .mobile-tabbar{display:flex;}
  html[data-mobile-layout="1"] body.mobile-settings-open .mobile-tabbar{display:none;}
  body.mobile-settings-open .mobile-topbar{display:flex;}
  .mobile-tab{
    flex:1;min-width:0;border:0;background:transparent;border-radius:11px;color:var(--text-3,#8b919c);
    display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;
    font:inherit;font-size:10.5px;cursor:pointer;padding:3px 0;
  }
  .mobile-tab svg{width:20px;height:20px;}
  .mobile-tab .mobile-tab-label{max-width:72px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
  .mobile-tab.active{color:var(--accent,#70a15a);background:var(--accent-soft,rgba(112,161,90,.12));}

  /* 手机设置页：导航横向滚动，内容占满全屏（顶部保留自己的返回栏） */
  html[data-mobile-layout="1"] .settings-view{
    left:0;right:0;top:46px;bottom:0;
    grid-template-columns:minmax(0,1fr);
    grid-template-rows:auto minmax(0,1fr);
    background:rgba(255,255,255,.94);
  }
  html[data-mobile-layout="1"] .settings-nav{
    display:flex;flex-direction:column;gap:6px;
    margin:0;padding:8px 10px;border-radius:0;border:0;border-bottom:1px solid rgba(0,0,0,.06);
    overflow:hidden;
    -webkit-backdrop-filter:none;backdrop-filter:none;background:transparent;box-shadow:none;
  }
  html[data-mobile-layout="1"] .settings-nav-search{width:100%;margin:0;flex:0 0 34px;}
  html[data-mobile-layout="1"] .settings-nav-list{
    display:flex;flex-direction:row;gap:6px;min-width:0;
    overflow-x:auto;overflow-y:hidden;padding-bottom:2px;
  }
  html[data-mobile-layout="1"] .settings-nav-list::-webkit-scrollbar{height:0;}
  html[data-mobile-layout="1"] .settings-nav-group{display:contents;}
  html[data-mobile-layout="1"] .settings-nav-head{display:none;}
  html[data-mobile-layout="1"] .settings-nav-item{
    flex:0 0 auto;width:auto;height:34px;padding:0 13px;border-radius:9px;
    background:rgba(0,0,0,.035);font-size:12px;white-space:nowrap;
  }
  html[data-mobile-layout="1"] .settings-nav-item.active{background:#fff;box-shadow:0 1px 4px rgba(30,60,20,.1);}
  html[data-mobile-layout="1"] .settings-content-wrap{
    margin:0;border-radius:0;border:0;box-shadow:none;
    -webkit-backdrop-filter:none;backdrop-filter:none;background:transparent;
  }
  html[data-mobile-layout="1"] .settings-content{padding:18px 14px 32px;}
  html[data-mobile-layout="1"] .settings-title{font-size:18px;}
  html[data-mobile-layout="1"] .setting-row{flex-direction:column;align-items:flex-start;gap:9px;padding:12px 13px;}
  html[data-mobile-layout="1"] .setting-control{width:100%;justify-content:flex-start;flex-wrap:wrap;}
  html[data-mobile-layout="1"] .setting-select{min-width:0;width:100%;}
  html[data-mobile-layout="1"] .h-resizer{display:none !important;}
  html[data-mobile-layout="1"] .composer{height:auto !important;min-height:56px;padding:8px 10px 10px;}
  html[data-mobile-layout="1"] .chat-header{height:50px;flex-basis:50px;padding:0 10px;gap:8px;}
  html[data-mobile-layout="1"] .logs-row{grid-template-columns:66px 62px minmax(0,1fr);font-size:10.5px;}
  html[data-mobile-layout="1"] .logs-toolbar{gap:6px;}
  html[data-mobile-layout="1"] .logs-stats{flex-basis:100%;margin-left:0;text-align:right;}
  html[data-mobile-layout="1"] .nc-dialog,
  html[data-mobile-layout="1"] .wc-dialog{width:100vw;max-width:100vw;height:100vh;max-height:100vh;border-radius:0;}
  html[data-mobile-layout="1"] .nc-mask,
  html[data-mobile-layout="1"] .wc-mask{align-items:flex-start;}

  /* 9:16 手机竖屏：保证所有内容可滚动，不横向溢出、不被底栏吞掉 */
  html[data-mobile-layout="1"] .settings-content,
  html[data-mobile-layout="1"] .record-main,
  html[data-mobile-layout="1"] .record-cards,
  html[data-mobile-layout="1"] .msg-scroll,
  html[data-mobile-layout="1"] .chat-messages{overflow-x:hidden;}
  html[data-mobile-layout="1"] .setting-input,
  html[data-mobile-layout="1"] .setting-select,
  html[data-mobile-layout="1"] .record-source,
  html[data-mobile-layout="1"] .record-search{max-width:100%;}
  html[data-mobile-layout="1"] .msg-bubble{max-width:88%;}
  html[data-mobile-layout="1"] .conv-item,
  html[data-mobile-layout="1"] .channel-item,
  html[data-mobile-layout="1"] .group-head,
  html[data-mobile-layout="1"] .msg-row{-webkit-touch-callout:none;}
  @media (max-height:700px){
    html[data-mobile-layout="1"] .composer{min-height:48px;padding:6px 8px 8px;}
    html[data-mobile-layout="1"] .settings-content{padding:14px 12px 26px;}
  }

  html[data-theme="dark"][data-mobile-layout="1"] .list-pane,
  html[data-theme="dark"][data-mobile-layout="1"] .content > .pane-view,
  html[data-theme="dark"][data-mobile-layout="1"] .settings-view{background:rgba(20,24,28,.96);}
  html[data-theme="dark"][data-mobile-layout="1"] .mobile-topbar,
  html[data-theme="dark"][data-mobile-layout="1"] .mobile-tabbar{background:rgba(20,24,28,.96);border-color:rgba(255,255,255,.08);}
`
