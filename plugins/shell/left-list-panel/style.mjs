/** left-list-panel 样式：玻璃板 + 搜索框 + 滚动区 + 紧凑模式（取自 demo） */
export const LIST_PANEL_CSS = `
  .list-pane{
    margin:10px 0 10px 6px;
    border-radius:var(--pane-radius, var(--glass-radius));
    display:flex;flex-direction:column;
    position:relative;
    overflow:hidden;
    min-width:0;
  }
  .list-view[data-view="chat"] .list-pane{
    --glass-alpha: var(--glass-chat-list-alpha, .55);
    --glass-blur: var(--glass-chat-list-blur, 22px);
    --glass-saturate: var(--glass-chat-list-saturate, 150%);
    --glass-brightness: var(--glass-chat-list-brightness, 100%);
    --glass-border-width: var(--glass-chat-list-border-width, 1px);
  }
  .list-view[data-view="channel"] .list-pane{
    --glass-alpha: var(--glass-channel-list-alpha, .55);
    --glass-blur: var(--glass-channel-list-blur, 22px);
    --glass-saturate: var(--glass-channel-list-saturate, 150%);
    --glass-brightness: var(--glass-channel-list-brightness, 100%);
    --glass-border-width: var(--glass-channel-list-border-width, 1px);
  }
  body.resizing-v .list-pane{ box-shadow:var(--glass-shadow-hover); }

  .list-views{flex:1;min-height:0;display:flex;flex-direction:column;}
  .list-view{flex:1;min-height:0;display:flex;flex-direction:column;}

  .pane-head{
    display:flex;gap:8px;padding:14px 12px 10px;align-items:center;
    flex:0 0 auto;
  }
  .search-box{
    flex:1;display:flex;align-items:center;gap:7px;min-width:0;
    height:36px;padding:0 12px;
    background:rgba(255,255,255,.55);
    -webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);
    border-radius:10px;
    transition:background .18s ease, box-shadow .18s ease, padding .18s ease;
    cursor:text;
    box-shadow:0 1px 2px rgba(30,60,20,.04);
  }
  .search-box:hover{background:rgba(255,255,255,.8);}
  .search-box:focus-within{background:rgba(255,255,255,.96);box-shadow:0 0 0 2px var(--accent-soft-2);}
  .search-box input{
    flex:1;min-width:0;border:none;background:transparent;outline:none;
    font-size:13px;font-family:inherit;color:var(--text);
  }
  .search-box input::placeholder{color:var(--text-4);}
  .search-ico{width:15px;height:15px;color:var(--text-4);flex:0 0 auto;}

  .search-popover{
    position:absolute;top:14px;left:12px;width:248px;height:36px;
    display:none;align-items:center;gap:7px;padding:0 12px;
    background:rgba(255,255,255,.94);
    -webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);
    border:1px solid rgba(255,255,255,.6);border-radius:10px;
    box-shadow:var(--shadow-lg);
    z-index:100;
  }
  .search-popover.show{display:flex;}
  .search-popover input{
    flex:1;min-width:0;border:none;outline:none;background:transparent;
    font:inherit;font-size:13px;color:var(--text);
  }
  .search-popover input::placeholder{color:var(--text-4);}

  /* ---------------- 紧凑模式 ---------------- */
  .list-pane.compact .pane-head{padding:12px 6px;justify-content:center;}
  .list-pane.compact .search-box{
    flex:0 0 36px;width:36px;padding:0;justify-content:center;cursor:pointer;
  }
  .list-pane.compact .search-box input{display:none;}
  .list-pane.compact .search-box:focus-within{background:rgba(255,255,255,.55);box-shadow:none;}
  .list-pane.compact .add-channel{padding:0;gap:0;margin:2px 8px 6px;}
  .list-pane.compact .add-channel .btn-text{display:none;}
  .list-pane.compact .tabs{margin:8px 8px 10px;padding:2px;gap:1px;}
  .list-pane.compact .tab .tab-full{display:none;}
  .list-pane.compact .tab .tab-short{display:inline;}
  .list-pane.compact .nav-row{justify-content:center;padding:0;gap:0;margin:2px 6px;}
  .list-pane.compact .nav-row .nav-text,
  .list-pane.compact .nav-row .chev{display:none;}
  .list-pane.compact .group-head{padding:0 6px;gap:4px;justify-content:flex-start;}
  .list-pane.compact .group-head .group-count{display:none;}
  .list-pane.compact .channel-item{padding:0 6px 0 18px;gap:6px;}
  .list-pane.compact .empty-hint{display:none;}
`
