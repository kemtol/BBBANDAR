# 0002 — SignalR WebSocket Protocol (Topstep ProjectX)

> **Layer:** Adapter  
> **Module:** [`core/adapters/topstep_signalr.js`](../core/adapters/topstep_signalr.js)  
> **Depends on:** Access token from login (see [0001](./0001_architecture_futures.md))

---

## 1. Protocol Overview

| Aspect | Detail |
|--------|--------|
| **Transport** | WebSocket (wss) |
| **Protocol** | SignalR JSON (not gRPC) |
| **Endpoint** | `wss://chartapi.topstepx.com/hubs/chart` |
| **Authentication** | URL parameter: `access_token=<token>` |
| **Frame Delimiter** | `\u001e` (ASCII 30, Record Separator) |

---

## 2. Connection Flow

### **Step 1: Initialize**

```javascript
const token = getAccessToken();  // From localStorage
const wsUrl = `wss://chartapi.topstepx.com/hubs/chart?access_token=${token}`;
const ws = new WebSocket(wsUrl);
```

### **Step 2: Handshake**

When connection opens, send SignalR handshake:

```javascript
ws.send(JSON.stringify({ protocol: "json", version: 1 }) + "\u001e");
```

Server responds with empty object `{}` (framed with `\u001e`).

### **Step 3: Subscribe to Market Data**

#### **Subscribe to Trades**

```javascript
const msg = {
  type: 1,                           // type: 1 = invoke
  target: "SubscribeTradeLogWithSpeed",
  arguments: ["F.US.ENQ", 0],       // [symbol, param]
  invocationId: "1"                 // Must be unique per request
};

ws.send(JSON.stringify(msg) + "\u001e");
```

#### **Subscribe to Quotes (Bid/Ask)**

```javascript
const msg = {
  type: 1,
  target: "SubscribeQuotesForSymbolWithSpeed",
  arguments: ["F.US.ENQ", 0],
  invocationId: "2"
};

ws.send(JSON.stringify(msg) + "\u001e");
```

Server sends back subscription confirmation:

```javascript
{
  type: 3,                                      // type: 3 = completion
  invocationId: "1",
  result: null
}
```

---

## 3. Inbound Messages

### **Message Structure**

All messages are delimited by `\u001e`. Multiple messages can arrive in one frame:

```javascript
const frames = data.split('\u001e').filter(Boolean);  // Filter empty frames

for (const frame of frames) {
  if (frame === '{}') continue;                        // Handshake ACK
  const msg = JSON.parse(frame);
  // Process msg
}
```

### **Message Type 6 (Server Ping)**

```javascript
{
  type: 6  // Type 6 = ping (can be ignored)
}
```

### **Message Type 3 (Completion/Response)**

After subscription, server sends confirmation:

```javascript
{
  type: 3,
  invocationId: "1",                    // Matches request ID
  result: null                          // Subscription ack
}
```

### **Message Type 1 (Invocation - Real Data)**

#### **Trade Data: `RealTimeTradeLogWithSpeed`**

```javascript
{
  type: 1,
  target: "RealTimeTradeLogWithSpeed",  // Handler name on client
  arguments: [
    null,                                // arg[0] (unused)
    [                                    // arg[1] = array of trades
      {
        Price: 4850.25,                  // Tick price
        Volume: 5,                       // Trade volume (contracts)
        Type: 0,                         // 0=buy, 1=sell (vendor flag)
        Timestamp: "2025-02-10T14:30:25.123Z"
      },
      {
        Price: 4850.50,
        Volume: 3,
        Type: 1,
        Timestamp: "2025-02-10T14:30:26.456Z"
      }
    ]
  ]
}
```

#### **Quote Data: `RealTimeSymbolQuote`**

```javascript
{
  type: 1,
  target: "RealTimeSymbolQuote",        // Handler name
  arguments: [
    {
      symbol: "F.US.ENQ",                // Contract symbol
      BestBid: 4850.00,                 // Best bid price
      BestAsk: 4850.25,                 // Best ask price
      LastPrice: 4850.25,
      Volume: 250000,                   // Total session volume
      // ... other fields (not used)
    }
  ]
}
```

---

## 4. Parsing & Aggressor Detection

### **Aggressor Inference**

Trade aggressor (buyer or seller) determined by:

1. **Quote Context** (highest confidence):
   - If `price >= bestAsk` → **BUY** (hit ask)
   - If `price <= bestBid` → **SELL** (hit bid)

2. **Vendor Type Flag** (fallback):
   - If `type === 0` → **BUY**
   - If `type === 1` → **SELL**

### **Parsed Trade Object** (Normalized)

```javascript
{
  price: 4850.25,            // Tick price
  volume: 5,                 // Contracts
  side: "BUY",               // 'BUY' or 'SELL'
  aggressor: true,           // true=BUY, false=SELL
  timestamp: 1707567025123,  // UTC epoch (ms)
  source: "quote_context",   // Detection method
  symbol: "F.US.ENQ"
}
```

---

## 5. Tick-to-Price Conversion

### **Problem: Floating-Point Precision**

Futures prices are quoted in ticks, not raw decimals. ENQ ticks are `0.25`.

```
Price    Tick Index
4850.00  → 19400
4850.25  → 19401
4850.50  → 19402
4850.75  → 19403
4851.00  → 19404
```

### **Solution: Integer Tick Index**

```javascript
const TICK_SIZE = 0.25;

function priceToTick(price) {
  return Math.round((price / TICK_SIZE) + 1e-9);  // 1e-9 for float hardening
}

function tickToPrice(tickIndex) {
  const price = tickIndex * TICK_SIZE;
  // Round to TICK_DECIMALS (2 for ENQ)
  return parseFloat(price.toFixed(2));
}
```

### **Why Integer Ticks?**

- ✅ No floating-point errors during aggregation
- ✅ Fast comparison: `tickIndex >= bestAskTick`
- ✅ Accurate volume profile per level
- ✅ Candle OHLC precise to the tick

---

## 6. Reconnection & Liveness

### **Auto-Reconnect Strategy**

```javascript
const MAX_RECONNECTS = 10;
const BASE_DELAY = 2000;      // 2 seconds
let reconnectDelayMs = BASE_DELAY;

function onDisconnect() {
  if (reconnectCount >= MAX_RECONNECTS) {
    console.error("Max reconnects reached. Giving up.");
    return;
  }

  console.log(`[SignalR] Reconnecting in ${reconnectDelayMs}ms...`);
  setTimeout(() => {
    connectSignalR();
    reconnectDelayMs = Math.min(reconnectDelayMs * 1.5, 60000);  // Exponential backoff
  }, reconnectDelayMs);
}
```

### **Liveness Watchdog**

If no message received for > 20 seconds, assume stale connection:

```javascript
const LIVENESS_TIMEOUT_MS = 20000;
let lastMsgAt = Date.now();

setInterval(() => {
  if (Date.now() - lastMsgAt > LIVENESS_TIMEOUT_MS) {
    console.warn("[SignalR] Stale connection. Resetting...");
    ws.close();
    connectSignalR();
  }
}, 5000);
```

---

## 7. State Machine

```
┌─────────────┐
│ DISCONNECTED│ ◄─── Start or after disconnect
└──────┬──────┘
       │ connectSignalR()
       ▼
┌─────────────┐
│ CONNECTING  │
└──────┬──────┘
       │ ws.onopen
       ▼
┌─────────────┐
│HANDSHAKE_   │
│SENT         │
└──────┬──────┘
       │ receive {}
       ▼
┌─────────────┐
│ SUBSCRIBE_  │
│ SENT        │
└──────┬──────┘
       │ type:3 confirmation
       ▼
┌─────────────┐
│ SUBSCRIBED  │ ◄─── Ready for trade data
└──────┬──────┘
       │
       ├─ type:1 (trade/quote) ──► process message
       ├─ type:6 (ping) ─────────► ignore
       └─ ws.onclose ────────────► DISCONNECTED
```

---

## 8. Example: Full Message Cycle

```javascript
// Raw WebSocket data frame (with \u001e delimiters)
`{"type":1,"target":"RealTimeTradeLogWithSpeed","arguments":[null,[{"Price":4850.25,"Volume":5,"Type":0,"Timestamp":"2025-02-10T14:30:25.123Z"}]]}` + '\u001e'

// Split by delimiter
frames = [
  `{"type":1,"target":"RealTimeTradeLogWithSpeed",...}`
]

// Parse
msg = JSON.parse(frames[0])
trades = msg.arguments[1]  // Array of {Price, Volume, Type, Timestamp}

// Normalize each trade
for (const trade of trades) {
  const normalized = {
    price: trade.Price,
    volume: trade.Volume,
    side: determineSide(trade.Price, trade.Type, bestBid, bestAsk),
    timestamp: new Date(trade.Timestamp).getTime()
  }

  // Emit to aggregator
  aggregator.processTrade(normalized);
}
```

---

## 9. Implementation Checklist

### **Module: `core/adapters/topstep_signalr.js`**

- [ ] `class TopstepSignalR extends EventEmitter`
- [ ] `connectSignalR(token)` — establish WebSocket
- [ ] `sendHandshake()` — protocol negotiation
- [ ] `subscribeToMarketData(symbol)` — subscribe trades + quotes
- [ ] `handleMessage(frame)` — parse inbound message
- [ ] `processTrade(data)` — normalize and emit
- [ ] `onDisconnect()` — auto-reconnect logic
- [ ] `getStats()` — return {connected, tradesProcessed, uptime, ...}

### **Events to Emit**

```javascript
// When trade arrives
emitter.emit('trade', {
  price: 4850.25,
  volume: 5,
  side: 'BUY',
  timestamp: 1707567025123
});

// When quote updates
emitter.emit('quote', {
  bid: 4850.00,
  ask: 4850.25,
  symbol: 'F.US.ENQ'
});

// When connection state changes
emitter.emit('state-change', { state: 'SUBSCRIBED', symbol: 'F.US.ENQ' });
```

---

## 10. Testing

### **Unit Tests**
```javascript
describe('TopstepSignalR', () => {
  it('should parse trade message correctly', () => {
    const frame = JSON.stringify({
      type: 1,
      target: "RealTimeTradeLogWithSpeed",
      arguments: [null, [{ Price: 4850.25, Volume: 5, Type: 0, Timestamp: "2025-02-10T14:30:25.123Z" }]]
    });

    const result = parseTrade(frame);
    assert.equal(result.price, 4850.25);
    assert.equal(result.side, 'BUY');
  });

  it('should convert price to tick index correctly', () => {
    assert.equal(priceToTick(4850.25, 0.25), 19401);
    assert.equal(priceToTick(4850.00, 0.25), 19400);
  });

  it('should reconnect after disconnect', (done) => {
    // Mock ws.onclose
    signalR.onDisconnect();
    setTimeout(() => {
      assert(signalR.state === 'CONNECTING');
      done();
    }, 2500);
  });
});
```

---

> **See also:**  
> - [0001 Architecture](./0001_architecture_futures.md)  
> - [0005 Footprint Aggregation](./0005_footprint_aggregation.md)
