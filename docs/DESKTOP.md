<!--
念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
项目全称：念风 Chat（NianFeng-Chat）
仓库：https://github.com/nianfeng233/NianFeng-Chat
-->
# 桌面端打包（Rust + WebView2，已实现）

念风现在提供两套分发产物，均由 `scripts/package-release.mjs` 生成：

| 版本 | 目录 | 说明 |
|---|---|---|
| Web 源码 | `release/web/source/` | 纯净源码，不含个人数据与 `node_modules`，适合推送 GitHub |
| Web 部署 | `release/web/deploy/` | 自带便携 Node 运行时，双击 `启动念风.cmd` 即可运行 |
| 桌面源码 | `release/desktop/source/` | Rust 桌面壳源码 + 无 `official-service` 的运行时 app + 可嵌入的 Node 运行时 |
| 桌面部署 | `release/desktop/deploy/念风Chat.exe` | 单文件、无边框窗口、已内嵌 Node 运行时与全部前端资源 |

重新生成：

```bash
npm run build:release     # Web + 桌面
npm run build:desktop     # 只生成桌面版
npm run build:release -- --web-only   # 只生成 Web 版
```

## 桌面壳实现

- **窗口**：`tao` + `wry`，`WindowBuilder::with_decorations(false)`，页面通过 `window.windHost.window(action)` 调用最小化 / 最大化 / 关闭。
- **拖动**：优先使用 WebView2 123+ 的 `app-region: drag`；同时注入 JS fallback，在顶层栏按下鼠标时通过 IPC 调用 `window.drag_window()`。
- **后端**：Rust 先挑选一个空闲端口，启动内嵌的 `node.exe server/index.mjs`，通过环境变量传入：
  - `PORT`：随机本地端口
  - `NIANFENG_STATIC_DIR=.`：由后端直接托管 WebUI
  - `NIANFENG_DATA_DIR=%LOCALAPPDATA%\NianFengChat\user_data`：用户数据目录
- **资源**：`node.exe` 与干净的 `app/` 在编译时通过 `build.rs` / `app_assets.rs` 嵌入 exe；首次运行释放到 `%LOCALAPPDATA%\NianFengChat\runtime`，用 `.build-id` 判断是否需要更新。用户数据独立保存在 `%LOCALAPPDATA%\NianFengChat\user_data`，升级版本不会覆盖。
- **外部插件**：后端 `plugin-registry` 会扫描数据目录下的 `plugins/`（桌面版为 `%LOCALAPPDATA%\NianFengChat\user_data\plugins`），也可在「设置 → 插件 → 插件目录」指定任意目录；插件放在 `<目录>/<分层>/<插件id>/index.mjs`，重新扫描/刷新即可加载，升级 exe 不删除外部插件。
- **图标**：`scripts/desktop-wrapper/app.ico` 由 `scripts/generate-icon.ps1` 从 `logo.png` 生成圆角矩形多尺寸图标，构建时嵌入 Windows 资源；`app.rgba` 同时作为窗口 / 任务栏缩略图图标。
- **官方服务**：桌面版会在打包时移除 `plugins/features/official-service` 并重写 `plugins/registry.mjs`，因此账号页与「使用念风内置模型」入口不会出现在打包版本中。
- **快速关闭**：点击关闭按钮时先 `set_visible(false)` 隐藏窗口，再用 `CREATE_NO_WINDOW` 异步启动
  `taskkill /PID <node> /T /F` 清理进程树，**不再同步等待** taskkill，也不会闪出黑色控制台窗口；
  用户感知是“点一下就关”，后台进程树仍会被清理（避免残留 node 占用端口 / 影响下次启动）。

## 环境要求

- 开发机：Windows 10/11、Visual Studio Build Tools（MSVC linker）、Rust MSVC toolchain、WebView2 Runtime（Win11 / 新版 Edge 已自带）。
- 用户机：Windows 10/11；WebView2 Runtime 缺失时需安装 Evergreen Runtime。

## 数据目录

两个版本共用同一套数据目录解析规律：

1. 宿主只负责提供可写的 `NIANFENG_HOME_DIR`（桌面版为 `%LOCALAPPDATA%\NianFengChat`，Web 部署版为部署根目录）。
2. 本部署首次启动时，`server/data-dir.mjs` 会读取 `%APPDATA%\nianfeng\instance.json` 里的本机数据目录指针，自动加载之前使用过的数据目录。
3. 之后本部署只认 `NIANFENG_HOME_DIR/user_data/instance.json`，不会反复读取 AppData 指针覆盖数据目录。
4. 用户也可以在「设置 → 数据」里切换目录，记录会写入该本地指针。

- Web 部署默认位置：`release/web/deploy/user_data/`
- 桌面版：`%LOCALAPPDATA%\NianFengChat\user_data\`（若 LOCALAPPDATA 不可写，会回退到 exe 同级 `.nianfeng` 或 TEMP）
  * 默认外部插件目录：`%LOCALAPPDATA%\NianFengChat\user_data\plugins\`（设置里可改成任意外部目录）

两个版本都不会把会话、配置、密钥写进源码目录。

## 许可证与商用

- 依赖清单：`docs/DEPENDENCIES.md`（`npm run audit:deps` 重新生成）
- 第三方声明：`THIRD-PARTY-NOTICES.md`
- 商用检查建议：`docs/COMMERCIAL-USE.md`
- 发布 exe / Web 部署目录时，请一并保留 `LICENSE`、`THIRD-PARTY-NOTICES.md` 和 `docs/DEPENDENCIES.md`。
