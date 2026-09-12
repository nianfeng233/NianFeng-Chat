/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/** tooltip-host 样式 */
export const TOOLTIP_CSS = `
  .wind-tooltip{
    position:fixed;z-index:500;max-width:280px;
    padding:7px 11px;border-radius:8px;
    background:rgba(35,40,34,.94);color:#fff;
    font-size:12px;line-height:1.5;letter-spacing:.1px;
    box-shadow:0 8px 22px rgba(0,0,0,.22);
    opacity:0;transform:translateY(3px);pointer-events:none;
    transition:opacity .14s ease, transform .14s ease;
  }
  .wind-tooltip.show{opacity:1;transform:none;}
`
