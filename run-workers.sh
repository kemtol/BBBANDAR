#!/usr/bin/env bash

###############################
# How to use this script:
###############################
# ./run-workers.sh start
# ./run-workers.sh stop
# ./run-workers.sh status
# ./run-workers.sh restart
###############################

set -euo pipefail

ROOT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
LOG_DIR="$ROOT_DIR/logs/workers"
PID_DIR="$ROOT_DIR/tmp/pids"

mkdir -p "$LOG_DIR" "$PID_DIR"

start_worker() {
  local name="$1"
  local dir="$2"
  local port="$3"

  local pid_file="$PID_DIR/${name}.pid"
  local log_file="$LOG_DIR/${name}.log"

  # Kalau sudah ada PID dan proses masih hidup + listen, skip
  if [[ -f "$pid_file" ]]; then
    local old_pid
    old_pid="$(cat "$pid_file" || true)"
    if [[ -n "${old_pid:-}" ]] && kill -0 "$old_pid" 2>/dev/null; then
      if lsof -i ":$port" >/dev/null 2>&1; then
        echo "[$name] sudah jalan (pid=$old_pid, port=$port)."
        return
      fi
    fi
  fi

  echo "[$name] start di port $port ..."
  (
    cd "$dir"

    case "$name" in
      asset-router)
        # Router pakai env "local" → PREPROCESS_URL / ANALYZER_URL = localhost
        wrangler dev --env local --port "$port"
        ;;
      *)
        # Worker lain cukup wrangler dev biasa
        wrangler dev --port "$port"
        ;;
    esac

  ) >"$log_file" 2>&1 &

  local pid=$!
  echo "$pid" > "$pid_file"
  echo "[$name] pid=$pid  log=$log_file"

  # Tunggu sampai listening atau fail
  wait_for_port "$name" "$port" "$log_file"
}

wait_for_port() {
  local name="$1"
  local port="$2"
  local log_file="$3"
  local timeout=15

  for ((i=1; i<=timeout; i++)); do
    if lsof -i ":$port" >/dev/null 2>&1; then
      echo "[$name] ✅ listening di :$port (ready)"
      return 0
    fi

    # Kalau proses sudah mati sebelum listen
    local pid_file="$PID_DIR/${name}.pid"
    if [[ -f "$pid_file" ]]; then
      local pid
      pid="$(cat "$pid_file" || true)"
      if [[ -n "${pid:-}" ]] && ! kill -0 "$pid" 2>/dev/null; then
        echo "[$name] ❌ proses mati sebelum listen di :$port"
        echo "----- LAST LOG [$name] -----"
        tail -n 20 "$log_file" 2>/dev/null || echo "(log kosong)"
        echo "----------------------------"
        return 1
      fi
    fi

    sleep 1
  done

  echo "[$name] ❌ tidak listen di :$port dalam 15 detik."
  echo "----- LAST LOG [$name] -----"
  tail -n 20 "$log_file" 2>/dev/null || echo "(log kosong)"
  echo "----------------------------"
  return 1
}

stop_worker() {
  local name="$1"
  local pid_file="$PID_DIR/${name}.pid"

  # mapping name → port (biar bisa kill via lsof kalau PID file ga ada)
  local port=""
  case "$name" in
    auth-uid)        port=8786 ;;
    asset-preprocess) port=8787 ;;
    asset-analyzer)   port=8788 ;;
    asset-router)     port=8789 ;;
    multi-agent)      port=8790 ;;
    *) port="" ;;
  esac


  if [[ -f "$pid_file" ]]; then
    local pid
    pid="$(cat "$pid_file" || true)"

    if [[ -n "${pid:-}" ]] && kill -0 "$pid" 2>/dev/null; then
      echo "[$name] stop pid=$pid ..."
      kill "$pid" 2>/dev/null || true
    else
      echo "[$name] PID file ada tapi prosesnya sudah tidak hidup."
    fi

    rm -f "$pid_file"
  else
    echo "[$name] tidak ada PID file."
  fi

  # Fallback: kalau masih ada proses yang listen di port, kill via lsof
  if [[ -n "$port" ]]; then
    local pids_from_port
    pids_from_port="$(lsof -ti ":$port" 2>/dev/null || true)"
    if [[ -n "$pids_from_port" ]]; then
      echo "[$name] force kill via port :$port (pids: $pids_from_port)"
      # shellcheck disable=SC2086
      kill $pids_from_port 2>/dev/null || true
    fi
  fi
}


status_worker() {
  local name="$1"
  local port="$2"
  local pid_file="$PID_DIR/${name}.pid"

  local pid="(unknown)"
  if [[ -f "$pid_file" ]]; then
    pid="$(cat "$pid_file" || true)"
  fi

  if lsof -i ":$port" >/dev/null 2>&1; then
    echo "[$name] ON  (pid=$pid, port=$port)"
  else
    echo "[$name] OFF (pid=$pid, port=$port)"
  fi
}

case "${1:-start}" in
  start)
    echo "== START ASSET + SERVICE WORKERS =="
    start_worker "auth-uid"        "$ROOT_DIR/workers/auth-uid"        8786
    start_worker "asset-preprocess" "$ROOT_DIR/workers/asset-preprocess" 8787
    start_worker "asset-analyzer"   "$ROOT_DIR/workers/asset-analyzer"   8788
    start_worker "asset-router"     "$ROOT_DIR/workers/asset-router"     8789
    start_worker "multi-agent"      "$ROOT_DIR/workers/multi-agent"      8790
    echo "Done. Cek status dengan: $0 status"
    ;;
  stop)
    echo "== STOP ASSET + SERVICE WORKERS =="
    stop_worker "multi-agent"
    stop_worker "asset-router"
    stop_worker "asset-analyzer"
    stop_worker "asset-preprocess"
    stop_worker "auth-uid"
    echo "Done."
    ;;
  restart)
    "$0" stop || true
    "$0" start
    ;;
  status)
    echo "== STATUS ASSET + SERVICE WORKERS =="
    status_worker "auth-uid"         8786
    status_worker "asset-preprocess" 8787
    status_worker "asset-analyzer"   8788
    status_worker "asset-router"     8789
    status_worker "multi-agent"      8790
    ;;
  *)
    echo "Usage: $0 {start|stop|restart|status}"
    exit 1
    ;;
esac

