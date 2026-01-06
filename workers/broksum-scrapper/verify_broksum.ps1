Write-Output "Starting broksum-scrapper verification..."
$p = Start-Process -FilePath "cmd" -ArgumentList "/c npx wrangler dev --port 8792" -PassThru -NoNewWindow -RedirectStandardOutput "wrangler.log" -RedirectStandardError "wrangler.err"
Write-Output "Process started with ID: $($p.Id)"
Start-Sleep -Seconds 20
Write-Output "Waking up..."
try {
    $resp = Invoke-RestMethod -Uri "http://127.0.0.1:8792/" -ErrorAction Stop
    $json = $resp | ConvertTo-Json -Depth 5
    Write-Output "RESPONSE_SUCCESS: $json"
} catch {
    Write-Output "RESPONSE_ERROR: $_"
    Get-Content "wrangler.err" -ErrorAction SilentlyContinue
}
Stop-Process -InputObject $p -Force
Write-Output "Done."
