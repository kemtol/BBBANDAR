# KNOWLEDGE CENTER — VPS OPENCLAW RETROSPECTIVE

## VPS Box credential
ssh: ssh root@213.199.49.18
password:  3Desember1986

---

## 🖥️ VPS Overview
- **OS**: Linux (vmi3141055)
- **Purpose**: Brain server untuk project MONEYBOX (Hedge Fund in a Box)
- **Repo**: `~/moneybox/` — algorithmic multi-agent trading system
- **Stack**: Python, ZeroMQ, PostgreSQL, Redis, Kafka, TimescaleDB, Qdrant, Docker, OpenClaw

---

## 🦞 OpenClaw Setup (Mar 11, 2026)

### Problems yang ditemukan & di-fix:
| # | Problem | Root Cause | Fix |
|---|---------|-----------|-----|
| 1 | `models.providers.ollama.models: Invalid input` | Field `models` tidak ada di config ollama | Tambah `"models": []` ke ollama provider di `openclaw.json` |
| 2 | `HTTP 401 invalid x-api-key` | `auth-profiles.json` punya key lama/korup (`"echo"`), `.bashrc` punya early-exit untuk non-interactive shell | Recreate kedua `auth-profiles.json` dengan key valid, tambah ke `/etc/environment` |
| 3 | Anthropic provider tidak dikenali | Field `api` harus `"anthropic-messages"` bukan `"anthropic"`, perlu `baseUrl` | Tambah provider anthropic yang benar ke `openclaw.json` |
| 4 | Stale gateway process | `openclaw-gateway` jalan di background dengan credentials lama ter-cache | Kill PID lama, gateway auto-respawn dengan config baru |
| 5 | Telegram tidak bisa | Tidak ada `channels.telegram` di config, `botToken` tidak tersimpan | Tambah blok `channels.telegram` + bind agent `main` |
| 6 | `config.yaml` placeholder | `api_key: "API_KEY_KAMU"` belum diisi | Ganti ke `env:ANTHROPIC_API_KEY` |

### File yang dimodifikasi:
- `~/.openclaw/openclaw.json` — providers, channels, agents, models
- `~/.openclaw/agents/main/auth-profiles.json` — API key anthropic
- `~/.openclaw/agents/main/agent/auth-profiles.json` — API key anthropic + deepseek
- `~/.openclaw/agents/main/agent/soul.md` — identitas agent (fix DeepSeek identity confusion)
- `~/.openclaw/config.yaml` — api_key reference
- `/etc/environment` — ANTHROPIC_API_KEY persisten untuk non-interactive shell

---

## 🤖 Agents

| Agent  | Model (Primary)               | Fallback                             | Alias    | Telegram Bot    | Workspace | Use Case |
|--------|-------------------------------|--------------------------------------|----------|-----------------|-----------|----------|
| `main` | `deepseek/deepseek-chat` (V3) | `anthropic/claude-3-haiku-20240307`  | deepseek | @Qqquanta_bot   | `~/.openclaw/workspace` (shared) | PMO — chat, tidy-up, koordinasi |
| `ditesh`| `deepseek/deepseek-chat` (V3) | `anthropic/claude-sonnet-4-20250514` | deepseek | @ditesh_bot     | `~/.openclaw/agents/ditesh/workspace` | IT Support — infra & Docker |
| `newton`| `anthropic/claude-sonnet-4-20250514` | `deepseek/deepseek-reasoner` (R1) | sonnet | @Qqquanta_bot (belum punya bot sendiri) | `~/.openclaw/workspace` (shared) | Quant research subagent |
| `elsa`| `deepseek/deepseek-chat` (V3) | `anthropic/claude-3-haiku-20240307`  | deepseek | @elsa_oc_bot    | `~/.openclaw/agents/elsa/workspace` | Librarian — RAG data curator |

### Model pricing (per 1M token):
- DeepSeek V3 (chat): $0.27 input / $1.10 output
- DeepSeek R1 (reasoning): $0.55 input / $2.19 output
- Haiku (fallback chat): $0.25 input / $1.25 output
- Sonnet 4 (fallback code): $3.00 input / $15.00 output

### Models accessible:
- ✅ `deepseek/deepseek-chat` (DeepSeek V3) — via API key `sk-100533f374f44ba89cf80667e4dbddc9`
- ✅ `deepseek/deepseek-reasoner` (DeepSeek R1) — via alias `r1`
- ✅ `anthropic/claude-3-haiku-20240307` — fallback main, alias `haiku`
- ✅ `anthropic/claude-sonnet-4-20250514` — alias `sonnet`

> **Fix identity confusion**: DeepSeek-V3 punya kebiasaan mengklaim dirinya "Claude 3 Haiku" karena training data. Solved dengan menambah `soul.md` di `~/.openclaw/agents/main/agent/soul.md` yang memaksa identitas "Master, powered by DeepSeek-V3". Setelah fix, model menjawab dengan benar.

---

## 📱 Telegram

| Agent  | Bot         | Token (prefix)              | Account Key | Status |
|--------|-------------|-----------------------------|-----------  |--------|
| main   | @Qqquanta_bot | `8684914523:AAFmnEO...`   | `default`   | ✅ |
| elsa   | @elsa_oc_bot  | `8639143226:AAGn-uw...`   | `elsa`      | ✅ |
| ditesh | @ditesh_bot   | `8653047406:AAEqKdk...`   | `ditesh`    | ✅ |
| newton | (belum punya bot sendiri — fallback ke main) | — | NOT SET | ⚠️ |

- **allowFrom**: `7980136995` (Telegram user ID pemilik)
- **dmPolicy**: `allowlist`
- **Gateway**: user-level systemd (`systemctl --user restart openclaw-gateway`, requires `XDG_RUNTIME_DIR=/run/user/0`)
- **Linger**: `yes` — gateway auto-start on boot tanpa SSH login

> ⚠️ Setiap bot baru harus di-`/start` dulu dari Telegram sebelum bisa mengirim pesan ke user.

---

## 🔑 Env Vars

| Var | Lokasi | Value |
|-----|--------|-------|
| `ANTHROPIC_API_KEY` | `/etc/environment` + `~/.bashrc` | `sk-ant-api03-oT6J...IJLG5wAA` |
| `DEEPSEEK_API_KEY` | `~/.openclaw/agents/main/agent/models.json` | `sk-100533...dbddc9` |

> ⚠️ `.bashrc` punya `[ -z "$PS1" ] && return` — env var dari `.bashrc` tidak load untuk non-interactive shell. Gunakan `/etc/environment` sebagai sumber kebenaran.

---

## 📦 MONEYBOX Project

> Sebelumnya bernama **FIRMA** — di-rename Mar 11, 2026 (35 file + folder)

### Arsitektur:
```
VPS Linux (Brain) ←─── ZeroMQ TCP ───→ VPS Windows (Muscle)
Port 5555 (tick stream PUB-SUB)         MetaTrader 5
Port 5556 (orders REQ-REP)              MQL5 EA Bridge
Port 5557 (account state REQ-REP)
```

### Phase status:
| Phase | Status | Deskripsi |
|-------|--------|-----------|
| Phase 1 | 🔴 In Development | ZeroMQ Execution Bridge (Linux ↔ MT5) |
| Phase 2 | ⏳ Planned | Agent Army + Docker |
| Phase 3 | ⏳ Planned | Quant Research Loop |

### Agents (Phase 2) — 6 Karyawan:

| # | Nama | Role | Instrumen | Persona |
|---|------|------|-----------|---------|
| 1 | **ARIA** | Director / CIO | — | Harvard MBA, ex-Goldman Sachs |
| 2 | **FELIX** | Trader Fiat | EURUSD, GBPUSD | Self-taught, agresif & disiplin |
| 3 | **MIDAS** | Trader Gold | XAUUSD | Macro-first, sabar & presisi |
| 4 | **AEGIS** | Risk Manager | Semua | Military background, zero tolerance |
| 5 | **ATLAS** | Portfolio Manager | Semua | Actuary, portfolio-level thinker |
| 6 | **NEWTON** | Quant Researcher | R&D | PhD Physics, statistical rigor |
| 7 | **ELSA** | Librarian / RAG Curator | R&D | PhD Information Science MIT, data obsessive |

#### Gugus Tugas Detail:

**ARIA — Director**
- Koordinasi semua agent via Redis pub/sub
- Aggregasi sinyal dari FELIX & MIDAS → forward ke AEGIS untuk validasi
- Route approved orders ke ZeroMQ execution bridge → MT5
- Kirim daily performance report ke Kemal via Telegram
- Deploy strategi baru hasil riset NEWTON ke trader
- *Rule: tidak pernah kirim order ke execution tanpa AEGIS approval*

**FELIX — Trader Fiat**
- Monitor EURUSD & GBPUSD (sesi London + NY only, max spread 1.5 pip)
- Generate sinyal lengkap: direction, lot, SL, TP + confidence score (0.0–1.0)
- Support 4 strategy type: `momentum_burst`, `breakout`, `mean_reversion`, `carry_scalp`
- *Rule: semua sinyal lewat ARIA → AEGIS, tidak pernah langsung ke eksekusi*

**MIDAS — Trader Gold**
- Monitor XAUUSD dengan filter makro: DXY, inflasi, geopolitik
- Confidence score weighted by macro alignment (bukan hanya teknikal)
- Session filter: London open dan NY saja
- *Rule: tidak trading emas berlawanan tren makro dominan, seberapa pun kuat setup teknikalnya*

**AEGIS — Risk Manager (Gatekeeper)**
- Validasi SEMUA order sebelum eksekusi — tidak bisa di-bypass siapapun termasuk ARIA
- Hard rules: max 1% equity/trade · max 5% daily drawdown · max 2 lot USD-long simultan · gold+JPY tidak boleh opposite direction bersamaan
- Circuit breaker: DD 4% → alert Kemal; DD 5% → halt semua order, tunggu manual override
- Setiap keputusan (approve/reject) dicatat permanen ke PostgreSQL

**ATLAS — Portfolio Manager**
- Hitung optimal lot size berdasarkan equity saat ini (dynamic, bukan fixed)
- Track korelasi antar posisi: EURUSD + GBPUSD = 1 doubled bet, bukan 2 trade terpisah
- Daily P&L per instrumen & strategi, win rate & profit factor (rolling 30 hari)
- Kalau profit factor strategi < 1.2 dalam 30 hari → flag ke NEWTON untuk di-review
- *Rule: tidak pernah approve concentration risk*

**ELSA — Librarian** *(full spec: `~/moneybox/phase2/agents/librarian/spawn.md`)*
- Pipeline: **SCRAPE → CLEAN → CHUNK → EMBED → STORE**
- Sumber data: IDX disclosures, Reuters/Bloomberg RSS, economic calendar (FOMC, BI Rate), Stockbit sentimen, research papers
- Kelola **8 koleksi Qdrant**: `news_global`, `news_indonesia`, `economic_calendar`, `idx_disclosures`, `macro_data`, `research_papers`, `strategy_corpus`, `sentiment_feed`
- Deduplication via SHA-256 hash + Redis cache, metadata tracking di PostgreSQL `scrape_log`
- **Activity Schedule**: 1min heartbeat, 15min news, 30min sentiment, 1h calendar, 07:00 WIB daily IDX+macro, Senin weekly papers
- **Reports**: Daily Digest ke ARIA (08:00), Source Health Alert, Coverage Alert, NEWTON Request Log
- *Rule: tidak pernah kirim sinyal trading — hanya data dan pengetahuan*

**NEWTON — Quant Researcher** *(full spec: `~/moneybox/phase2/agents/quant-researcher/spawn.md`)*
- Loop 3 tahap: **Strategy Hunter → Backtest Engine → Fine Tuner**
- Backtest pakai `vectorbt`, final validation pakai MT5 Strategy Tester via bridge
- Min threshold lolos: Win Rate ≥55% · Profit Factor ≥1.5 · Sharpe ≥1.2 · Max DD ≤15% · ≥500 trades
- Fine-tuning pakai **Bayesian optimization (Optuna)** + walk-forward validation wajib
- Kelola Approved Strategy Registry di PostgreSQL dengan versioning (v1, v2, v3...)
- *Rule: backtest saja bukan bukti — walk-forward + stress test wajib sebelum deploy*
- **Activity Schedule**: Monthly review, Weekly fine-tune + audit, Daily hunt + backtest, Hourly health pulse, 15min regime recalc, 1min heartbeat
- **Reports**: Daily digest, Live vs backtest deviation, Weekly audit, Monthly review, Strategy approval, Regime change alert
- **Interactions**: ARIA (assignments/reports), FELIX/MIDAS (strategy deploy), AEGIS (risk projections), ATLAS (correlation/flags)
- **Tools**: PostgreSQL (registry), Redis (pub/sub + cache), Qdrant (strategy embeddings), vectorbt, Optuna

#### Alur Kerja:
```
FELIX/MIDAS ──→ sinyal ──→ ARIA ──→ AEGIS (validasi) ──→ ZeroMQ ──→ MT5
                              ↑            ↑
                         ATLAS (allocation check)
                              ↑
                         NEWTON (strategy supply)
                              ↑
                         ELSA (data & corpus supply)
```

### Docker — Naming Convention
```
Core Infra / Shared Tools  →  plain name    (postgres, redis, qdrant, n8n, grafana)
Agents                     →  agent_*       (agent_director, agent_trader_fiat, ...)
```

### Docker containers (target setelah `docker-compose up -d`):

**Core Infrastructure:**
| Container | Image | Port |
|-----------|-------|------|
| `postgres` | postgres:16-alpine | 5432 |
| `redis` | redis:7-alpine | 6379 |

**Shared Tools:**
| Container | Image | Port |
|-----------|-------|------|
| `qdrant` | qdrant/qdrant:latest | 6333-6334 |
| `n8n` | n8nio/n8n:latest | 5678 |
| `grafana` | grafana/grafana:latest | 3000 |
| ~~`plane`~~ | ~~—~~ | ~~DEPRECATED — uninstalled Mar 12, 2026~~ |

**Agents:**
| Container | Agent | Port |
|-----------|-------|------|
| `agent_director` | ARIA | 8081 |
| `agent_trader_fiat` | FELIX | 8082 |
| `agent_trader_gold` | MIDAS | 8083 |
| `agent_risk_manager` | AEGIS | 8084 |
| `agent_portfolio_manager` | ATLAS | 8085 |
| `agent_quant_researcher` | NEWTON | 8086 |
| `agent_librarian` | ELSA | 8087 |

> ⚠️ Container yang sedang jalan masih bernama `firma_*` dari sebelum rename. Perlu `docker-compose down && docker-compose up -d` untuk apply nama baru.

### ⚠️ TODOs setelah sesi ini:
- [ ] `cd ~/moneybox && docker-compose down && docker-compose up -d` untuk apply nama baru
- [ ] Fix agent containers yang restarting: cek `docker logs agent_trader_gold` & `docker logs agent_risk_manager`
- [x] ~~Buat `./infra/plane/docker-compose.yml`~~ → **Diganti PostgreSQL PM** (Mar 12, 2026)
- [ ] Rename GitHub repo dari `firma` → `moneybox` (Settings → Repository name)
- [ ] Aktivasi n8n workflow 07 (Compact_Main) dan 08 (Compact_Elsa)
- [ ] Verifikasi deployment dispatcher v3 di VPS

---

## 📋 Project Management — PostgreSQL (Pengganti Plane)

> Plane di-uninstall Mar 12, 2026. PM sekarang pakai tabel langsung di PostgreSQL `firma`.

### Schema

| Tabel / View | Fungsi |
|---|---|
| `pm_tasks` | Task tracker — code, title, status, priority, phase, assigned_to |
| `pm_milestones` | Milestone M-001/M-002/M-003 (Phase 1/2/3) |
| `pm_task_milestone` | Relasi task ↔ milestone |
| `pm_logs` | Audit log setiap aksi agent |
| `pm_open_tasks` | View: semua task yang belum done/cancelled, urut prioritas |

### Status Values
- **Task**: `todo` → `in_progress` → `done` / `blocked` / `cancelled`
- **Milestone**: `pending` → `active` → `completed`
- **Priority**: `low` | `medium` | `high` | `critical`

### Cara Akses
```bash
docker exec firma_postgres psql -U firma -d firma -c "SELECT code,title,status,priority,assigned_to FROM pm_open_tasks;"
```

### Credentials
- Container: `firma_postgres`
- User: `firma` / Pass: `changeme` / DB: `firma`

### TOOLS.md per Agent
Tiap agent punya `/agent/TOOLS.md` yang berisi SQL snippets siap pakai:

| Agent | Path di VPS | Berisi |
|---|---|---|
| main (Albert) | `~/.openclaw/agents/main/agent/TOOLS.md` | PM + Dispatcher (main/elsa/ditesh/newton) + n8n + Redis + Qdrant + RAG |
| elsa | `~/.openclaw/agents/elsa/agent/TOOLS.md` | PM + Qdrant + Redis + Pipeline Logs + RAG API |
| ditesh | `~/.openclaw/agents/ditesh/agent/TOOLS.md` | PM + Docker + System Health + Systemd + Network |
| newton | `~/.openclaw/agents/newton/agent/TOOLS.md` | PM + Strategy Registry + Qdrant + Redis |

---

## �️ n8n Ritual Prompts

> Prompt yang dikirim oleh dispatcher ke masing-masing agent sesuai jadwal.
> Format: `POST 172.17.0.1:19191/agent` → `{"agent": "...", "message": "..."}`
> Semua cron dalam UTC. WIB = UTC+7.

---

### 01 — Hourly Tidy-Up (Main Agent, setiap jam :00 UTC)

**Agent**: `main` | **Model**: DeepSeek V3 | **Cron**: `0 * * * *`
**Karakter**: Heartbeat singkat — bukan laporan, cukup satu kalimat konfirmasi. Kalau ada yang aneh, baru sebutkan.

```
[SYSTEM HEARTBEAT] Jam berapa sekarang? Kamu baik-baik saja? Kalau ada sesuatu yang menggantung di memori atau ada task yang mestinya sudah selesai tapi belum, sebutkan sekarang. Kalau tidak ada, cukup balas: "Sistem normal."
```

---

### 02 — Hourly Pipeline Check (ELSA Agent, setiap jam :30 UTC)

**Agent**: `elsa` | **Model**: DeepSeek V3 | **Cron**: `30 * * * *`
**Karakter**: ELSA adalah data librarian yang obsesif dengan akurasi. Prompt-nya technical, output berupa tabel singkat atau JSON-like — bukan narasi.

```
ELSA, lakukan pipeline audit sekarang. Jawab hanya dalam format ini — tidak perlu kalimat panjang:

SCRAPER   : [OK/STALE/ERROR] — terakhir sukses berapa menit lalu?
QDRANT    : [OK/DEGRADED] — estimasi total docs terbaru?
BACKLOG   : [kosong / N item pending]
ANOMALI   : [tidak ada / sebutkan jika ada]

Kalau semua OK, cukup outputkan tabelnya saja. Kalau ada issue, tambahkan satu baris "ACTION:" berisi langkah yang kamu ambil.
```

---

### 03 — Morning Briefing (Main Agent, 07:30 WIB / 00:30 UTC)

**Agent**: `main` | **Model**: DeepSeek V3 | **Cron**: `30 0 * * *`
**Karakter**: Seperti seorang analis menyiapkan brief untuk eksekutif — dikurasi, langsung ke inti, tanpa basa-basi. Fokus: apa yang penting hari ini, bukan recap semalam.

```
Selamat pagi. Hari ini tanggal berapa, hari apa?

Saya butuh satu paragraf saja: apa yang paling perlu saya perhatikan hari ini? Bisa berupa deadline yang mendekat, pekerjaan yang setengah jalan, atau context penting dari sesi-sesi sebelumnya yang relevan untuk hari ini.

Setelah paragraf itu, tambahkan satu baris "FOKUS HARI INI:" dengan satu kalimat — satu hal paling krusial yang harus selesai hari ini.

Kirim juga ke Telegram.
```

---

### 04 — Daily Standup (Main Agent, 12:00 WIB / 05:00 UTC)

**Agent**: `main` | **Model**: DeepSeek V3 | **Cron**: `0 5 * * *`
**Karakter**: Engineering standup — kering, padat, tidak ada basa-basi. Tiga pertanyaan klasik, jawaban pendek. Seperti stand-up 5 menit, bukan presentasi.

```
Standup tengah hari. Jawab tiga pertanyaan ini, masing-masing maksimal dua kalimat:

DONE    → Apa yang sudah selesai pagi ini?
DOING   → Apa yang sedang berjalan sekarang?
BLOCKED → Ada yang menghambat? (tulis "clear" kalau tidak ada)

Tidak perlu format cantik, tidak perlu emoji. Langsung jawab.
```

---

### 05 — Afternoon Checkpoint (Main Agent, 15:00 WIB / 08:00 UTC)

**Agent**: `main` | **Model**: DeepSeek V3 | **Cron**: `0 8 * * *`
**Karakter**: Pertanyaan yang agak tajam — bukan laporan, tapi pertanyaan yang memaksa evaluasi jujur. Apakah hari ini masih on track atau sudah melenceng?

```
Jujur: hari ini sudah sesuai rencana atau tidak?

Kalau iya, bilang kenapa. Kalau tidak, bilang di mana letak melencengnya dan apa yang akan kamu lakukan dari sekarang sampai malam untuk membuatnya lebih baik. Jawaban boleh satu paragraf pendek, atau bahkan satu kalimat.

Tidak perlu laporan lengkap. Saya hanya butuh assessment jujur dari kamu.
```

---

### 06 — Evening Wrap-up (Main Agent, 20:00 WIB / 13:00 UTC)

**Agent**: `main` | **Model**: DeepSeek V3 | **Cron**: `0 13 * * *`
**Karakter**: Bukan laporan — lebih seperti jurnal harian. Reflektif, personal, ditulis seperti catatan penutup hari. Satu hal yang berhasil, satu yang gagal, satu yang dipelajari, dan kalimat penutup untuk besok.

```
Hari ini sudah selesai. Tulis catatan penutup hari ini — seperti jurnal, bukan laporan. 

Struktur bebas, tapi harus ada:
- satu hal yang berjalan baik hari ini
- satu hal yang tidak sesuai harapan (atau tidak selesai)
- satu pelajaran atau insight yang akan dibawa ke besok
- satu kalimat terakhir: "Besok, saya akan fokus pada ___."

Kirim juga ke Telegram sebagai end-of-day note.
```

---

### Update Prompt — Cara Ganti Prompt di n8n

Prompt disimpan di node **HTTP Request** dalam setiap workflow.
Cara update tanpa touch database:

1. Login ke n8n UI: `http://213.199.49.18:5678` (admin / password123)
2. Buka workflow yang ingin diubah
3. Klik node **HTTP Request**
4. Edit field `Body` → field `message` → ganti prompt sesuai kebutuhan
5. Save → workflow langsung pakai prompt baru

Atau via API (kalau sudah ada API key JWT yang valid):
```bash
# Export current workflow
curl -u admin:password123 http://213.199.49.18:5678/api/v1/workflows/{ID} > workflow.json

# Edit message field di JSON, lalu import kembali
docker exec n8n n8n import:workflow --input=/tmp/workflow.json --userId=6991c0fd-779e-41bb-af59-328151b3ae87
```

---
## 🔄 Arsitektur Ritual + Compaction (v3 — Maret 2026)

### Alur Lengkap

```
n8n cron trigger (scheduled)
      ↓
POST http://172.17.0.1:19191/agent
  {"agent": "main", "message": "...", "ritual": "03 Morning Briefing", "inject_memory": true}
      ↓
Agent Dispatcher v3 (port 19191)
  - inject 3 memory snapshots terbaru ke awal message (jika ada)
  - spawn background thread
  - return 202 langsung ke n8n (n8n workflow selesai)
      ↓ (background)
openclaw agent --agent main --message "[MEMORY...]\n[PROMPT]" --no-color
      ↓
response ditangkap dispatcher
      ↓
Telegram Bot API → chat_id 7980136995
  [MAIN] 03 Morning Briefing
  <response text>
```

### Jadwal Ritual (UTC)

| Workflow | Cron (UTC) | Agent | Ritual Label |
|---|---|---|---|
| 01_Hourly_Tidy_Up_Main | `0 * * * *` | main | 01 Hourly Tidy-Up |
| 02_Hourly_Pipeline_Elsa | `30 * * * *` | elsa | 02 Pipeline ELSA |
| 03_Morning_Briefing | `30 0 * * *` | main | 03 Morning Briefing |
| 04_Daily_Standup | `0 5 * * *` | main | 04 Daily Standup |
| 05_Afternoon_Checkpoint | `0 8 * * *` | main | 05 Afternoon Checkpoint |
| 06_Evening_Wrapup | `0 13 * * *` | main | 06 Evening Wrap-up |
| ~~07_Compact_Main~~ | ~~`15 * * * *`~~ | ~~—~~ | ~~compact main session~~ → dipindah ke dispatcher internal |
| ~~08_Compact_Elsa~~ | ~~`45 * * * *`~~ | ~~—~~ | ~~compact elsa session~~ → dipindah ke dispatcher internal |

### Memory Loop (Iterate & Get Smarter)

```
Tiap jam:                        Tiap ritual:
07_Compact_Main (:15)            inject_memory: true
08_Compact_Elsa (:45)            → inject 3 x memory snapshot
      ↓                                  ↓
POST /compact                    agent punya konteks history
      ↓
session .jsonl > 200KB?
  YES → tail diambil → LLM buat JSON snapshot:
    {agent, timestamp, context, decisions[], in_progress[], insights[], keywords[]}
    → simpan: ~/.openclaw/agents/{agent}/memories/YYYYMMDD_HHMMSS.json
- session lama diarsip: _archived_YYYYMMDD_HHMMSS_{uuid}.jsonl  ← nama selalu bersih (tidak numpuk prefix)
    → Telegram notif: "[MAIN] 🗜️ Compacted 1 session(s) → memory saved"
  NO → skip
```

### Dispatcher v3 — Endpoints

| Endpoint | Method | Body | Response |
|---|---|---|---|
| `/agent` | POST | `{agent, message, ritual?, inject_memory?}` | 202 accepted |
| `/compact` | POST | `{agent}` | 200 + hasil compaction |

> ⚠️ **Status n8n (Mar 12, 2026)**: Semua ritual agent workflow (03-08) sudah DIHAPUS dari n8n.
> n8n sekarang hanya menjalankan 2 heart- buat hhalaman untuk cron.html jugabeat:
> - `01_Hourly_Tidy_Up_Main` (cron `:00`) → main agent
> - `02_Hourly_Pipeline_Elsa` (cron `:30`) → elsa agent
> **Compaction** sekarang diatur oleh dispatcher sendiri via `compact_scheduler()` thread — jalan tiap `:15`, hasilnya dinotif ke Ditesh via Telegram.

### Telegram Attachment Ingestion (Mar 12, 2026)

ELSA (dan semua bot) sekarang bisa menerima file `.txt` langsung dari Telegram:
1. User kirim file `.txt` ke bot ELSA di Telegram
2. Dispatcher deteksi `document` field di update
3. Download file via Telegram `getFile` API
4. POST ke RAG `/index` dengan schema `{id, content, metadata, source}`
5. Reply konfirmasi: `✅ filename.txt berhasil di-ingest ke RAG!`

Format yang didukung: `.txt` atau MIME `text/*`
Format lain: ditolak dengan pesan error.

```bash
# Test manual ingest via RAG API langsung
curl -s -X POST http://localhost:8000/index \
  -H "Content-Type: application/json" \
  -d '{"id":"test_001","content":"isi dokumen...","metadata":{"source":"manual"},"source":"test.txt"}'
``` 

- File: `/usr/local/bin/agent-dispatcher.py`
- Service: `systemctl status agent-dispatcher`
- Log: `journalctl -u agent-dispatcher -f`
- TG chat_id: `7980136995` (sama untuk semua agent)

> ⚠️ **Bug dispatcher yang sudah difix (Mar 12, 2026)**:
> 1. `get_sessions()` ikut compact file `_archived_*` → nama terus menumpuk → `[Errno 36] File name too long`
> 2. Fix: skip file dengan prefix `_archived_` + pakai `re.sub()` untuk strip prefix lama sebelum rename

| Agent | Bot Token |
|---|---|
| main / newton | `8684914523:AAFmnEODA5g4udOuZDCA0AjIrCnAZxiaTgs` |
| **elsa** | `8639143226:AAGn-uw7GDpAvmuQeqfpOE4sdrwGoHMdH2E` |
| **ditesh** | `8653047406:AAEqKdkkFe_3VkxoeSigkqQ8WfkrT27UHs8` |

⚠️ **PENTING**: Setiap bot baru harus di-`/start` dulu dari Telegram sebelum bisa mengirim pesan ke user.

### Cara Monitor via Telegram

Karena semua response dikirim ke Telegram, monitoring cukup dari HP:
- Setiap ritual → agent merespons di Telegram dengan label `[MAIN] 03 Morning Briefing`
- Tiap compaction → notif `[MAIN] 🗜️ Compacted 1 session(s)`
- Error → notif `[MAIN] ❌ Error: ...`
- Timeout → notif `[MAIN] ⚠️ Timeout setelah 120s`

Tidak perlu buka n8n UI untuk tahu apakah sistem jalan atau tidak.

---
## �🔧 Quick Commands

```bash
# SSH ke VPS
ssh root@213.199.49.18

# Cek status OpenClaw
openclaw doctor

# Chat via CLI (DeepSeek V3 — default)
openclaw agent --message "..."

# Chat via CLI (DeepSeek R1 — IT Support)
openclaw agent --agent ditesh --message "..."

# Chat via CLI (ELSA — librarian & RAG curator)
openclaw agent --agent elsa --message "..."

# Restart gateway (user-level systemd)
XDG_RUNTIME_DIR=/run/user/0 systemctl --user restart openclaw-gateway
XDG_RUNTIME_DIR=/run/user/0 systemctl --user status openclaw-gateway

# Legacy fallback jika systemd tidak jalan
pkill -f openclaw-gateway && sleep 2 && nohup openclaw-gateway > ~/.openclaw/gateway.log 2>&1 &

# Fix Albert stuck: hapus orphaned session pointer lalu restart gateway
python3 -c "
import json; path='~/.openclaw/agents/main/sessions/sessions.json'.replace('~', '/root')
d=json.load(open(path)); d.pop('agent:main:telegram:slash:7980136995', None)
json.dump(d, open(path,'w'), indent=2)"
pkill -f openclaw-gateway && sleep 2 && nohup openclaw-gateway > ~/.openclaw/gateway.log 2>&1 &

# Force compact agent session (bila lambat / session > 200KB)
curl -s -X POST http://localhost:19191/compact -H 'Content-Type: application/json' -d '{"agent":"elsa"}'

# Cek docker containers
docker ps

# Lihat logs agent
docker logs firma_director --tail 50

# Gateway CPU spike fix: cek siapa yang poll token
# Jika ada 409 Conflict di dispatcher logs → berarti token di-poll 2 kali
# Fix: hapus account dari openclaw.json dan restart gateway
python3 -c "
import json; p='/root/.openclaw/openclaw.json'; d=json.load(open(p))
accs = d['channels']['telegram']['accounts']
print('Accounts:', list(accs.keys()))
# accs.pop('nama_agent', None)  # uncomment untuk hapus
# json.dump(d, open(p,'w'), indent=2)"
systemctl --user restart openclaw-gateway

# Bersihkan session proliferation (bila agent punya banyak sesi aktif)
python3 -c "
from pathlib import Path; import shutil
agent = 'elsa'  # ganti sesuai nama agent
d = Path(f'/root/.openclaw/agents/{agent}/sessions')
arc = d / '_archived'; arc.mkdir(exist_ok=True)
for f in d.glob('*.jsonl'):
    shutil.move(str(f), str(arc / f.name)); print(f'archived {f.name[:8]}')
(d / 'sessions.json').write_text('{}')"
# Dispatcher akan buat session baru bernama 'dispatcher-{agent}' pada pesan berikutnya
```

---

## Changelog

### Mar 12, 2026

**Telegram Attachment Ingestion**
- Dispatcher kini support parsing attachment dari Telegram ke RAG
- Format didukung: `txt, pdf, docx, doc, xls, xlsx, csv, md`
- Fungsi baru: `extract_text_from_bytes()` + `ingest_tg_document()`
- Libraries dipasang di VPS: `pypdf`, `openpyxl` (via `--break-system-packages`)
- Flow: getFile → download bytes → extract text → POST `/index` → reply ✅

**Gateway 409 / CPU Spike Fix**
- Root cause: `openclaw.json` punya entry `ditesh` di `channels.telegram.accounts`
  → gateway + dispatcher poll token yang sama → 409 Conflict loop → CPU 133%
- Fix: hapus `ditesh` dari `openclaw.json` accounts, restart gateway
- Hasilnya: CPU 133% → 10% idle ✅
- Gateway sekarang hanya poll `default` (main/newton)

**Session Proliferation Fix**
- Root cause: dispatcher panggil `openclaw agent` tanpa `--session-id`
  → tiap call (ritual, TG message, compact) buat file session baru
- Fix: tambah `--session-id dispatcher-{agent}` ke semua CLI calls di dispatcher
  - Line 167: `do_compact()` subprocess call
  - Line 218: `run_agent_background()` cmd list
- Dispatcher restart → semua session lama di-archive → sesi berikutnya pakai ID tetap `dispatcher-{agent}`

**Plane Docker Images Removed**
- Semua 6 Plane images dihapus dari Docker (containers sudah tidak ada sebelumnya)
- Images yang dihapus: `plane-admin`, `plane-backend`, `plane-frontend`, `plane-live`, `plane-proxy`, `plane-space`
- Disk freed: ~750MB

**n8n Workflow Cleanup — Fokus ke Integrasi**
- Hapus 6 ritual/compact workflows: 03-08 (Morning Briefing, Standup, Checkpoint, Wrapup, Compact Main, Compact Elsa)
- n8n sekarang hanya punya 2 workflows aktif (heartbeat):
  - `01_Hourly_Tidy_Up_Main` → main agent
  - `02_Hourly_Pipeline_Elsa` → elsa agent
- n8n sekarang fokus untuk integrasi workflows saja, bukan ritual agent

**Compact dikelola Dispatcher + Ditesh**
- Tambah `compact_scheduler()` background thread di dispatcher
- Jalan otomatis tiap jam di menit `:15` (UTC)
- Compact main + elsa sessions jika > 200KB
- Notifikasi hasil dikirim ke Ditesh via Telegram: `[DITESH] Compact (:15) — MAIN: no-op | ELSA: 1 compacted`
- Thread ke-4 di dispatcher (Tasks: 3 → 4 setelah restart)

### Mar 13, 2026

**Ditesh Compaction Audit & Fix**
- Root cause session bengkak: `COMPACT_AGENTS` hanya berisi `["main", "elsa"]` — ditesh **tidak pernah dicompact**
- Ditesh punya 355KB active session + 1.6MB `.jsonl.old` dead weight (total 2.1M), 0 memory snapshots
- Fix 1: Tambah `ditesh` ke `COMPACT_AGENTS` → `["main", "elsa", "ditesh"]` di dispatcher line 528
- Fix 2: `.jsonl.old` (1.6MB) sudah masuk `_archived/` subfolder, archived session dipindah juga
- Fix 3: `ditesh` masih ada di `openclaw.json` `channels.telegram.accounts` → hapus (409 Conflict kambuh)
- Gateway restart tanpa ditesh account → 409 errors berhenti
- Manual compact ditesh → memory snapshot pertama berhasil dibuat: `20260313_074538.json` (1.2K)

**ELSA Orphan Session Cleanup**
- ELSA punya 44 orphan sessions dari n8n cron channel (UUID format: `agent:elsa:cron:{wf-id}:run:{UUID}`)
- Semua 44 file diarchive ke `_archived/` subfolder, `sessions.json` direset ke `{}`
- Main juga punya 5 orphan `_archived_` files dengan stacked prefixes — dipindah ke `_archived/` subfolder

**Dispatcher v3 → v4: Heartbeat Scheduler + RAG Index Bridge**
- n8n heartbeat workflows **dideactivate** (01_Hourly_Tidy_Up_Main + 02_Hourly_Pipeline_Elsa) — n8n container di-restart
- Heartbeat scheduling sekarang **native di dispatcher** via `heartbeat_scheduler()` thread baru
- Setiap agent punya `~/.openclaw/agents/{agent}/agent/heartbeat.md` dengan YAML frontmatter:
  - `interval_minutes`: interval pengulangan (default 60)
  - `offset_minutes`: menit keberapa di jam itu heartbeat fire
  - `inject_memory`: inject memory snapshot ke prompt (true/false)
  - `ritual_label`: label display di Telegram
- Schedule aktif:
  - **main**: setiap 60m @:00 — "01 Hourly Tidy-Up" (sistem normal check)
  - **elsa**: setiap 60m @:30 — "02 Pipeline ELSA" (SCRAPER/QDRANT/BACKLOG/ANOMALI)
  - **ditesh**: setiap 60m @:45 — "03 Infra Check DITESH" (DOCKER/DISK/MEMORY/SERVICES/NETWORK)
  - **newton**: setiap 360m @:10 — "04 Research Pulse NEWTON" (STRATEGY/BACKTEST/REGIME/INSIGHT)
- Heartbeat.md di-reload setiap ~60 menit, jadi perubahan schedule tidak perlu restart dispatcher
- **RAG Index Bridge**: `index_to_rag()` dipanggil setelah setiap `save_memory()` di `do_compact()`
  - Memory snapshot di-POST ke `http://localhost:8000/index` → Qdrant `agent_memory` collection
  - Menjembatani file-based memory → semantic search via Qdrant
- Dispatcher sekarang punya **5 threads**: HTTP server, compact_scheduler, heartbeat_scheduler, polling elsa, polling ditesh
- Backup v3 tersedia di `/usr/local/bin/agent-dispatcher.py.bak`

**Bug Fix: rag_heartbeat_monitor.py Duplicate Ingestion (Albert's Audit)**
- Albert (main agent) mengidentifikasi 3 bug di `rag_heartbeat_monitor.py`:
  1. Semua agent baca file yang sama: `/root/.openclaw/workspace/memory/{today}.md` (shared workspace)
  2. Semua agent kirim ke collection yang sama: `agent_memory` (hardcoded)
  3. `openclaw session status` tanpa `--agent` flag → baca context global, bukan per-agent
- Dampak: 3x duplicate ingestion konten identik dari semua agen ke Qdrant
- **Fix 1**: Ganti path ke `~/.openclaw/agents/{AGENT_NAME}/memories/*.json` (per-agent JSON snapshots)
- **Fix 2**: Ganti collection ke `f"agent_memory_{AGENT_NAME}"` — elsa → `agent_memory_elsa`, dll
- **Fix 3**: Context estimation dari ukuran session file per-agent (bukan `openclaw session status`)
- **Fix 4**: RAG API `/index` menerima single Document dengan field `collection` di dalamnya, bukan batch format
- Dispatcher v4 `index_to_rag()` juga di-update ke `f"agent_memory_{agent}"` collection
- Qdrant sekarang punya `agent_memory_elsa` collection terpisah (verified: 3 snapshots berhasil masuk)
- Script juga exit dengan error jika `AGENT_NAME` tidak di-set — mencegah silent bug
- Status post-fix: ditesh memories=8.0K ✅, 409 errors=0 ✅, compact_scheduler sekarang cover 3 agents

**Token Audit & Agent Isolation (late Mar 13, 2026)**

*Token burn audit findings:*
- Gold 1-min cron (ELSA): ~662K tokens/day (30 runs × avg 4,600 tok)
- Main heartbeat: ~670K tokens/day (24 × 27,900 tok) — contextTokens MAXED at 64K
- Ditesh heartbeat: ~638K tokens/day (24 × 26,600 tok) — contextTokens MAXED at 64K
- Root cause: `workspace/memory/2026-03-13.md` = 51KB growing all day, injected every heartbeat
- `systemPromptReport.chars = 38,385` per Ditesh run

*Optimizations applied:*
- **inject_memory: false** set di `ditesh/agent/heartbeat.md` dan `elsa/agent/heartbeat.md`
  - `inject_memory` injects 3 compact memory JSON snapshots ke prompt — tidak perlu untuk infra check & pipeline audit
  - Main tetap `inject_memory: true` (Albert butuh memory untuk PMO context)
- **Ditesh workspace isolated**: `~/.openclaw/agents/ditesh/workspace/` dibuat baru
  - Sebelumnya pakai shared `/root/.openclaw/workspace` (254KB penuh Python scripts)
  - Workspace baru berisi: CONTEXT.md (infra-focused), AGENTS.md, IDENTITY.md, BOOTSTRAP.md
  - File ditesh-specific (DITESH_RAG_IMPLEMENTATION_PLAN.md, DITESH_AGENT_MEMORY_RAG_CARD.md) dipindahkan
  - Config: `openclaw.json agents.list[ditesh].workspace = "/root/.openclaw/agents/ditesh/workspace"`
- **Ditesh TOOLS.md pruned**: 5,815 → 4,708 bytes
  - Hapus section "Project Management — PostgreSQL" (SQL snippets) — tidak relevan untuk infra heartbeat
  - Backup di `~/.openclaw/agents/ditesh/agent/TOOLS.md.bak`
- **Workspace memory pruned**: `workspace/memory/2026-03-13.md` 51KB → 5.3KB (keep last 100 lines)
  - Full archive di `workspace/memory/archive/2026-03-13_full_1507.md`
  - Older files (2026-03-10, 2026-03-11) archived ke `memory/archive/`
- **Auto-prune cron**: `/etc/cron.d/prune-workspace-memory` — runs `0 0 * * *` midnight
  - Script: `/usr/local/bin/prune_workspace_memory.py`
  - Action: archive full file, truncate ke 100 lines terakhir
- **Ditesh model changed**: `anthropic/claude-sonnet-4-5-20251001` → `deepseek/deepseek-chat`
  - Fallback: `deepseek/deepseek-reasoner` → `anthropic/claude-sonnet-4-20250514`
  - Alasan: Ditesh hanya butuh infra check singkat, Sonnet terlalu mahal ($3/1M)

**ELSA Telegram Delivery Isolation (late Mar 13, 2026)**
- Problem: ELSA heartbeat (`:30` setiap jam) masih dikirim lewat **bot Albert** (@Qqquanta_bot)
  - `openclaw.json` sudah punya `channels.telegram.accounts.elsa` terdaftar
  - Tapi `agents.list[elsa].delivery.telegram.account` **tidak diset** → fallback ke `default` (Albert)
- Fix: `agents.list[elsa].delivery.telegram.account = "elsa"`
- Gateway restart via: `XDG_RUNTIME_DIR=/run/user/0 systemctl --user restart openclaw-gateway`
- Status sekarang:
  - main → bot Albert (by design, PMO)
  - elsa → bot ELSA ✅
  - ditesh → bot Ditesh ✅
  - newton → bot Albert ⚠️ (belum punya bot sendiri, perlu buat di @BotFather)

*Agent isolation summary (post Mar 13):*

| Agent  | Workspace     | Telegram Bot | inject_memory | Model |
|--------|--------------|--------------|---------------|-------|
| main   | shared (254KB) | @Qqquanta_bot | true        | deepseek-chat |
| elsa   | isolated (27KB) | @elsa_oc_bot | **false**   | deepseek-chat |
| ditesh | isolated (new, ~15KB) | @ditesh_bot | **false** | deepseek-chat |
| newton | shared (254KB) | @Qqquanta_bot | true       | claude-sonnet-4 |