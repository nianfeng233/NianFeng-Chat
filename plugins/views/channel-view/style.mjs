/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/** channel-view 骨架样式 */
export const CHANNEL_VIEW_CSS = `
  .channel-list-slot{flex:1;min-height:0;display:flex;flex-direction:column;}
  /* 渠道详情统一由插槽负责纵向滚动：内置详情和 NapCat / QQ官方 / 微信插件
     自定义详情（wc-detail / nc-detail）都能完整往下翻，不会被裁切。 */
  .channel-detail-slot{
    flex:1;min-height:0;display:block;
    overflow-y:auto;overflow-x:hidden;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;
  }
  .channel-detail-slot > .empty-state{min-height:100%;height:100%;}
`
