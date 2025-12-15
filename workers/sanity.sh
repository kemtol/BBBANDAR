#!/usr/bin/env bash
set -euo pipefail

# Pakai:
#   ./test_state_engine.sh https://livetrade-state-engine.YOURNAME.workers.dev
BASE_URL="${1:-https://livetrade-state-engine.mkemalw.workers.dev}"

echo "🔹 BASE_URL = $BASE_URL"
echo

echo "1) TEST /bulk-update (simulasi panggilan dari aggregator)..."
curl -sS -X POST "$BASE_URL/bulk-update" \
  -H "Content-Type: application/json" \
  -d '{
    "mode": "swing",
    "items": [
      {
        "kode": "BBRI",
        "mode": "swing",
        "open": 5000,
        "close": 5125,
        "high": 5150,
        "low": 4975,
        "vol": 1234567,
        "freq": 890,
        "net_vol": 345678,
        "money_flow": 0.28,
        "momentum": 2.5,
        "absorption": 1234.5,
        "val": 1234567890,
        "quadrant_profile": {
          "q1": 10,
          "q2": 5,
          "q3": 3,
          "q4": 12,
          "q4_ratio": 0.40
        },
        "hidden_acc_score": 0.1234,
        "history": [
          {
            "t": "09:00",
            "p": 5000,
            "v": 100000000,
            "dv": 50000000,
            "m": 0.0,
            "a": 100.0,
            "haka": 55.5,
            "x": 5.5
          },
          {
            "t": "09:05",
            "p": 5050,
            "v": 150000000,
            "dv": 50000000,
            "m": 1.0,
            "a": 150.0,
            "haka": 60.0,
            "x": 10.0
          }
        ],
        "last_raw": "20251211|090501|...|BBRI|RG|...|005050|00000100"
      }
    ]
  }' | jq . || echo "[INFO] jq tidak ada, output raw di atas."

echo
echo "✅ Selesai POST /bulk-update"
echo "--------------------------------------"
echo

echo "2) TEST /state?kode=BBRI (ambil balik dari DO)..."
curl -sS "$BASE_URL/state?kode=BBRI" | jq . || curl -sS "$BASE_URL/state?kode=BBRI"
echo
echo "--------------------------------------"
echo

echo "3) TEST /history (harusnya dummy HISTORY_BYPASSED_DO_DEBUG)..."
curl -sS "$BASE_URL/history?kode=BBRI&mode=swing&limit=5" | jq . || curl -sS "$BASE_URL/history?kode=BBRI&mode=swing&limit=5"
echo
echo "--------------------------------------"
echo "Selesai semua test ✅"
