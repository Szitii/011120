param(
  [string]$LanIp = ""
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  throw "Docker Desktop / docker CLI is required for the one-command Stage 1 phone environment."
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Node.js 24+ is required."
}

if (-not (Test-Path "node_modules")) {
  npm install
}

if ([string]::IsNullOrWhiteSpace($LanIp)) {
  $preferred = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object {
      $_.IPAddress -notmatch "^127\." -and
      $_.IPAddress -notmatch "^169\.254\." -and
      $_.InterfaceAlias -notmatch "vEthernet|WSL|Loopback|Bluetooth"
    } |
    Sort-Object @{
      Expression = {
        if ($_.InterfaceAlias -match "Wi-Fi|WLAN|Wireless|Ethernet") { 0 } else { 1 }
      }
    }, InterfaceMetric |
    Select-Object -First 1

  if ($null -eq $preferred) {
    throw "Could not determine a LAN IPv4 address. Re-run with -LanIp YOUR_PC_LAN_IP."
  }
  $LanIp = $preferred.IPAddress
}

$ApiUrl = "http://$($LanIp):8787"
Write-Host "Using LAN API address: $ApiUrl"
Write-Host "If the iPhone cannot reach it, stop Expo and re-run with -LanIp YOUR_PC_WIFI_OR_ETHERNET_IPV4."

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
$env:MOBILE_DEV_HOST = "0.0.0.0"
$env:MOBILE_DEV_PORT = "8787"
$env:MOBILE_DEV_OWNER_TOKEN = "companion-social-stage1-owner"
$env:MOBILE_DEV_OWNER_SUBJECT = "00000000-0000-0000-0000-0000000000a1"
$env:MOBILE_DEV_OWNER_ID = "00000000-0000-0000-0000-0000000001a1"

try {
  npm run dev:mobile:db:init
} catch {
  Write-Host ""
  Write-Host "Database initialization failed. If this is a previous dev database, reset it with:"
  Write-Host "  docker compose -f compose.mobile-dev.yml down -v"
  Write-Host "Then run this script again."
  throw
}

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
  throw "Stage 1 mobile dev API did not become healthy on port 8787. Check the API PowerShell window."
}

$env:EXPO_PUBLIC_API_BASE_URL = $ApiUrl
$env:EXPO_PUBLIC_OWNER_BEARER_TOKEN = "companion-social-stage1-owner"
$env:EXPO_PUBLIC_SAMPLE_COMPANION_COMPANION_ID = "00000000-0000-0000-0000-0000000002a1"
$env:EXPO_PUBLIC_DATA_MODE = "dev"

Set-Location (Join-Path $Root "apps/mobile")
if (-not (Test-Path "node_modules")) {
  npm install
}

Write-Host ""
Write-Host "Stage 1 phone environment is ready."
Write-Host "1. Keep the API PowerShell window open."
Write-Host "2. Install/open Expo Go on the iPhone."
Write-Host "3. Put iPhone and PC on the same Wi-Fi/LAN."
Write-Host "4. Scan the Expo QR code below."
Write-Host ""

npm start
