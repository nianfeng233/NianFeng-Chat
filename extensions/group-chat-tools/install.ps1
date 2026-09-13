# 念风chat · 扩展插件安装脚本 · group-chat-tools
#
# 用法（在任意目录均可执行）：
#   powershell -ExecutionPolicy Bypass -File .\extensions\group-chat-tools\install.ps1
#   .\extensions\group-chat-tools\install.ps1 -DataDir "D:\nianfeng-data"
#   .\extensions\group-chat-tools\install.ps1 -PluginsDir "D:\my-plugins" -Force
#
# 本脚本只做一件事：把插件的 index.mjs / manifest.json / README.md
# 复制到念风的外部插件目录（默认 <数据目录>/plugins/group-chat-tools）。
param(
  [string]$DataDir = '',
  [string]$PluginsDir = '',
  [switch]$Force
)

$ErrorActionPreference = 'Stop'

$sourceDir = $PSScriptRoot
$repoRoot = Split-Path (Split-Path $sourceDir -Parent) -Parent

function Resolve-DefaultDataDir {
  param([string]$Root)
  $localDir = Join-Path $Root 'user_data'
  $localInstance = Join-Path $localDir 'instance.json'
  if (Test-Path $localInstance) {
    try {
      $parsed = Get-Content $localInstance -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($parsed.dataDir) { return [string]$parsed.dataDir }
    } catch { }
  }
  $appPointer = Join-Path $env:APPDATA 'nianfeng\instance.json'
  if (Test-Path $appPointer) {
    try {
      $parsed = Get-Content $appPointer -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($parsed.dataDir) { return [string]$parsed.dataDir }
    } catch { }
  }
  return $localDir
}

if ($PluginsDir) {
  $targetDir = Join-Path $PluginsDir 'group-chat-tools'
  $label = "插件目录 -PluginsDir"
} else {
  $resolvedDataDir = if ($DataDir) { $DataDir } else { Resolve-DefaultDataDir -Root $repoRoot }
  $targetDir = Join-Path (Join-Path $resolvedDataDir 'plugins') 'group-chat-tools'
  $label = "数据目录 plugins"
}

Write-Host "念风 · 群聊工具 安装"
Write-Host "  来源：$sourceDir"
Write-Host "  目标：$targetDir  （$label）"

New-Item -ItemType Directory -Force -Path $targetDir | Out-Null

$files = @('index.mjs', 'manifest.json', 'README.md')
foreach ($name in $files) {
  $from = Join-Path $sourceDir $name
  if (-not (Test-Path $from)) { throw "缺少文件：$from" }
  $to = Join-Path $targetDir $name
  if ((Test-Path $to) -and -not $Force) {
    throw "目标已存在：$to`n如果确认要覆盖，请加 -Force 参数重新执行。"
  }
  Copy-Item -Path $from -Destination $to -Force
  Write-Host "  ✔ 已写入 $name"
}

Write-Host ""
Write-Host "安装完成。接下来："
Write-Host "  1. 回到念风 → 设置 → 插件 → 重新扫描 / 刷新页面；"
Write-Host "  2. 确认「群聊工具」已启用（默认启用，依赖内置 NapCat 渠道插件）；"
Write-Host "  3. 在任意 NapCat 群聊渠道里对 AI 说「查一下群里叫小明的人」验证。"
Write-Host ""
Write-Host "提示：如果念风的数据目录不是在 $repoRoot\user_data，请用 -DataDir 指定，"
Write-Host "      或在 设置 → 插件 里查看当前外部插件目录后用 -PluginsDir 指定。"
