/** channel-list 样式（取自 demo 的渠道列表部分） */
export const CHANNEL_LIST_CSS = `
  .add-channel{
    margin:2px 14px 6px;height:38px;
    border:1px dashed rgba(120,170,90,.35);
    border-radius:10px;
    background:rgba(255,255,255,.4);
    display:flex;align-items:center;justify-content:center;gap:7px;
    font-size:13px;color:var(--text-2);cursor:pointer;
    transition:border-color .18s ease, background .18s ease, color .18s ease, padding .18s ease;
    flex:0 0 auto;
  }
  .add-channel:hover{border-color:var(--accent);background:rgba(59,108,246,.1);color:var(--accent);}
  .add-channel svg{width:15px;height:15px;flex:0 0 auto;}

  .nav-row{
    display:flex;align-items:center;gap:9px;height:38px;margin:2px 8px;
    padding:0 10px;border-radius:8px;cursor:pointer;font-size:13px;color:var(--text-2);
    transition:background .14s ease, color .14s ease;
    flex:0 0 auto;
  }
  .nav-row:hover{background:var(--bg-hover);color:var(--text);}
  .nav-ico{width:16px;height:16px;color:var(--text-3);flex:0 0 auto;display:inline-flex;}
  .nav-ico svg{width:16px;height:16px;}
  .nav-row .chev{margin-left:auto;color:var(--text-4);width:14px;height:14px;flex:0 0 auto;display:inline-flex;}
  .nav-row .chev svg{width:14px;height:14px;}

  .tabs{
    display:flex;gap:2px;margin:8px 14px 10px;padding:3px;
    background:rgba(255,255,255,.55);
    -webkit-backdrop-filter: blur(8px);backdrop-filter: blur(8px);
    border-radius:10px;
    transition:margin .18s ease, padding .18s ease;
    box-shadow:0 1px 2px rgba(30,60,20,.04);
    flex:0 0 auto;
  }
  .tab{
    flex:1;min-width:0;height:28px;border:none;background:transparent;border-radius:7px;
    font-size:12.5px;color:var(--text-3);cursor:pointer;padding:0;
    transition:background .16s ease, color .16s ease, box-shadow .16s ease;
  }
  .tab:hover{color:var(--text);}
  .tab.active{background:#fff;color:var(--text);font-weight:500;box-shadow:var(--shadow-sm);}
  .tab .tab-short{display:none;}
  html[data-theme="dark"] .tab.active{background:rgba(255,255,255,.14);}

  #groupsContainer{padding:0 6px 12px;}
  .group{margin-bottom:2px;}
  .group-head{
    display:flex;align-items:center;gap:7px;height:34px;
    padding:0 10px;border-radius:8px;
    cursor:pointer;font-size:13px;user-select:none;
    transition:background .14s ease;
  }
  .group-head:hover{background:var(--bg-hover);}
  .group-head .chev{
    width:14px;height:14px;flex:0 0 auto;color:var(--text-4);
    transition:transform .18s ease;display:inline-flex;
  }
  .group-head .chev svg{width:14px;height:14px;}
  .group-head.expanded .chev{transform:rotate(90deg);}
  .group-name{
    flex:1;min-width:0;color:var(--text);font-weight:500;
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  }
  .group-count{
    font-size:11.5px;color:var(--text-4);flex:0 0 auto;
    background:rgba(255,255,255,.72);border-radius:8px;padding:1px 7px;
    min-width:20px;text-align:center;
  }

  .group.drop-target > .group-head{
    background:rgba(255,255,255,.92);
    box-shadow:inset 0 0 0 1px var(--accent-soft-2);
  }
  .group.drop-target > .group-body{
    background:rgba(255,255,255,.55);
    border-radius:8px;
    box-shadow:inset 0 0 0 1px rgba(59,108,246,.18);
    margin:0;padding:3px 0;
  }

  .channel-item{
    display:flex;align-items:center;gap:10px;height:34px;
    padding:0 10px 0 30px;border-radius:8px;
    cursor:pointer;font-size:13px;color:var(--text-2);
    transition:background .14s ease, color .14s ease;
    min-width:0;
  }
  .channel-item:hover{background:var(--bg-hover);color:var(--text);}
  .channel-item.active{background:rgba(255,255,255,.85);color:var(--accent);box-shadow:0 1px 2px rgba(30,60,20,.06);}
  html[data-theme="dark"] .channel-item.active{background:rgba(255,255,255,.12);}
  .dot{width:8px;height:8px;border-radius:50%;flex:0 0 auto;box-shadow:0 0 0 3px rgba(255,255,255,.55);}
  .channel-name{
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;
  }
  .empty-hint{ padding:8px 0 8px 30px;font-size:12.5px;color:var(--text-4); }

  .channel-ghost{
    display:flex;align-items:center;gap:10px;
    padding:8px 14px;border-radius:9px;
    background:rgba(255,255,255,.95);
    box-shadow:0 10px 26px rgba(30,60,20,.22);
    font-size:13px;color:var(--text);
    z-index:600;pointer-events:none;opacity:.94;
  }
`
