# Starts Laya (laya-serve) for EzAutoApply at http://127.0.0.1:8000.
#
# First run: creates classifier\.venv with Python 3.12, installs CPU-only
# PyTorch and Laya, then downloads the model (~0.8 GB) on first use.
#
#   .\start.ps1                       # default port 8000, no API key
#   .\start.ps1 -ApiKey "some-secret" # require Authorization: Bearer some-secret
#   .\start.ps1 -Port 8001 -Threads 4
param(
    [int]$Port = 8000,
    [string]$ApiKey = $env:LAYA_API_KEY,
    [int]$Threads = 0,
    [string]$Model = 'typed-decisions'
)
$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$venv = Join-Path $here '.venv'
$python = Join-Path $venv 'Scripts\python.exe'

if (-not (Test-Path $python)) {
    Write-Host 'Creating the Python virtual environment (first run only)...'
    if (Get-Command py -ErrorAction SilentlyContinue) {
        py -3.12 -m venv $venv
    } else {
        python -m venv $venv
    }
    if (-not (Test-Path $python)) { throw 'Could not create a virtual environment. Install Python 3.10-3.12 and try again.' }

    & $python -m pip install --upgrade pip
    # The CPU build of PyTorch avoids downloading gigabytes of CUDA libraries.
    & $python -m pip install torch --index-url https://download.pytorch.org/whl/cpu
    & $python -m pip install -r (Join-Path $here 'requirements.txt')
    if ($LASTEXITCODE -ne 0) { throw 'Installing Laya failed. See the pip output above.' }
}

# Check the port before loading the model, so a clash gets a clear message instead of a socket error.
$listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listener) {
    $running = $false
    try {
        $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 3
        $running = $health.status -eq 'ok'
    } catch {}
    if ($running) {
        Write-Host "Laya is already running on http://127.0.0.1:$Port. Nothing to do."
        exit 0
    }
    $owner = Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue
    Write-Host "Port $Port is already in use by $($owner.ProcessName) (PID $($listener.OwningProcess))."
    Write-Host "Close that program, or start Laya on another port: .\start.ps1 -Port 8001 (then set http://127.0.0.1:8001 in EzAutoApply's Settings)."
    exit 1
}

# Bind to localhost only: laya-serve's default (0.0.0.0) would expose it to your network.
$env:LAYA_HOST = '127.0.0.1'
$env:LAYA_PORT = "$Port"
$env:LAYA_DEVICE = 'cpu'
# Load the checkpoint EzAutoApply asks for at startup, so the first autofill isn't slow.
$env:LAYA_PRELOAD = '1'
$env:LAYA_MODELS = $Model
if ($ApiKey) { $env:LAYA_API_KEY = $ApiKey }
if ($Threads -gt 0) { $env:LAYA_THREADS = "$Threads" }

Write-Host "Starting Laya on http://127.0.0.1:$Port (checkpoint: $Model). Press Ctrl+C to stop."
# Run through python rather than Scripts\laya-serve.exe, whose launcher hard-codes the
# venv's path and breaks if the project folder is moved.
& $python -m laya.serve
