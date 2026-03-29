# MVP Order Protocol — IPOT WebSocket

> Berdasarkan analisis `data/ws-dump.json` sesi live 2026-03-11.  
> Cycle: **Login → Profile & Max Fund → Put Buy → Put Sell**

---

## 1. Overview Protocol

Semua komunikasi pakai JSON over WebSocket (SocketCluster).  
- **Request**: `{event:"cmd"|"submit"|"get", data:{cmdid, param:{...}}, cid}`  
- **Response**: `{rid: <matching cid>, data:{status:"OK"|"ERROR", ...}}`  
- **Push**: `{event:"push", data:{event:"push", service, rtype, code, cust, rec|data}}`

Korelasi request↔response: `cid` di request = `rid` di response.

---

## 2. Step 1: Login Detection

### 2.1 Layer 1 — Token (Early Hint)
- `localStorage.getItem('appsession')` — token muncul setelah login form
- Prefix `M` di custcode = Margin, `R` = Reguler

### 2.2 Layer 2 — MYACCOUNT (Confirmation)

**SEND:**
```json
{
  "event": "cmd",
  "data": {
    "cmdid": <int>,
    "param": {
      "service": "porto",
      "cmd": "MYACCOUNT",
      "param": {}
    }
  },
  "cid": <int>
}
```

**RECV:**
```json
{
  "rid": <matching cid>,
  "data": {
    "status": "OK",
    "data": {
      "lid": "USERNAME",
      "name": "...",
      "custcode": ["M10000195903"],
      "main": "M10000195903",
      "accinfo": { ... },
      "custinfo": { ... }
    }
  }
}
```

**Key Fields:**
- `data.data.main` → primary custcode
- Prefix `M` = Margin, `R` = Regular
- Status sudah diimplementasi di preload.js

---

## 3. Step 2: Get Profile & Max Fund

### 3.1 CASHINFO — Buying Power & Account Type

**SEND:**
```json
{
  "event": "cmd",
  "data": {
    "cmdid": <int>,
    "param": {
      "service": "porto",
      "cmd": "CASHINFO",
      "param": {
        "custcode": "M10000195903"
      }
    }
  },
  "cid": <int>
}
```

**RECV:**
```json
{
  "rid": <matching cid>,
  "data": {
    "status": "OK",
    "data": {
      "code": "CASHINFO",
      "rtype": "CASHINFO",
      "cmdseq": <int>,
      "rec": [ ... 72 fields ... ]
    }
  }
}
```

**CASHINFO `rec` Field Mapping (verified):**

| Idx | Field             | Sample Value        | Keterangan |
|-----|-------------------|---------------------|------------|
| 5   | custcode          | `M10000195903`      | Customer code |
| 10  | status_msg        | `OK CASH INFO`      | Status message |
| 14  | credit_limit      | `158336208.47`      | Total credit/limit |
| 15  | credit_limit_2    | `158336208.47`      | Same (dup?) |
| 16  | cash_balance      | `5208592.56`        | Saldo kas |
| 17  | cash_balance_2    | `5208592.56`        | Same |
| 18  | cash_balance_3    | `5208592.56`        | Same |
| 19  | mkt_value         | `447180574.50`      | Market value portfolio |
| 20  | net_val_today     | `-288844366.03`     | Net (negatif = hutang margin) |
| 25  | pending_buy       | `539800.00`         | Pending buy orders value |
| 26  | pending_sell      | `1926400.00`        | Pending sell orders value |
| 27  | date_t0           | `2026-03-11`        | Settlement date T+0 |
| 28  | date_t1           | `2026-03-12`        | Settlement date T+1 |
| 29  | date_t2           | `2026-03-13`        | Settlement date T+2 |
| 69  | **account_type**  | `M`                 | **M=Margin, R=Regular** |

### 3.2 CASHPOS — Cash Position (Subscribe)

**SEND:**
```json
{
  "event": "cmd",
  "data": {
    "cmdid": <int>,
    "param": {
      "service": "porto",
      "cmd": "CASHPOS",
      "subsid": "CASHPOS_M10000195903",
      "param": { "custcode": "M10000195903", "subscribe": true },
      "rtype": "CASHPOS"
    }
  },
  "cid": <int>
}
```

**RECV (push):**
```json
{
  "event": "push",
  "data": {
    "service": "porto",
    "rtype": "CASHPOS",
    "code": "CASH",
    "cust": "M10000195903",
    "rec": [ ... 48 fields ... ]
  }
}
```

### 3.3 STOCKPOS — Stock Portfolio (Subscribe)

**SEND:**
```json
{
  "event": "cmd",
  "data": {
    "cmdid": <int>,
    "param": {
      "service": "porto",
      "cmd": "STOCKPOS",
      "subsid": "STOCKPOS_M10000195903",
      "param": { "custcode": "M10000195903", "code": "*", "subscribe": true },
      "rtype": "STOCKPOS"
    }
  },
  "cid": <int>
}
```

**RECV (push per stock):**
```json
{
  "event": "push",
  "data": {
    "service": "porto",
    "rtype": "STOCKPOS",
    "code": "SCMA",
    "cust": "M10000195903",
    "rec": [ ... 39 fields ... ]
  }
}
```

**STOCKPOS `rec` Field Mapping:**

| Idx | Field         | Sample Value          | Keterangan |
|-----|--------------|-----------------------|------------|
| 4   | custcode     | `M10000195903`        | Customer code |
| 5   | code         | `SCMA`                | Stock ticker |
| 6   | total_lot    | `25000`               | Total lot dimiliki |
| 7   | sell_pending | `0`                   | Lot pending sell |
| 9   | available    | `25000`               | Lot tersedia jual |
| 13  | buy_today    | `200`                 | Lot beli hari ini |
| 14  | sell_today   | `200`                 | Lot jual hari ini |
| 24  | last_price   | `248`                 | Harga terakhir |
| 25  | avg_price    | `322.2927`            | Avg buy price |
| 26  | avg_price2   | `256.0000000`         | Avg price lain |
| 29  | board        | `RG`                  | Board (RG=Regular) |
| 30  | net_lot      | `25000`               | Net lot |
| 33  | mkt_value    | `6400000.00`          | Market value |
| 34  | pl           | `-1670305.00`         | Profit/Loss |
| 35  | pl_pct       | `-20.70`              | P/L percentage |

---

## 4. Step 3 & 4: Put Buy / Put Sell Order

### ⚠️ BELUM TERCAPTURE

Dump sesi 2026-03-11 **tidak mengandung order placement** karena user hanya browsing portfolio, tidak menaruh order.

### 4.1 Yang Sudah Diketahui dari ORDER Subscription

**SEND (subscribe order list):**
```json
{
  "event": "cmd",
  "data": {
    "cmdid": <int>,
    "param": {
      "service": "stocktrade",
      "cmd": "ORDER",
      "subsid": "ORDER_M10000195903",
      "param": { "custcode": "M10000195903", "code": "*", "subscribe": true },
      "rtype": "ORDER"
    }
  },
  "cid": <int>
}
```

**RECV (push existing orders):**
```json
{
  "event": "push",
  "data": {
    "service": "stocktrade",
    "rtype": "ORDER",
    "code": "BBCA",
    "cust": "M10000195903",
    "data": {
      "code": "BBCA",
      "custcode": "M10000195903",
      "price": "6925.00",
      "qty": [0, 0, 200, 0, 0, 0]
    }
  }
}
```

**ORDERSUM qty array meaning (hypothesis):**
`[open_buy, open_sell, match_buy, match_sell, withdraw_buy, withdraw_sell, ?price1, ?price2]`

**ORDER qty array meaning (hypothesis):**
`[open, amend, match, withdraw, reject, partial]`

### 4.2 Langkah Selanjutnya — Capture Order Placement

Untuk menangkap flow put buy/put sell, perlu:
1. Start app → login → buka halaman order
2. Tempatkan 1 order buy (harga jauh di bawah market agar tidak match)
3. Tempatkan 1 order sell (harga jauh di atas market agar tidak match)
4. Analisis ws-dump.json untuk request pattern

**Hipotesis struktur PUT ORDER:**
```json
{
  "event": "cmd",
  "data": {
    "cmdid": <int>,
    "param": {
      "service": "stocktrade",
      "cmd": "ORDER_PUT" | "NEWORDER" | ???,
      "param": {
        "custcode": "M10000195903",
        "code": "BBCA",
        "side": "B" | "S",
        "price": "6800",
        "qty": 100,
        "board": "RG"
      }
    }
  },
  "cid": <int>
}
```

---

## 5. Protocol Summary Table

| Step | Service | Cmd | Event | Sudah? |
|------|---------|-----|-------|--------|
| Login | porto | MYACCOUNT | cmd → rid response | ✅ |
| Cash Info | porto | CASHINFO | cmd → rid response | ✅ |
| Cash Position | porto | CASHPOS | cmd → push stream | ✅ |
| Stock Position | porto | STOCKPOS | cmd → push stream | ✅ |
| Order Summary | stocktrade | ORDERSUM | cmd → push stream | ✅ |
| Order List | stocktrade | ORDER | cmd → push stream | ✅ |
| **Put Buy** | stocktrade | ??? | cmd → rid response | ❌ Need capture |
| **Put Sell** | stocktrade | ??? | cmd → rid response | ❌ Need capture |

---

## 6. Technical Notes

- Buffer dinaikkan dari 500 → 5000 entries agar capture login flow
- Noise filter active: skip LT, SS2, OB2, BAR1, ping/pong, stream, notif
- custcode `M` prefix = Margin, `R` prefix = Regular
- CASHINFO rec[69] = account type (`M`/`R`)
- Semua numeric values di rec sebagai string — perlu parseFloat
