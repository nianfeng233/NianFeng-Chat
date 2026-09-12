/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/** right-main-panel 样式：一块大玻璃板（取自 demo 的 .content） */
export const MAIN_PANEL_CSS = `
  .content{
    display:flex;
    min-width:0;min-height:0;
    overflow:hidden;
    background:transparent;
    padding:10px 10px 10px 0;
  }

  .content > .pane-view{
    flex:1;
    min-width:0;min-height:0;
    border-radius:var(--glass-radius);
    overflow:hidden;
    display:flex;flex-direction:column;
    background:rgba(var(--glass-rgb), var(--glass-alpha, .55));
    -webkit-backdrop-filter:blur(var(--glass-blur, 22px)) saturate(var(--glass-saturate, 150%)) brightness(var(--glass-brightness, 100%));
    backdrop-filter:blur(var(--glass-blur, 22px)) saturate(var(--glass-saturate, 150%)) brightness(var(--glass-brightness, 100%));
    border:1px solid var(--glass-border);
    border-width:var(--glass-border-width, 1px);
    box-shadow:var(--glass-shadow);
    transition:box-shadow .2s ease;
  }
  .content > .main-view[data-view="chat"]{
    --glass-alpha: var(--glass-chat-main-alpha, .55);
    --glass-blur: var(--glass-chat-main-blur, 22px);
    --glass-saturate: var(--glass-chat-main-saturate, 150%);
    --glass-brightness: var(--glass-chat-main-brightness, 100%);
    --glass-border-width: var(--glass-chat-main-border-width, 1px);
  }
  .content > .main-view[data-view="channel"]{
    --glass-alpha: var(--glass-channel-main-alpha, .55);
    --glass-blur: var(--glass-channel-main-blur, 22px);
    --glass-saturate: var(--glass-channel-main-saturate, 150%);
    --glass-brightness: var(--glass-channel-main-brightness, 100%);
    --glass-border-width: var(--glass-channel-main-border-width, 1px);
  }
  body.resizing-v .content > .pane-view{
    box-shadow:var(--glass-shadow-hover);
  }
`
