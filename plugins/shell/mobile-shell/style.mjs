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
    /* 手机端隐藏标题栏后 app-main 会成为第一个网格项；改为单行布局，避免它落进
       高度为 0 的标题栏行，导致会话 / 渠道主面板整体空白。 */
    grid-template-rows:minmax(0,1fr);
  }
  html[data-mobile-layout="1"] [data-slot="app:titlebar"]{display:none !important;}
  html[data-mobile-layout="1"] .app-main{
    grid-row:1;grid-column:1;min-width:0;min-height:0;overflow:hidden;
    /* rail 在手机端隐藏后 .body 会成为第一个网格项；如果保留 0 宽的 rail 列，
       主面板会被放进 0px 列，设置页正常但会话 / 渠道整片空白。 */
    grid-template-columns:minmax(0,1fr);
  }
  html[data-mobile-layout="1"] .rail{display:none !important;}
  html[data-mobile-layout="1"] .body{
    grid-template-columns:minmax(0,1fr);
    grid-template-rows:minmax(0,1fr);
    min-width:0;min-height:0;
  }
  html[data-mobile-layout="1"] .resizer{display:none !important;}

  html[data-mobile-layout="1"] .list-pane{
    margin:0;border-radius:0;border:0;box-shadow:none;height:100%;
    -webkit-backdrop-filter:none;backdrop-filter:none;background:rgba(255,255,255,.92);
  }
  html[data-mobile-layout="1"] .content{padding:0;min-height:0;}
  html[data-mobile-layout="1"] .chat-messages,
  html[data-mobile-layout="1"] .chat-list-slot,
  html[data-mobile-layout="1"] .channel-list-slot,
  html[data-mobile-layout="1"] .channel-detail-slot{min-height:0;}
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
    display:flex;flex-direction:column;gap:6px;max-height:124px;
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
  html[data-mobile-layout="1"] .settings-content{padding:18px 14px 32px;-webkit-overflow-scrolling:touch;}
  html[data-mobile-layout="1"] .settings-title{font-size:18px;}
  html[data-mobile-layout="1"] .settings-title-row{flex-direction:column;gap:10px;margin-bottom:18px;}
  html[data-mobile-layout="1"] .setting-row{flex-direction:column;align-items:flex-start;gap:9px;padding:12px 13px;min-height:0;}
  html[data-mobile-layout="1"] .setting-main{width:100%;flex:0 0 auto !important;}
  html[data-mobile-layout="1"] .setting-control{width:100%;flex:0 0 auto !important;justify-content:flex-start;flex-wrap:wrap;gap:8px 10px;}
  /* 插件生成的内联宽度是按桌面写的；手机上统一改为整行宽度，避免控件被挤出屏幕。 */
  html[data-mobile-layout="1"] .setting-input{width:100% !important;max-width:100%;}
  html[data-mobile-layout="1"] .setting-select{min-width:0;width:100% !important;max-width:100%;}
  html[data-mobile-layout="1"] .segmented{width:100%;max-width:100%;overflow-x:auto;}
  html[data-mobile-layout="1"] .segmented button{flex:1 0 auto;}
  /* 自定义提供商：桌面端 Setting 行用 flex:1 1 150px/240px 排版；手机切成竖排后
     如果不重置 flex-basis，它们会变成 150px/240px 的“高度”，整行被撑到几百
     像素高，看起来就是设置项之间的大片空白（模型页尤其明显）。 */
  html[data-mobile-layout="1"] .model-provider-layout{grid-template-columns:minmax(0,1fr);gap:10px;}
  html[data-mobile-layout="1"] .model-provider-side{min-height:0;max-height:none;padding:8px;}
  html[data-mobile-layout="1"] .model-provider-list{
    flex-direction:row;flex-wrap:nowrap;gap:8px;max-height:none;min-height:0;
    overflow-x:auto;overflow-y:hidden;padding:2px 2px 6px;-webkit-overflow-scrolling:touch;
  }
  html[data-mobile-layout="1"] .model-provider-list::-webkit-scrollbar{height:0;}
  html[data-mobile-layout="1"] .model-provider-item{flex:0 0 auto;width:auto;min-width:150px;max-width:250px;padding:8px 10px;}
  html[data-mobile-layout="1"] .model-provider-del{display:none;}
  html[data-mobile-layout="1"] .model-side-foot{display:none;}
  html[data-mobile-layout="1"] .model-provider-main .setting-main,
  html[data-mobile-layout="1"] .model-provider-main .setting-control{flex:0 0 auto !important;width:100%;}
  html[data-mobile-layout="1"] .model-provider-main .setting-control{justify-content:flex-start;}
  html[data-mobile-layout="1"] .model-detail-head,
  html[data-mobile-layout="1"] .model-list-head,
  html[data-mobile-layout="1"] .model-item-main-row,
  html[data-mobile-layout="1"] .provider-head,
  html[data-mobile-layout="1"] .plugin-row,
  html[data-mobile-layout="1"] .plugin-item,
  html[data-mobile-layout="1"] .coder-toolbar{flex-wrap:wrap;}
  html[data-mobile-layout="1"] .model-detail-actions,
  html[data-mobile-layout="1"] .model-list-actions{width:100%;justify-content:flex-start;flex-wrap:wrap;}
  html[data-mobile-layout="1"] .model-item-actions{width:100%;justify-content:flex-end;flex-wrap:wrap;}
  html[data-mobile-layout="1"] .model-editor{padding:2px 12px 12px;}
  html[data-mobile-layout="1"] .model-editor-grid{
    grid-template-columns:repeat(auto-fit,minmax(128px,1fr));
  }
  html[data-mobile-layout="1"] .model-form-grid,
  html[data-mobile-layout="1"] .model-advanced-grid{grid-template-columns:minmax(0,1fr);}
  /* 插件页：桌面端 info / actions 同排，手机上让操作按钮占满下一行。 */
  html[data-mobile-layout="1"] .plugin-item{align-items:flex-start;}
  html[data-mobile-layout="1"] .plugin-info{flex:1 1 100%;}
  html[data-mobile-layout="1"] .plugin-actions{width:100%;justify-content:flex-end;flex-wrap:wrap;}
  html[data-mobile-layout="1"] .plugin-toolbar-right{margin-left:0;width:100%;justify-content:flex-start;flex-wrap:wrap;}
  html[data-mobile-layout="1"] .glass-alpha-control{width:100%;min-width:0;}
  html[data-mobile-layout="1"] .file-picker{width:100%;max-width:100%;}
  html[data-mobile-layout="1"] .record-page{flex-direction:column;min-height:0;}
  html[data-mobile-layout="1"] .record-list{flex:0 0 auto;width:100%;max-height:260px;}
  html[data-mobile-layout="1"] .record-main{width:100%;}
  html[data-mobile-layout="1"] .record-cards{min-height:260px;max-height:none;}
  html[data-mobile-layout="1"] .record-source{min-height:320px;}
  html[data-mobile-layout="1"] .logs-toolbar{width:100%;}
  html[data-mobile-layout="1"] .logs-list{height:56vh;min-height:220px;}
  html[data-mobile-layout="1"] .h-resizer{display:none !important;}
  html[data-mobile-layout="1"] .composer{height:auto !important;min-height:52px;padding:7px 10px 9px;}
  html[data-mobile-layout="1"] .composer-tools{margin-bottom:4px;max-height:28px;}
  html[data-mobile-layout="1"] .composer-input{font-size:14px;line-height:1.65;}
  html[data-mobile-layout="1"] .tool-btn{width:29px;height:29px;}
  html[data-mobile-layout="1"] .send-btn,
  html[data-mobile-layout="1"] .stop-btn{height:34px;padding:0 14px;font-size:12.5px;}
  html[data-mobile-layout="1"] .chat-header{height:50px;flex-basis:50px;padding:0 10px;gap:8px;}
  html[data-mobile-layout="1"] .msg-scroll{padding:14px 12px 10px;-webkit-overflow-scrolling:touch;}
  html[data-mobile-layout="1"] .msg-row{gap:9px;margin-bottom:10px;}
  html[data-mobile-layout="1"] .msg-row .avatar{width:32px;height:32px;flex:0 0 32px;}
  html[data-mobile-layout="1"] .time-divider{margin:14px 0 11px;font-size:11px;}
  html[data-mobile-layout="1"] .logs-row{grid-template-columns:88px 110px minmax(0,1fr);font-size:10.5px;}
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
  html[data-mobile-layout="1"] .msg-bubble{max-width:88%;overflow-wrap:anywhere;}
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
