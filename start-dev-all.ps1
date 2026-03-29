$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$logDir = Join-Path $root ".codex"
$pidFile = Join-Path $logDir "dev-all.pid"
$stdoutLog = Join-Path $logDir "dev-all.stdout.log"
$stderrLog = Join-Path $logDir "dev-all.stderr.log"

New-Item -ItemType Directory -Force -Path $logDir | Out-Null

if (Test-Path $pidFile) {
    $existingPid = (Get-Content $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1).Trim()
    if ($existingPid) {
        $existingProcess = Get-Process -Id ([int]$existingPid) -ErrorAction SilentlyContinue
        if ($existingProcess) {
            Write-Host "dev:all already running (PID $existingPid)"
            exit 0
        }
    }
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
}

$process = Start-Process -FilePath "npm.cmd" `
    -ArgumentList "run", "dev:all" `
    -WorkingDirectory $root `
    -RedirectStandardOutput $stdoutLog `
    -RedirectStandardError $stderrLog `
    -WindowStyle Hidden `
    -PassThru

Set-Content -Path $pidFile -Value $process.Id -Encoding ascii
Write-Host "dev:all started in background (PID $($process.Id))"
