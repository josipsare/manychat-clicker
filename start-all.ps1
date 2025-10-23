# ManyChat Clicker - Start Everything

Write-Host ""
Write-Host "==============================================" -ForegroundColor Cyan
Write-Host "    ManyChat Clicker with Public URL" -ForegroundColor Cyan
Write-Host "==============================================" -ForegroundColor Cyan
Write-Host ""

# Clean up
taskkill /IM node.exe /F 2>$null | Out-Null
taskkill /IM cloudflared.exe /F 2>$null | Out-Null
Start-Sleep -Seconds 1

# Set HEADLESS=false
$env:HEADLESS="false"
$envContent = Get-Content ".env"
$newContent = $envContent -replace "HEADLESS=true", "HEADLESS=false"
Set-Content ".env" -Value $newContent

Write-Host "[1/2] Starting ManyChat server..." -ForegroundColor Yellow
Write-Host "      Browser will open - keep it open!" -ForegroundColor Gray
Start-Process powershell -ArgumentList "-NoExit", "-WindowStyle", "Minimized", "-Command", "cd '$PWD'; Write-Host 'ManyChat Server Running' -ForegroundColor Green; node server.js"

Start-Sleep -Seconds 6

Write-Host "[2/2] Starting Public Tunnel..." -ForegroundColor Yellow
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$PWD'; Write-Host ''; Write-Host '===== YOUR PUBLIC URL =====' -ForegroundColor Green; Write-Host ''; .\cloudflared.exe tunnel --url http://localhost:3000"

Start-Sleep -Seconds 6

Write-Host ""
Write-Host "==============================================" -ForegroundColor Green
Write-Host "          SETUP COMPLETE!" -ForegroundColor Green
Write-Host "==============================================" -ForegroundColor Green
Write-Host ""
Write-Host "What's running:" -ForegroundColor Cyan
Write-Host "  [OK] ManyChat server (minimized window)" -ForegroundColor White
Write-Host "  [OK] Cloudflare tunnel (check for your URL)" -ForegroundColor White
Write-Host "  [OK] Browser context (visible, can minimize)" -ForegroundColor White
Write-Host ""
Write-Host "Your public URL is in the tunnel window!" -ForegroundColor Yellow
Write-Host ""
Write-Host "On FIRST API call:" -ForegroundColor Cyan
Write-Host "  - Browser will navigate to ManyChat" -ForegroundColor White
Write-Host "  - Complete the login and any captcha" -ForegroundColor White
Write-Host "  - After that, API works automatically!" -ForegroundColor White
Write-Host ""
Write-Host "==============================================" -ForegroundColor Green
Write-Host ""
Write-Host "Keep windows open for API to work!" -ForegroundColor Yellow
Write-Host ""



