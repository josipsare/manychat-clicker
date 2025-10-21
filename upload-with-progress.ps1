$railwayUrl = "https://web-production-acab4.up.railway.app"

Write-Host "📦 Step 1: Reading file..." -ForegroundColor Cyan
$fileBytes = [System.IO.File]::ReadAllBytes("user-data-backup.zip")
$fileSize = $fileBytes.Length
Write-Host "   File size: $([math]::Round($fileSize/1MB, 2)) MB" -ForegroundColor Green

Write-Host "🔄 Step 2: Converting to base64..." -ForegroundColor Cyan
$fileBase64 = [System.Convert]::ToBase64String($fileBytes)
Write-Host "   Base64 size: $([math]::Round($fileBase64.Length/1MB, 2)) MB" -ForegroundColor Green

Write-Host "📤 Step 3: Creating payload..." -ForegroundColor Cyan
$jsonPayload = @{
    fileData = $fileBase64
    fileName = "user-data-backup.zip"
} | ConvertTo-Json -Depth 10

Write-Host "🚀 Step 4: Uploading to Railway (this may take 1-2 minutes)..." -ForegroundColor Cyan

try {
    $response = Invoke-RestMethod -Uri "$railwayUrl/upload-user-data" -Method POST -Body $jsonPayload -ContentType "application/json" -TimeoutSec 300
    
    Write-Host ""
    Write-Host "✅ SUCCESS!" -ForegroundColor Green
    Write-Host "Message: $($response.message)" -ForegroundColor White
    Write-Host "Extracted to: $($response.extractedTo)" -ForegroundColor White
    Write-Host ""
    Write-Host "🎉 Your ManyChat clicker is now fully deployed!" -ForegroundColor Cyan
    
} catch {
    Write-Host ""
    Write-Host "❌ Error: $($_.Exception.Message)" -ForegroundColor Red
    if ($_.Exception.Response) {
        $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
        $responseBody = $reader.ReadToEnd()
        Write-Host "Response: $responseBody" -ForegroundColor Yellow
    }
}

