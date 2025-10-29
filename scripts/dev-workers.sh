#!/usr/bin/env bash
set -euo pipefail

# Quick helper to run two workers' dev servers in the repo for local testing.
# - Starts root worker (assumed wrangler.toml at repo root) on port 8787
# - Starts otp worker (workers/otp-worker) on port 8788
# Logs are written to ./logs/*.log and PIDs to ./tmp/*.pid

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="$ROOT_DIR/logs"
TMP_DIR="$ROOT_DIR/tmp"

mkdir -p "$LOG_DIR" "$TMP_DIR"

echo "Starting reko worker (bpjs-reko) on port 8787..."
(cd "$ROOT_DIR/workers/reko-worker" && wrangler dev --port 8787 > "$LOG_DIR/reko-dev.log" 2>&1 & echo $! > "$TMP_DIR/reko.pid")
sleep 1
echo "Root worker started (logs: $LOG_DIR/reko-dev.log)"

echo "Starting otp worker (bpjs-uid) on port 8788..."
(cd "$ROOT_DIR/workers/otp-worker" && wrangler dev --port 8788 > "$LOG_DIR/otp-dev.log" 2>&1 & echo $! > "$TMP_DIR/otp.pid")
sleep 1
echo "OTP worker started (logs: $LOG_DIR/otp-dev.log)"

echo "PIDs written to: $TMP_DIR/reko.pid and $TMP_DIR/otp.pid"
echo "To stop: kill $(cat "$TMP_DIR/reko.pid") $(cat "$TMP_DIR/otp.pid")"

echo "Tail logs: tail -f $LOG_DIR/reko-dev.log $LOG_DIR/otp-dev.log"
