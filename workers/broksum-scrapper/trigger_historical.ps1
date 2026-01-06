
$WorkerUrl = Read-Host -Prompt "Enter the Worker URL (e.g., https://broksum-scrapper.username.workers.dev)"

# 1. Update Watchlist
Write-Host "Updating Watchlist..."
try {
    $update = Invoke-RestMethod -Uri "$WorkerUrl/update-watchlist" -Method Get
    Write-Host "Watchlist Updated: $($update.message)"
} catch {
    Write-Host "Error updating watchlist: $_" -ForegroundColor Red
}

# 2. Trigger Last 7 Days
$today = Get-Date
for ($i = 1; $i -le 90; $i++) {
    $date = $today.AddDays(-$i).ToString("yyyy-MM-dd")
    Write-Host "Triggering scrape for $date..."
    try {
        $scrape = Invoke-RestMethod -Uri "$WorkerUrl/scrape?date=$date" -Method Get
        Write-Host "Scrape Triggered: $($scrape.message) (Batches: $($scrape.total_batches))"
    } catch {
        Write-Host "Error fetching $date: $_" -ForegroundColor Red
    }
    Start-Sleep -Seconds 2 # Gentle delay
}
Write-Host "Done."
