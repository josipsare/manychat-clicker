# Cloudflare Tunnel Setup Script
# This sets up a permanent tunnel for: manychat-followupsv2.setty.ai
# Run this ONCE on your Vultr server after installing cloudflared.exe

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Cloudflare Tunnel Setup" -ForegroundColor Cyan
Write-Host "  Domain: manychat-followupsv2.setty.ai" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

$workDir = "C:\manychat-clicker"
Set-Location $workDir

# Step 1: Check if cloudflared exists
if (!(Test-Path ".\cloudflared.exe")) {
    Write-Host "[ERROR] cloudflared.exe not found!" -ForegroundColor Red
    Write-Host "Downloading cloudflared..." -ForegroundColor Yellow
    Invoke-WebRequest -Uri "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe" -OutFile "cloudflared.exe"
    Write-Host "Downloaded!" -ForegroundColor Green
}

# Step 2: Login to Cloudflare
Write-Host ""
Write-Host "[Step 1/4] Logging into Cloudflare..." -ForegroundColor Yellow
Write-Host "A browser will open - select your domain (setty.ai) and authorize." -ForegroundColor White
Write-Host ""
Read-Host "Press ENTER to open browser for Cloudflare login"

.\cloudflared.exe tunnel login

Write-Host ""
Write-Host "[OK] Cloudflare login complete!" -ForegroundColor Green

# Step 3: Create the tunnel
Write-Host ""
Write-Host "[Step 2/4] Creating tunnel 'manychat-clicker'..." -ForegroundColor Yellow

# Check if tunnel already exists
$existingTunnels = .\cloudflared.exe tunnel list 2>&1
if ($existingTunnels -match "manychat-clicker") {
    Write-Host "Tunnel 'manychat-clicker' already exists!" -ForegroundColor Yellow
    $tunnelInfo = .\cloudflared.exe tunnel info manychat-clicker 2>&1
    Write-Host $tunnelInfo -ForegroundColor White
} else {
    .\cloudflared.exe tunnel create manychat-clicker
    Write-Host "[OK] Tunnel created!" -ForegroundColor Green
}

# Get tunnel ID
$tunnelList = .\cloudflared.exe tunnel list 2>&1
$tunnelLine = $tunnelList | Select-String "manychat-clicker"
if ($tunnelLine) {
    $tunnelId = ($tunnelLine -split "\s+")[0]
    Write-Host "Tunnel ID: $tunnelId" -ForegroundColor Cyan
} else {
    Write-Host "[ERROR] Could not find tunnel ID" -ForegroundColor Red
    exit 1
}

# Step 4: Create DNS record
Write-Host ""
Write-Host "[Step 3/4] Creating DNS record for manychat-followupsv2.setty.ai..." -ForegroundColor Yellow
.\cloudflared.exe tunnel route dns manychat-clicker manychat-followupsv2.setty.ai 2>&1
Write-Host "[OK] DNS record created!" -ForegroundColor Green

# Step 5: Create config file
Write-Host ""
Write-Host "[Step 4/4] Creating tunnel config file..." -ForegroundColor Yellow

$configDir = "$env:USERPROFILE\.cloudflared"
if (!(Test-Path $configDir)) {
    New-Item -ItemType Directory -Path $configDir -Force | Out-Null
}

$credentialsFile = Get-ChildItem "$configDir\*.json" | Select-Object -First 1

if (!$credentialsFile) {
    Write-Host "[ERROR] Credentials file not found in $configDir" -ForegroundColor Red
    Write-Host "Please check that tunnel login was successful" -ForegroundColor Yellow
    exit 1
}

$configContent = @"
tunnel: manychat-clicker
credentials-file: $($credentialsFile.FullName)

ingress:
  - hostname: manychat-followupsv2.setty.ai
    service: http://localhost:3000
  - service: http_status:404
"@

$configPath = "$configDir\config.yml"
Set-Content -Path $configPath -Value $configContent
Write-Host "[OK] Config file created at: $configPath" -ForegroundColor Green

# Done!
Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host "  TUNNEL SETUP COMPLETE!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host ""
Write-Host "Your permanent URL:" -ForegroundColor White
Write-Host "  https://manychat-followupsv2.setty.ai" -ForegroundColor Cyan
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Yellow
Write-Host "  1. Run .\start-production.ps1 to start the server" -ForegroundColor White
Write-Host "  2. The tunnel will automatically use your domain" -ForegroundColor White
Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host ""
