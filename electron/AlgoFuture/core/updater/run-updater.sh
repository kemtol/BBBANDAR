#!/bin/bash

# run-updater.sh - Helper script for Crontab
# Menjalankan emiten-updater.js menggunakan Node.js

# Navigasi ke direktori project (agar path relatif di JS aman)
cd "$(dirname "$0")/../.."

echo "[CRON] Starting Emiten Sync at $(date)"
node core/updater/emiten-updater.js
echo "[CRON] Sync finished at $(date)"
