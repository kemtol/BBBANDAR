#!/usr/bin/env bash
set -euo pipefail

# Usage: CF_ACCOUNT_ID=... CF_API_TOKEN=... CF_WORKER_NAME=... ./scripts/pull-worker.sh [outdir]
# Example:
# CF_ACCOUNT_ID=xxxx CF_API_TOKEN=xxxx CF_WORKER_NAME=cf-worker-name ./scripts/pull-worker.sh

: "${CF_ACCOUNT_ID:?Environment variable CF_ACCOUNT_ID is required.}"
: "${CF_API_TOKEN:?Environment variable CF_API_TOKEN is required.}"
: "${CF_WORKER_NAME:?Environment variable CF_WORKER_NAME is required.}"

OUT_DIR="${1:-scripts}"
mkdir -p "$OUT_DIR"
OUT_FILE="$OUT_DIR/${CF_WORKER_NAME}.js"

echo "Pulling worker '$CF_WORKER_NAME' from account $CF_ACCOUNT_ID -> $OUT_FILE"

curl -fSL -H "Authorization: Bearer $CF_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/workers/scripts/${CF_WORKER_NAME}" \
  -o "$OUT_FILE"

if [ $? -eq 0 ]; then
  echo "Saved worker script to: $OUT_FILE"
else
  echo "Failed to download worker script"
  exit 2
fi

exit 0
