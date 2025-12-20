#!/bin/bash
TICKER="${1:-MNQ}"
DAYS="${2:-7}"
API_BASE="https://fut-fetchers.mkemalw.workers.dev"

echo "=== Backfilling $TICKER Intraday Data ($DAYS Days) ==="
echo "Target: $API_BASE/backfill-intraday"

# Curl with -v (verbose) optional or just output
RESPONSE=$(curl -s -X POST "$API_BASE/backfill-intraday?ticker=$TICKER&days=$DAYS")

echo "Response:"
echo "$RESPONSE" | jq .
