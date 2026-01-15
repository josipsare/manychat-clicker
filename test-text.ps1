# Quick Test Script for Text Followup Feature
# Usage: .\test-text.ps1

# ===== CONFIGURATION =====
# Replace these with your actual values
$AUTH_TOKEN = "YOUR_AUTH_TOKEN_HERE"
$CHAT_ID = "YOUR_CHAT_ID_HERE"
$PAGE_ID = "YOUR_PAGE_ID_HERE"
$MESSAGE = "Hello, this is a test message from PowerShell!"
$BASE_URL = "http://localhost:3000"

# ===== TEST TEXT FOLLOWUP =====
Write-Host "`n=== Testing Text Followup ===" -ForegroundColor Cyan
Write-Host "Message: $MESSAGE" -ForegroundColor Yellow
Write-Host "Chat ID: $CHAT_ID" -ForegroundColor Yellow
Write-Host "Page ID: $PAGE_ID" -ForegroundColor Yellow
Write-Host ""

$headers = @{
    "Authorization" = "Bearer $AUTH_TOKEN"
    "Content-Type" = "application/json"
}

$body = @{
    type = "text"
    chatId = $CHAT_ID
    message = $MESSAGE
    pageId = $PAGE_ID
} | ConvertTo-Json

try {
    Write-Host "Sending request..." -ForegroundColor Gray
    $response = Invoke-RestMethod -Uri "$BASE_URL/press" -Method POST -Headers $headers -Body $body -ErrorAction Stop
    Write-Host "`n✅ SUCCESS!" -ForegroundColor Green
    Write-Host ($response | ConvertTo-Json -Depth 10)
} catch {
    Write-Host "`n❌ ERROR!" -ForegroundColor Red
    Write-Host "Status Code: $($_.Exception.Response.StatusCode.value__)" -ForegroundColor Red
    if ($_.ErrorDetails.Message) {
        $errorObj = $_.ErrorDetails.Message | ConvertFrom-Json
        Write-Host "Error: $($errorObj.error)" -ForegroundColor Red
    } else {
        Write-Host "Error: $($_.Exception.Message)" -ForegroundColor Red
    }
}

Write-Host "`n=== Test Complete ===" -ForegroundColor Cyan

