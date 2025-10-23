# Simple ManyChat Clicker Launcher

Write-Host "=== ManyChat Clicker ===" -ForegroundColor Cyan
Write-Host ""

# Ensure HEADLESS=true
$env:HEADLESS="true"

# Kill any existing processes
Write-Host "Cleaning up old processes..." -ForegroundColor Gray
taskkill /IM node.exe /F 2>$null | Out-Null
taskkill /IM cloudflared.exe /F 2>$null | Out-Null
Start-Sleep -Seconds 2

# Start server in background
Write-Host "Starting ManyChat server..." -ForegroundColor Yellow
Start-Process -FilePath "node" -ArgumentList "server.js" -WindowStyle Hidden -PassThru | Out-Null
Start-Sleep -Seconds 3
Write-Host "[OK] Server started on port 3000" -ForegroundColor Green

# Start tunnel
Write-Host "Starting Cloudflare tunnel..." -ForegroundColor Yellow
Write-Host "(This creates your public HTTPS URL)" -ForegroundColor Gray
Write-Host ""

# Run cloudflared in foreground so we can see the URL
& .\cloudflared.exe tunnel --url http://localhost:3000



