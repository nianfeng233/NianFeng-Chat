/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目：念风 Chat（NianFeng-Chat）
 *
 * 本文件是 QRCode for JavaScript 的 ESM 转换版（原版 MIT License，
 * Copyright (c) 2009 Kazuhiko Arase，来自 qrcode-terminal 的 vendor/QRCode）。
 * 仅用于在本地渲染微信 Clawbot 登录二维码，不参与联网请求。
 */
import QRMode from './QRMode.mjs';

/**
 * 8bit 字节模式。原版只取 charCodeAt & 0xff，无法正确编码中文；
 * 这里优先用 TextEncoder 按 UTF-8 编码，微信登录二维码内容可安全包含中文。
 */
function QR8bitByte(data) {
        this.mode = QRMode.MODE_8BIT_BYTE;
        this.data = String(data);
        this.bytes = typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(this.data) : null;
}

QR8bitByte.prototype = {

        getLength : function() {
                return this.bytes ? this.bytes.length : this.data.length;
        },

        write : function(buffer) {
                if (this.bytes) {
                        for (var i = 0; i < this.bytes.length; i++) {
                                buffer.put(this.bytes[i], 8);
                        }
                        return;
                }
                for (var i = 0; i < this.data.length; i++) {
                        buffer.put(this.data.charCodeAt(i) & 0xff, 8);
                }
        }
};

export default QR8bitByte;
