<!--
念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
项目全称：念风 Chat（NianFeng-Chat）
仓库：https://github.com/nianfeng233/NianFeng-Chat
-->
# 第三方组件与许可证声明

> 念风原创代码、文档、界面与资源使用 Apache License 2.0（见根目录 LICENSE 与 NOTICE）；release/publish 发布仓库同样适用。
> 本文件仅列出第三方组件与相应许可证义务。


本文件用于满足念风项目的第三方依赖署名与许可证声明义务。
`docs/DEPENDENCIES.md` 由 `npm run audit:deps` 自动生成，包含完整依赖清单；
本文件给出最重要的分发注意事项与通用许可证文本。

> 本文件不是法律意见。正式发布 / 商用前，请结合你的分发方式、所在司法辖区
> 和实际使用的模型服务条款做最终确认。

## 1. Node.js 运行时

桌面版 `念风Chat.exe` 内嵌了 Node.js 运行时，并会释放到本机运行；Web 部署版在
`runtime/node.exe` 中携带便携运行时。本次构建使用 Node.js v24.x。

Node.js 主体使用 MIT 许可证；发行版中还包含 V8、OpenSSL、c-ares、ICU 等
第三方组件，完整许可证文本见 Node.js 官方仓库的 `LICENSE` 文件：

- https://github.com/nodejs/node/blob/main/LICENSE

分销时请至少：保留本声明、保留 Node.js 官方许可证链接，并不要移除 `node.exe`
中自带的版权 / 许可证信息。

## 2. Web / Node 依赖

| 组件 | 版本 | 许可证 | 上游 |
|---|---|---|---|
| cordis | 4.0.0-rc.10 | MIT | https://github.com/cordiverse/cordis |
| cosmokit | 1.8.1 | MIT | https://github.com/shigma/cosmokit |
| @standard-schema/spec | 1.1.0 | MIT | https://github.com/standard-schema/standard-schema |

这些依赖均为 MIT 许可证，允许商业使用、修改与再分发，但需要保留版权声明
与许可证文本。

## 2.1 内置 QRCode（共享模块）

`src/vendor/qrcode/` 是 **QRCode for JavaScript** 的 ESM 转换版，来自
`qrcode-terminal` 的 `vendor/QRCode`，由 QQBot 与微信 Clawbot 渠道插件共用：

- Copyright (c) 2009 Kazuhiko Arase
- MIT License（<https://opensource.org/licenses/MIT>）
- 用途：QQ / 微信 Clawbot 登录二维码的本地渲染；不参与联网请求。

分发时请随项目保留本声明与 `src/vendor/qrcode/` 中的版权/许可证注释。

## 2.2 点歌台内置 SILK 编码器（silk-wasm）

`extensions/media-post/vendor/silk-wasm/` 内置了 **silk-wasm** 的发布文件，
用于把 PCM 编码为 QQ 官方机器人语音所需的 SILK：

- Copyright (c) 2024 idranme
- MIT License（<https://opensource.org/licenses/MIT>）
- 上游：https://github.com/idranme/silk-wasm
- 用途：点歌台 `media-post` 向 QQ 官方机器人发送语音时的本地编码；不联网。

分发时请保留 `extensions/media-post/vendor/silk-wasm/` 中的 LICENSE 与版权声明。
## 3. Rust 桌面壳依赖

Rust 依赖及许可证清单见 [`docs/DEPENDENCIES.md`](docs/DEPENDENCIES.md)，
当前审计结果的许可证类别为：

- `MIT OR Apache-2.0` / `Apache-2.0 OR MIT`
- `MIT`
- `Apache-2.0`
- `Unicode-3.0`（ICU4X 相关 Unicode 数据）
- `CC0-1.0 OR MIT-0 OR Apache-2.0`
- `MIT OR Apache-2.0 OR Zlib`

未发现 GPL / AGPL / LGPL / SSPL 等 copyleft 依赖；这些宽松许可证均可用于
闭源商业分发。

Apache-2.0 许可证要求保留版权、许可证与 NOTICE（如上游提供）。Rust crates
的完整许可证文件位于其发布包中；发布二进制时请保留 `docs/DEPENDENCIES.md`、
本文件以及 `release/` 各部署目录中的声明文件。

## 4. Microsoft WebView2 Runtime

桌面版通过 Microsoft Edge WebView2 Runtime 渲染界面。念风不复制、不修改
WebView2 Runtime 本身；最终用户需按 Microsoft 的许可条款安装 / 使用该运行时：

- https://learn.microsoft.com/microsoft-edge/webview2/

若你未来选择捆绑 WebView2 Evergreen Bootstrapper，请另外遵守 Microsoft 的
再分发条款。

## 5. 模型服务与第三方商标

念风本身只是客户端，不内置任何模型或官方云服务。用户接入的
DeepSeek / OpenAI / Anthropic / Google Gemini / Ollama 等服务，分别受
各自的服务条款、隐私政策与商标政策约束。商业分发时请注意：

- 不要暗示与这些厂商存在官方合作或背书；
- 模型输入输出内容的使用、版权与数据合规由使用者和对应服务条款共同约束；
- “DeepSeek”“OpenAI”“Claude”“Gemini”等名称如用于宣传，需遵守相应商标规范。

## 6. 项目 Logo、图标与字体

- 项目自带 Logo / 图标 / 界面资源的使用权由项目作者确认；若使用 AI 生成或
  第三方素材，请保留生成 / 授权凭证。
- 当前界面使用系统字体（系统 UI 字体栈），未随项目分发第三方字体文件。

## 7. 通用 MIT 许可证文本

以下文本适用于前述 MIT 许可组件；各项目版权持有人以其 LICENSE 文件为准。

```text
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 8. 发布检查清单

- [ ] `LICENSE` 中的项目自身版权主体已改为真实姓名 / 公司主体
- [ ] 保留 `THIRD-PARTY-NOTICES.md` 与 `docs/DEPENDENCIES.md`
- [ ] Node.js 官方许可证链接可访问，且未移除 `node.exe` 内置版权信息
- [ ] Rust 依赖如有升级，已重新运行 `npm run audit:deps`
- [ ] 已遵守所接入模型服务的条款与商标规范
- [ ] 如未来捆绑 WebView2 Runtime 引导程序，已单独核对 Microsoft 条款
