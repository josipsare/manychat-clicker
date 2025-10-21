$railwayUrl = "https://web-production-acab4.up.railway.app"

Write-Host "Reading file..." -ForegroundColor Yellow
$fileBytes = [System.IO.File]::ReadAllBytes("user-data-backup.zip")
$fileBase64 = [System.Convert]::ToBase64String($fileBytes)

Write-Host "Creating payload..." -ForegroundColor Yellow
$jsonPayload = @{
    fileData = $fileBase64
    fileName = "user-data-backup.zip"
} | ConvertTo-Json

Write-Host "Uploading to Railway..." -ForegroundColor Yellow
$response = Invoke-WebRequest -Uri "$railwayUrl/upload-user-data" -Method POST -Body $jsonPayload -ContentType "application/json" -TimeoutSec 300

Write-Host "Response:" -ForegroundColor Green
$response.Content

