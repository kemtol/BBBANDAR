# Orderflow Scanner Methodology & Integrity Checklist

Dokumen ini merinci metodologi penentuan sinyal orderflow serta checklist integritas data yang diperlukan untuk menjaga akurasi sistem.

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
`ABS(CVD) = abs(delta_pct) / (1 + abs(price_pct))`

- **Skor Tinggi**: Menunjukkan adanya anomali volume (CVD) yang tidak sebanding dengan pergerakan harga (Divergensi).
- **Arah (Label)**:
    - Jika `deltaPct > 0` -> **Breakout**.
    - Jika `deltaPct < 0` -> **Heavy Sell**.

**Integrasi CVD**:
- **Intraday (Live)**: Represented by `deltaPct` (Net Delta akumulatif sesi berjalan).
- **Historical (D-1 Context)**: Represented by `ctx_net` / `z_ngr` (Z-score flow akumulatif kemarin dari D1).

---

## 3. Pengolahan & Penyaringan Data

### A. Komponen Data Utama
1. **Raw Data (Broksum)**: R2 `RAW_BROKSUM/{ticker}/{date}.json`
2. **Historical Features (Trailing)**: R2 `SSSAHAM_EMITEN/features/z_score/emiten/{ticker}.json`
3. **Daily Features**: D1 `daily_features` & R2 `features/z_score/daily/{date}.json`

### B. Proses Analisis
- **JOIN Pipeline**: Menggabungkan data intraday (Raw) dengan Context (Daily Features D-1).
- **Velocity Score**: Fokus pengembangan berikutnya untuk mengukur kecepatan Delta masuk dalam 1 jam terakhir.

---

## 4. Data Integrity Checklist

| Jalur | Komponen | Cek Cepat | Gagal Jika |
| :--- | :--- | :--- | :--- |
| **A. Daily** | Raw Per Ticker | HEAD check untuk `{date}` | Job skip/no update |
| **A. Daily** | Trailing History | Cek `history.length >= 20` | State tidak stabil |
| **B. Intraday** | Footprint Table | `SELECT COUNT(*)` for `{date}` | Hasil `0 items` |
| **B. Intraday** | Context (D-1) | `SELECT MAX(date) < {date}` | `ctx_found=false` |

> [!IMPORTANT]
> Indikator **🚀 Breakout** akan muncul di UI jika `divScore > 5` dan `deltaPct > 2%`.
