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

*Document Version: 1.3*
*Created: 2026-02-10*
*Last Updated: 2026-02-13*
*Author: Copilot + mkemalw*
*Changelog: v1.3 — Added Section 15: Accumulation Scanner (TradingView-Style)*
