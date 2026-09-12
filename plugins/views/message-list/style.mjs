/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/** message-list 样式：滚动区、行布局、时间分隔线（取自 demo） */
export const MESSAGE_LIST_CSS = `
  .msg-scroll{
    flex:1 1 0;min-height:0;
    overflow-y:auto;padding:22px 24px 16px;
    background:transparent;
  }
  .msg-scroll::-webkit-scrollbar{width:8px;}
  .msg-scroll::-webkit-scrollbar-thumb{
    background:rgba(120,170,90,.18);border-radius:4px;border:2px solid transparent;background-clip:content-box;
  }
  .msg-scroll::-webkit-scrollbar-thumb:hover{background:rgba(120,170,90,.32);background-clip:content-box;border:2px solid transparent;}
  .msg-scroll::-webkit-scrollbar-track{background:transparent;}

  .msg-row{display:flex;gap:11px;align-items:flex-start;margin-bottom:12px;}
  .msg-row.right{flex-direction:row-reverse;}
  .msg-row .avatar{width:34px;height:34px;flex:0 0 34px;font-size:13px;margin-top:2px;}

  .time-divider{
    text-align:center;font-size:11.5px;color:var(--text-3);
    margin:20px 0 16px;
    text-shadow:0 1px 3px rgba(255,255,255,.9);
  }
`
