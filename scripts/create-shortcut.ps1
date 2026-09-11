<#
    在桌面创建“风语 AI Chat”快捷方式。
    用法（在项目根目录执行）：
        powershell -ExecutionPolicy Bypass -File scripts\create-shortcut.ps1
        pwsh -File scripts\create-shortcut.ps1 -Name "风语"
#>
[CmdletBinding()]
param(
    [string]$Name = '风语 AI Chat'
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Target = Join-Path $Root 'start.cmd'
$Logo = Join-Path $Root 'public\assets\logo.png'

if (-not (Test-Path $Target)) { throw "找不到 start.cmd：$Target" }

$desktop = [Environment]::GetFolderPath('Desktop')
$lnk = Join-Path $desktop "$Name.lnk"

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($lnk)
$shortcut.TargetPath = $Target
$shortcut.WorkingDirectory = $Root
$shortcut.Description = '风语 · AI Chat（本地 AI 聊天客户端）'
$shortcut.WindowStyle = 1
if (Test-Path $Logo) { $shortcut.IconLocation = $Logo }
$shortcut.Save()

Write-Host ""
Write-Host "  已创建桌面快捷方式：$lnk" -ForegroundColor Green
Write-Host "  双击即可启动风语（后端 + WebUI）。"
Write-Host ""
