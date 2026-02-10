# 0003 — Channel & Stream Architecture

> **Layer:** Channel · **Modules:** [`core/channel/`](../core/channel/)
> **Depends on:** [0002 Token Engine](./0002_token_mgmt.md) (public token)
> **Consumed by:** Strategy Engine, Dashboard UI, Data Store

---

## Overview

Channel layer menangani semua koneksi WebSocket ke IPOT SocketCluster. Semua channel menggunakan **public token** (Tier 1) — tidak perlu login. Data yang diterima di-parse dan di-emit sebagai event untuk dikonsumsi oleh layer atas (strategy, UI, storage).

## Channels

| Channel | Module | Subscription | Trigger | Output |
|---------|--------|-------------|---------|--------|
| **Live Trade** | [`livetrade.js`](../core/channel/livetrade.js) | `rtype: LT`, `code: *` | Auto (on token ready) | Event `trade` per transaksi |
| **Target Price** | [`target-price.js`](../core/channel/target-price.js) | `index: en_qu_TargetPrice` | Manual (DRY RUN button) | File `target-price-by-emiten.json` |

---

## 1. Live Trade Stream

### Protocol

```
wss://ipotapp.ipot.id/socketcluster/?appsession=<PUBLIC_TOKEN>
  │
  ├─ TX: { event: "#handshake", data: { authToken: null }, cid: 1 }
  │
  ├─ TX: { event: "cmd", data: { cmdid: 999, param: {
  │         cmd: "subscribe", service: "mi", rtype: "LT", code: "*",
  │         subsid: "electron_livetrade" }}, cid: 2 }
  │
  └─ RX: { event: "stream", data: { rtype: "LT",
            data: "20260210|143025|BBCA|9575|150|..." }}
```

### Pipe Format (rtype: LT)

Trade data dikirim sebagai pipe-delimited string:

```
YYYYMMDD | HHMMSS | TICKER | PRICE | VOL | SIDE | ...
   [0]      [1]      [2]     [3]    [4]   [5]
```

| Field | Idx | Example | Type |
|-------|:---:|---------|------|
| Date | 0 | `20260210` | `YYYYMMDD` |
| Time | 1 | `143025` | `HHMMSS` (WIB) |
| Ticker | 2 | `BBCA` | string |
| Price | 3 | `9575` | number |
| Volume | 4 | `150` | number (lot) |
| Side | 5 | `B` / `S` | Buy/Sell indicator |

### Parsed Trade Object

```js
{
  date: '20260210',
  time: '143025',
  ticker: 'BBCA',
  price: 9575,
  vol: 150,
  side: 'B',
  ts: 1739169025000,     // UTC epoch (ms)
  ts_quality: 'derived', // 'derived' from pipe | 'ingestion' fallback
  _fmt: 'pipe'
}
```

### Event Flow

```
TokenEngine.public-token-ready
  └─ main.js → liveTradeStream.connect(token)
       └─ WebSocket → subscribe LT (code: *)
            └─ on message (rtype: LT)
                 └─ _parseTrade(pipeString)
                      ├─ emit('trade', parsedObj)      → Strategy Engine
                      ├─ emit('trade-raw', envelope)    → Archival
                      └─ IPC 'live-trade' → Dashboard   → UI Log
```

### Features

- ♻️ **Auto-reconnect** — reconnect otomatis setelah 5 detik jika disconnect
- 📊 **Stats** — `getStats()` returns `{ connected, totalTrades, lastTradeAt, reconnects, uptime }`
- 🏗️ **Singleton** — satu instance global, bisa diakses dari module manapun

---

## 2. Target Price Channel

### Protocol

```
wss://ipotapp.ipot.id/socketcluster/?appsession=<PUBLIC_TOKEN>
  │
  ├─ TX: { event: "#handshake", data: { authToken: null }, cid: 1 }
  │
  └─ TX (per emiten): {
       event: "cmd",
       data: { cmdid: 2, param: {
         cmd: "query", service: "midata",
         param: { source: "datafeed",
                  index: "en_qu_TargetPrice",
                  args: ["BBCA", "2026-02-10"] }}},
       cid: N }
```

### Query Strategy

- Load semua ticker dari [`data/master-emiten.json`](../data/master-emiten.json) (101 emiten)
- Strip suffix `.JK` → `BBCA.JK` → `BBCA`
- Stagger query: **300ms** delay antar emiten (anti rate-limit)
- Date parameter: tanggal hari ini (auto `YYYY-MM-DD`)

### Output

Hasil disimpan ke [`data/target-price-by-emiten.json`](../data/target-price-by-emiten.json):

```json
{
  "generatedAt": "2026-02-10T08:30:00.000Z",
  "totalEmitens": 101,
  "results": {
    "BBCA": { "data": { ... }, "fetchedAt": "..." },
    "BBRI": { "data": { ... }, "fetchedAt": "..." }
  }
}
```

### Trigger

Dipanggil dari dashboard via IPC `fetch-target-prices` (tombol **DRY RUN**).

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────┐
│                   main.js                       │
│                                                 │
│  did-finish-load ──► tokenEngine                │
│                        │                        │
│              ┌─── public token ready ───┐       │
│              ▼                          ▼       │
│     ┌────────────────┐       ┌────────────────┐ │
│     │  livetrade.js  │       │ target-price.js│ │
│     │  (auto-start)  │       │  (on-demand)   │ │
│     └───────┬────────┘       └───────┬────────┘ │
│             │                        │          │
│         emit('trade')           saveResults()   │
│             │                        │          │
│     ┌───────▼────────┐       ┌───────▼────────┐ │
│     │  IPC to UI     │       │  JSON file     │ │
│     │  'live-trade'  │       │  (by-emiten)   │ │
│     └────────────────┘       └────────────────┘ │
└─────────────────────────────────────────────────┘
```

---

## Porting Reference

`livetrade.js` di-port dari Cloudflare Worker [`livetrade-taping`](../../workers/livetrade-taping/src/index.js):

| Aspect | Worker (CF) | Electron |
|--------|------------|----------|
| Runtime | Durable Object | Node.js singleton |
| Reconnect | Alarm (2s interval) | setTimeout (5s) |
| Buffer | In-memory + R2 flush | EventEmitter (no persistence) |
| OB2 Subscribe | Per-watchlist kode | Not implemented yet |
| Ping/Pong | `#1` → `#2` | `#1` → `#2` (same) |

---

> **See also:** [0001 Pipeline (PRD)](./0001_pipeline.md) · [0002 Token Management](./0002_token_mgmt.md)
