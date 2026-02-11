# SSSAHAM — Smart Stock Scanner System

> **Version**: 2.0  
> **Last Updated**: 2026-02-11

## 🎯 Project Overview

SSSAHAM adalah sistem analisis saham berbasis **Orderflow** dan **Smart Money Flow** yang mendeteksi akumulasi/distribusi institusional dengan metodologi non-overfitting.

### Core Philosophy

```
"Jika net buying tinggi tapi harga belum bergerak, ada tekanan beli tersembunyi 
yang akan mendorong harga naik." — Prinsip Absorption dari Market Microstructure
```

### Key Features

| Feature | Description | Status |
|---------|-------------|--------|
| **Orderflow Scanner** | Realtime delta analysis + hybrid scoring | ✅ Live |
| **Smart Money Flow** | 20-day Z-Score tracking (Foreign + Local Fund vs Retail) | ✅ Live |
| **Divergence Scoring** | Cross-validate intraday vs 20-day trend | 🚧 In Progress |
| **Footprint Chart** | Granular bid/ask level visualization | ✅ Live |
| **Broker Summary** | Per-broker accumulation/distribution tracking | ✅ Live |

---

## 📂 Directory Structure Overview

### 🖥️ Frontends

| Path | Description |
| :--- | :--- |
| `index.html` | **Main Landing Page**. Entry point for the ecosystem. |
| `idx/emiten/index.html` | **Orderflow Scanner**. Main bubble chart + table scanner. |
| `idx/emiten/broker-summary.html` | **Broker Summary Detail**. Per-ticker SM flow analysis. |
| `idx/emiten/detail.html` | **Footprint Chart**. Granular price level visualization. |
| `admin-dashboard.html` | **Admin Dashboard**. Monitors worker health, cron jobs. |
| `performance-report.html` | **Performance Reports**. Portfolio/trading performance. |

---

### 🔌 API Services

#### 🌍 Public APIs (Client Facing)

| Worker | Endpoints | Description |
| :--- | :--- | :--- |
| **`api-saham`** | `/footprint/summary`, `/screener` | Orderflow scanner data |
| **`api-saham`** | `/range`, `/flow/smart-money` | Broker summary & SM flow |
| **`api-saham`** | `/features/calculate` | On-demand Z-Score calculation |
| **`auth-uid`** | `/register`, `/login`, `/me` | User authentication |

#### 🔒 Private APIs (Internal)

| Worker | Endpoints | Description |
| :--- | :--- | :--- |
| **`features-service`** | `/aggregate`, `/aggregate-footprint` | Cron-triggered aggregation |
| **`livetrade-taping-agregator`** | `/footprint-hourly-dump` | R2→D1 backfill |
| **`cron-checker`** | `/trigger`, `/check` | Orchestrates scheduled jobs |

---

### ☁️ Cloudflare Workers Architecture

```
                    ┌─────────────────────────────────────────────┐
                    │           TRADE STREAM (WebSocket)          │
                    └─────────────────────┬───────────────────────┘
                                          │
                    ┌─────────────────────▼───────────────────────┐
                    │       Durable Object Engine (x7)            │
                    │   livetrade-durable-engine-1 ~ 7            │
                    └───────┬─────────────────────────┬───────────┘
                            │                         │
              R2 write      │                         │ Queue
              (NDJSON)      ▼                         ▼
┌───────────────────────────────────────┐  ┌──────────────────────────────┐
│ R2: tape-data-saham                   │  │ livetrade-taping-agregator   │
│                                       │  │  → processAggregationBatch   │
│ footprint/{TICKER}/1m/{Y}/{M}/{D}/    │  │  → R2 → D1 insert            │
└───────────────────┬───────────────────┘  └──────────────┬───────────────┘
                    │                                      │
                    │         ┌────────────────────────────┘
                    │         ▼
                    │  ┌──────────────────────────────────────────┐
                    │  │ D1: temp_footprint_consolidate           │
                    │  │ (ticker, date, OHLC, vol, delta)         │
                    │  └───────────────────┬──────────────────────┘
                    │                      │
     R2 fallback    │                      │ Cron: */5 * * * *
     (if D1 empty)  │                      ▼
                    │  ┌──────────────────────────────────────────┐
                    └─►│ features-service                         │
                       │  aggregateHybrid()                       │
                       │  → Hybrid Score + Signal                 │
                       │  → Divergence Factor (NEW)               │
                       │  → SM Weight (NEW)                       │
                       │  → R2: footprint-summary.json            │
                       └───────────────────┬──────────────────────┘
                                           │
                       ┌───────────────────▼──────────────────────┐
                       │ api-saham  GET /footprint/summary        │
                       │  → Frontend (Orderflow Scanner)          │
                       └──────────────────────────────────────────┘
```

#### 📈 Stock Data Pipeline

| Worker | Description |
| :--- | :--- |
| `livetrade-durable-engine-*` | Durable Objects for realtime trade buffering |
| `livetrade-taping-agregator` | Aggregation: R2 → D1, cleanup |
| `features-service` | Z-Score calculation, hybrid scoring, **divergence scoring** |
| `broksum-scrapper` | Broker summary data collection |
| `api-saham` | Public API gateway |

#### 🛠️ Infrastructure

| Worker | Description |
| :--- | :--- |
| `cron-checker` | Centralized cron orchestrator |
| `batch-delete` | R2 bulk deletion helper |
| `auth-uid` | User authentication (JWT) |

---

## 📊 Scoring Methodology

### Hybrid Score Formula

```javascript
// Base Score (70% realtime, 30% historical)
hybridScore = (0.7 × normDelta) + (0.3 × normZNGR)

// NEW: Divergence-Aware Scoring
finalScore = hybridScore × divergenceFactor × smWeight
```

### Divergence Factor

| Scenario | Factor | Risk |
|----------|--------|------|
| DISTRIBUTION + Bullish intraday | 0.5 | 🔴 Retail Trap |
| ACCUMULATION + Bearish intraday | 0.7 | 🟡 Shakeout |
| ACCUMULATION + Bullish + SM positive | 1.2 | 🟢 Confirmed |
| NEUTRAL | 1.0 | ➖ No adjustment |

### SM Direction Weight

| SM Net | Retail Net | Weight | Meaning |
|--------|------------|--------|---------|
| + | - | 1.2 | Smart Accumulation |
| - | + | 0.6 | Retail Trap |
| + | + | 1.1/0.9 | Both buying |
| - | - | 1.0 | Both selling |

See [workers/_DOC/0004_divergence_scoring.md](workers/_DOC/0004_divergence_scoring.md) for full documentation.

---

## 📚 Living Documentation

| Document | Description |
|----------|-------------|
| [0001_orderflow.md](workers/_DOC/0001_orderflow.md) | Orderflow Scanner architecture & scoring |
| [0002_detail_emiten.md](workers/_DOC/0002_detail_emiten.md) | Footprint Chart & auto-repair system |
| [0003_brokersummary.md](workers/_DOC/0003_brokersummary.md) | Smart Money Flow chart & Z-Score features |
| [0004_divergence_scoring.md](workers/_DOC/0004_divergence_scoring.md) | **NEW**: Divergence-aware scoring logic |

---

## 🔄 Key Workflows

### 1. Orderflow Scanner Pipeline

```
WebSocket → Durable Objects → R2 (NDJSON) → D1 → features-service → API → Frontend
```

**Cron Schedule**:
- `*/5 * * * *` — Aggregate footprint, calculate hybrid score
- `*/1 * * * *` — Health check via cron-checker

### 2. Smart Money Flow Calculation

```
R2: raw-broksum/{ticker}/{date}.json → 
  features-service (queue consumer) → 
    Z-Score calculation (20-day window) → 
      D1: daily_features → 
        API: /screener
```

### 3. Divergence Detection (NEW)

```
Intraday Signal (deltaPct > 0) + 
  Historical State (DISTRIBUTION) + 
    SM Net < 0 + Retail Net > 0 
      → RETAIL_TRAP warning
```

---

## 📦 Deployment

### Deploy Single Worker
```bash
cd workers/<worker-name>
npx wrangler deploy
```

### Deploy All
```bash
./workers/deploy.sh
```

### Sanity Check
```bash
./workers/sanity.sh
```

---

## 🧪 Testing & Debugging

### Force R2 Fallback
```bash
curl "https://features-service.mkemalw.workers.dev/aggregate-footprint?source=r2"
```

### Check Scanner Output
```bash
curl "https://api-saham.mkemalw.workers.dev/footprint/summary" | jq '.items | length'
```

### Debug Frontend
Add `?debug` to URL:
```
https://sssaham.pages.dev/idx/emiten/index.html?debug
```

---

*Project maintained by mkemalw + Copilot*
