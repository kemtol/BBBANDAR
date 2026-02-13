
 # 0005 · Execution Engine / Put Order PRD


**Status**: Draft · Ready for implementation  
**Scope**: WebSocket order injection for IPOT retail account  
**Depends on**: `0004_login_detection.md` (custcode + agent token readiness)



---


## 1. Purpose & Success Criteria



Membangun modul eksekusi order berlatensi rendah (<10 ms) yang:


1. Mengubah sinyal strategi menjadi payload `submit` WebSocket.
2. Mengelola siklus hidup order (buy, sell, cancel, amend – tahap pertama fokus buy/sell).
3. Menangani konfirmasi (ACK) dan update status secara event-driven tanpa blocking.
4. Menyediakan kerangka “Phantom Stop” (auto cut loss) berbasis data lokal.


Keberhasilan modul diukur melalui uji lapangan 1 lot (buy + sell) tanpa interaksi UI resmi IPOT.


---


## 2. Observed Official Flow (Reverse Engineering)


Berdasarkan sniffing WebSocket aplikasi resmi IPOT, berikut urutan event saat user melakukan order:


| Step | Tujuan Resmi | Payload Penting |
|------|---------------|-----------------|
| 1 | Persiapan UI (menampilkan data realtime) | `subscribe` → `JTM`, `OB2`, `AUC` |
| 2 | Validasi dana | `CASHINFO` |
| 3 | Eksekusi | `submit` → `service: stocktrade`, `cmd: BUY/SELL` |
| 4 | Konfirmasi tampilan portofolio | `subscribe` → `LP` |



**Catatan bot:** Untuk latensi minimal, kita cukup menjalankan **Step 3** (dan handling Step 4 secara pasif). Langkah lain bersifat opsional / dapat digantikan logika internal.


---


## 3. WebSocket Contract


### 3.1 Jalur Koneksi
- **Transport**: Secure WebSocket (wss).  
- **Endpoint**: Sama dengan stream data login (gunakan session & agent token hasil `0004_login_detection`).  
- **Auth**: Cookie + header bawaan IPOT (reuse dari session login).  


### 3.2 Struktur Pesan Dasar
- **Outbound order**: objek JSON bertopologi `event + data + cid`.  
- **Inbound ack**: server membalas dengan `rid` yang harus dicocokkan dengan `cid`.  
- **Inbound update**: event `push` dengan `data.rtype === "ORDER"` memuat status terbaru.


### 3.3 Manajemen ID Lokal
| Field | Fungsi | Cara Bangun |
|-------|--------|-------------|
| `cid` | Conversation ID | Counter increment (reset saat app restart) |
| `cmdid` | Command ID | Boleh sama dengan `cid` (untuk konsistensi) |
| `submitid` | Unique submit key | `Math.floor(Date.now() / 1000)` (epoch detik) |


Semua ID dihasilkan client-side demi mengurangi round-trip.

### 3.4 Modul Per Broker (Login vs Eksekusi)
- **Login Detection Adapter**: setiap broker punya adapter terpisah (`core/login/adapters/{broker}.js`) yang menangani polling token, intercept WebSocket, dan emit custcode secara aman ke main process. Preload hanya bertindak sebagai registry/dispatcher.
- **Execution Engine**: order engine per broker berada di `core/engine/execution/{broker}.js` dan diakses via router (`core/engine/execution/index.js`). Router ini memastikan API (`connect`, `placeBuy`, `placeSell`, event emitter) konsisten lintas broker.
- **Stream**: modul publik (Time & Sales, features) tetap shared; tidak perlu dipecah per broker karena tidak membawa kredensial sensitif.

---


## 4. Payload Spesifikasi



























### 4.1 BUY Order
```json
{
  "event": "submit",
  "data": {

    "cmdid": 101,
    "param": {
      "service": "stocktrade",
      "cmd": "BUY",
      "param": {

        "custcode": "R10000xxxxx",
        "code": "ZATA",
        "price": 120,
        "vol": 1
      },

      "submitid": 1770885700
    }
  },

  "cid": 101
}
```




### 4.2 SELL Order
```json
{
  "event": "submit",
  "data": {

    "cmdid": 102,
    "param": {
      "service": "stocktrade",
      "cmd": "SELL",
      "param": {

        "custcode": "R10000xxxxx",
        "code": "ZATA",
        "price": 121,
        "vol": 3
      },

      "submitid": 1770885900
    }
  },

  "cid": 102
}
```


> **Vol** adalah dalam LOT (bukan lembar).  
> `custcode` diperoleh dari engine login (`R` untuk regular, `M` margin, dsb).


### 4.3 Optional Pre-check (Kapan dipakai?)


| Payload | Fungsi | Kapan diperlukan |
|---------|--------|------------------|
| `CASHINFO` | mengukur buying power | Jika bot mau double-check saldo broker (trade besar). |
| `OB2`, `JTM` | update order book, running trade | Hanya jika bot membutuhkan konteks pasar tambahan. |
| `AUC` | status auction | Berguna menjelang pre-open/closing. |


Untuk HFT/Scalping, kita lewati semua agar fire time < latency RTT.


---


## 5. Handling Respons & Update


### 5.1 Immediate Ack (synchronous)
- **Tujuan**: memastikan server menerima order.  
- **Match**: `msg.rid === cid`.  
- **Sukses**: `msg.data.status === "OK"`.  
  - Simpan `msg.data.data.jatsorderno` untuk amend/cancel.  
- **Gagal**: `msg.data.status !== "OK"`.  
  - Ambil `msg.data.message` untuk logging & fallback.

### 5.2 Order Update Stream
- Dengarkan event: `event === "push"`, `data.rtype === "ORDER"`.  
- Kolom penting:
  - `data.code`: ticker.  
  - `data.cmd`: BUY/SELL.  
  - `data.status`: `O` (Open), `M` (Matched), `R` (Rejected), `C` (Cancelled).  

### 5.3 Portfolio Sync
- Aplikasi resmi otomatis subscribe `rtype: LP`.  
- Bot cukup mencatat `ORDER` + optional auto-trigger sync ke modul portfolio kita.

---


## 6. Risk Management: Phantom Stop/TP






Karena IPOT tidak menyediakan server-side advanced stop, kita kelola sendiri:


1. **After Matched** (`status === 'M'`):
   - Simpan average price per ticker + lot tersisa.
   - Hitung `stopPrice` dan `targetPrice` berdasarkan konfigurasi strategi.


2. **Price Watcher**:  
   - Subscribes pada `Running Trade` atau `Order Book`.  
   - Loop cepat: cek harga bid/ask terakhir.



3. **Trigger**:
```ts
if (lastPrice <= stopPrice) {
  submitSell({ code, price: bestBid, vol: remainingLot });
}
```



4. **Keunggulan**: tidak menumpuk order di order book, meminimasi ekspos “bandar sniffing”.

---


## 7. Developer Checklist


### 7.1 Router & Adapter Setup
- [ ] `core/engine/execution/index.js` sebagai registry, memetakan broker → engine dan meneruskan event secara seragam.
- [ ] `core/engine/execution/ipot.js` (dan broker lain nantinya) berisi implementasi WebSocket + payload spesifik.
- [ ] `core/login/adapters/ipot.js` menangani deteksi login & ekstraksi custcode; `preload.js` hanya memilih adapter aktif.

### 7.2 Modul Eksekusi IPOT (`core/engine/execution/ipot.js`)
- [ ] `IDGenerator` (cid/cmdid auto-increment).  
- [ ] `buildSubmitPayload({ side, code, price, lot, custcode })`.  
- [ ] `sendOrder(payload)` → `ws.send(JSON.stringify(payload))`.  
- [ ] Event emitter untuk ack dan stream update.




### 7.3 Integrasi Strategi
- [ ] API `execution.placeBuy(params)` & `execution.placeSell(params)`.
- [ ] Registrasi listener di modul order status untuk stop/TP.


### 7.4 UI Hooks (sementara)
- [ ] Tombol dummy: “Test BUY 1 Lot” & “Test SELL 1 Lot” pada dashboard untuk QA manual.  
- [ ] Panel log menampilkan ack & update status order secara realtime.


---






## 8. Testing Plan

### Phase 1 – Dry Run (No network impact)
- Stub `ws.send` → console.  
- Verifikasi bentuk JSON, tipe data, nilai `submitid` berformat angka 10-digit.

### Phase 2 – Paper Trade 1 Lot
1. Login ke IPOT melalui bot.  
2. Tekan tombol “Test BUY 1 Lot” (saham murah, contoh: GOTO).  
3. Pastikan ack `OK` dan stream `ORDER` menampilkan status `O/M`.  
4. Tekan “Test SELL 1 Lot” → validasi barang keluar.

### Phase 3 – Stress & Recovery (opsional)
- Simulasikan reject (harga terlalu tinggi/rendah).  
- Pastikan modul mencatat pesan error & tidak crash.

---


## 9. Future Enhancement
- Cancel/Amend order (butuh payload tambahan).  
- Multi-account routing (custcode per akun).  
- Batched orders + throttle limiter.  
- Integrasi ke modul strategi untuk auto-sizing (lot vs capital).


---


## 10. Appendix

### 10.1 Contoh Paket Ack (Sukses)
```json
{

  "rid": 101,
  "data": {











    "status": "OK",
    "message": "SUCCESS",
    "data": {
      "jatsorderno": "2024021200000123"
    }


  }
}

```



### 10.2 Contoh Paket Stream `ORDER`
```json
{

  "event": "push",
  "data": {














    "rtype": "ORDER",
    "code": "ZATA",
    "cmd": "BUY",
    "status": "M",
    "price": 120,
    "vol": 1,
    "jatsorderno": "2024021200000123"
  }
}

```




---




































































































Dokumen ini menjadi panduan utama ketika mengimplementasikan modul eksekusi. Perubahan struktural utama harus diperbarui di sini sebelum di-deploy ke produksi.