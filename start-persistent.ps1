# Start ManyChat Clicker with persistent browser

Write-Host "=== ManyChat Clicker - Persistent Mode ===" -ForegroundColor Cyan
Write-Host ""
Write-Host "This keeps the browser context alive between requests." -ForegroundColor White
Write-Host "Login session will stay valid as long as this runs." -ForegroundColor White
Write-Host ""

# Kill any existing processes
taskkill /IM node.exe /F 2>$null | Out-Null
taskkill /IM cloudflared.exe /F 2>$null | Out-Null
Start-Sleep -Seconds 2

# Set environment
$env:HEADLESS="false"

# Update .env
$envContent = Get-Content ".env"
$newContent = $envContent -replace "HEADLESS=true", "HEADLESS=false"
Set-Content ".env" -Value $newContent

Write-Host "Starting server with persistent browser..." -ForegroundColor Yellow
Write-Host "(Browser will open - this is normal)" -ForegroundColor Gray
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$PWD'; `$env:HEADLESS='false'; node server.js" -WindowStyle Minimized

Write-Host "Waiting for server to start..." -ForegroundColor Gray
Start-Sleep -Seconds 8

# Test server
try {
    Invoke-WebRequest -Uri "http://localhost:3000/" -Method GET -TimeoutSec 5 | Out-Null
    Write-Host "[OK] Server is running" -ForegroundColor Green
} catch {
    Write-Host "[ERROR] Server failed to start" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "Starting Cloudflare Tunnel..." -ForegroundColor Yellow
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$PWD'; Write-Host 'Cloudflare Tunnel' -ForegroundColor Cyan; Write-Host 'Keep this window open!' -ForegroundColor Yellow; Write-Host ''; .\cloudflared.exe tunnel --url http://localhost:3000"

Start-Sleep -Seconds 8

Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host "  ManyChat Clicker is Running!" -ForegroundColor Green  
Write-Host "========================================" -ForegroundColor Green
Write-Host ""
Write-Host "Check the Cloudflare Tunnel window for your public URL" -ForegroundColor Cyan
Write-Host ""
Write-Host "IMPORTANT:" -ForegroundColor Yellow
Write-Host "  - Keep all windows open" -ForegroundColor White
Write-Host "  - The browser window must stay open (can minimize)" -ForegroundColor White
Write-Host "  - First API call will trigger login - complete it in the browser" -ForegroundColor White
Write-Host ""
Write-Host "Press any key to stop all services..." -ForegroundColor Gray
$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")

Write-Host ""
Write-Host "Stopping services..." -ForegroundColor Yellow
taskkill /IM node.exe /F 2>$null | Out-Null
taskkill /IM cloudflared.exe /F 2>$null | Out-Null
Write-Host "Stopped" -ForegroundColor Green



