@echo off
rem 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
rem 项目全称：念风 Chat（NianFeng-Chat）
rem 仓库：https://github.com/nianfeng233/NianFeng-Chat
chcp 65001 >nul
setlocal EnableExtensions
cd /d "%~dp0"
title 念风 · 安装依赖

echo.
echo   念风依赖安装（cordis）
echo   --------------------------------
echo   如果你的网络需要代理才能访问 npm（例如本机代理 7890 端口），
echo   请在下面输入代理地址；直连用户直接回车跳过。
echo.

set "PROXY="
set /p PROXY=代理地址（如 http://127.0.0.1:7890，直接回车跳过）:

if not "%PROXY%"=="" (
    set "HTTP_PROXY=%PROXY%"
    set "HTTPS_PROXY=%PROXY%"
    set "NO_PROXY=localhost,127.0.0.1"
    echo   已设置代理：%PROXY%
    echo.
)

echo   正在执行 npm install ...
call npm install --no-audit --no-fund
if errorlevel 1 (
    echo.
    echo   [错误] 安装失败。请检查代理地址与网络后重试。
    echo.
    pause
    exit /b 1
)

echo.
echo   [完成] 依赖安装成功。以后双击 start.cmd 即可启动念风。
echo.
pause
