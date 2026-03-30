$ErrorActionPreference = "SilentlyContinue"

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$pidFile = Join-Path $root ".codex\dev-all.pid"
$stopped = $false

if (Test-Path $pidFile) {
    $pidText = (Get-Content $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1).Trim()
    if ($pidText) {
        $process = Get-Process -Id ([int]$pidText) -ErrorAction SilentlyContinue
        if ($process) {
            $commandLine = ""
            try {
                $wmiProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $pidText" -ErrorAction Stop
                $commandLine = [string]($wmiProcess.CommandLine)
            } catch {
                $commandLine = ""
            }

            $isExpectedProcess =
                $process.ProcessName -in @("node", "npm", "cmd", "powershell", "pwsh") -or
                $commandLine -match "dev-runner\.ts" -or
                $commandLine -match "npm(\.cmd)?\s+run\s+dev:all"

            if ($isExpectedProcess) {
                taskkill /PID $pidText /T /F | Out-Null
                Write-Host "dev:all stopped (PID $pidText)"
                $stopped = $true
            } else {
                Write-Host "Skipped unrelated PID in dev-all.pid ($pidText)"
            }
        }
    }
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
}

if (-not $stopped) {
    Write-Host "dev:all is not running"
}
