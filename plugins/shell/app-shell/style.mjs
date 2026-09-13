/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/** app-shell 样式：骨架、玻璃、面板容器、空状态（取自 demo 的骨架部分） */
export const APP_SHELL_CSS = `
  *{box-sizing:border-box;}
  /* 统一 hidden 语义：插件样式常写 display:flex/grid，会覆盖浏览器默认的
     [hidden]{display:none}；全局补一条，避免批量工具条、返回键、附件栏等
     在 hidden=true 时仍然显示。 */
  [hidden]{display:none !important;}
  html,body{height:100%;margin:0;}

  body{
    font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei","Segoe UI",sans-serif;
    font-size:13px;color:var(--text);overflow:hidden;
    -webkit-font-smoothing:antialiased;
    text-rendering:optimizeLegibility;
    background:#ffffff;
    position:relative;
    isolation:isolate;
  }

  button{font-family:inherit;}

  body.resizing-v, body.resizing-v * {cursor:col-resize !important;user-select:none !important;}
  body.resizing-h, body.resizing-h * {cursor:row-resize !important;user-select:none !important;}
  body.dragging-channel, body.dragging-channel * {cursor:grabbing !important;user-select:none !important;}

  /* 插槽宿主：不参与布局，让插件内容直接成为父级 grid/flex 的子项 */
  .slot-host{display:contents;}

  .app{
    position:relative;z-index:1;
    height:100vh;width:100vw;
    display:grid;
    grid-template-rows:var(--titlebar-h) 1fr;
    overflow:hidden;
  }

  .app-main{
    position:relative;
    display:grid;
    grid-template-columns:var(--rail-w) 1fr;
    min-width:0;min-height:0;
    overflow:hidden;
  }

  .body{
    display:grid;
    grid-template-columns:var(--list-w) var(--resizer-w) 1fr;
    min-width:0;min-height:0;
    overflow:hidden;
    transition:grid-template-columns .22s cubic-bezier(.4,0,.2,1);
  }
  body.resizing-v .body{ transition:none; }

  .glass{
    background:rgba(var(--glass-rgb), var(--glass-alpha, .55));
    -webkit-backdrop-filter: blur(var(--glass-blur, 22px)) saturate(var(--glass-saturate, 150%)) brightness(var(--glass-brightness, 100%));
    backdrop-filter: blur(var(--glass-blur, 22px)) saturate(var(--glass-saturate, 150%)) brightness(var(--glass-brightness, 100%));
    border:1px solid var(--glass-border);
    border-width:var(--glass-border-width, 1px);
    box-shadow:var(--glass-shadow);
    transition:box-shadow .2s ease;
  }

  .resizer{
    background:transparent;
    position:relative;
    cursor:col-resize;
    z-index:20;
    align-self:stretch;
  }
  .resizer::before{content:"";position:absolute;left:-4px;right:-4px;top:0;bottom:0;}
  .resizer::after{
    content:"";
    position:absolute;left:50%;top:50%;
    width:3px;height:0;border-radius:2px;
    background:rgba(100,160,70,.55);
    transform:translate(-50%,-50%);
    transition:height .18s ease, opacity .18s ease;
    opacity:0;
  }
  .resizer:hover::after, .resizer.dragging::after{ height:44px; opacity:1; }

  .pane-view{flex:1;min-height:0;display:flex;flex-direction:column;}

  .scroll{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;}
  .scroll::-webkit-scrollbar{width:8px;}
  .scroll::-webkit-scrollbar-thumb{
    background:rgba(120,170,90,.18);border-radius:4px;border:2px solid transparent;background-clip:content-box;
  }
  .scroll::-webkit-scrollbar-thumb:hover{background:rgba(120,170,90,.32);background-clip:content-box;border:2px solid transparent;}
  .scroll::-webkit-scrollbar-track{background:transparent;}

  .empty-state{
    flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;
    gap:12px;color:var(--text-4);padding:0 24px;text-align:center;
  }
  .empty-state svg{width:56px;height:56px;color:rgba(150,180,120,.32);}
  .empty-title{font-size:14px;color:var(--text-2);font-weight:500;}
  .empty-sub{font-size:12.5px;color:var(--text-4);}

  /* 头像：会话列表与消息行共用 */
  .avatar{
    width:38px;height:38px;flex:0 0 38px;border-radius:50%;
    background:linear-gradient(135deg,var(--c1,#8ab4ff),var(--c2,#5a8dff));
    color:#fff;display:flex;align-items:center;justify-content:center;
    font-size:14px;font-weight:500;user-select:none;
    letter-spacing:.5px;
    box-shadow:0 1px 3px rgba(30,60,20,.1);
  }
`
