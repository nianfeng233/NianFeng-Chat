@echo off
rem 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
rem 项目全称：念风 Chat（NianFeng-Chat）
rem 仓库：https://github.com/nianfeng233/NianFeng-Chat
chcp 65001 >nul
cd /d "%~dp0"
title 念风chat · 仅后端
where node >nul 2>nul || (echo [错误] 未找到 Node.js & pause & exit /b 1)
if not exist "node_modules\cordis\lib\index.js" (echo [提示] 请先运行 install.cmd 安装依赖 & pause & exit /b 1)
node server/index.mjs
if errorlevel 1 pause
