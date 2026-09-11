@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 风语 · 关闭旧实例
echo 正在查找并关闭占用 5173 / 8788 的风语实例...
echo.
node scripts\stop.mjs %*
if errorlevel 1 (
  echo.
  echo [提示] node 方式失败，尝试 PowerShell 方式...
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop.ps1"
)
echo.
pause
