# Login Detection & Agent Readiness

## 1. Tujuan & Lingkup
- Menetapkan mekanisme tunggal untuk mendeteksi status login broker.
- Menjamin pane kanan hanya mengaktifkan kontrol agen ketika broker siap.
- MVP berfokus pada IPOT; broker lain mengikuti pola yang sama.

## 2. Event Flow
1. Warm-up selesai di main process.
2. Main → Preload: `warmup-ready` (via `webContents.send`).
3. Preload memulai monitoring WebSocket untuk mendeteksi login.
4. Preload → Main: `broker-login-state` (IPC async) saat status berubah.
5. Main → Pane kanan: `broker-login-state` untuk update UI.
6. Pane kanan menyalakan/mematikan tombol Start Agent dan indikator koneksi.

```
┌────────┐      warmup-ready      ┌────────────┐     broker-login-state     ┌──────────┐
│  Main  │ ─────────────────────▶ │ Preload L  │ ─────────────────────────▶ │  Renderer│
└────────┘                        └────────────┘                            └──────────┘
          ▲                         │                    │                        │
          │                         └─ WS intercept ─────┘                        │
          │                                                                    UI updates
          └──────── broker-login-state (relay) ◀──────────────────────────────────┘
```

---

## 3. Adapter-Specific Logic

### IPOT (MVP) – Detail Lengkap

#### 3.1 Mekanisme Deteksi Login

IPOT menggunakan **dua layer** deteksi untuk memastikan login benar-benar valid:

| Layer | Metode | Keterangan |
|-------|--------|------------|
| 1. Early Hint | `localStorage.appsession` | Token muncul setelah form login, tapi belum tentu server mengakui |
| 2. Confirm | WebSocket response `MYACCOUNT` | Server sudah mengakui sesi, data akun dikembalikan |

**Layer 2 (WebSocket) adalah sumber kebenaran utama.**

#### 3.2 WebSocket Request–Response Pattern

**Request (client → server):**
```json
{
  "event": "cmd",
  "data": {
    "cmdid": 124,
    "param": {
      "service": "porto",
      "cmd": "MYACCOUNT",
      "param": {}
    }
  },
  "cid": 126
}
```

**Response (server → client):**
```json
{
  "rid": 126,
  "data": {
    "status": "OK",
    "data": {
      "lid": "KEMTOL",
      "name": "...",
      "custcode": ["R10000195903", ...],
      "main": "R10000195903",
      "accinfo": { ... },
      "custinfo": { ... }
    }
  }
}
```

**Catatan Penting:**
- Field `cid` di request = `rid` di response (pasangan request-response).
- Login dianggap sukses jika `status === "OK"` dan `data.lid` ada.
- Data sensitif (nama, custcode, limit) **TIDAK BOLEH** di-log atau dikirim ke UI.

#### 3.3 Implementasi di Preload

```
┌─────────────────────────────────────────────────────────────────┐
│                        PRELOAD.JS                               │
├─────────────────────────────────────────────────────────────────┤
│  0. Warm-up Ready Handler                                       │
│     └─ Terima `warmup-ready` dari main                          │
│     └─ Tandai `isWarmupActive = true` (hindari listen prematur) │
│                                                                 │
│  1. Hook WebSocket constructor                                  │
│     └─ Intercept setiap instance WebSocket baru                 │
│                                                                 │
│  2. Hook WebSocket.send()                                       │
│     └─ Parse payload keluar                                     │
│     └─ Jika event="cmd" & ada cid:                              │
│        requestMap.set(cid, { service, cmd, isSubscribe, ts })   │
│                                                                 │
│  3. Hook WebSocket.onmessage / addEventListener('message')      │
│     └─ Parse payload masuk                                      │
│     └─ Jika ada rid & requestMap.has(rid):                      │
│        └─ Ambil metadata { service, cmd }                       │
│        └─ Jika service="porto" & cmd="MYACCOUNT" & status="OK": │
│           └─ Trigger login confirm (lihat 3.5)                  │
│        └─ Hapus entry dari requestMap                           │
│                                                                 │
│  4. Optional: monitor stream subscribe                          │
│     └─ Misal `CASHPOS`, `TRADE` (fitur lanjutan)                │
│                                                                 │
│  5. Cleanup saat beforeunload                                   │
└─────────────────────────────────────────────────────────────────┘
```

#### 3.4 Log Format

| Event | Log Message |
|-------|-------------|
| Warmup ready | `[LISTEN LOGIN IPOT] Waiting user to login` |
| Request MYACCOUNT | `[LISTEN LOGIN IPOT] Tracking request: service=porto cmd=MYACCOUNT cid=###` |
| MYACCOUNT OK | `[LISTEN LOGIN IPOT] Login confirmed via MYACCOUNT` |
| Logout/Reset | `[LISTEN LOGIN IPOT] Session ended` |
| WS Error | `[LISTEN LOGIN IPOT] WebSocket error: ...` |

#### 3.5 Integrasi IPC

Ketika respons `MYACCOUNT` sukses dikonfirmasi:

```js
ipcRenderer.send('broker-login-state', {
  broker: 'ipot',
  loggedIn: true,
  source: 'MYACCOUNT',
  ts: Date.now()
});
```

Main process meneruskan payload ke pane kanan (`win.getBrowserViews()[1]`). Renderer kanan memperbarui indikator koneksi menjadi **Connected Ready** dan mengaktifkan tombol START.

#### 3.6 Payload IPC

| Field    | Tipe   | Keterangan                              |
|----------|--------|-----------------------------------------|
| broker   | string | `"ipot"`                                |
| loggedIn | bool   | `true` bila MYACCOUNT sukses            |
| source   | string | `"MYACCOUNT"` (untuk traceability)      |
| ts       | number | Timestamp (ms) pengiriman event         |

#### 3.7 Fallback & Edge Cases

| Kondisi | Handling |
|---------|----------|
| WebSocket disconnect | Reset status, tunggu reconnect, bersihkan requestMap |
| Token `appsession` hilang | Kirim `loggedIn: false` |
| Multiple MYACCOUNT response | Hanya proses pertama; abaikan duplikat |
| Request timeout (no response) | Bersihkan requestMap setelah TTL (30s) |
| Format payload berubah | Log warning, fallback ke layer 1 (appsession) |

---

### Broker Lain (Template)

#### Stockbit
- **Status:** TBD
- **Endpoint:** TBD
- **Login Indicator:** TBD

#### Ajaib
- **Status:** TBD
- **Endpoint:** TBD
- **Login Indicator:** TBD

#### Mirae
- **Status:** TBD
- **Endpoint:** TBD
- **Login Indicator:** TBD

---

## 4. Keamanan & Konsiderasi

### Data Sensitif
- **JANGAN** log/simpan: nama lengkap, custcode, credit limit, saldo.
- **BOLEH** log: status boolean, service/cmd name, timestamp.
- Mask data jika perlu debugging: `custcode: "R100...903"`.

### Isolasi
- Preload tetap menggunakan `contextIsolation` default.
- Tidak ada data kredensial yang dikirim ke pane kanan.
- Request map dibersihkan saat page unload.

### Error Handling
- Wrap semua JSON.parse dalam try-catch.
- Jangan crash jika WebSocket tidak ada atau format berubah.

---

## 5. Testing Checklist

- [ ] Start app → pane kanan menampilkan "Waiting Login".
- [ ] Login IPOT → tunggu response MYACCOUNT → status berubah "Connected Ready".
- [ ] Tombol START aktif setelah login confirmed.
- [ ] Logout manual → status kembali "Waiting Login".
- [ ] Refresh halaman IPOT → status tetap konsisten.
- [ ] Console tidak menampilkan data sensitif.

---

## 6. TODO Berikutnya

- [ ] Implementasi adapter login detection untuk Stockbit.
- [ ] Implementasi adapter login detection untuk Ajaib.
- [ ] Implementasi adapter login detection untuk Mirae.
- [ ] Unit test dengan mock WebSocket.
- [ ] Toast/notification di UI untuk transisi status.
- [ ] Deteksi logout otomatis (session expired).
