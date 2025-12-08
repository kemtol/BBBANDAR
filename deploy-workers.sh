  #!/usr/bin/env bash

  # deploy-workers-asset.sh
  # Usage:
  #   ./deploy-workers.sh                     # deploy workers + frontend
  #   ./deploy-workers.sh --workers-only      # hanya workers asset-*
  #   ./deploy-workers.sh --frontend-only     # hanya frontend qqquanta
  #   ./deploy-workers.sh --pages-only        # alias ke --frontend-only

  set -euo pipefail

  ROOT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

  cd "$ROOT_DIR"

  MODE="all"
  case "${1:-}" in
    "")
      MODE="all"
      ;;
    --pages-only|--frontend-only)
      MODE="frontend"
      ;;
    --workers-only)
      MODE="workers"
      ;;
    *)
      echo "Usage: $0 [--workers-only | --frontend-only]"
      exit 1
      ;;
  esac

  ############################
  # Helper: pretty echo
  ############################
  log() {
    echo -e "\n== $* =="
  }

  ############################
  # Step 1: Deploy Workers (asset-*)
  ############################
  deploy_workers() {
    log "START ASSET WORKERS (local sanity pipeline)"
    ./run-workers.sh start

    echo
    echo "== HEALTH CHECK =="

    # asset-preprocess /health
    echo ">> [asset-preprocess] GET http://127.0.0.1:8787/health"
    curl -sS http://127.0.0.1:8787/health | jq . || curl -sS http://127.0.0.1:8787/health

    # asset-analyzer /health
    echo
    echo ">> [asset-analyzer] GET http://127.0.0.1:8788/health"
    curl -sS http://127.0.0.1:8788/health | jq . || curl -sS http://127.0.0.1:8788/health

    # asset-router /health
    echo
    echo ">> [asset-router] GET http://127.0.0.1:8789/health"
    curl -sS http://127.0.0.1:8789/health | jq . || curl -sS http://127.0.0.1:8789/health

    echo
    echo "== SANITY TEST =="

    # asset-preprocess /sanity
    echo ">> [asset-preprocess] POST http://127.0.0.1:8787/sanity"
    curl -sS -X POST http://127.0.0.1:8787/sanity \
      -H "Content-Type: application/json" \
      -d '{"prompt":"test preprocess"}' \
      >/dev/null && echo "OK [asset-preprocess] sanity"

    # asset-analyzer /sanity
    echo
    echo ">> [asset-analyzer] POST http://127.0.0.1:8788/sanity"
    curl -sS -X POST http://127.0.0.1:8788/sanity \
      -H "Content-Type: application/json" \
      -d '{"prompt":"test analyzer"}' \
      >/dev/null && echo "OK [asset-analyzer] sanity"

    echo
    echo "== Semua health + sanity OK. Siap deploy. =="

    # Matikan dev workers
    ./run-workers.sh stop

    ########################
    # Deploy via Wrangler
    ########################
    echo
    echo "== DEPLOY VIA WRANGLER =="

    # Note: Ditambahkan --env="" untuk menghilangkan warning "Multiple environments"
    # Ini memaksa wrangler menggunakan konfigurasi top-level (default).

    echo
    echo "--> Deploy workers/asset-preprocess"
    ( cd "$ROOT_DIR/workers/asset-preprocess" && wrangler deploy )

    echo
    echo "--> Deploy workers/asset-analyzer"
    ( cd "$ROOT_DIR/workers/asset-analyzer" && wrangler deploy )

    echo
    echo "--> Deploy workers/asset-router"
    ( cd "$ROOT_DIR/workers/asset-router" && wrangler deploy )

    echo
    echo "--> Deploy workers/multi-agent"
    ( cd "$ROOT_DIR/workers/multi-agent" && wrangler deploy )

    echo
    echo "== DONE: semua worker berhasil di-deploy =="
  }

  ############################
  # Step 2: Deploy frontend Worker qqquanta
  ############################
  deploy_frontend() {
    local FRONTEND_DIR="$ROOT_DIR/workers/app-qqquanta"

    log "DEPLOY CLOUDFLARE FRONTEND (futures/ -> Worker qqquanta)"
    echo "Project dir : $FRONTEND_DIR"
    echo "Assets dir  : $ROOT_DIR/futures"
    echo "Worker name : qqquanta"

    cd "$FRONTEND_DIR"
    # Tambahkan --env="" juga disini untuk konsistensi
    wrangler deploy --env=""

    echo
    echo "== DONE: frontend qqquanta berhasil di-deploy =="
  }

  ############################
  # Main flow
  ############################
  case "$MODE" in
    all)
      deploy_workers
      deploy_frontend
      ;;
    workers)
      deploy_workers
      ;;
    frontend)
      deploy_frontend
      ;;
  esac

  echo
  echo "== PROD SANITY CHECK (asset-router /pass-imgs) =="

  PASS_IMGS_RESP="$(
    curl -sS -X POST "https://asset-router.mkemalw.workers.dev/pass-imgs" \
      -H "Content-Type: application/json" \
      -d '{
        "wizard_version": "sanity-prod",
        "pair": "gold",
        "style": "intraday",
        "analysis_mode": "INTRADAY",
        "screenshot_counts": { "charts": 0, "macro": 0 },
        "screenshots": { "charts": [], "macro": [] }
      }'
  )"

  echo "Raw response:"
  echo "$PASS_IMGS_RESP"

  if echo "$PASS_IMGS_RESP" | jq . >/dev/null 2>&1; then
    echo
    echo "Parsed JSON:"
    echo "$PASS_IMGS_RESP" | jq .
  else
    echo
    echo "(!) Response BUKAN JSON (mungkin error Cloudflare, misal 'error code: 1042')"
  fi