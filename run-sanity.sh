#!/usr/bin/env bash
set -euo pipefail

HOST="127.0.0.1"

ports=(8787 8788 8789 8790)
names=("asset-preprocess" "asset-analyzer" "asset-router" "multi-agent")

SANITY_PROMPT="${1:-Apa ibu kota Indonesia, (tanpa text format, tanpa markdown, tanpa format bold/italic).?}"

echo "=== HTTP connectivity check ==="
for i in "${!ports[@]}"; do
  port=${ports[$i]}
  name=${names[$i]}

  code=$(curl -s -o /dev/null -w "%{http_code}" "http://$HOST:$port" --max-time 2 || echo "000")

  if [[ "$code" == "000" ]]; then
    echo "[$name] :$port  ❌  no HTTP response (connection refused/timeout)"
  else
    echo "[$name] :$port  ✅  HTTP $code"
  fi
done

echo
echo "=== Process check (lsof) ==="
for i in "${!ports[@]}"; do
  port=${ports[$i]}
  name=${names[$i]}
  echo "[$name] :$port"
  lsof -i ":$port" 2>/dev/null || echo "  (no process listening)"
  echo
done

echo "=== Preprocess /health ==="
curl -s "http://$HOST:8787/health" || echo "❌ /health tidak merespon"
echo
echo

echo "=== Preprocess /sanity check ==="
echo "Prompt  : $SANITY_PROMPT"
echo "Response:"
curl -s -X POST "http://$HOST:8787/sanity" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg p "$SANITY_PROMPT" '{prompt: $p}')" || echo "❌ /sanity error"
echo
echo

echo "=== Analyzer /sanity check ==="
echo "Prompt  : $SANITY_PROMPT"
echo "Response:"
curl -s -X POST "http://$HOST:8788/sanity" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg p "$SANITY_PROMPT" '{prompt: $p}')" || echo "❌ /sanity error (analyzer)"
echo
echo

echo "=== multi-agent /health check ==="
curl -s "http://$HOST:8790/health" || echo "❌ /health multi-agent tidak merespon"
echo
echo

echo "=== multi-agent /sanity check ==="
echo "Prompt  : $SANITY_PROMPT"
echo "Response:"
curl -s -X POST "http://$HOST:8790/sanity" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg p "$SANITY_PROMPT" '{prompt: $p}')" || echo "❌ /sanity error (multi-agent)"
echo
echo
