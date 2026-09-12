/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/** session-list 样式（取自 demo 的会话项部分） */
export const SESSION_LIST_CSS = `
  #convList{padding:0 6px 10px;}
  #convList .empty-hint{padding:14px 12px;font-size:12.5px;color:var(--text-4);text-align:center;}

  .pane-head .icon-btn{
    width:36px;height:36px;flex:0 0 36px;
    border:none;background:rgba(255,255,255,.55);border-radius:10px;
    color:var(--text-3);cursor:pointer;
    display:flex;align-items:center;justify-content:center;
    transition:background .15s ease,color .15s ease;
    box-shadow:0 1px 2px rgba(30,60,20,.04);
  }
  .pane-head .icon-btn:hover{background:rgba(255,255,255,.85);color:var(--accent);}
  .pane-head .icon-btn.active{background:var(--accent-soft);color:var(--accent);}
  .pane-head .icon-btn svg{width:16px;height:16px;}
  .list-pane.compact .pane-head .icon-btn{display:none;}

  .batch-bar{display:flex;align-items:center;flex-wrap:wrap;gap:6px;margin:0 8px 8px;padding:8px 9px;border-radius:10px;background:rgba(255,255,255,.78);border:1px solid rgba(0,0,0,.06);font-size:11.5px;color:var(--text-3);}
  .batch-bar span{flex:1 1 auto;min-width:60px;}
  .batch-bar button{border:1px solid rgba(0,0,0,.09);background:#fff;border-radius:7px;padding:3px 8px;font:inherit;font-size:11.5px;color:var(--text-2);cursor:pointer;}
  .batch-bar button:hover{background:#f7f8f6;color:var(--text);}
  .batch-bar button.danger{color:#c65b5b;border-color:rgba(198,91,91,.25);}
  .conv-item.batch-checked{background:rgba(112,161,90,.12);}
  .conv-check{width:20px;height:20px;flex:0 0 20px;border-radius:50%;border:1.5px solid rgba(0,0,0,.18);display:flex;align-items:center;justify-content:center;color:#fff;background:#fff;font-size:11px;}
  .conv-item.batch-checked .conv-check{background:var(--accent,#70a15a);border-color:var(--accent,#70a15a);}
  .conv-check svg{width:12px;height:10px;}

  .sync-banner{
    display:flex;align-items:center;gap:6px;
    margin:0 12px 8px;padding:7px 10px;
    border-radius:9px;
    background:rgba(255,243,224,.85);
    color:#a5721a;font-size:11.5px;line-height:1.4;
  }
  .sync-banner span{flex:1;min-width:0;}
  .sync-retry{
    flex:0 0 auto;height:22px;padding:0 8px;border:1px solid rgba(165,114,26,.3);
    background:transparent;border-radius:6px;color:#a5721a;font:inherit;font-size:11px;cursor:pointer;
  }
  .sync-retry:hover{background:rgba(165,114,26,.08);}
  .list-pane.compact .sync-banner{display:none !important;}

  .conv-item{
    position:relative;
    display:flex;
    gap:11px;
    align-items:center;
    padding:9px 36px 9px 10px;
    margin-bottom:1px;
    border-radius:10px;
    cursor:pointer;
    transition:background .14s ease;
    overflow:hidden;
    min-width:0;
    justify-content:flex-start;
  }
  .conv-item:hover{background:var(--bg-hover);}
  .conv-item.active{background:rgba(255,255,255,.9);box-shadow:0 1px 4px rgba(30,60,20,.08);}
  .conv-item.active .conv-name{color:var(--accent);}
  .conv-item .avatar-img{background-size:cover;background-position:center;color:transparent;}
  .conv-del{
    position:absolute;right:7px;top:50%;transform:translateY(-50%);
    width:24px;height:24px;border:1px solid rgba(198,91,91,.25);border-radius:7px;
    background:rgba(198,91,91,.08);color:#c65b5b;display:flex;align-items:center;justify-content:center;
    cursor:pointer;opacity:0;transition:opacity .14s ease,background .14s ease;
  }
  .conv-del svg{width:13px;height:13px;}
  .conv-item:hover .conv-del,.conv-item.active .conv-del,.conv-item:focus-within .conv-del{opacity:1;}
  .conv-del:hover{background:rgba(198,91,91,.2);}
  @media (hover: none){.conv-del{opacity:1;}}

  .conv-main{
    flex:1 1 auto;
    min-width:0;
    display:flex;
    flex-direction:column;
    justify-content:center;
    gap:3px;
    overflow:hidden;
  }
  .conv-top{
    display:flex;
    align-items:center;
    gap:6px;
    min-width:0;
    overflow:hidden;
  }
  .conv-name{
    flex:1 1 auto;
    min-width:0;
    font-size:13.5px;
    font-weight:500;
    color:var(--text);
    overflow:hidden;
    text-overflow:ellipsis;
    white-space:nowrap;
  }
  .conv-time{
    flex:0 0 auto;
    font-size:11.5px;
    color:var(--text-4);
    white-space:nowrap;
  }
  .conv-msg{
    font-size:12.5px;
    color:var(--text-3);
    overflow:hidden;
    text-overflow:ellipsis;
    white-space:nowrap;
  }

  .list-pane.compact #convList{padding:0 6px 10px;}
  .list-pane.compact .conv-item{
    justify-content:center;
    gap:0;
    padding:8px 0;
  }
  .list-pane.compact .conv-main{ display:none; }
  /* 收起成头像栏时不再显示行内删除按钮，否则会压在头像上；删除仍可用右键菜单完成。 */
  .list-pane.compact .conv-del{ display:none; }
  .list-pane.compact .conv-item.active{ box-shadow:0 0 0 2px var(--accent-soft-2),0 1px 4px rgba(30,60,20,.08); }

  /* 紧凑模式下搜索浮层改为固定定位（坐标由 JS 写入），避免被窄面板裁切 */
  .list-pane.compact .search-popover{ position:fixed;top:0;left:0;width:280px; }
`
