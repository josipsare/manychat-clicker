# Script to clear session and login with different account

Write-Host "=== Clear Session & Login with Different Account ===" -ForegroundColor Cyan
Write-Host ""

# Step 1: Stop processes
Write-Host "[1/4] Stopping all processes..." -ForegroundColor Yellow
taskkill /IM node.exe /F 2>$null | Out-Null
taskkill /IM cloudflared.exe /F 2>$null | Out-Null
Start-Sleep -Seconds 2
Write-Host "      Processes stopped" -ForegroundColor Green

# Step 2: Delete user-data
Write-Host "[2/4] Clearing old session data..." -ForegroundColor Yellow
if (Test-Path "data\user-data") {
    Remove-Item "data\user-data" -Recurse -Force
    Write-Host "      Old session cleared" -ForegroundColor Green
} else {
    Write-Host "      No existing session found" -ForegroundColor Gray
}

# Step 3: Run manual login
Write-Host "[3/4] Starting manual login..." -ForegroundColor Yellow
Write-Host ""
Write-Host "A browser will open. Please:" -ForegroundColor Cyan
Write-Host "  1. Login with your NEW account" -ForegroundColor White
Write-Host "  2. Wait until you see the dashboard" -ForegroundColor White
Write-Host "  3. Press ENTER in the terminal when done" -ForegroundColor White
Write-Host ""

node manual-login.js

# Step 4: Done
Write-Host ""
Write-Host "[4/4] Session saved!" -ForegroundColor Green
Write-Host ""
Write-Host "=== Setup Complete ===" -ForegroundColor Green
Write-Host "You can now run: .\start-all.ps1" -ForegroundColor Cyan



