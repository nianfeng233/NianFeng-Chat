/** settings-item-code-runner 样式：编辑器 / 输出区。 */
export const CODE_RUNNER_CSS = `
  .coder-toolbar{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 15px;border-bottom:1px solid rgba(0,0,0,.045);flex-wrap:wrap}
  .coder-hint{font-size:11px;color:var(--text-3)}
  .coder-actions{display:flex;gap:7px;flex-wrap:wrap}
  .coder-editor{display:block;width:100%;min-height:160px;border:0;border-bottom:1px solid rgba(0,0,0,.045);background:rgba(0,0,0,.018);padding:12px 15px;font:12px/1.65 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--text);outline:none;resize:vertical;box-sizing:border-box;tab-size:2}
  .coder-editor:focus{background:rgba(59,108,246,.03)}
  .coder-output-head{display:flex;align-items:center;justify-content:space-between;padding:7px 15px;font-size:11px;color:var(--text-3);background:rgba(0,0,0,.015)}
  .coder-output{margin:0;padding:12px 15px;min-height:120px;max-height:340px;overflow:auto;background:rgba(0,0,0,.025);font:11.5px/1.65 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;word-break:break-word;color:var(--text-2)}
  .coder-output[data-empty]:not(:empty){color:var(--text-2)}
  html[data-theme="dark"] .coder-editor,
  html[data-theme="dark"] .coder-output{background:rgba(255,255,255,.04)}
`
