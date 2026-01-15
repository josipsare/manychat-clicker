# Start server with visible browser (for Vultr/VPS with desktop)
Write-Host "=== ManyChat Clicker (Visible Mode) ===" -ForegroundColor Cyan

# Kill existing processes
Write-Host "Stopping old processes..." -ForegroundColor Yellow
taskkill /IM node.exe /F 2>$null | Out-Null
taskkill /IM cloudflared.exe /F 2>$null | Out-Null
Start-Sleep -Seconds 2

# Set environment - HEADLESS=false keeps browser visible
$env:HEADLESS = "false"
$env:AUTH_TOKEN = "manychat2024"

Write-Host ""
Write-Host "Starting server with VISIBLE browser..." -ForegroundColor Green
Write-Host "AUTH_TOKEN = manychat2024" -ForegroundColor Cyan
Write-Host ""
Write-Host "The browser will open when you make your first API request." -ForegroundColor Yellow
Write-Host "If not logged in, you can login manually in the browser window." -ForegroundColor Yellow
Write-Host ""

# Run server directly (not hidden) so you can see all logs
node server.js

