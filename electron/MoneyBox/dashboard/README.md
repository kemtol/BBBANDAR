# OpenClaw Dashboard

Live monitoring dashboard untuk OpenClaw multi-agent system.
Served oleh nginx di **http://213.199.49.18** (port 80).

---

## Deploy

```bash
rsync -av --delete dashboard/ root@213.199.49.18:/var/www/openclaw-dashboard/
```

Untuk deploy dispatcher saja:
```bash
scp electron/MoneyBox/agent-dispatcher-v4.py root@213.199.49.18:/usr/local/bin/agent-dispatcher.py
ssh root@213.199.49.18 "systemctl restart agent-dispatcher"
```

---

## Arsitektur

```
Browser → nginx :80
  /api/dispatcher/  → agent-dispatcher.py :19191
  /api/qdrant/      → Qdrant :6333
  /api/rag/         → RAG FastAPI :8000
```

---

## Data Points (semua sudah live ✅)

| Panel | Endpoint | Worker |
|---|---|---|
| Active Agents | `GET /api/dispatcher/metrics` | `metrics-worker.js` |
| Session Memory (per agent KB) | `GET /api/dispatcher/metrics` | `metrics-worker.js` |
| Context % + progress bar | `GET /api/dispatcher/metrics` | `metrics-worker.js` |
| Memories count | `GET /api/dispatcher/metrics` | `metrics-worker.js` |
| Heartbeat next-fire (menit) | `GET /api/dispatcher/metrics` | `metrics-worker.js` |
| Model name per agent | `GET /api/dispatcher/metrics` | `metrics-worker.js` |
| RAM %, Disk %, Uptime, Threads | `GET /api/dispatcher/metrics` | `metrics-worker.js` |
| Qdrant Points + Collections | `GET /api/qdrant/collections/{name}` | `qdrant-worker.js` |
| RAG bar chart per collection | `GET /api/qdrant/collections/{name}` | `qdrant-worker.js` |
| Services status (qdrant, rag) | metrics + live fetch `/api/rag/` | inline |
| Activity Log | `GET /api/dispatcher/logs?since=TS` | `log-worker.js` |
| Quick Actions (compact/heartbeat) | `POST /api/dispatcher/compact` | inline fetch |
| Connection status + statusbar | semua bus events | inline |

---

## Dispatcher Endpoints (ditambahkan v4)

| Method | Path | Deskripsi |
|---|---|---|
| GET | `/health` | `{status, ts}` |
| GET | `/metrics` | per-agent + system stats |
| GET | `/logs?since=TS` | last 500 log lines (ring buffer) |
| POST | `/compact` | trigger compact satu agent |
| POST | `/agent` | kirim message ke agent |

---

## File Structure

```
dashboard/
  index.html          ← Overview page (live data via worker-bus)
  kanban.html         ← Project Management
  agent.html          ← Agents detail
  rag.html            ← RAG / Qdrant detail
  log.html            ← Full logs view
  css/
    style.css
    themes.css
  worker/
    worker-bus.js     ← Event bus (import { bus })
    metrics-worker.js ← Poll /metrics setiap 5s
    log-worker.js     ← Poll /logs setiap 3s
    qdrant-worker.js  ← Poll Qdrant setiap 30s
    notif-worker.js   ← Push notifications
```

---

## Agents

| ID | Display | Model | Heartbeat |
|---|---|---|---|
| main | Albert | deepseek/deepseek-chat | every 60m @:00 |
| elsa | ELSA | deepseek/deepseek-chat | every 60m @:30 |
| ditesh | Ditesh | deepseek/deepseek-chat | every 60m @:45 |
| newton | Newton | anthropic/claude-sonnet-4-20250514 | every 360m @:10 |

Compact scheduler jalan di **:15** dan **:45** setiap jam. Threshold: **150KB**.