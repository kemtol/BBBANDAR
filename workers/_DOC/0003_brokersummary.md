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

*Document Version: 1.0*
*Created: 2026-02-10*
*Author: Copilot + mkemalw*
