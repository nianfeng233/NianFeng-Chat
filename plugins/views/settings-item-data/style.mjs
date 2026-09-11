/** settings-item-data 样式：数据目录输入与警示条。 */
export const DATA_PAGE_CSS = `
  .data-path{width:min(430px,100%);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;color:var(--text-2);background:rgba(0,0,0,.025)}
  input.data-path:not([readonly]){background:rgba(255,255,255,.86);color:var(--text)}
  .setting-control .data-path{flex:1 1 260px}
  .data-warn{background:rgba(255,244,222,.9);color:#9a7418}
  html[data-theme="dark"] .data-warn{background:rgba(201,162,39,.12);color:#d8b64e}
  html[data-theme="dark"] input.data-path{background:rgba(255,255,255,.06)}
`
