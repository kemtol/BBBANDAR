# WebSocket Frame Recognition — IPOT

> Hasil taping dari `data/ws-dump.json` pada sesi live market.  
> WebSocket endpoint: `wss://ipotapp.ipot.id/socketcluster/?appsession=***`

---

## 1. Struktur Frame Umum

Semua frame menggunakan format JSON dengan wrapper:

```json
{
  "event": "stream" | "notif" | "cmd" | ...,
  "data": { ... }
}
```

---

## 2. Event Types yang Ditemukan

| Event   | Direction | Keterangan |
|---------|-----------|------------|
| `stream`| RECV      | Market data real-time (LT, SS2, OB2, BAR1) |
| `notif` | RECV      | Notifikasi price alert / trigger |
| `cmd`   | SEND      | Request ke server (porto, market, dll) |
| `#handshake` | SEND | Socketcluster handshake (non-JSON frame) |

---

## 3. RECV: stream — rtype breakdown

| rtype  | Count (sample) | Keterangan |
|--------|---------------|------------|
| `LT`   | dominan (~72%) | Live Trade / Time & Sales |
| `SS2`  | medium (~25%)  | Stock Snapshot v2 |
| `notif`| kecil (~2%)    | Price alert triggered |
| `OB2`  | sangat kecil   | Order Book v2 |
| `BAR1` | sangat kecil   | OHLCV Candle Bar |

---

## 4. rtype: LT (Live Trade / Time & Sales)

**Envelope:**
```json
{
  "event": "stream",
  "data": {
    "source": "IDX",
    "service": "mi",
    "rtype": "LT",
    "code": "ANY",
    "data": "B|152735|0|PTRO|RG|01660795|5025|789|--|-|--|-|5100|00|4479700|-75|0|5095|-1|1"
  }
}
```

**Pipe-delimited fields (`data` string):**

| Idx | Field     | Contoh       | Keterangan |
|-----|-----------|--------------|------------|
| 0   | type      | `B`          | Selalu `B` (Buy execution?) |
| 1   | time      | `152735`     | HHMMSS WIB (15:27:35) |
| 2   | unk1      | `0`          | Unknown, selalu 0 |
| 3   | code      | `PTRO`       | Kode saham |
| 4   | board     | `RG`         | Board (RG=Regular) |
| 5   | seq       | `01660795`   | Sequence trans global |
| 6   | price     | `5025`       | Harga transaksi |
| 7   | lot       | `789`        | Volume dalam lot |
| 8   | unk2      | `--`         | Unknown |
| 9   | unk3      | `-`          | Unknown |
| 10  | unk4      | `--`         | Unknown |
| 11  | unk5      | `-`          | Unknown |
| 12  | prev      | `5100`       | Harga kemarin (prev close) |
| 13  | side      | `00`         | `00`=unknown, `12`=buy, `21`=sell (perlu verifikasi) |
| 14  | cumVol    | `4479700`    | Cumulative volume (lot) hari ini |
| 15  | change    | `-75`        | Change dari prev (price - prev) |
| 16  | unk6      | `0`          | Unknown |
| 17  | bestask   | `5095`       | Best ask saat transaksi |
| 18  | unk7      | `-1`         | Unknown |
| 19  | unk8      | `1`          | Unknown, seringkali 1 |

---

## 5. rtype: SS2 (Stock Snapshot v2)

**Envelope:**
```json
{
  "event": "stream",
  "data": {
    "source": "IDX",
    "service": "mi",
    "rtype": "SS2",
    "code": "PGAS",
    "data": {
      "subcmd": "INIT" | "UPDATE",
      "code": "PGAS",
      "board": "RG",
      "data": "D|I|PGAS|RG|1970|1995|1950|1965|628379|123663414000|12301|1970|1967|1965|10979|1970|8133|154035|106286|-5|0|0|-1|13|2|-13|20|1",
      "trendinfo": ["TREND_R10_5:val", "TREND_R10_5:frq"]  // optional
    }
  }
}
```

**Pipe-delimited fields (28 fields):**

| Idx | Field    | Contoh           | Keterangan |
|-----|----------|------------------|------------|
| 0   | type     | `D`              | Selalu `D` |
| 1   | subcmd   | `I`              | `I`=INIT, `U`=UPDATE |
| 2   | code     | `PGAS`           | Kode saham |
| 3   | board    | `RG`             | Board pasar |
| 4   | prev     | `1970`           | Harga kemarin |
| 5   | high     | `1995`           | Highest hari ini |
| 6   | low      | `1950`           | Lowest hari ini |
| 7   | last     | `1965`           | Last / close price |
| 8   | vol      | `628379`         | Volume (lot) |
| 9   | val      | `123663414000`   | Value (Rupiah) |
| 10  | freq     | `12301`          | Frekuensi transaksi |
| 11  | bid1     | `1970`           | Best bid |
| 12  | bid2     | `1967`           | Bid ke-2 |
| 13  | ask1     | `1965`           | Best ask |
| 14  | bidVol1  | `10979`          | Volume best bid (lot) |
| 15  | ask2     | `1970`           | Ask ke-2 |
| 16  | askVol1  | `8133`           | Volume best ask (lot) |
| 17  | buyVol   | `154035`         | Total buy volume hari ini (lot) |
| 18  | sellVol  | `106286`         | Total sell volume hari ini (lot) |
| 19  | change   | `-5`             | Perubahan harga (last - prev) |
| 20  | unk1     | `0`              | Unknown |
| 21  | unk2     | `0`              | Unknown |
| 22  | unk3     | `-1`             | Unknown |
| 23  | unk4     | `13`             | Unknown (mungkin foreign?) |
| 24  | unk5     | `2`              | Unknown |
| 25  | chgPct   | `-13`            | Change persen × 100 (misal: -13 = -0.13%) atau bps |
| 26  | unk6     | `20`             | Unknown |
| 27  | unk7     | `1`              | Unknown |

---

## 6. rtype: OB2 (Order Book v2)

**Envelope:**
```json
{
  "event": "stream",
  "data": {
    "source": "IDX",
    "service": "mi",
    "rtype": "OB2",
    "code": "SCMA",
    "data": "{\"subcmd\":\"UPDATE\",\"board\":\"RG\",\"recinfo\":\"C|U|SCMA|RG|248|252|258|262|246|255|7827|229126|276562|...\"}"
  }
}
```

> ⚠️ `data` adalah JSON string yang harus di-parse lagi.

**`recinfo` pipe-delimited (partial):**

| Idx | Field | Contoh | Keterangan |
|-----|-------|--------|------------|
| 0   | type  | `C`    | Unknown |
| 1   | subcmd| `U`    | `U`=UPDATE |
| 2   | code  | `SCMA` | Kode saham |
| 3   | board | `RG`   | Board |
| 4   | bid5? | `248`  | Bid level 5? |
| 5   | bid4? | `252`  | Bid level 4? |
| 6   | ask1  | `258`  | Best ask |
| 7   | ask2  | `262`  | Ask level 2 |
| 8   | bid?  | `246`  | Bid level? |
| 9   | vol?  | `255`  | Volume? |
| ... | ...   | ...    | Perlu analisis lebih lanjut |

Bagian setelah `:` dan `;` adalah segment orderbook detail:
```
:|256|258|1|4|1|0|-4|;|256|258|P|258|0|36664|X|1
```

---

## 7. rtype: BAR1 (OHLCV Candle Bar — 1 menit)

**Envelope:**
```json
{
  "event": "stream",
  "data": {
    "source": "REGIONAL",
    "service": "mi",
    "rtype": "BAR1",
    "code": "SCMA",
    "data": "{\"time\":1773217620000,\"close\":258,\"open\":258,\"high\":258,\"low\":256,\"volume\":174700}"
  }
}
```

> ⚠️ `data` adalah JSON string yang harus di-parse lagi.

| Field    | Keterangan |
|----------|------------|
| `time`   | Epoch ms — awal candle (1 menit) |
| `open`   | Harga open candle |
| `high`   | Highest candle |
| `low`    | Lowest candle |
| `close`  | Harga close candle |
| `volume` | Volume dalam lembar (bukan lot) |

---

## 8. event: notif (Price Alert)

**Envelope:**
```json
{
  "event": "notif",
  "data": {
    "source": "IDX",
    "service": "mi",
    "context": "lastprice",
    "info": {
      "code": "PTRO",
      "board": "RG",
      "price": 5025,
      "pprev": 5100,
      "popen": 5125,
      "phi": 5275,
      "plo": 4970,
      "pavg": 5095,
      "chg": -75,
      "chgchg": 1
    }
  }
}
```

| Field    | Keterangan |
|----------|------------|
| `code`   | Kode saham |
| `price`  | Harga terakhir |
| `pprev`  | Harga kemarin |
| `popen`  | Harga open hari ini |
| `phi`    | Highest hari ini |
| `plo`    | Lowest hari ini |
| `pavg`   | Average price hari ini |
| `chg`    | Change (price - pprev) |
| `chgchg` | Unknown (1 = harga berubah?) |

---

## 9. SEND: cmd (Request ke Server)

Request porto/market dikirim dengan format:
```json
{
  "event": "cmd",
  "data": {
    "cmdid": 124,
    "param": {
      "service": "porto" | "mi" | ...,
      "cmd": "MYACCOUNT" | "CASHPOS" | "TRADE" | ...,
      "param": { ... }
    }
  },
  "cid": 126
}
```

> `cid` di request = `rid` di response (pasangan req-res).

---

## 10. Subscribe Pattern

Untuk subscribe ke stream saham tertentu:
```json
{
  "event": "cmd",
  "data": {
    "param": {
      "service": "mi",
      "cmd": "SS2",
      "param": {
        "code": "BBCA",
        "subscribe": true
      }
    }
  },
  "cid": 99
}
```

---

## 11. TODO / Perlu Verifikasi Lanjutan

- [ ] Field `side` di LT: mapping `00` / `12` / `21` ke buy/sell/unknown
- [ ] Field `chgPct` di SS2: apakah × 100 atau basis poin?
- [ ] OB2 `recinfo` full field mapping (5 bid + 5 ask levels)
- [ ] Porto cmd list lengkap: CASHPOS, TRADE, ORDERLIST, dll
- [ ] `unk` fields di SS2 (idx 20-24, 26-27) — mungkin foreign net, ARA/ARB indicator
- [ ] BAR1: apakah `volume` dalam lembar atau lot?
- [ ] Capture SEND frames porto dengan login session (dump hanya mendapat 1 SEND frame karena tap dimulai setelah sesi berjalan)
