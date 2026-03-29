$ErrorActionPreference = "SilentlyContinue"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$pidFile = Join-Path $root ".codex\dev-all.pid"
$stopped = $false

if (Test-Path $pidFile) {
    $pidText = (Get-Content $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1).Trim()
    if ($pidText) {
        taskkill /PID $pidText /T /F | Out-Null
        Write-Host "dev:all stopped (PID $pidText)"
        $stopped = $true
    }
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
}

if (-not $stopped) {
    Write-Host "dev:all is not running"
}
