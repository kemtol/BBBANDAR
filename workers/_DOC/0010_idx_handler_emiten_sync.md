# Dokumentasi Arsitektur IDX Handler: Sinkronisasi Emiten (D1)

## 🎯 Objective
Sistem ini bertugas **menjaga konsistensi daftar emiten** antara sumber resmi BEI (IDX) dan tabel `emiten` di D1. Fokus utamanya:

1. **Daily sync emiten**: Setiap hari worker `idx-handler` menarik data terbaru dari IDX (`GetEmiten`) dan melakukan *upsert* ke tabel `emiten` di D1.
2. **Deteksi emiten baru (IPO)**: Jika muncul ticker baru di IDX yang belum ada di D1, worker otomatis menambahkan baris baru dengan field sektor/industri boleh kosong dulu (akan di-repair belakangan).
3. **Sumber tunggal kebenaran untuk daftar saham**: Endpoint baru di `api-saham` membaca langsung dari D1 sehingga semua sistem downstream (UI, fitur lain) menggunakan daftar emiten yang sama.

---

## 1. Konteks dan Masalah

### 1.1. Kondisi Saat Ini
- Tabel `emiten` di D1 berisi daftar saham (kolom: `ticker`, `sector`, `industry`, `status`, `created_at`, `updated_at`, dll).
- Data ini awalnya di-*seed* secara manual / batch, sehingga **tidak otomatis mengikuti** penambahan saham baru (IPO) di IDX.
- Frontend (misalnya halaman IDX / emiten list) mengandalkan daftar ini untuk:
  - Dropdown / autocomplete ticker.
  - Filter per sektor / industri.

### 1.2. Masalah
- Jika ada saham baru yang IPO namun belum tercatat di tabel `emiten`:
  - UI tidak bisa menemukan ticker tersebut.
  - Worker lain (orderflow, brokerflow, dsb.) berpotensi gagal menulis atau menampilkan data karena ticker tidak dikenal.
- Proses update manual **berisiko terlambat** dan tidak terukur.

### 1.3. Target
- **Daily consistency** antara IDX dan D1.
- Kemudahan audit: kapan terakhir sync, berapa emiten baru yang masuk.
- Endpoint jelas di `api-saham` untuk membaca list emiten yang sudah terdokumentasi.

---

## 2. Sumber Data IDX: GetEmiten

### 2.1. Endpoint Upstream
- URL: `https://www.idx.co.id/primary/Helper/GetEmiten?emitenType=*`
- Metode: `GET`
- Konten: JSON berisi daftar emiten IDX.
- Auth: publik (menggunakan header standar browser).

> Catatan: Format payload IDX bisa berubah tanpa pemberitahuan; worker `idx-handler` harus defensif (misalnya cek field secara aman dengan default).

### 2.2. Normalisasi ke Model Internal

Secara konseptual, setiap item dari IDX akan dinormalisasi ke struktur internal berikut:

```js
{
  ticker: "BBRI.JK",         // kode saham lengkap sesuai IDX
  name: "Bank Rakyat Indonesia Tbk", // nama perusahaan (opsional untuk fitur ini)
  sector: "Financial Services" || null,
  industry: "Banks - Regional" || null,
  status: "ACTIVE" | "SUSPENDED" | "DELISTED", // mapping dari field status IDX jika tersedia
}
```

- Jika sector/industry belum tersedia dari IDX dalam bentuk yang konsisten, **biarkan `sector` dan `industry` = `NULL`**.
- Repair sector/industry bisa dilakukan di fase terpisah (worker lain atau job manual) dengan tetap menggunakan baris `emiten` yang sudah dibuat oleh sync ini.

---

## 3. Skema D1: Tabel `emiten` (Konseptual)

> Skema SQL detail bisa diletakkan di dokumen lanjutan (misal `0011_idx_handler_schema_sync.md`). Di sini fokus pada kolom yang digunakan oleh idx-handler.

Kolom minimal yang dipakai:

| Kolom       | Tipe        | Deskripsi                                    |
| ----------- | ----------- | -------------------------------------------- |
| `ticker`    | TEXT (PK)   | Kode saham, misal `BBRI.JK`                  |
| `sector`    | TEXT        | Nama sektor (boleh `NULL`)                   |
| `industry`  | TEXT        | Nama industri (boleh `NULL`)                 |
| `status`    | TEXT        | `ACTIVE` / `SUSPENDED` / `DELISTED`          |
| `created_at`| DATETIME    | Waktu insert pertama kali                    |
| `updated_at`| DATETIME    | Waktu terakhir di-update oleh worker         |

Aturan:
- Worker `idx-handler` **tidak menghapus baris** ketika emiten hilang dari respon IDX; strategi untuk delisting bisa dirancang kemudian.
- Untuk v1, fokus pada **insert dan update** (upsert) agar IPO segera tercatat.

---

## 4. Desain Worker Baru: `idx-handler`

Worker `idx-handler` akan menjadi **service internal** untuk segala hal yang berhubungan dengan IDX, dimulai dari sinkronisasi emiten.

### 4.1. Binding Lingkungan

Contoh binding yang dibutuhkan (nama final mengikuti konfigurasi `wrangler.toml`):

- `SSSAHAM_DB` → D1 database utama yang berisi tabel `emiten`.
- `IDX_EMITEN_SYNC_TOKEN` (opsional) → secret untuk mengamankan endpoint internal.

### 4.2. Endpoint Internal di idx-handler

#### 4.2.1. `POST /internal/idx/sync-emiten`

- **Tujuan**: Menarik data dari IDX dan melakukan upsert ke tabel `emiten` di D1.
- **Akses**: Internal (dipanggil oleh cron Cloudflare atau endpoint admin di `api-saham`).

**Request**

- Method: `POST`
- Headers opsional:
  - `X-Admin-Token: {IDX_EMITEN_SYNC_TOKEN}` untuk proteksi manual.

**Response (contoh)**

```json
{
  "status": "ok",
  "synced_at": "2026-02-16T03:00:00Z",
  "summary": {
    "total_idx": 900,
    "existing": 880,
    "inserted": 5,
    "updated": 15,
    "skipped": 0
  }
}
```

### 4.3. Alur Kerja Sync (High Level)

1. Worker menerima `POST /internal/idx/sync-emiten`.
2. Worker memanggil `GET GetEmiten` ke IDX.
3. Response IDX diparsing dan dinormalisasi ke array objek internal.
4. Untuk setiap emiten:
   - Cek apakah `ticker` sudah ada di D1.
   - Jika belum ada → `INSERT` baris baru (`sector` & `industry` boleh `NULL`).
   - Jika sudah ada → `UPDATE` field yang berubah (`status`, dan nantinya `name/sector/industry` jika mau).
5. Di akhir, worker mengembalikan ringkasan jumlah `inserted` / `updated`.

> Catatan: Untuk v1, operasi bisa dilakukan dengan query per-baris. Optimisasi (batch insert/update) bisa datang kemudian jika diperlukan.

---

## 5. Peran api-saham: Endpoint Tambahan

`api-saham` akan memiliki **dua endpoint baru** terkait emiten:

### 5.1. Endpoint 1: Baca Daftar Emiten dari D1

Contoh kontrak:

- Path: `GET /emiten`
- Query (opsional):
  - `status=ACTIVE` (default)
  - `q=BBR` untuk search by ticker / nama sebagian.
  - `sector=Financial Services` (opsional filter).

**Response (sketsa)**

```json
{
  "data": [
    {
      "ticker": "BBRI.JK",
      "name": "Bank Rakyat Indonesia Tbk",
      "sector": "Financial Services",
      "industry": "Banks - Regional",
      "status": "ACTIVE"
    }
  ],
  "meta": {
    "count": 1
  }
}
```

### 5.2. Endpoint 2: Trigger Sync via idx-handler (Opsional/Admin)

Alih-alih langsung memanggil IDX dari `api-saham`, desain ini mendorong semua logic sync ke `idx-handler`.

- Path: `POST /admin/emiten/sync`
- Behaviour:
  - `api-saham` meneruskan request ke `idx-handler` (`/internal/idx/sync-emiten`).
  - Endpoint ini bisa dibatasi hanya untuk admin (misalnya dengan header secret atau IP allowlist).

**Response**: meneruskan ringkasan dari `idx-handler` (lihat 4.2.1).

---

## 6. Scheduling & Operasional

### 6.1. Cron Harian

- Cron Cloudflare (misal di `idx-handler`):
  - Jadwal: Setiap hari, setelah jam bursa selesai (misal 18:00 WIB).
  - Aksi: Memanggil handler internal yang menjalankan proses sync (tanpa HTTP publik).

### 6.2. Observability

- Logging ringkas per run:
  - `synced_at`, `inserted`, `updated`, `total_idx`.
- (Opsional) Menulis catatan ke tabel D1 terpisah / log R2 jika perlu jejak historis.

---

## 7. Edge Cases & Risiko

1. **Perubahan Struktur Response IDX**  
   - Mitigasi: Parsing defensif (cek keberadaan field sebelum pakai) dan logging error yang jelas.
2. **Ticker dihapus / delisting**  
   - Untuk v1: tidak menghapus baris; `status` bisa di-update jika IDX menyediakan indikatornya. Strategi penghapusan penuh bisa didesain kemudian.
3. **Sector/Industry Tidak Konsisten**  
   - Dibiarkan `NULL` sampai ada proses repair / enrichment lain. Sync ini **tidak memblokir** IPO hanya karena metadata belum lengkap.
4. **Rate Limit / Downtime IDX**  
   - Cron bisa retry otomatis; jika gagal total, tidak mengubah D1 (last known good state tetap dipakai oleh `api-saham`).

---

## 8. Acceptance Criteria

1. **IPO Tertangkap Otomatis**  
   - Jika IDX menambahkan ticker baru, **paling lambat H+1** setelah cron berjalan, baris baru muncul di tabel `emiten` D1.
2. **Endpoint `GET /emiten` di api-saham**  
   - Mengembalikan daftar emiten yang konsisten dengan tabel D1 (minimal kolom `ticker`, `sector`, `industry`, `status`).
3. **Tidak Mengganggu Worker Lain**  
   - Penambahan `idx-handler` dan endpoint baru tidak mengubah perilaku endpoint existing (`/symbol`, `/footprint-raw-hist`, dll.).
4. **Operasional Jelas**  
   - Ada cara yang terdokumentasi untuk: menjalankan sync manual, melihat ringkasan hasil sync, dan memonitor kegagalan.

---

## 9. Pairing

- Worker baru: `workers/idx-handler` (akan berisi implementasi endpoint internal dan cron untuk sync emiten).
- Worker existing: `workers/api-saham` (akan menambahkan endpoint `/emiten` dan `/admin/emiten/sync`).
- Database: D1 `SSSAHAM_DB` (tabel `emiten`).
