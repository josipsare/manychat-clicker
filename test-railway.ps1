$url = "https://web-production-acab4.up.railway.app"

Write-Host "Testing Railway deployment..." -ForegroundColor Cyan
try {
    $response = Invoke-WebRequest -Uri $url -Method GET
    $result = $response.Content | ConvertFrom-Json
    Write-Host "✅ Railway is ready!" -ForegroundColor Green
    Write-Host "Service: $($result.service)" -ForegroundColor White
    Write-Host "Status: $($result.status)" -ForegroundColor White
    Write-Host ""
    Write-Host "Ready to upload! Run:" -ForegroundColor Yellow
    Write-Host "  .\upload-direct.ps1" -ForegroundColor White
} catch {
    Write-Host "❌ Railway not ready yet or error occurred" -ForegroundColor Red
    Write-Host "Wait a minute and try again" -ForegroundColor Yellow
}

