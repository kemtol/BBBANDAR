#!/bin/bash
# Backfill MNQ futures daily data - 5 years, month by month
# Each month takes ~2-5 seconds

TICKER="${1:-MNQ}"
API_BASE="https://fut-fetchers.mkemalw.workers.dev"

echo "=== Backfilling $TICKER Daily Data (5 Years) ==="
echo ""

# Get list of months
MONTHS=$(curl -s -X POST "$API_BASE/backfill-futures?ticker=$TICKER&years=5" | jq -r '.months_to_process[]')

total=0
wrote_total=0
skipped_total=0

for month in $MONTHS; do
    result=$(curl -s -X POST "$API_BASE/backfill-futures?ticker=$TICKER&month=$month")
    wrote=$(echo "$result" | jq -r '.backfill_futures.wrote')
    skipped=$(echo "$result" | jq -r '.backfill_futures.skipped')
    total_month=$(echo "$result" | jq -r '.backfill_futures.total')
    
    echo "$month: wrote=$wrote, skipped=$skipped (total=$total_month)"
    
    wrote_total=$((wrote_total + wrote))
    skipped_total=$((skipped_total + skipped))
    total=$((total + total_month))
    
    # Small delay to avoid rate limiting
    sleep 0.5
done

echo ""
echo "=== COMPLETE ==="
echo "Total bars: $total"
echo "Wrote: $wrote_total"
echo "Skipped: $skipped_total"
