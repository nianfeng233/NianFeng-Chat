<!--
念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
项目全称：念风 Chat（NianFeng-Chat）
仓库：https://github.com/nianfeng233/NianFeng-Chat
-->
# Windows 使用指南

念风在 Windows 上的目标：**双击一个脚本就能用**，不需要记命令行。

---

## 一、首次使用

1. 安装 **Node.js 20 或更高版本**（[nodejs.org](https://nodejs.org/)，安装时保持默认选项即可）
2. 双击 **`install.cmd`**
   * 直连用户：提示输入代理时直接回车
   * 需要代理的用户（例如本机 7890 端口）：输入 `http://127.0.0.1:7890` 后回车
3. 安装完成后再双击 **`start.cmd`**，浏览器会自动打开念风

> 如果双击 `start.cmd` 时依赖已经装好，它会直接启动，不会重复安装。

---

## 二、脚本一览

| 文件 | 用途 | 说明 |
|---|---|---|
| `start.cmd` | **主入口（双击）** | 检查 Node → 缺依赖自动安装 → 启动后端 + WebUI → 自动开浏览器 |
| `install.cmd` | 安装/修复依赖 | 支持填代理；网络正常时也可直接回车 |
| `start.ps1` | PowerShell 版启动器 | 参数更丰富，适合放进计划任务/快捷方式 |
| `serve.cmd` | 单端口模式 | 只开 5173，后端同时托管 WebUI |
| `backend.cmd` | 只启动后端 | API 在 8788，适合单独调接口 |
| `scripts/create-shortcut.ps1` | 创建桌面快捷方式 | 一键生成“念风Chat”快捷方式 |

`start.ps1` 的常用参数：

```powershell
.\start.ps1                                   # 正常启动
.\start.ps1 -NoOpen                           # 不自动开浏览器
.\start.ps1 -Serve                            # 单端口模式
.\start.ps1 -WebPort 8080 -BackendPort 9000   # 自定义端口
.\start.ps1 -Proxy http://127.0.0.1:7890      # 首次装依赖时走代理
```

在资源管理器里右键 `start.ps1 → 使用 PowerShell 运行`，出错时窗口会停留，方便看日志。

### 创建桌面快捷方式

```powershell
powershell -ExecutionPolicy Bypass -File scripts\create-shortcut.ps1
```

会在桌面生成“念风Chat”，双击等价于运行 `start.cmd`。
（快捷方式图标尝试使用 `public/assets/logo.png`；如果 Windows 不显示图标，可以把一个 `.ico`
放到 `public/assets/logo.ico` 后重新运行该脚本。）

---

## 三、运行时

* WebUI：<http://127.0.0.1:5173>
* 后端 API：<http://127.0.0.1:8788/api/health>
* 数据目录：项目下的 `user_data\`（默认，可切换）
* 外部插件：默认读取数据目录下的 `user_data\plugins\`，也可在「设置 → 插件 → 插件目录」指定任意目录；放进插件文件夹后重新扫描即可，无需重新生成 registry.mjs
  * `config.json` — 配置与模型凭据（API Key）
  * `sessions.json` — 会话元数据（名称 / 预览 / 渠道绑定）
  * `chat.db` — 全部聊天记录原文（内置 SQLite；旧版 sessions.json 首次启动会自动迁移）

关闭黑窗口（或按 Ctrl+C）即退出念风；所有数据已落盘，下次启动会恢复。

### 端口被占用？

用环境变量或 PowerShell 参数换端口：

```powershell
$env:WEB_PORT=8080; $env:BACKEND_PORT=9000; node start.mjs
# 或
.\start.ps1 -WebPort 8080 -BackendPort 9000
```

---

## 四、常见问题

**双击 `念风Chat.exe` 没反应**
先看 `%LOCALAPPDATA%\NianFengChat\error.log`；新版桌面壳会在启动失败时弹窗并写这个日志。
桌面版运行时目录现在按构建号隔离（`runtime-<BUILD_ID>`），升级时旧版本 `node.exe` 仍在运行也不会再因为“文件被占用(os error 32)”导致打不开。
如果仍然打不开，可以在任务管理器结束旧的 `念风Chat` / 由它启动的 `node.exe`，或删除 `%LOCALAPPDATA%\NianFengChat\runtime*` 后重试。

**双击后一闪而过 / 提示缺少 Node.js**
说明 Node 未安装或未加入 PATH。重新安装 Node.js 后重试；也可以先跑 `start.ps1` 看具体错误。

**`npm install` 失败（超时、证书、ECONNRESET）**
双击 `install.cmd`，填入你的代理地址（如 `http://127.0.0.1:7890`）再试。
注意：念风运行本身**不需要**代理，只有安装依赖和调用云端模型时可能需要。

**Windows 防火墙弹窗**
只有本机回环监听（127.0.0.1），可以直接点“允许”或“取消”，不影响本机使用。
如果你希望同一局域网的其他设备访问，需要自行改成监听 0.0.0.0 并放行端口。

**想让念风开机自启 / 后台常驻？**
可以用“任务计划程序”创建任务，操作填：
`powershell -NoProfile -WindowStyle Hidden -File <项目路径>\start.ps1 -NoOpen`
触发器选“登录时”。（注意：隐藏窗口后退出需要用任务管理器结束 node 进程。）

**杀毒软件误报？**
`.cmd` / `.ps1` 只是调用本机 Node，没有加壳或下载行为，可加白名单。打包成 `.exe`（见 `DESKTOP.md`）后同理。

**数据备份 / 迁移**
直接复制整个 `data\` 目录即可；换机器时把它放到新项目目录下就行。


