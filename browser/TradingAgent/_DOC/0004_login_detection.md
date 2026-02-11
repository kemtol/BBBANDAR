# Login Detection & Agent Readiness

## 1. Tujuan & Lingkup
- Menetapkan mekanisme tunggal untuk mendeteksi status login broker.
- Menjamin pane kanan hanya mengaktifkan kontrol agen ketika broker siap.
- MVP berfokus pada IPOT; broker lain mengikuti pola yang sama.

## 2. Event Flow
1. Warm-up selesai di main process.
2. Main → Preload: `warmup-ready` (via `webContents.send`).
3. Preload memulai polling status login sesuai adapter broker aktif.
4. Preload → Main: `broker-login-state` (IPC async) saat status berubah.
5. Main → Pane kanan: `broker-login-state` untuk update UI.
6. Pane kanan menyalakan/mematikan tombol Start Agent dan indikator koneksi.

```
┌────────┐      warmup-ready      ┌────────────┐     broker-login-state     ┌──────────┐
│  Main  │ ─────────────────────▶ │ Preload L  │ ─────────────────────────▶ │  Renderer│
└────────┘                        └────────────┘                            └──────────┘
          ▲                         │                    │                        │
          │                         └─ polling token ────┘                        │
          │                                                                    UI updates
          └──────── broker-login-state (relay) ◀──────────────────────────────────┘
```

## 3. Adapter-Specific Logic

### IPOT (MVP)
- Sumber kebenaran utama: `window.localStorage.getItem('appsession')`.
  - Dianggap valid jika string panjangnya ≥ 20.
- Fallback: cek cookie `cookie_user` jika diperlukan.
- Polling dilakukan setiap 4 detik setelah warm-up.
- Log format:
  - `[LISTEN LOGIN IPOT] Waiting user to login`
  - `[LISTEN LOGIN IPOT] Login detected. Bot disable agent start button OFF`
- Status hanya dikirim ketika terjadi perubahan (menghindari spam event).

### Broker Lain (template)
- Stockbit / Ajaib / Mirae: TBD.
  - Gunakan modul terpisah dengan pengecekan storage/cookie masing-masing.
  - Pastikan tidak mengirim data sensitif.

## 4. Payload IPC
| Field    | Tipe   | Keterangan                    |
|----------|--------|--------------------------------|
| broker   | string | e.g. `"ipot"`                 |
| loggedIn | bool   | `true` bila user login         |
| ts       | number | Timestamp (ms) pengiriman event|

## 5. Keamanan & Konsiderasi
- Tidak ada token/kredensial yang dikirim ke renderer kanan.
- Polling dilakukan di preload (sandboxed, context isolation tetap aktif).
- Periksa error akses storage dengan try–catch (IPOT bisa menolak akses).
- Pastikan event tidak bocor ke browser preview (check `typeof require`).

## 6. TODO Berikutnya
- Implementasi adapter login detection untuk broker lain.
- Unit/integration test dengan mock `localStorage`.
- Tambahkan toast/notification di UI untuk transisi status.
- Pertimbangkan debounce tambahan saat status berfluktuasi.
