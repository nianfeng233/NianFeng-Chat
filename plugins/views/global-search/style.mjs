/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/** global-search 样式：居中的搜索浮层，复用玻璃拟态变量。 */
export const GLOBAL_SEARCH_CSS = `
  .gsearch-mask{
    position:fixed;inset:0;z-index:90;
    display:none;align-items:flex-start;justify-content:center;
    padding:12vh 18px 24px;
    background:rgba(20,26,18,.28);
    -webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px);
  }
  .gsearch-mask.show{display:flex;animation:gsearchFade .14s ease;}
  .gsearch-panel{
    width:min(620px,100%);max-height:min(70vh,580px);
    display:flex;flex-direction:column;min-height:0;overflow:hidden;
    background:rgba(255,255,255,.97);
    border:1px solid rgba(255,255,255,.7);
    border-radius:16px;
    box-shadow:0 24px 64px rgba(20,40,15,.28), inset 0 1px 0 rgba(255,255,255,.9);
    animation:gsearchRise .16s ease;
  }
  .gsearch-head{
    display:flex;align-items:center;gap:10px;flex:0 0 auto;
    padding:12px 14px;border-bottom:1px solid var(--border);
  }
  .gsearch-ico{display:inline-flex;color:var(--text-3);flex:0 0 auto;}
  .gsearch-ico svg{width:18px;height:18px;}
  .gsearch-input{
    flex:1;min-width:0;border:0;outline:0;background:transparent;
    font:inherit;font-size:14px;color:var(--text);
  }
  .gsearch-input::placeholder{color:var(--text-4);}
  .gsearch-kbd{
    flex:0 0 auto;font:11px ui-monospace,SFMono-Regular,Menlo,monospace;
    color:var(--text-4);border:1px solid var(--border-strong);border-radius:5px;
    padding:2px 6px;background:rgba(0,0,0,.025);
  }
  .gsearch-body{flex:1;min-height:0;overflow-y:auto;padding:7px;}
  .gsearch-body::-webkit-scrollbar{width:8px;}
  .gsearch-body::-webkit-scrollbar-thumb{
    background:rgba(120,170,90,.18);border-radius:4px;border:2px solid transparent;background-clip:content-box;
  }
  .gsearch-group{margin-bottom:4px;}
  .gsearch-group-title{
    display:flex;align-items:center;justify-content:space-between;
    padding:8px 10px 4px;font-size:11.5px;color:var(--text-4);
  }
  .gsearch-group-title i{font-style:normal;font-size:10.5px;}
  .gsearch-item{
    width:100%;border:0;background:transparent;border-radius:10px;
    display:flex;flex-direction:column;gap:3px;
    padding:9px 11px;text-align:left;font:inherit;cursor:pointer;
    transition:background .14s ease;
  }
  .gsearch-item:hover,.gsearch-item.active{background:var(--bg-hover);}
  .gsearch-item-title{
    font-size:13px;color:var(--text);font-weight:500;
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  }
  .gsearch-item-snippet{
    font-size:11.5px;color:var(--text-3);
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  }
  .gsearch-empty{padding:44px 16px;text-align:center;color:var(--text-4);font-size:12.5px;line-height:1.7;}
  .gsearch-foot{
    flex:0 0 auto;display:flex;align-items:center;justify-content:space-between;gap:8px;
    padding:9px 14px;border-top:1px solid var(--border);
    font-size:11px;color:var(--text-4);
  }
  html[data-theme="dark"] .gsearch-panel{background:rgba(35,40,34,.97);border-color:rgba(255,255,255,.09);}
  html[data-theme="dark"] .gsearch-kbd{background:rgba(255,255,255,.06);}
  @media(max-width:640px){
    .gsearch-mask{padding:8vh 10px 16px;}
    .gsearch-panel{max-height:76vh;}
  }
  @keyframes gsearchFade{from{opacity:0}to{opacity:1}}
  @keyframes gsearchRise{from{opacity:0;transform:translateY(8px) scale(.985)}to{opacity:1;transform:none}}
`
