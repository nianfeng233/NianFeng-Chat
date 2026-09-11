/** bg-image 样式：图片铺满背景层，并加一层可读性蒙版。 */
export const BG_IMAGE_CSS = `
  .bg-image-inner{position:absolute;inset:0;background-size:cover;background-position:center;background-repeat:no-repeat;background-color:transparent}
  .bg-image-inner::after{content:"";position:absolute;inset:0;background:linear-gradient(180deg,rgba(255,255,255,.30),rgba(255,255,255,.58))}
  html[data-theme="dark"] .bg-image-inner::after{background:linear-gradient(180deg,rgba(12,16,12,.46),rgba(12,16,12,.74))}
`
