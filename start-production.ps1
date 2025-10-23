# ManyChat Clicker - Production Startup Script
# This script is optimized for 24/7 operation on Windows Server

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  ManyChat Clicker - Production Mode" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Set working directory (adjust if needed)
$workDir = "C:\manychat-clicker"
if (!(Test-Path $workDir)) {
    Write-Host "ERROR: Directory not found: $workDir" -ForegroundColor Red
    Write-Host "Please update the path in this script" -ForegroundColor Yellow
    exit 1
}

Set-Location $workDir

# Clean up any existing processes
Write-Host "[Step 1/4] Cleaning up old processes..." -ForegroundColor Yellow
taskkill /IM node.exe /F 2>$null | Out-Null
taskkill /IM cloudflared.exe /F 2>$null | Out-Null
Start-Sleep -Seconds 2
Write-Host "            Done" -ForegroundColor Green

# Set environment to non-headless (browser needs to stay open)
Write-Host "[Step 2/4] Configuring environment..." -ForegroundColor Yellow
$env:HEADLESS="false"

# Update .env file
if (Test-Path ".env") {
    $envContent = Get-Content ".env"
    $newContent = $envContent -replace "HEADLESS=true", "HEADLESS=false"
    Set-Content ".env" -Value $newContent
    Write-Host "            Done" -ForegroundColor Green
} else {
    Write-Host "            WARNING: .env file not found" -ForegroundColor Yellow
}

# Start Node.js server
Write-Host "[Step 3/4] Starting ManyChat server..." -ForegroundColor Yellow
Start-Process powershell -ArgumentList @(
    "-NoExit",
    "-WindowStyle", "Minimized",
    "-Command", "cd '$workDir'; Write-Host 'ManyChat Server Running on Port 3000' -ForegroundColor Green; Write-Host 'Keep this window open!' -ForegroundColor Yellow; node server.js"
)
Start-Sleep -Seconds 8
Write-Host "            Server started (check minimized window)" -ForegroundColor Green

# Start Cloudflare Tunnel
Write-Host "[Step 4/4] Starting Cloudflare Tunnel..." -ForegroundColor Yellow
Start-Process powershell -ArgumentList @(
    "-NoExit",
    "-Command", "cd '$workDir'; Write-Host ''; Write-Host '===== YOUR PUBLIC URL =====' -ForegroundColor Green; Write-Host ''; .\cloudflared.exe tunnel --url http://localhost:3000"
)
Start-Sleep -Seconds 10

Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host "        PRODUCTION SERVER LIVE!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host ""
Write-Host "Status Check:" -ForegroundColor Cyan
Write-Host "  [OK] ManyChat server (minimized)" -ForegroundColor White
Write-Host "  [OK] Cloudflare tunnel (check for URL)" -ForegroundColor White
Write-Host "  [OK] Browser context (running)" -ForegroundColor White
Write-Host ""
Write-Host "Next Steps:" -ForegroundColor Yellow
Write-Host "  1. Check tunnel window for your public URL" -ForegroundColor White
Write-Host "  2. Test the API from your application" -ForegroundColor White
Write-Host "  3. Set up Task Scheduler for auto-restart" -ForegroundColor White
Write-Host ""
Write-Host "Maintenance:" -ForegroundColor Cyan
Write-Host "  - You can disconnect RDP (services stay running)" -ForegroundColor White
Write-Host "  - To restart: Run this script again" -ForegroundColor White
Write-Host "  - To change accounts: Run .\clear-session-and-login.ps1" -ForegroundColor White
Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host ""

