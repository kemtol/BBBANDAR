# 0015 — Shareholder Confluence

> **Status:** `In Development`  
> **Owner:** mkemalw  
> **Updated:** 2026-04-05  
> **File:** `workers/app-sssaham/public/idx/emiten/shareholder.html`

---

## 1. Objective

Mendeteksi **jumlah pemegang saham** dan korelasinya terhadap **pergerakan harga saham** sebagai sinyal fase pasar.

Hipotesis utama:
- Harga naik + Jumlah pemegang turun → **AKUMULASI** (smart money mengkonsolidasi kepemilikan)
- Harga turun + Jumlah pemegang naik → **DISTRIBUSI** (smart money membagi kepemilikan ke retail)

---

## 2. Page Architecture

### 2.1 Index Page (`shareholder.html`)

Menampilkan seluruh emiten dalam daftar dengan:
- Logo, simbol, nama emiten, sektor
- Type badges (Pemerintah, Fin. Inst., Corporate, Individual, Mutual Fund)
- Coverage bar (total % kepemilikan yang terdeteksi)
- **[NEW] Phase badge per emiten** (Akumulasi / Distribusi / Momentum / Bearish)
- **[NEW] Filter berdasarkan fase**
- Search by nama / simbol

### 2.2 Detail Page (`shareholder.html?symbol=BBRI`)

Menampilkan breakdown lengkap satu emiten:
- Emiten header (logo, nama, sektor)
- Stat cards (total pemegang, coverage, asing, pemerintah)
- **[NEW] Trend mini-cards:** Δ Harga 30d, Δ Shareholder 30d, Korelasi Index
- **[NEW] Phase banner:** label AKUMULASI / DISTRIBUSI / MOMENTUM / BEARISH CAPITULATION
- **[NEW] Dual-axis chart:** Harga (kanan-axis) + Jumlah Pemegang (kiri-axis) overlay
- Donut chart komposisi tipe pemegang
- Tabel daftar pemegang saham (ranked, dengan kepemilikan %)

---

## 3. Phase Detection Logic

Penentuan fase menggunakan window **30 calendar days** terakhir:

```
trend_price      = slope(close_prices, 30d) → positif / negatif
trend_sh_count   = slope(shareholder_counts, 30d) → positif / negatif
```

| `trend_price` | `trend_sh_count` | Fase                   | Warna  | Sinyal  |
|:---:|:---:|:---|:---:|:---:|
| ↑ positif | ↓ negatif | **AKUMULASI**              | 🟢 Hijau   | Bullish |
| ↓ negatif | ↑ positif | **DISTRIBUSI**             | 🔴 Merah   | Bearish |
| ↑ positif | ↑ positif | **MOMENTUM**               | 🟡 Kuning  | Netral  |
| ↓ negatif | ↓ negatif | **BEARISH CAPITULATION**   | 🟠 Oranye  | Watch   |
| flat      | flat      | **KONSOLIDASI**            | ⚪ Abu-abu | Netral  |

**Threshold slope "flat":** perubahan < 0.5% dalam 30 hari dianggap flat/sideways.

---

## 4. Dual-Axis Chart Spec

Library: **TradingView Lightweight Charts v4.x**

| Parameter | Spesifikasi |
|---|---|
| Series kiri | Line series — Jumlah pemegang saham (count) |
| Series kanan | Candlestick atau Line series — Harga penutupan (Rp) |
| Range | Default: 90 hari terakhir |
| Warna harga | Candlestick: hijau/merah standar |
| Warna sh count | Dashed line `#a78bfa` (ungu) |
| Crosshair | Mode Normal, tooltip menampilkan kedua nilai |
| Background | Transparan |
| Grid | Disembunyikan (`visible: false`) |
| Responsive | Height 260px desktop, 200px mobile |

---

## 5. Data Contract (Future API)

Endpoint yang diharapkan dari backend (belum tersedia, saat ini dummy):

```
GET /api/shareholder/history?symbol=BBRI&days=90
Response:
{
  "symbol": "BBRI",
  "data": [
    { "date": "2025-01-01", "shareholder_count": 142823, "price_close": 5200 },
    ...
  ]
}
```

---

## 6. Test Cases

### TC-001: Index Page Load
| # | Skenario | Expected Result |
|---|---|---|
| 1.1 | Buka `shareholder.html` tanpa query param | Tampil Index view, bukan Detail |
| 1.2 | Index menampilkan minimal 1 emiten | List tidak kosong |
| 1.3 | Search "BBRI" | Hanya BBRI yang muncul |
| 1.4 | Search string tidak cocok ("ZZZY") | Tampil pesan "Emiten tidak ditemukan" |
| 1.5 | Klik card emiten | Redirect ke `?symbol=<SIMBOL>` |
| 1.6 | Setiap emiten memiliki Phase badge | Badge tidak boleh kosong/undefined |
| 1.7 | Filter "Akumulasi" | Hanya emiten dengan fase Akumulasi tampil |

### TC-002: Detail Page Load
| # | Skenario | Expected Result |
|---|---|---|
| 2.1 | Buka `shareholder.html?symbol=BBRI` | Tampil Detail view untuk BBRI |
| 2.2 | Symbol tidak valid (`?symbol=XXXX`) | Tampil pesan error "Emiten tidak ditemukan" |
| 2.3 | Stat cards terisi lengkap | Tidak ada nilai `—` atau `NaN` |
| 2.4 | Donut chart ter-render | Donut chart visible dengan warna masing-masing tipe |
| 2.5 | Tabel pemegang ter-render | Minimal 1 baris, diurutkan dari terbesar |
| 2.6 | Phase banner tampil | Banner dengan label + warna fase yang sesuai |

### TC-003: Dual-Axis Chart
| # | Skenario | Expected Result |
|---|---|---|
| 3.1 | Chart container ter-render | `#detail-chart-container` tidak bertinggi 0 |
| 3.2 | Kedua series tampil | Line shareholder count (kiri) + harga (kanan) visible |
| 3.3 | Toggle Candlestick | Series harga berubah ke candlestick |
| 3.4 | Toggle Line | Series harga berubah ke line chart |
| 3.5 | Crosshair menampilkan kedua nilai | Hovering di chart: tooltip menampilkan Harga + Jumlah Pemegang |
| 3.6 | Chart responsive | Di layar < 576px, tinggi berubah ke 200px |

### TC-004: Phase Detection
| # | Skenario Input (Dummy) | Expected Phase |
|---|---|---|
| 4.1 | Harga +15% dalam 30d, SH count -8% | AKUMULASI |
| 4.2 | Harga -12% dalam 30d, SH count +20% | DISTRIBUSI |
| 4.3 | Harga +10% dalam 30d, SH count +5% | MOMENTUM |
| 4.4 | Harga -5% dalam 30d, SH count -3% | BEARISH CAPITULATION |
| 4.5 | Harga perubahan < 0.5%, SH count flat | KONSOLIDASI |

### TC-005: Trend Mini-Cards
| # | Skenario | Expected Result |
|---|---|---|
| 5.1 | Δ Harga 30d positif | Tampil nilai hijau dengan prefix "+" |
| 5.2 | Δ Harga 30d negatif | Tampil nilai merah dengan prefix "−" |
| 5.3 | Δ SH Count 30d | Menampilkan delta count dan delta % |

### TC-006: Responsiveness
| # | Viewport | Expected |
|---|---|---|
| 6.1 | Desktop (> 992px) | Semua kolom tabel visible |
| 6.2 | Tablet (576–992px) | Kolom bar dan holdings disembunyikan |
| 6.3 | Mobile (< 576px) | Chart lebih pendek, kolom irrelevant hidden |

---

## 7. Acceptance Criteria

### AC-001: Index View
- [ ] Menampilkan list semua emiten dengan simbol, nama, sektor, type badges, dan coverage bar
- [ ] Setiap emiten menampilkan **Phase Badge** (min. salah satu: Akumulasi / Distribusi / Momentum / Bearish Capitulation / Konsolidasi)
- [ ] Fitur search berfungsi real-time (filter tanpa page reload)
- [ ] Klik emiten card navigates ke detail page dengan `?symbol=` yang benar
- [ ] Halaman responsif di mobile

### AC-002: Detail View
- [ ] Header emiten (logo, simbol, nama, sektor) tampil lengkap
- [ ] Stat cards menampilkan: total pemegang, total coverage %, % asing, % pemerintah
- [ ] **Phase banner** tampil dengan warna & label yang sesuai logika fase
- [ ] **Trend mini-cards** menampilkan Δ Harga 30d dan Δ Shareholder Count 30d
- [ ] Donut chart komposisi ter-render dengan benar
- [ ] Tabel pemegang diurutkan dari kepemilikan terbesar ke terkecil
- [ ] Progress bar di tabel proporsional terhadap pemegang terbesar

### AC-003: Dual-Axis Chart
- [ ] Chart menggunakan TradingView Lightweight Charts
- [ ] **Dua series wajib:** harga saham (kanan-axis) + jumlah pemegang (kiri-axis)
- [ ] Toggle Candlestick / Line berfungsi tanpa me-reload chart
- [ ] Crosshair menampilkan nilai dari **kedua series** secara bersamaan
- [ ] Chart background transparan, grid tersembunyi
- [ ] Chart responsive (200px di mobile)

### AC-004: Phase Detection
- [ ] Fase ditentukan berdasarkan slope harga 30d vs slope shareholder count 30d
- [ ] Hasil fase konsisten antara Index badge dan Detail banner untuk emiten yang sama
- [ ] Threshold "flat" (< 0.5%) diterapkan sebelum menentukan arah trend

---

## 8. Out of Scope (v1)

- Integrasi data real dari API backend (saat ini dummy)
- Notifikasi / alert saat emiten berpindah fase
- Historical fase (riwayat perubahan fase dari waktu ke waktu)
- Backtesting akurasi sinyal akumulasi/distribusi
