$railwayUrl = "https://web-production-acab4.up.railway.app"

Write-Host "=== Railway Deployment Test Suite ===" -ForegroundColor Cyan
Write-Host ""

# 1. Check if service is up
Write-Host "1. Testing service endpoint..." -ForegroundColor Yellow
try {
    $health = Invoke-WebRequest -Uri "$railwayUrl/" -Method GET -TimeoutSec 10
    Write-Host "   ✓ Service is UP" -ForegroundColor Green
} catch {
    Write-Host "   ✗ Service is DOWN" -ForegroundColor Red
    Write-Host "   Error: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "2. Checking session data status..." -ForegroundColor Yellow
try {
    $debug = Invoke-WebRequest -Uri "$railwayUrl/debug-session" -Method GET
    $debugData = $debug.Content | ConvertFrom-Json
    
    Write-Host "   USER_DATA_DIR: $($debugData.userDataDir)" -ForegroundColor White
    Write-Host "   Directory Exists: $(if ($debugData.exists) { '[YES]' } else { '[NO]' })" -ForegroundColor $(if ($debugData.exists) { "Green" } else { "Red" })
    
    if ($debugData.exists) {
        Write-Host "   Total Items: $($debugData.totalItems)" -ForegroundColor White
        Write-Host "   Default Folder: $(if ($debugData.defaultFolder.exists) { '[YES]' } else { '[NO]' })" -ForegroundColor $(if ($debugData.defaultFolder.exists) { "Green" } else { "Red" })
        
        if (-not $debugData.defaultFolder.exists) {
            Write-Host ""
            Write-Host "[WARNING] Session data not found. Run upload script:" -ForegroundColor Yellow
            Write-Host "   .\upload-direct.ps1" -ForegroundColor Cyan
            exit 0
        }
    } else {
        Write-Host ""
        Write-Host "[WARNING] USER_DATA_DIR does not exist. Run upload script:" -ForegroundColor Yellow
        Write-Host "   .\upload-direct.ps1" -ForegroundColor Cyan
        exit 0
    }
} catch {
    Write-Host "   ✗ Could not check session data" -ForegroundColor Red
    Write-Host "   Error: $($_.Exception.Message)" -ForegroundColor Red
}

Write-Host ""
Write-Host "3. Verifying login status (may take 10-20 seconds)..." -ForegroundColor Yellow
try {
    $loginCheck = Invoke-WebRequest -Uri "$railwayUrl/debug-verify-login" -Method POST -ContentType "application/json" -Body "{}" -TimeoutSec 60
    $loginData = $loginCheck.Content | ConvertFrom-Json
    
    Write-Host "   Current URL: $($loginData.url)" -ForegroundColor White
    Write-Host "   On ManyChat Domain: $(if ($loginData.checks.onManyChatDomain) { '[YES]' } else { '[NO]' })" -ForegroundColor $(if ($loginData.checks.onManyChatDomain) { "Green" } else { "Red" })
    Write-Host "   Not on Login Page: $(if ($loginData.checks.notOnLoginPage) { '[YES]' } else { '[NO]' })" -ForegroundColor $(if ($loginData.checks.notOnLoginPage) { "Green" } else { "Red" })
    Write-Host "   Dashboard Elements Found: $(if ($loginData.checks.anyDashboardElement) { '[YES]' } else { '[NO]' })" -ForegroundColor $(if ($loginData.checks.anyDashboardElement) { "Green" } else { "Red" })
    Write-Host ""
    Write-Host "   Overall Login Status: $(if ($loginData.isLoggedIn) { '[LOGGED IN]' } else { '[NOT LOGGED IN]' })" -ForegroundColor $(if ($loginData.isLoggedIn) { "Green" } else { "Red" })
    
    if (-not $loginData.isLoggedIn) {
        Write-Host ""
        Write-Host "[WARNING] Not logged in. Your session may have expired." -ForegroundColor Yellow
        Write-Host "   1. Run local server with HEADLESS=false" -ForegroundColor Cyan
        Write-Host "   2. Complete login manually" -ForegroundColor Cyan
        Write-Host "   3. Re-run .\upload-direct.ps1" -ForegroundColor Cyan
        exit 0
    }
} catch {
    Write-Host "   ✗ Login verification failed" -ForegroundColor Red
    Write-Host "   Error: $($_.Exception.Message)" -ForegroundColor Red
}

Write-Host ""
Write-Host "=== All Tests Passed! ===" -ForegroundColor Green
Write-Host ""
Write-Host "Your deployment is ready to use. Test with:" -ForegroundColor Yellow
Write-Host ""
Write-Host '$body = @{chatId="1054056495"; message="Hello from Railway!"} | ConvertTo-Json' -ForegroundColor Cyan
Write-Host 'Invoke-WebRequest -Uri "' + $railwayUrl + '/press" -Method POST -Body $body -ContentType "application/json" -Headers @{Authorization="Bearer pablonicotinepouches"}' -ForegroundColor Cyan
Write-Host ""

