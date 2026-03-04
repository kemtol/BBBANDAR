# R2 Class A Operations — Efficiency Plan

**Date**: 2026-03-04  
**Author**: System  
**Status**: Draft

---

## Objective

Menurunkan jumlah R2 Class A Operations (PUT, LIST, DELETE) dari **~1.9 juta/hari**
menjadi **< 100.000/hari** sehingga tetap dalam batas free tier 1M/bulan, atau paling
tidak di bawah ~35.000/hari (= 1M/bulan).

## Current State

| # | Worker | Pola | PUT/hari | Masalah |
|---|--------|------|----------|---------|
| 1 | **sector-scrapper** | `appendJsonlBatch` (GET→PUT) per simbol + per sektor, 11 sektor × ~150 simbol × ~210 cron/hari | **~1,300,000** | Read-modify-write per key. 1 cron cycle = ~3.300 PUT |
| 2 | **livetrade-taping** OB15s | `_appendDailySnapshotLine` (GET→PUT) per simbol setiap 15 detik | **~245,000** | Append ke daily JSONL file per simbol, market hours 8.5 jam |
| 3 | **livetrade-durable-engine ×7** | `doWriteMerge` (GET→PUT) per dirty ticker-hour setiap 5 detik | **~300,000** | Hanya aktif saat backfill; idle = 0 |
| 4 | **livetrade-taping** LT+OB+WS | `flushToR2LT`, `flushToR2OB`, `flushToR2WS` (PUT new key) setiap 5 detik | **~50,000** | Write-only (no GET), tapi frekuensi tinggi |
| 5 | **features-service** | `.list()` paginated setiap 5-15 menit | **~5,000** | LIST = Class A |
| **TOTAL** | | | **~1,900,000** | **~57M/bulan → ~$250/bulan** |

Semua hotspot punya pola yang sama: **read-modify-write anti-pattern** — GET existing file → append → PUT back.
Ini berarti setiap logical write = 1 GET + 1 PUT.

---

## Target

| Metric | Current | Target | Reduction |
|--------|---------|--------|-----------|
| Class A ops/hari | ~1.9M | < 35.000 | **98%** |
| Class A ops/bulan | ~57M | < 1M (free tier) | **98%** |
| Est. biaya R2 /bulan | ~$250 | $0 (free tier) | **100%** |

---

## Plan

### Phase 1: sector-scrapper — Buffer-then-Write (saves ~1.3M PUT/hari)

**Problem**: Setiap cron cycle, `writeSectorRecordsToR2()` memanggil `appendJsonlBatch()` per key.
Setiap call = 1 GET + 1 PUT. Dengan 150 simbol × 2 keys (per-symbol + aggregate) × 11 sektor = 3.300 PUT per cron cycle.

**Solution**: Kumpulkan semua record di memory per cron cycle, tulis **1x per key** di akhir cycle. 
Ganti `appendJsonlBatch` (read-modify-write) dengan **write-only PUT** karena tiap cron cycle 
sudah menghasilkan data baru — tidak perlu baca data lama tiap kali, cukup append ke nama file yang berbeda.

**Perubahan**:

1. **Ganti `appendJsonlBatch` → direct PUT ke timestamped key**
   - Dari: `sector/IDXENERGY/BBCA/2026/03/04.jsonl` (1 daily file, append)
   - Ke: `sector/IDXENERGY/BBCA/2026/03/04/{HH}{mm}.jsonl` (1 file per cron run, write-only)
   - Ini menghilangkan GET sebelum PUT — langsung PUT saja
   
2. **Batch per-sector aggregate jadi 1 PUT**
   - Dari: `sector/IDXENERGY/2026/03/04.jsonl` (append per cron)
   - Ke: `sector/IDXENERGY/2026/03/04/{HH}{mm}.jsonl` (write-only per cron)

3. **Aggregate daily file dibuat sekali oleh cron-housekeeping di akhir hari**
   - Job baru: merge semua `{HH}{mm}.jsonl` → `daily.jsonl` sekali saja

**Estimasi setelah fix**:
- Sebelum: 3.300 PUT per cycle × 210 cycles = **~693.000 PUT/hari**
- Sesudah: (150 simbol + 1 aggregate) × 11 sektor = ~1.661 PUT per cycle, **tanpa GET**
- Tapi cron setiap 1-5 menit → tetap ~210 cycles → **~350.000 PUT/hari**
- Masih banyak? Ya. Solusi lebih agresif:

4. **Turunkan granularitas write dari per-simbol ke per-sektor saja**
   - Semua simbol dalam 1 sektor → 1 JSONL file (sudah ada `sectorKey`)
   - Drop per-symbol key sepenuhnya — consumer baca dari aggregate
   - 210 cycles × 11 sektor × 1 PUT = **~2.310 PUT/hari** ✅

**Risiko & Mitigasi**:
- ❗ Consumer `/sector/cvd` di api-saham baca per-sector aggregate (sudah) → **tidak terdampak**
- ❗ Consumer `/sector/cvd/batch` baca per-sector aggregate → **tidak terdampak**
- ❗ Jika perlu data per-simbol, bisa di-derive dari aggregate karena setiap record sudah ada field `symbol`
- ❗ Hilangnya per-symbol key berarti lookup individual simbol butuh scan aggregate → tapi volume kecil (~150 simbol/sektor), scan cepat

**Impact**: ~1,300,000 → **~2,310 PUT/hari** (**99.8% reduction**)

---

### Phase 2: livetrade-taping OB15s — Buffer in Memory (saves ~245K PUT/hari)

**Problem**: `flushOB15sDaily()` dipanggil setiap alarm cycle (2 detik), menulis snapshot 
setiap 15 detik per simbol. Setiap write = GET daily file + append + PUT. 
Dengan 60 simbol × 2.040 interval/hari = **~122.400 PUT/hari** (plus same number of GET).

**Solution**: Buffer snapshot di memory, flush ke R2 **sekali per 5 menit** (bukan per 15 detik). 
Dan ganti dari append-to-daily ke **write-new-key per flush**.

**Perubahan**:

1. **Ganti `_appendDailySnapshotLine` (GET→PUT) dengan buffered batch write**
   - Buffer: `Map<kode, snapshot[]>` di memory
   - Setiap 15 detik: push snapshot ke buffer (memory only)
   - Setiap 5 menit: flush semua buffer ke R2 sebagai 1 PUT per simbol
   - Key: `ob2/snapshot15s/v1/symbol={KODE}/date={DATE}/{HH}{mm}.jsonl`
   
2. **Hapus `_appendDailySnapshotLine` (read-modify-write)**
   - Ganti dengan direct PUT ke timestamped key (no GET needed)

3. **Daily consolidation by cron-housekeeping**
   - Merge semua 5-min files → `daily.jsonl` sekali di akhir hari

**Estimasi setelah fix**:
- Sebelum: 60 simbol × 2.040 snapshots = **~122.400 PUT/hari**
- Sesudah: 60 simbol × (510 menit / 5 menit) = 60 × 102 = **~6.120 PUT/hari**
- Jika batch semua simbol ke 1 file per flush: 102 PUT/hari ✅

**Pendekatan yang dipilih**: 1 file per simbol per 5-min flush → **~6.120 PUT/hari**
(tetap per-simbol agar `ob2-seed` endpoint bisa baca per simbol tanpa scan)

**Risiko & Mitigasi**:
- ❗ Kehilangan data jika DO crash sebelum flush → Durable Object storage punya built-in persistence, 
  dan 5 menit data loss acceptable untuk OB2 snapshot (bukan trade data)
- ❗ Memory usage: 60 simbol × 20 snapshots × ~500 bytes = ~600KB → sangat aman
- ❗ `ob2-seed` endpoint perlu diupdate untuk baca multi-file (bukan 1 daily) → atau buat daily di akhir hari

**Impact**: ~245,000 → **~6,120 PUT/hari** (**97.5% reduction**)

---

### Phase 3: livetrade-taping LT/OB/WS flush — Increase interval (saves ~40K PUT/hari)

**Problem**: 3 buffer (`flushToR2LT`, `flushToR2OB`, `flushToR2WS`) masing-masing flush 
setiap 5 detik. Ini menghasilkan ~50.000 PUT/hari. Ini sudah write-only (no GET), 
tapi frekuensinya masih terlalu tinggi.

**Solution**: Naikkan flush interval dari 5 detik ke **60 detik**.

**Perubahan**:
- `FLUSH_INTERVAL_LT`: 5s → 60s
- `FLUSH_INTERVAL_OB`: 5s → 60s  
- `FLUSH_INTERVAL_WS`: 5s → 60s
- Tetap flush jika buffer penuh (batch size/byte limit) — safety valve

**Estimasi setelah fix**:
- Sebelum: ~3 flushes × (510 min × 60s/5s) = ~18.360 PUT per pipeline → ~50.000 total
- Sesudah: ~3 flushes × (510 min × 60s/60s) = ~1.530 PUT per pipeline → **~4.590 PUT/hari**

**Risiko & Mitigasi**:
- ❗ Data loss window naik dari 5 detik ke 60 detik saat DO crash
  → Trade data (LT) lebih critical, tapi sudah di-buffer di V2 pipeline juga
  → Mitigasi: flush ke DO storage (gratis) tiap 5 detik, ke R2 tiap 60 detik
- ❗ File size lebih besar per flush → masih jauh di bawah R2 limit (5GB per object)

**Impact**: ~50,000 → **~4,590 PUT/hari** (**91% reduction**)

---

### Phase 4: features-service LIST calls — Cache atau kurangi frekuensi

**Problem**: `.list()` dipanggil dengan pagination setiap 5-15 menit untuk scan footprint files. 
Setiap `.list()` = 1 Class A operation. Dengan pagination (10 pages) × 288 cycles = **~2.880/hari**.

**Solution**: 
1. Cache hasil LIST di memory/KV selama 15 menit
2. Gunakan D1 index sebagai pengganti R2 LIST jika memungkinkan

**Estimasi setelah fix**:
- Sebelum: ~5.000 LIST/hari
- Sesudah: ~500 LIST/hari (cache hit 90%)

**Risiko**: Minimal — LIST result bisa stale max 15 menit, acceptable.

**Impact**: ~5,000 → **~500 LIST/hari** (**90% reduction**)

---

### Phase 5: livetrade-durable-engine — Hanya aktifkan saat backfill

**Problem**: 7 engine instances, masing-masing alarm setiap 5 detik. 
Saat idle (tidak ada backfill), tidak ada write. 
Tapi saat backfill aktif: ~300.000 PUT/hari.

**Solution**:
1. Pastikan engine idle saat tidak ada backfill task (sudah default)
2. Saat backfill: naikkan flush interval dari 5s ke 30s
3. Naikkan `limit` dirty hours dari 50 ke 200 per cycle (batch lebih besar, cycle lebih jarang)
4. Pertimbangkan kurangi dari 7 engine ke 2-3

**Estimasi setelah fix**:
- Saat idle: 0 (sudah)
- Saat backfill: ~300.000 → ~50.000 (flush 6x lebih jarang)

**Risiko**: Backfill lebih lambat → acceptable, bukan real-time requirement.

**Impact**: ~300,000 → **~50,000 PUT/hari (saat backfill)**, 0 saat idle

---

## Summary

| Phase | Worker | Sebelum | Sesudah | Pengurangan | Effort | Priority |
|-------|--------|---------|---------|-------------|--------|----------|
| 1 | sector-scrapper | 1,300,000 | 2,310 | **99.8%** | Medium | 🔴 P0 |
| 2 | livetrade-taping OB15s | 245,000 | 6,120 | **97.5%** | Medium | 🔴 P0 |
| 3 | livetrade-taping flush | 50,000 | 4,590 | **91%** | Low | 🟡 P1 |
| 4 | features-service LIST | 5,000 | 500 | **90%** | Low | 🟢 P2 |
| 5 | durable-engine (backfill) | 300,000 | 50,000 | **83%** | Medium | 🟢 P2 |
| **TOTAL (tanpa backfill)** | | **1,600,000** | **~13,520** | **99.2%** | | |
| **TOTAL (dengan backfill)** | | **1,900,000** | **~63,520** | **96.7%** | | |

### Target Achievement

| Metric | Current | After All Phases | Target | ✅? |
|--------|---------|-----------------|--------|-----|
| Class A ops/hari (normal) | ~1.6M | ~13,520 | < 35,000 | ✅ |
| Class A ops/bulan (normal) | ~48M | ~405,600 | < 1M | ✅ |
| Est. biaya R2/bulan | ~$210 | **$0** (free tier) | $0 | ✅ |

---

## Execution Order

1. **Phase 1** (sector-scrapper) — paling besar dampaknya, paling urgent
2. **Phase 2** (OB15s) — kedua terbesar, harus bersamaan dengan Phase 1
3. **Phase 3** (flush interval) — quick win, bisa dikerjakan paralel
4. **Phase 4 & 5** — nice to have, bisa dijadwalkan setelah Phase 1-3 beres

---

## Risk Matrix

| Risk | Probability | Impact | Mitigasi |
|------|-------------|--------|----------|
| Data loss saat DO crash (Phase 2,3) | Low | Medium | Buffer ke DO storage (gratis) tiap 5s, R2 tiap 60s |
| Consumer API rusak setelah key pattern berubah (Phase 1,2) | Medium | High | Update consumer (`/sector/cvd`, `ob2-seed`) sebelum deploy producer |
| Daily consolidation gagal (Phase 1,2) | Low | Low | Data tetap ada di per-interval files, cuma perlu re-run merge |
| Backfill lambat (Phase 5) | Low | Low | Acceptable — bukan real-time requirement |
| Memory overflow di DO (Phase 2) | Very Low | Medium | Cap buffer size, force-flush jika > 2MB |
