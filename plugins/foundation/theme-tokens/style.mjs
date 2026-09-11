/** theme-tokens 的样式：沿用 demo 的 :root 变量，并补充深色主题覆盖。 */
export const THEME_CSS = `
  :root{
    --bg-muted:  rgba(255,255,255,.55);
    --bg-hover:  rgba(255,255,255,.78);
    --bg-glass:  rgba(255,255,255,.65);

    --text:   #1a1d21;
    --text-2: #5c6370;
    --text-3: #8b919c;
    --text-4: #aab0ba;

    --border:        rgba(0,0,0,.06);
    --border-strong: rgba(0,0,0,.12);

    --accent:        #3b6cf6;
    --accent-hover:  #2d5ce0;
    --accent-soft:   rgba(59,108,246,.10);
    --accent-soft-2: rgba(59,108,246,.22);

    --shadow-sm: 0 1px 2px rgba(16,24,40,.05);
    --shadow-md: 0 4px 14px rgba(16,24,40,.08);
    --shadow-lg: 0 12px 32px rgba(16,24,40,.14);

    --rail-w: 52px;
    --list-w: 300px;
    --resizer-w: 8px;
    --titlebar-h: 32px;

    --glass-rgb:    255,255,255;
    --glass-alpha:  .55;
    --glass-bg:     rgba(var(--glass-rgb), var(--glass-alpha));
    --glass-border: rgba(255,255,255,.7);
    --glass-radius: 16px;
    --glass-shadow: 0 14px 36px rgba(30,60,20,.12),
                    0 2px 8px rgba(30,60,20,.06),
                    inset 0 1px 0 rgba(255,255,255,.85);
    --glass-shadow-hover: 0 22px 52px rgba(30,60,20,.18),
                          0 4px 12px rgba(30,60,20,.09),
                          inset 0 1px 0 rgba(255,255,255,.9);
  }

  html[data-theme="dark"]{
    --bg-muted:  rgba(255,255,255,.05);
    --bg-hover:  rgba(255,255,255,.09);
    --bg-glass:  rgba(30,35,28,.6);

    --text:   #e9efe4;
    --text-2: #b9c2b2;
    --text-3: #8e9987;
    --text-4: #6d7668;

    --border:        rgba(255,255,255,.07);
    --border-strong: rgba(255,255,255,.14);

    --shadow-sm: 0 1px 2px rgba(0,0,0,.3);
    --shadow-md: 0 4px 14px rgba(0,0,0,.34);
    --shadow-lg: 0 12px 32px rgba(0,0,0,.42);

    --glass-rgb:    28,33,26;
    --glass-bg:     rgba(var(--glass-rgb), var(--glass-alpha));
    --glass-border: rgba(255,255,255,.09);
    --glass-shadow: 0 14px 36px rgba(0,0,0,.32),
                    0 2px 8px rgba(0,0,0,.22),
                    inset 0 1px 0 rgba(255,255,255,.06);
    --glass-shadow-hover: 0 22px 52px rgba(0,0,0,.42),
                          0 4px 12px rgba(0,0,0,.28),
                          inset 0 1px 0 rgba(255,255,255,.09);

    color-scheme: dark;
  }

  html[data-theme="dark"] body{ background:#191d17; }
  html[data-theme="dark"] .bg-aurora{ background:#191d17; }
  html[data-theme="dark"] .bg-aurora .blob{ opacity:.42; }
  html[data-theme="dark"] .titlebar{ background:rgba(var(--glass-rgb), var(--glass-titlebar-alpha, .42)); }
  html[data-theme="dark"] .bubble .code{ background:rgba(0,0,0,.28); color:#cfe0c2; }
  html[data-theme="dark"] .modal{ background:#232821; color:var(--text); }
  html[data-theme="dark"] .btn{ background:#2b312a; border-color:var(--border-strong); color:var(--text); }
  html[data-theme="dark"] .btn:hover{ background:#333a32; }
  html[data-theme="dark"] .context-menu,
  html[data-theme="dark"] .search-popover{ background:rgba(35,40,34,.96); }
  html[data-theme="dark"] .search-box{ background:rgba(255,255,255,.06); }
  html[data-theme="dark"] .search-box:hover{ background:rgba(255,255,255,.1); }
  html[data-theme="dark"] .search-box:focus-within{ background:rgba(255,255,255,.14); }
  html[data-theme="dark"] .conv-item.active,
  html[data-theme="dark"] .channel-item.active,
  html[data-theme="dark"] .group.drop-target > .group-head{ background:rgba(255,255,255,.12); }
  html[data-theme="dark"] .setting-input,
  html[data-theme="dark"] .setting-select,
  html[data-theme="dark"] .plugin-sort-select,
  html[data-theme="dark"] .outline-btn,
  html[data-theme="dark"] .plugin-action-btn{ background:rgba(255,255,255,.08); color:var(--text); }
  html[data-theme="dark"] .settings-card,
  html[data-theme="dark"] .plugin-item{ background:rgba(255,255,255,.05); }
  html[data-theme="dark"] .switch{ background:#4a5348; }
  html[data-theme="dark"] .segmented{ background:rgba(255,255,255,.07); }
  html[data-theme="dark"] .segmented button.active{ background:#333a32; color:var(--text); }
  html[data-theme="dark"] .msg-row:not(.right) .bubble{ background:rgba(255,255,255,.08); box-shadow:0 1px 4px rgba(0,0,0,.25); }

  .no-animation *{ transition:none !important; animation:none !important; }
`
