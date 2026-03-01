# Smart Money Flow Chart — FSD (Functional Specification Document)

## 1. Objective

> **One Simple Idea**: *"Smart Money (Foreign + Local Fund) bergerak lebih awal dari Retail. Jika Smart Money akumulasi sementara Retail masih jual, ini sinyal awal reversal."*
>
> **Non-Overfitting Evidence** (~85% confidence):
> - **2 series only**: Smart Money (blue) vs Retail (orange) — tidak ada 10 garis berbeda
> - **Agregasi sederhana**: Total net value per kategori, bukan model ML kompleks
> - **Window 30 hari**: Cukup untuk melihat trend, tidak cherry-picked
> - **Kategorisasi broker**: Menggunakan mapping dari IDX/sekuritas, bukan self-labeled
>
> *Risiko overfitting tersisa (~15%): Definisi "Smart Money" (Foreign + Local Fund) bisa diperdebatkan. Beberapa Local Fund adalah quasi-retail.*

---

## 2. Problem Statement

### Current State
Halaman `broker-summary.html` menampilkan:
- Market Sentiment (Bullish/Bearish) ✅ OK
- Progress bar Accumulation vs Distribution ❌ **Tidak informatif** — bar statis tidak menunjukkan trend

### Desired State
Menambahkan **Line Chart Time Series 30 Hari** yang menampilkan:
- **Garis Biru**: Smart Money = Foreign + Local Fund (net value akumulatif)
- **Garis Orange**: Retail (net value akumulatif)

User dapat melihat:
- Apakah Smart Money sedang akumulasi atau distribusi
- Divergensi antara Smart Money vs Retail (leading indicator)
- Trend 30 hari untuk konfirmasi

---

## 3. Data Source

### R2 Bucket: `raw-broksum`

**Key Pattern**: `{TICKER}/{YYYY-MM-DD}.json`

**Sample**: `BBCA/2026-02-10.json`

```json
{
  "symbol": "BBCA",
  "date": "2026-02-10",
  "data": {
    "broker_summary": {
      "buyer": [
        { "netbs_broker_code": "YP", "type": "Asing", "bval": 50000000, "blot": 500, ... },
        { "netbs_broker_code": "NI", "type": "Lokal", "bval": 30000000, "blot": 300, ... },
        ...
      ],
      "seller": [
        { "netbs_broker_code": "PD", "type": "Lokal", "sval": 20000000, "slot": 200, ... },
        ...
      ]
    }
  }
}
```

### Broker Category Mapping (D1: `brokers` table)

| Broker Code | Category | Treated As |
|---|---|---|
| YP, JP, ML | Asing | **Smart Money** |
| NI, AM, KK | Local Fund | **Smart Money** |
| PD, RX, SQ | Retail | Retail |

**Logic**:
```javascript
isSmartMoney = (b.type === "Asing") || (!isRetail(b.code) && b.type !== "Retail")
isRetail = brokerCategory.includes("retail")
```

---

## 4. Aggregation Logic

### Per-Day Calculation

```javascript
// Untuk setiap hari dalam range 30 hari:
let smartMoneyNet = 0;  // Foreign + Local Fund
let retailNet = 0;

brokerSummary.buyer.forEach(b => {
  if (b.type === "Asing") smartMoneyNet += b.bval;
  else if (!isRetail(b.code)) smartMoneyNet += b.bval;  // Local Fund
  else retailNet += b.bval;
});

brokerSummary.seller.forEach(b => {
  if (b.type === "Asing") smartMoneyNet -= b.sval;
  else if (!isRetail(b.code)) smartMoneyNet -= b.sval;
  else retailNet -= b.sval;
});

// Output per hari:
{ date: "2026-02-10", smartMoney: smartMoneyNet, retail: retailNet }
```

### Cumulative (Optional View)

Untuk melihat akumulasi total 30 hari:
```javascript
let cumSmart = 0, cumRetail = 0;
series.forEach(day => {
  cumSmart += day.smartMoney;
  cumRetail += day.retail;
  day.cumSmart = cumSmart;
  day.cumRetail = cumRetail;
});
```

---

## 5. API Design

### New Endpoint: `GET /flow/smart-money`

**Query Params**:
| Param | Required | Default | Description |
|---|---|---|---|
| `tickers` | Yes | - | Comma-separated: `BBCA,BBRI,BMRI` |
| `days` | No | `30` | Lookback days |
| `mode` | No | `daily` | `daily` or `cumulative` |

**Response**:
```json
{
  "status": "OK",
  "generated_at": "2026-02-10T12:00:00Z",
  "tickers": ["BBCA", "BBRI", "BMRI"],
  "days": 30,
  "mode": "daily",
  "series": [
    {
      "date": "2026-01-10",
      "smartMoney": 125000000000,
      "retail": -45000000000
    },
    {
      "date": "2026-01-11",
      "smartMoney": 89000000000,
      "retail": -32000000000
    },
    // ... 30 days
  ],
  "summary": {
    "smartMoney_total": 2500000000000,
    "retail_total": -890000000000,
    "divergence": "SMART_ACCUM_RETAIL_DIST"  // Leading indicator
  }
}
```

### Alternative: Aggregate Market-Wide

**Endpoint**: `GET /flow/market-smart-money`

Sama seperti di atas tapi untuk **semua emiten** (atau top 100 by liquidity). Ini untuk widget "Market Smart Money Flow" di dashboard utama.

---

## 6. Frontend Design

### Chart Specification

| Property | Value |
|---|---|
| Type | Line Chart (Chart.js) |
| X-Axis | Date (30 days) |
| Y-Axis | Net Value (IDR, formatted: "125 T", "-45 B") |
| Series 1 | Smart Money — Blue (#2563eb), line width 2 |
| Series 2 | Retail — Orange (#f97316), line width 2 |
| Fill | Optional: area fill with 10% opacity |
| Tooltip | Date, Smart Money value, Retail value |
| Legend | "Smart Money (Asing + Fund)" / "Retail" |

### Placement

Replace current progress bar in `#market-breadth-widget` with:
```html
<div class="chart-container-responsive" style="height: 200px;">
  <canvas id="smartMoneyChart"></canvas>
</div>
```

### Mobile Responsive
- Portrait: height 150px
- Landscape: height 200px

---

## 7. Implementation Plan

### Phase 1: MVP (Blue Chip Only)

**Scope**: 8 tickers for initial validation
```
BBCA, BBRI, BMRI, ANTM, PTBA, TINS, BREN, GOTO
```

**Tasks**:
1. [ ] Create endpoint `GET /flow/smart-money` di `api-saham`
2. [ ] Read R2 raw-broksum untuk 30 hari × 8 tickers
3. [ ] Aggregate Smart Money vs Retail per hari
4. [ ] Frontend: Replace progress bar dengan line chart
5. [ ] Test & validate data accuracy

**Estimated Effort**: 4-6 hours

### Phase 2: Backfill All Tickers

**Scope**: ~900 active emiten × 30 days = ~27,000 R2 reads

**Tasks**:
1. [ ] Create worker cron untuk daily aggregation (18:00 WIB)
2. [ ] Store aggregated data ke R2 cache: `flow/smart-money-30d.json`
3. [ ] Backfill historical data (30 hari kebelakang) via queue
4. [ ] Frontend: Switch to cached data

**Estimated Effort**: 2-3 hours

### Phase 3: Market-Wide Widget

**Scope**: Aggregate all tickers untuk satu chart "Market Smart Money"

**Tasks**:
1. [ ] Create `GET /flow/market-smart-money`
2. [ ] Add to main dashboard (optional)

---

## 8. Schema & Keys

### R2 Cache Key (Output)

| Key | Description | Writer | Reader |
|---|---|---|---|
| `flow/smart-money/{TICKER}-30d.json` | Per-ticker 30-day series | api-saham/cron | Frontend |
| `flow/market-smart-money-30d.json` | Market-wide aggregated | Cron | Dashboard widget |

### Cache TTL
- Daily refresh at 18:00 WIB (market close + 2 hours for data settle)
- Frontend fallback: direct R2 read if cache miss

---

## 9. Edge Cases & Error Handling

| Case | Handling |
|---|---|
| Missing day data (holiday) | Skip, don't interpolate |
| Partial broker data | Use available, log warning |
| Weekend request | Return last Friday's data |
| R2 read limit (1000) | Batch by ticker, parallelize |
| Ticker not in MVP list | Return 400 with supported list |

---

## 10. Success Metrics

| Metric | Target |
|---|---|
| API response time | < 2s for 8 tickers × 30 days |
| Data freshness | Updated by 18:30 WIB daily |
| Chart render time | < 500ms |
| User engagement | TBD (click-through to detail) |

---

## 11. Future Enhancements

1. **Divergence Alert**: Notifikasi ketika Smart Money vs Retail divergence > threshold
2. **Sector View**: Aggregate by sector (Banking, Mining, etc.)
3. **Intraday Smart Money**: Hourly tracking (requires footprint data integration)
4. **Historical Backtest**: Validate divergence → price correlation

---

## Appendix A: Broker Category Reference

### Smart Money (Foreign)
```
YP (JP Morgan), ML (Merrill Lynch), UB (UBS), CS (Credit Suisse),
GS (Goldman), MS (Morgan Stanley), DB (Deutsche), ...
```

### Smart Money (Local Fund)
```
NI (Nikko), AM (Mandiri Sekuritas - Asset Mgmt), KK (Korea Investment),
MG (Mega Capital), ZP (Samuel), ...
```

### Retail
```
PD (Panin Dana), RX (Indo Premier), SQ (Stockbit), YU (Mirae - Retail),
KZ (Ajaib), ...
```

*Note: Mapping subject to refinement based on actual trading patterns.*

---

## Appendix B: Sample API Call Flow

```
1. Frontend loads broker-summary.html
2. JS calls: GET /flow/smart-money?tickers=BBCA,BBRI,...&days=30
3. Worker:
   a. Check R2 cache: flow/smart-money/BBCA-30d.json
   b. If fresh (< 1 day old): return cached
   c. If stale: read raw-broksum/{ticker}/{date}.json × 30 days
   d. Aggregate, cache, return
4. Frontend renders Chart.js line chart
```

---

## 12. Z-Score Features Card (Detail View)

### Overview

Halaman `broker-summary.html` menampilkan **Z-Score Features Card** yang memberikan insight tentang karakteristik trading emiten berdasarkan analisis 20-hari.

### Features Displayed

| Feature | Metric | Interpretation |
|---------|--------|----------------|
| **Effort** | `z_effort` | Volume effort vs historical. High = aggressive trading |
| **Price Response** | `z_result` | Price response to effort. High = responsive |
| **Net Quality** | `z_ngr` | Quality of net flow. High = consistent accumulation |
| **Elasticity** | `z_elas` | Price elasticity. High = volatile, Low = rigid |
| **State** | `state` | Overall regime: ACCUMULATION / DISTRIBUTION / NEUTRAL |

### Badge Logic

```javascript
function getBadge(label, value, thresholds) {
    // Each feature has specific threshold interpretation
    // Green = positive signal
    // Yellow = neutral
    // Red = negative signal
    
    // Example: Effort
    if (label === 'Effort') {
        if (value > 1) return { text: 'High Volume', class: 'success' };
        if (value < -1) return { text: 'Low Volume', class: 'secondary' };
        return { text: 'Normal', class: 'warning' };
    }
    // ... etc
}
```

### Data Source

**Primary**: `/screener?limit=9999` API endpoint
- Contains pre-calculated Z-Score features for ~101 emiten (actively tracked)

**Fallback (On-Demand)**: When ticker not in screener
- Calculate from raw broker summary history (20-day rolling window)
- API: `/features/calculate?ticker={TICKER}` (new endpoint)

### On-Demand Calculation Flow

```
User opens broker-summary.html?kode=BMSR
         ↓
loadZScoreFeatures(ticker)
         ↓
Try /screener endpoint
         ↓
Found in screener? → Display directly
         ↓
Not found? → calculateFeaturesFromHistory()
         ↓
Fetch raw broker summary (20 days)
         ↓
Calculate locally:
- NGR = (buyVal - sellVal) / totalVal per day
- z_ngr = (NGR_today - mean(NGR_20d)) / stddev(NGR_20d)
- ... other z-scores
         ↓
Display calculated features
```

### UI Placement

```
┌─────────────────────────────────────────┐
│ [Broker Summary Card - Top]             │
│ - Market Sentiment                      │
│ - Proportional Bar (SM vs Retail)       │
├─────────────────────────────────────────┤
│ [Z-Score Features Card] ← NEW           │
│ ┌─────────┬─────────┬─────────┐        │
│ │ Effort  │ Response│ Quality │        │
│ │ Normal  │ Quiet   │ Noise   │        │
│ └─────────┴─────────┴─────────┘        │
│ ┌─────────────┬─────────────┐          │
│ │ Elasticity  │ State       │          │
│ │ Rigid       │DISTRIBUTION │          │
│ └─────────────┴─────────────┘          │
├─────────────────────────────────────────┤
│ [Date Range Selector]                   │
│ [Smart Money Flow Chart]                │
└─────────────────────────────────────────┘
```

### Feature Interpretation Guide

| Feature | High (> 1) | Normal (-1 to 1) | Low (< -1) |
|---------|------------|------------------|------------|
| Effort | Heavy trading activity | Normal activity | Light activity |
| Response | Strong price moves | Normal response | Price stuck |
| Quality | Clean accumulation | Mixed flow | Heavy distribution |
| Elasticity | Very responsive | Normal | Rigid/stuck |

| State | Color | Meaning |
|-------|-------|---------|
| ACCUMULATION | 🟢 Green | Smart money building position |
| DISTRIBUTION | 🔴 Red | Smart money exiting |
| NEUTRAL | 🟡 Yellow | No clear direction |

---

## 13. Divergence Detection Integration

### Cross-Reference with Orderflow

The Z-Score features now integrate with Orderflow Scanner to detect **divergence**:

| Orderflow Signal | Z-Score State | Result |
|------------------|---------------|--------|
| Bullish (WATCH_ACCUM) | ACCUMULATION | ✅ Confirmed |
| Bullish (WATCH_ACCUM) | DISTRIBUTION | ⚠️ **RETAIL_TRAP** |
| Bearish (SELL) | DISTRIBUTION | ✅ Confirmed |
| Bearish (SELL) | ACCUMULATION | 🔄 Possible Shakeout |

### Display Warning

When divergence detected, broker-summary.html shows:
```
⚠️ DIVERGENCE WARNING
Intraday signal (BULLISH) conflicts with 20-day trend (DISTRIBUTION).
Smart Money net: -28.2M | Retail net: +28.1M
Risk Level: HIGH - Potential Retail Trap
```

See [0004_divergence_scoring.md](0004_divergence_scoring.md) for full divergence logic.

---

## 14. Smart Repair & Data Integrity

### 14.1 Problem Statement (Incident: 2026-02-10 ~ 2026-02-11)

**Root Cause**: WebSocket koneksi ke IPOT bersifat non-deterministic. Scraper menunggu records selama `EMPTY_IDLE_MS` (1.2s), tetapi IPOT kadang lambat merespon. Akibatnya:

| Tanggal | Price | brokers_buy | brokers_sell | Impact |
|---------|-------|-------------|--------------|--------|
| 2026-02-10 | 0 | [] | [] | Scraper gagal total — summary line juga kosong |
| 2026-02-11 | 7444 | [] | [] | Summary ter-parse, tapi broker records kosong |

Data kosong ini disimpan ke R2 **tanpa validasi**, menimpa data valid (jika ada) dan menyebabkan chart cumulative flow **kehilangan data point** untuk tanggal tersebut.

Masalah terdeteksi di **semua emiten** (BBCA, BBRI, BMRI, TLKM, ASII, dll.) — bukan masalah per-ticker melainkan masalah WebSocket timing secara global.

### 14.2 Solution Architecture: 2 Layer Protection

```
┌──────────────────────────────────────────────────────┐
│ LAYER 1: Real-time Validation (Saat Scrape)          │
│                                                      │
│  Scraper → validate() → OK? ─── YES → save to R2    │
│                          │                           │
│                          NO → retry (max 2x)         │
│                               │                      │
│                               STILL FAIL?            │
│                               ├─ R2 punya data valid │
│                               │  → SKIP overwrite    │
│                               └─ R2 kosong           │
│                                  → save + flag       │
│                                    _needsRepair      │
│                                  → repair queue      │
└──────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────┐
│ LAYER 2: Daily Health Check Cron (Safety Net)        │
│                                                      │
│  Cron 19:00 WIB → sample ~60 emiten dari H-1        │
│  ├─ 30 emiten wajib (LQ45/IDX30)                    │
│  └─ 30 emiten random dari watchlist                  │
│                                                      │
│  Validate semuanya → hitung critical rate            │
│  ├─ >10% critical → FULL REBUILD tanggal H-1        │
│  ├─ <10% tapi ada → SELECTIVE REPAIR                │
│  └─ 0% critical   → Log "All Healthy ✅"            │
└──────────────────────────────────────────────────────┘
```

### 14.3 Validator Module (`validator.js`)

Shared module yang dipakai oleh scraper (Layer 1) dan health check (Layer 2).

**Rules**:

| # | Rule | Severity | Description |
|---|------|----------|-------------|
| 1 | `price > 0` | CRITICAL | Harga harus ada jika ada trading |
| 2 | `brokers_buy.length >= 1` | CRITICAL | Minimal 1 broker buy |
| 3 | `brokers_sell.length >= 1` | CRITICAL | Minimal 1 broker sell |
| 4 | `total_value > 0 && broker_count == 0` | CRITICAL | Summary ada tapi broker kosong |
| 5 | `price_change <= 35%` vs H-1 | WARNING | Di luar ARA/ARB (25-35%) |
| 6 | `frequency > 0 && total_val == 0` | CRITICAL | Ada transaksi tapi value 0 |

**Interface**:

```javascript
import { validateBroksum } from './validator.js';

const result = validateBroksum(rawData, previousDayData);
// Returns: { valid: boolean, issues: string[], severity: 'OK'|'WARNING'|'CRITICAL' }
```

### 14.4 Smart Save Logic (Scraper Integration)

Ditambahkan di `index.js` sebelum R2 `.put()`:

```
validate(scrapedData, prevData)
  ├── valid → save to R2 ✅
  └── invalid (CRITICAL)
       ├── retry ≤ 2x → re-scrape, re-validate
       └── retry exhausted
            ├── R2 punya data lama yang valid? → SKIP save (keep existing) 🛡️
            └── R2 kosong → save with _needsRepair flag + add to repair queue 📋
```

### 14.5 Health Check Cron

**Schedule**: `0 12 * * 1-5` (19:00 WIB, Senin-Jumat)
- Berjalan **1 jam setelah** daily rewrite cron (18:00 WIB)
- Memberi waktu scrape + queue processing selesai sebelum di-validasi

**Sample Strategy**:

```javascript
const MANDATORY_CHECK = [
  // LQ45 / IDX30 yang wajib dicek
  'BBCA','BBRI','BMRI','BBNI','TLKM','ASII','UNVR',
  'HMSP','ICBP','INDF','KLBF','PGAS','SMGR','TOWR',
  'EXCL','ANTM','INCO','PTBA','ADRO','MDKA','ACES',
  'BRIS','ARTO','GOTO','BREN','AMMN','CPIN','MAPI',
  'ESSA','BRPT'
];
const RANDOM_SAMPLE_SIZE = 30;  // dari sisa watchlist
```

**Decision Matrix**:

| Critical Rate | Action | Scope |
|---------------|--------|-------|
| > 10% (≥ 6/60) | FULL REBUILD | Semua emiten, tanggal H-1 |
| 1-10% (1-5/60) | SELECTIVE REPAIR | Hanya emiten yg gagal |
| 0% | No action | Log "healthy" |

**Repair Queue**: Disimpan di KV `repair:{YYYY-MM-DD}` dengan TTL 7 hari.

**Report**: Disimpan di KV `health-report:{YYYY-MM-DD}` dengan TTL 30 hari.

### 14.6 Implementation Files

| File | Type | Description |
|------|------|-------------|
| `src/validator.js` | NEW | Validation rules & severity logic |
| `src/health-check.js` | NEW | Health check cron handler + repair orchestration |
| `src/index.js` | MODIFY | Import validator, smart save before R2 put, route health check in cron |
| `wrangler.jsonc` | MODIFY | Add `"0 12 * * 1-5"` cron trigger |

### 14.7 Webhook Notifications

Health check mengirim notifikasi via existing `NOTIF_SERVICE` binding:

| Event | Message |
|-------|---------|
| All Healthy | `✅ Health Check: 60/60 emiten healthy for 2026-02-11` |
| Selective Repair | `🔧 Health Check: 3/60 critical. Repairing: BBCA, GOTO, ASII` |
| Full Rebuild | `⚠️ Health Check: 12/60 critical (20%). FULL REBUILD triggered for 2026-02-11` |
| Repair Success | `✅ Repair Complete: 3/3 emiten fixed for 2026-02-11` |

### 14.8 Tasks

- [x] Investigate root cause (WebSocket timing, EMPTY_IDLE_MS too short)
- [x] Frontend fix: chart filter tidak buang tanggal zero-data
- [x] Scraper fix: retry logic saat broker list kosong + validasi save
- [ ] Create `validator.js`
- [ ] Create `health-check.js`
- [ ] Integrate smart save into scraper `index.js`
- [ ] Add health check cron to `wrangler.jsonc`
- [ ] Deploy & verify

---

## 15. Accumulation Scanner (TradingView-Style)

### 15.1 Objective

Provide a fast, pre-aggregated screener that identifies stocks where **Smart Money** (Foreign + Local Fund) has been net buying for consecutive days. Replaces the slow per-R2-read MVP filter with a D1-backed pipeline.

### 15.2 Architecture

```
Queue Consumer (per scrape)
    └─ flow-aggregator.js → D1 `daily_broker_flow` (upsert)

Cron 15 12 * * 1-5 (19:15 WIB)
    └─ accum-preprocessor.js → R2 `cache/screener-accum-latest.json`

API
    └─ GET /screener-accum?window=2|5|10|20 → JSON
```

### 15.3 D1 Table: `daily_broker_flow`

| Column | Type | Description |
|--------|------|-------------|
| date | TEXT | YYYY-MM-DD |
| ticker | TEXT | Stock code |
| foreign_buy/sell/net | REAL | Foreign fund flow |
| local_buy/sell/net | REAL | Local fund flow |
| retail_buy/sell/net | REAL | Retail flow |
| smart_net | REAL | foreign_net + local_net |
| price | INT | Average price |
| total_value | TEXT | Total transaction value |
| broker_buy/sell_count | INT | Broker count |

Primary key: `(date, ticker)`. Indexes on `(ticker, date DESC)` and `(date)`.

Migration: `migrations/0005_create_daily_broker_flow.sql`

### 15.4 Flow Aggregator (`flow-aggregator.js`)

- Called after each successful scrape in queue consumer
- Classifies brokers via D1 `brokers.category` + IPOT `type` field
- Broker category cache with 10-minute TTL
- Exports: `aggregateAndStore(env, ticker, date, dailyOutput)`
- Non-blocking: errors are logged but don't fail the scrape

### 15.5 Accum Preprocessor (`accum-preprocessor.js`)

- Cron: `15 12 * * 1-5` (UTC 12:15 / 19:15 WIB)
- Queries last 30 calendar days from D1 `daily_broker_flow`
- Computes per-ticker, per-window (2D/5D/10D/20D) metrics:
  - `fn` — foreign net sum
  - `ln` — local net sum  
  - `rn` — retail net sum
  - `sm` — smart money net (fn + ln)
  - `streak` — consecutive days with sm > 0
  - `allPos` — every day in window had sm > 0
  - `pctChg` — price change % over window
- Writes to R2: `cache/screener-accum-latest.json`

### 15.6 API Endpoint (`/screener-accum`)

- Public endpoint in `api-saham`
- Query param: `?window=2|5|10|20` (default: 2)
- Merges accum data with z-score screener data
- Response: `{ items, date, window, availableWindows, total }`

### 15.7 Frontend

- Default mode: **Accum** (was "All")
- Mode selector: `All` | `Accum` (replaces old "MVP Filter")
- Timeframe pills (TradingView style): `2D` `5D` `10D` `20D`
- Active filter pill: "Smart Money > 0"
- New column: **Smart $** — shows net smart money flow with streak badges
- Default sort: Smart Money DESC in Accum mode
- Client-side filter: only `allPos === true` items shown

### 15.8 Cron Schedule (Updated)

| Cron | UTC | WIB | Mode |
|------|-----|-----|------|
| `0 */3 * * *` | Every 3h | - | Sweeping backfill |
| `0 11 * * *` | 11:00 | 18:00 | Daily rewrite |
| `0 12 * * 1-5` | 12:00 | 19:00 | Health check |
| `15 12 * * 1-5` | 12:15 | 19:15 | **Accum preprocessor** |

### 15.9 Implementation Files

| File | Action |
|------|--------|
| `migrations/0005_create_daily_broker_flow.sql` | NEW — D1 migration |
| `src/flow-aggregator.js` | NEW — queue post-processor |
| `src/accum-preprocessor.js` | NEW — cron preprocessor |
| `src/index.js` | MODIFIED — imports, queue wire, cron branch |
| `wrangler.jsonc` | MODIFIED — added cron |
| `api-saham/src/index.js` | MODIFIED — `/screener-accum` endpoint |
| `idx/emiten/broker-summary.html` | MODIFIED — filter bar UI |
| `idx/emiten/broker-summary.js` | MODIFIED — accum mode logic |

---

## 16. Screener Feature & Artifact Granularity Matrix

> This section maps **every artifact and feature** exposed on the screener frontend — where the data comes from, how it's computed, and which service generates it.

### 16.1 Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          DATA INGESTION LAYER                              │
│                                                                             │
│  IPOT WebSocket ──→ broksum-scrapper (Queue) ──→ R2:raw-broksum             │
│                           │                        {TICKER}/{DATE}.json     │
│                           ↓                                                 │
│                     flow-aggregator ──→ D1:daily_broker_flow                 │
│                                                                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                         PRE-PROCESSING LAYER                               │
│                                                                             │
│  features-service (Queue) ──→ D1:daily_features ──→ R2:features/{date}.json │
│  accum-preprocessor (Cron) ──→ R2:cache/screener-accum-latest.json          │
│  foreign-flow-scanner ──────→ R2:cache/foreign-flow-scan.json               │
│                                                                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                            API LAYER                                        │
│                                                                             │
│  api-saham: /screener-accum ──→ Merge accum + z-score → Frontend            │
│  api-saham: /screener ────────→ Z-score screener passthrough                │
│  api-saham: /foreign-sentiment → MVP 10 stock foreign flow                  │
│  api-saham: /footprint-scanner → Hybrid intraday + z-score                  │
│                                                                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                           FRONTEND LAYER                                    │
│                                                                             │
│  broker-summary.html: Filter (Strict/Smart/All) → Table [2D|5D|10D|20D]    │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 16.2 Accumulation Features (per ticker × per window)

Generated by `accum-preprocessor.js` → stored in R2 `cache/screener-accum-latest.json`

| Feature | Logic | Prereq Data | Generator Service |
|---------|-------|-------------|-------------------|
| `fn` (Foreign Net) | Σ `foreign_net` over window days | D1 `daily_broker_flow` | `broksum-scrapper/accum-preprocessor` |
| `ln` (Local Net) | Σ `local_net` over window days | D1 `daily_broker_flow` | `broksum-scrapper/accum-preprocessor` |
| `rn` (Retail Net) | Σ `retail_net` over window days | D1 `daily_broker_flow` | `broksum-scrapper/accum-preprocessor` |
| `sm` (Smart Money) | `fn + ln` | Derived from `fn`, `ln` | `broksum-scrapper/accum-preprocessor` |
| `streak` | Count consecutive recent days where `smart_net > 0` (walk backward from latest) | D1 `daily_broker_flow.smart_net` | `broksum-scrapper/accum-preprocessor` |
| `allPos` | Boolean: every day in window has `smart_net > 0` | D1 `daily_broker_flow.smart_net` | `broksum-scrapper/accum-preprocessor` |
| `foreignAllPos` | Boolean: every day in window has `foreign_net > 0` | D1 `daily_broker_flow.foreign_net` | `broksum-scrapper/accum-preprocessor` |
| `foreignDominant` | Boolean: cumulative `fn > 0` | Derived from `fn` | `broksum-scrapper/accum-preprocessor` |
| `days` | Actual trading days available in window (may be < window) | Row count | `broksum-scrapper/accum-preprocessor` |
| `pctChg` | `(lastPrice − firstPrice) / firstPrice × 100` | D1 `daily_broker_flow.price` | `broksum-scrapper/accum-preprocessor` |

**Windows**: `2`, `5`, `10`, `20` (trading days, taken as last N from 30 calendar days)

**Cron**: `15 12 * * 1-5` (UTC 12:15 / WIB 19:15)

### 16.3 Z-Score Features (per ticker × per window)

Generated by `features-service` queue consumer → stored in D1 `daily_features` + R2 `features/{date}.json`

| Feature | Logic | Prereq Data | Generator Service |
|---------|-------|-------------|-------------------|
| `z_effort` (e) | Z-score of volume effort, uses **D-1 shifted value** (yesterday's effort, today's context) | R2 `raw-broksum`, z-score history | `features-service` queue consumer |
| `z_result` (r) | Z-score of absolute price return `|close − prevClose| / prevClose` | R2 `raw-broksum` | `features-service` queue consumer |
| `z_ngr` (n) | Z-score of Net-to-Gross Ratio `(buyVal − sellVal) / (buyVal + sellVal)` | R2 `raw-broksum` | `features-service` queue consumer |
| `z_elas` (el) | Z-score of Elasticity `result / effort` (price response per unit flow) | Derived from `z_result`, `z_effort` | `features-service` queue consumer |

**Windows**: `5`, `10`, `20`, `60` (Z-score lookback periods)

**Trigger**: Queue message after each `broksum-scrapper` scrape, or `features-service` rebuild cron

### 16.4 State Classification

Generated by `features-service` → stored in D1 `daily_features.state`

| Feature | Logic | Prereq Data | Generator Service |
|---------|-------|-------------|-------------------|
| `state` (s) | Rules-based classifier using window-20 z-scores with D-1 effort shift | `z_effort`, `z_result`, `z_ngr`, `z_elas` | `features-service` queue consumer |

**State values**:

| State | Code | Rule |
|-------|------|------|
| ACCUMULATION | AC | High effort D-1 + stable/positive price today + positive NGR |
| DISTRIBUTION | DI | High effort D-1 + price drop today + negative NGR |
| READY_MARKUP | RM | Effort declining + stable result + high elasticity |
| TRANSITION | TR | High effort + small result (no clear direction) |
| NEUTRAL | NE | Default (no strong signal) |

### 16.5 Composite Scores

| Feature | Logic | Prereq Data | Generator Service |
|---------|-------|-------------|-------------------|
| `internal_score` (sc) | `z_effort × 1 + z_result × 1 + z_ngr × 1 + z_elas × 0.5` (window-20) | All 4 z-scores | `features-service` |
| `simpleScore` (Flow) | `effortBonus + stateBonus + ngrBonus` (frontend-computed) | `z_effort`, `state`, `z_ngr` | Frontend JS (client-side) |

### 16.6 Flow Aggregation (D1 daily_broker_flow)

Generated by `flow-aggregator.js` → stored in D1 `daily_broker_flow`

| Feature | Logic | Prereq Data | Generator Service |
|---------|-------|-------------|-------------------|
| `foreign_buy` / `sell` / `net` | Sum of broker records where `type='Asing'` OR D1 `brokers.category='foreign'` | R2 `raw-broksum`, D1 `brokers` | `broksum-scrapper/flow-aggregator` |
| `local_buy` / `sell` / `net` | Sum of broker records where `category='local_fund'` or non-retail local | R2 `raw-broksum`, D1 `brokers` | `broksum-scrapper/flow-aggregator` |
| `retail_buy` / `sell` / `net` | Sum of broker records where `category='retail'` | R2 `raw-broksum`, D1 `brokers` | `broksum-scrapper/flow-aggregator` |
| `smart_net` | `foreign_net + local_net` | Derived | `broksum-scrapper/flow-aggregator` |
| `price` | VWAP from `stock_summary.close` or average price | R2 `raw-broksum` | `broksum-scrapper/flow-aggregator` |

**Trigger**: Called non-blocking after each successful queue consumer scrape + `/backfill-flow` HTTP endpoint

### 16.7 Hybrid Footprint Features (Intraday)

Generated by `features-service` cron → stored in R2 `cache/footprint-summary-latest.json`

| Feature | Logic | Prereq Data | Generator Service |
|---------|-------|-------------|-------------------|
| `deltaPct` (dp) | `(cumDelta / totalVol) × 100` from intraday candles | D1 `temp_footprint_consolidate` | `features-service` |
| `pricePct` (pp) | `(lastClose − firstOpen) / firstOpen × 100` | D1 `temp_footprint_consolidate` | `features-service` |
| `volume` (v) | Σ candle volumes | D1 `temp_footprint_consolidate` | `features-service` |
| `absorption` (abs) | CVD-Price Divergence: `|normDelta − normPrice|` | Derived from `deltaPct`, `pricePct` | `features-service` |
| `hybridScore` | `0.7 × intradayScore + 0.3 × contextScore` × `divFactor` | Footprint + Z-score context | `features-service` |
| `signal` | Classification: STRONG_BUY / WATCH_ACCUM / RETAIL_TRAP / etc. | `hybridScore`, `state`, `divFactor` | `features-service` |
| `divType` | Divergence type: RETAIL_TRAP / SM_DIVERGENCE / SHAKEOUT / null | `state` vs intraday direction conflict | `features-service` |
| `divFactor` | Multiplier 0.5–1.2 based on divergence severity | Z-score `state` vs intraday `deltaPct` | `features-service` |

### 16.8 Foreign Sentiment (Market-Level)

| Feature | Logic | Prereq Data | Generator Service |
|---------|-------|-------------|-------------------|
| `cumulative.net` | Running sum of daily foreign net for MVP 10 stocks | R2 `raw-broksum` (10 hardcoded tickers) | `api-saham` (on-demand, cached 1h) |
| `foreignTrend` | Linear regression slope of cumulative foreign flow / 1e9 | R2 `raw-broksum` per ticker | `features-service` |
| `trendScore` | `abs(foreignTrend) × sign` clamped 0–4 | Derived from `foreignTrend` | `features-service` |

### 16.9 Operational / Quality Features

| Feature | Logic | Prereq Data | Generator Service |
|---------|-------|-------------|-------------------|
| Validator severity | Checks: price > 0, brokers non-empty, price anomaly < 35% vs prev day | R2 `raw-broksum` (current + prev day) | `broksum-scrapper/validator` |
| Health check score | Samples 60 emiten, runs validator, counts CRITICAL vs OK | R2 `raw-broksum`, validator | `broksum-scrapper/health-check` |
| Audit trail | Append-only log: `{ date, status, brokers, price }` per scrape | Queue consumer result | `broksum-scrapper` |

### 16.10 Frontend Screener Filter → Feature Mapping

This table maps each **filter option** on the screener UI to the underlying artifact field it gates on.

| Filter | Option | Gates On | Field Path | Window-Aware? |
|--------|--------|----------|------------|---------------|
| **Preset: Strict** | — | Foreign + Smart Money positive every day | `accum[w].foreignAllPos && accum[w].allPos` | ✅ Yes |
| **Preset: Smart** | — | Smart Money positive every day | `accum[w].allPos` | ✅ Yes |
| **Preset: All** | — | No accumulation filter | — | — |
| **Foreign Net** | `> 0 (Net Buy)` | Cumulative foreign positive | `accum[w].fn > 0` | ✅ Yes |
| **Foreign Net** | `> 0 Every Day` | Foreign positive each day | `accum[w].foreignAllPos` | ✅ Yes |
| **Foreign Net** | `< 0 (Net Sell)` | Cumulative foreign negative | `accum[w].fn < 0` | ✅ Yes |
| **Smart Money** | `> 0 (Accumulation)` | Cumulative SM positive | `accum[w].sm > 0` | ✅ Yes |
| **Smart Money** | `> 0 Every Day` | SM positive each day | `accum[w].allPos` | ✅ Yes |
| **Smart Money** | `< 0 (Distribution)` | Cumulative SM negative | `accum[w].sm < 0` | ✅ Yes |
| **Trend** | `Streak ≥ 3 hari` | Min consecutive sm > 0 days | `accum[w].streak >= 3` | ✅ Yes |
| **Trend** | `Trend 5D Up` | Acceleration short-term vs 5D baseline | `avg(sm2) > avg(sm5)` | ❌ Candidate-level |
| **Trend** | `Trend 10D Up` | 5D stronger vs 10D baseline | `avg(sm5) > avg(sm10)` | ❌ Candidate-level |
| **Trend** | `Trend 20D Up` | 10D stronger vs 20D baseline | `avg(sm10) > avg(sm20)` | ❌ Candidate-level |
| **Effort Rel** | `Any` / `2D>5D` / `2D>10D` / `2D>20D` / `5D>10D` / `5D>20D` / `10D>20D` / `2D≥5D≥10D≥20D` | Relational gate for effort z-score across horizons | `e2,e5,e10,e20` from `z[w].e` | ❌ Candidate-level |
| **NGR Rel** | `Any` / `2D>5D` / `2D>10D` / `2D>20D` / `5D>10D` / `5D>20D` / `10D>20D` / `2D≥5D≥10D≥20D` | Relational gate for NGR z-score across horizons | `n2,n5,n10,n20` from `z[w].n` | ❌ Candidate-level |
| **VWAP Rel** | `Any` / `2D>5D` / `2D>10D` / `2D>20D` / `5D>10D` / `5D>20D` / `10D>20D` / `2D≥5D≥10D≥20D` | Relational gate for VWAP z-score across horizons | `v2,v5,v10,v20` from `z[w].v` | ❌ Candidate-level |
| **Relation Combine** | Multiple dropdown aktif bersamaan | Semua gate relation harus lolos bersamaan | `passEffort && passNgr && passVwap` | ❌ Candidate-level |
| **Horizon** | `Any / 2D / 5D / 10D / 20D` | Selects which accumulation window is evaluated | `w ∈ {2,5,10,20}` | ✅ Yes |
| **Effort** | `High` / `Positif` | Effort z-score gate (legacy fixed) | `effort20 > 1` / `effort20 > 0` | ❌ Fixed W20 |
| **State** | `Accumulation` / `Accumulation + Ready Markup` | Z-score state classifier | `s` = AC / RM | ❌ Fixed W20 |
| **View (eye icon)** | `Show 2D/5D/10D/20D` | Controls visible table columns only | `.col-h{2|5|10|20}` show/hide | UI only |

### 16.11 R2 Artifact Storage Map

| R2 Bucket | Key Pattern | Written By | Content | TTL / Refresh |
|-----------|-------------|------------|---------|---------------|
| `raw-broksum` | `{TICKER}/{YYYY-MM-DD}.json` | `broksum-scrapper` queue | Raw broker summary per day | Permanent |
| `sssaham-emiten` | `cache/screener-accum-latest.json` | `accum-preprocessor` cron | All windows accum data | Daily 19:15 WIB |
| `sssaham-emiten` | `features/latest.json` | `features-service` cron | Pointer to daily z-score file | Daily |
| `sssaham-emiten` | `features/{date}.json` | `features-service` cron | Full z-score screener | Daily |
| `sssaham-emiten` | `features/history/{TICKER}.json` | `features-service` queue | Per-ticker z-score history (365d) | Per-scrape |
| `sssaham-emiten` | `cache/footprint-summary-latest.json` | `features-service` cron | Hybrid footprint screener | Periodic |
| `sssaham-emiten` | `cache/foreign-flow-scan.json` | `features-service` | Foreign flow trend scanner | Manual |
| `sssaham-emiten` | `cache/screener-mvp-*.json` | `api-saham` | MVP filtered cache | 1h TTL |
| `sssaham-emiten` | `cache/foreign-sentiment-*.json` | `api-saham` | Foreign sentiment cache | 1h TTL |
| `sssaham-emiten` | `cache/range-broksum-*.json` | `api-saham` | Range broker summary cache | 2-7d TTL |
| `sssaham-emiten` | `audit/{TICKER}.json` | `broksum-scrapper` | Scrape audit trail | Append, last 100 |

### 16.12 D1 Table Map

| Table | PK | Written By | Read By | Purpose |
|-------|----|-----------|---------|---------
| `daily_broker_flow` | `(date, ticker)` | `flow-aggregator` | `accum-preprocessor`, `api-saham` | Pre-aggregated foreign/local/retail flow |
| `daily_features` | `(date, ticker)` | `features-service` | `api-saham`, `features-service` | Z-score features per day |
| `brokers` | `code` | Seeded/manual | `flow-aggregator`, `api-saham` | Broker classification (foreign/local/retail) |
| `watchlist` | `code` | Seeded/manual | `broksum-scrapper` | Active scrape targets |
| `temp_footprint_consolidate` | `(date, ticker, time)` | External pipeline | `api-saham`, `features-service` | Intraday 1-min footprint candles |
| `scraping_logs` | auto-inc | `broksum-scrapper` | `api-saham` | Scrape audit log |
| `feature_logs` | auto-inc | `features-service` | Diagnostics | Feature computation log |

---

## 17. Broker Flow Chart (Per-Broker Cumulative Time Series)

### 17.1 Objective

> **Idea**: "Lihat secara granular SIAPA yang akumulasi dan SIAPA yang distribusi — bukan hanya kategori (Foreign/Local/Retail), tapi broker individual."
>
> Pada SmartMoney Flow chart yang sudah ada, user hanya melihat 3 garis agregat (Foreign, Retail, Local).
> Broker Flow chart menambah layer detail: **9 garis kumulatif** dari 3 broker teratas per kategori (Foreign, Local, Retail) sehingga user tahu apakah akumulasi didominasi oleh 1 broker besar atau tersebar merata.

### 17.2 Problem Statement

**Current State**:
- Detail view hanya punya 1 chart: SmartMoney Flow (Foreign/Retail/Local cumulative lines + daily bars + price)
- User tidak bisa melihat aktivitas broker individual dari waktu ke waktu
- Top broker table di bawah hanya menunjukkan total range, BUKAN time series pergerakannya

**Desired State**:
- Tambah sub-tab toggle di atas chart: **SmartMoney Flow** | **Broker Flow**
- Broker Flow menampilkan **line chart kumulatif** per broker individual (top 3 per kategori = 9 garis)
- Broker Flow menggunakan **cache terpisah** agar tidak memperberat response `/cache-summary`
- Tiap garis memiliki **colored circle + broker code** di ujung kanan sebagai legend

### 17.3 UI Design

```
┌──────────────────────────────────────────────────────┐
│  [SmartMoney Flow] [Broker Flow]     ← sub-tab toggle│
│                                                       │
│  ┌─────────────────────────────────────────────────┐ │
│  │                                                 │ │
│  │   ──── YP (green-1)                        ●YP  │ │
│  │     ──── ML (green-2)                      ●ML  │ │
│  │       ──── UB (green-3)                    ●UB  │ │
│  │                                                 │ │
│  │   ──── NI (blue-1)                         ●NI  │ │
│  │     ──── AM (blue-2)                       ●AM  │ │
│  │       ──── KK (blue-3)                     ●KK  │ │
│  │                                                 │ │
│  │   ──── PD (red-1)                          ●PD  │ │
│  │     ──── RX (red-2)                        ●RX  │ │
│  │       ──── SQ (red-3)                      ●SQ  │ │
│  │                                                 │ │
│  │  13/2  14/2  17/2  18/2  19/2  20/2  21/2      │ │
│  └─────────────────────────────────────────────────┘ │
│                                                       │
│  [Top 3] [Top 6] [Top 9]        ← broker count toggle│
│                                                       │
│  ● YP - JP Morgan    ● NI - Nikko    ● PD - Panin    │
│  ● ML - Merrill      ● AM - Mandiri  ● RX - Indo Prem│
│  ● UB - UBS          ● KK - Korea    ● SQ - Stockbit │
│  ← scrollable legend with colored circles             │
└──────────────────────────────────────────────────────┘
```

### 17.4 Sub-Tab Toggle Behavior

| Action | Result |
|--------|--------|
| Click "SmartMoney Flow" | Show existing `#detailChart` canvas, hide `#brokerFlowChart` |
| Click "Broker Flow" | Hide `#detailChart`, show `#brokerFlowChart`, lazy-init on first click |
| Default | SmartMoney Flow (existing behavior preserved) |

### 17.5 Data Source & API

**New Endpoint**: `GET /cache-summary/broker-daily?symbol=BBRI&from=YYYY-MM-DD&to=YYYY-MM-DD`

Terpisah dari `/cache-summary` untuk mengisolasi beban:
- `/cache-summary` tetap ringan (~5KB) untuk chart utama + broker table
- `/cache-summary/broker-daily` (~3-8KB) hanya di-fetch saat user klik "Broker Flow"

**Backend Logic** (inside `calculateRangeData` variant):
1. Loop through dates (same as existing)
2. Per day, track **per-broker net value** (bval - sval) per broker code
3. At the end, determine top 3 per category by **abs(total net)** over entire range
4. Return only those 9 brokers' daily series

**Response**:
```json
{
  "symbol": "BBRI",
  "from": "2026-02-13",
  "to": "2026-02-27",
  "brokers": [
    { "code": "YP", "name": "JP Morgan", "type": "foreign" },
    { "code": "ML", "name": "Merrill Lynch", "type": "foreign" },
    { "code": "UB", "name": "UBS", "type": "foreign" },
    { "code": "NI", "name": "Nikko", "type": "local" },
    { "code": "AM", "name": "Mandiri Sekuritas", "type": "local" },
    { "code": "KK", "name": "Korea Investment", "type": "local" },
    { "code": "PD", "name": "Panin Dana", "type": "retail" },
    { "code": "RX", "name": "Indo Premier", "type": "retail" },
    { "code": "SQ", "name": "Stockbit", "type": "retail" }
  ],
  "dates": ["2026-02-13", "2026-02-14", "2026-02-17", ...],
  "series": {
    "YP": [5000000, -2000000, 8000000, ...],
    "ML": [3000000, 1000000, -500000, ...],
    ...
  }
}
```

- `series[broker][i]` = **daily net value** (bval - sval) for that broker on `dates[i]`
- Frontend computes cumulative from daily values (same pattern as existing chart)

### 17.6 R2 Cache Key

| Key | Written By | TTL |
|-----|-----------|-----|
| `broker/daily/v1/{symbol}/{from}_{to}.json` | `api-saham` | 2 days (same as cache-summary) |

Separate R2 key prefix from `broker/summary/v5/` to avoid cache invalidation interference.

### 17.7 Frontend Chart Specification

| Property | Value |
|----------|-------|
| Type | Line Chart (Chart.js) |
| Canvas | `#brokerFlowChart` (new, inside `#broker-flow-chart-container`) |
| X-Axis | Date (DD/MM format, same as SmartMoney chart) |
| Y-Axis | Cumulative Net Value (IDR, formatted: "125M", "-45B") |
| Lines | 9 lines max (3 per category), configurable via Top 3/6/9 toggle |
| Foreign colors | `#16a34a` (dark), `#22c55e` (medium), `#86efac` (light) |
| Local colors | `#2563eb` (dark), `#3b82f6` (medium), `#93c5fd` (light) |
| Retail colors | `#dc2626` (dark), `#ef4444` (medium), `#fca5a5` (light) |
| Point style | `pointRadius: 0` for all points except last point |
| Last point | Colored circle (8px radius) at line endpoint |
| Legend | Custom HTML legend below chart with colored circles + broker code + name |
| Zero line | Dashed grey line at y=0 (same plugin as SmartMoney chart) |

### 17.8 Top N Toggle

| Button | Behavior |
|--------|----------|
| **Top 3** | Show only rank-1 broker from each category (3 lines) |
| **Top 6** | Show rank 1-2 from each category (6 lines) |
| **Top 9** | Show all 3 per category (9 lines, default) |

Toggle hides/shows Chart.js datasets by setting `dataset.hidden = true/false`, no re-fetch needed.

### 17.9 Cumulative Calculation (Frontend)

```javascript
// Same pattern as existing renderChart()
const cumulative = {};
brokers.forEach(b => { cumulative[b.code] = []; });

let accumulators = {};
brokers.forEach(b => { accumulators[b.code] = 0; });

dates.forEach((date, i) => {
    brokers.forEach(b => {
        const dailyNet = series[b.code]?.[i] || 0;
        accumulators[b.code] += dailyNet;
        cumulative[b.code].push(accumulators[b.code]);
    });
});
```

### 17.10 Edge Cases

| Case | Handling |
|------|---------|
| Broker has 0 activity on a date | Push 0, cumulative stays flat |
| Broker appears mid-range (IPO broker, new entrant) | Missing dates = 0, cumulative starts from first appearance |
| < 3 brokers in a category | Show whatever is available (e.g., 2 foreign + 3 local + 3 retail = 8 lines) |
| No broker data at all | Show "Belum ada data broker flow" message in chart area |
| Mobile (< 576px) | Chart height reduced to 200px, legend wraps to 2 rows |

### 17.11 Implementation Plan

| # | Task | File | Type |
|---|------|------|------|
| 1 | Add `GET /cache-summary/broker-daily` endpoint | `workers/api-saham/src/index.js` | BACKEND |
| 2 | Add R2 cache read/write for `broker/daily/v1/` | `workers/api-saham/src/index.js` | BACKEND |
| 3 | Add sub-tab toggle HTML (SmartMoney Flow / Broker Flow) | `idx/emiten/broker-summary.html` | FRONTEND |
| 4 | Add `#brokerFlowChart` canvas + legend container | `idx/emiten/broker-summary.html` | FRONTEND |
| 5 | Add Top 3/6/9 toggle buttons | `idx/emiten/broker-summary.html` | FRONTEND |
| 6 | Implement `fetchBrokerDailyData()` | `idx/emiten/broker-summary.js` | FRONTEND |
| 7 | Implement `renderBrokerFlowChart()` | `idx/emiten/broker-summary.js` | FRONTEND |
| 8 | Wire sub-tab toggle + lazy init | `idx/emiten/broker-summary.js` | FRONTEND |
| 9 | Add CSS for sub-tab active state + legend styling | `idx/emiten/broker-summary.html` | FRONTEND |

### 17.12 Performance Considerations

- **Lazy fetch**: `/cache-summary/broker-daily` is ONLY called when user clicks "Broker Flow" tab
- **Separate R2 cache**: Does not invalidate or increase size of existing `/cache-summary` cache
- **Client-side cumulative**: Daily net values are small arrays; cumulative computed in browser
- **No re-fetch on toggle**: Top 3/6/9 toggle only hides/shows datasets, no additional API call
- **Estimated response size**: ~3-8KB for 14-day range with 9 brokers (vs ~5KB for cache-summary)

---

*Document Version: 1.8*
*Created: 2026-02-10*
*Last Updated: 2026-02-27*
*Author: Copilot + mkemalw*
*Changelog: v1.8 — Added §17 Broker Flow Chart PRD: per-broker cumulative time series with separate cache, sub-tab toggle, Top 3/6/9, colored circle legend*
