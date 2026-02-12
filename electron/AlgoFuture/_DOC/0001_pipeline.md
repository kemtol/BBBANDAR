# PRODUCT REQUIREMENTS DOCUMENT (PRD)

**Project Name:** Algo-One Trading Agent (Desktop)
**Version:** 1.0 (MVP Scope)
**Status:** In-Development
**Owner:** Kemal
**Platform:** Electron (Desktop - Windows/ThinkPad)

---

## 1. Executive Summary

**Background:**
Trader ritel seringkali kalah cepat dibandingkan institusi dalam mendeteksi anomali pasar (seperti ledakan volume atau HAKA masif). Mata manusia memiliki keterbatasan dalam memproses ribuan data transaksi per detik (*Time & Sales*), dan emosi sering mengganggu eksekusi disiplin (*Take Profit/Cut Loss*).

**Objective:**
Membangun aplikasi desktop berbasis **Electron** yang berfungsi sebagai sistem **Fully Automated Scalping Trading**. Aplikasi ini berjalan sebagai "Sidecar" cerdas yang menyatu dengan web sekuritas untuk melakukan *sniffing* data pasar secara real-time, menganalisanya secara instan, dan melakukan eksekusi tanpa intervensi manusia. **Waktu eksekusi (latency) adalah parameter paling kritis** dalam sistem ini untuk mendapatkan harga terbaik di pasar yang bergerak cepat.

---

## 2. Target Persona & User Story

**User Profile:**
* **Name:** Kemal (40th, Developer & Trader).
* **Style:** Scalper & Day Trader.
* **Needs:** Kecepatan, Data Kuantitatif (Bukan Feeling), dan Manajemen Risiko Otomatis.

**User Story:**
> *"Sebagai seorang Scalper, saya ingin bot saya mendeteksi saham yang sedang 'Panic Buying' (Z-Score tinggi) dalam hitungan milidetik, sehingga saya bisa masuk di awal momentum dan keluar otomatis saat target profit 2% tercapai tanpa melibatkan emosi."*

---

## 3. Scope & Features (MVP)

### A. Core Architecture (The "Parasitic" System)

1. **Dual-Pane Interface:**
    * **Pane Kiri (Host):** BrowserView yang memuat web sekuritas (IPOT/Stockbit/Ajaib) secara *native*. Login dilakukan manual oleh user (Zero-Credential Storage).
    * **Pane Kanan (Agent):** Dashboard kontrol untuk monitoring sinyal, konfigurasi strategi, dan log eksekusi.

2. **Data Ingestion (Sniffing):**
    * Mekanisme *WebSocket Hooking* untuk menyadap aliran data *Running Trade* dari Pane Kiri.
    * Parser data universal (JSON) untuk menormalisasi format data dari berbagai broker.

### B. Strategy Engine (The "Brain")

| Strategy Name | Logic Trigger (Entry) | Parameter Kunci (Configurable) |
| --- | --- | --- |
| **Bekti Sutikna (Burst)** | Deteksi frekuensi transaksi tinggi yang tidak wajar (*Statistical Anomaly*). | • **Burst Threshold:** Min. transaksi (misal: 15x).<br>• **Time Window:** Durasi pantau (misal: 3 detik).<br>• **Z-Score:** Tingkat anomali (misal: > 2.5σ). |
| **John Wijaya (Whale)** | Deteksi transaksi tunggal dengan nilai Jumbo yang memakan Offer (*HAKA*). | • **Min Value:** Min. Rupiah per trade (misal: Rp 500jt).<br>• **Action:** Buy Only / Sell Only.<br>• **Price Action:** Harga harus naik/tetap. |
| **Custom Strategy** | User dapat menyimpan kombinasi parameter di atas sebagai preset baru. | • Nama Strategi (String). |

### C. Risk Management System (The "Shield")

1. **Take Profit (TP):** Target profit dalam % (misal: 2.0%).
2. **Stop Loss (SL):** Batas kerugian dalam % (misal: -2.0%).
3. **Capital Allocation:** Input manual modal maksimal per trade (misal: Rp 5.000.000).
4. **Trailing Stop (Future):** Menggeser SL mengikuti kenaikan harga (Opsional di MVP).

### D. Execution & Testing

1. **Blackbox Mode (Simulation):** Bot berjalan seolah-olah trading dengan uang virtual. Mencatat P/L di log tanpa mengirim order ke sekuritas.
2. **Live Execution (Phase 2):** Bot mengisi form order di DOM Pane Kiri dan melakukan klik tombol "Buy/Sell" secara otomatis.

---

## 4. UI/UX Requirements

**Design Philosophy:** *Dark Mode, High Contrast, Dense Information.*

1. **Header:**
    * Status Koneksi ke Broker (Connected/Disconnected).
    * Broker Selector Dropdown.

2. **Left Column (Controls):**
    * Dropdown Preset Strategy.
    * Dynamic Form (Inputan berubah sesuai strategi).
    * Tombol "Save Preset".

3. **Right Column (Risk & Action):**
    * Input TP, SL, Allocation.
    * Tombol Besar: **START AGENT / STOP AGENT**.
    * Summary Panel (Strategi Aktif & Profil Risiko).

4. **Feedback System:**
    * Log Console: Menampilkan teks real-time ("Processing data...", "Signal Detected!").
    * Visual Indicators: Warna Hijau untuk Profit/Win, Merah untuk Loss.

---

## 5. Technical Constraints & Non-Functional Req.

1. **Latency:** Waktu pemrosesan dari data diterima hingga keputusan (Signal) harus **< 50ms**.
2. **Memory Management:** Menggunakan *Circular Buffer* untuk data history agar aplikasi tidak berat (*Memory Leak prevention*).
3. **Security:**
    * Aplikasi **TIDAK BOLEH** menyimpan username/password sekuritas.
    * Aplikasi **TIDAK BOLEH** mengirim data trade user ke server eksternal manapun.
4. **Compatibility:** Dioptimalkan untuk OS Windows (ThinkPad User) dan Chromium engine terbaru.

---

## 6. Roadmap & Phasing

### Phase 1: The "Watcher" (Current MVP) ✅
* [x] Basic Electron Shell (Kiri/Kanan).
* [x] WebSocket Sniffing Logic.
* [x] Z-Score & Whale Calculation Logic.
* [x] UI Dashboard & Config Saver.
* [ ] **Test:** Verifikasi data *Running Trade* di log sesuai dengan layar sekuritas.

### Phase 2: The "Simulator" (Next Week)
* [ ] Implementasi fitur *Blackbox Testing* (Uang Virtual).
* [ ] Fitur *Compounding Balance* di simulator.
* [ ] Uji coba ketahanan strategi (7-Day Challenge).

### Phase 3: The "Executor" (High Risk)
* [ ] Mapping DOM Selector (ID tombol Buy/Sell) untuk IPOT & Stockbit.
* [ ] Script Auto-Click & Auto-Fill Form.
* [ ] Mekanisme *Kill Switch* (Tombol darurat untuk stop semua aktivitas).

---

## 7. Success Metrics (KPI)

1. **Akurasi Data:** Sinyal "Whale Detected" di aplikasi muncul bersamaan (atau lebih cepat) dari mata melihat di layar.
2. **Stabilitas:** Aplikasi berjalan nonstop selama jam bursa (09:00 - 16:00) tanpa *crash* atau *freeze*.
3. **Profitabilitas (Simulasi):** Mode Blackbox menghasilkan *Win Rate* > 60% dengan *Drawdown* < 5% dalam pengujian 1 minggu.
