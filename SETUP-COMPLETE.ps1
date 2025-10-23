# Complete ManyChat Clicker Setup

Write-Host "=== ManyChat Clicker Setup ===" -ForegroundColor Cyan
Write-Host ""
Write-Host "This will:" -ForegroundColor White
Write-Host "  1. Help you login to ManyChat" -ForegroundColor White
Write-Host "  2. Test your login works" -ForegroundColor White
Write-Host "  3. Start server with public HTTPS URL" -ForegroundColor White
Write-Host ""

$continue = Read-Host "Ready to start? (Press ENTER)"

# Step 1: Login
Write-Host "`n[Step 1/3] ManyChat Login" -ForegroundColor Cyan
Write-Host "Opening browser..." -ForegroundColor Yellow

$loginProcess = Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$PWD'; node manual-login.js" -PassThru

Write-Host "Complete the login in the browser window" -ForegroundColor White
$continue = Read-Host "`nPress ENTER after you've logged in and see the dashboard"

Write-Host "Saving session..." -ForegroundColor Yellow
Stop-Process -Id $loginProcess.Id -Force 2>$null
Start-Sleep -Seconds 2
Write-Host "[OK] Session saved" -ForegroundColor Green

# Step 2: Test
Write-Host "`n[Step 2/3] Testing Login" -ForegroundColor Cyan

$envContent = Get-Content ".env"
$newContent = $envContent -replace "HEADLESS=false", "HEADLESS=true"
Set-Content ".env" -Value $newContent

$testServer = Start-Process powershell -ArgumentList "-WindowStyle Hidden", "-Command", "cd '$PWD'; node server.js" -PassThru
Start-Sleep -Seconds 5

try {
    $response = Invoke-WebRequest -Uri "http://localhost:3000/debug-verify-login" -Method POST -ContentType "application/json" -Body "{}" -TimeoutSec 60
    $data = $response.Content | ConvertFrom-Json
    
    if ($data.isLoggedIn) {
        Write-Host "[OK] Login verified!" -ForegroundColor Green
        $loginWorks = $true
    } else {
        Write-Host "[FAIL] Login failed" -ForegroundColor Red
        $loginWorks = $false
    }
} catch {
    Write-Host "[FAIL] Test error" -ForegroundColor Red
    $loginWorks = $false
}

Stop-Process -Id $testServer.Id -Force 2>$null
Start-Sleep -Seconds 2

if (-not $loginWorks) {
    Write-Host "`nSetup failed. Please try again." -ForegroundColor Red
    exit 1
}

# Step 3: Start tunnel
Write-Host "`n[Step 3/3] Starting Public Server" -ForegroundColor Cyan
& .\start-tunnel.ps1

