# 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
# 项目全称：念风 Chat（NianFeng-Chat）
# 仓库：https://github.com/nianfeng233/NianFeng-Chat
# 关闭占用念风端口（默认 5173 / 8788）的进程。
# 用法：
#   powershell -ExecutionPolicy Bypass -File stop.ps1
#   powershell -ExecutionPolicy Bypass -File stop.ps1 -Ports 5173,8788,18099
param([int[]]$Ports = @(5173, 8788))

$killedAny = $false
$joined = $Ports -join ", "
foreach ($port in $Ports) {
  $pids = @()
  try {
    $pids = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop | Select-Object -ExpandProperty OwningProcess -Unique)
  } catch {
    $pids = @(netstat -ano | Select-String ":$port\s" | ForEach-Object { if ($_ -match "LISTENING\s+(\d+)\s*$") { [int]$Matches[1] } } | Select-Object -Unique)
  }
  foreach ($procId in $pids) {
    if (-not $procId) { continue }
    $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
    if (-not $proc) { continue }
    Write-Host "Closing port $port -> PID $procId ($($proc.ProcessName))"
    Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
    $killedAny = $true
  }
}

if ($killedAny) {
  Write-Host "Done. You can run start.cmd again."
} else {
  Write-Host "No listener found on ports: $joined"
}