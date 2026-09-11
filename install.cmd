@echo off
chcp 65001 >nul
setlocal EnableExtensions
cd /d "%~dp0"
title 风语 · 安装依赖

echo.
echo   风语依赖安装（cordis）
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
echo   [完成] 依赖安装成功。以后双击 start.cmd 即可启动风语。
echo.
pause
