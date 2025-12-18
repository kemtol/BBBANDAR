#!/bin/bash
# Quick cleanup script for raw futures data

WORKER_URL="YOUR_WORKER_URL_HERE"  # Update this after deployment

# Array of prefixes to cleanup
PREFIXES=(
    "futures/raw_MNQ/"
    "futures/raw_MGC/"
)

echo "=== Batch Cleanup Script ==="
echo ""

for prefix in "${PREFIXES[@]}"; do
    echo "Processing: $prefix"
    
    # Get list and token
    RESPONSE=$(curl -s "$WORKER_URL/list?prefix=$prefix")
    COUNT=$(echo "$RESPONSE" | jq -r '.total')
    TOKEN=$(echo "$RESPONSE" | jq -r '.confirm_token')
    
    if [ "$COUNT" = "0" ] || [ "$COUNT" = "null" ]; then
        echo "  ✓ No objects found, skipping"
        continue
    fi
    
    echo "  Found $COUNT objects"
    read -p "  Delete these objects? (yes/no): " confirm
    
    if [ "$confirm" = "yes" ]; then
        echo "  Deleting..."
        RESULT=$(curl -s -X DELETE "$WORKER_URL/delete?prefix=$prefix&confirm=$TOKEN")
        DELETED=$(echo "$RESULT" | jq -r '.deleted')
        echo "  ✓ Deleted $DELETED objects"
    else
        echo "  Skipped"
    fi
    
    echo ""
done

echo "=== Cleanup Complete ==="
