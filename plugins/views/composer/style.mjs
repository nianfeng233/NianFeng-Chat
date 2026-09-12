/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/** composer 样式（取自 demo 的输入区部分） */
export const COMPOSER_CSS = `
  .h-resizer{
    flex:0 0 1px;height:1px;background:var(--border);
    cursor:row-resize;position:relative;z-index:10;
    transition:background .15s;
  }
  .h-resizer::before{content:"";position:absolute;left:0;right:0;top:-4px;bottom:-4px;}
  .h-resizer:hover,.h-resizer.dragging{background:rgba(120,180,90,.45);}

  .composer{
    flex:0 0 auto;
    height:170px;min-height:58px;
    padding:10px 20px 14px;
    display:flex;flex-direction:column;min-width:0;
    position:relative;background:transparent;
    box-sizing:border-box;
  }
  .composer-tools{
    display:flex;align-items:center;gap:2px;
    margin-bottom:6px;flex:0 0 auto;
    max-height:32px;opacity:1;overflow:hidden;
    transition:max-height .2s ease, opacity .2s ease, margin .2s ease;
  }
  .typing-hint{
    display:inline-flex;align-items:center;gap:5px;
    margin-right:6px;padding:0 8px;height:22px;
    font-size:12px;color:var(--accent);white-space:nowrap;
  }
  .typing-hint[hidden]{display:none;}
  .typing-hint::before{
    content:"";width:6px;height:6px;border-radius:50%;
    background:currentColor;opacity:.85;
    animation:typing-pulse 1s ease-in-out infinite;
  }
  @keyframes typing-pulse{0%,100%{opacity:.25;transform:scale(.85)}50%{opacity:.95;transform:scale(1)}}
  .tool-btn{
    width:32px;height:32px;border:none;background:transparent;border-radius:8px;
    color:var(--text-3);cursor:pointer;display:flex;align-items:center;justify-content:center;
    transition:background .14s ease, color .14s ease;
  }
  .tool-btn:hover{background:rgba(255,255,255,.78);color:var(--text);}
  .tool-btn.active{background:var(--accent-soft);color:var(--accent);}
  .tool-btn svg{width:17px;height:17px;}

  .composer-attachments{display:flex;gap:8px;flex-wrap:wrap;padding:2px 0 4px;}
  .composer-attachment{position:relative;margin:0;width:58px;height:58px;border-radius:11px;overflow:hidden;border:1px solid var(--border);background:rgba(255,255,255,.7);}
  .composer-attachment img{width:100%;height:100%;object-fit:cover;display:block;}
  .composer-attachment button{position:absolute;top:2px;right:2px;width:18px;height:18px;border:none;border-radius:50%;background:rgba(20,30,40,.62);color:#fff;font-size:13px;line-height:16px;cursor:pointer;padding:0;}
  .composer-attachment button:hover{background:rgba(200,60,60,.85);}

  .composer-body{ flex:1;min-height:0;display:flex;align-items:flex-end;gap:10px; }

  .composer-input{
    flex:1;align-self:stretch;min-width:0;min-height:28px;
    border:none;outline:none;resize:none;background:transparent;
    font-family:inherit;font-size:13.5px;line-height:1.7;color:var(--text);
    padding:6px 0;overflow-y:auto;
  }
  .composer-input::placeholder{color:var(--text-4);}
  .composer-input::-webkit-scrollbar{width:6px;}
  .composer-input::-webkit-scrollbar-thumb{
    background:rgba(120,170,90,.22);border-radius:3px;border:1px solid transparent;background-clip:content-box;
  }

  .stop-btn{
    flex:0 0 auto;
    display:none;align-items:center;justify-content:center;
    height:38px;padding:0 16px;border:1px solid rgba(198,91,91,.3);border-radius:10px;
    background:rgba(198,91,91,.08);color:#c65b5b;font-size:13px;font-weight:500;cursor:pointer;
    white-space:nowrap;transition:background .15s ease,border-color .15s ease;
  }
  .stop-btn.show{display:inline-flex;}
  .stop-btn:hover{background:rgba(198,91,91,.16);border-color:rgba(198,91,91,.5);}

  .send-btn{
    flex:0 0 auto;
    display:inline-flex;align-items:center;gap:6px;
    height:38px;padding:0 18px;border:none;border-radius:10px;
    background:var(--accent);color:#fff;font-size:13px;font-weight:500;cursor:pointer;
    transition:background .15s ease, transform .15s ease, box-shadow .15s ease;
    white-space:nowrap;
    box-shadow:0 2px 8px rgba(59,108,246,.28);
  }
  .send-btn:hover{background:var(--accent-hover);box-shadow:0 4px 12px rgba(59,108,246,.36);}
  .send-btn:active{transform:scale(.97);}
  .send-btn svg{width:12px;height:12px;opacity:.9;flex:0 0 auto;}

  .composer.compact{ padding-top:12px; }
  .composer.compact .composer-tools{
    position:absolute;left:20px;bottom:calc(100% + 4px);
    margin:0;padding:0;
    background:transparent;border:none;box-shadow:none;
    max-height:none;opacity:1;overflow:visible;
    gap:4px;z-index:30;
  }
  .composer.compact .tool-btn{
    width:28px;height:28px;border-radius:50%;
    background:transparent;color:var(--text-3);
  }
  .composer.compact .tool-btn:hover{
    background:rgba(255,255,255,.85);color:var(--text);
  }
`
