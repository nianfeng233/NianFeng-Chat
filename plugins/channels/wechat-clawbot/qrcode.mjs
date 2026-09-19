/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 *
 * 二维码渲染已抽到共享模块 src/vendor/qrcode，QQBot / 微信 Clawbot
 * 两个渠道不再各自复制一份 vendor 实现。
 */
export { renderQrSvg, isQrImageContent } from '../../../src/vendor/qrcode/index.mjs'
