# PRD — Sector WebSocket Frequency & Price Range Taping

> **Document ID**: 0014_sector  
> **Version**: 1.0  
> **Date**: 2026-02-25  
> **Status**: Proposed

---

## 1) Latar Belakang

Data `freq` di pipeline sekarang kadang undercount karena fallback dari footprint/candle count.  
Kita akan ambil **frequency** dan **range harga** langsung dari stream `SS2` (websocket endpoint), lalu simpan ke R2 dengan pola **taping bercabang**:

1. per emiten per sektor
2. agregat per sektor per hari

Tujuan utamanya: sumber `freq` lebih representatif (direct market feed), bisa dipakai realtime + rekonsiliasi harian.

---

## 2) Objective

1. Menangkap data `SS2` untuk emiten hasil query sektoral.  
2. Mengekstrak minimal field:
	- `freq_tx` (frequency)
	- `price_high`
	- `price_low`
	- `price_last`
	- `levels[]` (price per level + lot/frequency)
	- metadata (`sector`, `symbol`, `board`, `ts`).
3. Menulis ke R2 dual-path:
	- `tape-data-saham/sector/{SECTOR}/{SYMBOL}/{YYYY}/{MM}/{DD}.jsonl`
	- `tape-data-saham/sector/{SECTOR}/{YYYY}/{MM}/{DD}.jsonl`
4. Menyediakan dataset siap konsumsi untuk fallback `freq/range` di scanner.

---

## 3) Non-Goal (fase ini)

1. Tidak mengganti total pipeline orderflow existing.  
2. Tidak membuat scoring baru dari data sektoral.  
3. Tidak membuat UI baru (hanya data layer + kontrak).

---

## 4) Sumber Data & Handshake

### 4.1 Query Top Stock per sektor

Request:

```json
{"event":"cmd","data":{"cmdid":346,"param":{"cmd":"query","service":"midata","param":{"source":"datafeed","index":"en_qu_get_top_stock","args":["TopStock","IDXBASIC","pchg","DESC",30]}}},"cid":338}
```

Response sample:

```json
{"event":"record","data":{"event":"record","cmdid":346,"recno":1,"data":{"get_top_stock":"INKP"}}}
{"event":"stream","data":{"event":"stream","source":"IDX","service":"mi","rtype":"SS2","code":"INKP","data":{"subcmd":"INIT","code":"INKP","board":"RG","data":"D|I|INKP|RG|10300|12000|10200|12000|879245|981661100000|18693|10300|11164|11975|390|12000|43479|41890|71037|1700|0|16|-1|10|1|0|0|1","trendinfo":["TREND_R10_5:val","TREND_R10_5:valNWR"]}}}
```

### 4.2 Query Traded Summary (Harga per Level)

Request:

```json
{"event":"cmd","data":{"cmdid":344,"param":{"service":"midata","cmd":"query","param":{"source":"datafeed","index":"en_qu_TradedSummary","args":["TKIM"]}}},"cid":346}
```

Response sample:

```json
{"event":"record","data":{"event":"record","cmdid":344,"recno":1,"data":{"en_qu_tradedsummary":"9150.00|17558|23094|600|535"}}}
{"event":"record","data":{"event":"record","cmdid":344,"recno":2,"data":{"en_qu_tradedsummary":"9125.00|2501|6651|142|207"}}}
{"event":"record","data":{"event":"record","cmdid":344,"recno":3,"data":{"en_qu_tradedsummary":"9100.00|1808|4717|95|128"}}}
```

### 4.3 Sektor target (awal)

- `IDXBASIC`
- `IDXENERGY`
- `IDXINDUST`
- `IDXNONCYC`
- `IDXCYCLC`
- `IDXHEALTH`
- `IDXFINANCE`
- `IDXPROPERT`
- `IDXTECHNO`
- `IDXINFRA`
- `IDXTRANS`

> Final list disimpan sebagai config (`SECTOR_LIST`) agar mudah tambah/kurang tanpa ubah logic inti.

---

## 5) Data Contract (Normalized Record)

Setiap event `SS2` dinormalisasi ke JSON line:

```json
{
  "ts": "2026-02-25T03:50:12.321Z",
  "date": "2026-02-25",
  "sector": "IDXBASIC",
  "symbol": "INKP",
  "board": "RG",
  "price_last": 12000,
  "price_high": 12000,
  "price_low": 10200,
  "freq_tx": 18693,
	"levels": [
		{"price": 9150, "b_lot": 17558, "s_lot": 23094, "t_lot": 40652, "b_freq": 600, "s_freq": 535},
		{"price": 9125, "b_lot": 2501, "s_lot": 6651, "t_lot": 9152, "b_freq": 142, "s_freq": 207}
	],
  "raw": "D|I|INKP|RG|10300|12000|10200|12000|879245|981661100000|18693|...",
  "source": "ws:ss2"
}
```

## Parsing field minimum dari `data` string `D|I|...`

Mapping minimal yang dipakai pada fase ini:

- `symbol` = token[2]
- `board` = token[3]
- `price_low` = token[6]
- `price_last` = token[7]
- `freq_tx` = token[10]
- `price_high` = `max(price_last, price_low)` jika high token tidak tersedia/invalid

> Catatan: jika mapping resmi token tersedia, update parser agar `price_high` memakai field resmi, bukan heuristic.

### Parsing `en_qu_tradedsummary` (level)

Format line: `PRICE|B_LOT|S_LOT|B_FREQ|S_FREQ`

- `price` = token[0]
- `b_lot` = token[1]
- `s_lot` = token[2]
- `b_freq` = token[3]
- `s_freq` = token[4]
- `t_lot` = `b_lot + s_lot`

---

## 6) R2 Storage Design

### 6.1 Per Emiten

`sector/{SECTOR}/{SYMBOL}/{YYYY}/{MM}/{DD}.jsonl`

Contoh:

`sector/IDXBASIC/INKP/2026/02/25.jsonl`

### 6.2 Agregat Sektor Harian

`sector/{SECTOR}/{YYYY}/{MM}/{DD}.jsonl`

Contoh:

`sector/IDXBASIC/2026/02/25.jsonl`

### 6.3 Aturan Write

1. **Dual write** per event valid (emiten + sektor).  
2. Append newline-delimited JSON (`jsonl`).  
3. Flush buffer per 5 detik atau saat buffer > N record.  
4. Tambahkan `generated_at` di envelope jika nanti dibutuhkan format chunked object.

---

## 7) Arsitektur Implementasi (Taping Bercabang)

1. **Discovery Worker**
	- Query `TopStock` per sektor.
	- Build watchlist `{sector -> symbols[]}`.

2. **Stream Worker / Durable Object**
	- Maintain websocket connection.
	- Subscribe simbol watchlist.
	- Parse `SS2` menjadi record normal.
	- Push ke in-memory buffer keyed by:
	  - `{sector,symbol,date}`
	  - `{sector,date}`

3. **Writer (alarm/timer)**
	- Flush buffer ke R2 tiap interval.
	- Retry write dengan backoff jika gagal.

4. **Quality Guard**
	- Drop record invalid (`symbol kosong`, `freq_tx` non numeric, harga negatif).
	- Dedup ringan: skip jika `(symbol, freq_tx, price_last, ts_bucket)` sama.
	- Batasi `levels` dengan `level_limit` agar payload tetap terkendali.

---

## 8) Integrasi ke Pipeline Existing

Prioritas fallback `freq` (setelah fitur ini live):

1. `broksum total_freq`
2. `sector taping latest freq_tx` (per symbol, same day)
3. `processed/{date}.json` freq
4. `candle_count` (last resort)

Untuk range:

1. `sector taping latest {price_low, price_high}`
2. footprint aggregate range

---

## 9) Reliability & Observability

Metric minimum:

1. `ws_connected` (boolean + uptime)
2. `records_in` per menit
3. `records_written` per path
4. `flush_fail_count`
5. `sector_coverage` (% sektor punya data hari ini)
6. `symbol_coverage` (% watchlist dapat SS2)

Log minimum:

- handshake success/fail
- resubscribe event
- flush summary (records/path/latency)

---

## 10) Security & Cost Guardrail

1. Max symbols per sektor configurable (default 30).  
2. Max flush frequency configurable.  
3. Batasi ukuran buffer untuk hindari memory spike.  
4. Gunakan key partition harian untuk memudahkan lifecycle/retention.

---

## 11) Step Implementasi (Actionable)

### Phase 1 — Foundation

1. Tambah config:
	- `SECTOR_LIST`
	- `TOP_N_PER_SECTOR`
	- `FLUSH_INTERVAL_MS`
2. Buat parser `parseSS2()` untuk ekstrak `freq/range` minimal.
3. Buat normalizer `toSectorRecord()`.

### Phase 2 — Taping Engine

4. Implement websocket session manager (connect, heartbeat, reconnect, resubscribe).  
5. Implement query `TopStock` per sektor dan build watchlist berkala (mis. tiap 5 menit).  
6. Implement branching buffer:
	- buffer emiten (`sector/symbol/date`)
	- buffer sektor (`sector/date`)

### Phase 3 — R2 Writer

7. Implement flush periodic ke 2 path R2 sekaligus.  
8. Tambah retry + backoff + dead-letter log untuk write fail.  
9. Tambah dedup ringan sebelum write.

### Phase 4 — Consumption

10. Buat helper baca latest sector-taping per symbol (same day).  
11. Integrasikan helper ini ke fallback chain `freq` di endpoint scanner/orderflow.  
12. Tambah guard: jika data sector stale > X menit, skip.

### Phase 5 — QA & Rollout

13. Uji 1 sektor dulu (`IDXBASIC`) selama 1 hari market.  
14. Validasi `freq_tx` vs referensi market snapshot.  
15. Rollout bertahap ke seluruh sektor.  
16. Aktifkan monitor dan alert coverage.

### Phase 6 — Level Data (Traded Summary)

17. Tambah query `en_qu_TradedSummary` per simbol hasil `TopStock`.  
18. Parse level lines ke `levels[]` terstandarisasi.  
19. Simpan `levels[]` di record yang sama (dual-write tetap).  
20. Tambah parameter runtime:
	- `include_levels=true|false`
	- `level_limit` (default 20)
	- `level_idle_ms`, `level_max_ms`

---

## 12) Acceptance Criteria

1. File harian dual-path terbuat untuk sektor aktif.  
2. Minimal 95% simbol watchlist punya >= 1 record valid/jam saat market session.  
3. `freq_tx` BMRI/BBRI/TLKM tidak lagi stuck di angka candle-like saat data direct tersedia.  
4. Endpoint scanner menampilkan `freq` lebih konsisten terhadap market screen.
5. Untuk simbol yang tersedia, record menyertakan `levels[]` valid dari `en_qu_TradedSummary`.

---

## 13) Risiko & Mitigasi

1. **Parser token meleset** → sediakan feature flag + raw capture + quick remap.  
2. **WS disconnect sering** → exponential backoff + auto resubscribe + heartbeat.  
3. **Biaya write tinggi** → batching + flush interval + optional compression/compaction EOD.  
4. **Data duplikat** → dedup key per menit + idempotent merge saat read.

---

## 14) Next Iteration (opsional)

1. Tambah endpoint ringkas: `/sector/latest?sector=IDXBASIC&symbol=INKP`  
2. Tambah agregasi 1m/5m dari raw jsonl sektor.  
3. Tambah insight sektoral (breadth, avg freq, range expansion score).