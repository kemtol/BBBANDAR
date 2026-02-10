# 0002 — Token Management Engine

> **Layer:** Engine · **Module:** [`core/engine/token-engine.js`](../core/engine/token-engine.js)
> **Depends on:** Electron `webContents` (session/cookies)
> **Consumed by:** [0003 Channel & Stream](./0003_channel_stream.md), Dashboard UI

---

## Overview

Sistem token terbagi menjadi **3 tier** yang independent. Public token didapat otomatis tanpa login dan **tidak bisa mengeksekusi order** — hanya untuk data. Agent token didapat setelah user login dan memungkinkan eksekusi trade.

## Token Tiers

| Tier | Nama | Cara Dapat | Kegunaan | Eksekusi? |
|:----:|------|-----------|----------|:---------:|
| 🌐 1 | **Public Token** | Otomatis, buka halaman IPOT | Backtest, Dry Run, Chart, Target Price, Live Trade Stream | ❌ |
| 🔒 2 | **IPOT Agent Token** | Login IPOT | Eksekusi order via IPOT | ✅ |
| 🔒 3 | **Stockbit Agent Token** | Login Stockbit | Eksekusi order via Stockbit | ✅ |

## State Object

```js
tokenEngine.state = {
  public: null,        // string — auto-detected on page load
  ipotAgent: null,     // string — after IPOT login
  stockbitAgent: null  // string — after Stockbit login
}
```

## API

| Method | Description |
|--------|------------|
| `extractPublicToken(webContents)` | Sniff `appsession` dari cookies / localStorage IPOT |
| `extractAgentToken(webContents, broker)` | Ambil authenticated token post-login (`'ipot'` \| `'stockbit'`) |
| `getPublicToken()` | Getter cached public token |
| `getAgentToken(broker)` | Getter cached agent token |
| `mask(token)` | Mask token untuk safe logging |

## Events

| Event | Payload | Trigger |
|-------|---------|---------|
| `public-token-ready` | `string` (token) | Setelah public token berhasil di-extract |
| `agent-token-ready` | `{ broker, token }` | Setelah agent token berhasil di-extract |

## Extraction Flow

```
App Start
  └─ leftPane.did-finish-load
       └─ 🔑 Get public token...
            ├─ Cookie: ipotapp.ipot.id (appsession)
            ├─ localStorage/sessionStorage scan
            └─ Cookie: .indopremier.com (session/token)
                 │
                 ├─ Found → ✅ Public token ready
                 │          🔑 Public token is p03db4f00...9df302
                 │          └─ Auto-start channels (→ 0003)
                 │
                 └─ Not Found → ⚠️ Halaman IPOT belum terbuka sempurna
```

## Terminal Log (on startup)

```
🔑 Get public token...
✅ Public token ready
🔑 Public token is p03db4f00...9df302
```

## Integration Point

Setelah public token ready, `main.js` otomatis menjalankan channel streams yang terdokumentasi di [0003 Channel & Stream](./0003_channel_stream.md):
- **Live Trade Stream** — auto-connect
- **Target Price** — on-demand via DRY RUN button

---

> **See also:** [0001 Pipeline (PRD)](./0001_pipeline.md) · [0003 Channel & Stream](./0003_channel_stream.md)