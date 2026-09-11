/** bubble-default 样式（取自 demo 的气泡部分） */
export const BUBBLE_DEFAULT_CSS = `
  .bubble-cluster{
    display:flex;flex-direction:column;align-items:flex-start;
    min-width:0;max-width:min(660px,72%);
  }
  .msg-row.right .bubble-cluster{align-items:flex-end;}
  .bubble{
    display:inline-block;
    max-width:100%;
    padding:7px 12px 6px;
    border-radius:14px;
    font-size:13.5px;line-height:1.62;
    color:var(--text);
    vertical-align:top;
  }
  .bubble-text{ white-space:pre-wrap; word-break:break-word; overflow-wrap:anywhere; }

  /* 调用详情：只出现在一轮调用的最末尾那条消息结尾，悬停该消息时显示 */
  .bubble-call-stats{
    display:none;
    clear:both;
    align-items:center;flex-wrap:wrap;gap:4px;
    margin-top:6px;padding-top:6px;
    border-top:1px dashed rgba(0,0,0,.07);
    font-size:10.5px;line-height:1;color:var(--text-4);
    overflow:hidden;text-overflow:ellipsis;
  }
  .bubble:hover .bubble-call-stats,
  .bubble-call-stats:focus-within{display:flex;}
  .msg-row.right .bubble-call-stats{
    border-top-color:rgba(80,150,50,.18);
    color:#5d8544;
  }
  .call-stat{
    display:inline-flex;align-items:center;gap:3px;
    padding:3px 7px;border-radius:999px;
    background:rgba(255,255,255,.58);
    border:1px solid rgba(255,255,255,.5);
  }
  html[data-theme="dark"] .call-stat{background:rgba(255,255,255,.07);border-color:rgba(255,255,255,.08);}
  .bubble-meta{
    float:right;
    display:inline-flex;align-items:center;gap:3px;
    margin:5px -3px 0 10px;
    font-size:11px;line-height:1;letter-spacing:.1px;
    white-space:nowrap;user-select:none;font-weight:400;
  }
  .bubble-time{ display:inline-block; }
  .check{ flex:0 0 auto;display:block;width:13px;height:9px;overflow:visible; }
  .check.double{ width:17px; }

  .msg-row:not(.right) .bubble{
    background:rgba(255,255,255,.78);
    -webkit-backdrop-filter: blur(10px);backdrop-filter: blur(10px);
    border-bottom-left-radius:6px;
    box-shadow:0 1px 4px rgba(30,60,20,.07), 0 0 0 1px rgba(255,255,255,.5) inset;
  }
  .msg-row:not(.right) .bubble-meta{ color:#98a890; }

  .msg-row.right .bubble{
    background:linear-gradient(135deg, rgba(212,242,180,.96) 0%, rgba(190,232,150,.96) 100%);
    color:#1e3f12;border-bottom-right-radius:6px;
    box-shadow:0 2px 8px rgba(100,170,70,.18);
  }
  .msg-row.right .bubble-text{ color:#1e3f12; }
  .msg-row.right .bubble-meta{ color:#5d8544; }
  .msg-row.right .bubble-meta .check.single{ color:#8ec277; }
  .msg-row.right .bubble-meta .check.double{ color:#6da554; }
  .msg-row.right .bubble-meta .check.double.read{ color:#3f8025; }

  .bubble .code{
    display:block;
    background:rgba(255,255,255,.7);
    border:1px solid rgba(0,0,0,.04);
    border-radius:8px;
    padding:10px 12px;margin:8px 0 6px;
    font-family:ui-monospace,Menlo,Consolas,monospace;
    font-size:12.5px;line-height:1.65;color:#3d4450;
    white-space:pre;overflow-x:auto;
  }
  .msg-row.right .bubble .code{
    background:rgba(255,255,255,.55);
    color:#2d4a1c;
    border-color:rgba(80,150,50,.12);
  }

  .bubble .stream-caret{
    display:inline-block;width:6px;height:14px;margin-left:3px;
    vertical-align:-2px;border-radius:2px;
    background:currentColor;opacity:.35;
    animation:caret 1s steps(1,end) infinite;
  }
  @keyframes caret{ 0%,49%{opacity:.35} 50%,100%{opacity:0} }
  /* 等待首个 token：三点交替呼吸 */
  .thinking-dots{display:inline-flex;align-items:center;gap:5px;padding:3px 1px}
  .thinking-dots i{width:7px;height:7px;border-radius:50%;background:currentColor;opacity:.3;animation:thinking-bounce 1.25s ease-in-out infinite}
  .thinking-dots i:nth-child(2){animation-delay:.16s}
  .thinking-dots i:nth-child(3){animation-delay:.32s}
  @keyframes thinking-bounce{0%,60%,100%{transform:translateY(0);opacity:.28}30%{transform:translateY(-4px);opacity:.95}}
  .avatar.avatar-img{background-size:cover;background-position:center;color:transparent}

  .bubble .bubble-translation{
    margin-top:6px;padding-top:6px;
    border-top:1px dashed rgba(0,0,0,.09);
    font-size:12.5px;line-height:1.6;color:var(--text-3);
    white-space:pre-wrap;word-break:break-word;
  }
  .msg-row.right .bubble .bubble-translation{border-top-color:rgba(80,150,50,.22);color:#41682c;}
  .bubble .bubble-error{
    margin-top:5px;font-size:11.5px;color:#c65b5b;
  }

  /* 资料消息：与普通文本气泡区分 */
  .bubble-doc{
    min-width:180px;padding:9px 11px;border-radius:10px;
    background:rgba(255,255,255,.55);border:1px dashed rgba(90,120,180,.35);
  }
  .msg-row.right .bubble-doc{background:rgba(255,255,255,.45);border-color:rgba(80,150,50,.28);}
  .bubble-doc-head{display:flex;align-items:center;gap:6px;font-weight:600;font-size:13px;}
  .bubble-doc-icon{font-size:15px;line-height:1;}
  .bubble-doc-summary{margin-top:5px;font-size:12.5px;line-height:1.6;opacity:.82;white-space:pre-wrap;word-break:break-word;}
  .bubble-doc-id{margin-top:4px;font-size:10.5px;opacity:.55;font-family:ui-monospace,Menlo,Consolas,monospace;}

  /* 历史脏数据兜底：隐藏误存进正文的工具标记 */
  .bubble-tool-hidden{
    display:inline-flex;align-items:center;gap:5px;
    padding:4px 8px;border-radius:8px;
    background:rgba(120,140,180,.12);border:1px dashed rgba(120,140,180,.35);
    color:var(--text-3);font-size:12px;
  }
`
