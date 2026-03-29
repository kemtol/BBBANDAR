#!/usr/bin/env python3
"""
Agent Dispatcher v4 — Self-contained agent orchestrator
  HTTP bridge:  POST /agent   {"agent":"main","message":"...","inject_memory":true}
                POST /compact {"agent":"main"}
  Schedulers:   compact_scheduler (every 15 min, or urgent at 70% context fill)
                heartbeat_scheduler (reads heartbeat.md per-agent)
  RAG bridge:   index_to_rag() after each memory snapshot
"""
from http.server import HTTPServer, BaseHTTPRequestHandler
import re, sqlite3
import subprocess, json, logging, os, signal, sys, threading, urllib.request, urllib.parse
from datetime import datetime, timezone
from pathlib import Path

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("dispatcher")

ALLOWED_AGENTS = {"main", "elsa", "ditesh", "newton"}
AGENT_TIMEOUT  = 120         # default timeout
AGENT_TIMEOUTS = {
    "main":   120,
    "elsa":   600,   # needs extra time for embedding/RAG ingestion
    "ditesh": 300,
    "newton": 180,
}
COMPACT_THRESH      = 150 * 1024  # 150 KB → proactive compaction threshold
COMPACT_MAX_SESSIONS = 8          # batch-compact ALL sessions when count exceeds this
COMPACT_MIN_SIZE     = 10  * 1024  # 10 KB lower bound — skip near-empty junk sessions
COMPACT_STALE_SEC    = 3600       # 1 hour — sessions unmodified longer than this are stale
COMPACT_ARCHIVE_TTL  = 86400      # 24 hours — delete archived files older than this
OPENCLAW_DIR   = Path(os.path.expanduser("~/.openclaw"))
KANBAN_DB      = OPENCLAW_DIR / "kanban.db"
POLL_INTERVAL  = 2           # seconds between getUpdates polls

# Telegram: per-agent bot token + target chat_id
TG_CHAT_ID = 7980136995
TG_AGENTS  = {
    "main":   "8684914523:AAFmnEODA5g4udOuZDCA0AjIrCnAZxiaTgs",
    "elsa":   "8639143226:AAGn-uw7GDpAvmuQeqfpOE4sdrwGoHMdH2E",
    "ditesh": "8653047406:AAEqKdkkFe_3VkxoeSigkqQ8WfkrT27UHs8",
    "newton": "8684914523:AAFmnEODA5g4udOuZDCA0AjIrCnAZxiaTgs",
}


# ─── Telegram helper ─────────────────────────────────────────────────────────

def send_telegram(text: str, agent: str = "main", chat_id: int = TG_CHAT_ID) -> bool:
    """Send text to Telegram chat via the agent's Bot API. Truncates to 4096 chars."""
    bot_token = TG_AGENTS.get(agent, TG_AGENTS["main"])
    if not bot_token:
        return False
    def _tg_post(payload_dict):
        req = urllib.request.Request(
            f"https://api.telegram.org/bot{bot_token}/sendMessage",
            data=json.dumps(payload_dict).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read()).get("ok", False)

    try:
        return _tg_post({"chat_id": chat_id, "text": text[:4096], "parse_mode": "Markdown"})
    except urllib.error.HTTPError as e:
        if e.code == 400:
            log.info(f"telegram markdown failed, retrying plain (agent={agent})")
            try:
                return _tg_post({"chat_id": chat_id, "text": text[:4096]})
            except Exception as e2:
                log.warning(f"telegram plain send also failed (agent={agent}): {e2}")
                return False
        log.warning(f"telegram send failed (agent={agent}): {e}")
        return False
    except Exception as e:
        log.warning(f"telegram send failed (agent={agent}): {e}")
        return False


# ─── Memory helpers ──────────────────────────────────────────────────────────

def _agent_workspace(agent: str):
    """Return Path of the agent's workspace dir (from openclaw.json), or None."""
    try:
        cfg = json.loads((OPENCLAW_DIR / "openclaw.json").read_text())
        ws = cfg.get("agents", {}).get("list", {}).get(agent, {}).get("workspace")
        return Path(ws) if ws else None
    except Exception:
        return None


def load_recent_memories(agent: str, max_n: int = 3) -> str:
    """Load last N session snapshots as context block to inject into prompt."""
    mem_dir = OPENCLAW_DIR / "agents" / agent / "memories"
    if not mem_dir.exists():
        return ""
    files = sorted(mem_dir.glob("*.json"), reverse=True)[:max_n]
    if not files:
        return ""
    parts = []
    for f in files:
        try:
            d   = json.loads(f.read_text())
            ts  = d.get("timestamp", f.stem)
            ctx = d.get("context", "")
            dec = "; ".join(d.get("decisions", []))
            wip = "; ".join(d.get("in_progress", []))
            ins = "; ".join(d.get("insights", []))
            block = f"[{ts}] {ctx}"
            if dec: block += f" | Decisions: {dec}"
            if wip: block += f" | WIP: {wip}"
            if ins: block += f" | Insights: {ins}"
            parts.append(block)
        except Exception:
            pass
    if not parts:
        return ""
    return "=== ACCUMULATED MEMORY (past sessions) ===\n" + "\n".join(parts) + "\n=== END MEMORY ===\n\n"


def load_rag_context(agent: str, query: str, limit: int = 4) -> str:
    """Query RAG /search for relevant past memory. Replaces bulk inject_memory
    for agents with use_rag_context: true in heartbeat.md."""
    try:
        payload = {"text": query[:400], "collection": f"agent_memory_{agent}", "limit": limit}
        req = urllib.request.Request(
            "http://localhost:8000/search",
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read())
        results = data.get("results", [])
        if not results:
            return ""
        parts = []
        for r in results:
            doc     = r.get("document", {})
            content = doc.get("content", "")
            ts      = doc.get("metadata", {}).get("ts", "")
            score   = r.get("score", 0)
            if content and score > 0.15:  # filter low-relevance results
                header = f"[{ts}]" if ts else "[past]"
                parts.append(f"{header} {content[:400]}")
        if not parts:
            return ""
        return "=== RAG MEMORY (relevant past context) ===\n" + "\n---\n".join(parts) + "\n=== END RAG MEMORY ===\n\n"
    except Exception as e:
        log.warning(f"load_rag_context failed for {agent}: {e}")
        return ""


def flush_workspace_to_rag(agent: str):
    """Index the agent's workspace/memory/*.md files into RAG before compaction.
    Skips files < 200 bytes to avoid indexing near-empty stubs."""
    ws = _agent_workspace(agent)
    if not ws:
        return
    mem_dir = ws / "memory"
    if not mem_dir.exists():
        return
    for md_file in sorted(mem_dir.glob("*.md")):
        try:
            content = md_file.read_text().strip()
            if len(content) < 200:
                continue
            doc_id = f"ws_mem_{agent}_{md_file.stem}"
            payload = {
                "id":      doc_id,
                "content": content[:6000],
                "collection": f"agent_memory_{agent}",
                "metadata": {"source": "workspace_memory", "agent": agent,
                              "file": md_file.name, "ts": datetime.now(timezone.utc).isoformat()},
                "source":  f"workspace/memory/{md_file.name}",
            }
            req = urllib.request.Request(
                "http://localhost:8000/index",
                data=json.dumps(payload, ensure_ascii=False).encode(),
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=30) as resp:
                pass
            log.info(f"workspace memory → RAG: {agent}/{md_file.name} ({len(content)}B)")
        except Exception as e:
            log.warning(f"flush_workspace_to_rag failed for {agent}/{md_file.name}: {e}")


def save_memory(agent: str, summary: dict) -> Path:
    mem_dir = OPENCLAW_DIR / "agents" / agent / "memories"
    mem_dir.mkdir(parents=True, exist_ok=True)
    ts  = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    out = mem_dir / f"{ts}.json"
    out.write_text(json.dumps(summary, indent=2, ensure_ascii=False))
    log.info(f"memory saved → {out.name}")
    return out


def index_to_rag(agent: str, summary: dict, mem_file: Path):
    """POST memory snapshot to RAG /index for Qdrant semantic search.
    Uses per-agent collection: agent_memory_{agent}"""
    try:
        doc_id = f"mem_{agent}_{mem_file.stem}"
        content_parts = [summary.get("context", "")]
        for key in ("decisions", "in_progress", "insights"):
            items = summary.get(key, [])
            if items:
                content_parts.append(f"{key}: {'; '.join(items)}")
        payload = {
            "id": doc_id,
            "content": " | ".join(content_parts),
            "collection": f"agent_memory_{agent}",   # per-agent collection
            "metadata": {"source": "compact", "agent": agent, "ts": summary.get("timestamp", "")},
            "source": f"memory/{mem_file.name}",
        }
        req = urllib.request.Request(
            "http://localhost:8000/index",
            data=json.dumps(payload, ensure_ascii=False).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            pass
        log.info(f"RAG indexed → {doc_id}")
    except Exception as e:
        log.warning(f"RAG index failed for {agent}: {e}")


# ─── Compaction ──────────────────────────────────────────────────────────────

def get_sessions(agent: str):
    d = OPENCLAW_DIR / "agents" / agent / "sessions"
    # Skip already-archived files to prevent filename accumulation
    return [p for p in d.glob("*.jsonl") if not p.name.startswith("_archived_")] if d.exists() else []


# ─── Kanban DB ──────────────────────────────────────────────────────────────

KANBAN_SEED = [
    {"id":"T-41","title":"Dispatcher v5: live metrics API","description":"Expose /metrics HTTP endpoint di dispatcher untuk agent session sizes, heartbeat last-fire timestamp, compact run history.","status":"planning","agent":"Albert / Ditesh","priority":"\u2191 High","epic":"TASK-24","tags":["dispatcher","api","metrics"],"todos":["Design /metrics response schema","Implement metrics collection thread","Add JSON endpoint to HTTP handler","Test dengan curl dari dashboard","Update retrospective"]},
    {"id":"T-40","title":"Dashboard: sambungkan ke real-time API","description":"Replace seluruh mock data di dashboard/index.html dengan fetch() ke dispatcher /metrics dan Qdrant /collections/.","status":"planning","agent":"ELSA","priority":"\u2192 Medium","epic":"TASK-24","tags":["dashboard","frontend"],"todos":["Map mock data ke API fields","Implement setInterval fetch","Handle loading & error states","Deploy ke VPS"]},
    {"id":"T-39","title":"Per-agent Qdrant collections setup","description":"Buat 4 collections Qdrant terpisah per agent: agent_memory_main, agent_memory_ditesh, agent_memory_newton. agent_memory_elsa sudah ada.","status":"planning","agent":"ELSA","priority":"\u2192 Medium","epic":"TASK-11","tags":["qdrant","rag"],"todos":["Buat agent_memory_main","Buat agent_memory_ditesh","Buat agent_memory_newton","Verify ingest via dispatcher"]},
    {"id":"T-38","title":"Cron: per-agent rag_heartbeat_monitor","description":"Tambah crontab entries: AGENT_NAME=elsa python3 rag_heartbeat_monitor.py tiap 15 menit untuk semua agent yang active.","status":"planning","agent":"Ditesh","priority":"\u2191 High","epic":"TASK-8","tags":["cron","rag","elsa"],"todos":["Test manual run per agent","Tambah crontab elsa","Tambah crontab main","Tambah crontab ditesh","Verify log output"]},
    {"id":"T-35","title":"Deploy dashboard ke VPS (nginx)","description":"Setup nginx di VPS untuk serve dashboard/index.html + kanban.html di port publik. Tambah basic auth agar tidak aksesibel bebas.","status":"todo","agent":"Ditesh","priority":"\u2191 High","epic":"TASK-24","tags":["nginx","vps","deploy"],"todos":["Install/config nginx","Upload dashboard files","Setup basic auth","Point domain atau IP public","Test akses dari luar"]},
    {"id":"T-36","title":"Newton: backtest queue integration","description":"Sambungkan Newton heartbeat pulse ke backtest queue API agar research pulse menampilkan data antrian backtest yang akurat.","status":"todo","agent":"Newton","priority":"\u2193 Low","epic":"TASK-11","tags":["newton","backtest","quant"],"todos":["Identify backtest queue API endpoint","Update newton heartbeat.md prompt","Test research pulse output"]},
    {"id":"T-37","title":"Session cleanup: housekeeping cron","description":"Tambah daily cron job untuk menghapus _archived_ session files yang sudah lebih dari 7 hari agar disk tidak penuh.","status":"todo","agent":"Ditesh","priority":"\u2192 Medium","epic":"TASK-8","tags":["cron","disk","cleanup"],"todos":["Tulis cleanup script","Test di non-production","Tambah ke crontab (0 2 * * *)","Monitor disk space setelah 1 minggu"]},
    {"id":"T-34","title":"OpenClaw Dashboard: UI mock","description":"Build full UI mock dashboard: overview page + kanban project management. Dark theme, agent cards, heartbeat status, RAG collections, system health.","status":"inprogress","agent":"Albert / ELSA","priority":"\u2191 High","epic":"TASK-24","tags":["dashboard","ui","html"],"todos":["\u2705 Build overview/index.html","\u2705 Build kanban.html","\u2705 Sidebar navigation","Add tab links antara halaman","Connect ke real API (TASK-40)"]},
    {"id":"T-33","title":"RAG: per-agent collection architecture","description":"Fix rag_heartbeat_monitor.py: 3 bugs — shared file paths, shared collection name, non-per-agent context check.","status":"inprogress","agent":"ELSA","priority":"\u2191 High","epic":"TASK-11","tags":["rag","qdrant","bugfix"],"todos":["\u2705 Fix memory path ke per-agent JSON snapshots","\u2705 Fix collection ke agent_memory_{agent}","\u2705 Fix context estimation per-agent","\u2705 Fix RAG API format (collection inside doc)","Verify di Qdrant collections list"]},
    {"id":"T-32","title":"Dispatcher v4: heartbeat_scheduler","description":"Implement heartbeat_scheduler() thread native di dispatcher. Baca heartbeat.md YAML frontmatter, fire prompts di offset_minutes, auto-reload setiap jam.","status":"inprogress","agent":"Albert / Ditesh","priority":"\u2191 High","epic":"TASK-24","tags":["dispatcher","heartbeat","scheduler"],"todos":["\u2705 Implement parse_frontmatter()","\u2705 Implement heartbeat_scheduler()","\u2705 Add index_to_rag() post-compact","\u2705 Deploy v4 ke VPS","\u2705 Verify 4 schedules loaded","Monitor first heartbeat fire"]},
    {"id":"T-31","title":"n8n heartbeat decommission","description":"Deactivate n8n workflows 01_Hourly_Tidy_Up_Main dan 02_Hourly_Pipeline_Elsa. Restart n8n container untuk apply perubahan.","status":"done","agent":"Ditesh","priority":"\u2192 Medium","epic":"TASK-24","tags":["n8n","heartbeat"],"todos":["\u2705 Identify workflow IDs","\u2705 Deactivate via n8n CLI","\u2705 Restart n8n container","\u2705 Verify tidak ada trigger baru"]},
    {"id":"T-30","title":"ELSA orphan session cleanup (44 files)","description":"44 orphan sessions dari n8n cron channel (UUID format). Archive semua ke _archived/ subfolder, reset sessions.json ke {}.","status":"done","agent":"ELSA","priority":"\u2192 Medium","epic":"TASK-11","tags":["elsa","sessions","cleanup"],"todos":["\u2705 Audit session files","\u2705 Archive 44 orphan files","\u2705 Reset sessions.json","\u2705 Verify clean state"]},
    {"id":"T-29","title":"SSH key auth setup (passwordless VPS)","description":"Deploy ed25519 pubkey ke VPS authorized_keys, enable PubkeyAuthentication di sshd_config, reload ssh.service.","status":"done","agent":"Ditesh","priority":"\u2193 Low","epic":"TASK-8","tags":["ssh","vps","auth"],"todos":["\u2705 Copy pubkey ke VPS","\u2705 Enable PubkeyAuthentication","\u2705 Reload sshd","\u2705 Test tanpa password"]},
    {"id":"T-28","title":"Ditesh compaction fix + 409 resolution","description":"Root cause: ditesh tidak ada di COMPACT_AGENTS. Fix 3: tambah ke list, archive .jsonl.old, hapus dari openclaw.json accounts.","status":"done","agent":"Ditesh","priority":"\u2191 High","epic":"TASK-11","tags":["ditesh","compact","409"],"todos":["\u2705 Tambah ditesh ke COMPACT_AGENTS","\u2705 Archive dead .jsonl.old files","\u2705 Hapus ditesh dari openclaw.json accounts","\u2705 Manual compact \u2192 snapshot pertama OK"]},
    {"id":"T-27","title":"Dispatcher v3: compact_scheduler","description":"Background thread compact yang run di :15 setiap jam. COMPACT_AGENTS = main, elsa, ditesh. Notifikasi hasil ke Ditesh via Telegram.","status":"done","agent":"Albert","priority":"\u2191 High","epic":"TASK-24","tags":["dispatcher","compact"],"todos":["\u2705 Implement compact_scheduler()","\u2705 COMPACT_AGENTS list","\u2705 Telegram notify","\u2705 Deploy"]},
    {"id":"T-26","title":"heartbeat.md untuk semua 4 agent","description":"Buat YAML frontmatter heartbeat.md per agent: main @:00 (60m), elsa @:30 (60m), ditesh @:45 (60m), newton @:10 (360m).","status":"done","agent":"Albert","priority":"\u2192 Medium","epic":"TASK-8","tags":["heartbeat","agents"],"todos":["\u2705 main heartbeat.md","\u2705 elsa heartbeat.md","\u2705 ditesh heartbeat.md","\u2705 newton heartbeat.md"]},
    {"id":"T-25","title":"Dispatcher v4 deploy + verify","description":"Deploy dispatcher v4 ke VPS, verify 5 threads running, all 4 schedules loaded dengan schedule yang benar, HTTP /agent endpoint 202 OK.","status":"done","agent":"Albert / Ditesh","priority":"\u2191 High","epic":"TASK-11","tags":["dispatcher","deploy"],"todos":["\u2705 SCP v4 ke VPS","\u2705 Syntax check (py_compile)","\u2705 systemctl restart","\u2705 journalctl 4 schedules correct","\u2705 HTTP endpoint test"]},
    {"id":"T-24","title":"OpenClaw VPS initial setup","description":"Full OpenClaw setup dari awal: providers DeepSeek+Anthropic, agents main/elsa/ditesh/newton, Telegram bots, auth-profiles, soul.md identity fix.","status":"done","agent":"Albert","priority":"\u2191 High","epic":"TASK-8","tags":["openclaw","vps","setup"],"todos":["\u2705 Install openclaw","\u2705 Configure providers","\u2705 Setup 4 agents","\u2705 Connect Telegram bots","\u2705 Fix DeepSeek identity confusion"]},
]


def _kanban_conn():
    """Open a SQLite connection to the kanban DB (per-call, closed by caller)."""
    conn = sqlite3.connect(str(KANBAN_DB), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn


def init_kanban_db():
    """Create tasks table and seed with initial data if empty."""
    conn = _kanban_conn()
    try:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS tasks (
                id          TEXT PRIMARY KEY,
                title       TEXT NOT NULL,
                description TEXT DEFAULT '',
                status      TEXT NOT NULL DEFAULT 'planning',
                agent       TEXT DEFAULT '',
                priority    TEXT DEFAULT '\u2192 Medium',
                epic        TEXT DEFAULT '\u2014',
                tags        TEXT DEFAULT '[]',
                todos       TEXT DEFAULT '[]',
                created_at  TEXT,
                updated_at  TEXT
            )
        """)
        conn.commit()
        cur = conn.execute("SELECT COUNT(*) FROM tasks")
        if cur.fetchone()[0] == 0:
            now = datetime.now(timezone.utc).isoformat()
            for t in KANBAN_SEED:
                conn.execute(
                    "INSERT INTO tasks (id,title,description,status,agent,priority,epic,tags,todos,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                    (t["id"], t["title"], t.get("description",""), t["status"],
                     t.get("agent",""), t.get("priority","\u2192 Medium"),
                     t.get("epic","\u2014"),
                     json.dumps(t.get("tags",[])), json.dumps(t.get("todos",[])),
                     now, now)
                )
            conn.commit()
            log.info(f"kanban_db: seeded {len(KANBAN_SEED)} tasks")
        else:
            log.info("kanban_db: already initialised, skipping seed")
    finally:
        conn.close()


def kanban_get_all() -> list:
    conn = _kanban_conn()
    try:
        rows = conn.execute(
            "SELECT * FROM tasks ORDER BY "
            "CASE status WHEN 'planning' THEN 1 WHEN 'todo' THEN 2 WHEN 'inprogress' THEN 3 WHEN 'done' THEN 4 END, id"
        ).fetchall()
        result = []
        for r in rows:
            d = dict(r)
            d["tags"]  = json.loads(d.get("tags")  or "[]")
            d["todos"] = json.loads(d.get("todos") or "[]")
            result.append(d)
        return result
    finally:
        conn.close()


def kanban_create(task_id, title, description, status, agent, priority, epic, tags, todos):
    now = datetime.now(timezone.utc).isoformat()
    conn = _kanban_conn()
    try:
        conn.execute(
            "INSERT OR REPLACE INTO tasks (id,title,description,status,agent,priority,epic,tags,todos,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (task_id, title, description, status, agent, priority, epic,
             json.dumps(tags  if isinstance(tags,  list) else []),
             json.dumps(todos if isinstance(todos, list) else []),
             now, now)
        )
        conn.commit()
    finally:
        conn.close()


def kanban_update(task_id: str, fields: dict) -> bool:
    allowed = {"title","description","status","agent","priority","epic","tags","todos"}
    updates = {k: v for k, v in fields.items() if k in allowed}
    if not updates:
        return False
    for k in ("tags","todos"):
        if k in updates and isinstance(updates[k], list):
            updates[k] = json.dumps(updates[k])
    updates["updated_at"] = datetime.now(timezone.utc).isoformat()
    set_clause = ", ".join(f"{k} = ?" for k in updates)
    vals = list(updates.values()) + [task_id]
    conn = _kanban_conn()
    try:
        conn.execute(f"UPDATE tasks SET {set_clause} WHERE id = ?", vals)
        conn.commit()
        return True
    finally:
        conn.close()


def kanban_delete(task_id: str):
    conn = _kanban_conn()
    try:
        conn.execute("DELETE FROM tasks WHERE id = ?", (task_id,))
        conn.commit()
    finally:
        conn.close()


def kanban_next_id() -> str:
    conn = _kanban_conn()
    try:
        rows = conn.execute("SELECT id FROM tasks").fetchall()
        nums = [int(m.group(1)) for r in rows for m in [re.match(r'^T-(\d+)$', r[0])] if m]
        return f"T-{max(nums)+1}" if nums else "T-42"
    finally:
        conn.close()


# ─── Metrics + Logs ──────────────────────────────────────────────────────────

# In-memory ring-buffer for dispatcher log lines (filled by DispatcherLogHandler)
import collections
_LOG_RING: collections.deque = collections.deque(maxlen=500)

class DispatcherLogHandler(logging.Handler):
    """Append structured log entries to the in-memory ring."""
    def emit(self, record: logging.LogRecord):
        msg = record.getMessage()
        # derive agent from message prefix patterns like "agent=main" or "compact elsa/"
        agent = "sys"
        for a in ("main", "elsa", "ditesh", "newton"):
            if a in msg:
                agent = a
                break
        level = record.levelname  # INFO / WARNING / ERROR
        _LOG_RING.append({
            "ts":    datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "agent": agent,
            "level": level,
            "msg":   msg[:300],
        })

# Attach handler to root logger so all log.info() calls go to ring
_log_handler = DispatcherLogHandler()
_log_handler.setLevel(logging.INFO)
logging.getLogger().addHandler(_log_handler)


def build_metrics() -> dict:
    """Compute live metrics from ~/.openclaw filesystem state."""
    cfg_path = OPENCLAW_DIR / "openclaw.json"
    agent_models = {}
    agent_names  = {}
    heartbeat_meta = {}
    try:
        cfg = json.loads(cfg_path.read_text())
        for a in cfg.get("agents", {}).get("list", []):
            aid = a.get("id", "")
            agent_models[aid] = a.get("model", {}).get("primary", "unknown")
            agent_names[aid]  = a.get("name", aid) or aid
    except Exception:
        pass

    agents_out = {}
    for ag in ALLOWED_AGENTS:
        d = OPENCLAW_DIR / "agents" / ag
        sessions_dir = d / "sessions"
        mem_dir      = d / "memories"
        hb_path      = d / "agent" / "heartbeat.md"

        active = get_sessions(ag)
        mems   = list(mem_dir.glob("*.json")) if mem_dir.exists() else []
        total_bytes = sum(p.stat().st_size for p in active)
        threshold   = COMPACT_THRESH  # bytes

        # Heartbeat metadata
        hb_offset   = None
        hb_interval = 60
        hb_label    = ""
        hb_rag      = False
        if hb_path.exists():
            txt = hb_path.read_text()
            if txt.startswith("---"):
                parts = txt.split("---", 2)
                for line in parts[1].strip().splitlines():
                    if ":" in line:
                        k, v = line.split(":", 1)
                        k = k.strip(); v = v.strip().strip('"').strip("'")
                        if k == "offset_minutes":
                            try: hb_offset = int(v)
                            except: pass
                        elif k == "interval_minutes":
                            try: hb_interval = int(v)
                            except: pass
                        elif k == "ritual_label":
                            hb_label = v
                        elif k == "use_rag_context":
                            hb_rag = v.lower() in ("true", "yes", "1")

        # Compute next fire time
        next_fire_min = None
        if hb_offset is not None:
            now_utc = datetime.now(timezone.utc)
            mins_day = now_utc.hour * 60 + now_utc.minute
            elapsed  = (mins_day - hb_offset) % hb_interval
            next_fire_min = hb_interval - elapsed

        # Context fill percentage: how full toward compact threshold (not raw token limit)
        context_pct = min(100, round(total_bytes / COMPACT_THRESH * 100))

        agents_out[ag] = {
            "name":          agent_names.get(ag, ag),
            "model":         agent_models.get(ag, "unknown"),
            "session_count": len(active),
            "session_kb":    total_bytes // 1024,
            "context_pct":   context_pct,
            "memories":      len(mems),
            "compact_thresh_kb": threshold // 1024,
            "heartbeat_offset":   hb_offset,
            "heartbeat_interval": hb_interval,
            "heartbeat_label":    hb_label,
            "heartbeat_next_min": next_fire_min,
            "use_rag_context":    hb_rag,
        }

    # System metrics
    import resource
    uptime_sec = 0
    try:
        with open("/proc/uptime") as f:
            uptime_sec = int(float(f.read().split()[0]))
    except Exception:
        pass

    cpu_pct = None
    ram_pct = None
    disk_pct = None
    try:
        import subprocess as _sp
        r = _sp.run(["free", "-m"], capture_output=True, text=True, timeout=3)
        for line in r.stdout.splitlines():
            if line.startswith("Mem:"):
                parts = line.split()
                total_ram = int(parts[1]); used_ram = int(parts[2])
                ram_pct = round(used_ram / total_ram * 100)
    except Exception:
        pass
    try:
        import subprocess as _sp
        r = _sp.run(["df", "-h", "/"], capture_output=True, text=True, timeout=3)
        lines = r.stdout.strip().splitlines()
        if len(lines) >= 2:
            disk_pct = int(lines[1].split()[4].replace("%",""))
    except Exception:
        pass

    thread_count = threading.active_count()

    return {
        "agents":         agents_out,
        "uptime_seconds": uptime_sec,
        "thread_count":   thread_count,
        "ram_pct":        ram_pct,
        "disk_pct":       disk_pct,
        "compact_thresh_kb": COMPACT_THRESH // 1024,
        "ts":             datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }


def extract_tail(session_file: Path, max_chars: int = 8000) -> str:
    msgs = []
    for line in session_file.read_text().splitlines():
        try:
            m    = json.loads(line)
            role = m.get("role", "")
            if role not in ("user", "assistant"):
                continue
            content = m.get("content", "")
            if isinstance(content, list):
                content = " ".join(c.get("text", "") for c in content if isinstance(c, dict))
            msgs.append(f"{role.upper()}: {str(content)[:400]}")
        except Exception:
            pass
    full = "\n".join(msgs)
    return full[-max_chars:] if len(full) > max_chars else full


def do_compact(agent: str, effective_thresh: int = None) -> dict:
    """Compact agent sessions. effective_thresh overrides COMPACT_THRESH for overflow/per-session
    size checks — pass a lower value when called urgently so the compact actually fires."""
    if effective_thresh is None:
        effective_thresh = COMPACT_THRESH

    sessions  = get_sessions(agent)
    compacted = []

    # Flush workspace memory to RAG before archiving any session
    if sessions:
        flush_workspace_to_rag(agent)

    # Batch mode: when session count exceeds limit, compact ALL sessions ≥ COMPACT_MIN_SIZE
    batch_mode = len(sessions) > COMPACT_MAX_SESSIONS
    if batch_mode:
        log.info(f"batch mode for {agent}: {len(sessions)} sessions > {COMPACT_MAX_SESSIONS}")

    # Total-overflow mode: total size > effective threshold but no individual session is large enough
    # → compact the largest session to relieve pressure
    total_bytes = sum(s.stat().st_size for s in sessions)
    overflow_target = None
    if not batch_mode and total_bytes >= effective_thresh:
        biggest = max(sessions, key=lambda s: s.stat().st_size, default=None)
        if biggest and biggest.stat().st_size >= COMPACT_MIN_SIZE:
            overflow_target = biggest
            log.info(f"total-overflow {agent}: {total_bytes//1024}KB total >= {effective_thresh//1024}KB → compact largest {biggest.name} ({biggest.stat().st_size//1024}KB)")

    for session in sessions:
        size = session.stat().st_size
        if batch_mode:
            if size < COMPACT_MIN_SIZE:
                log.info(f"skip tiny {agent}/{session.name} ({size//1024}KB) in batch mode")
                continue
            log.info(f"batch-compact {agent}/{session.name} ({size//1024}KB)")
        elif overflow_target:
            if session != overflow_target:
                continue
            log.info(f"overflow-compact {agent}/{session.name} ({size//1024}KB)")
        else:
            if size < effective_thresh:
                log.info(f"skip {agent}/{session.name} ({size//1024}KB < {effective_thresh//1024}KB threshold)")
                continue
            log.info(f"compacting {agent}/{session.name} ({size//1024}KB)")
        tail = extract_tail(session)
        ts_now = datetime.now(timezone.utc).isoformat()
        prompt = (
            "Buat memory snapshot dari percakapan berikut. "
            "Output HANYA raw JSON (tanpa markdown code block, tanpa penjelasan).\n\n"
            f"PERCAKAPAN:\n{tail}\n\n"
            "FORMAT JSON yang harus kamu output:\n"
            '{"agent":"' + agent + '",'
            '"timestamp":"' + ts_now + '",'
            '"context":"ringkasan konteks utama dalam 2-3 kalimat",'
            '"decisions":["keputusan atau kesimpulan penting"],'
            '"in_progress":["task yang belum selesai"],'
            '"insights":["insight teknis atau domain penting"],'
            '"keywords":["topik","utama"]}'
        )

        try:
            # Use ephemeral session for compact LLM call — avoid polluting dispatcher session
            compact_ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
            compact_session_id = f"ephemeral-compact-{agent}-{compact_ts}"
            result = subprocess.run(
                ["openclaw", "agent", "--agent", agent, "--session-id", compact_session_id, "--message", prompt, "--no-color"],
                capture_output=True, text=True, timeout=AGENT_TIMEOUTS.get(agent, AGENT_TIMEOUT),
                env={**os.environ, "TERM": "dumb"}
            )
            out   = result.stdout
            start = out.find("{")
            end   = out.rfind("}") + 1
            if start >= 0 and end > start:
                summary = json.loads(out[start:end])
            else:
                summary = {
                    "agent": agent, "timestamp": ts_now,
                    "context": out.strip()[:500],
                    "decisions": [], "in_progress": [], "insights": [], "keywords": []
                }

            mem_file = save_memory(agent, summary)
            index_to_rag(agent, summary, mem_file)

            ts_str    = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
            base_name = re.sub(r"^(_archived_\d{8}_\d{6}_)+", "", session.name)
            archive   = session.parent / f"_archived_{ts_str}_{base_name}"
            session.rename(archive)
            log.info(f"session archived → {archive.name}")

            compacted.append({
                "session":  session.name,
                "size_kb":  size // 1024,
                "memory":   mem_file.name,
                "archived": archive.name,
            })
        except Exception as e:
            log.error(f"compact error {agent}: {e}")
        finally:
            # Clean up ephemeral compact session file
            sessions_dir = OPENCLAW_DIR / "agents" / agent / "sessions"
            for f in sessions_dir.glob(f"*compact*{agent}*.jsonl"):
                try:
                    f.unlink()
                    log.info(f"compact ephemeral session deleted → {f.name}")
                except Exception:
                    pass

    return {
        "agent": agent,
        "threshold_kb": COMPACT_THRESH // 1024,
        "checked": len(sessions),
        "compacted": compacted,
    }


def cleanup_stale_sessions(agent: str) -> int:
    """Delete stale sessions (unmodified > COMPACT_STALE_SEC) that are too small to compact.
    These are typically gateway cron sessions that run every 10-30 minutes and pile up.
    Sessions ≥ COMPACT_MIN_SIZE are left for do_compact to handle properly."""
    import time
    sessions = get_sessions(agent)
    now = time.time()
    deleted = 0
    for s in sessions:
        age = now - s.stat().st_mtime
        size = s.stat().st_size
        if age > COMPACT_STALE_SEC and size < COMPACT_MIN_SIZE:
            try:
                s.unlink()
                log.info(f"stale cleanup: deleted {agent}/{s.name} ({size}B, {age/3600:.1f}h old)")
                deleted += 1
            except Exception as e:
                log.error(f"stale cleanup error {agent}/{s.name}: {e}")
    return deleted


def cleanup_archives(agent: str) -> int:
    """Delete archived session files older than COMPACT_ARCHIVE_TTL.
    These have already been summarized and indexed to RAG — no further value on disk."""
    import time
    d = OPENCLAW_DIR / "agents" / agent / "sessions"
    if not d.exists():
        return 0
    now = time.time()
    deleted = 0
    for f in d.glob("_archived_*.jsonl"):
        age = now - f.stat().st_mtime
        if age > COMPACT_ARCHIVE_TTL:
            try:
                f.unlink()
                log.info(f"archive cleanup: deleted {agent}/{f.name} ({age/3600:.1f}h old)")
                deleted += 1
            except Exception as e:
                log.error(f"archive cleanup error {agent}/{f.name}: {e}")
    return deleted


# Telegram bot token → agent name reverse map (for webhook routing)
TG_TOKEN_TO_AGENT = {v: k for k, v in TG_AGENTS.items()}


# ─── Background runner ───────────────────────────────────────────────────────

def run_agent_background(agent: str, message: str, ritual_name: str = "", reply_chat_id: int = None, ephemeral: bool = False):
    """Run openclaw agent, capture response, forward to Telegram.
    ephemeral=True: use a unique per-run session ID and delete the session file after
    the response is captured — true fire-and-forget, no context accumulation.
    """
    target_chat = reply_chat_id or TG_CHAT_ID
    if ephemeral:
        ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
        session_id = f"ephemeral-{agent}-{ts}"
    else:
        session_id = f"dispatcher-{agent}"
    try:
        cmd = ["openclaw", "agent", "--agent", agent, "--session-id", session_id, "--message", message, "--no-color"]
        log.info(f"background start → agent={agent} ritual={ritual_name} ephemeral={ephemeral} reply_to={target_chat}")
        result = subprocess.run(
            cmd, capture_output=True, text=True, timeout=AGENT_TIMEOUTS.get(agent, AGENT_TIMEOUT),
            env={**os.environ, "TERM": "dumb"}
        )
        response = result.stdout.strip()
        if not response:
            response = result.stderr.strip() or "(no response)"

        # Format message for Telegram — no header for DM replies (cleaner)
        if ritual_name:
            tg_text = f"*[{agent.upper()}]* {ritual_name}\n\n{response}"
        else:
            tg_text = response

        ok = send_telegram(tg_text, agent=agent, chat_id=target_chat)
        log.info(f"background done → agent={agent} tg_sent={ok} response_len={len(response)}")
    except subprocess.TimeoutExpired:
        log.warning(f"background timeout → agent={agent}")
        send_telegram(f"⚠️ Timeout setelah {AGENT_TIMEOUTS.get(agent, AGENT_TIMEOUT)}s", agent=agent, chat_id=target_chat)
    except Exception as e:
        log.error(f"background error → agent={agent}: {e}")
        send_telegram(f"❌ Error: {str(e)[:200]}", agent=agent, chat_id=target_chat)
    finally:
        # Ephemeral: delete session file immediately — no residual context
        if ephemeral:
            sessions_dir = OPENCLAW_DIR / "agents" / agent / "sessions"
            for f in sessions_dir.glob(f"{session_id}*.jsonl"):
                try:
                    f.unlink()
                    log.info(f"ephemeral session deleted → {f.name}")
                except Exception:
                    pass


# ─── HTTP Handler ────────────────────────────────────────────────────────────

class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        log.info(fmt % args)

    def _respond(self, code: int, data: dict):
        body = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", len(body))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        if self.path == "/metrics":
            self._respond(200, build_metrics())
            return
        if self.path.startswith("/logs"):
            from urllib.parse import urlparse, parse_qs
            qs  = parse_qs(urlparse(self.path).query)
            since = qs.get("since", [None])[0]
            lines = list(_LOG_RING)
            if since:
                lines = [l for l in lines if l["ts"] > since]
            self._respond(200, {"lines": lines})
            return
        if self.path == "/health":
            self._respond(200, {"status": "ok", "ts": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")})
            return

        # GET /agent-files?agent=X — list .md files in agent's /agent/ dir
        if self.path.startswith("/agent-files"):
            from urllib.parse import urlparse, parse_qs
            qs    = parse_qs(urlparse(self.path).query)
            agent = (qs.get("agent", [None])[0] or "").strip()
            if not agent or agent not in ALLOWED_AGENTS:
                self._respond(400, {"error": "invalid agent"}); return
            agent_dir = OPENCLAW_DIR / "agents" / agent / "agent"
            files = sorted(f.name for f in agent_dir.glob("*.md")) if agent_dir.exists() else []
            self._respond(200, {"agent": agent, "files": files})
            return

        # GET /agent-file?agent=X&file=Y — read a single .md file
        if self.path.startswith("/agent-file?"):
            from urllib.parse import urlparse, parse_qs
            qs    = parse_qs(urlparse(self.path).query)
            agent = (qs.get("agent", [None])[0] or "").strip()
            fname = (qs.get("file",  [None])[0] or "").strip()
            if not agent or agent not in ALLOWED_AGENTS:
                self._respond(400, {"error": "invalid agent"}); return
            if not fname or not fname.endswith(".md") or "/" in fname or ".." in fname:
                self._respond(400, {"error": "invalid file name"}); return
            fpath = OPENCLAW_DIR / "agents" / agent / "agent" / fname
            if not fpath.exists():
                self._respond(404, {"error": f"{fname} not found"}); return
            content = fpath.read_text(encoding="utf-8")
            self._respond(200, {"agent": agent, "file": fname, "content": content})
            return

        # GET /kanban/tasks — return all tasks from SQLite
        if self.path == "/kanban/tasks":
            try:
                tasks = kanban_get_all()
                self._respond(200, {"ok": True, "tasks": tasks})
            except Exception as e:
                log.error(f"kanban GET error: {e}")
                self._respond(500, {"ok": False, "error": str(e)})
            return

        # GET /qdrant/collections — list all Qdrant collections with point counts
        if self.path == "/qdrant/collections":
            try:
                QDRANT = "http://localhost:6333"
                with urllib.request.urlopen(f"{QDRANT}/collections", timeout=5) as r:
                    raw = json.loads(r.read())
                names = [c["name"] for c in raw.get("result", {}).get("collections", [])]
                collections = []
                for name in names:
                    try:
                        with urllib.request.urlopen(f"{QDRANT}/collections/{name}", timeout=5) as r2:
                            info = json.loads(r2.read()).get("result", {})
                        collections.append({
                            "name":         name,
                            "points_count": info.get("points_count", 0),
                            "status":       info.get("status", "green"),
                        })
                    except Exception:
                        collections.append({"name": name, "points_count": 0, "status": "unknown"})
                self._respond(200, {"ok": True, "collections": collections})
            except Exception as e:
                log.error(f"qdrant collections error: {e}")
                self._respond(500, {"ok": False, "error": str(e)})
            return

        # GET /qdrant/points?collection=NAME&limit=500 — scroll collection points
        if self.path.startswith("/qdrant/points"):
            from urllib.parse import urlparse, parse_qs as _pqs
            qs    = _pqs(urlparse(self.path).query)
            cname = (qs.get("collection", [None])[0] or "").strip()
            limit = min(int((qs.get("limit", ["500"])[0]) or 500), 500)
            if not cname:
                self._respond(400, {"ok": False, "error": "collection required"}); return
            try:
                QDRANT = "http://localhost:6333"
                payload = json.dumps({"limit": limit, "with_payload": True, "with_vector": False}).encode()
                req = urllib.request.Request(
                    f"{QDRANT}/collections/{cname}/points/scroll",
                    data=payload,
                    headers={"Content-Type": "application/json"},
                    method="POST",
                )
                with urllib.request.urlopen(req, timeout=10) as r:
                    data = json.loads(r.read())
                points = []
                for p in data.get("result", {}).get("points", []):
                    pl = p.get("payload", {})
                    meta = pl.get("metadata", {})
                    points.append({
                        "id":        str(p["id"]),
                        "content":   pl.get("content", ""),
                        "source":    pl.get("source", pl.get("doc_id", str(p["id"]))),
                        "timestamp": pl.get("timestamp", meta.get("ingested_at", "")),
                        "metadata":  meta,
                    })
                self._respond(200, {"ok": True, "collection": cname, "points": points})
            except Exception as e:
                log.error(f"qdrant points error {cname}: {e}")
                self._respond(500, {"ok": False, "error": str(e)})
            return

        self._respond(404, {"error": "not found"})

    def _read_body(self) -> dict:
        length = self.headers.get("Content-Length")
        if length is not None:
            data = self.rfile.read(int(length))
        else:
            # Chunked or missing Content-Length — read until connection closes
            chunks = []
            while True:
                line = self.rfile.readline()
                if not line:
                    break
                size_str = line.strip()
                if not size_str:
                    continue
                try:
                    chunk_size = int(size_str, 16)
                except ValueError:
                    # Not chunked encoding — plain read
                    chunks.append(size_str)
                    break
                if chunk_size == 0:
                    break
                chunks.append(self.rfile.read(chunk_size))
                self.rfile.read(2)  # CRLF
            data = b"".join(chunks) if chunks else b""
        if not data:
            return {}
        result = json.loads(data)
        if isinstance(result, str):
            result = json.loads(result)  # double-encoded string
        return result

    def do_POST(self):
        # Telegram webhook fallback (tidak dipakai, polling yang aktif)
        if self.path.startswith("/tg/"):
            self._respond(200, {}); return

        try:
            body = self._read_body()
        except Exception as e:
            log.warning(f"400 bad request body: {e} path={self.path} headers={dict(self.headers)}")
            self._respond(400, {"error": f"bad request: {e}"}); return

        # POST /kanban/tasks — create / upsert a task (no agent param needed)
        if self.path == "/kanban/tasks":
            try:
                title = (body.get("title") or "").strip()
                if not title:
                    self._respond(400, {"ok": False, "error": "title required"}); return
                task_id = (body.get("id") or "").strip() or kanban_next_id()
                kanban_create(
                    task_id,
                    title,
                    body.get("description", ""),
                    body.get("status", "planning"),
                    body.get("agent", ""),
                    body.get("priority", "\u2192 Medium"),
                    body.get("epic", "\u2014"),
                    body.get("tags", []),
                    body.get("todos", []),
                )
                log.info(f"kanban task created/updated: {task_id}")
                self._respond(200, {"ok": True, "id": task_id})
            except Exception as e:
                log.error(f"kanban POST error: {e}")
                self._respond(500, {"ok": False, "error": str(e)})
            return

        agent = body.get("agent", "main")
        if agent not in ALLOWED_AGENTS:
            log.warning(f"400 unknown agent={agent!r}")
            self._respond(400, {"error": f"unknown agent: {agent}"}); return

        # POST /compact ────────────────────────────────────────────────────────
        if self.path == "/compact":
            log.info(f"compact request → agent={agent}")
            result = do_compact(agent)
            n = len(result.get("compacted", []))
            if n > 0:
                send_telegram(f"*[{agent.upper()}]* 🗜️ Compacted {n} session(s) → memory saved", agent=agent)
            self._respond(200, result)
            return

        # POST /agent ──────────────────────────────────────────────────────────
        if self.path == "/agent":
            message = body.get("message", "").strip()
            if not message:
                self._respond(400, {"error": "message required"}); return

            ritual_name = body.get("ritual", "")

            if body.get("inject_memory", True):
                mem = load_recent_memories(agent)
                if mem:
                    message = mem + message

            t = threading.Thread(
                target=run_agent_background,
                args=(agent, message, ritual_name)
            )
            t.daemon = True
            t.start()
            self._respond(202, {
                "status":  "accepted",
                "agent":   agent,
                "ritual":  ritual_name,
                "note":    "response will be delivered via Telegram",
            })
            return

        # POST /agent-file — write a .md file back to agent's /agent/ dir
        if self.path == "/agent-file":
            fname   = (body.get("file",    "") or "").strip()
            content = body.get("content", "")
            if not fname or not fname.endswith(".md") or "/" in fname or ".." in fname:
                self._respond(400, {"error": "invalid file name"}); return
            fpath = OPENCLAW_DIR / "agents" / agent / "agent" / fname
            if not fpath.exists():
                self._respond(404, {"error": f"{fname} not found — only existing files can be updated"}); return
            fpath.write_text(content, encoding="utf-8")
            log.info(f"agent-file saved: {agent}/{fname} ({len(content)} bytes)")
            self._respond(200, {"status": "ok", "agent": agent, "file": fname, "bytes": len(content)})
            return

        # POST /agent-sync — run agent turn synchronously, return response in body
        # Used by the AI Assistant panel in the dashboard. Session is ephemeral.
        if self.path == "/agent-sync":
            message = (body.get("message", "") or "").strip()
            if not message:
                self._respond(400, {"error": "message required"}); return
            ts           = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
            session_id   = f"ai-assist-{agent}-{ts}"
            sessions_dir = OPENCLAW_DIR / "agents" / agent / "sessions"
            try:
                result = subprocess.run(
                    ["openclaw", "agent", "--agent", agent, "--session-id", session_id,
                     "--message", message, "--no-color"],
                    capture_output=True, text=True, timeout=120,
                    env={**os.environ, "TERM": "dumb"}
                )
                response = result.stdout.strip() or result.stderr.strip() or "(no response)"
                self._respond(200, {"agent": agent, "response": response})
            except subprocess.TimeoutExpired:
                self._respond(408, {"error": "timeout after 120s"})
            except Exception as e:
                self._respond(500, {"error": str(e)})
            finally:
                try:
                    for f in sessions_dir.glob(f"{session_id}*.jsonl"):
                        f.unlink()
                except Exception:
                    pass
            return

        self._respond(404, {"error": "not found"})

    def do_PATCH(self):
        try:
            body = self._read_body()
        except Exception as e:
            self._respond(400, {"ok": False, "error": str(e)}); return

        # PATCH /kanban/tasks — update task fields
        if self.path == "/kanban/tasks":
            try:
                task_id = (body.get("id") or "").strip()
                if not task_id:
                    self._respond(400, {"ok": False, "error": "id required"}); return
                ok = kanban_update(task_id, body)
                if ok:
                    log.info(f"kanban task updated: {task_id}")
                self._respond(200, {"ok": True, "id": task_id})
            except Exception as e:
                log.error(f"kanban PATCH error: {e}")
                self._respond(500, {"ok": False, "error": str(e)})
            return

        self._respond(404, {"error": "not found"})

    def do_DELETE(self):
        from urllib.parse import urlparse, parse_qs
        qs = parse_qs(urlparse(self.path).query)

        # DELETE /kanban/tasks?id=T-41 — remove a task
        if self.path.startswith("/kanban/tasks"):
            try:
                task_id = (qs.get("id", [None])[0] or "").strip()
                if not task_id:
                    self._respond(400, {"ok": False, "error": "id required"}); return
                kanban_delete(task_id)
                log.info(f"kanban task deleted: {task_id}")
                self._respond(200, {"ok": True, "id": task_id})
            except Exception as e:
                log.error(f"kanban DELETE error: {e}")
                self._respond(500, {"ok": False, "error": str(e)})
            return

        self._respond(404, {"error": "not found"})


def tg_api(token: str, method: str, payload: dict = None, timeout: int = 30) -> dict:
    """Generic Telegram Bot API call."""
    data = json.dumps(payload or {}).encode() if payload else None
    req  = urllib.request.Request(
        f"https://api.telegram.org/bot{token}/{method}",
        data=data,
        headers={"Content-Type": "application/json"} if data else {},
        method="POST" if data else "GET",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read())




# --- Document text extraction ------------------------------------------------

def extract_text_from_bytes(data, fname):
    ext = fname.rsplit('.', 1)[-1].lower() if '.' in fname else ''
    if ext == 'pdf':
        import io, pypdf
        reader = pypdf.PdfReader(io.BytesIO(data))
        return '\n'.join(page.extract_text() or '' for page in reader.pages)
    if ext == 'docx':
        import io, docx
        doc = docx.Document(io.BytesIO(data))
        return '\n'.join(p.text for p in doc.paragraphs)
    if ext == 'doc':
        import subprocess, tempfile, os
        with tempfile.NamedTemporaryFile(suffix='.doc', delete=False) as tf:
            tf.write(data); tf_path = tf.name
        try:
            r = subprocess.run(['antiword', tf_path], capture_output=True, text=True, timeout=15)
            return r.stdout if r.returncode == 0 else data.decode('utf-8', errors='replace')
        except FileNotFoundError:
            return data.decode('utf-8', errors='replace')
        finally:
            os.unlink(tf_path)
    if ext in ('xlsx', 'xls'):
        import io, openpyxl
        wb = openpyxl.load_workbook(io.BytesIO(data), data_only=True)
        rows = []
        for ws in wb.worksheets:
            for row in ws.iter_rows(values_only=True):
                line = '\t'.join('' if v is None else str(v) for v in row)
                if line.strip():
                    rows.append(line)
        return '\n'.join(rows)
    return data.decode('utf-8', errors='replace')


# ─── Telegram document ingestion ─────────────────────────────────────────────

def ingest_tg_document(token: str, file_id: str, fname: str, agent: str, chat_id: int):
    """Download a Telegram document, ingest into RAG /index API, reply result."""
    try:
        # Step 1: resolve file path via getFile
        r = tg_api(token, "getFile", {"file_id": file_id})
        file_path = r["result"]["file_path"]

        # Step 2: download raw content
        url = f"https://api.telegram.org/file/bot{token}/{file_path}"
        req = urllib.request.Request(url)
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read()
        content = extract_text_from_bytes(raw, fname)

        # Step 3: POST to RAG /index
        ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
        doc_id = f"tg_{agent}_{ts}_{fname}"
        payload = {
            "id": doc_id,
            "content": content,
            "metadata": {"source": "telegram", "filename": fname, "agent": agent, "ts": ts},
            "source": fname,
        }
        req2 = urllib.request.Request(
            "http://localhost:8000/index",
            data=json.dumps(payload, ensure_ascii=False).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req2, timeout=60) as resp2:
            pass  # 200 OK

        send_telegram(
            f"✅ *{fname}* berhasil di-ingest ke RAG!\n`id: {doc_id}`",
            agent=agent, chat_id=chat_id,
        )
        log.info(f"RAG ingest ok: {fname} → {doc_id}")
    except Exception as e:
        log.error(f"ingest_tg_document error ({fname}): {e}")
        send_telegram(f"❌ Gagal ingest `{fname}`: {str(e)[:200]}", agent=agent, chat_id=chat_id)

def poll_bot(agent: str, token: str):
    """Long-poll getUpdates for one bot, dispatch DMs to the agent."""
    offset_file = OPENCLAW_DIR / f"tg_offset_{agent}.txt"
    offset = int(offset_file.read_text()) if offset_file.exists() else 0

    # Clear any existing webhook so polling works
    try:
        tg_api(token, "deleteWebhook", {"drop_pending_updates": False})
        log.info(f"polling start → agent={agent}")
    except Exception as e:
        log.warning(f"deleteWebhook failed for {agent}: {e}")

    while True:
        try:
            result = tg_api(token, "getUpdates", {
                "offset": offset,
                "timeout": 25,
                "allowed_updates": ["message"],
            }, timeout=35)
            updates = result.get("result", [])
            for update in updates:
                offset = update["update_id"] + 1
                msg = update.get("message")
                if not msg:
                    continue
                chat_id = msg.get("chat", {}).get("id")
                text    = (msg.get("text") or "").strip()
                doc     = msg.get("document")
                uname   = msg.get("from", {}).get("username", "?")

                if not chat_id:
                    continue

                # Security: only respond to allowlisted chat_id
                if chat_id != TG_CHAT_ID:
                    log.warning(f"blocked unknown chat_id={chat_id} on {agent} bot")
                    continue

                # ── Document / file upload ────────────────────────────────
                if doc and not text:
                    fname = doc.get("file_name", "upload.txt")
                    mime  = doc.get("mime_type", "")
                    fid   = doc.get("file_id", "")
                    _SUPPORTED = {"txt","pdf","doc","docx","xls","xlsx","csv","md"}
                    _ext = fname.rsplit(".",1)[-1].lower() if "." in fname else ""
                    if _ext in _SUPPORTED or "text" in mime:
                        log.info(f"tg_doc → agent={agent} from=@{uname} file={fname}")
                        t = threading.Thread(
                            target=ingest_tg_document,
                            args=(token, fid, fname, agent, chat_id),
                            daemon=True,
                        )
                        t.start()
                    else:
                        send_telegram(
                            f"❌ Format tidak didukung: `{fname}`\nFormat OK: txt, pdf, doc, docx, xls, xlsx, csv, md",
                            agent=agent, chat_id=chat_id,
                        )
                    continue

                if not text:
                    continue

                log.info(f"tg_dm → agent={agent} from=@{uname} text={text[:60]}")

                full_msg = text
                mem = load_recent_memories(agent)
                if mem:
                    full_msg = mem + text

                t = threading.Thread(
                    target=run_agent_background,
                    args=(agent, full_msg, "", chat_id)
                )
                t.daemon = True
                t.start()

            if updates:
                offset_file.write_text(str(offset))
        except Exception as e:
            log.warning(f"poll error agent={agent}: {e}")
            import time; time.sleep(5)



def compact_scheduler():
    """Run every 15 minutes (:00/:15/:30/:45), or urgently if any agent exceeds 70% context fill.
    After an urgent compact, that agent has a 10-minute cooldown before it can trigger urgent again.
    """
    import time
    # All 4 agents: routine heartbeats are ephemeral (auto-deleted), but each agent
    # also has a persistent dispatcher-{agent} session for non-routine dev/kanban work
    # that needs compacting when it grows large.
    COMPACT_AGENTS  = ["main", "elsa", "ditesh", "newton"]
    URGENT_PCT      = 85    # trigger early compact if any agent reaches this threshold
    URGENT_COOLDOWN = 1800  # seconds (30 min) before the same agent can urgent-trigger again

    last_urgent: dict = {}  # agent → epoch seconds of last urgent fire

    while True:
        now = datetime.now(timezone.utc)
        # Next 15-min boundary (:00, :15, :30, :45)
        next_quarter  = ((now.minute // 15) + 1) * 15
        wait_sec      = (next_quarter - now.minute) * 60 - now.second
        if wait_sec <= 0:
            wait_sec = 15 * 60  # safety fallback

        # Poll every 60 seconds while waiting — break early if any agent hits URGENT_PCT
        slept         = 0
        urgent_agent  = None
        urgent_pct    = 0
        while slept < wait_sec:
            chunk = min(60, wait_sec - slept)
            time.sleep(chunk)
            slept += chunk
            now_ts = datetime.now(timezone.utc).timestamp()
            for ag in COMPACT_AGENTS:
                # Skip if this agent is still within its cooldown window
                since_last = now_ts - last_urgent.get(ag, 0)
                if since_last < URGENT_COOLDOWN:
                    continue
                sessions = get_sessions(ag)
                if not sessions:
                    continue
                total_bytes = sum(s.stat().st_size for s in sessions)
                pct = min(100, round(total_bytes / COMPACT_THRESH * 100))
                if pct >= URGENT_PCT:
                    log.warning(f"compact_scheduler: {ag} at {pct}% >= {URGENT_PCT}% → urgent compact")
                    urgent_agent = ag
                    urgent_pct   = pct
                    break
            if urgent_agent:
                break

        # When urgent: use a lower effective threshold so do_compact actually fires
        urgent_effective = int(COMPACT_THRESH * URGENT_PCT / 100) if urgent_agent else None

        results = []
        for ag in COMPACT_AGENTS:
            try:
                # Pass lower threshold only for the agent that triggered the urgent
                thresh = urgent_effective if (urgent_agent and ag == urgent_agent) else None
                res = do_compact(ag, effective_thresh=thresh)
                n   = len(res.get("compacted", []))
                results.append(f"{ag.upper()}: {n} compacted" if n else f"{ag.upper()}: no-op")
            except Exception as e:
                results.append(f"{ag.upper()}: ERR {e}")

        # Record cooldown timestamp for the urgent agent
        if urgent_agent:
            last_urgent[urgent_agent] = datetime.now(timezone.utc).timestamp()

        # Notify ditesh via Telegram
        trigger_label = f"urgent({urgent_agent}@{urgent_pct}%)" if urgent_agent else ":15"
        ditesh_token  = TG_AGENTS.get("ditesh")
        if ditesh_token:
            summary = " | ".join(results)
            tg_api(ditesh_token, "sendMessage", {
                "chat_id": TG_CHAT_ID,
                "text": f"[DITESH] Compact ({trigger_label}) — {summary}"
            })
        log.info(f"compact_scheduler done [{trigger_label}]: {results}")

        # Housekeeping: clean up stale gateway sessions and old archives
        for ag in COMPACT_AGENTS:
            try:
                stale_n = cleanup_stale_sessions(ag)
                arch_n  = cleanup_archives(ag)
                if stale_n or arch_n:
                    log.info(f"cleanup {ag}: {stale_n} stale deleted, {arch_n} archives purged")
            except Exception as e:
                log.error(f"cleanup error {ag}: {e}")


# ─── Heartbeat Scheduler ────────────────────────────────────────────────────

def parse_frontmatter(text: str) -> tuple:
    """Parse simple YAML frontmatter from ---delimited text. Returns (meta_dict, body_str)."""
    if not text.startswith("---"):
        return {}, text
    parts = text.split("---", 2)
    if len(parts) < 3:
        return {}, text
    meta = {}
    for line in parts[1].strip().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if ":" in line:
            key, val = line.split(":", 1)
            key = key.strip()
            val = val.strip().strip('"').strip("'")
            if val.lower() in ("true", "yes"):
                val = True
            elif val.lower() in ("false", "no"):
                val = False
            else:
                try:
                    val = int(val)
                except ValueError:
                    try:
                        val = float(val)
                    except ValueError:
                        pass
            meta[key] = val
    return meta, parts[2].strip()


def heartbeat_scheduler():
    """Read heartbeat.md per agent, fire prompts at configured intervals.
    Each heartbeat.md has YAML frontmatter with:
      interval_minutes: N  (default 60)
      offset_minutes: M    (fire when minute-of-day % interval == offset)
      inject_memory: true/false
      ritual_label: "display name"
    Body is the prompt text.
    """
    import time

    def load_schedules():
        schedules = []
        for agent in sorted(ALLOWED_AGENTS):
            hb_path = OPENCLAW_DIR / "agents" / agent / "agent" / "heartbeat.md"
            if not hb_path.exists():
                continue
            meta, prompt = parse_frontmatter(hb_path.read_text())
            if not prompt:
                continue
            schedules.append({
                "agent":           agent,
                "interval":        meta.get("interval_minutes", 60),
                "offset":          meta.get("offset_minutes", 0),
                "prompt":          prompt,
                "ritual":          meta.get("ritual_label", f"heartbeat-{agent}"),
                "inject_memory":   meta.get("inject_memory", True),
                "use_rag_context": meta.get("use_rag_context", False),
                "ephemeral":       meta.get("ephemeral", False),
                "last_cycle":      None,
            })
        return schedules

    schedules = load_schedules()
    log.info(f"heartbeat_scheduler loaded {len(schedules)} schedules: "
             + ", ".join(f"{s['agent']}(every {s['interval']}m @:{s['offset']:02d})" for s in schedules))

    reload_counter = 0
    while True:
        now = datetime.now(timezone.utc)
        minutes_since_midnight = now.hour * 60 + now.minute

        for sched in schedules:
            interval = sched["interval"]
            offset   = sched["offset"]

            # Check if current minute matches: (minutes_since_midnight - offset) % interval == 0
            if (minutes_since_midnight - offset) % interval != 0:
                continue

            # Deduplicate: don't fire twice in the same cycle minute
            cycle_key = f"{now.strftime('%Y%m%d')}_{minutes_since_midnight}"
            if sched["last_cycle"] == cycle_key:
                continue
            sched["last_cycle"] = cycle_key

            agent  = sched["agent"]
            prompt = sched["prompt"]

            if sched["inject_memory"]:
                mem = load_recent_memories(agent)
                if mem:
                    prompt = mem + prompt
            elif sched.get("use_rag_context"):
                # Lightweight RAG search: query with first 300 chars of prompt as hint
                rag_ctx = load_rag_context(agent, prompt[:300])
                if rag_ctx:
                    prompt = rag_ctx + prompt

            log.info(f"heartbeat fire → agent={agent} ritual={sched['ritual']} ephemeral={sched.get('ephemeral', False)}")
            t = threading.Thread(
                target=run_agent_background,
                args=(agent, prompt, sched["ritual"]),
                kwargs={"ephemeral": sched.get("ephemeral", False)},
                daemon=True,
            )
            t.start()

        # Sleep until next minute boundary (+2s buffer to avoid double-fire)
        now2 = datetime.now(timezone.utc)
        sleep_sec = 62 - now2.second
        time.sleep(max(sleep_sec, 5))

        # Reload heartbeat.md every 60 cycles (~1 hour) to pick up changes
        reload_counter += 1
        if reload_counter >= 60:
            reload_counter = 0
            schedules = load_schedules()
            log.info(f"heartbeat_scheduler reloaded {len(schedules)} schedules")


def start_polling():
    """Start polling only for bots with a UNIQUE token not managed by openclaw-gateway.
    Main + ELSA bots are handled by openclaw-gateway; only ditesh has its own polling."""
    gateway_tokens = {TG_AGENTS["main"], TG_AGENTS["elsa"], TG_AGENTS["ditesh"]}  # gateway owns these
    seen = set()
    for agent, token in TG_AGENTS.items():
        if token in seen or token in gateway_tokens:
            continue  # skip gateway-managed bots and duplicates
        seen.add(token)
        t = threading.Thread(target=poll_bot, args=(agent, token), daemon=True)
        t.start()


def main():
    port   = int(os.environ.get("DISPATCHER_PORT", 19191))
    server = HTTPServer(("0.0.0.0", port), Handler)
    signal.signal(signal.SIGTERM, lambda *_: (server.server_close(), sys.exit(0)))
    log.info(f"Agent Dispatcher v4 listening on {port} | TG chat_id={TG_CHAT_ID} | agents={list(TG_AGENTS.keys())}")
    # Initialise kanban SQLite DB (creates table + seeds if empty)
    init_kanban_db()
    # Start compact scheduler (runs at :15 past each hour)
    t_compact = threading.Thread(target=compact_scheduler, daemon=True)
    t_compact.start()
    # Start heartbeat scheduler (reads heartbeat.md per-agent)
    t_heartbeat = threading.Thread(target=heartbeat_scheduler, daemon=True)
    t_heartbeat.start()
    # Start Telegram polling threads
    start_polling()
    server.serve_forever()


if __name__ == "__main__":
    main()
