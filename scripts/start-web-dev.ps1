$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  throw "Docker Desktop / docker CLI is required for the real-data browser preview."
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Node.js 24+ is required."
}

if (-not (Test-Path "node_modules")) {
  npm install
}

cmd.exe /c "docker compose -f compose.mobile-dev.yml down -v --remove-orphans >nul 2>&1"
if ($LASTEXITCODE -ne 0) {
  throw "Could not reset the disposable COMPANION_SOCIAL development database."
}

cmd.exe /c "docker compose -f compose.mobile-dev.yml up -d --wait"
if ($LASTEXITCODE -ne 0) {
  throw "Could not start the disposable COMPANION_SOCIAL development database."
}

$env:DATABASE_URL = "postgresql://postgres:postgres@127.0.0.1:54329/companion_social_mobile_dev"
$env:COMPANION_SOCIAL_DEV_DATABASE = "1"
$env:MOBILE_DEV_HOST = "127.0.0.1"
$env:MOBILE_DEV_PORT = "8787"
$env:MOBILE_DEV_OWNER_TOKEN = "companion-social-stage1-owner"
$env:MOBILE_DEV_OWNER_SUBJECT = "00000000-0000-0000-0000-0000000000a1"
$env:MOBILE_DEV_OWNER_ID = "00000000-0000-0000-0000-0000000001a1"

npm run dev:mobile:db:init

$existingApi = Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($existingApi) {
  $process = Get-CimInstance Win32_Process -Filter "ProcessId = $($existingApi.OwningProcess)" -ErrorAction SilentlyContinue
  $commandLine = if ($process) { [string]$process.CommandLine } else { "" }
  if ($commandLine -match "companion-social" -or $commandLine -match "mobile-http-server") {
    Stop-Process -Id $existingApi.OwningProcess -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 500
  } else {
    throw "Port 8787 is already in use by another application. Close it before starting COMPANION_SOCIAL."
  }
}

$apiCommand = "Set-Location '$Root'; npm run dev:mobile:api"
Start-Process powershell.exe -ArgumentList "-NoExit", "-Command", $apiCommand

$apiReady = $false
for ($attempt = 1; $attempt -le 30; $attempt++) {
  try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:8787/healthz" -TimeoutSec 2
    if ($health.ok -eq $true) {
      $apiReady = $true
      break
    }
  } catch {
    Start-Sleep -Seconds 1
  }
}
if (-not $apiReady) {
  throw "Stage 1 dev API did not become healthy on port 8787."
}

$env:EXPO_PUBLIC_API_BASE_URL = "http://127.0.0.1:8787"
$env:EXPO_PUBLIC_OWNER_BEARER_TOKEN = "companion-social-stage1-owner"
$env:EXPO_PUBLIC_SAMPLE_COMPANION_COMPANION_ID = "00000000-0000-0000-0000-0000000002a1"
$env:EXPO_PUBLIC_DATA_MODE = "dev"

Set-Location (Join-Path $Root "apps/mobile")
if (-not (Test-Path "node_modules")) {
  npm install
}

Write-Host ""
Write-Host "Opening COMPANION_SOCIAL Stage 1 in the browser with real local API data..."
Write-Host "You do not need the phone and PC to be on the same Wi-Fi for this mode."
Write-Host ""

npm run web
