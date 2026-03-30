$ErrorActionPreference = "Stop"

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
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
            $commandLine = ""
            try {
                $wmiProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $existingPid" -ErrorAction Stop
                $commandLine = [string]($wmiProcess.CommandLine)
            } catch {
                $commandLine = ""
            }

            $isExpectedProcess =
                $existingProcess.ProcessName -in @("node", "npm", "cmd", "powershell", "pwsh") -or
                $commandLine -match "dev-runner\.ts" -or
                $commandLine -match "npm(\.cmd)?\s+run\s+dev:all"

            if ($isExpectedProcess) {
                Write-Host "dev:all already running (PID $existingPid)"
                exit 0
            }
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
