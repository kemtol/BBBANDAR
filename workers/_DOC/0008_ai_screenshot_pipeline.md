# AI Broker Summary — Multi-Screenshot Pipeline

## 1. Tujuan & Ruang Lingkup

Menstandarkan alur pengambilan lebih dari satu screenshot (summary fund-flow + pembanding intraday) sebelum memanggil analisis AI pada fitur **AI Broker Summary**. Dokumen ini mencakup:

- Arsitektur end-to-end (frontend → intercepting service → backend AI worker).
- Konvensi penamaan, metadata, dan TTL untuk objek screenshot di R2.
- Strategi cache, housekeeping, serta requirement ketat supaya respons model AI konsisten **dalam format JSON**.

## 2. Komponen Sistem

| Komponen | Fungsi | Catatan |
| --- | --- | --- |
| Frontend (`broker-summary.html`) | Menangkap elemen `#summary-pane` → upload ke `/ai/screenshot`. | Menjalankan `html2canvas`, label default `brokerflow-{range}`. |
| Intercepting Service (baru) | Menghasilkan screenshot tambahan (minimal intraday) menggunakan headless browser. | Berjalan async setelah upload pertama. Mengambil `idx/emiten/detail.html?kode={SYMBOL}`. |
| API Worker (`/ai/screenshot`, `/ai/analyze-broksum`) | Mengelola upload, memicu intercept service, menyusun daftar gambar untuk AI, dan memanggil model. | Bertanggung jawab atas cache, TTL, polling label, dan memastikan output AI dalam JSON. |
| R2 Storage | Menyimpan semua screenshot dan cache analisis. | Harus menyimpan metadata (symbol, label, version, source, generated_at). |
| AI Provider (OpenAI, Grok, dll.) | Menghasilkan analisis berbasis multi-screenshot. | **WAJIB** mengembalikan respons dalam JSON valid. |

## 3. Alur Kerja End-to-End

1. **Klik AI Analysis** (frontend).
   - Tangkap `#summary-pane` → buat Blob JPEG → `PUT /ai/screenshot?symbol=POWR&label=brokerflow-14d`.
2. **Endpoint `/ai/screenshot`**:
   - Simpan file ke R2 (`ai-screenshots/POWR/{DATE}_brokerflow-14d.jpg`).
   - Tulis metadata `{ symbol, label, version, source="frontend", generated_at }`.
   - Enqueue job ke **Intercepting Service** untuk simbol & tanggal yang sama.
3. **Intercepting Service**:
   - Render `idx/emiten/detail.html?kode=POWR`, tunggu seluruh komponen intraday ready.
   - Ambil elemen intraday target (`#summary-pane` atau elemen yang disepakati).
   - Upload hasil ke `/ai/screenshot?symbol=POWR&label=intraday` dengan metadata `{ source="intraday-interceptor" }`.
4. **Analisis (`POST /ai/analyze-broksum`)**:
   - Terima `symbol`, `image_keys` awal dari frontend.
   - **Lookup label wajib** (brokerflow + intraday) di R2 untuk `symbol` + `date`.
   - Jika `forceRefresh=true`, validasi ulang label dan panggil ulang intercept service bila perlu.
   - Bangun payload AI dengan seluruh gambar tersedia.
   - Panggil model (OpenAI/Grok) menggunakan prompt terstandar.
   - **Validasi bahwa respons adalah JSON**: jika model mengembalikan teks non-JSON, worker harus:
     1. Mencoba parsing → jika gagal, kirim ulang prompt dengan instruksi koreksi.
     2. Jika masih gagal setelah retry, kembalikan error ke frontend.
   - Simpan hasil ke `ai-cache/{SYMBOL}/{DATE}.json` (berisi JSON analisis + daftar screenshot + info token + provider).
5. **Frontend Modal**:
   - Menampilkan semua thumbnail (brokerflow & intraday) yang diberikan worker.
   - Render analisis dari JSON (bukan markdown bebas).

## 4. Konvensi Penamaan & Metadata

- **Key R2**: `ai-screenshots/{SYMBOL}/{YYYY-MM-DD}_{LABEL}.jpg`.
- **Mandatory Metadata (`customMetadata`)**:
  ```json
  {
    "symbol": "POWR",
    "label": "intraday",
    "version": "v1",
    "source": "intraday-interceptor",
    "generated_at": "2025-02-05T03:21:00Z"
  }
  ```
- **TTL**: 24 jam (dapat diperpanjang untuk cache hit). Versi baru (misalnya `version="v2"`) harus memicu re-upload & invalidasi cache lama.
- **Cache Analisis**: `ai-cache/{SYMBOL}/{YYYY-MM-DD}.json` berisi struktur JSON final dari model + metadata eksekusi.

## 5. Housekeeping & Observability

- **Cron Harian** (mis. `0 18 * * *`):
  - Hapus screenshot & cache lebih tua dari 7 hari.
  - Laporkan jumlah file terhapus, ukuran, dan simbol terkait ke log/monitoring.
- **Logging**:
  - Catat sukses/gagal intercept, ukuran blob, dan durasi.
  - Simpan statistik token penggunaan per model di log analisis.
- **Alerting**:
  - Jika intercept gagal >3x berturut-turut untuk simbol yang sama dalam 24 jam → kirim alert (Slack/Email).
  - Jika validasi JSON pada respons AI gagal setelah retry → log error kritis.

## 6. Checklist Implementasi

### Frontend
- [ ] Gunakan label upload konsisten (`brokerflow-{range}`) dan sertakan simbol uppercase.
- [ ] (Opsi) Tambahkan polling ringan memastikan label intraday tersedia sebelum memanggil analisis (opsi ini bisa digantikan logic backend).
- [ ] Pastikan UI membaca JSON hasil analisis (bukan markdown) dan menampilkan fallback error bila JSON invalid.

### Backend Worker (`api-saham`)
- [ ] Modifikasi `/ai/screenshot` → enqueue intercept job + tulis metadata.
- [ ] Tambah fungsi helper untuk cek ketersediaan label (menggunakan `head` R2).
- [ ] Update `/ai/analyze-broksum` → susun `image_keys` final, validasi JSON respons dengan retry.
- [ ] Simpan cache JSON + metadata provider/model/token.

### Intercepting Service
- [ ] Deploy service headless (Puppeteer/Playwright) dengan endpoint `POST /capture-intraday` (payload: `{ symbol, date, label }`).
- [ ] Tangani render `detail.html` (load Chart.js, tunggu dataset siap).
- [ ] Upload hasil ke `/ai/screenshot` (gunakan metadata `source` dan `version`).
- [ ] Logging + retry (max 3 percobaan, exponential backoff).

### Housekeeping
- [ ] Tambah cron job untuk bersih-bersih screenshot & cache >7 hari.
- [ ] Buat laporan ringkas (di log) jumlah file terhapus.

### Testing
- [ ] Uji manual: simbol dengan cache kosong → pastikan kedua label tersedia sebelum AI dipanggil.
- [ ] Uji `forceRefresh`: cache lama dihapus → screenshot baru dibuat → JSON terbaru.
- [ ] Uji fallback: bila intercept gagal, pastikan worker merespons error dan tidak memanggil AI dengan data tidak lengkap.
- [ ] Uji validasi JSON: paksa model mengembalikan string non-JSON → pastikan worker retry & mengembalikan error jika tetap gagal.

## 7. Panduan JSON Output Model

- **Prompt** untuk setiap provider harus menekankan: "Berikan output dalam JSON valid sesuai skema berikut ..." (sesuaikan dengan schema analisis yang diinginkan).
- Worker harus menyediakan schema (misal via JSON Schema) dan mem-parsing hasil menggunakan `JSON.parse`.
- Jika parsing gagal:
  1. Worker mengirim permintaan ulang dengan prompt koreksi (sebutkan error parsing).
  2. Jika tetap gagal setelah 1 retry → kembalikan status error ke frontend (`ok: false`, pesan "AI tidak mengembalikan JSON valid").
- Frontend hanya menerima JSON dan menolak menampilkan string raw.

## 8. Rencana Pengembangan Lanjutan

- Tambahkan label tambahan (mis. market depth, footprint, audit trail chart) di intercept pipeline.
- Integrasikan Prompt Service agar pengaturan provider (OpenAI, Grok) plus format JSON terkelola terpusat.
- Buat dashboard observability: latensi intercept, tingkat keberhasilan, dan token usage per provider.
- Evaluasi kompresi (WebP/AVIF) bila ukuran JPEG terlalu besar.
