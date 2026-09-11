/** channel-detail-host 样式 */
export const CHANNEL_DETAIL_CSS = `
  .channel-detail{
    flex:1;min-height:0;overflow-y:auto;
    padding:26px 34px 40px;
  }
  .channel-detail-head{display:flex;align-items:center;gap:14px;}
  .channel-avatar{
    width:48px;height:48px;border-radius:50%;flex:0 0 48px;
    background:linear-gradient(135deg,var(--c1,#8ab4ff),var(--c2,#5a8dff));
    color:#fff;display:flex;align-items:center;justify-content:center;
    font-size:17px;font-weight:600;box-shadow:0 2px 8px rgba(30,60,20,.12);
  }
  .channel-detail-main{flex:1;min-width:0;}
  .channel-detail-name{font-size:19px;font-weight:650;color:var(--text);letter-spacing:.1px;}
  .channel-detail-sub{font-size:12.5px;color:var(--text-3);margin-top:5px;}
  .channel-status{font-size:12px;flex:0 0 auto;}
  .channel-code{
    font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
    font-size:11.5px;color:var(--text-2);
    background:rgba(0,0,0,.045);border-radius:5px;padding:3px 7px;
  }
  .channel-detail .settings-section{margin-top:22px;}
  .channel-detail .settings-section-title{margin-bottom:9px;}
`
