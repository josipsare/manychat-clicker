﻿# Upload user-data to Railway deployment
param(
    [Parameter(Mandatory=$true)]
    [string]$RailwayUrl
)

Write-Host "ðŸš€ Uploading user-data to Railway deployment..." -ForegroundColor Cyan
Write-Host ""

# Check if zip file exists
if (-not (Test-Path "user-data-backup.zip")) {
    Write-Host "âŒ Error: user-data-backup.zip not found!" -ForegroundColor Red
    Write-Host "Please run this command first:" -ForegroundColor Yellow
    Write-Host "  Compress-Archive -Path './data/user-data' -DestinationPath './user-data-backup.zip' -Force" -ForegroundColor Yellow
    exit 1
}

# Get file size
$fileSize = (Get-Item "user-data-backup.zip").Length
Write-Host "ðŸ“¦ File size: $([math]::Round($fileSize/1MB, 2)) MB" -ForegroundColor Green

# Read file and convert to base64
Write-Host "ðŸ“¤ Converting file to base64..." -ForegroundColor Yellow
$fileBytes = [System.IO.File]::ReadAllBytes("user-data-backup.zip")
$fileBase64 = [System.Convert]::ToBase64String($fileBytes)

Write-Host "ðŸ“¤ Uploading to $RailwayUrl..." -ForegroundColor Yellow

# Create JSON payload
$jsonPayload = @{
    fileData = $fileBase64
    fileName = "user-data-backup.zip"
} | ConvertTo-Json

# Upload to Railway
try {
    $response = Invoke-WebRequest -Uri "$RailwayUrl/upload-user-data" -Method POST -Body $jsonPayload -ContentType "application/json" -TimeoutSec 300
    $result = $response.Content | ConvertFrom-Json
    
    if ($result.ok) {
        Write-Host ""
        Write-Host "âœ… SUCCESS!" -ForegroundColor Green
        Write-Host "User data uploaded and extracted to: $($result.extractedTo)" -ForegroundColor Green
        Write-Host ""
        Write-Host "ðŸŽ‰ Your deployment is ready!" -ForegroundColor Cyan
        Write-Host ""
        Write-Host "Test your API with:" -ForegroundColor Yellow
        Write-Host "curl -X POST $RailwayUrl/press" -ForegroundColor White
    } else {
        Write-Host ""
        Write-Host "âŒ Upload failed: $($result.error)" -ForegroundColor Red
    }
} catch {
    Write-Host ""
    Write-Host "âŒ Error uploading: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host ""
    Write-Host "Troubleshooting:" -ForegroundColor Yellow
    Write-Host "1. Make sure your Railway app is running" -ForegroundColor White
    Write-Host "2. Check that the URL is correct" -ForegroundColor White
    Write-Host "3. Check Railway logs for errors" -ForegroundColor White
}

