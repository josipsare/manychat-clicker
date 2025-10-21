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
    
    Write-Host "`n--- Verifying Extraction ---" -ForegroundColor Cyan
    Write-Host "Checking session data on Railway..." -ForegroundColor Yellow
    
    Start-Sleep -Seconds 2  # Give it a moment to finish extraction
    
    try {
        $debugResponse = Invoke-WebRequest -Uri "$railwayUrl/debug-session" -Method GET
        $debugData = $debugResponse.Content | ConvertFrom-Json
        
        Write-Host "`nSession Data Status:" -ForegroundColor Cyan
        Write-Host "  USER_DATA_DIR: $($debugData.userDataDir)" -ForegroundColor White
        Write-Host "  Directory Exists: $($debugData.exists)" -ForegroundColor $(if ($debugData.exists) { "Green" } else { "Red" })
        
        if ($debugData.exists) {
            Write-Host "  Total Items: $($debugData.totalItems)" -ForegroundColor White
            Write-Host "  Default Folder: $($debugData.defaultFolder.exists)" -ForegroundColor $(if ($debugData.defaultFolder.exists) { "Green" } else { "Red" })
            
            if ($debugData.criticalFiles) {
                Write-Host "`n  Critical Files:" -ForegroundColor Cyan
                foreach ($file in $debugData.criticalFiles.PSObject.Properties) {
                    $status = if ($file.Value.exists) { "✓" } else { "✗" }
                    $color = if ($file.Value.exists) { "Green" } else { "Red" }
                    $size = if ($file.Value.exists -and $file.Value.size) { " ($([math]::Round($file.Value.size/1KB, 2)) KB)" } else { "" }
                    Write-Host "    $status $($file.Name)$size" -ForegroundColor $color
                }
            }
        }
        
        Write-Host "`n✅ Verification complete!" -ForegroundColor Green
        Write-Host "`nNext step: Test with /press endpoint or /debug-verify-login" -ForegroundColor Yellow
        
    } catch {
        Write-Host "Warning: Could not verify extraction" -ForegroundColor Yellow
        Write-Host $_.Exception.Message -ForegroundColor Yellow
    }
    
} catch {
    Write-Host "ERROR:" -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
}

