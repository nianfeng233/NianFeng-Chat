<!--
念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
项目全称：念风 Chat（NianFeng-Chat）
仓库：https://github.com/nianfeng233/NianFeng-Chat
-->
# 商用可行性检查

> 结论基于当前仓库在 2026-09 的依赖快照与本地审计结果，不构成法律意见。
> 正式商用前，请由法务 / 合规人员结合你的分发方式复核。

## 一、当前结论

**代码与依赖层面：具备闭源商业分发的基础条件。**

- Node / Web 依赖仅 3 个，全部为 MIT，允许商业使用与再分发。
- Rust 桌面依赖共 82 个（当前 Windows 目标），许可证为
  MIT / Apache-2.0 / Zlib / Unicode-3.0 / CC0-1.0 等宽松类别；
  未发现 GPL / AGPL / LGPL / SSPL 等 copyleft 依赖。
- 项目代码、插件系统、本地后端均为原创实现，不包含官方服务端的模拟云逻辑。
- WebView2 Runtime 不随项目再分发，由最终用户环境提供。
- Node.js 运行时以 MIT 为主，发行版内第三方组件按其官方 `LICENSE` 授权。

## 二、需要发布者自行确认的事项

| 事项 | 说明 | 建议 |
|---|---|---|
| 项目自身 LICENSE | 原创代码、文档、界面与资源使用 **Apache-2.0**（见 `LICENSE` 与 `NOTICE`） | 分发时保留 `LICENSE` / `NOTICE` / `THIRD-PARTY-NOTICES.md` |
| Logo / 图标 / UI 素材 | 需确认原创或已取得授权 | 保留设计源文件与授权记录 |
| 产品名称 / 商标 | 念风、NianFeng 如用于商业名称，建议先做商标检索 | 咨询知识产权代理 |
| 模型 API | DeepSeek / OpenAI / Anthropic / Gemini / Ollama 等各有服务条款 | 商用前核对对应条款、数据地域与内容政策 |
| AI 输出内容 | 生成内容的版权归属与合规责任由用户和服务条款共同决定 | 在用户协议中明确 |
| 用户数据 | 项目本地保存 API Key、会话与配置；Web 部署也涉及用户数据 | 准备隐私政策、备份与删除机制 |
| WebView2 | 最终用户需安装运行时；若未来捆绑引导程序需另遵守 Microsoft 条款 | 阅读 WebView2 分发文档 |
| 出口 / 制裁合规 | 如果面向受制裁地区分发，需额外评估 | 咨询合规人员 |
| 第三方许可证文本 | MIT / Apache-2.0 要求保留版权与许可证声明 | 保留 `THIRD-PARTY-NOTICES.md` |

## 三、分发时的最低合规动作

1. 在 Web 部署目录与桌面 exe 发布目录中保留：
   - `THIRD-PARTY-NOTICES.md`
   - `docs/DEPENDENCIES.md`
   - 项目自身 `LICENSE`
2. 不要移除 `node.exe` 内置的版权 / 许可证信息。
3. 若升级依赖，重新运行：

   ```bash
   npm run audit:deps
   ```

4. 仔细阅读 [`THIRD-PARTY-NOTICES.md`](../THIRD-PARTY-NOTICES.md) 第 5 节有关模型服务与商标的说明。
5. 对外用户协议 / 隐私政策应明确：模型请求会发送到用户配置的第三方服务商。

## 四、结论

在“仅分发念风客户端、模型由用户自带、不冒充官方服务、遵守各模型厂商条款”的
前提下，当前依赖链没有发现阻止商业分发的许可证问题，**可以用于商用**。

但以下情况仍可能带来额外义务，需要发布者自行处理：

- 把模型服务包装成自己的官方服务；
- 使用未授权的名称 / Logo / 字体 / 数据；
- 在受制裁地区分发或使用受出口管制的模型；
- 未保留第三方 MIT / Apache-2.0 声明。
