# 0001 — Scenario Test Manual (Playwright) 

Dokumen ini adalah runbook skenario test manual berbasis Playwright untuk alur `broker-summary`.
Tujuan utamanya: agent dapat mengeksekusi skenario **berurutan** dari S00 sampai selesai dengan standar QA industri (traceable, repeatable, evidence-based).

## 1. Ruang Lingkup

In scope:
1. Halaman `broker-summary` (index + detail).
2. Integritas request jaringan utama (`/screener-accum`, `/orderflow/snapshots`, `/cache-summary`).
3. Regresi tanggal trading (contoh kasus BBRI 2026-03-30/31).
4. Smoke untuk AI Analysis trigger dari UI (non-deep validation model quality).
5. Sampling random emiten untuk validasi perilaku umum.

Out of scope:
1. Akurasi rekomendasi AI secara fundamental.
2. Backtesting strategi trading.
3. Load/performance test skala besar.

## 2. Standar Eksekusi

Aturan umum:
1. Semua skenario punya ID unik (`S00`, `S01`, dst).
2. Eksekusi wajib urut sesuai fase (gated execution).
3. Jika skenario P0 gagal, hentikan fase berikutnya dan buat defect.
4. Setiap skenario wajib menyimpan evidence minimal: command, hasil pass/fail, dan artefak.

Status yang dipakai:
1. `NOT_RUN`
2. `PASS`
3. `FAIL`
4. `BLOCKED`

Severity defect:
1. `SEV-1` = blocker produksi/fitur utama tidak bisa dipakai.
2. `SEV-2` = fungsi utama jalan tapi hasil salah/menyesatkan.
3. `SEV-3` = isu minor UI/UX atau edge case non-blocking.

## 3. Environment & Prasyarat

Environment default:
1. `APP_BASE_URL=https://app-sssaham.mkemalw.workers.dev`
2. `API_BASE_URL=https://api-saham.mkemalw.workers.dev`
3. Browser: Chromium (Playwright).

Prasyarat lokal:
1. Posisi terminal di `workers/e2e-playwright`.
2. Dependency terpasang.

Command setup:

```bash
cd /home-ssd/mkemalw/Projects/SSSAHAM/workers/e2e-playwright
npm ci
npx playwright install --with-deps chromium
```

Command baseline report:

```bash
npx playwright test --project=chromium
npx playwright show-report
```

## 4. Gated Execution Flow

Phase 0 (Readiness):
1. S00

Phase 1 (Smoke P0):
1. S01
2. S02
3. S03

Phase 2 (Functional Regression P0/P1):
1. S04
2. S05
3. S06
4. S09

Phase 3 (Randomized Manual Regression):
1. S07
2. S08

Exit criteria minimum:
1. Semua P0 = `PASS`.
2. Tidak ada defect `SEV-1` terbuka.
3. Artefak Playwright tersedia untuk seluruh skenario yang dijalankan.

## 5. Scenario Matrix

| ID  | Nama Skenario | Priority | Tipe | Mode | Referensi Script |
|---|---|---|---|---|---|
| S00 | Readiness & health check | P0 | Pre-check | Manual CLI | N/A |
| S01 | Screener load & row visibility | P0 | Smoke | Automated | `tests/broker-summary.spec.mjs` |
| S02 | Initial request avoids fan-out | P0 | Smoke | Automated | `tests/broker-summary.spec.mjs` |
| S03 | Search + navigate index ke detail | P0 | Smoke | Automated | `tests/broker-summary.spec.mjs` |
| S04 | BBRI trading date regression (30/31) | P0 | Regression | Automated | `tests/broker-summary-bbri-range.spec.mjs` |
| S05 | Holiday range no false backfill spinner | P1 | Regression | Manual+CLI | N/A |
| S06 | AI Analysis trigger dari detail | P1 | Functional | Manual (headed) | N/A |
| S07 | Random emiten sample (10 simbol) | P1 | Exploratory Regression | Manual+Playwright session | N/A |
| S08 | Random emiten AI trigger spot-check (3 simbol) | P2 | Exploratory Regression | Manual (headed) | N/A |
| S09 | Broker detail fokus 1 emiten via query `stock` | P0 | Regression | Automated | `tests/broker-detail-focus-stock.spec.mjs` |

## 6. Detail Skenario

### S00 — Readiness & Health Check

Metadata:
1. Priority: `P0`
2. Status awal: `NOT_RUN`

Langkah:
1. Jalankan health endpoint app dan api.
2. Pastikan response code sukses.
3. Catat timestamp eksekusi.

Command:

```bash
curl -i "$APP_BASE_URL/idx/emiten/broker-summary.html" | head -n 20
curl -s "$API_BASE_URL/health" | jq
```

Expected result:
1. App URL dapat diakses.
2. API health `ok=true` atau status sehat ekuivalen.

Evidence minimum:
1. Potongan output `curl`.
2. Waktu eksekusi.

---

### S01 — Screener Load & Row Visibility

Metadata:
1. Priority: `P0`
2. Status awal: `NOT_RUN`

Langkah:
1. Jalankan test Playwright skenario load screener.
2. Verifikasi jumlah row > 0.

Command:

```bash
APP_BASE_URL="$APP_BASE_URL" API_BASE_URL="$API_BASE_URL" \
npx playwright test tests/broker-summary.spec.mjs \
  --project=chromium \
  -g "loads rows, uses bulk orderflow, supports search, and navigates to detail"
```

Expected result:
1. Test `PASS`.
2. Tidak ada timeout menunggu row tabel.

Evidence minimum:
1. Output test terminal.
2. Report Playwright.

---

### S02 — Initial Request Avoids Fan-out

Metadata:
1. Priority: `P0`
2. Status awal: `NOT_RUN`

Langkah:
1. Jalankan test Playwright skenario anti fan-out.
2. Verifikasi `/cache-summary?symbol=` tidak meledak (tetap low count).

Command:

```bash
APP_BASE_URL="$APP_BASE_URL" API_BASE_URL="$API_BASE_URL" \
npx playwright test tests/broker-summary.spec.mjs \
  --project=chromium \
  -g "initial screener request avoids orderflow fan-out"
```

Expected result:
1. Test `PASS`.
2. Assertion fan-out terpenuhi.

Evidence minimum:
1. Output test terminal.
2. Jika gagal: screenshot/video dari folder `test-results`.

---

### S03 — Search + Navigate Index ke Detail

Metadata:
1. Priority: `P0`
2. Status awal: `NOT_RUN`

Langkah:
1. Gunakan skenario automated S01 sebagai basis.
2. Pastikan row pertama bisa diklik dan URL detail terbentuk.

Command:

```bash
APP_BASE_URL="$APP_BASE_URL" API_BASE_URL="$API_BASE_URL" \
npx playwright test tests/broker-summary.spec.mjs \
  --project=chromium \
  -g "loads rows, uses bulk orderflow, supports search, and navigates to detail"
```

Expected result:
1. URL berformat `/idx/emiten/broker-summary.html?kode=XXXX`.
2. `#detail-view` visible.

Evidence minimum:
1. Output assertion URL dari report/log.

---

### S04 — BBRI Trading Date Regression (2026-03-30 / 2026-03-31)

Metadata:
1. Priority: `P0`
2. Status awal: `NOT_RUN`

Langkah:
1. Jalankan test regresi BBRI khusus range tanggal.
2. Pastikan `history` mengandung kedua tanggal.

Command:

```bash
APP_BASE_URL="$APP_BASE_URL" API_BASE_URL="$API_BASE_URL" \
npx playwright test tests/broker-summary-bbri-range.spec.mjs --project=chromium
```

Expected result:
1. Test `PASS`.
2. Payload mengandung `2026-03-30` dan `2026-03-31`.

Evidence minimum:
1. Output terminal `1 passed`.
2. Jika fail: screenshot/video + response error context.

---

### S05 — Holiday Range: No False Backfill Spinner

Metadata:
1. Priority: `P1`
2. Status awal: `NOT_RUN`

Langkah:
1. Buka page detail BBRI dengan range libur panjang.
2. Validasi tidak stuck pada status backfill palsu.

Command manual (headed):

```bash
APP_BASE_URL="$APP_BASE_URL" API_BASE_URL="$API_BASE_URL" \
npx playwright open "$APP_BASE_URL/idx/emiten/broker-summary.html?kode=BBRI&start=2026-03-18&end=2026-03-24"
```

Checklist verifikasi:
1. Date input terisi sesuai range.
2. Tidak ada loop loading/backfill tak berujung.
3. UI menampilkan kondisi kosong yang konsisten jika memang hari libur semua.

Expected result:
1. Halaman stabil dan user tidak terkunci dalam retry loop.

Evidence minimum:
1. Screenshot state final.
2. Catatan observasi 2-3 kalimat.

---

### S06 — AI Analysis Trigger Dari Detail

Metadata:
1. Priority: `P1`
2. Status awal: `NOT_RUN`

Langkah:
1. Buka detail emiten likuid (contoh: BBRI/BBCA).
2. Klik tombol `AI Analysis`.
3. Tunggu modal hasil.
4. Catat provider dan model yang tampil.

Command manual (headed):

```bash
APP_BASE_URL="$APP_BASE_URL" API_BASE_URL="$API_BASE_URL" \
npx playwright open "$APP_BASE_URL/idx/emiten/broker-summary.html?kode=BBRI"
```

Checklist verifikasi:
1. Tombol AI aktif dan modal terbuka.
2. Tidak crash JS di console.
3. Jika gagal provider, error chain terbaca jelas di modal.

Expected result:
1. Analisis muncul atau error terstruktur (bukan blank state).

Evidence minimum:
1. Screenshot modal.
2. Catatan provider/model.

---

### S07 — Random Emiten Sample (10 simbol)

Metadata:
1. Priority: `P1`
2. Status awal: `NOT_RUN`

Langkah:
1. Ambil 10 simbol acak dari screener.
2. Untuk tiap simbol, buka detail page.
3. Verifikasi halaman detail render tanpa error fatal.

Command ambil sampel:

```bash
curl -s "$API_BASE_URL/screener-accum?include_orderflow=false" \
  | jq -r '.candidates[].symbol' \
  | shuf | head -n 10
```

Eksekusi manual:
1. Loop 10 simbol dengan `playwright open` atau satu browser session.
2. Catat simbol yang gagal load.

Expected result:
1. Minimal 9/10 simbol render detail normal.
2. Tidak ada pola kegagalan sistemik.

Evidence minimum:
1. Daftar 10 simbol.
2. Tabel hasil pass/fail per simbol.

---

### S08 — Random Emiten AI Trigger Spot-check (3 simbol)

Metadata:
1. Priority: `P2`
2. Status awal: `NOT_RUN`

Langkah:
1. Pilih 3 simbol acak dari hasil S07 yang lolos render detail.
2. Untuk tiap simbol klik `AI Analysis`.
3. Catat provider yang menangani request.

Expected result:
1. Minimal 2/3 simbol memberi respons analisis/error terstruktur.
2. Tidak ada blank modal permanen.

Evidence minimum:
1. Screenshot modal per simbol.
2. Catatan provider + status.

---

### S09 — Broker Detail Fokus 1 Emiten Via Query `stock`

Metadata:
1. Priority: `P0`
2. Status awal: `NOT_RUN`

Langkah:
1. Jalankan test Playwright khusus halaman `broker/detail`.
2. Verifikasi URL dengan `stock=TRON` hanya menampilkan emiten `TRON`.
3. Verifikasi URL tanpa `stock` tetap menampilkan daftar emiten penuh.
4. Verifikasi input filter stock di halaman (contoh ketik `TRON`) menyaring ke satu emiten.

Command:

```bash
APP_BASE_URL="$APP_BASE_URL" \
npx playwright test tests/broker-detail-focus-stock.spec.mjs --project=chromium
```

Expected result:
1. Test case `focuses to one stock when stock query param is present` = `PASS`.
2. Holdings table, chart labels, dan breadth hanya berisi `TRON` saat `stock=TRON`.
3. Test case tanpa param `stock` tetap `PASS` dan menampilkan multi-emiten.
4. Test case in-page filter stock `PASS` dan bisa clear kembali ke multi-emiten.

Evidence minimum:
1. Output terminal `3 passed`.
2. Jika fail: screenshot/video/trace dari folder `test-results`.

## 7. Format Laporan Eksekusi

Gunakan tabel ini saat menjalankan:

| Scenario | Priority | Status | Start | End | Evidence Link/Path | Notes |
|---|---|---|---|---|---|---|
| S00 | P0 | NOT_RUN | - | - | - | - |
| S01 | P0 | NOT_RUN | - | - | - | - |
| S02 | P0 | NOT_RUN | - | - | - | - |
| S03 | P0 | NOT_RUN | - | - | - | - |
| S04 | P0 | NOT_RUN | - | - | - | - |
| S05 | P1 | NOT_RUN | - | - | - | - |
| S06 | P1 | NOT_RUN | - | - | - | - |
| S07 | P1 | NOT_RUN | - | - | - | - |
| S08 | P2 | NOT_RUN | - | - | - | - |
| S09 | P0 | NOT_RUN | - | - | - | - |

## 8. Defect Ticket Template

Template singkat:

1. `Title`: `[SXX][SEV-Y] Ringkas masalah`
2. `Environment`: APP/API URL, branch/commit, tanggal.
3. `Precondition`: kondisi sebelum test.
4. `Steps to Reproduce`: langkah bernomor.
5. `Expected Result`: hasil yang diharapkan.
6. `Actual Result`: hasil aktual.
7. `Evidence`: screenshot/video/trace path.
8. `Impact`: bisnis/fitur terdampak.
9. `Suspected Area`: file atau endpoint terkait.

## 9. Catatan Operasional untuk Agent

Urutan kerja agent:
1. Jalankan S00.
2. Jika S00 pass, lanjut S01-S04.
3. Jika ada P0 fail, stop dan buat defect.
4. Jika seluruh P0 pass, lanjut S05-S09.
5. Tutup dengan tabel laporan + daftar defect.

Prinsip eksekusi:
1. Satu skenario selesai dulu, baru lanjut skenario berikutnya.
2. Jangan gabung hasil beberapa skenario dalam satu status.
3. Selalu simpan artefak saat fail untuk mempercepat RCA.

## 10. Template Skenario Baru

Gunakan template ini saat menambah skenario berikutnya (`S10+`):

````md
### SXX — <Nama Skenario>

Metadata:
1. Priority: `P0|P1|P2`
2. Status awal: `NOT_RUN`
3. Mode: `Automated|Manual|Hybrid`

Precondition:
1. <kondisi awal 1>
2. <kondisi awal 2>

Langkah:
1. <langkah 1>
2. <langkah 2>
3. <langkah 3>

Command:
```bash
<perintah eksekusi>
```

Expected result:
1. <hasil yang diharapkan 1>
2. <hasil yang diharapkan 2>

Evidence minimum:
1. <log/report>
2. <screenshot/video/trace>
````
