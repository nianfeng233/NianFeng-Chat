<#
    风语 · AI Chat — PowerShell 启动脚本

    用法：
      .\start.ps1                     启动 后端 + WebUI（自动打开浏览器）
      .\start.ps1 -Serve              单端口模式（后端直接托管 WebUI）
      .\start.ps1 -NoOpen             不自动打开浏览器
      .\start.ps1 -Proxy http://127.0.0.1:7890   首次安装依赖时走代理
      .\start.ps1 -WebPort 8080       自定义 WebUI 端口
      .\start.ps1 -BackendPort 9000   自定义后端端口

    在资源管理器里右键“使用 PowerShell 运行”时，出错窗口会停留。
#>
[CmdletBinding()]
param(
    [switch]$Serve,
    [switch]$NoOpen,
    [string]$Proxy,
    [int]$WebPort = 0,
    [int]$BackendPort = 0,
    [switch]$NoPause
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

function Fail([string]$Message) {
    Write-Host ""
    Write-Host "  [错误] $Message" -ForegroundColor Red
    Write-Host ""
    if (-not $NoPause) {
        try { Read-Host "按回车退出" | Out-Null } catch {}
    }
    exit 1
}

Write-Host ""
Write-Host "  ============================================"
Write-Host "   风语 · AI Chat  (后端 + WebUI)"
Write-Host "  ============================================"
Write-Host ""

# ---- Node.js 检查 ----
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Fail "没有找到 Node.js。请先安装 Node.js 20+：https://nodejs.org/"
}
$nodeVersion = (& node -p "process.versions.node").Trim()
$nodeMajor = [int]($nodeVersion.Split('.')[0])
if ($nodeMajor -lt 20) {
    Fail "Node.js 版本过低（当前 $nodeVersion），需要 20 或更高。"
}
Write-Host "  Node.js  $nodeVersion"

# ---- 代理 ----
if ($Proxy) {
    $env:HTTP_PROXY = $Proxy
    $env:HTTPS_PROXY = $Proxy
    $env:NO_PROXY = 'localhost,127.0.0.1'
    Write-Host "  代理     $Proxy"
}

# ---- 端口 ----
if ($WebPort -gt 0) { $env:WEB_PORT = $WebPort }
if ($BackendPort -gt 0) { $env:BACKEND_PORT = $BackendPort }

# ---- 依赖 ----
if (-not (Test-Path (Join-Path $Root 'node_modules/cordis/lib/index.js'))) {
    Write-Host ""
    Write-Host "  [提示] 首次运行，正在安装依赖（cordis）..."
    Write-Host "         网络需要代理时，请使用：.\start.ps1 -Proxy http://127.0.0.1:7890"
    Write-Host ""
    & npm install --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) {
        Fail "依赖安装失败。可先运行 install.cmd 配置代理，或使用 -Proxy 参数。"
    }
}

# ---- 启动 ----
$startArgs = @()
if ($Serve) { $startArgs += '--serve' }
if ($NoOpen) { $startArgs += '--no-open' }

Write-Host ""
Write-Host "  正在启动，浏览器会自动打开；按 Ctrl+C 退出风语。"
Write-Host ""

& node start.mjs @startArgs
if ($LASTEXITCODE -ne 0) {
    Fail "风语已退出（退出码 $LASTEXITCODE）。请查看上面的日志。"
}
