@echo off
rem 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
rem 项目全称：念风 Chat（NianFeng-Chat）
rem 仓库：https://github.com/nianfeng233/NianFeng-Chat
chcp 65001 >nul
cd /d "%~dp0"
title 念风chat · 关闭旧实例
echo 正在查找并关闭占用 5173 / 8788 的念风实例...
echo.
node scripts\stop.mjs %*
if errorlevel 1 (
  echo.
  echo [提示] node 方式失败，尝试 PowerShell 方式...
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop.ps1"
)
echo.
pause
