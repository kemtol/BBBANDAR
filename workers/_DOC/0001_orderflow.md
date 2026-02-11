# Orderflow Scanner — Arsitektur & Metodologi

Dokumen ini merinci arsitektur pipeline, metodologi sinyal, formula scoring, dan checklist integritas data untuk sistem Orderflow Scanner SSSAHAM.

> **Objective & Non-Overfitting Statement**
> 
> **One Simple Idea**: *"Jika net buying tinggi tapi harga belum bergerak, ada tekanan beli tersembunyi yang akan mendorong harga naik."* — Prinsip **absorption** dari market microstructure.
> 
> **Non-Overfitting Evidence** (~90% confidence):
> - **2 input features only**: `deltaPct` (realtime) + `z_ngr` (historical) — tidak ada ratusan indikator
> - **Fixed weights (70/30)**: Dipilih berdasarkan domain knowledge, bukan optimized via backtesting
> - **Window 20-hari**: Standar industri untuk rolling z-score, bukan cherry-picked
> - **0 parameter tuning**: Threshold sinyal (0.7, 0.3, dst) adalah round numbers dari domain intuition
> - **Signal logic = 8 rules**: Cukup sederhana untuk di-audit manual, bukan black-box ML
> 
> *Risiko overfitting tersisa (~10%): Threshold price penalty (-4%, -5%) mungkin perlu validasi out-of-sample.*

---

## 0. Arsitektur Pipeline

### Diagram Alur Data

```
                         ┌──────────────────────┐
                         │  Trade Stream (Live)  │
                         └──────────┬───────────┘
                                    │
                                    ▼
                    ┌───────────────────────────────┐
                    │  Durable Object Engine (x7)   │
                    │  livetrade-durable-engine-1~7  │
                    └───────┬───────────┬───────────┘
                            │           │
               R2 write     │           │  Queue: livetrade-processed-queue
               (jsonl)      ▼           ▼
┌──────────────────────────────┐  ┌──────────────────────────────────┐
│ R2: tape-data-saham          │  │ livetrade-taping-agregator       │
│                              │  │  handleProcessedBatch()          │
│ footprint/{TICKER}/1m/       │  │  processIntradayMinute()         │
│   {YYYY}/{MM}/{DD}/{HH}.jsonl│  │   → R2 state: processed/        │
│                              │  │   → R2 public: intraday.json     │
└───────────────┬──────────────┘  └───────────┬────────────────────┘
                │                              │
                │                              │ Queue: livetrade-backfill-queue
                │                              │ (aggregate_batch)
                │                              ▼
                │                 ┌──────────────────────────────┐
                │                 │  livetrade-taping-agregator  │
                │                 │  processAggregationBatch()   │
                │                 │   → R2 read → D1 insert      │
                │                 └───────────┬────────────────┘
                │                              │
                │         ┌────────────────────┘
                │         ▼
                │  ┌──────────────────────────────────────────┐
                │  │ D1: temp_footprint_consolidate            │
                │  │ (ticker, date, time_key, OHLC, vol, delta)│
                │  └────────────────────┬─────────────────────┘
                │                       │
   R2 fallback  │                       │ Cron: */5 * * * *
   (kalau D1    │                       ▼
    kosong)     │  ┌──────────────────────────────────────────┐
                └─►│ features-service                         │
                   │  aggregateHybrid()                       │
                   │   L1: D1 footprint (atau R2 fallback)    │
                   │   L2: D1 daily_features (konteks D-1)    │
                   │   → Hitung Hybrid Score + Signal         │
                   │   → Tulis R2: footprint-summary.json     │
                   └────────────────────┬─────────────────────┘
                                        │
                                        ▼
                   ┌──────────────────────────────────────────┐
                   │ api-saham  GET /footprint/summary        │
                   │  1. Baca R2 footprint-summary.json       │
                   │  2. Kosong? → fallback: mundur 1-7 hari  │
                   │     query D1 calculateFootprintRange()   │
                   │  3. Return JSON ke frontend              │
                   └────────────────────┬─────────────────────┘
                                        │
                                        ▼
                   ┌──────────────────────────────────────────┐
                   │ Frontend: idx/emiten/index.html          │
                   │  → Fetch /footprint/summary              │
                   │  → Render tabel + bubble chart           │
                   │  → Auto-refresh setiap 60 detik          │
                   └──────────────────────────────────────────┘
```

### Tier Reliability

| Tier | Sumber | Dipakai Ketika | Latensi |
| :--- | :--- | :--- | :--- |
| **Tier 1** | D1 `temp_footprint_consolidate` | Normal flow, D1 punya ≥200 tickers | ~50ms |
| **Tier 2** | R2 `footprint/{T}/1m/...` langsung | D1 kosong/sparse (<200 tickers) atau `?source=r2` | ~15 detik |
| **Tier 3** | R2 `features/footprint-summary.json` cache | Summary sudah ditulis oleh cron */5 | ~30ms |
| **Fallback** | D1 calculateFootprintRange (hari sebelumnya) | Summary kosong, mundur 1-7 hari | ~200ms |

---

## 1. Metodologi Sinyal (Buy/Sell)

### A. Sinyal Akumulasi (Buy)
Digunakan untuk mendeteksi emiten dengan tren akumulasi yang stabil oleh Smart Money.
- **State**: Harus berada dalam fase `ACCUMULATION` (berdasarkan Z-Score dan State Regime).
- **Z-Score**: Menggunakan window jangka panjang (**Window 20**) untuk validitas tren.
- **Volume**: Adanya volume perdagangan yang signifikan dan konsisten.
- **Delta**: Mengindikasikan dominasi beli yang kuat sejalan dengan akumulasi.

### B. Analisis Volatilitas (Range & Fluctuation)
Selain arah pergerakan (Delta), intensitas pergerakan harga juga dianalisis untuk melihat peluang:
- **Range**: Selisih nominal `High - Low` dalam periode berjalan.
- **Fluctuation (%)**: Persentase `((High - Low) / Low) * 100`. Menunjukkan volatilitas relatif.

### C. Sinyal Continues (Sell Tomorrow)
Digunakan untuk mendeteksi emiten dengan momentum jangka pendek tinggi yang berpotensi untuk *buy today sell tomorrow*.
- **State**: Cenderung `DISTRIBUTION` atau `TRANSITION`.
- **Z-Score**: Menunjukkan anomali distribusi/aktivitas dalam jangka pendek.

---

## 2. Strategi Prediksi Pergerakan Harga (Next-Day Prediction)

Berdasarkan literatur analisis finansial, sistem menggunakan pendekatan **CVD-Price Divergence (Absorption Score)** sebagai indikator leading.

### A. Konsep Absorption & Pressure
Predictive Power utama kita ada pada identifikasi **Intensitas Divergensi** (CVD vs Harga):
- **🚀 Breakout Potential (Absorption)**: Jika **CVD Positif** (Buy Aggression) tinggi tapi **Harga Sideways**. Ini indikasi akumulasi agresif (Smart Money "menelan" semua barang dari seller retail).
- **⚠️ Heavy Sell (Distribution)**: Jika **CVD Negatif** (Sell Aggression) tinggi tapi **Harga Sideways/Tertahan**. Ini indikasi jualan masif (Smart Money "membuang" barang ke dalam antrian bid retail).

### B. Rumusan Prediksi (ABS(CVD) / Absorption Score)
```
ABS(CVD) = abs(delta_pct) / (1 + abs(price_pct))
```

- **Skor Tinggi**: Menunjukkan adanya anomali volume (CVD) yang tidak sebanding dengan pergerakan harga (Divergensi).
- **Arah (Label)**:
    - Jika `deltaPct > 0` → **Breakout**.
    - Jika `deltaPct < 0` → **Heavy Sell**.

**Integrasi CVD**:
- **Intraday (Live)**: Represented by `deltaPct` (Net Delta akumulatif sesi berjalan).
- **Historical (D-1 Context)**: Represented by `ctx_net` / `z_ngr` (Z-score flow akumulatif kemarin dari D1).

---

## 3. Formula Scoring

### A. Hybrid Score (features-service — Cron Aggregator)

Digunakan saat `features-service` cron `*/5` menulis `footprint-summary.json`.

```
deltaPct   = (total_delta / total_vol) × 100
pricePct   = ((close - open) / open) × 100

normZNGR   = normalize(hist_z_ngr, -3, +3)      // Konteks historical
normDelta  = normalize(deltaPct, -100, +100)     // Realtime delta

hybridScore = (0.3 × normZNGR) + (0.7 × normDelta)

// Penalty & Bonus
if pricePct < -4  → hybridScore *= 0.5    // Falling knife penalty
if -1 ≤ pricePct ≤ 2  → hybridScore *= 1.1  // Consolidation bonus (sweet spot)

hybridScore = min(1, hybridScore)
```

### B. Hybrid Score (api-saham — On-Demand /footprint/range)

Digunakan saat `api-saham` menghitung via `calculateFootprintRange()`.

```
normDelta  = normalize(deltaPct, -25, +25)
normPrice  = normalize(pricePct, -5, +5)

rtScore    = (0.7 × normDelta) + (0.3 × normPrice)     // Realtime 70%

normZNGR   = normalize(hist_z_ngr, -3, +3)
if hist_state == 'ACCUMULATION'  → normZNGR += 0.1
if hist_state == 'DISTRIBUTION'  → normZNGR -= 0.1
histScore  = clamp(0, 1, normZNGR)                      // Historical 30%

hybridScore = (0.7 × rtScore) + (0.3 × histScore)
```

> **Catatan**: Kedua formula sedikit berbeda normalization range-nya. features-service pakai range yang lebih lebar (`-100..+100` vs `-25..+25`) karena ditulis untuk semua saham termasuk yang illiquid.

### C. Signal Logic (Prioritas Tertinggi ke Terendah)

| Prioritas | Sinyal | Kondisi |
| :--- | :--- | :--- |
| 0 | `SELL` | `pricePct < -5` (falling knife) |
| 1 | `STRONG_BUY` | `score > 0.7` + `ACCUMULATION` + `pricePct ≥ -2` |
| 2 | `TRAP_WARNING` | `deltaPct > 80` + `hist_z_ngr < -0.5` |
| 3 | `HIDDEN_ACCUM` | `deltaPct < 40` + `hist_z_ngr > 0.7` + `ACCUMULATION` |
| 4 | `STRONG_SELL` | `score < 0.3` + `DISTRIBUTION` |
| 5 | `BUY` | `score > 0.6` + `pricePct ≥ -3` |
| 6 | `SELL` | `score < 0.4` |
| 7 | `WATCH_ACCUM` | Tidak ada konteks + `normDelta > 0.8` + `score > 0.6` + `pricePct ≥ -3` |
| default | `NEUTRAL` | |

### D. Frontend Prediction Label

| Label | Warna | Kondisi |
| :--- | :--- | :--- |
| `BREAKOUT` | 🟢 Hijau | `div > 5` + `money > 2` + `momentum ≥ -3` |
| `FALLING` | 🔴 Merah | `momentum < -5` |
| `HEAVY SELL` | 🔴 Merah | `div > 5` + `money < -2` |
| `WATCHING` | 🔵 Biru | `div > 3` + `momentum ≥ -3` |
| default | Abu | signal label dari backend |

---

## 4. Pengolahan & Penyaringan Data

### A. Komponen Data Utama
1. **Raw Data (Broksum)**: R2 `RAW_BROKSUM/{ticker}/{date}.json`
2. **Historical Features (Trailing)**: R2 `SSSAHAM_EMITEN/features/z_score/emiten/{ticker}.json`
3. **Daily Features**: D1 `daily_features` & R2 `features/z_score/daily/{date}.json`

### B. Proses Analisis
- **JOIN Pipeline**: Menggabungkan data intraday (Raw) dengan Context (Daily Features D-1).
- **Velocity Score**: Fokus pengembangan berikutnya untuk mengukur kecepatan Delta masuk dalam 1 jam terakhir.

---

## 4A. Fallback Chain — 3 Layer Detail

Sistem memiliki **3 layer fallback** yang saling mendukung untuk memastikan data selalu tersedia:

### Layer 1: Pre-Fallback (R2 Cache)

```
Frontend → api-saham /footprint/summary
              ↓
         R2: features/footprint-summary.json
              ↓
         Ada & items > 0? ✅ Return langsung
                          ❌ → Layer 2
```

File ini ditulis oleh `features-service` setiap **5 menit** (cron `*/5 * * * *`). Selama pipeline normal berjalan, ini yang di-serve ke frontend.

### Layer 2: Fallback D1 (7-Day Lookback)

```
R2 cache kosong/items=0
              ↓
Loop: for daysBack = 1..7 (skip weekend)
              ↓
   D1: calculateFootprintRange(tryDate, tryDate)
       SELECT ... FROM temp_footprint_consolidate
       WHERE date = tryDate
       GROUP BY ticker
              ↓
   items > 0? ✅ Return dengan status: "FALLBACK"
              ❌ → coba hari sebelumnya
              ↓
   7 hari habis, semua kosong → Layer 3
```

### Layer 3: NO_DATA Response

```
{
  "status": "NO_DATA",
  "reason": "WEEKEND_NO_DATA" atau "NO_DATA",
  "message": "No recent trading data found in last 7 days.",
  "items": []
}
```

### Di Dalam features-service (Sumber R2 Cache)

`features-service` juga punya fallback internal saat menulis cache:

```
aggregateHybrid() → fetchFootprintAggregates()
              ↓
         D1 query temp_footprint_consolidate
              ↓
   results > 200 tickers? ✅ Pakai D1
   results = 0?           ❌ → R2 Fallback
   results < 200?         ❌ → R2 Fallback (sparse)
   ?source=r2?            ❌ → R2 Fallback (force)
              ↓
         fetchFootprintFromR2()
         (Multi-hour discovery strategy)
```

### Diagram Lengkap Fallback Chain

```
┌─────────────────────────────────────────────────────────────────┐
│                    FRONTEND REQUEST                             │
│                 GET /footprint/summary                          │
└─────────────────────────┬───────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────────┐
│ LAYER 0: R2 CACHE (Pre-fallback)                                │
│ api-saham → R2.get("features/footprint-summary.json")           │
│                                                                 │
│ ✅ Ada & items > 0 → Return langsung (TTL 30s)                  │
│ ❌ Kosong/items=0  → Continue to Layer 1                        │
└─────────────────────────┬───────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────────┐
│ LAYER 1: D1 FALLBACK (7-Day Lookback)                           │
│ api-saham → calculateFootprintRange(date-1, date-1)             │
│          → calculateFootprintRange(date-2, date-2)              │
│          → ... sampai 7 hari (skip weekend)                     │
│                                                                 │
│ ✅ Ada items → Return status:"FALLBACK", reason:"Using X days"  │
│ ❌ 7 hari semua kosong → Continue to Layer 2                    │
└─────────────────────────┬───────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────────┐
│ LAYER 2: NO_DATA RESPONSE                                       │
│ Return { status: "NO_DATA", items: [] }                         │
└─────────────────────────────────────────────────────────────────┘

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

┌─────────────────────────────────────────────────────────────────┐
│              FEATURES-SERVICE (Cron */5)                        │
│                aggregateHybrid()                                │
└─────────────────────────┬───────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────────┐
│ PRIMARY: D1 QUERY                                               │
│ SELECT ticker, SUM(vol), SUM(delta), ...                        │
│ FROM temp_footprint_consolidate WHERE date = today              │
│ GROUP BY ticker                                                 │
│                                                                 │
│ ✅ results ≥ 200 tickers → Pakai D1, tulis R2 cache             │
│ ❌ results = 0 atau < 200 → Trigger R2 Fallback                 │
└─────────────────────────┬───────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────────┐
│ R2 FALLBACK: fetchFootprintFromR2()                             │
│ 1. List R2 prefix "footprint/" → ~168 tickers                   │
│ 2. Round 1: Probe jam 03 untuk semua (~147 found)               │
│ 3. Round 2: Probe jam lain untuk yg belum ketemu                │
│ 4. Aggregate OHLCV dari candles                                 │
│ 5. Self-healing: Backfill ke D1                                 │
│                                                                 │
│ → Tulis R2 cache dengan data dari R2 langsung                   │
└─────────────────────────────────────────────────────────────────┘
```

---

## 4B. Z-Score Context Pipeline

### Sumber Data: Broker Summary

Z-Score dihitung dari **Broker Summary** — data akumulasi/distribusi per broker per hari.

```
┌──────────────────────────────────────────┐
│ R2: raw-broksum/{TICKER}/{date}.json     │
│                                          │
│ Data per broker:                         │
│ - code: "YP" (broker code)               │
│ - tval, tbuy, tsell (value)              │
│ - bvol, svol (lot)                       │
│ - bavg, savg (avg price)                 │
│ - category: "Asing", "Retail", "Institusi"
└──────────────────────────┬───────────────┘
                           ↓
```

### Proses Perhitungan (SmartMoney Engine)

```
features-service Queue Consumer
       ↓
SmartMoney.processSingleDay(ticker, date, rawData, history)
       ↓
┌──────────────────────────────────────────────────────────────┐
│ 1. Hitung Net Growth Rate (NGR)                              │
│    NGR = (totalBuy - totalSell) / totalVol                   │
│                                                              │
│ 2. Z-Score Window 20 hari                                    │
│    z_ngr = (NGR_today - mean(NGR_20d)) / stddev(NGR_20d)     │
│                                                              │
│ 3. State Classification                                      │
│    - ACCUMULATION: z_ngr > 0.5 + consistent buy              │
│    - DISTRIBUTION: z_ngr < -0.5 + consistent sell            │
│    - NEUTRAL: otherwise                                      │
│                                                              │
│ 4. Z-Score lainnya (effort, result, elasticity)              │
│    - z_effort: Z-score volume effort                         │
│    - z_result: Z-score price result                          │
│    - z_elas: Effort/Result elasticity                        │
└──────────────────────────┬───────────────────────────────────┘
                           ↓
┌──────────────────────────────────────────────────────────────┐
│ OUTPUT: Simpan ke 2 tempat                                   │
│                                                              │
│ 1. R2: features/z_score/emiten/{TICKER}.json                 │
│    - history[] array (last 365 days)                         │
│    - Untuk rebuild & time-series analysis                    │
│                                                              │
│ 2. D1: daily_features                                        │
│    - date, ticker, state, z_ngr, z_effort, ...               │
│    - Untuk JOIN cepat saat aggregation                       │
└──────────────────────────────────────────────────────────────┘
```

### D1 Schema `daily_features`

```sql
CREATE TABLE daily_features (
    date TEXT NOT NULL,
    ticker TEXT NOT NULL,
    state TEXT,           -- 'ACCUMULATION' | 'DISTRIBUTION' | 'NEUTRAL'
    score REAL,           -- internal_score dari SmartMoney
    z_effort REAL,        -- Z-score effort (volume)
    z_result REAL,        -- Z-score result (price)
    z_ngr REAL,           -- Z-score Net Growth Rate ← DIPAKAI SCORING
    z_elas REAL,          -- Z-score elasticity
    metrics_json TEXT,    -- Full JSON untuk debug
    created_at TIMESTAMP,
    PRIMARY KEY (date, ticker)
);
```

### Cara Context Dipakai di Scoring

```javascript
// features-service: fetchLatestContext(date)
// Ambil tanggal TERAKHIR sebelum hari ini yang punya data

SELECT MAX(date) as ctx_date 
FROM daily_features 
WHERE date < '2026-02-10'  -- Misal hari ini 10 Feb
→ ctx_date = '2026-02-07'   -- Jumat kemarin (skip weekend)

SELECT ticker, state as hist_state, z_ngr as hist_z_ngr
FROM daily_features
WHERE date = '2026-02-07'
→ 500+ rows dengan context per ticker
```

```javascript
// features-service: calculateHybridItem()

// Footprint hari ini (realtime)
deltaPct = (total_delta / total_vol) × 100     // e.g. +15%

// Context kemarin (historical)
hist_z_ngr = context.hist_z_ngr                // e.g. +1.2
hist_state = context.hist_state                // e.g. "ACCUMULATION"

// Normalize
normZNGR  = normalize(hist_z_ngr, -3, +3)      // 0-1 range
normDelta = normalize(deltaPct, -100, +100)    // 0-1 range

// Final Score
hybridScore = (0.3 × normZNGR) + (0.7 × normDelta)
//            └── 30% historical  └── 70% realtime
```

### Kenapa Context Penting?

| Skenario | deltaPct | hist_z_ngr | hist_state | Hasil |
|---|---|---|---|---|
| Fresh markup tanpa history | +10% | 0 | NEUTRAL | score ~0.6, signal: BUY |
| Confirmed accumulation | +10% | +1.5 | ACCUMULATION | score ~0.75, signal: **STRONG_BUY** |
| Trap (high delta, bad history) | +85% | -1.0 | DISTRIBUTION | signal: **TRAP_WARNING** |
| Hidden gem (low delta, good history) | +30% | +2.0 | ACCUMULATION | signal: **HIDDEN_ACCUM** |

Context memberikan **validasi historis** terhadap sinyal intraday. Emiten dengan history bagus mendapat boost, emiten dengan history distribusi tetap diwaspadai meskipun delta tinggi.

---

## 5. Schema & Key Pattern

### A. D1 Schema — `temp_footprint_consolidate`

```sql
CREATE TABLE IF NOT EXISTS temp_footprint_consolidate (
    ticker TEXT NOT NULL,       -- e.g. 'BBCA'
    date TEXT NOT NULL,         -- '2026-02-04' (partisi harian)
    time_key INTEGER NOT NULL,  -- Unix ms (e.g. 1770170400000)
    open REAL, high REAL, low REAL, close REAL,
    vol REAL,
    delta REAL,                 -- Net Volume (Buy - Sell)
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (ticker, time_key)
);
CREATE INDEX idx_temp_footprint_date_ticker
    ON temp_footprint_consolidate(date, ticker);
```

Retensi: **3 hari** (cleanup acak 5% chance per batch job).

### B. D1 Schema — `job_checkpoint`

```sql
CREATE TABLE IF NOT EXISTS job_checkpoint (
    job_id TEXT PRIMARY KEY,    -- 'agg_hour_2026-02-04_09'
    date TEXT NOT NULL,
    hour INTEGER NOT NULL,
    total_tickers INTEGER DEFAULT 0,
    processed_tickers INTEGER DEFAULT 0,
    status TEXT DEFAULT 'PENDING', -- PENDING | PROCESSING | COMPLETED
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

### C. D1 Tabel Lain (Reference)

| Tabel | Kolom Penting | Dipakai Oleh |
| :--- | :--- | :--- |
| `emiten` | `ticker`, `status` (`ACTIVE`) | features-service (daftar ticker) |
| `daily_features` | `ticker`, `date`, `state` (hist_state), `z_ngr` (hist_z_ngr) | Konteks L2 untuk scoring |
| `brokers` | `code`, `category` | api-saham (deteksi retail/asing) |

### D. R2 Key Pattern

| Pattern | Writer | Reader |
| :--- | :--- | :--- |
| `footprint/{T}/1m/{Y}/{M}/{D}/{HH}.jsonl` | Durable Object Engine | features-service, api-saham, taping-agregator |
| `processed/{T}/state.json` | taping-agregator (realtime) | taping-agregator |
| `processed/{T}/intraday.json` | taping-agregator (realtime) | Frontend (Tier 2 fallback) |
| `features/footprint-summary.json` | features-service (cron */5) | api-saham (/footprint/summary) |
| `raw_lt/{Y}/{M}/{D}/{HH}/...` | Durable Objects | taping-agregator (backfill) |
| `health/cron_state.json` | cron-checker | cron-checker |
| `debug/hybrid_crash.txt` | features-service | debug |

### E. Footprint 1-min Candle Schema (NDJSON)

```json
{
  "t0": 1770344400000,
  "ohlc": { "o": 1325, "h": 1330, "l": 1320, "c": 1325 },
  "vol": 112,
  "delta": -112,
  "levels": [{ "p": 1325, "bv": 0, "av": 112 }]
}
```

### F. Summary Item Schema (API Output)

```json
{
  "t": "BBCA",       // ticker
  "d": 15.2,         // deltaPct (Net Delta %)
  "p": 1.3,          // pricePct (Price Change %)
  "v": 50000,        // total volume (lot)
  "h": 9200,         // high
  "l": 9100,         // low
  "r": 100,          // range (h - l)
  "f": 1.09,         // fluktuasi % ((h-l)/l × 100)
  "div": 8.5,        // absorption score (ABS(CVD))
  "ctx_net": 1.2,    // historical z-score (D-1)
  "ctx_st": "ACCUMULATION", // historical state
  "sc": 0.782,       // hybrid score (0-1)
  "sig": "STRONG_BUY"       // signal label
}
```

---

## 6. Worker Reference

### A. features-service

| | |
| :--- | :--- |
| **Wrangler** | `workers/features-service/wrangler.jsonc` |
| **Cron** | `30 11 * * 1-5` (dispatch), `45 11 * * 1-5` (aggregate daily), `*/5 * * * *` (footprint) |
| **Bindings** | `SSSAHAM_DB` (D1), `SSSAHAM_EMITEN` (R2), `TAPE_DATA_SAHAM` (R2), `FEATURES_QUEUE` (Queue) |

| Endpoint | Deskripsi |
| :--- | :--- |
| `GET /aggregate?date=` | Trigger aggregasi daily manual |
| `GET /aggregate-footprint?date=&hour=&source=r2` | Trigger aggregasi footprint manual. `source=r2` bypass D1. |
| `GET /trigger-all?date=` | Full daily pipeline (async) |
| `GET /rebuild-history?ticker=` | Rebuild history single ticker |
| `GET /rebuild-all` | Batch rebuild semua via queue |
| `GET /integrity-scan?ticker=` | Cek gaps D-1 s/d D-90 |
| `GET /diag/r2-coverage?date=` | Diagnostic: cek berapa ticker punya file R2 hari itu |

**R2 Fallback (`fetchFootprintFromR2`) — UPDATED:**

Dipanggil ketika:
- D1 kosong untuk tanggal tersebut, ATAU
- D1 punya < 200 tickers (sparse), ATAU
- URL param `?source=r2` (force)

**Strategi Multi-Hour Discovery (budget 1000 R2 reads):**

```
┌────────────────────────────────────────────────────────────────┐
│ 1. LIST ticker dari R2 prefix "footprint/" (paginated, ~5 hal) │
│    → Dapat ~168 valid tickers (4-char, A-Z0-9)                 │
│    → Fallback: tabel `emiten` jika R2 list gagal               │
└───────────────────────────┬────────────────────────────────────┘
                            ↓
┌────────────────────────────────────────────────────────────────┐
│ 2. ROUND 1: Probe jam 03 UTC (10:00 WIB) untuk SEMUA tickers   │
│    Key: footprint/{T}/1m/{Y}/{M}/{D}/03.jsonl                  │
│    → ~168 reads, ~147 ditemukan                                │
└───────────────────────────┬────────────────────────────────────┘
                            ↓
┌────────────────────────────────────────────────────────────────┐
│ 3. ROUND 2: Untuk yang BELUM ketemu, probe jam lain            │
│    Urutan: 06, 02, 04, 05, 07, 08, 09 (likelihood order)       │
│    → Stop ketika total reads mencapai 950                      │
│    → Saham sepi pagi yang aktif sore bisa ditemukan            │
└───────────────────────────┬────────────────────────────────────┘
                            ↓
┌────────────────────────────────────────────────────────────────┐
│ 4. AGGREGATE: Parse NDJSON, dedupe by t0, hitung OHLCV         │
│    → Output: [{ticker, total_vol, total_delta, OHLC, ...}]     │
└───────────────────────────┬────────────────────────────────────┘
                            ↓
┌────────────────────────────────────────────────────────────────┐
│ 5. BACKFILL D1 (self-healing): INSERT ke temp_footprint_       │
│    consolidate (max 2000 rows, chunk 5)                        │
│    → Next run pakai D1 path (lebih cepat)                      │
└────────────────────────────────────────────────────────────────┘
```

**Kenapa jam 03 UTC dipilih untuk Round 1?**
- Jam 03 UTC = 10:00 WIB = **peak session 1** (after pre-opening)
- Mayoritas emiten aktif trading di jam ini
- Saham yang sepi pagi (e.g. third-liner, warrant base) dicari di jam lain via Round 2

### B. api-saham

| | |
| :--- | :--- |
| **Wrangler** | `workers/api-saham/wrangler.jsonc` |
| **Bindings** | `SSSAHAM_DB` (D1), `SSSAHAM_EMITEN` (R2), `RAW_BROKSUM` (R2), `FOOTPRINT_BUCKET` (R2) |

| Endpoint | Deskripsi |
| :--- | :--- |
| `GET /footprint/summary` | Data bubble chart (dari R2 cache, fallback D1 7 hari) |
| `GET /footprint/range?from=&to=` | Aggregate range custom (langsung D1) |
| `GET /footprint-raw-hist?kode=&date=` | Raw 1m footprint dari R2 |
| `GET /range?symbol=&start=&end=` | Broker summary range |

**Fallback /footprint/summary:**
1. Baca `features/footprint-summary.json` dari R2
2. Kalau kosong/items=0 → loop mundur 1-7 hari (skip weekend)
3. Tiap hari: `calculateFootprintRange(date, date)` → D1 query
4. Pertama yang punya data → return `status: "FALLBACK"`
5. Semua gagal → `status: "NO_DATA"`

### C. livetrade-taping-agregator

| | |
| :--- | :--- |
| **Wrangler** | `workers/livetrade-taping-agregator/wrangler.toml` |
| **Queue** | Consumer: `livetrade-backfill-queue`, `livetrade-processed-queue` |
| **Bindings** | `DATA_LAKE` (R2 tape-data-saham), `SSSAHAM_DB` (D1), `BACKFILL_QUEUE` (Queue) |

| Endpoint | Deskripsi |
| :--- | :--- |
| `POST /footprint-hourly-dump?date=&hour=&filter_prefix=` | Dispatch aggregasi R2→D1 per jam |
| `POST /run?force=&date=` | Trigger daily cron manual |
| `POST /repair-footprint?kode=&date=` | Repair footprint broken ticker |
| `POST /seed-all?date=` | Seed semua jam untuk tanggal |
| `POST /seed-hour?date=&hour=` | Seed satu jam |
| `GET /signal?kode=` | Realtime signal per ticker |

**Data flow `processAggregationBatch`:**
1. Baca R2: `footprint/{ticker}/1m/{Y}/{M}/{D}/{HH}.jsonl` (parallel 10)
2. Parse NDJSON → collect `{ticker, date, time_key, OHLC, vol, delta}`
3. D1 bulk insert (chunk 5): `INSERT OR REPLACE INTO temp_footprint_consolidate`
4. Cleanup retention (5% chance): hapus data > 3 hari
5. Update `job_checkpoint` → kalau selesai, mark `COMPLETED`

### D. cron-checker

| | |
| :--- | :--- |
| **Wrangler** | `workers/cron-checker/wrangler.toml` |
| **Cron** | `* * * * *` (setiap menit) |

Orkestrator terpusat. Setiap menit cek apakah worker terdaftar sudah waktunya trigger.

| Worker | Interval | Cara Trigger |
| :--- | :--- | :--- |
| `livetrade-taping-agregator` | 3600s (1 jam) | Service binding → `/footprint-hourly-dump` |
| `livetrade-taping` | 60s | HTTP keep-alive |
| `features-service` | 900s (15 menit) | Service binding |

State disimpan di R2: `health/cron_state.json`.

---

## 7. Data Integrity Checklist

| Jalur | Komponen | Cek Cepat | Gagal Jika |
| :--- | :--- | :--- | :--- |
| **A. Daily** | Raw Per Ticker | HEAD check untuk `{date}` | Job skip/no update |
| **A. Daily** | Trailing History | Cek `history.length >= 20` | State tidak stabil |
| **B. Intraday** | Footprint Table | `SELECT COUNT(DISTINCT ticker) FROM temp_footprint_consolidate WHERE date = ?` | Hasil < 50 tickers |
| **B. Intraday** | Context (D-1) | `SELECT MAX(date) FROM daily_features WHERE date < ?` | `ctx_found=false` |
| **C. Pipeline** | R2 footprint files | Cek `footprint/{T}/1m/{Y}/{M}/{D}/03.jsonl` exists | R2 listing kosong |
| **C. Pipeline** | Summary freshness | `footprint-summary.json` → `generated_at` | Lebih dari 10 menit lalu |
| **D. Fallback** | D1 sparse check | `COUNT(DISTINCT ticker)` < 50 | Auto-trigger R2 fallback |

### Completeness Check (Market Hours)

- **Market**: 09:00 – 16:00 WIB (02:00 – 09:00 UTC)
- **Full session**: 7 jam = 420 menit = **84 candles** (per 5-min) atau **420 candles** (per 1-min)
- **Sparse threshold**: 50% dari expected (terima saham illiquid seperti CASA)
- **Stale check**: Lag > 20 menit saat jam market = warning

> [!IMPORTANT]
> Indikator **🚀 Breakout** akan muncul di UI jika `divScore > 5` dan `deltaPct > 2%` dan `pricePct ≥ -3%`.

---

## 8. Troubleshooting

### Dashboard Kosong (NO_DATA)

```
Cek 1: curl api-saham/footprint/summary → status?
  ├─ "OK" + items > 0       → Frontend issue (JS error, filter terlalu ketat)
  ├─ "FALLBACK" + items > 0  → Pipeline putus tapi fallback bekerja
  ├─ "NO_DATA"               → Lanjut ke Cek 2
  └─ Error/timeout            → Worker down atau cold start

Cek 2: curl api-saham/footprint/range?from={today}&to={today}
  ├─ items > 0  → D1 punya data, masalah di R2 cache (features-service cron)
  └─ items = 0  → Lanjut ke Cek 3

Cek 3: Cek R2 footprint files ada?
  ├─ Ada → R2→D1 pipeline putus (cron-checker / taping-agregator)
  │        Fix: POST /footprint-hourly-dump?date=YYYY-MM-DD&hour=HH&filter_prefix=
  │        atau: trigger features-service/aggregate-footprint?date=&source=r2 (auto R2 fallback)
  └─ Kosong → Upstream (Durable Objects) tidak menulis data
             Cek: livetrade-taping aktif? Token RPA valid?
```

### Partial Data (< 200 Tickers)

Sistem otomatis trigger R2 fallback jika D1 < 200 tickers. Tapi jika masih partial:

1. **Cek R2 coverage aktual:**
   ```bash
   curl "https://features-service.mkemalw.workers.dev/diag/r2-coverage?date=2026-02-10"
   ```
   Response menunjukkan berapa ticker punya file R2 vs berapa yang ditemukan.

2. **Cek tabel `emiten`:**
   ```sql
   SELECT COUNT(*) FROM emiten WHERE status='ACTIVE'
   ```
   Jika < 100, tabel belum di-seed. R2 listing akan dipakai sebagai fallback.

3. **Budget R2 reads**: Max ~950 per invocation (CF Workers limit 1000 subrequests). Jika ada 500+ tickers di R2, tidak semua bisa di-probe dalam 1 run.

### Score Semua NEUTRAL atau ctx_found=false

Berarti `daily_features` tidak punya data historis. Cek:

```bash
# Tanggal terakhir yang punya context
curl "sql: SELECT MAX(date) FROM daily_features"
```

Jika tanggal terlalu lama (> 7 hari), semua ticker akan `ctx_found=false` → fallback ke `WATCH_ACCUM` atau `NEUTRAL`.

**Fix:**
```bash
curl "https://features-service.mkemalw.workers.dev/trigger-all?date=2026-02-10"
```
Ini akan:
1. Dispatch job ke queue untuk semua ticker
2. Process broker summary dari R2
3. Hitung Z-Score dan state
4. Insert ke `daily_features`

### Data Stale (generated_at > 10 menit)

```bash
curl -s "https://api-saham.mkemalw.workers.dev/footprint/summary" | jq '.generated_at'
```

Jika terlalu lama:
1. Cek cron-checker state: `R2 health/cron_state.json`
2. Manual trigger: `curl "https://features-service.mkemalw.workers.dev/aggregate"`

### Force Refresh dari R2 (Bypass D1)

Jika D1 korup atau tidak lengkap, bypass dengan:
```bash
curl "https://features-service.mkemalw.workers.dev/aggregate-footprint?source=r2"
```

Ini akan:
1. Skip D1 query entirely
2. List semua ticker dari R2 langsung
3. Probe multi-hour untuk coverage maksimal
4. Backfill ke D1 (self-healing)

### Debug Mode di Frontend

Tambahkan `?debug` ke URL frontend:
```
http://127.0.0.1:5500/idx/emiten/index.html?debug
```

Console akan menampilkan:
- API response metadata (status, reason, count)
- Fallback detection warnings
- Signal distribution
- Filter/render statistics
