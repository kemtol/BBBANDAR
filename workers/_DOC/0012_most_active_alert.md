# PRD 0012 — Most Active Alert

## 1) Ringkasan
Bangun **pipeline menit-an** untuk:
1. Mengambil roster **Most Active / Top Change** IDX.
2. Menentukan emiten paling “hot” (continuation candidate).
3. Mengambil **orderbook** per emiten hot via kelas terpisah.
4. Menyajikan UI: **chart di atas**, lalu tab bawah **Feed/Catalyst** dan **Brokerflow**.

Tujuan utama: membantu user gaya **trend continuation / ARA Hunter** menilai apakah momentum saham **masih berlanjut** atau **sudah selesai masa tampilnya**.

---

## 2) Latar Belakang Masalah
Watchlist intraday sering berubah cepat. User membutuhkan:
- shortlist emiten yang benar-benar aktif,
- konteks narasi (feed/catalyst),
- dan konfirmasi mikrostruktur (orderbook/brokerflow),
tanpa pindah banyak halaman.

Saat ini data sudah ada secara terpisah, namun belum menjadi satu pipeline terarah untuk keputusan continuation vs exhaustion.

---

## 3) Objective Produk
### Objective Utama
- Menyediakan **ranking hot emiten per menit** yang stabil dan actionable.

### Objective Turunan
- Meminimalkan noise (false hot karena spike sesaat).
- Menyatukan sinyal makro (aktivitas) + mikro (orderbook) + konteks (feed/catalyst).
- Menampilkan keputusan cepat: `Continuation`, `Watch`, `Exhaustion`.

### Non-Objective (v1)
- Tidak membangun auto-trading.
- Tidak membangun prediksi harga jangka panjang.
- Tidak mengganti engine scoring global lain di luar scope fitur ini.

---

## 4) Persona & Use Case
### Persona
- Trader intraday agresif (ARA Hunter, momentum continuation).

### Use Case Inti
1. User buka halaman emiten.
2. Sistem refresh roster most active tiap 1 menit.
3. Sistem highlight top hot candidates.
4. User lihat chart + catalyst + brokerflow.
5. User ambil keputusan: lanjut hold/add, wait, atau exit/avoid.

---

## 5) Definisi Istilah
- **Roster**: daftar emiten hasil query most active/top change.
- **Hot Score**: skor komposit untuk ranking continuation candidate.
- **Continuation**: momentum masih valid.
- **Exhaustion**: gejala pelemahan momentum.

---

## 6) Requirement Fungsional
### FR-1 — Ingestion Most Active (Interval 1 Menit)
- Sistem mengirim query roster tiap 60 detik.
- Jika gagal, retry dengan backoff ringan.

Contoh handshake/query:
```json
{"event":"cmd","data":{"cmdid":94,"param":{"cmd":"query","service":"midata","param":{"source":"datafeed","index":"xen_qu_top_stock_gl","args":["COMPOSITE","2026-2-20","2026-2-20"],"info":{"orderby":[[3,"ASC","N"]],"sum":[6]},"pagelen":60,"slid":""}}},"cid":96}
```

### FR-2 — Scoring “Most Hot”
Untuk tiap emiten roster, hitung `hot_score` dari komponen minimum:
- activity rank (dari roster),
- value/volume acceleration (menit berjalan vs baseline singkat),
- persistence (berapa menit berturut masuk roster),
- optional: spread health + imbalance sederhana.

Output status klasifikasi:
- `Continuation`
- `Watch`
- `Exhaustion`

### FR-3 — Orderbook Pipeline (Kelas Terpisah)
- Orderbook diambil hanya untuk emiten prioritas (mis. Top-N hot, default N=10).
- Gunakan subscription OB2 per kode.

Contoh subscribe orderbook:
```json
{"event":"cmd","data":{"cmdid":248,"param":{"cmd":"subscribe","service":"mi","code":"BUVA","level":10,"subsid":"ee147a5ffa","rtype":"OB2"}},"cid":250}
```

- Kelas orderbook wajib terpisah dari kelas roster agar modular:
	- `MostActivePipeline` (query + scoring)
	- `OrderbookPipeline` (subscribe/maintain/unsubscribe)

### FR-4 — Integrasi UI
Layout halaman:
1. **Chart** di bagian atas.
2. Di bawah chart, tab:
	 - **Feed/Catalyst**
	 - **Brokerflow**

Tambahan UI:
- badge status (`Continuation/Watch/Exhaustion`),
- timestamp update terakhir,
- indikator koneksi data (live/degraded).

### FR-5 — Watchlist Dinamis
- Jika simbol keluar dari Top-N selama X menit (default 3), lakukan unsubscribe orderbook.
- Jika simbol masuk Top-N, subscribe otomatis.

### FR-6 — Explainability Ringkas
Di tiap simbol tampilkan alasan singkat status, contoh:
- “Persistence 5m, buy imbalance kuat, spread sehat” (Continuation)
- “Rank naik tapi imbalance melemah” (Watch)
- “Value tinggi namun distribusi broker dominan” (Exhaustion)

---

## 7) Requirement Non-Fungsional
- Refresh siklus: **60 detik**.
- Target latensi render setelah data masuk: < 2 detik.
- Toleran disconnect websocket, auto reconnect.
- Logging terstruktur untuk setiap siklus menit-an.
- Graceful degradation saat orderbook tidak tersedia.

---

## 8) Arsitektur Pipeline (v1)
### Komponen
1. **MostActiveIngestor**
	 - Mengirim query roster per menit.
	 - Menyimpan snapshot ring buffer (mis. 30 menit terakhir).

2. **HotScoreEngine**
	 - Hitung `hot_score` + label status.
	 - Menyediakan alasan klasifikasi.

3. **OrderbookPipeline (separate class)**
	 - Manage subscribe/unsubscribe OB2 untuk Top-N.
	 - Hitung metrik mikrostruktur sederhana (imbalance, spread).

4. **UI Composer**
	 - Menyatukan chart, feed/catalyst, brokerflow.
	 - Menampilkan badge status + reason.

### Data Flow Singkat
1. Minute tick → query roster.
2. Roster diterima → scoring hot.
3. Pilih Top-N → sinkronkan subscription orderbook.
4. Gabungkan hasil ke model UI.
5. Render chart + tab panel.

---

## 9) Kontrak Data (Draft)
```json
{
	"timestamp": 1760000000000,
	"index": "COMPOSITE",
	"top": [
		{
			"code": "BUVA",
			"rank": 1,
			"hot_score": 87.4,
			"status": "Continuation",
			"reasons": [
				"persistence_5m",
				"buy_imbalance_strong",
				"spread_healthy"
			],
			"orderbook": {
				"imbalance": 0.62,
				"spread_bps": 14.2,
				"depth_ratio": 1.45
			}
		}
	]
}
```

---

## 10) Rules Klasifikasi (Initial Heuristic)
> Nilai threshold final akan dituning dari data historis.

- **Continuation**
	- persistence ≥ 3 menit,
	- hot_score tinggi (mis. ≥ 70),
	- imbalance positif dan spread tidak melebar ekstrem.

- **Watch**
	- rank/score membaik tapi persistence belum kuat,
	- atau metrik orderbook campuran.

- **Exhaustion**
	- score turun bertahap 2–3 siklus,
	- spread melebar,
	- imbalance buy melemah/distribusi meningkat.

---

## 11) Observability & Alerting
- Log per siklus:
	- waktu query,
	- jumlah roster,
	- top-N symbol,
	- subscribe/unsubscribe count,
	- error rate.
- Metric minimum:
	- `most_active_cycle_success_rate`
	- `orderbook_subscription_active`
	- `hot_signal_count`
	- `pipeline_cycle_latency_ms`

---

## 12) Risiko & Mitigasi
- **Rate limit / disconnect WS** → backoff + reconnect + state restore.
- **Noise intraday tinggi** → gunakan persistence + smoothing score.
- **Orderbook tidak lengkap** → fallback status berbasis roster + feed.
- **Over-subscribe banyak simbol** → batasi Top-N + timeout unsubscribe.

---

## 13) Acceptance Criteria
1. Sistem melakukan refresh roster setiap 60 detik (stabil).
2. Tersedia ranking hot emiten dengan status (`Continuation/Watch/Exhaustion`).
3. Orderbook berjalan di kelas/komponen terpisah dan hanya untuk Top-N.
4. UI sesuai: chart di atas, tab bawah `Feed/Catalyst` dan `Brokerflow`.
5. Terdapat timestamp update + indikator status koneksi data.
6. Jika websocket putus, sistem reconnect otomatis tanpa reload manual.

---

## 14) Rencana Rollout
### Phase 1 (v1)
- Roster menit-an + scoring dasar + UI status badge.

### Phase 2 (v1.1)
- Orderbook top-N + reason engine lebih jelas.

### Phase 3 (v1.2)
- Tuning threshold berbasis evaluasi historis + QA trading desk.

---

## 15) Open Questions
1. Top-N default final: 10, 15, atau 20?
2. Apakah universe awal hanya `COMPOSITE`?
3. Threshold status final ditetapkan statis atau adaptif per sesi pasar?
4. Durasi persistence optimal untuk ARA Hunter: 3m vs 5m?

---

## 16) Catatan Implementasi Teknis
- Pisahkan class agar mudah di-test:
	- `MostActiveClient` (query roster)
	- `HotScoreEngine` (scoring/label)
	- `OrderbookClient` (OB2 subscribe lifecycle)
	- `MostActiveOrchestrator` (minute loop + merge + publish)
- Gunakan ring buffer in-memory untuk snapshot menit-an.
- Pastikan `cid` unik/naik untuk setiap command websocket.

---

## 17) R2 Storage Design (Path & Format)

Bagian ini menambahkan desain penyimpanan R2 untuk dua stream utama:
1. **Snapshot roster per menit** (hasil query most active).
2. **Tap + flush OB2 per emiten** (hanya simbol prioritas).

### 17.1 Prinsip Umum
- Simpan **raw + normalized** agar mudah audit dan cepat dipakai scoring/UI.
- Partition key berbasis waktu market (`YYYY/MM/DD/HH/mm`) untuk query cepat.
- Semua timestamp disimpan dalam:
	- `ts_unix_ms` (epoch),
	- `ts_iso` (UTC ISO-8601),
	- `market_date` (zona market lokal).
- Kompresi object: `gzip` untuk JSON besar.

### 17.2 Namespace/Bucket Konseptual
- `r2://most-active-snapshots` → roster per menit.
- `r2://orderbook-ob2-raw` → event OB2 mentah (tap stream).
- `r2://orderbook-ob2-minute` → agregasi menit OB2 per emiten.
- `r2://most-active-manifest` → manifest index per menit (untuk fast lookup).

> Nama bucket final mengikuti binding environment worker yang dipakai saat deploy.

### 17.3 Key Path — Snapshot Roster per Menit
Format key (raw):
`most-active/raw/v1/index={INDEX}/date={YYYY-MM-DD}/hour={HH}/minute={mm}/snapshot_{ts_unix_ms}_{cid}.json.gz`

Format key (normalized):
`most-active/norm/v1/index={INDEX}/date={YYYY-MM-DD}/hour={HH}/minute={mm}/top60.json`

Contoh:
- `most-active/raw/v1/index=COMPOSITE/date=2026-02-20/hour=09/minute=31/snapshot_1771570260000_96.json.gz`
- `most-active/norm/v1/index=COMPOSITE/date=2026-02-20/hour=09/minute=31/top60.json`

### 17.4 Key Path — OB2 Tap & Flush per Emiten
#### A) Raw OB2 Event (append-style by chunk)
`ob2/raw/v1/index={INDEX}/symbol={CODE}/date={YYYY-MM-DD}/hour={HH}/minute={mm}/chunk_{seq}.jsonl.gz`

Isi: JSONL event OB2 selama interval menit berjalan (atau hingga chunk size).

#### B) Aggregated OB2 Minute (1 object/symbol/minute)
`ob2/minute/v1/index={INDEX}/symbol={CODE}/date={YYYY-MM-DD}/hour={HH}/minute={mm}/summary.json`

Isi: ringkasan metrik mikrostruktur 1 menit (imbalance, spread, depth ratio, update_count).

### 17.5 Key Path — Manifest per Menit
`manifest/v1/index={INDEX}/date={YYYY-MM-DD}/hour={HH}/minute={mm}/manifest.json`

Fungsi:
- daftar top-N simbol,
- pointer object `top60`, `ob2/minute/*`,
- status flush dan completeness.

---

## 18) Object Schema (Draft)

### 18.1 Schema Raw Snapshot (Most Active)
```json
{
	"schema": "most-active.raw.v1",
	"index": "COMPOSITE",
	"cmdid": 94,
	"cid": 96,
	"request": {
		"event": "cmd",
		"data": {
			"param": {
				"cmd": "query",
				"service": "midata"
			}
		}
	},
	"response": {},
	"ts_unix_ms": 1771570260000,
	"ts_iso": "2026-02-20T02:31:00.000Z",
	"market_date": "2026-02-20"
}
```

### 18.2 Schema Normalized Snapshot
```json
{
	"schema": "most-active.norm.v1",
	"index": "COMPOSITE",
	"minute_key": "2026-02-20T09:31",
	"rows": [
		{
			"code": "BUVA",
			"rank": 1,
			"value": 123456789,
			"volume": 45678900,
			"change_pct": 24.8
		}
	],
	"row_count": 60,
	"ts_unix_ms": 1771570260000
}
```

### 18.3 Schema Raw OB2 Event (JSONL line)
```json
{
	"schema": "ob2.raw.v1",
	"index": "COMPOSITE",
	"symbol": "BUVA",
	"subsid": "ee147a5ffa",
	"seq": 12031,
	"bid": [[123, 50000], [122, 35000]],
	"ask": [[124, 42000], [125, 61000]],
	"level": 10,
	"ts_unix_ms": 1771570265123,
	"ts_iso": "2026-02-20T02:31:05.123Z"
}
```

### 18.4 Schema OB2 Minute Summary
```json
{
	"schema": "ob2.minute.v1",
	"index": "COMPOSITE",
	"symbol": "BUVA",
	"minute_key": "2026-02-20T09:31",
	"update_count": 148,
	"imbalance": 0.62,
	"spread_bps_avg": 14.2,
	"spread_bps_p95": 21.4,
	"depth_ratio_avg": 1.45,
	"last_px": 124,
	"ts_close_unix_ms": 1771570319999
}
```

### 18.5 Schema Manifest
```json
{
	"schema": "most-active.manifest.v1",
	"index": "COMPOSITE",
	"minute_key": "2026-02-20T09:31",
	"topn": ["BUVA", "BBCA", "ANTM"],
	"objects": {
		"top60": "most-active/norm/v1/index=COMPOSITE/date=2026-02-20/hour=09/minute=31/top60.json",
		"ob2": [
			"ob2/minute/v1/index=COMPOSITE/symbol=BUVA/date=2026-02-20/hour=09/minute=31/summary.json"
		]
	},
	"flush": {
		"ob2_expected": 10,
		"ob2_written": 10,
		"complete": true
	},
	"ts_unix_ms": 1771570320100
}
```

---

## 19) Flush Policy (OB2)

### 19.1 Trigger Flush
- Flush default **setiap 60 detik** per simbol.
- Early flush jika event count mencapai threshold (mis. 5.000 event/chunk).
- Final flush saat simbol di-unsubscribe.

### 19.2 Watchlist Dinamis
- Subscribe untuk simbol yang masuk Top-N.
- Grace period keluar Top-N: 3 menit.
- Jika melewati grace period, lakukan unsubscribe + final flush.

### 19.3 Idempotency & Dedup
- Gunakan `minute_key + symbol + seq_range` untuk mencegah write ganda.
- Manifest menyimpan status `complete` dan `ob2_written`.

---

## 20) Retention, Tiering, dan Biaya
- `ob2/raw/*`: simpan 7–14 hari (high volume).
- `ob2/minute/*`: simpan 90 hari (analisis menengah).
- `most-active/norm/*` + `manifest/*`: simpan 180 hari.
- Arsip jangka panjang opsional ke cold storage bila diperlukan backtest.

---

## 21) Query Pattern untuk UI dan Scoring
- UI menit berjalan:
	1. Baca `manifest` minute terbaru.
	2. Baca `top60` normalized.
	3. Baca `ob2/minute summary` untuk top-N.
- Scoring continuation/exhaustion:
	- gunakan rolling window 5–30 menit dari `norm + ob2/minute`.

---

## 22) Error Handling & Smart Repair
- Jika write raw sukses tapi summary gagal:
	- tandai manifest `complete=false`.
	- jadwalkan repair job untuk regenerate summary dari raw chunk.
- Jika snapshot minute hilang:
	- backfill dari data minute sebelum/sesudah + flag `reconstructed=true`.
- Semua object wajib memiliki `schema` version agar aman untuk migrasi.

---

## 23) Security & Governance
- Jangan simpan credential/session sensitif ke R2 object.
- Redact field sensitif dari payload raw sebelum persist (jika ada token internal).
- Gunakan prefix access policy per service agar least privilege.

---

## 24) Acceptance Criteria Tambahan (Storage)
1. Setiap menit tersedia object `top60` + `manifest` untuk index aktif.
2. Untuk top-N simbol, tersedia `ob2/minute summary` minute yang sama.
3. Jika terjadi disconnect sesaat, pipeline melanjutkan flush di menit berikutnya tanpa korupsi data.
4. Minimal 99% minute windows per hari memiliki `manifest.complete=true`.
5. Semua object mengandung `schema`, `ts_unix_ms`, dan partition key yang valid.

---

## 25) Requirement Tambahan — Z-Features (Trader Continuation)

Bagian ini menambahkan requirement konkret untuk pembacaan momentum “masih manggung atau sudah selesai”.

### FR-7 — Dual OB2 Indicator (Bid Stacking & Ask Thinner)
- Sistem wajib menghitung 2 indikator mikrostruktur per simbol top-N:
	1. `bid_stacking_score` (0–100)
	2. `ask_thinner_score` (0–100)
- Sumber data: OB2 level 10 dari stream yang sama.
- Minimum update cadence indikator: setiap 5 detik (intra-minute), lalu disimpan summary per menit.
- UI wajib menampilkan dua bar berdampingan:
	- Bar kiri: Bid Stacking
	- Bar kanan: Ask Thinner
- Rule warna:
	- Hijau: skor >= 65
	- Kuning: 45–64
	- Merah: < 45
- Kondisi ideal continuation: `GREEN_GREEN` bertahan minimal 3 update berturut.

#### Definisi Operasional FR-7
- `bid_stacking_score` dipengaruhi oleh:
	- kenaikan total bid qty L1–L5,
	- refill bid setelah terserap,
	- stabilitas best bid.
- `ask_thinner_score` dipengaruhi oleh:
	- penurunan total ask qty L1–L5,
	- frekuensi ask terkikis/naik level,
	- absennya wall ask berulang.

### FR-8 — Rank Trail Sparkline (Mini Trend di Kolom)
- Sistem wajib menyimpan histori rank per menit (`rank_trail`) minimal 60 titik terakhir per simbol.
- Jika simbol tidak muncul di roster minute tertentu, simpan `null` pada titik tersebut.
- UI tabel roster wajib menampilkan sparkline kecil pada kolom rank-trail.
- UI wajib menampilkan perubahan rank:
	- `rank_now`
	- `rank_delta_5m`
	- `rank_delta_15m`
- Sumbu rank harus terbalik (rank 1 di atas) agar perbaikan rank terlihat naik.

### FR-9 — Stage Scoring dengan Risk Memory (FCA/Suspend)
- Sistem wajib menambahkan faktor governance/risk memory ke scoring:
	- `ever_fca`
	- `fca_last_date`
	- `suspend_count_1y`
	- `last_suspend_date`
	- `uma_count_90d` (jika tersedia)
- Skor akhir (`stage_score`) wajib memasukkan penalti FCA/suspend untuk mengurangi false continuation pada saham high-risk.
- Label tahap wajib tersedia:
	- `On Stage (Continuation)`
	- `Watch`
	- `Cooling/Exhaustion`
- UI wajib menampilkan reason ringkas, termasuk saat penalti governance diterapkan.

### FR-10 — Explainability yang Dapat Diaudit
- Untuk setiap simbol top-N, sistem wajib mengeluarkan minimal 3 reason code prioritas yang menjelaskan status.
- Reason code harus mencakup kombinasi:
	- aktivitas/rank,
	- mikrostruktur OB2,
	- risk memory.
- Semua reason code disimpan pada object output minute agar dapat direplay/backtest.

---

## 26) Requirement Non-Fungsional Tambahan
- Perhitungan indikator FR-7 pada top-N tidak boleh menambah latensi render > 300 ms dari baseline.
- Sparkline FR-8 harus tetap ringan: payload trail terkompresi dan dibatasi window aktif.
- Scoring FR-9 harus deterministik untuk input minute yang sama (idempotent).
- Jika data FCA/suspend belum tersedia, sistem wajib fallback aman dengan flag `risk_memory_missing=true`.

---

## 27) Acceptance Criteria Tambahan (Z-Features)
1. Setiap simbol top-N memiliki `bid_stacking_score` dan `ask_thinner_score` valid (0–100).
2. UI menampilkan dual-bar indikator dan state warna konsisten dengan threshold.
3. Setiap simbol top-N memiliki `rank_trail` minimal 30 titik (saat sesi baru) dan meningkat hingga 60 titik.
4. `stage_score` menurun saat penalti FCA/suspend aktif dibanding baseline tanpa penalti.
5. Output minute menyertakan `reason_codes` yang dapat ditelusuri pada replay data.

---

## 28) Kontrak Data Tambahan (Z-Features)
```json
{
	"code": "BUVA",
	"rank_now": 3,
	"rank_delta_5m": -9,
	"rank_delta_15m": -14,
	"rank_trail": [15, 11, 9, 8, 7, 5, 3],
	"ob2_indicator": {
		"bid_stacking_score": 78,
		"ask_thinner_score": 72,
		"state": "GREEN_GREEN"
	},
	"risk_memory": {
		"ever_fca": true,
		"fca_last_date": "2025-11-18",
		"suspend_count_1y": 1
	},
	"stage_score": 74,
	"stage_label": "On Stage (Continuation)",
	"reason_codes": [
		"rank_improving_15m",
		"bid_stack_persistent",
		"ask_thinning_consistent",
		"fca_penalty_applied"
	]
}
```

---

## 29) Formula Matematis Final (v1) — Siap Implementasi

Bagian ini adalah formula **konkret** agar agent engineering bisa langsung implementasi tanpa ambigu.

### 29.1 Normalisasi Umum
Semua komponen skor dinormalisasi ke rentang 0–100.

Gunakan helper:

$$
	ext{clip}(x, a, b)=\min(\max(x,a),b)
$$

$$
	ext{norm}(x, lo, hi)=100\cdot\frac{\text{clip}(x,lo,hi)-lo}{hi-lo}
$$

### 29.2 Activity Score
Komponen:
- `rank_score = norm((max_rank + 1 - rank_now), 1, max_rank)`
- `value_accel = norm((value_1m / max(value_5m_avg,1)), 0.7, 2.5)`
- `volume_accel = norm((vol_1m / max(vol_5m_avg,1)), 0.7, 2.5)`

Formula:

$$
activity\_score = 0.45\cdot rank\_score + 0.30\cdot value\_accel + 0.25\cdot volume\_accel
$$

### 29.3 Bid Stacking Score (BSS)
Input rolling 30 detik:
- `bid_qty_l1_l5_delta_pct`
- `bid_refill_rate`
- `best_bid_stability`

Subscore:
- `b1 = norm(bid_qty_l1_l5_delta_pct, -10, 40)`
- `b2 = norm(bid_refill_rate, 0.0, 1.2)`
- `b3 = norm(best_bid_stability, 0.2, 1.0)`

$$
BSS = 0.45\cdot b1 + 0.35\cdot b2 + 0.20\cdot b3
$$

### 29.4 Ask Thinner Score (ATS)
Input rolling 30 detik:
- `ask_qty_l1_l5_drop_pct`
- `ask_eaten_rate`
- `ask_wall_reappear_penalty` (0..100, makin besar makin buruk)

Subscore:
- `a1 = norm(ask_qty_l1_l5_drop_pct, -10, 40)`
- `a2 = norm(ask_eaten_rate, 0.0, 1.2)`
- `a3 = 100 - ask_wall_reappear_penalty`

$$
ATS = 0.45\cdot a1 + 0.35\cdot a2 + 0.20\cdot a3
$$

### 29.5 Microstructure Score

$$
micro\_score = 0.50\cdot BSS + 0.40\cdot ATS + 0.10\cdot spread\_health
$$

Dengan:
- `spread_health = 100 - norm(spread_bps_avg, 10, 80)`

### 29.6 Persistence Score

$$
persistence\_score = norm(consecutive\_minutes\_in\_topN, 0, 10)
$$

### 29.7 Trend Quality Score
Komponen:
- `rank_slope_score = norm(-rank_slope_10m, -1.0, 1.0)`  (slope negatif = membaik)
- `volatility_penalty` (0..100)

$$
trend\_quality = 0.70\cdot rank\_slope\_score + 0.30\cdot (100-volatility\_penalty)
$$

### 29.8 Governance Penalty

Gunakan penalty additive:
- `+12` jika `ever_fca=true`
- `+10` jika `days_since_fca <= 90`
- `+18 * suspend_count_1y` (maks 36)
- `+8` jika `uma_count_90d >= 1`

Lalu clip:

$$
governance\_penalty = clip(p, 0, 45)
$$

### 29.9 Final Stage Score

$$
base = 0.35\cdot activity\_score + 0.30\cdot micro\_score + 0.20\cdot persistence\_score + 0.15\cdot trend\_quality
$$

$$
stage\_score = clip(base - governance\_penalty, 0, 100)
$$

Label:
- `On Stage (Continuation)` jika `stage_score >= 70` dan `BSS>=65` dan `ATS>=65`
- `Watch` jika `50 <= stage_score < 70`
- `Cooling/Exhaustion` jika `stage_score < 50`

---

## 30) Threshold Operasional per Sesi (Initial)

Untuk mengurangi false signal antar fase market:

### Pre-open / Open (09:00–09:30)
- `On Stage` threshold naik: `stage_score >= 75`
- Wajib persistence minimal 2 menit.

### Regular Session (09:30–15:00)
- Threshold standar:
	- On Stage: `>=70`
	- Watch: `50–69`

### Late Session (15:00–close)
- `On Stage` threshold dinaikkan lagi: `>=73`
- Penalty spread diperberat (x1.15).

---

## 31) Pseudocode Eksekusi Pipeline (Menit + Intra-Menit)

```text
every 60s:
	roster = MostActiveClient.queryTopStock(COMPOSITE)
	saveRawRosterToR2(roster)
	normRoster = normalizeRoster(roster)
	saveNormRosterToR2(normRoster)

	hotCandidates = selectTopN(normRoster, N=10)
	OrderbookClient.reconcileSubscriptions(hotCandidates, grace=3m)

every 5s (for subscribed symbols):
	ob2Events = OrderbookClient.readBuffer(symbol)
	updateRollingMetrics(symbol, ob2Events)
	bss, ats = computeBSSATS(symbol)
	cacheInMemory(symbol, bss, ats)

at minute close:
	for symbol in hotCandidates:
		ob2Summary = buildOB2MinuteSummary(symbol)
		saveOB2SummaryToR2(ob2Summary)

		stageScore = computeStageScore(symbol, normRoster, ob2Summary, riskMemory)
		reasons = buildReasonCodes(symbol)
		publishSymbolSnapshot(symbol, stageScore, reasons)

	manifest = buildMinuteManifest()
	saveManifestToR2(manifest)
```

---

## 32) Reason Code Matrix (Deterministik)

Gunakan reason code berikut agar explainability konsisten lintas service:

### Positif
- `rank_improving_5m`
- `rank_improving_15m`
- `bid_stack_persistent`
- `ask_thinning_consistent`
- `tight_spread`
- `high_persistence_topN`

### Netral/Watch
- `mixed_microstructure`
- `rank_flat`
- `spread_normal`

### Negatif
- `ask_wall_reappearing`
- `bid_pullback_fast`
- `spread_widening`
- `rank_deteriorating_5m`
- `fca_penalty_applied`
- `suspend_penalty_applied`

Rule output:
- minimal 3 code,
- maksimal 6 code,
- urut berdasarkan absolute contribution score terbesar.

---

## 33) Backtest & Validasi (Wajib sebelum go-live penuh)

### Dataset
- Minimum 20 hari bursa data minute.
- Label manual 100+ kejadian “continuation valid” dan “fake breakout”.

### KPI Validasi
- Precision sinyal `On Stage` >= 0.62 (initial target)
- False-positive rate turun >= 20% vs baseline tanpa BSS/ATS
- Coverage sinyal (symbol-day) tidak turun > 30% dari baseline

### Safety Gate
- Jika KPI tidak tercapai, otomatis fallback ke mode `Watch-only` (tanpa rekomendasi continuation tegas).

---

## 34) Task Breakdown Implementasi (Siap Dikerjakan Agent)

1. Buat modul `score_math` untuk semua formula section 29.
2. Tambah `ob2_feature_extractor` untuk metrik rolling 5s/30s.
3. Tambah `rank_trail_store` (ring buffer 60 titik/simbol).
4. Integrasi `risk_memory_provider` (FCA/UMA/suspend).
5. Tambah `reason_engine` berbasis matrix section 32.
6. Tulis object output sesuai schema section 28 + manifest section 18.5.
7. Tambah test:
	 - unit test formula,
	 - integration test minute flush,
	 - replay test dari raw OB2 chunk.

---

## 35) Rancangan UX (Tahap 1 — Foundation)

Fokus tahap ini adalah membuat keputusan cepat untuk trader: **lanjut**, **wait**, atau **hindari** dalam < 5 detik baca layar.

### UX Objective
- 1 layar untuk membaca: momentum, mikrostruktur, narasi.
- Mengurangi scroll dan context switching.
- Menjaga konsistensi visual antara `Feed/Catalyst` dan `Brokerflow`.

### UX Success Criteria
1. User bisa identifikasi top 3 kandidat dalam <= 10 detik.
2. User bisa pahami status simbol (`On Stage`, `Watch`, `Cooling`) tanpa membuka detail.
3. User bisa melihat perubahan rank historis singkat langsung di tabel.

---

## 36) Information Architecture (IA)

### 36.1 Struktur Halaman Utama
1. **Header ringkas**: market state + last update + connection status.
2. **Primary Chart Zone (atas)**: chart harga + overlay status simbol aktif.
3. **Signal Strip (tepat bawah chart)**: dual OB2 bar + stage badge + risk badge.
4. **Tab Zone (bawah)**:
	 - Tab A: `Feed/Catalyst`
	 - Tab B: `Brokerflow`
5. **Roster Table (sticky bawah/side panel desktop)**: top-N dengan sparkline rank.

### 36.2 Prioritas Visual
- Level 1: Stage badge + dual OB2 bar.
- Level 2: rank trail + delta rank.
- Level 3: reason chips + FCA/suspend flag.

---

## 37) Wireframe Teks (Desktop-first)

```text
┌─────────────────────────────────────────────────────────────────────┐
│ Header: COMPOSITE | Last Update 09:31:02 | WS: LIVE               │
├─────────────────────────────────────────────────────────────────────┤
│ [Chart Area - 65% width]                                           │
│  Price/Intraday + marker On Stage / Watch / Cooling               │
├─────────────────────────────────────────────────────────────────────┤
│ Signal Strip: [BSS Bar] [ATS Bar] [Stage Badge] [Risk: FCA/SUSP] │
├───────────────────────────────┬─────────────────────────────────────┤
│ Tabs Panel (70%)              │ Roster Panel (30%)                 │
│ [Feed/Catalyst] [Brokerflow]  │ Rank | Symbol | Sparkline | Stage  │
│ tab content...                │ Δ5m | Δ15m | BSS/ATS mini           │
└───────────────────────────────┴─────────────────────────────────────┘
```

### Mobile adaptation
- Chart tetap di atas.
- Signal strip jadi 2 baris.
- Roster panel menjadi bottom sheet collapse/expand.

---

## 38) UX Components (Definitif)

### 38.1 `StageBadge`
- Value: `On Stage`, `Watch`, `Cooling`.
- Warna:
	- Hijau = On Stage
	- Amber = Watch
	- Merah = Cooling
- Tooltip wajib: reason top-3.

### 38.2 `DualMicroBar`
- Menampilkan `BSS` dan `ATS` berdampingan.
- Format label: `BSS 78` dan `ATS 72`.
- State visual:
	- `GREEN_GREEN`
	- `GREEN_YELLOW`
	- `YELLOW_RED`
	- `RED_RED`

### 38.3 `RankSparkline`
- 60 titik max, 1 titik = 1 menit.
- Null point (simbol tidak masuk roster) ditampilkan garis putus.
- Hover menampilkan rank exact per titik.

### 38.4 `RiskBadge`
- Menampilkan tag `FCA`, `SUSP-1Y`, `UMA`.
- Tidak menutupi stage, hanya memberi konteks penalti.

### 38.5 `ReasonChips`
- Tampilkan max 3 chip pada row.
- Contoh: `rank_improving_15m`, `ask_thinning_consistent`, `fca_penalty_applied`.

---

## 39) Interaction Design (Per Event)

### 39.1 On Minute Tick (60s)
- Refresh roster + rank trail.
- Animasi halus (`fade/slide <= 200ms`) pada perubahan rank.
- Jika symbol naik > 5 rank, tampilkan pulse singkat 1x.

### 39.2 On Intra-Minute Tick (5s)
- Update `DualMicroBar` tanpa rerender penuh tabel.
- Jika dari non-ideal menjadi `GREEN_GREEN`, tampilkan indikator naik kecil.

### 39.3 On Symbol Select
- Klik row roster mengikat context ke chart + tab.
- Panel tab tetap mempertahankan tab aktif terakhir user.

### 39.4 On Degraded Data
- Jika WS drop: badge `DEGRADED` + fallback timestamp terakhir sukses.
- Jangan kosongkan UI; pertahankan data terakhir dengan watermark `stale`.

---

## 40) UX Copy & Labeling

Gunakan label pendek dan konsisten:
- `Masih Manggung` = On Stage
- `Perlu Konfirmasi` = Watch
- `Mulai Dingin` = Cooling

Microcopy contoh:
- `BSS kuat, ATS kuat, rank naik 15m`.
- `Rank naik tapi ask menebal kembali`.
- `Skor turun, spread melebar, risiko tinggi`.

---

## 41) UX Acceptance Criteria (Implementable)

1. Chart selalu tampil di atas tab zone pada desktop dan mobile.
2. Row roster wajib menampilkan: `rank_now`, `Δ5m`, `Δ15m`, `RankSparkline`, `StageBadge`, mini `DualMicroBar`.
3. Saat update 5 detik, hanya komponen mikrostruktur yang berubah (tanpa flicker tabel).
4. Saat update 60 detik, perubahan rank terlihat dengan transisi <= 200ms.
5. Saat data stale > 90 detik, badge status otomatis berubah ke `DEGRADED`.
6. Pada mode gelap/terang, kontras elemen status tetap lolos readability internal.

---

## 42) Deliverables UX (untuk Sprint Berikutnya)

1. High-fidelity mockup desktop + mobile (1 halaman utama).
2. Component spec untuk `StageBadge`, `DualMicroBar`, `RankSparkline`, `RiskBadge`, `ReasonChips`.
3. State matrix (LIVE, DEGRADED, STALE, EMPTY).
4. Mapping field API -> komponen UI.
5. Checklist QA visual dan interaction.