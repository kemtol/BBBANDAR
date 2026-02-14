# 0001 — AlgoFuture Architecture (Topstep ProjectX)

> **Objective:** Automated futures trading for Topstep evaluation (prop firm funding challenge)  
> **Data Source:** Topstep ProjectX SignalR WebSocket  
> **Broker:** Any broker supporting NinjaTrader API (integration TBD)  
> **Status:** MVP (Phase 1: Data ingestion + footprint aggregation)

---

## 1. System Overview

```
┌──────────────────────────────────────────────────────────────┐
│                     ELECTRON APP (Main)                       │
├──────────────────────────────────────────────────────────────┤
│                                                               │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │               LEFT PANE: Broker/Chart                    │ │
│  │  ┌─────────────────────────────────────────────────────┐│ │
│  │  │ Topstep ProjectX Account                            ││ │
│  │  │ - Login/Token Management                            ││ │
│  │  │ - Account Snapshot                                  ││ │
│  │  │ - Position Monitor                                  ││ │
│  │  └─────────────────────────────────────────────────────┘│ │
│  └─────────────────────────────────────────────────────────┘ │
│                                                               │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │            RIGHT PANE: Trading Dashboard                │ │
│  │  ┌─────────────────────────────────────────────────────┐│ │
│  │  │ Agent Controls:                                      ││ │
│  │  │ ├─ Strategy Selector                                ││ │
│  │  │ ├─ START / STOP / FLATTEN buttons                   ││ │
│  │  │ └─ Risk Settings                                    ││ │
│  │  │                                                      ││ │
│  │  │ P&L Monitor:                                         ││ │
│  │  │ ├─ Daily P&L                                         ││ │
│  │  │ ├─ Drawdown Tracker                                 ││ │
│  │  │ └─ Topstep Compliance Status                        ││ │
│  │  │                                                      ││ │
│  │  │ Footprint Chart:                                     ││ │
│  │  │ ├─ Real-time Candle Data                            ││ │
│  │  │ ├─ POC, Value Area                                  ││ │
│  │  │ └─ Volume Profile                                   ││ │
│  │  │                                                      ││ │
│  │  │ System Log (scrollable)                             ││ │
│  │  └─────────────────────────────────────────────────────┘│ │
│  └─────────────────────────────────────────────────────────┘ │
│                                                               │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │                   CORE MODULES                          │ │
│  │  ┌─────────────┐  ┌──────────────┐  ┌──────────────┐   │ │
│  │  │  Adapters   │  │   Engine     │  │    Risk      │   │ │
│  │  ├─ signalr.js│  ├─ executor.js │  ├─ compliance  │   │ │
│  │  ├─ auth.js   │  ├─ aggregator  │  ├─ position    │   │ │
│  │  └─ parser.js │  └─ footprint   │  └─ phantom     │   │ │
│  │               │                 │                  │   │ │
│  │  ┌─────────────┐  ┌──────────────┐                │   │ │
│  │  │ Channel     │  │  Strategies  │                │   │ │
│  │  ├─ livetrade  │  ├─ scalper     │                │   │ │
│  │  ├─ features   │  ├─ breakout    │                │   │ │
│  │  └─ stream     │  └─ manager     │                │   │ │
│  │               │                 │                  │   │ │
│  └─────────────────────────────────────────────────────┘   │ │
│                                                               │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │                  DATA LAYER                             │ │
│  │  ┌───────────────────────────────────────────────────┐  │ │
│  │  │ data/                                             │  │ │
│  │  │ ├─ footprints-cache.json (in-memory)             │  │ │
│  │  │ ├─ positions.json (current holdings)             │  │ │
│  │  │ ├─ pnl-history.json (daily snapshots)            │  │ │
│  │  │ └─ master-futures.json (contract specs)          │  │ │
│  │  └───────────────────────────────────────────────────┘  │ │
│  └─────────────────────────────────────────────────────────┘ │
│                                                               │
└──────────────────────────────────────────────────────────────┘
```

---

## 2. Data Flow

### **Phase 1: Initialization**

```
App Start
  │
  ├─ Load master-futures.json (contract specs)
  │
  ├─ Render LEFT PANE (Topstep login page)
  │   └─ https://topstepx.com/login
  │
  ├─ Render RIGHT PANE (Dashboard UI)
  │   └─ index.html + local webpack bundle
  │
  └─ Wait for user login...
```

### **Phase 2: User Login → Token Ready**

```
User logs in to Topstep (left pane)
  │
  ├─ Preload detects login (MYACCOUNT response)
  │
  ├─ IPC send to main: broker-login-state {loggedIn: true}
  │
  ├─ Main extracts access_token from localStorage
  │   └─ (via executeJavaScript)
  │
  ├─ Token sent to RIGHT PANE via IPC
  │   └─ 'token-ready' event
  │
  └─ RIGHT PANE: Enable START button
```

### **Phase 3: Market Data Streaming**

```
User clicks START
  │
  ├─ Main → tokenEngine.connectSignalR(token)
  │
  ├─ WebSocket init:
  │   ├─ wss://chartapi.topstepx.com/hubs/chart?access_token=...
  │   ├─ Send handshake
  │   └─ Subscribe to SubscribeTradeLogWithSpeed + SubscribeQuotesForSymbolWithSpeed
  │
  ├─ On trade message (RealTimeTradeLogWithSpeed):
  │   ├─ Parser: extract {Price, Volume, Type, Timestamp}
  │   ├─ Aggregator: add to current candle
  │   └─ Emit event to RIGHT PANE (update chart)
  │
  ├─ On quote message (RealTimeSymbolQuote):
  │   ├─ Parser: extract {BestBid, BestAsk}
  │   ├─ Update DOM (best bid/ask)
  │   └─ Emit event to RIGHT PANE
  │
  └─ On candle close (timeframe elapsed):
      ├─ Finalize candle data (OHLC, volume profile, POC)
      ├─ Save to footprints-cache.json
      └─ Emit event to RIGHT PANE (plot on chart)
```

### **Phase 4: Order Execution**

```
Strategy generates BUY signal
  │
  ├─ Risk Manager validates:
  │   ├─ Daily P&L limit not exceeded
  │   ├─ Position size within limit
  │   └─ Account margin available (from Topstep account snapshot)
  │
  ├─ Executor builds order payload
  │   └─ {symbol, side, price, qty, orderType}
  │
  ├─ Send to NinjaTrader API (or mock execution)
  │   └─ Receive order ID
  │
  ├─ Monitor execution:
  │   ├─ On filled: update positions.json
  │   ├─ Track entry price, contracts
  │   └─ Emit event to RIGHT PANE (position update)
  │
  └─ Trigger risk management:
      ├─ Set phantom stop loss
      ├─ Set phantom take profit
      └─ Watch real-time price vs stops
```

---

## 3. Key Design Decisions

| Aspect | Decision | Rationale |
|--------|----------|-----------|
| **Data Source** | Topstep ProjectX SignalR | Real-time tick-by-tick data for futures |
| **Runtime** | Electron (Node.js) | Local app, no cloud latency, full control |
| **Chart/DOM** | In-process aggregation | Sub-100ms candle updates |
| **Execution** | NinjaTrader API (TBD) | Standard for retail futures trading |
| **Risk Mgmt** | Phantom stops (local) | Topstep doesn't offer server-side advanced orders |
| **State Persistence** | JSON files in `data/` | Simple, debuggable, fast recovery |

---

## 4. Contract Specifications

### **Supported Contracts** (Configurable)

```javascript
// data/master-futures.json
{
  "ENQ": {                      // E-mini NASDAQ
    "symbol": "F.US.ENQ",
    "tickSize": 0.25,           // Price increment
    "tickValue": 5.00,          // Dollar value per tick
    "contractMultiplier": 20,
    "minTradingQty": 1,         // Min 1 contract
    "margin": 17000,            // Initial margin per contract
    "tradingHours": "23:00-22:00 UTC (Sun-Fri)"
  },
  "ES": {
    "symbol": "F.US.ES",
    "tickSize": 0.25,
    "tickValue": 12.50,
    "contractMultiplier": 50,
    "margin": 12500
  },
  "GC": {
    "symbol": "F.US.GC",
    "tickSize": 0.10,
    "tickValue": 10.00,
    "contractMultiplier": 100,
    "margin": 8000
  }
}
```

---

## 5. Topstep Compliance Rules

### **Account Limits** (Step 1 Challenge)

| Rule | Threshold | Action |
|------|-----------|--------|
| **Daily Loss Limit** | -$1,000 | Stop trading for the day |
| **Trailing Drawdown** | -$2,000 | Full account lockout |
| **Profit Target** | +$3,000 | Pass to next step |
| **Min Trading Days** | 5 days | Consistency check |
| **Max Position** | 5 contracts | Per symbol limit |
| **Consistency** | No day > 30% of monthly profit | Avoid reckless wins |

---

## 6. Module Structure

```
electron/AlgoFuture/
├── core/
│   ├── adapters/
│   │   ├── topstep_signalr.js      ← WebSocket connection
│   │   ├── topstep_auth.js         ← Login detection + token extraction
│   │   └── topstep_parser.js       ← Parse trade/quote messages
│   │
│   ├── engine/
│   │   ├── executor.js             ← Order submission (NinjaTrader stub)
│   │   ├── aggregator.js           ← Footprint candle building
│   │   └── footprint.js            ← POC, value area, profile
│   │
│   ├── channel/
│   │   ├── livetrade.js            ← Broadcast trade events
│   │   ├── features.js             ← Optional macro data
│   │   └── stream.js               ← Generic event emitter
│   │
│   ├── risk/
│   │   ├── compliance.js           ← Topstep rules enforcement
│   │   ├── position_manager.js     ← Track holdings + P&L
│   │   └── phantom_stops.js        ← Auto cut loss logic
│   │
│   ├── strategies/
│   │   ├── scalper.js              ← 5-tick scalping
│   │   ├── breakout.js             ← Level breakout
│   │   └── manager.js              ← Strategy selector
│   │
│   ├── features/
│   │   ├── z_score.js              ← Statistical anomalies
│   │   ├── velocity.js             ← Trades per second
│   │   └── confluence.js           ← Multi-factor weighting
│   │
│   └── updater/
│       └── master-futures.js       ← Contract specs (auto-generated)
│
├── data/
│   ├── master-futures.json         ← Contract specifications
│   ├── footprints-cache.json       ← In-memory candles (current session)
│   ├── positions.json              ← Current holdings {symbol, qty, entryPrice}
│   ├── pnl-history.json            ← Daily P&L snapshots
│   └── compliance-log.json         ← Topstep rule violations
│
├── cron/
│   └── scheduler.js                ← Auto flatten, daily reset
│
├── index.html                      ← Dashboard UI
├── main.js                         ← Electron main process
├── preload.js                      ← Login detection (IPC bridge)
├── package.json
└── _DOC/
    ├── 0001_architecture_futures.md
    ├── 0002_signalr_websocket.md
    ├── 0003_topstep_compliance.md
    ├── 0004_execution_engine.md
    ├── 0005_footprint_aggregation.md
    └── 0006_strategies_framework.md
```

---

## 7. MVP Milestones

### **Week 1: Data Ingestion**
- [ ] SignalR WebSocket connection
- [ ] Trade/Quote parsing
- [ ] Real-time tick streaming to dashboard

### **Week 2: Footprint Aggregation**
- [ ] Multi-timeframe candle building (1m, 5m, 15m)
- [ ] Volume profile calculation
- [ ] POC + value area

### **Week 3: Risk Management**
- [ ] Topstep compliance rules engine
- [ ] Position tracking
- [ ] Phantom stop/TP logic

### **Week 4: Execution & Strategies**
- [ ] NinjaTrader API integration (stub)
- [ ] Simple scalping strategy
- [ ] End-to-end paper trading test

---

## 8. Security & Credentials

### **Token Management**
- ✅ Access token extracted from Topstep localStorage (client-side)
- ✅ Token masked in logs for safety
- ❌ Never stored to disk (volatile memory only)
- ❌ Never transmitted to external servers

### **IPC Security**
- ✅ Preload sanitizes all messages
- ✅ No sensitive data in IPC payloads
- ✅ Browser context isolation enabled by default

---

> **See also:**  
> - [0002 SignalR WebSocket Protocol](./0002_signalr_websocket.md)  
> - [0003 Topstep Compliance Rules](./0003_topstep_compliance.md)  
> - [0005 Footprint Aggregation](./0005_footprint_aggregation.md)
