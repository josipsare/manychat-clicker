# Start server with Cloudflare Tunnel

Write-Host "`n=== Starting ManyChat Clicker ===" -ForegroundColor Cyan

# Start server
Write-Host "Starting server..." -ForegroundColor Yellow
$serverJob = Start-Job -ScriptBlock {
    Set-Location $using:PWD
    $env:HEADLESS="true"
    node server.js
}
Start-Sleep -Seconds 3
Write-Host "[OK] Server running on port 3000" -ForegroundColor Green

# Start tunnel
Write-Host "Creating public tunnel..." -ForegroundColor Yellow
$tunnelJob = Start-Job -ScriptBlock {
    Set-Location $using:PWD
    .\cloudflared.exe tunnel --url http://localhost:3000 2>&1
}

Start-Sleep -Seconds 5

# Get URL
$maxAttempts = 15
$attempt = 0
$tunnelUrl = $null

Write-Host "Waiting for tunnel URL..." -ForegroundColor Gray

while ($attempt -lt $maxAttempts -and -not $tunnelUrl) {
    $attempt++
    $output = Receive-Job $tunnelJob 2>&1 | Out-String
    
    if ($output -match 'https://[a-zA-Z0-9\-]+\.trycloudflare\.com') {
        $tunnelUrl = $matches[0]
        break
    }
    
    Start-Sleep -Seconds 1
}

if ($tunnelUrl) {
    Write-Host ""
    Write-Host "========================================"  -ForegroundColor Green
    Write-Host "  ManyChat Clicker is LIVE!" -ForegroundColor Green
    Write-Host "========================================"  -ForegroundColor Green
    Write-Host ""
    Write-Host "Your Public URL:" -ForegroundColor Cyan
    Write-Host "  $tunnelUrl" -ForegroundColor White
    Write-Host ""
    Write-Host "Test your API:" -ForegroundColor Cyan
    Write-Host '  $body = @{' -ForegroundColor Gray
    Write-Host '    chatId="1054056495"' -ForegroundColor Gray
    Write-Host '    message="Hello from public URL!"' -ForegroundColor Gray
    Write-Host '  } | ConvertTo-Json' -ForegroundColor Gray
    Write-Host ''
    Write-Host "  Invoke-WebRequest ``" -ForegroundColor Gray
    Write-Host "    -Uri `"$tunnelUrl/press`" ``" -ForegroundColor Gray
    Write-Host '    -Method POST ``' -ForegroundColor Gray
    Write-Host '    -Body $body ``' -ForegroundColor Gray
    Write-Host '    -ContentType "application/json" ``' -ForegroundColor Gray
    Write-Host '    -Headers @{Authorization="Bearer pablonicotinepouches"}' -ForegroundColor Gray
    Write-Host ""
    Write-Host "========================================"  -ForegroundColor Green
    Write-Host ""
    Write-Host "Server is running. Press Ctrl+C to stop." -ForegroundColor Yellow
    Write-Host ""
    
    Set-Content "tunnel-url.txt" -Value $tunnelUrl
    
    try {
        while ($true) {
            Start-Sleep -Seconds 5
            if ($serverJob.State -ne 'Running' -or $tunnelJob.State -ne 'Running') {
                Write-Host "`nService stopped unexpectedly" -ForegroundColor Red
                break
            }
        }
    } finally {
        Write-Host "`nStopping..." -ForegroundColor Yellow
        Stop-Job $serverJob, $tunnelJob 2>$null
        Remove-Job $serverJob, $tunnelJob 2>$null
        Write-Host "Stopped" -ForegroundColor Green
    }
} else {
    Write-Host "`nCould not get tunnel URL" -ForegroundColor Red
    Write-Host "Output:" -ForegroundColor Yellow
    Receive-Job $tunnelJob 2>&1
    Stop-Job $serverJob, $tunnelJob 2>$null
    Remove-Job $serverJob, $tunnelJob 2>$null
}



