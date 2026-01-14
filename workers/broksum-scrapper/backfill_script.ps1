# Backfill Automation Script
# Usage: ./backfill_script.ps1

$baseUrl = "https://broksum-scrapper.mkemalw.workers.dev"
$startDate = Get-Date "2026-01-13"  # Adjust this to your desired start date
$daysToBackfill = 365
$chunkSize = 5

Write-Host "Starting Backfill for $daysToBackfill days from $startDate..." -ForegroundColor Cyan

for ($i = 0; $i -lt $daysToBackfill; $i += $chunkSize) {
    # Calculate the 'from' date for this chunk
    # We move backwards: StartDate - i days
    $currentFromDate = $startDate.AddDays(-$i).ToString("yyyy-MM-dd")
    
    $url = "$baseUrl/init?days=$chunkSize&from=$currentFromDate"
    
    Write-Host "[$i / $daysToBackfill] Triggering batch for 5 days starting: $currentFromDate" -NoNewline
    
    try {
        $response = Invoke-RestMethod -Uri $url -Method Get -ErrorAction Stop
        Write-Host " [OK]" -ForegroundColor Green
        Write-Host "   Response: $($response.message)" -ForegroundColor Gray
    }
    catch {
        Write-Host " [FAILED]" -ForegroundColor Red
        Write-Host "   Error: $_" -ForegroundColor Red
        # Optional: Add sleep or retry here
    }

    # Sleep to respect Cloudflare rate limits and give time for queue dispatch
    Write-Host "   Waiting 10 seconds..." -ForegroundColor DarkGray
    Start-Sleep -Seconds 10
}

Write-Host "Backfill Loop Completed." -ForegroundColor Cyan
