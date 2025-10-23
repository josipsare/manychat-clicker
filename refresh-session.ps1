# Script to refresh expired ManyChat session

Write-Host "=== ManyChat Session Refresh ===" -ForegroundColor Cyan
Write-Host ""
Write-Host "Your session has expired. Follow these steps:" -ForegroundColor Yellow
Write-Host ""

# Step 1: Check if local server is running
Write-Host "STEP 1: Stop any running local servers" -ForegroundColor Cyan
Write-Host "Press Ctrl+C in any terminal running 'node server.js'" -ForegroundColor White
Write-Host ""
$continue = Read-Host "Press ENTER when ready to continue"

# Step 2: Update .env to HEADLESS=false
Write-Host "`nSTEP 2: Checking .env file..." -ForegroundColor Cyan
$envContent = Get-Content ".env"
$headlessLine = $envContent | Where-Object { $_ -like "HEADLESS=*" }

if ($headlessLine -like "*true*") {
    Write-Host "Current setting: HEADLESS=true" -ForegroundColor Yellow
    Write-Host "Updating to: HEADLESS=false" -ForegroundColor Green
    
    $newContent = $envContent -replace "HEADLESS=true", "HEADLESS=false"
    Set-Content ".env" -Value $newContent
    
    Write-Host "[SUCCESS] .env updated" -ForegroundColor Green
} else {
    Write-Host "HEADLESS is already set to false" -ForegroundColor Green
}

# Step 3: Start server
Write-Host "`nSTEP 3: Starting local server..." -ForegroundColor Cyan
Write-Host "A browser window will open. Please:" -ForegroundColor Yellow
Write-Host "  1. Complete the ManyChat login" -ForegroundColor White
Write-Host "  2. Wait until you see the dashboard" -ForegroundColor White
Write-Host "  3. Come back here and press Ctrl+C to stop the server" -ForegroundColor White
Write-Host ""
$continue = Read-Host "Press ENTER to start server"

Start-Process powershell -ArgumentList "-NoExit", "-Command", "node server.js"
Write-Host ""
Write-Host "Server started in new window!" -ForegroundColor Green
Write-Host "Complete login, then continue here..." -ForegroundColor Yellow
Write-Host ""
$continue = Read-Host "Press ENTER when you've completed login and stopped the server"

# Step 4: Restore HEADLESS=true
Write-Host "`nSTEP 4: Restoring .env..." -ForegroundColor Cyan
$envContent = Get-Content ".env"
$newContent = $envContent -replace "HEADLESS=false", "HEADLESS=true"
Set-Content ".env" -Value $newContent
Write-Host "[SUCCESS] HEADLESS=true restored" -ForegroundColor Green

# Step 5: Create new backup
Write-Host "`nSTEP 5: Creating new session backup..." -ForegroundColor Cyan
if (Test-Path "user-data-backup.zip") {
    Write-Host "Removing old backup..." -ForegroundColor Yellow
    Remove-Item "user-data-backup.zip" -Force
}

Write-Host "Compressing user-data..." -ForegroundColor Yellow
Compress-Archive -Path "data\user-data" -DestinationPath "user-data-backup.zip" -CompressionLevel Optimal
$sizeInMB = [math]::Round((Get-Item "user-data-backup.zip").Length / 1MB, 2)
Write-Host "[SUCCESS] Backup created: $sizeInMB MB" -ForegroundColor Green

# Step 6: Upload to Railway
Write-Host "`nSTEP 6: Upload to Railway?" -ForegroundColor Cyan
$upload = Read-Host "Upload now? (Y/N)"

if ($upload -eq "Y" -or $upload -eq "y") {
    Write-Host "Uploading to Railway..." -ForegroundColor Yellow
    & .\upload-direct.ps1
} else {
    Write-Host ""
    Write-Host "Backup created successfully!" -ForegroundColor Green
    Write-Host "Run .\upload-direct.ps1 when ready to upload" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "=== Session Refresh Complete ===" -ForegroundColor Green




