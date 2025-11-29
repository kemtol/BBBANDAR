#!/usr/bin/env bash

# deploy-workers-asset.sh
# Usage:
#   ./deploy-workers-asset.sh           # deploy workers + pages
#   ./deploy-workers-asset.sh --workers-only
#   ./deploy-workers-asset.sh --pages-only

set -euo pipefail

ROOT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PAGES_PROJECT_NAME="qqquanta"   # GANTI sesuai nama project CF Pages kamu

cd "$ROOT_DIR"

MODE="all"
case "${1:-}" in
  "")
    MODE="all"
    ;;
  --pages-only)
    MODE="pages"
    ;;
  --workers-only)
    MODE="workers"
    ;;
  *)
    echo "Usage: $0 [--workers-only | --pages-only]"
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
# Step 1: Deploy Workers
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
  echo "== DONE: semua worker berhasil di-deploy =="
}

############################
# Step 2: Deploy Pages (futures/)
############################
deploy_pages() {
  log "DEPLOY CLOUDFLARE PAGES (futures only)"
  echo "Root   : $ROOT_DIR/futures"
  echo "Project: $PAGES_PROJECT_NAME"

  wrangler pages deploy ./futures --project-name "$PAGES_PROJECT_NAME"

  echo
  echo "== DONE: Futures wizard deployed to Cloudflare Pages =="
}

############################
# Main flow
############################
case "$MODE" in
  all)
    deploy_workers
    deploy_pages
    ;;
  workers)
    deploy_workers
    ;;
  pages)
    deploy_pages
    ;;
esac
