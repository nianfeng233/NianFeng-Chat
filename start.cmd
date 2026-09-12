@echo off
rem 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
rem 项目全称：念风 Chat（NianFeng-Chat）
rem 仓库：https://github.com/nianfeng233/NianFeng-Chat
chcp 65001 >nul
setlocal EnableExtensions
cd /d "%~dp0"
title 念风chat

echo.
echo   ============================================
echo    念风chat  （后端 + WebUI 一键启动）
echo   ============================================
echo.

rem ---- 检查 Node.js ----
where node >nul 2>nul
if errorlevel 1 (
    echo   [错误] 没有找到 Node.js。
    echo   请先安装 Node.js 20 或更高版本：https://nodejs.org/
    echo.
    pause
    exit /b 1
)

for /f "delims=." %%v in ('node -p "process.versions.node"') do set "NODE_MAJOR=%%v"
if %NODE_MAJOR% LSS 20 (
    echo   [错误] Node.js 版本过低（当前 %NODE_MAJOR%），需要 20 或更高。
    echo   请从 https://nodejs.org/ 升级后重试。
    echo.
    pause
    exit /b 1
)

rem ---- 首次运行自动安装依赖 ----
if not exist "node_modules\cordis\lib\index.js" (
    echo   [提示] 首次运行，需要安装依赖（cordis）...
    echo          如果下载失败，请先双击 install.cmd 配置代理。
    echo.
    call npm install --no-audit --no-fund
    if errorlevel 1 (
        echo.
        echo   [错误] 依赖安装失败。可以双击 install.cmd 填写代理后重试。
        echo.
        pause
        exit /b 1
    )
)

echo   正在启动，浏览器会自动打开；关闭本窗口即退出念风。
echo.
node start.mjs
set "EXITCODE=%ERRORLEVEL%"

if not "%EXITCODE%"=="0" (
    echo.
    echo   [错误] 念风启动失败（退出码 %EXITCODE%）。
    echo   请把上面的日志发给开发者，或查看 README.md 的常见问题。
    echo.
    pause
)
exit /b %EXITCODE%
