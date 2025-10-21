$railwayUrl = "https://web-production-acab4.up.railway.app"

Write-Host "Reading user-data-backup.zip..." -ForegroundColor Yellow
$fileBytes = [System.IO.File]::ReadAllBytes("user-data-backup.zip")
Write-Host "File size: $([math]::Round($fileBytes.Length/1MB, 2)) MB" -ForegroundColor Cyan

Write-Host "Converting to base64..." -ForegroundColor Yellow
$fileBase64 = [System.Convert]::ToBase64String($fileBytes)

Write-Host "Creating JSON payload..." -ForegroundColor Yellow
$jsonPayload = @{
    fileData = $fileBase64
    fileName = "user-data-backup.zip"
} | ConvertTo-Json

Write-Host "Uploading to Railway (this may take 1-2 minutes)..." -ForegroundColor Yellow
try {
    $response = Invoke-WebRequest -Uri "$railwayUrl/upload-user-data" -Method POST -Body $jsonPayload -ContentType "application/json" -TimeoutSec 300
    Write-Host "SUCCESS!" -ForegroundColor Green
    Write-Host $response.Content -ForegroundColor White
} catch {
    Write-Host "ERROR:" -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
}

