# Audit Report — D1 Read Billing Amplification

> **Document ID**: 0004_d1_read_billing_audit  
> **Version**: 1.2  
> **Date**: 2026-04-01  
> **Status**: Audit Complete + Progress Update + Integrity Deep Audit

---

## 1) Ringkasan Eksekutif

Audit source code menunjukkan bahwa ledakan billing read yang Anda sebut sebagai "D2" hampir pasti sebenarnya berasal dari **Cloudflare D1**.

Alasannya:

1. Di repo ini worker yang relevan hanya terikat ke `d1_databases` (`SSSAHAM_DB`) dan `r2_buckets`, tidak ada binding database "D2" yang aktif di config worker utama.
2. Pain point terbesar bukan cron background semata, tetapi kombinasi:
   - frontend polling yang agresif,
   - endpoint publik yang mahal,
   - path request yang tetap menyentuh D1 walau cache R2 sudah ada,
   - dan potensi query scan besar bila index D1 tidak sesuai pola akses.

Kesimpulan paling penting:

1. **Hotspot nomor satu** ada di alur screener `broker-summary.js` -> `/cache-summary` -> `getOrderflowSnapshot()`.
2. **Hotspot nomor dua** adalah mismatch antara query pattern dengan index D1, terutama pada `temp_footprint_consolidate` dan kemungkinan `daily_features`.
3. **Hotspot nomor tiga** adalah endpoint internal/expensive yang masih terbuka publik, terutama di `features-service`.

Jika target Anda adalah menurunkan read secepat mungkin, dampak terbesar hampir pasti datang dari:

1. mematikan/hardening public expensive endpoints,
2. menghentikan per-symbol hydration tiap menit di screener,
3. memisahkan `orderflow` dari `/cache-summary`,
4. dan memastikan index D1 sesuai query hot path.

---

## 1.1) Update Progress Implementasi (2026-04-01)

Update ini adalah re-audit static code setelah implementasi gelombang awal optimasi billing.

### 1.1.1 Status aktual per area

| Area | Status | Bukti Implementasi Terkini | Dampak ke Billing |
|---|---|---|---|
| Screener initial load tidak bawa orderflow | Done | `broker-summary.js` memanggil `/screener-accum?include_orderflow=false` di sekitar `:391` dan `:3504` | Mengurangi beban orderflow saat first load |
| Hydration list tidak lagi per-symbol request | Done | `hydrateOrderflowForVisibleRows()` -> `fetchOrderflowSnapshotsForSymbols()` di sekitar `:3358` dan `:2512` | Fan-out request turun drastis |
| Bulk endpoint orderflow tersedia | Done | `GET /orderflow/snapshots` aktif di `workers/api-saham/src/index.js` sekitar `:4500-4532` | Mengubah N request symbol menjadi 1 request bulk |
| `/prev-close` didahulukan ke R2 monthly | Done | `api-saham` route `/prev-close` baca `yfinance/{CODE}/1d/{YYYY-MM}.json` dulu, lalu fallback D1 (`:3038+`) | Menekan query fallback D1 pada dashboard |
| `/cache-summary` default attach orderflow | Done | Default diubah ke opt-in: attach hanya jika `include_orderflow=true|1|yes` (`api-saham/src/index.js:4972-4973`) | Memutus D1 orderflow attach dari call general |
| Detail page retry loop masih agresif | Partial | `MAX_RETRIES = 60`, interval retry 5 detik di `broker-summary.js` sekitar `:3952+` | Potensi spike read saat backfill |
| Endpoint expensive `features-service` | Done | Route mahal diproteksi token (`PROTECTED_HTTP_PATHS` + `isProtectedRequestAuthorized`) di `features-service/src/index.js:40-70` dan `:2007-2017` | Menahan fan-out dari hit publik/manual |
| Polling + cache busting index | Done | `_ts` dihapus dari fetch `/sector/cvd`, `/footprint/summary`, `/prev-close` (`idx/index.html:838`, `:856`, `:903`) | Meningkatkan cache hit ratio |
| Cache reference table `brokers` | Done | Memoization in-memory TTL 12 jam (`BROKERS_CACHE_TTL_MS`, `getBrokersMapCached`) dipakai lintas endpoint (`api-saham/src/index.js:165-227`, `:1908`, `:4948`, `:5195`) | Mengurangi read D1 berulang yang non-esensial |
| Verifikasi index `daily_features`/`yfinance_1d` | Not Started | Migration SQL final tidak ditemukan di repo untuk dua tabel ini | Risiko row scan belum tertutup |

### 1.1.2 Interpretasi progres

1. Perbaikan paling berdampak untuk screener sudah masuk: jalur hydration sekarang bulk dan first load sudah menonaktifkan orderflow.
2. Risiko terbesar yang tersisa ada di sisi backend policy: default `/cache-summary`, endpoint mahal tanpa guard, dan pola polling cache-busting.
3. Integritas data saat ini tetap aman karena source of truth tidak diubah; yang berubah baru pola pengambilan data.

### 1.1.3 Rekomendasi berikutnya (High Impact, Low Effort, Data-Safe)

1. Ubah default `/cache-summary` menjadi `include_orderflow=false` dan aktifkan hanya untuk path detail.
2. Tambahkan guard sederhana untuk endpoint mahal `features-service` (Bearer token/secret header + Cloudflare WAF rate limit).
3. Naikkan `ORDERFLOW_CACHE_TTL_MS` dari `45s` ke `180-300s` untuk list mode, detail mode tetap live.
4. Hapus `_ts=${Date.now()}` pada endpoint yang sudah punya freshness metadata, lalu ubah cache header summary ke `public, max-age=15, stale-while-revalidate=45`.
5. Memoize tabel `brokers` di memory worker (TTL 6-24 jam) agar tidak `SELECT *` berulang.

### 1.1.4 Guardrail integritas data untuk 5 langkah di atas

1. Jangan ubah formula/orderflow derivation; ubah hanya cache policy dan request routing.
2. Pertahankan jalur detail page sebagai jalur presisi/live sampai parity test lulus.
3. Pastikan response list tetap membawa metadata `generated_at`, `window_date`, `is_fallback_day`.
4. Jika snapshot gagal, tampilkan data terakhir + stale indicator, bukan mengganti dengan nilai nol.

## 1.2) Integrity Deep Audit (Post-Change Verification)

### 1.2.1 Planning Analisa (dijalankan dulu sebelum eksekusi)

Tujuan audit integrity ini adalah memastikan optimasi billing **tidak mengubah kebenaran data** (terutama features/z-score), dan hanya menurunkan biaya read.

Framework planning yang dipakai:

1. **Scope Freeze**
   - Fokus hanya pada perubahan wave optimasi billing:
     - default `include_orderflow` policy,
     - hardening endpoint expensive,
     - throttling/hydration policy di screener,
     - cacheability header dashboard,
     - memoization referensi `brokers`.
2. **Invariant Definition**
   - Invariant A: field features (`s`, `sc`, `z`, `accum`) tidak berubah karena toggle orderflow.
   - Invariant B: summary broker (`foreign/local/retail`) tidak berubah karena toggle orderflow.
   - Invariant C: source-of-truth write path (cron/features aggregation) tidak berubah.
3. **Verification Layers**
   - Static code-path audit (read/write path).
   - Sample parity test API (multi-symbol).
   - Browser/network behavior check (manual style via Playwright runtime tracing).
   - Existing E2E regression suite.
4. **Acceptance Criteria**
   - `mismatch_without_orderflow = 0` untuk `screener-accum`.
   - `summary_totals_same = true` untuk sample `cache-summary` true vs false.
   - Tidak ada perubahan formula features/aggregation path pada `scheduled()` flow.
   - E2E kritikal tetap hijau.

### 1.2.2 Eksekusi Verifikasi yang Dilakukan

Timestamp eksekusi: `2026-04-01 18:29:53 WIB`.

1. **Static path audit**
   - `api-saham`: policy & cache-layer perubahan terverifikasi di:
     - `brokers` memoization helper: `workers/api-saham/src/index.js:165-227`
     - usage memoization di kalkulasi: `:1908`, `:4948`, `:5195`
     - `/cache-summary` opt-in orderflow: `:4972-4973`
     - `/footprint/summary` cache policy: `:3594`
   - `features-service`:
     - HTTP path guard di `:40-70` dan `:2007-2017`
     - cron/scheduled pipeline tetap aktif dan tidak berubah model hitung di `:72-106`
   - Frontend:
     - remove `_ts` + cache-friendly fetch di `workers/app-sssaham/public/idx/index.html:838`, `:856`, `:903`
     - list mode explicit non-orderflow + detail explicit orderflow:
       - `workers/app-sssaham/public/idx/js/broker-summary.js:392`
       - `:3470` (`include_orderflow=false` untuk zscore calc-from-history)
       - `:3965`, `:5031` (`include_orderflow=true` untuk detail/AI range)
     - hydration throttling di `:156-158` dan `:3362-3374`

2. **Sample parity check — `cache-summary` (multi-symbol)**
   - Sample: `BBRI`, `TLKM`, `BMRI`, `ASII`, `TRON`
   - Range: `2026-03-25` s/d `2026-03-31`
   - Hasil:
     - history days sama untuk tiap simbol
     - `summary.foreign/local/retail` buy/sell **identik** untuk `include_orderflow=true` vs `false`
     - perbedaan payload hanya `orderflow` dan `bubble.orderflow` (sesuai desain)

3. **Sample parity check — `screener-accum`**
   - Compare `include_orderflow=true` vs `false`
   - Result:
     - `count_a = 773`, `count_b = 773`
     - `missingInA = 0`, `missingInB = 0`
     - `mismatch_without_orderflow = 0`
   - Probe ticker (`BBRI`, `BMRI`, `TLKM`, `ASII`, `TRON`):
     - `z_equal = true`
     - `accum_equal = true`
     - `state_equal = true`
     - `score_equal = true`

4. **Runtime manual-style browser checks (Playwright network tracing)**
   - Screener page:
     - initial request memakai `screener-accum?include_orderflow=false`
     - ada bulk `orderflow/snapshots`
     - tidak ada fan-out initial `/cache-summary` per symbol
   - Detail page:
     - **catatan environment**: pada deployment live saat pengujian, request masih terlihat tanpa `include_orderflow` explicit (indikasi deployment app belum memuat patch frontend terbaru).
     - Secara code lokal, detail sudah explicit `include_orderflow=true` di `broker-summary.js:3965`.

5. **Regression suite**
   - Playwright suite: `6 passed (1.2m)`
   - Skenario:
     - focus by stock param,
     - filter by stock name individual,
     - screener bulk orderflow behavior,
     - initial screener tanpa fan-out cache-summary.

### 1.2.3 Analisa Integritas Data (Deep Findings)

1. **Features data integrity: terjaga**
   - Tidak ada perubahan formula `z-score`, `accum`, `state`, `score`.
   - Perubahan hanya pada attach policy orderflow, cache behavior, dan throttling fetch.
   - Bukti parity `screener-accum` menunjukkan 0 mismatch tanpa field orderflow.

2. **Broker summary integrity: terjaga**
   - `summary.foreign/local/retail` tetap identik true-vs-false orderflow.
   - Artinya optimasi tidak menggeser agregasi utama broker summary.

3. **Cron/features pipeline integrity: terjaga**
   - Guard token hanya berlaku jalur HTTP manual trigger, bukan `scheduled()` path.
   - Pipeline harian/periodik tetap berjalan dari cron; tidak ada perubahan rumus aggregator.

4. **Consistency risk yang masih tersisa (bukan data corruption)**
   - `brokers` memoization TTL 12 jam dapat membuat klasifikasi retail/foreign tertunda jika tabel broker berubah intraday.
   - Ini risiko freshness referensi, bukan risiko integritas formula.

### 1.2.4 Residual Risk & Mitigasi Lanjutan

1. Tambahkan endpoint internal untuk invalidate `brokers` cache ketika ada update master broker.
2. Tambahkan telemetry mismatch sentinel:
   - compare `screener-accum` include true/false (sample 20 ticker per jam) di monitoring internal.
3. Verifikasi post-deploy bahwa app frontend terbaru sudah live:
   - detail request harus mengandung `include_orderflow=true`.

### 1.2.5 Verdict Integritas

Dengan evidence static + sample parity + runtime check + e2e suite:

1. **Tidak ditemukan indikasi bahwa optimasi billing mengubah nilai features utama**.
2. **Tidak ditemukan indikasi perubahan nilai agregasi broker summary utama**.
3. Risiko yang tersisa bersifat freshness/operasional, bukan kerusakan integritas data.

---

## 2) Scope Audit

Audit ini dilakukan secara **static code audit** terhadap jalur read di:

1. `workers/api-saham`
2. `workers/features-service`
3. `workers/yfinance-handler`
4. `workers/auth-uid`
5. `workers/app-sssaham/public/idx`

Catatan penting:

1. Audit ini **belum memakai production logs / Cloudflare Analytics**.
2. Ranking kontribusi billing disusun dari pola kode, polling frontend, sifat endpoint, dan potensi row-scan query.
3. Di Cloudflare D1, angka billed "read" bisa jauh lebih besar dari jumlah request, karena satu query bisa membaca banyak row jika query plan atau index kurang pas.

---

## 3) Validasi Istilah "D2"

Saya tidak menemukan binding database "D2" aktif pada worker utama yang mengurus flow ini.

Yang ditemukan:

1. `workers/api-saham/wrangler.jsonc` memakai `d1_databases -> SSSAHAM_DB`
2. `workers/features-service/wrangler.jsonc` memakai `d1_databases -> SSSAHAM_DB`
3. `workers/yfinance-handler/wrangler.jsonc` memakai `d1_databases -> SSSAHAM_DB`

Jadi report ini diposisikan sebagai **audit D1 read billing**.

---

## 4) Ranking Pain Point (Baseline 2026-03-30, sebelum gelombang optimasi)

| Rank | Severity | Pain Point | Jalur Utama | Kenapa Berbahaya |
|---|---|---|---|---|
| 1 | Critical | Per-symbol orderflow hydration tiap menit | `broker-summary.js` -> `/cache-summary` -> `getOrderflowSnapshot()` | 1 tab bisa memicu puluhan sampai ratusan request/minute |
| 2 | Critical | Query/index mismatch pada D1 hot path | `temp_footprint_consolidate`, `daily_features`, `yfinance_1d` | Satu query bisa berubah jadi scan besar dan billed read meledak |
| 3 | High | Endpoint expensive terbuka publik | `features-service` | Hit manual/bot bisa fan-out ke D1 + R2 besar |
| 4 | High | YFinance bulk prefill 6 hari per page load | `broker-summary.js` -> `/indicators?date=` | Setiap load screener menarik 6 bulk D1 query |
| 5 | High | Index page polling berantai ke `/prev-close` | `index.html` -> `/footprint/summary` -> `/prev-close` | Refresh periodik + cache busting + D1 fallback |
| 6 | Medium | Detail page retry loop | `broker-summary.js` -> `/cache-summary` berulang | Satu tab bisa retry puluhan kali |
| 7 | Medium | Repeated `SELECT * FROM brokers` | `api-saham` banyak endpoint | Reference table statis tetap dibaca dari D1 berulang |
| 8 | Medium | `/symbol` detail endpoint masih cukup mahal | `emiten/detail.html` -> `/symbol` | Kombinasi 24 R2 GET + beberapa query D1 |

---

## 5) Temuan Detail (Baseline pra-implementasi 2026-03-30)

### 5.1 Critical — Screener melakukan per-symbol hydration tiap 60 detik

Di frontend screener:

1. `workers/app-sssaham/public/idx/js/broker-summary.js:131-143` membuat timer `setInterval(..., 60 * 1000)`.
2. Timer tersebut mengambil `SCREENER_PAGE_SIZE = 100` pada `workers/app-sssaham/public/idx/js/broker-summary.js:154`.
3. TTL cache orderflow client hanya `45 detik` pada `workers/app-sssaham/public/idx/js/broker-summary.js:155`.
4. Untuk setiap symbol yang stale, frontend memanggil `fetchOrderflowSnapshotForSymbol(symbol)` pada `workers/app-sssaham/public/idx/js/broker-summary.js:3335-3346`.
5. Fungsi itu memanggil endpoint:
   `GET /cache-summary?symbol=...&from=today&to=today&cache=default&_ts=...`
   pada `workers/app-sssaham/public/idx/js/broker-summary.js:2513-2523`.

Masalah utamanya:

1. Ini dilakukan **per symbol**, bukan bulk.
2. `_ts=${Date.now()}` membuat request unik terus-menerus, sehingga cache reuse makin kecil.
3. Dengan page size 100 dan refresh tiap menit, satu tab aktif bisa menembak sampai sekitar **100 request `/cache-summary` per menit**.

### 5.2 Critical — `/cache-summary` tetap menyentuh D1 walau R2 cache sudah hit

Di backend:

1. Route `/cache-summary` ada di `workers/api-saham/src/index.js:4803-4865`.
2. Pada cache hit R2, kode tetap menempelkan orderflow live jika `include_orderflow` tidak diset `false`.
3. Itu terjadi di `workers/api-saham/src/index.js:4845-4861`.
4. Default `include_orderflow` adalah `true` pada `workers/api-saham/src/index.js:4808`.

Artinya:

1. Walau summary historis sudah ada di R2, request tetap lanjut ke `getOrderflowSnapshot(env, symbol)`.
2. Jadi cache R2 **tidak benar-benar memotong jalur D1** untuk use case screener.

### 5.3 Critical — `getOrderflowSnapshot()` berantai ke beberapa query D1

`getOrderflowSnapshot()` berada di `workers/api-saham/src/index.js:2505-2662`.

Minimal jalur query D1 yang terlihat:

1. `resolveOrderflowWindow()` dipanggil di `2509`.
2. `resolveOrderflowWindow()` sendiri menjalankan query `COUNT/MIN/MAX` per hari di `2136-2143`.
3. Jika fallback, ada query kedua di `2155-2165`.
4. Query agregasi utama ada di `2518-2529`.
5. Query open/close ada di `2535-2539`.
6. Query context ke `daily_features` ada di `2549-2555`.

Jadi per request `/cache-summary` untuk orderflow live, jalurnya minimal sekitar **4-5 query D1**, bahkan saat cache summary R2 sudah hit.

### 5.4 Critical — Ada kemungkinan query besar melakukan row scan mahal

Ini poin yang sangat mungkin menjadi akar ledakan billed read.

#### A. `temp_footprint_consolidate`

Schema yang bisa diverifikasi di repo ada di:
`workers/livetrade-taping-agregator/migrations/0001_initial_footprint.sql:4-21`

Index yang terlihat hanya:

1. `PRIMARY KEY (ticker, time_key)`
2. `idx_temp_footprint_date_ticker ON (date, ticker)`

Masalahnya, beberapa query hot path tidak ideal untuk index ini:

1. `resolveOrderflowWindow()` memakai:
   `WHERE date = ? AND time_key >= ? AND time_key <= ?`
   pada `workers/api-saham/src/index.js:2136-2143`
2. `getOrderflowSnapshotMap()` memakai:
   `WHERE date = ? AND time_key >= ? AND time_key <= ? ORDER BY ticker, time_key`
   pada `workers/api-saham/src/index.js:2678-2683`
3. `/prev-close` D1 fallback memakai:
   `WHERE time_key >= ? AND time_key <= ? GROUP BY ticker`
   pada `workers/api-saham/src/index.js:3076-3081`

Query-query ini berpotensi membutuhkan index seperti:

1. `(date, time_key)`
2. `(ticker, date, time_key)` atau minimal benchmark atas variasi sejenis
3. untuk beberapa case, index `time_key` juga layak dipertimbangkan

Tanpa index yang cocok, satu request bisa membaca row jauh lebih banyak dari yang kelihatan dari source code.

#### B. `daily_features`

Di repo ini saya **tidak menemukan migration/schema SQL final** untuk `daily_features`.
Dokumen lama `workers/_DOC/0001_orderflow.md:415-427` menyebut `PRIMARY KEY (date, ticker)`, tetapi itu bukan sumber schema runtime yang bisa diverifikasi penuh.

Yang berbahaya:

1. Query `WHERE ticker = ? AND date < ? ORDER BY date DESC LIMIT 1`
   dipakai di `workers/api-saham/src/index.js:2549-2555`
2. Query `WHERE ticker = ? ORDER BY date DESC LIMIT 1`
   dipakai di `workers/api-saham/src/index.js:4152-4157`
3. Jika `daily_features` hanya punya PK `(date, ticker)` tanpa index `(ticker, date DESC)`,
   maka query ticker-first seperti ini berpotensi mahal.

#### C. `yfinance_1d`

Saya juga **tidak menemukan migration/schema SQL final** untuk `yfinance_1d` di repo.

Padahal query hot path membutuhkan setidaknya verifikasi index:

1. `WHERE date = ?` pada `workers/yfinance-handler/src/index.js:528-534`
2. `WHERE ticker = ? ORDER BY date DESC LIMIT ?` pada `workers/yfinance-handler/src/index.js:520-523`
3. `WHERE ticker = ? AND date LIKE ? ORDER BY date ASC` pada `workers/yfinance-handler/src/index.js:550-552`

Jika index `(date)` dan `(ticker, date DESC)` belum ada, biaya baca bisa naik tajam.

### 5.5 High — `features-service` punya endpoint mahal yang masih terbuka

Di `workers/features-service/src/index.js` saya menemukan route mahal tanpa guard auth yang jelas:

1. `/aggregate` pada `1976-1979`
2. `/aggregate-footprint` pada `1982-2000`
3. `/trigger-all` pada `2046-2050`
4. `/foreign-flow-scanner` pada `2054-2058`
5. route diagnostic dan rebuild di area `2003-2249`

Yang paling riskan adalah `/aggregate-footprint`, karena ia memicu jalur:

1. D1 aggregation `temp_footprint_consolidate` pada `1175-1216`
2. R2 supplement/replacement pada `1252-1261`
3. fallback ke R2 master tickers via `emiten` di `1378-1401`
4. context fetch ke `daily_features` di `1585-1598`

Kalau endpoint ini bisa di-hit publik atau bot, read bisa melonjak cepat meski cron normal sebenarnya masih terkendali.

### 5.6 High — Bulk yfinance 6 hari dipanggil setiap load screener

Di `workers/app-sssaham/public/idx/js/broker-summary.js:513-524`, setiap load screener:

1. memanggil `prefillIntradayFromFootprintSummary(allCandidates)`
2. memanggil `prefillFromYfinanceD1(allCandidates)`
3. memanggil `prefillSectorDigest(allCandidates)`

`prefillFromYfinanceD1()` di `2739-2765`:

1. menyusun 6 trading day terakhir,
2. lalu memanggil `/indicators?date=...` untuk **semua 6 tanggal secara paralel**.

Di backend, `/indicators?date=...` pada `workers/yfinance-handler/src/index.js:526-535`
menjalankan **bulk D1 query semua ticker untuk satu tanggal**.

Secara desain ini lebih baik daripada per-symbol query, tetapi tetap mahal bila:

1. dipanggil dari banyak tab,
2. tanpa edge cache efektif,
3. dan dipicu lagi pada setiap page load.

### 5.7 High — Landing/index page melakukan polling berantai

Di `workers/app-sssaham/public/idx/index.html`:

1. `_fetchFootprintSummary()` dipanggil tiap 2 menit pada `1428-1430`
2. `_fetchSectorCvd()` dipanggil tiap 3 menit pada `1432-1434`
3. fetch menggunakan `_ts=${Date.now()}` di `856`
4. setelah footprint summary berhasil, frontend **selalu** memanggil `_fetchPrevClose(allCodes)` pada `876-885`
5. `_fetchPrevClose()` memanggil `/prev-close?symbols=...&_ts=...` di `898-903`

Di backend:

1. `/footprint/summary` mengirim header `Cache-Control: no-cache, no-store, must-revalidate`
   pada `workers/api-saham/src/index.js:3463-3468`
2. `/prev-close` punya fallback D1 loop per tanggal pada `3054-3085`

Jadi:

1. frontend sengaja cache-busting,
2. backend juga memaksa no-cache untuk summary,
3. dan bila data R2 tidak lengkap, `/prev-close` masuk ke D1 fallback.

### 5.8 Medium — Detail page bisa polling `/cache-summary` berulang saat backfill

Di `workers/app-sssaham/public/idx/js/broker-summary.js:3921-4056`:

1. `MAX_RETRIES = 60`
2. retry dilakukan setiap `5 detik`
3. request yang diulang adalah `/cache-summary?...`

Artinya satu tab detail bisa membuat sampai **60 retry** untuk satu symbol bila backend menandai `backfill_active=true`.

### 5.9 Medium — `SELECT * FROM brokers` dipakai berulang di banyak endpoint

Saya menemukan pembacaan penuh tabel `brokers` di:

1. `workers/api-saham/src/index.js:1842`
2. `workers/api-saham/src/index.js:4260`
3. `workers/api-saham/src/index.js:4784`
4. `workers/api-saham/src/index.js:5030`

Tabel ini kecil dan statis, jadi membaca D1 berulang untuk data referensi seperti ini adalah pemborosan yang mudah dipangkas.

### 5.10 Medium — `/symbol` detail endpoint masih cukup berat

Route `/symbol` di `workers/api-saham/src/index.js:3795-4160`:

1. membaca 24 file R2 intraday per load (`3823-3835`)
2. lalu tetap melakukan beberapa D1 query:
   - latest date `3801-3803`
   - latest candle `4128-4130`
   - day stats `4132-4136`
   - latest state `4152-4157`

Endpoint ini mungkin bukan kontributor terbesar dibanding screener, tetapi tetap cukup mahal untuk page-view detail.

### 5.11 Low-Medium — Ada baseline read dari cron, tetapi ini bukan tersangka utama

Saya tetap cek sumber read background agar audit tidak bias ke frontend saja.

Yang terlihat:

1. `features-service` punya cron:
   - `0 10 * * 1-5`
   - `15 10 * * 1-5`
   - `*/5 * * * *`
   pada `workers/features-service/wrangler.jsonc:57-63`
2. Jalur `*/5 * * * *` memanggil `aggregateFootprint(env, date)` pada `workers/features-service/src/index.js:85-89`
3. `yfinance-handler` punya cron harian `30 9 * * 1-5`
   pada `workers/yfinance-handler/wrangler.jsonc:45-48`
4. `auth-uid` memang memakai D1, tetapi mayoritas query yang terlihat adalah point lookup user/session dan tidak menunjukkan pola read amplification sebesar jalur screener

Interpretasinya:

1. Cron memang menambah baseline read yang konsisten.
2. Tetapi dari pola kode, ledakan ke level miliaran read/bulan jauh lebih mungkin didorong oleh **request publik berulang** dibanding cron terjadwal saja.
3. Jadi optimasi cron tetap berguna, tetapi **bukan prioritas pertama**.

---

## 6) Skenario Amplifikasi Read

### 6.1 Satu tab screener aktif

Asumsi yang bisa dibaca langsung dari kode:

1. 100 symbol visible per page
2. refresh tiap 60 detik
3. TTL orderflow client 45 detik
4. tiap symbol memanggil `/cache-summary`
5. tiap `/cache-summary` memicu sekitar 4-5 query D1 untuk orderflow live

Estimasi kasar:

1. `100 request / menit`
2. `x ~5 query-path D1`
3. `= ~500 D1 query-path / menit / tab`
4. `= ~30.000 / jam / tab`
5. `= ~240.000 / 8 jam trading / tab`
6. `= ~4,8 juta / bulan / tab` untuk 20 hari bursa

Ini **belum** memasukkan efek row scan. Jika query plan buruk, billed read aktual bisa jauh lebih besar dari angka query-path ini.

### 6.2 Kenapa angka 7 miliar read/bulan masuk akal

Dengan only order-of-magnitude reasoning:

1. 100-300 tab aktif/monitor/scraper saja sudah bisa menghasilkan ratusan juta query-path per bulan
2. bila sebagian query melakukan scan ribuan row,
3. total billed read level miliaran menjadi sangat masuk akal

Jadi target 7 miliar read/bulan **sangat plausibel** berasal dari kombinasi frontend polling + hot query yang tidak terindeks optimal.

---

## 7) Prioritas Mitigasi (Baseline 2026-03-30)

Catatan: status terbaru dan prioritas rebaseline ada di bagian `1.1.3`.

### 7.1 P0 — lakukan dalam 24-48 jam

1. **Lock down endpoint mahal** di `features-service`.
   Minimal: `/aggregate`, `/aggregate-footprint`, `/trigger-all`, `/foreign-flow-scanner`, route diag/rebuild.
   Tambahkan auth token + rate limit/WAF, bukan sekadar obscurity.
2. **Ubah default `/cache-summary` menjadi tidak attach orderflow** untuk screener/list.
   Gunakan `include_orderflow=false` secara default untuk list view.
3. **Naikkan TTL orderflow client** dari `45 detik` ke minimal `3-10 menit`.
4. **Jangan hydrate 100 symbol tiap menit**.
   Batasi ke top 10-20 visible rows, atau hydrate saat hover/click/detail.
5. **Hentikan `_ts=${Date.now()}`** pada endpoint yang seharusnya bisa di-cache.
6. **Cache tabel `brokers`** di memory/KV/R2, bukan `SELECT * FROM brokers` berulang.

### 7.2 P1 — lakukan dalam 2-5 hari

1. Verifikasi dan tambahkan index D1 untuk hot path:
   - `temp_footprint_consolidate(date, time_key)`
   - `daily_features(ticker, date DESC)`
   - `yfinance_1d(date)`
   - `yfinance_1d(ticker, date DESC)`
2. Ubah screener ke **bulk orderflow endpoint**.
   Jangan 1 symbol = 1 request.
3. Pertimbangkan reuse pola `getOrderflowSnapshotMap()` di `workers/api-saham/src/index.js:2667-2851`
   untuk sekali baca banyak symbol.
4. Ubah `/prev-close` agar fallback lebih mengutamakan sumber yang lebih murah daripada scan footprint intraday.

### 7.3 P2 — lakukan dalam 1-2 minggu

1. Buat artefak intraday orderflow map per menit ke R2/KV.
2. Edge-cache hasil `/indicators?date=...` atau siapkan artefak bulk harian di R2.
3. Tambahkan request telemetry per endpoint:
   - endpoint name
   - symbol count
   - D1 query count
   - latency
   - fallback hit/miss
4. Pisahkan endpoint user-facing vs internal/admin secara tegas.

---

## 8) Checklist Verifikasi D1 yang Disarankan

Jalankan verifikasi ini langsung di D1 production/staging:

```sql
PRAGMA index_list('temp_footprint_consolidate');
PRAGMA index_list('daily_features');
PRAGMA index_list('yfinance_1d');
PRAGMA index_list('brokers');
```

Lalu cek query plan untuk hot query:

```sql
EXPLAIN QUERY PLAN
SELECT COUNT(*) as candles, MIN(time_key), MAX(time_key)
FROM temp_footprint_consolidate
WHERE date = ? AND time_key >= ? AND time_key <= ?;
```

```sql
EXPLAIN QUERY PLAN
SELECT state, z_ngr
FROM daily_features
WHERE ticker = ? AND date < ?
ORDER BY date DESC
LIMIT 1;
```

```sql
EXPLAIN QUERY PLAN
SELECT ticker, date, open, high, low, close, volume
FROM yfinance_1d
WHERE date = ?;
```

Targetnya sederhana:

1. pastikan tidak ada full scan pada query yang dipanggil sering,
2. pastikan query ticker-first punya index ticker-first,
3. dan pastikan query date-range pada footprint tidak scan seluruh tabel harian.

---

## 9) Kesimpulan

Root cause paling mungkin dari ledakan D1 read bukan satu worker cron tunggal, tetapi **read amplification lintas layer**:

1. frontend mem-poll sering,
2. endpoint publik mahal bisa di-hit berkali-kali,
3. cache R2 tidak memutus jalur D1 pada `/cache-summary`,
4. dan query D1 hot path berpotensi scan row besar bila index kurang pas.

Kalau saya harus memilih satu fokus paling berdampak, urutannya adalah:

1. **screener orderflow hydration**
2. **index/query-plan D1**
3. **public expensive endpoints**

Tiga area itu adalah kandidat paling kuat penyumbang mayoritas billing read.

---

## 10) Confidence Level untuk Solusi 5.1

### 10.1 Confidence keseluruhan

Confidence saya untuk **mengimplementasikan solusi 5.1 tanpa mengorbankan integritas data dan UX** adalah:

**8.5 / 10** untuk rollout bertahap yang menjaga detail page tetap live, dan mengubah hanya jalur list/screener lebih dulu.

Alasannya:

1. Source of truth tetap sama, yaitu D1 `temp_footprint_consolidate` + `daily_features`.
2. Perubahan yang diusulkan bukan mengubah formula inti, tetapi mengubah **cara pengambilan** dari per-symbol menjadi bulk/per-visible-window.
3. Di codebase sudah ada fondasi yang bisa direuse, terutama pola `getOrderflowSnapshotMap()` untuk agregasi banyak ticker sekaligus.
4. UX bisa dijaga dengan model hybrid:
   - list memakai snapshot bulk yang tetap fresh,
   - detail page tetap memakai live per-symbol path.

### 10.2 Confidence per fase

| Fase | Scope | Confidence | Catatan |
|---|---|---|---|
| A | Matikan per-symbol hydration untuk list, pertahankan detail page | 9/10 | Risiko rendah, impact tinggi |
| B | Tambah bulk endpoint orderflow untuk visible rows | 8.5/10 | Reuse logic existing, perlu parity test |
| C | Tambah freshness metadata + stale badge + hidden-tab pause | 9/10 | Hampir tidak berisiko ke integritas |
| D | Pindah ke precomputed snapshot KV/R2 bila perlu | 7/10 | Perlu validasi freshness dan invalidation lebih ketat |

### 10.3 Sumber ketidakpastian utama

Confidence tidak saya taruh 10/10 karena masih ada beberapa unknown di production:

1. Query plan D1 production belum kita verifikasi dengan `EXPLAIN QUERY PLAN`.
2. Kita belum punya baseline telemetry endpoint-per-endpoint dari traffic nyata.
3. Bisa ada coupling UI yang tidak langsung terlihat dari static audit, terutama pada state refresh screener dan fallback chart/detail.

---

## 11) Prinsip Solusi Agar Integritas dan UX Tetap Aman

Supaya perubahan ini aman, kita pegang 5 prinsip:

1. **Source of truth tidak berubah**. Snapshot baru harus tetap dihitung dari dataset yang sama dengan jalur lama.
2. **List dan detail dipisah**. List tidak perlu tick-by-tick; detail tetap bisa live.
3. **Bulk, bukan lossy**. Kita batching request, bukan membuang field atau mengubah formula.
4. **Freshness transparan**. Semua response baru harus membawa `generated_at`, `window_date`, dan `is_fallback_day` bila relevan.
5. **Fallback aman**. Jika bulk endpoint gagal, UI tetap bisa menampilkan data terakhir yang masih valid + stale indicator, bukan blank state.

---

## 12) Planning Implementasi Solusi 5.1

### 12.1 Target implementasi

Target implementasi adalah:

1. Menurunkan D1 read dari screener secara drastis.
2. Menjaga hasil orderflow di list tetap konsisten dengan jalur per-symbol lama.
3. Tidak mengubah pengalaman detail page yang membutuhkan presisi live.

### 12.2 Strategi rollout

Strategi yang direkomendasikan adalah **phased rollout**, bukan big bang.

#### Phase 0 — Baseline & Guardrail

Sebelum mengubah behavior:

1. Catat baseline jumlah request dari screener selama 5-10 menit:
   - jumlah request `/cache-summary`
   - jumlah symbol yang terhydrate
   - latency median
2. Tambahkan temporary logging/observability untuk membedakan:
   - `mode=list`
   - `mode=detail`
   - `include_orderflow=true/false`
3. Simpan baseline screenshot/video kecil untuk UX list dan detail agar parity visual bisa dibandingkan setelah perubahan.

#### Phase 1 — Safe Split antara list dan detail

Perubahan paling aman:

1. **List path**
   - ubah screener agar tidak lagi meminta orderflow via `/cache-summary` per symbol
   - gunakan `include_orderflow=false` untuk path list/screener
2. **Detail path**
   - pertahankan jalur lama `getOrderflowSnapshot()` untuk page detail
3. **Refresh policy**
   - stop refresh bila tab hidden
   - stop refresh di luar jam market bila data tidak perlu live
4. **Visible rows only**
   - hydrate hanya row yang benar-benar terlihat di viewport atau maksimal top N visible rows

Outcome fase ini:

1. data detail tetap identik,
2. list tidak lagi memicu 1 request per symbol,
3. risiko regressi paling rendah.

#### Phase 2 — Tambah bulk orderflow endpoint

Tambahkan endpoint baru, misalnya:

`GET /orderflow/snapshots?symbols=BBRI,TLKM,BBCA,...`

Spesifikasi yang disarankan:

1. input: daftar symbol terbatas, misalnya max 20-50 per request
2. output per symbol:
   - semua field yang dipakai UI list dari orderflow
   - `generated_at`
   - `window_date`
   - `is_fallback_day`
   - `source_version`
3. response harus deterministic untuk window yang sama

Implementasi backend:

1. reuse logika `getOrderflowSnapshotMap()`
2. tambahkan filter symbol agar tidak selalu menghitung seluruh universe bila belum perlu
3. hindari hit D1 berulang per symbol dalam satu request

Implementasi frontend:

1. satu refresh cycle = satu bulk request
2. hasil dipetakan ke visible rows
3. jika bulk gagal, gunakan snapshot lama dengan status stale

#### Phase 3 — UX hardening

Setelah bulk path stabil:

1. tampilkan label kecil seperti:
   - `Updated 24s ago`
   - `Using fallback day`
2. naikkan TTL orderflow list ke `3-5 menit`
3. tetap izinkan manual refresh atau refresh otomatis yang lebih jarang
4. gunakan debounce saat user ganti page/filter agar tidak spam endpoint

#### Phase 4 — Opsional: precomputed snapshot layer

Jika Phase 1-3 masih belum cukup menurunkan cost:

1. simpan snapshot orderflow list ke KV/R2/in-memory cache per interval 30-60 detik
2. list membaca snapshot siap pakai
3. detail tetap live ke D1

Ini fase dengan confidence paling rendah dibanding fase sebelumnya, jadi sebaiknya dilakukan hanya bila memang perlu.

---

## 13) Step Implementasi Teknis

### 13.1 Backend

1. Tambahkan pembeda mode konsumsi:
   - `mode=list`
   - `mode=detail`
2. Pastikan `/cache-summary` untuk list tidak lagi attach `orderflow` by default.
3. Buat endpoint bulk orderflow khusus screener.
4. Tambahkan metadata response:
   - `generated_at`
   - `window_date`
   - `is_fallback_day`
   - `source`
5. Tambahkan logging ringan:
   - symbol count
   - route
   - duration
   - fallback usage

### 13.2 Frontend Screener

1. Ganti hydration per-symbol menjadi bulk hydration per refresh cycle.
2. Batasi ke visible rows atau top N.
3. Pause refresh saat:
   - tab hidden
   - user idle di luar market hour
4. Tampilkan stale/fresh indicator yang ringan.
5. Pertahankan render awal dari data footprint/yfinance yang sudah ada agar first paint tetap cepat.

### 13.3 Frontend Detail

1. Jangan diubah pada fase awal.
2. Tetap gunakan jalur live existing.
3. Baru disentuh setelah list path terbukti stabil.

---

## 14) Integrity Test Plan

### 14.1 Tujuan integrity test

Integrity test harus menjawab 3 pertanyaan:

1. Apakah angka orderflow yang tampil tetap benar?
2. Apakah freshness data tetap cukup untuk UX?
3. Apakah request/read turun signifikan?

### 14.2 Data parity test

Ini test paling penting.

Untuk sample 20-50 ticker aktif:

1. panggil jalur lama per-symbol
2. panggil jalur baru bulk pada window yang sama
3. bandingkan field yang overlap

Field yang harus match:

1. `open`
2. `close`
3. `high`
4. `low`
5. `total_vol`
6. `total_delta`
7. `freq_tx`
8. `hist_state`
9. field derived yang dipakai UI list

Rule parity:

1. integer/count harus sama persis
2. numeric float tolerance maksimal `0.01` atau tolerance lain yang disepakati
3. jika fallback day aktif, status fallback harus sama pada jalur lama dan baru

Acceptance:

1. `>= 99%` sample ticker lolos parity penuh
2. semua mismatch harus bisa dijelaskan oleh rounding atau timing window yang berbeda

### 14.3 Freshness test

Verifikasi bahwa list tetap terasa live:

1. response baru selalu punya `generated_at`
2. age snapshot saat ditampilkan tidak melewati TTL yang disepakati
3. ketika refresh berjalan normal, timestamp harus bergerak maju
4. jika backend fallback/stale, UI harus menandai statusnya

Acceptance:

1. list snapshot age normal di bawah target, misalnya `< 60 detik` atau sesuai TTL
2. tidak ada kondisi user melihat data lama tanpa indikator

### 14.4 UI/UX regression test

Checklist manual yang perlu dijalankan:

1. screener initial load tetap cepat
2. angka orderflow tetap muncul tanpa flicker berlebihan
3. tidak ada layout shift saat bulk response datang
4. pindah page/filter tidak memicu storm request
5. detail page tetap identik dengan behavior sebelumnya

Acceptance:

1. first paint tidak memburuk signifikan
2. tidak ada blank cells permanen pada visible rows
3. detail page tidak regress

### 14.5 Request reduction test

Bandingkan sebelum vs sesudah untuk satu tab screener selama 10 menit:

1. total request ke `/cache-summary`
2. total request ke endpoint orderflow
3. total symbol yang dihydrate
4. latency median/p95

Target minimum yang realistis:

1. penurunan request orderflow list `> 80%`
2. penurunan jalur per-symbol `/cache-summary` dari screener mendekati nol
3. latency list tidak memburuk secara signifikan

### 14.6 D1 integrity / query plan test

Sesudah implementasi, jalankan:

1. `PRAGMA index_list(...)`
2. `EXPLAIN QUERY PLAN ...`
3. sampling response time untuk bulk endpoint vs path lama

Acceptance:

1. query hot path tidak full scan
2. bulk endpoint lebih efisien daripada N request individual

---

## 15) Rollout Gate dan Exit Criteria

### 15.1 Gate untuk lanjut rollout

Phase berikutnya hanya boleh jalan kalau fase sebelumnya lolos:

1. parity test
2. freshness test
3. UX regression check
4. request reduction target minimum

### 15.2 Rollback criteria

Rollback atau disable feature flag jika:

1. mismatch data signifikan
2. stale data tampil tanpa indikator
3. detail page terdampak
4. latency p95 memburuk tajam
5. read tidak turun secara material

### 15.3 Definisi sukses

Perubahan dianggap sukses bila:

1. list tetap terasa fresh untuk user
2. detail tetap akurat seperti sebelumnya
3. parity data tetap tinggi
4. request/read dari screener turun drastis
5. kita bisa mengobservasi penurunan billing D1 pada periode pengamatan berikutnya

---

## 16) Automated Manual Testing dengan Playwright

Untuk membantu integrity test setelah rollout, sudah dibuat suite Playwright terisolasi di:

1. `workers/e2e-playwright`

Tujuan suite ini bukan menggantikan seluruh contract test backend, tetapi mengunci behavior user-facing paling kritis pada screener yang baru dioptimasi.

### 16.1 Cakupan skenario yang sudah diautomasi

Suite saat ini meng-cover skenario berikut:

1. halaman `/idx/emiten/broker-summary.html` berhasil load dan merender row screener
2. initial load memakai `/screener-accum?include_orderflow=false`
3. hydration visible rows memakai bulk endpoint `/orderflow/snapshots`
4. initial screener load tidak fan-out ke banyak request `/cache-summary?symbol=...`
5. search symbol pada screener tetap bekerja
6. klik row screener tetap masuk ke detail mode symbol terkait

### 16.2 Cara menjalankan

Default target:

1. `APP_BASE_URL=https://app-sssaham.mkemalw.workers.dev`
2. `API_BASE_URL=https://api-saham.mkemalw.workers.dev`

Command:

```bash
cd workers/e2e-playwright
npm install
npx playwright install chromium
npm test
```

### 16.3 Hasil verifikasi terakhir

Verifikasi lokal terhadap deployment live menghasilkan:

1. `2 passed (24.2s)` pada 2026-03-30

### 16.4 Skenario manual lanjutan yang masih perlu dijalankan

Walau suite otomatis sudah hijau, checklist manual berikut tetap penting:

1. buka screener pada market hours dan pastikan angka visible rows ter-refresh tanpa flicker berlebihan
2. pindah page pagination dan pastikan hanya row page aktif yang dihydrate
3. aktifkan filter preset `Smart`, `Strict`, dan `ARA`, lalu cek row count dan render tetap stabil
4. search symbol populer seperti `BBRI`, `TLKM`, `BMRI`, lalu buka detail page masing-masing
5. buka tab screener, pindah browser ke tab lain lebih dari 1 menit, lalu kembali dan pastikan tidak ada request storm saat hidden
6. cek mobile viewport untuk memastikan search, filter bar, dan sticky column tetap usable

### 16.5 Kriteria lulus untuk suite ini

Suite Playwright ini dianggap cukup untuk smoke guard rollout bila:

1. semua test hijau pada deployment target
2. tidak ada lonjakan `/cache-summary?symbol=` saat initial screener load
3. bulk `/orderflow/snapshots` tetap terpanggil
4. navigasi list ke detail tidak regress
