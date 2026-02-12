# Features Registry — Complete Reference

> **Document Version**: 1.0  
> **Created**: 2026-02-12  
> **Last Updated**: 2026-02-12  
> **Author**: Copilot + mkemalw

---

## Conventions

Setiap feature didokumentasikan dengan format berikut:

| Elemen | Deskripsi |
|--------|-----------|
| **Ingredients** | Raw data yang dibutuhkan (sumber, format, storage) |
| **Recipe** | Formula / rumus perhitungan |
| **Process** | Langkah-langkah komputasi dan transformasi |
| **Schedule** | Kapan dan bagaimana feature ini dihasilkan |
| **Output** | Di mana hasilnya disimpan dan siapa yang mengkonsumsi |

---

## Table of Contents

### Part A — Orderflow Features (Intraday / Tick-Level)
- [OF-01: Delta (Net Volume per Candle)](#of-01-delta)
- [OF-02: Cumulative Delta / CVD](#of-02-cumulative-delta)
- [OF-03: Delta Percent (Intraday)](#of-03-delta-percent)
- [OF-04: Bid/Ask Volume (Level-by-Level)](#of-04-bidask-volume)
- [OF-05: HAKA Ratio](#of-05-haka-ratio)
- [OF-06: Momentum Score](#of-06-momentum-score)
- [OF-07: Intention Score (Orderbook Imbalance)](#of-07-intention-score)
- [OF-08: Fused Signal (Realtime Composite)](#of-08-fused-signal)
- [OF-09: Absorption Score](#of-09-absorption-score)
- [OF-10: Money Flow (Day-Level)](#of-10-money-flow)
- [OF-11: Hidden Accumulation Score](#of-11-hidden-accumulation-score)

### Part B — Brokerflow Features (Daily / EOD)
- [BF-01: Effort (Volume Activity Z-Score)](#bf-01-effort)
- [BF-02: Result (Price Response Z-Score)](#bf-02-result)
- [BF-03: NGR (Net Gross Ratio Z-Score)](#bf-03-ngr)
- [BF-04: Elasticity (Effort-Result Ratio Z-Score)](#bf-04-elasticity)
- [BF-05: SM State Classification](#bf-05-sm-state-classification)
- [BF-06: Internal Score (SM Composite)](#bf-06-internal-score)
- [BF-07: Foreign Flow Scanner](#bf-07-foreign-flow-scanner)
- [BF-08: Accum Window (Multi-Window Accumulation)](#bf-08-accum-window)
- [BF-09: Screener Score (Index View Composite)](#bf-09-screener-score)
- [BF-10: VWAP Deviation Z-Score](#bf-10-vwap-deviation)

### Part C — Composite / Cross-Domain Features
- [CF-01: Hybrid Score](#cf-01-hybrid-score)
- [CF-02: Divergence Factor](#cf-02-divergence-factor)
- [CF-03: Hybrid Divergence Score](#cf-03-hybrid-divergence-score)
- [CF-04: Signal Classification](#cf-04-signal-classification)

---

# Part A — Orderflow Features

Features yang dihitung dari data tick-level (trade stream) dan orderbook intraday.

---

<a id="of-01-delta"></a>
## OF-01: Delta (Net Volume per Candle)

### Ingredients

| Item | Detail |
|------|--------|
| **Source** | Live trade stream via WebSocket (IPOT pipe format) |
| **Format** | `YYYYMMDD\|HHMMSS\|X\|CODE\|BOARD\|TYPE\|PRICE\|VOL` |
| **Storage** | R2 `tape-data-saham` → `footprint/{TICKER}/1m/{YYYY}/{MM}/{DD}/{HH}.jsonl` |

### Recipe

$$\text{Delta} = \sum V_{buy} - \sum V_{sell}$$

Side inference menggunakan **Uptick Rule**:
- Jika `price > prevPrice` → **Buy** (uptick)
- Jika `price < prevPrice` → **Sell** (downtick)
- Jika `price == prevPrice` → gunakan direction terakhir

### Process

1. Durable Object (DO) menerima raw trade event dari WebSocket
2. Setiap trade diklasifikasikan buy/sell via uptick rule
3. Volume diagregasi per 1-menit candle
4. Delta dihitung sebagai `buyVol - sellVol` per candle
5. Flush ke R2 setiap 5 detik via DO alarm

### Schedule

| Trigger | Detail |
|---------|--------|
| **Realtime** | DO alarm setiap 5 detik (`livetrade-durable-object`) |
| **Aggregation** | Hourly cron `0 * * * *` (`livetrade-taping-agregator`) |

### Output

| Storage | Key/Path | Consumer |
|---------|----------|----------|
| R2 | `footprint/{TICKER}/1m/{YYYY}/{MM}/{DD}/{HH}.jsonl` | Aggregator, Frontend chart |
| D1 | `temp_footprint_consolidate` (5-min rollup) | Features service |

### Source Code

`workers/livetrade-durable-object/src/index.js`

---

<a id="of-02-cumulative-delta"></a>
## OF-02: Cumulative Delta / CVD

### Ingredients

| Item | Detail |
|------|--------|
| **Source** | Footprint candles dari R2 (`raw_lt/` files) |
| **Dependency** | OF-01 (Delta per candle) |

### Recipe

$$\text{CVD}_t = \sum_{i=0}^{t} \Delta_i$$

Di mana $\Delta_i$ adalah delta pada candle ke-$i$.

Per-bucket (5-min / 15-min):

$$\text{Net}_{\text{bucket}} = \sum_{\text{candles in bucket}} (V_{buy} - V_{sell})$$

### Process

1. Baca semua candle footprint dari R2 untuk hari tersebut
2. Hitung running sum delta dari candle pertama sampai candle terakhir
3. Agregasi ke bucket interval yang lebih besar (5m, 15m)

### Schedule

| Trigger | Detail |
|---------|--------|
| **Hourly** | Cron `0 * * * *` via `livetrade-taping-agregator` |
| **Backfill** | Queue `livetrade-backfill-queue` → `processAggregationBatch()` |

### Output

| Storage | Key/Path | Consumer |
|---------|----------|----------|
| R2 | `intraday/{TICKER}.json` → `net` field per bucket | Frontend intraday chart |
| R2 | `processed/{DATE}/{TICKER}.json` | Backfill pipeline |

### Source Code

`workers/livetrade-taping-agregator/src/index.js`

---

<a id="of-03-delta-percent"></a>
## OF-03: Delta Percent (Intraday)

### Ingredients

| Item | Detail |
|------|--------|
| **Source** | Aggregated day-level stats dari D1 / R2 |
| **Dependency** | OF-01 (Delta), OF-02 (CVD) |

### Recipe

$$\text{Delta\%} = \frac{\sum V_{buy}}{\sum V_{buy} + \sum V_{sell}} \times 100$$

> Catatan: Ini adalah **buy ratio**, bukan delta/total. Range: 0–100%.

### Process

1. Ambil total buy volume dan total sell volume untuk hari berjalan
2. Hitung rasio buy terhadap total volume
3. Simpan sebagai persentase (50% = netral)

### Schedule

| Trigger | Detail |
|---------|--------|
| **Realtime** | Cron `*/5 * * * *` via `features-service` |

### Output

| Storage | Key/Path | Consumer |
|---------|----------|----------|
| R2 | `intraday/{TICKER}.json` → `deltaPct` field | Screener, Hybrid scoring |

### Source Code

`workers/features-service/src/index.js`

---

<a id="of-04-bidask-volume"></a>
## OF-04: Bid/Ask Volume (Level-by-Level)

### Ingredients

| Item | Detail |
|------|--------|
| **Source** | Individual trades matched to price levels |
| **Dependency** | Raw trade stream (same as OF-01) |

### Recipe

Per price level $P$ dalam setiap 1-min candle:

$$V_{bid}(P) = \sum \text{volume di mana trade = sell (downtick) pada harga } P$$
$$V_{ask}(P) = \sum \text{volume di mana trade = buy (uptick) pada harga } P$$

### Process

1. Setiap trade diklasifikasikan buy/sell via uptick rule
2. Volume diakumulasi per price level
3. Disimpan sebagai `levels[]` array di dalam candle footprint

### Schedule

| Trigger | Detail |
|---------|--------|
| **Realtime** | Flushed setiap 5 detik via DO alarm |

### Output

| Storage | Key/Path | Consumer |
|---------|----------|----------|
| R2 | `footprint/{TICKER}/1m/...` → `levels[]` array per candle | Footprint chart, imbalance detection |

### Source Code

`workers/livetrade-durable-object/src/index.js`

---

<a id="of-05-haka-ratio"></a>
## OF-05: HAKA Ratio

### Ingredients

| Item | Detail |
|------|--------|
| **Source** | Recent trades dari R2 `raw_lt/` |
| **Dependency** | OF-01 (Delta / side classification) |

### Recipe

$$\text{Raw HAKA} = \frac{V_{buy}}{V_{buy} + V_{sell}}$$

Normalized ke range [-1, +1]:

$$\text{HAKA} = 2 \times \text{Raw HAKA} - 1$$

Per-bucket: disimpan sebagai `x` (range 0..100) dan `haka` (raw ratio).

### Interpretation

| Value | Meaning |
|-------|---------|
| HAKA > 0 | Buy-side dominant (aggressive buyer) |
| HAKA < 0 | Sell-side dominant (aggressive seller) |
| HAKA ≈ 0 | Balanced / no clear aggressor |

### Process

1. Ambil trade data dari R2 untuk window tertentu
2. Klasifikasi side via uptick rule
3. Hitung rasio buy volume terhadap total volume
4. Normalisasi ke [-1, +1]

### Schedule

| Trigger | Detail |
|---------|--------|
| **On-demand** | HTTP request via `app-orderflow` |
| **Backfill** | Per-bucket calculation in aggregator pipeline |

### Output

| Storage | Key/Path | Consumer |
|---------|----------|----------|
| HTTP | Response dari `/signals?ticker=X` | Frontend realtime |
| R2 | `intraday/{TICKER}.json` → `x`, `haka` per bucket | Timeline chart |

### Source Code

`workers/app-orderflow/src/index.js`

---

<a id="of-06-momentum-score"></a>
## OF-06: Momentum Score

### Ingredients

| Item | Detail |
|------|--------|
| **Source** | Recent trades dari R2 `raw_lt/` |
| **Dependency** | OHLC data dari trade stream |

### Recipe

$$\text{Raw Momentum} = \frac{P_{last} - P_{first}}{P_{first}}$$

Clamped to [-0.05, +0.05], then normalized:

$$\text{Momentum} = \frac{\text{Raw Momentum}}{0.05}$$

Final range: [-1, +1]. Per-bucket: disimpan sebagai `y`.

### Interpretation

| Value | Meaning |
|-------|---------|
| Momentum > 0 | Price trending up in window |
| Momentum < 0 | Price trending down in window |
| Momentum ≈ 0 | Price flat / consolidation |

### Process

1. Ambil first dan last price dalam window
2. Hitung percentage change
3. Clamp ke ±5% untuk menghindari outlier
4. Normalisasi ke [-1, +1]

### Schedule

| Trigger | Detail |
|---------|--------|
| **On-demand** | HTTP request via `app-orderflow` |
| **Backfill** | Per-bucket calculation |

### Output

| Storage | Key/Path | Consumer |
|---------|----------|----------|
| HTTP | Response dari `/signals?ticker=X` → `momentum` | Frontend realtime |
| R2 | `intraday/{TICKER}.json` → `y` per bucket | Quadrant chart |

### Source Code

`workers/app-orderflow/src/index.js`

---

<a id="of-07-intention-score"></a>
## OF-07: Intention Score (Orderbook Imbalance)

### Ingredients

| Item | Detail |
|------|--------|
| **Source** | Orderbook snapshot dari R2 `raw_ob/{TICKER}/` |
| **Dependency** | None (standalone from orderbook data) |

### Recipe

$$\text{Intention} = \frac{\sum V_{bids} - \sum V_{offers}}{\sum V_{bids} + \sum V_{offers}}$$

Clamped to [-1, +1].

### Interpretation

| Value | Meaning |
|-------|---------|
| > +0.3 | Strong buy intention (bid wall) |
| < -0.3 | Strong sell intention (offer wall) |
| ±0.3 | No clear intention |

### Process

1. Fetch latest orderbook snapshot dari R2
2. Sum semua bid volume dan offer volume
3. Hitung imbalance ratio
4. Clamp ke [-1, +1]

### Schedule

| Trigger | Detail |
|---------|--------|
| **On-demand** | HTTP request via `app-orderflow` |
| **Data refresh** | Cron `*/5 * * * *` via `orderbook-taping-agregator` (⚠️ handler belum lengkap) |

### Output

| Storage | Key/Path | Consumer |
|---------|----------|----------|
| HTTP | Response dari `/signals?ticker=X` → `intention` | Frontend realtime |

### Source Code

`workers/app-orderflow/src/index.js`

---

<a id="of-08-fused-signal"></a>
## OF-08: Fused Signal (Realtime Composite)

### Ingredients

| Item | Detail |
|------|--------|
| **Source** | OF-05 (HAKA) + OF-07 (Intention) |
| **Dependency** | Trade stream + Orderbook |

### Recipe

**Full mode** (HAKA + Intention available):

$$\text{Fused} = 0.6 \times \text{HAKA} + 0.4 \times \text{Intention}$$

**Lite mode** (HAKA only, no orderbook):

$$\text{Fused} = \text{HAKA}$$

**Side determination**:
- Fused > +0.15 → `BUY`
- Fused < -0.15 → `SELL`
- Else → `NONE`

### Process

1. Hitung HAKA dari trade data (OF-05)
2. Hitung Intention dari orderbook (OF-07)
3. Weighted average sesuai mode (full/lite)
4. Klasifikasi side berdasarkan threshold

### Schedule

| Trigger | Detail |
|---------|--------|
| **On-demand** | HTTP request via `app-orderflow` |

### Output

| Storage | Key/Path | Consumer |
|---------|----------|----------|
| HTTP | Response dari `/signals?ticker=X` → `fused`, `side` | Frontend realtime indicator |

### Source Code

`workers/app-orderflow/src/index.js`

---

<a id="of-09-absorption-score"></a>
## OF-09: Absorption Score

### Ingredients

| Item | Detail |
|------|--------|
| **Source** | Cumulative volume + OHLC dari backfill aggregation |
| **Dependency** | OF-02 (CVD), OHLC data |

### Recipe

$$\text{Absorption} = \frac{|\text{CVD}_{end} - \text{CVD}_{start}|}{P_{range}}$$

Di mana $P_{range} = P_{high} - P_{low}$.

Fallback jika $P_{range} = 0$:

$$\text{Absorption} = \frac{|\text{CVD}_{end} - \text{CVD}_{start}|}{P_{close}}$$

### Interpretation

| Value | Meaning |
|-------|---------|
| High | Volume besar tapi harga tidak bergerak → **absorption** (potensi breakout) |
| Low | Volume proporsional terhadap price change → **normal price discovery** |

### Process

1. Hitung CVD delta selama window (start → end)
2. Hitung price range (high - low) selama window yang sama
3. Bagi CVD delta dengan price range
4. Fallback ke close price jika range = 0

### Schedule

| Trigger | Detail |
|---------|--------|
| **Hourly** | Cron via backfill pipeline (`livetrade-taping-agregator`) |

### Output

| Storage | Key/Path | Consumer |
|---------|----------|----------|
| R2 | `intraday/{TICKER}.json` → `absorption` field per bucket | Screener, Divergence scoring |

### Source Code

`workers/livetrade-taping-agregator/src/index.js`

---

<a id="of-10-money-flow"></a>
## OF-10: Money Flow (Day-Level)

### Ingredients

| Item | Detail |
|------|--------|
| **Source** | Aggregated day-level buy/sell volume |
| **Dependency** | OF-01 (Delta, side classification) |

### Recipe

$$\text{Money Flow} = \frac{V_{buy} - V_{sell}}{V_{buy} + V_{sell}}$$

Range: [-1, +1].

### Interpretation

| Value | Meaning |
|-------|---------|
| > +0.3 | Strong net buying |
| < -0.3 | Strong net selling |
| ±0.3 | Balanced / no clear flow |

### Process

1. Agregasi seluruh buy dan sell volume untuk hari tersebut
2. Hitung rasio net terhadap total
3. Simpan sebagai single value per ticker per hari

### Schedule

| Trigger | Detail |
|---------|--------|
| **Hourly** | Cron via backfill pipeline, final write at EOD |

### Output

| Storage | Key/Path | Consumer |
|---------|----------|----------|
| R2 | `intraday/{TICKER}.json` → `moneyFlow` | Frontend summary |

### Source Code

`workers/livetrade-taping-agregator/src/index.js`

---

<a id="of-11-hidden-accumulation-score"></a>
## OF-11: Hidden Accumulation Score

### Ingredients

| Item | Detail |
|------|--------|
| **Source** | Per-bucket HAKA (x-axis) dan Momentum (y-axis) |
| **Dependency** | OF-05 (HAKA), OF-06 (Momentum) |

### Recipe

Quadrant classification:
- **Q1**: HAKA ≥ 0, Momentum ≥ 0 → Bullish (buy + price up)
- **Q2**: HAKA < 0, Momentum ≥ 0 → Bearish divergence
- **Q3**: HAKA < 0, Momentum < 0 → Bearish (sell + price down)
- **Q4**: HAKA ≥ 0, Momentum < 0 → **Hidden Accumulation** (buy + price down)

$$\text{Q4 Ratio} = \frac{|\text{buckets in Q4}|}{|\text{total buckets}|}$$

$$\text{Vol Bias} = \frac{V_{buy,Q4}}{V_{total,Q4}}$$

$$\text{Buy Bias} = \frac{V_{buy,Q4}}{V_{buy,total}}$$

$$\textbf{Hidden Acc Score} = \text{Q4 Ratio} \times \text{Vol Bias} \times \text{Buy Bias}$$

### Interpretation

| Value | Meaning |
|-------|---------|
| High | Banyak window di mana ada buying tapi harga turun → **stealth accumulation** |
| Low | Buying tidak terjadi saat harga turun → no hidden accumulation |

### Process

1. Plot semua bucket pada quadrant (x = HAKA, y = Momentum)
2. Identifikasi bucket yang masuk Q4
3. Hitung rasio Q4, volume bias, dan buy bias
4. Multiply ketiga komponen → Hidden Acc Score

### Schedule

| Trigger | Detail |
|---------|--------|
| **Hourly** | Cron via backfill pipeline |

### Output

| Storage | Key/Path | Consumer |
|---------|----------|----------|
| R2 | `intraday/{TICKER}.json` → `hidden_acc_score`, `quadrant_profile` | Screener, Signal classification |

### Source Code

`workers/livetrade-taping-agregator/src/index.js`

---

# Part B — Brokerflow Features

Features yang dihitung dari data broker summary harian (EOD) — siapa yang beli/jual berapa.

---

<a id="bf-01-effort"></a>
## BF-01: Effort (Volume Activity Z-Score)

### Ingredients

| Item | Detail |
|------|--------|
| **Source** | Broker summary dari R2 `raw-broksum/{TICKER}/{DATE}` |
| **Fields** | `brokers_buy[].bval`, `brokers_sell[].sval` — aggregated per broker type (Foreign/Local) |
| **Fallback** | Legacy structure: `foreign.buy_val`, `retail.buy_val`, `local.buy_val` |

### Recipe

**Step 1 — Raw Effort**:

$$\text{Effort} = \text{Gross Buy} + \text{Gross Sell}$$

Di mana:
- $\text{Gross Buy} = V_{foreign,buy} + V_{retail,buy} + V_{local,buy}$
- $\text{Gross Sell} = V_{foreign,sell} + V_{retail,sell} + V_{local,sell}$

> Semua dalam **Value (Rupiah)**, bukan lot.

**Step 2 — Z-Score** (per rolling window $W \in \{5, 10, 20, 60\}$):

$$z_{effort}(W) = \frac{E_{today} - \mu_E(W)}{\sigma_E(W)}$$

Di mana $\mu_E$ dan $\sigma_E$ dihitung dari $W$ data points terakhir.

> ⚠️ Menggunakan **population std dev** ($\div N$), bukan sample ($\div N-1$).

**Step 3 — D-1 Shift**:

Z-Score yang ditampilkan ke user adalah **Effort Z-Score kemarin** (D-1), bukan hari ini. Logika:

> *"Apakah Big Money masuk kemarin?"* → bandingkan dengan *"Bagaimana harga hari ini?"*

Jika data D-1 tersedia (`real_z_scores["20"].effort` dari history), maka:

$$z_{effort,displayed} = z_{effort,D-1}$$

### Interpretation

| Z-Score | Label | Meaning |
|---------|-------|---------|
| > +1.0 | **High** | Heavy trading activity, significantly above average |
| 0 to +1 | **Positive** | Above average trading activity |
| -1 to 0 | **Normal** | Below average but within 1σ |
| < -1.0 | **Low** | Light activity, significantly below average |

### Process

1. Fetch raw broker summary dari R2 untuk ticker
2. Aggregate buy/sell value dari semua broker types
3. Hitung Effort = grossBuy + grossSell
4. Load history (existingHistory) untuk rolling window
5. Hitung Z-Score per window [5, 10, 20, 60]
6. Apply D-1 shift: replace current effort Z with yesterday's
7. Simpan `real_z_scores` (true Day T) terpisah untuk digunakan besok

### Schedule

| Trigger | Detail |
|---------|--------|
| **Dispatch** | Cron `30 11 * * 1-5` (18:30 WIB) — features-service dispatches per-ticker jobs |
| **Compute** | Queue consumer processes each ticker |

### Output

| Storage | Key/Path | Consumer |
|---------|----------|----------|
| R2 | `features/z_score/{TICKER}.json` → history array | Next day's D-1 lookup |
| D1 | `smart_money_features` → `z_effort` | Screener, Feature card |
| R2 | `cache/screener-accum.json` → `z["20"].e` | Frontend screener index |

### Source Code

`workers/features-service/src/smart-money.js` — `processSingleDay()` method

### Industry Standard

| Aspect | Status | Note |
|--------|--------|------|
| Effort = Total Value | ✅ Standard | Wyckoff VSA: "Effort" = total volume/value |
| Z-Score normalization | ✅ Standard | Standard quantitative finance practice |
| D-1 Shift | ⚠️ Custom | Not standard Wyckoff — more akin to predictive lead-lag model |
| Population StdDev | ⚠️ Non-standard | Industry prefers sample std dev ($N-1$) for small windows |

---

<a id="bf-02-result"></a>
## BF-02: Result (Price Response Z-Score)

### Ingredients

| Item | Detail |
|------|--------|
| **Source** | Close price dari R2 `raw-broksum/` → `stock_summary.average_price` atau `bandar_detector.average` |
| **Dependency** | Previous close dari history |

### Recipe

**Step 1 — Daily Return**:

$$\text{ret} = \frac{P_{close,today} - P_{close,yesterday}}{P_{close,yesterday}}$$

**Step 2 — Result (Absolute Return)**:

$$\text{Result} = |\text{ret}|$$

**Step 3 — Z-Score**:

$$z_{result}(W) = \frac{R_{today} - \mu_R(W)}{\sigma_R(W)}$$

### Interpretation

| Z-Score | Meaning |
|---------|---------|
| High (> 1) | Strong price movement — harga bereaksi signifikan |
| Low (< -1) | Price stuck — harga nyaris tidak bergerak |
| Normal | Typical price response |

### Interplay with Effort

Inti dari **Wyckoff Effort vs Result**:

| Effort Z | Result Z | Interpretation |
|----------|----------|----------------|
| High | Low | **Absorption** — volume besar tapi harga diam → accumulation/distribution |
| High | High | **Normal** — volume besar, harga bergerak sesuai |
| Low | High | **Anomaly** — harga bergerak tanpa volume → gap/news driven |
| Low | Low | **Quiet** — tidak ada aktivitas signifikan |

### Schedule

Same as BF-01 (nebeng di `processSingleDay()`).

### Output

| Storage | Key/Path | Consumer |
|---------|----------|----------|
| R2 | `features/z_score/{TICKER}.json` → `z_scores["20"].result` | Feature card |
| D1 | `smart_money_features` → `z_result` | State classification |
| R2 | `cache/screener-accum.json` → `z["20"].r` | Frontend |

### Source Code

`workers/features-service/src/smart-money.js`

---

<a id="bf-03-ngr"></a>
## BF-03: NGR (Net Gross Ratio Z-Score)

### Ingredients

| Item | Detail |
|------|--------|
| **Source** | Foreign net flow dari R2 `raw-broksum/` |
| **Fields** | `foreign.buy_val`, `foreign.sell_val`, Effort (BF-01) |

### Recipe

**Step 1 — Net Foreign**:

$$\text{Net} = V_{foreign,buy} - V_{foreign,sell}$$

**Step 2 — NGR (Net Gross Ratio)**:

$$\text{NGR} = \frac{|\text{Net}|}{\text{Effort}}$$

> Effort = 0 → NGR = 0 (safeguard).

**Step 3 — Z-Score**:

$$z_{ngr}(W) = \frac{NGR_{today} - \mu_{NGR}(W)}{\sigma_{NGR}(W)}$$

### Interpretation

| Z-Score | Meaning |
|---------|---------|
| High (> 1) | Clean accumulation — foreign flow sangat searah (beli atau jual dominan) |
| Normal | Mixed flow — tidak ada dominasi jelas |
| Low (< -1) | Noisy — buying dan selling seimbang, tidak ada arah |

### Schedule

Same as BF-01.

### Output

| Storage | Key/Path | Consumer |
|---------|----------|----------|
| R2 | `features/z_score/{TICKER}.json` → `z_scores["20"].ngr` | Feature card |
| D1 | `smart_money_features` → `z_ngr` | Hybrid scoring (CF-01) |
| R2 | `cache/screener-accum.json` → `z["20"].n` | Frontend |

### Source Code

`workers/features-service/src/smart-money.js`

---

<a id="bf-04-elasticity"></a>
## BF-04: Elasticity (Effort-Result Ratio Z-Score)

### Ingredients

| Item | Detail |
|------|--------|
| **Dependency** | BF-02 (Result), Foreign Net |

### Recipe

$$\text{Elasticity} = \frac{|\text{ret}|}{|\text{Net}| + \varepsilon}$$

Di mana $\varepsilon = 10^{-9}$ (untuk menghindari division by zero).

**Z-Score**:

$$z_{elas}(W) = \frac{E_{today} - \mu_E(W)}{\sigma_E(W)}$$

### Interpretation

| Z-Score | Meaning |
|---------|---------|
| High | **Volatile** — harga mudah bergerak dengan sedikit net flow |
| Low | **Rigid** — butuh net flow besar untuk menggerakkan harga |

### Interplay with State

| Elasticity | Effort | Interpretation |
|------------|--------|----------------|
| High + Low Effort | — | Harga rentan → ready for markup/markdown |
| Low + High Effort | — | Harga kaku, big money sedang accumulate tanpa gerakkan harga |

### Schedule

Same as BF-01.

### Output

| Storage | Key/Path | Consumer |
|---------|----------|----------|
| R2 | `features/z_score/{TICKER}.json` → `z_scores["20"].elas` | Feature card |
| R2 | `cache/screener-accum.json` → `z["20"].el` | Frontend |

### Source Code

`workers/features-service/src/smart-money.js`

---

<a id="bf-05-sm-state-classification"></a>
## BF-05: SM State Classification

### Ingredients

| Item | Detail |
|------|--------|
| **Dependency** | BF-01 (Effort Z), BF-02 (Result Z, ret), BF-04 (Elasticity) |

### Recipe

Priority-based classification using Z-Score thresholds:

```
IF   effortZ > 0.5  AND  abs(resultZ) < 0.5            → TRANSITION
IF   effortZ > 0.5  AND  resultZ < -0.5  AND ret ≥ 0   → ACCUMULATION
IF   effortZ > 0.5  AND  ret < -0.01                    → DISTRIBUTION
IF   effortDeclining AND resultZ > -0.5  AND elas > 1.1×mean → READY_MARKUP
ELSE                                                     → NEUTRAL
```

> Note: `effortZ` uses D-1 shifted value (BF-01 Step 3).

### State Definitions

| State | Description |
|-------|-------------|
| **ACCUMULATION** | Big money masuk kemarin (high effort D-1), harga stabil/naik hari ini |
| **DISTRIBUTION** | Big money aktif kemarin (high effort D-1), harga turun hari ini |
| **TRANSITION** | Big money aktif kemarin, harga belum bereaksi (range kecil) |
| **READY_MARKUP** | Effort menurun, harga stabil, elasticity tinggi → siap breakout |
| **NEUTRAL** | Tidak ada pola signifikan |

### Schedule

Same as BF-01.

### Output

| Storage | Key/Path | Consumer |
|---------|----------|----------|
| D1 | `smart_money_features` → `state` | Screener filter, Feature card |
| R2 | `features/z_score/{TICKER}.json` → `state` | History |
| R2 | `cache/screener-accum.json` → `s` | Frontend screener index |

### Source Code

`workers/features-service/src/smart-money.js`

---

<a id="bf-06-internal-score"></a>
## BF-06: Internal Score (SM Composite)

### Ingredients

| Item | Detail |
|------|--------|
| **Dependency** | BF-01 (Effort Z), BF-02 (Result Z), BF-03 (NGR Z), BF-04 (Elasticity Z) |

### Recipe

$$\text{Score} = W_1 \cdot z_{effort} - W_2 \cdot |z_{result}| + W_3 \cdot (1 - z_{elas}) + W_4 \cdot z_{ngr}$$

Default weights:

| Weight | Value | Factor |
|--------|-------|--------|
| $W_1$ | 1.0 | Effort (positive contribution) |
| $W_2$ | 1.0 | Result (negative — penalizes big price moves) |
| $W_3$ | 1.0 | Elasticity (inverted — rewards rigidity) |
| $W_4$ | 0.5 | NGR (positive contribution, half weight) |

### Interpretation

Skor tinggi = **Effort besar, harga tidak bergerak, harga rigid, net flow searah** → ideal accumulation signal.

### Schedule

Same as BF-01.

### Output

| Storage | Key/Path | Consumer |
|---------|----------|----------|
| R2 | `features/z_score/{TICKER}.json` → `internal_score` | Internal ranking |

### Source Code

`workers/features-service/src/smart-money.js`

---

<a id="bf-07-foreign-flow-scanner"></a>
## BF-07: Foreign Flow Scanner

### Ingredients

| Item | Detail |
|------|--------|
| **Source** | R2 `raw-broksum/{TICKER}/{DATE}` — `brokers_buy[]`, `brokers_sell[]` |
| **Reference** | Foreign broker codes: `ZP, YU, KZ, RX, BK, AK, CS, CG, DB, ML, CC, DX, FS, LG, NI, OD` |

### Recipe

**Per-day Foreign Net**:

$$\text{Foreign Net}_d = \sum_{b \in \text{foreign}} V_{buy,b} - \sum_{b \in \text{foreign}} V_{sell,b}$$

**Cumulative Foreign Net (N-day)**:

$$\text{Cumulative}_N = \sum_{d=1}^{N} \text{Foreign Net}_d$$

**Trend**: Linear regression slope of cumulative values.

### Schedule

| Trigger | Detail |
|---------|--------|
| **On-demand** | HTTP request via `/foreign-scanner` endpoint |

### Output

| Storage | Key/Path | Consumer |
|---------|----------|----------|
| R2 | `cache/foreign-scanner.json` (in `broksum-data` bucket) | Frontend Foreign Flow chart |

### Source Code

`workers/api-saham/src/index.js`

---

<a id="bf-08-accum-window"></a>
## BF-08: Accum Window (Multi-Window Accumulation)

### Ingredients

| Item | Detail |
|------|--------|
| **Source** | D1 `daily_broker_flow` — per-ticker daily net flows |
| **Windows** | 2, 5, 10, 20 days |

### Recipe

Per window $W$:

$$\text{SM Net}_W = \sum_{d=1}^{W} (\text{Foreign Net}_d + \text{Local Net}_d)$$

$$\text{Foreign Net}_W = \sum_{d=1}^{W} \text{Foreign Net}_d$$

Output structure per window: `{ sm, fn, ln, rn, streak }`:
- `sm` = Smart Money Net (Foreign + Local)
- `fn` = Foreign Net
- `ln` = Local Net
- `rn` = Retail Net
- `streak` = Consecutive days with same sign SM

### Schedule

| Trigger | Detail |
|---------|--------|
| **Daily** | Cron `45 11 * * 1-5` (18:45 WIB) — screener aggregation |

### Output

| Storage | Key/Path | Consumer |
|---------|----------|----------|
| R2 | `cache/screener-accum.json` → per ticker `accum: { "2": {...}, "5": {...}, ... }` | Frontend index table |

### Source Code

`workers/features-service/src/index.js`

---

<a id="bf-09-screener-score"></a>
## BF-09: Screener Score (Index View Composite)

### Ingredients

| Item | Detail |
|------|--------|
| **Dependency** | BF-01 (Effort Z), BF-03 (NGR Z), BF-05 (State) |

### Recipe

Computed on the **frontend** (`broker-summary.js`):

$$\text{Effort Bonus} = \min(z_{effort} \times 2, 4) \quad \text{(if } z_{effort} > 0\text{, else 0)}$$

$$\text{State Bonus} = \begin{cases} 2 & \text{if ACCUMULATION or READY\_MARKUP} \\ 1 & \text{if TRANSITION} \\ 0 & \text{otherwise} \end{cases}$$

$$\text{NGR Bonus} = \begin{cases} 1 & \text{if } z_{ngr} > 0 \\ 0 & \text{otherwise} \end{cases}$$

$$\text{Screener Score} = \text{Effort Bonus} + \text{State Bonus} + \text{NGR Bonus}$$

Max possible: $4 + 2 + 1 = 7$.

### Schedule

| Trigger | Detail |
|---------|--------|
| **Client-side** | Computed on page load from screener data |

### Output

| Storage | Key/Path | Consumer |
|---------|----------|----------|
| In-memory | `score` field per candidate in `allCandidates[]` | Table sort, Flow column |

### Source Code

`idx/emiten/broker-summary.js` — `loadScreenerData()`

---

# Part C — Composite / Cross-Domain Features

Features yang menggabungkan data dari Orderflow (intraday) dan Brokerflow (EOD).

---

<a id="bf-10-vwap-deviation"></a>
## BF-10: VWAP Deviation Z-Score

### Ingredients

| Item | Detail |
|------|--------|
| **Source** | R2 `raw-broksum/{TICKER}/{DATE}` |
| **Fields** | `stock_summary.total_value`, `stock_summary.total_volume_shares`, `stock_summary.average_price` (= daily VWAP) |
| **Fallback** | `bandar_detector.value`, `bandar_detector.volume` |
| **Dependency** | Close price (BF-02), History of totalValue & totalVolume per day |

### Recipe

**Step 1 — Rolling VWAP** (over window $W$ days):

$$\text{Rolling VWAP}_W = \frac{\sum_{d=1}^{W} \text{TotalValue}_d}{\sum_{d=1}^{W} \text{TotalVolume}_d}$$

> This is the **true multi-day VWAP**, not the daily average price. It weights each day by its actual trading volume.

**Step 2 — VWAP Deviation**:

$$\text{Dev}_d = \frac{P_{close,d} - \text{Rolling VWAP}_W}{\text{Rolling VWAP}_W}$$

**Step 3 — Z-Score**:

$$z_{vwap}(W) = \frac{\text{Dev}_{today} - \mu_{Dev}(W)}{\sigma_{Dev}(W)}$$

Windows: $W \in \{5, 10, 20, 60\}$, primary = 20.

### Interpretation

| Z-Score | Label | Meaning |
|---------|-------|---------|
| > +1.0 | **Above** | Price significantly above rolling VWAP → buyers in control, potential overbought |
| 0 to +1 | **Fair+** | Price slightly above VWAP → mild bullish positioning |
| -1 to 0 | **Fair−** | Price slightly below VWAP → mild bearish positioning |
| < -1.0 | **Below** | Price significantly below rolling VWAP → sellers in control, potential oversold |

### Interplay with Other Features

| VWAP Dev Z | Effort Z | State | Signal |
|------------|----------|-------|--------|
| Above + High Effort | → | ACCUMULATION | **Breakout valid** — big money pushing price above fair value |
| Below + High Effort | → | ACCUMULATION | **Stealth accumulation** — buying at discount |
| Above + Low Effort | → | NEUTRAL | **Weak rally** — price drifting up without conviction |
| Below + Low Effort | → | DISTRIBUTION | **Confirmed distribution** — price sinking |

### Process

1. Extract `total_value` and `total_volume_shares` from raw broker summary data
2. Store both in `currentMetrics.metrics` alongside effort, result, etc.
3. For each rolling window [5, 10, 20, 60]:
   a. Sum `totalValue` and `totalVolume` across all days in the window
   b. Compute `rollingVwap = sumValue / sumVolume`
   c. Compute deviation of each day's close from rolling VWAP
   d. Z-Score the current day's deviation vs window deviations
4. Store as `vwap` key in `z_scores[w]` object

### Schedule

| Trigger | Detail |
|---------|--------|
| **Dispatch** | Cron `30 11 * * 1-5` (18:30 WIB) — same as BF-01..06 |
| **Compute** | Queue consumer, nebeng di `processSingleDay()` |

### Output

| Storage | Key/Path | Consumer |
|---------|----------|----------|
| R2 | `features/z_score/{TICKER}.json` → `z_scores["20"].vwap` | History, D-1 lookup |
| D1 | `daily_features` → `metrics_json` (inside full z_scores dump) | Screener aggregation |
| R2 | `cache/screener-accum.json` → `z["20"].v` (minified) | Frontend screener |
| HTML | `#feat-vwap` in Z-Score Features Card | Detail view |

### Source Code

`workers/features-service/src/smart-money.js` — `processSingleDay()` method

### Industry Standard

| Aspect | Status | Note |
|--------|--------|------|
| Rolling VWAP | ✅ Standard | VWAP = ΣValue/ΣVolume is the institutional standard |
| Deviation from VWAP | ✅ Standard | Used by institutional traders as fair value reference |
| Z-Score normalization | ✅ Standard | Standard quantitative approach |
| Multi-day rolling | ✅ Standard | Anchored VWAP (multi-day) is widely used for swing analysis |

---

<a id="cf-01-hybrid-score"></a>
## CF-01: Hybrid Score

### Ingredients

| Item | Detail |
|------|--------|
| **Source 1** | BF-03: Z-Score NGR dari D1 `smart_money_features` |
| **Source 2** | OF-03: Delta% dari R2 `intraday/{TICKER}.json` |
| **Source 3** | Price change % (intraday) |

### Recipe

**Step 1 — Raw Composite**:

$$\text{Raw} = 0.7 \times \frac{\text{Delta\%}}{100} + 0.3 \times \frac{z_{ngr}}{3}$$

> Weights: 70% intraday orderflow, 30% historical smart money.

**Step 2 — Price Penalty**:

$$\text{Penalty} = \begin{cases} 0.5 & \text{if price\% < -4\%} \\ 1.1 & \text{if -1\% ≤ price\% ≤ +2\% (consolidation)} \\ 1.0 & \text{otherwise} \end{cases}$$

**Step 3 — Final Score**:

$$\text{Hybrid} = \text{clamp}(\text{Raw} \times \text{Penalty}, 0, 1)$$

### Schedule

| Trigger | Detail |
|---------|--------|
| **Realtime** | Cron `*/5 * * * *` via `features-service` |

### Output

| Storage | Key/Path | Consumer |
|---------|----------|----------|
| R2 | `intraday/{TICKER}.json` → `rawHybrid` (pre-divergence), `hybridScore` (final) | Frontend screener |

### Source Code

`workers/features-service/src/index.js`

---

<a id="cf-02-divergence-factor"></a>
## CF-02: Divergence Factor

### Ingredients

| Item | Detail |
|------|--------|
| **Source 1** | BF-05: SM State dari D1 `smart_money_features` |
| **Source 2** | Intraday signal direction (bullish/bearish) from Delta% |
| **Source 3** | SM net direction (net foreign flow sign) |

### Recipe

Scenario-based fixed multiplier:

| SM State | Intraday Direction | Factor | Label |
|----------|-------------------|--------|-------|
| DISTRIBUTION | Bullish | 0.5 | **Retail Trap** |
| ACCUMULATION | Bearish | 0.7 | **Shakeout** |
| ACCUMULATION | Bullish + SM inflow | 1.2 | **Confirmed** |
| NEUTRAL | Any | 1.0 | No divergence |
| READY_MARKUP | Bullish | 1.15 | **Markup Confirmed** |

**Applied**:

$$\text{Final Hybrid} = \text{Raw Hybrid} \times \text{Divergence Factor}$$

### Schedule

| Trigger | Detail |
|---------|--------|
| **Realtime** | Cron `*/5 * * * *` via `features-service` |

### Output

| Storage | Key/Path | Consumer |
|---------|----------|----------|
| R2 | `intraday/{TICKER}.json` → `divFactor`, `divLabel`, `smDirection` | Frontend badge |

### Source Code

`workers/features-service/src/index.js`

---

<a id="cf-03-hybrid-divergence-score"></a>
## CF-03: Hybrid Divergence Score

### Ingredients

| Item | Detail |
|------|--------|
| **Dependency** | OF-09 (Absorption), Price change, Context from features-service |

### Recipe

$$\text{Hybrid Divergence} = \frac{|\Delta_{cumulative}|}{\text{Price Change} + \varepsilon}$$

High delta + low price change = high absorption = potential breakout.

### Schedule

| Trigger | Detail |
|---------|--------|
| **Realtime** | Cron `*/5 * * * *` via `features-service` |

### Output

| Storage | Key/Path | Consumer |
|---------|----------|----------|
| R2 | `intraday/{TICKER}.json` → `hybridDivergence` | Screener ranking |

### Source Code

`workers/features-service/src/index.js`

---

<a id="cf-04-signal-classification"></a>
## CF-04: Signal Classification

### Ingredients

| Item | Detail |
|------|--------|
| **Dependency** | CF-01 (Hybrid Score), OF-03 (Delta%), BF-03 (Z-NGR), BF-05 (SM State), CF-02 (Divergence Factor), Price% |

### Recipe

Priority cascade (first match wins):

| Priority | Condition | Signal |
|----------|-----------|--------|
| 1 | divLabel = "Retail Trap" | `RETAIL_TRAP` |
| 2 | divLabel = "Shakeout" | `SHAKEOUT` |
| 3 | divLabel = "SM Confirmed" | `SM_CONFIRMED` |
| 4 | score > 0.6, divFactor ≥ 1.1 | `STRONG_BUY` |
| 5 | delta > 80%, Z-NGR < -0.5 | `WATCH_DISTRIB` |
| 6 | delta < 40%, Z-NGR > 0.7 | `WATCH_ACCUM` |
| 7 | score > 0.5 | `MODERATE_BUY` |
| 8 | score < 0.3 | `WEAK` |
| 9 | — | `NEUTRAL` |

### Schedule

| Trigger | Detail |
|---------|--------|
| **Realtime** | Cron `*/5 * * * *` via `features-service` |

### Output

| Storage | Key/Path | Consumer |
|---------|----------|----------|
| R2 | `intraday/{TICKER}.json` → `signal` | Frontend badge, notification |

### Source Code

`workers/features-service/src/index.js`

---

# Appendix

## A. Storage Map

```
┌─────────────────────────────────────────────────────────────────┐
│ R2: tape-data-saham                                             │
│ ├── footprint/{TICKER}/1m/{YYYY}/{MM}/{DD}/{HH}.jsonl  [OF-01] │
│ ├── raw_lt/{TICKER}/{DATE}/                                     │
│ ├── raw_ob/{TICKER}/                                   [OF-07] │
│ ├── processed/{DATE}/{TICKER}.json                     [OF-02] │
│ └── intraday/{TICKER}.json        [OF-03..11, CF-01..04]       │
├─────────────────────────────────────────────────────────────────┤
│ R2: broksum-data                                                │
│ ├── raw-broksum/{TICKER}/{DATE}                        [BF-01] │
│ ├── features/z_score/{TICKER}.json         [BF-01..06, BF-10]  │
│ ├── cache/screener-accum.json              [BF-08..10]          │
│ └── cache/foreign-scanner.json             [BF-07]             │
├─────────────────────────────────────────────────────────────────┤
│ D1: sssaham-db                                                  │
│ ├── daily_broker_flow            (daily net flows)     [BF-07] │
│ ├── smart_money_features         (z-scores, state)     [BF-01] │
│ ├── temp_footprint_consolidate   (5-min OHLCV)         [OF-01] │
│ └── feature_logs                 (audit trail)                  │
├─────────────────────────────────────────────────────────────────┤
│ KV: sssaham-kv                                                  │
│ ├── watchlist:{UID}              (user watchlist)               │
│ └── token:{KEY}                  (auth tokens)                  │
└─────────────────────────────────────────────────────────────────┘
```

## B. Schedule Summary

```
┌──────────────────┬─────────────────────┬───────────────────────────┐
│ Time (UTC)       │ Worker              │ Features Produced         │
├──────────────────┼─────────────────────┼───────────────────────────┤
│ Every 2–5s       │ livetrade-durable-  │ OF-01, OF-04              │
│ (DO alarm)       │ object              │ (raw footprint candles)   │
├──────────────────┼─────────────────────┼───────────────────────────┤
│ */5 * * * *      │ features-service    │ OF-03, CF-01, CF-02,      │
│ (every 5 min)    │                     │ CF-03, CF-04              │
├──────────────────┼─────────────────────┼───────────────────────────┤
│ 0 * * * *        │ livetrade-taping-   │ OF-02, OF-05..11          │
│ (hourly)         │ agregator           │ (backfill aggregation)    │
├──────────────────┼─────────────────────┼───────────────────────────┤
│ 30 11 * * 1-5    │ features-service    │ BF-01..06, BF-10          │
│ (18:30 WIB)      │ (dispatch)          │ (SM Z-Scores + VWAP)      │
├──────────────────┼─────────────────────┼───────────────────────────┤
│ 45 11 * * 1-5    │ features-service    │ BF-08..10                 │
│ (18:45 WIB)      │ (screener agg)      │ (Accum + Score + VWAP)    │
├──────────────────┼─────────────────────┼───────────────────────────┤
│ On-demand (HTTP) │ app-orderflow       │ OF-05..08                 │
│                  │                     │ (realtime signals)        │
├──────────────────┼─────────────────────┼───────────────────────────┤
│ On-demand (HTTP) │ api-saham           │ BF-07                     │
│                  │                     │ (foreign flow scanner)    │
└──────────────────┴─────────────────────┴───────────────────────────┘
```

## C. Feature Dependency Graph

```
                    ┌──────────────┐
                    │ Trade Stream │
                    └──────┬───────┘
                           │
              ┌────────────┼────────────┐
              ▼            ▼            ▼
          ┌──────┐    ┌────────┐   ┌────────┐
          │OF-01 │    │ OF-04  │   │ OF-07  │
          │Delta │    │Bid/Ask │   │Intentiн│
          └──┬───┘    └────────┘   └───┬────┘
             │                         │
    ┌────────┼────────┐                │
    ▼        ▼        ▼                │
┌──────┐ ┌──────┐ ┌──────┐            │
│OF-02 │ │OF-05 │ │OF-06 │            │
│CVD   │ │HAKA  │ │Moment│            │
└──┬───┘ └──┬───┘ └──┬───┘            │
   │        │        │                │
   │        ├────────┤                │
   │        ▼        ▼                │
   │   ┌─────────┐                    │
   │   │ OF-11   │                    │
   │   │Hidden   │                    │
   │   │Accum    │                    │
   │   └─────────┘                    │
   │                                  │
   ▼                                  ▼
┌──────┐                         ┌────────┐
│OF-03 │                         │ OF-08  │
│Delta%│                         │ Fused  │
└──┬───┘                         └────────┘
   │
   │        ┌─────────────────────┐
   │        │ R2: raw-broksum     │
   │        └──────────┬──────────┘
   │                   │
   │    ┌──────────────┼──────────────┐
   │    ▼              ▼              ▼
   │ ┌──────┐     ┌──────┐      ┌──────┐
   │ │BF-01 │     │BF-02 │      │BF-03 │
   │ │Effort│     │Result│      │NGR   │
   │ └──┬───┘     └──┬───┘      └──┬───┘
   │    │             │             │
   │    │    ┌────────┤             │
   │    │    ▼        ▼             │
   │    │ ┌──────┐ ┌──────┐        │
   │    │ │BF-04 │ │BF-05 │        │
   │    │ │Elast │ │State │        │
   │    │ └──────┘ └──┬───┘        │
   │    │             │             │
   │    └──────┬──────┘             │
   │           ▼                    │
   │      ┌──────┐                  │
   │      │BF-06 │                  │
   │      │Score │                  │
   │      └──────┘                  │
   │                                │
   │      ┌──────┐                  │
   │      │BF-10 │                  │
   │      │VWAP  │                  │
   │      └──────┘                  │
   │           │                    │
   ├───────────┼────────────────────┤
   ▼           ▼                    ▼
┌─────────────────────────────────────┐
│ CF-01: Hybrid Score                 │
│ CF-02: Divergence Factor            │
│ CF-03: Hybrid Divergence            │
│ CF-04: Signal Classification        │
└─────────────────────────────────────┘
```

## D. Data Freshness

| Feature Group | Latency | Note |
|---------------|---------|------|
| OF-01, OF-04 | **2–5 seconds** | Realtime via DO alarm |
| OF-05..08 | **< 1 second** | On-demand HTTP computation |
| OF-02, OF-09..11 | **~1 hour** | Hourly cron aggregation |
| OF-03, CF-01..04 | **~5 minutes** | Cron `*/5 * * * *` |
| BF-01..06, BF-10 | **~EOD** | Cron 18:30 WIB (after market close) |
| BF-07 | **On-demand** | Computed per HTTP request |
| BF-08..10 | **~EOD** | Cron 18:45 WIB |
