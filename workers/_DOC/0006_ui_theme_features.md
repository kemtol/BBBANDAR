# UI Theme Feature — Bloomberg/Dark Mode Rollout

> **Document Version**: 0.1  
> **Created**: 2024-03-XX  
> **Last Updated**: 2024-03-XX  
> **Author**: Copilot + mkemalw

---

## 1. Executive Summary

Inisiatif ini bertujuan menambahkan tema gelap bergaya Bloomberg ("Bloomberg-style dark") ke web app tanpa mengganggu pengalaman tema terang eksisting. Implementasi dimulai secara terbatas di halaman `broker-summary.html` sebagai pilot, sebelum diperluas ke seluruh situs.

---

## 2. Objectives & Success Criteria

| Tujuan | Kriteria Sukses |
|--------|-----------------|
| Menyediakan versi dark theme yang konsisten | Halaman `broker-summary.html` dapat dirender penuh dengan palet warna baru tanpa regresi layout |
| Menjaga kompatibilitas tema lama | Pengguna / QA dapat kembali ke tema terang hanya dengan mengubah atribut root (`data-theme="light"`) |
| Mempersiapkan rollout global | Seluruh warna utama diisolasi dalam CSS variables sehingga mudah diterapkan ke halaman lain |

---

## 3. Scope

### 3.1 In-Scope (Sprint 1)
- Refactor warna pada `broker-summary.html` agar menggunakan CSS variables.
- Menambahkan deklarasi CSS variables untuk tema terang dan tema Bloomberg-style dark.
- Menyediakan toggle manual (dev/QA only) untuk mengganti `data-theme` pada root.
- Dokumentasi QA checklist untuk memverifikasi kontras dan keterbacaan.

### 3.2 Out-of-Scope (Sprint 1)
- Integrasi toggle tema ke seluruh UI / user settings.
- Update ikon/grafik khusus dark mode (akan dilakukan setelah pilot sukses).
- Penanganan tema di halaman lain selain `broker-summary.html`.

---

## 4. Design Guidelines

### 4.1 Palet Bloomberg-Style Dark (Draft)

| Token | Nilai | Penggunaan |
|-------|-------|------------|
| `--color-bg-primary` | `#0B0B0E` | Latar utama halaman |
| `--color-bg-secondary` | `#14141A` | Komponen sekunder / kartu |
| `--color-surface-elevated` | `#1F1F26` | Panel terangkat / modals |
| `--color-border-muted` | `#2A2A33` | Garis pembatas halus |
| `--color-text-primary` | `#F5F5F7` | Teks utama |
| `--color-text-secondary` | `#C3C3CD` | Subheading, metadata |
| `--color-text-invert` | `#0B0B0E` | Teks di atas accent |
| `--color-accent-primary` | `#F2A900` | Highlight utama (Bloomberg yellow) |
| `--color-accent-positive` | `#4ECB71` | Value positif |
| `--color-accent-negative` | `#FF5252` | Value negatif |
| `--color-chart-grid` | `#2B2B33` | Grid chart / tabel |
| `--shadow-elevated` | `0 8px 16px rgba(0, 0, 0, 0.35)` | Shadow kartu |

> **Catatan**: Nilai dapat diiterasi setelah review design/QA. Fokus awal pada kontras AA minimum (4.5:1).

### 4.2 Tipografi & Komponen
- Gunakan font keluarga yang sama dengan tema terang; hanya warna yang berubah.
- Tombol dan badge menggunakan accent primary, dengan teks invert untuk keterbacaan.
- Tabel menggunakan `--color-bg-secondary` untuk header dan zebra stripes dengan opacity 4%.
- Grafik: pastikan library chart mendukung override warna grid/axis menggunakan variable baru.

---

## 5. Architecture & Implementation Plan

### 5.1 Struktur CSS Variables

```css
:root[data-theme="light"] {
  /* existing light palette */
}

:root[data-theme="dark"] {
  /* bloomberg palette from section 4.1 */
}
```

- File sumber: `theme.css` atau stylesheet global serupa.
- Halaman yang belum dimigrasi tetap fallback ke `data-theme="light"`.
- Semua komponen di `broker-summary.html` harus membaca warna via `var(--color-*)`.

### 5.2 Langkah Teknis

1. **Audit warna**: kumpulkan semua warna hard-coded di `broker-summary.html` dan stylesheet terkait.
2. **Deklarasi variabel**: tambahkan mapping warna existing ke tema light di `theme.css`.
3. **Refactor halaman**: ganti seluruh referensi warna di halaman pilot dengan CSS variables.
4. **Tambahkan tema dark**: isi blok `:root[data-theme="dark"]` dengan palet Bloomberg-style.
5. **Aktifkan uji coba**: set `data-theme="dark"` pada `<body>` di `broker-summary.html` (opsional via query param / toggle script untuk QA).
6. **Regression test**: jalankan QA checklist (tabel, grafik, cards, tooltip, alerts, responsivitas).

### 5.3 Toggle Mekanisme (Pilot)
- Tambahkan script ringan di `broker-summary.html`:
  - Toggle button dev-only (mis. `Shift + D`) untuk switch antara `light` ↔ `dark`.
  - Simpan preferensi sementara di `localStorage` (`ui:theme`).
- Untuk rollout penuh, rencanakan integrasi ke global header / user settings.

### 5.4 QA Checklist

| Item | Detail |
|------|--------|
| Kontras teks utama | Gunakan `--color-text-primary` vs `--color-bg-primary` ≥ 4.5:1 |
| Tabel zebra & hover | Pastikan baris ter-highlight tanpa mengubah teks jadi tidak terbaca |
| Kartu statistik | Periksa warna positif/negatif terhadap latar sekunder |
| Grafik & grid | Axis, gridline, dan label mengikuti palet baru |
| Responsivitas | Periksa breakpoints utama (mobile, tablet, desktop) |
| Toggle persistensi | Pastikan reload halaman mempertahankan tema terakhir |

---

## 6. Rollout Strategy

1. **Pilot (Week 1)** — Terapkan tema dark di `broker-summary.html`, QA internal.
2. **Stabilization (Week 2)** — Fix bug visual, kumpulkan feedback pengguna internal.
3. **Expansion (Week 3+)** — Migrasi bertahap ke halaman lain (prioritas: dashboard, index, berita).
4. **Global Toggle** — Implement switch tema di header + penyimpanan preferensi user.

---

## 7. Risk & Mitigation

| Risiko | Dampak | Mitigasi |
|--------|--------|----------|
| Warna chart tidak sinkron | Grafik sulit dibaca | Audit konfigurasi chart library, expose variable untuk axis/series |
| Penurunan aksesibilitas | Pengguna tidak dapat membaca teks | QA fokus pada WCAG AA, gunakan tooling (Lighthouse/axe) |
| Inconsistent component styling | Layout tidak konsisten antar halaman | Buat guideline variables + checklist, migrasi komponen shared terlebih dahulu |
| Perf regression karena toggle JS | Interaksi terasa lambat | Keep toggle script minimal, hanya set atribut root dan simpan preferensi |

---

## 8. Next Steps

1. Validasi daftar warna dengan tim desain / stakeholder.
2. Update `theme.css` dengan struktur variable baru.
3. Lakukan refactor `broker-summary.html` sesuai plan.
4. Siapkan script toggle pilot dan QA instructions.
5. Revisi dokumentasi ini setelah pilot selesai (naikkan `Document Version`).
