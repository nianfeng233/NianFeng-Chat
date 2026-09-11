@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 风语 · 单端口模式
where node >nul 2>nul || (echo [错误] 未找到 Node.js & pause & exit /b 1)
if not exist "node_modules\cordis\lib\index.js" (echo [提示] 请先运行 install.cmd 安装依赖 & pause & exit /b 1)
node start.mjs --serve
if errorlevel 1 pause
