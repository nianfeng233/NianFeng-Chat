# 关闭占用风语端口（默认 5173 / 8788）的进程。
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