# PRD & TSD — Topstep SignalR Adapter

## PRD

### Objective
Reliable, low-latency ingestion of trade and quote frames from Topstep ProjectX SignalR feed and normalized event emission for downstream modules.

### Success Metrics
- End-to-end frame → normalized event latency < 50 ms (median)
- Parser error rate < 0.1%
- Uptime ≥ 99.9% in normal network conditions

### Stakeholders
- Footprint Aggregator, Strategies, Execution Engine, Dashboard UI

### Constraints
- SignalR framing uses Record Separator `\u001e`
- Auth via `access_token` query param
- Must handle bursts and reconnects robustly

---

## TSD

### Overview
`TopstepSignalR` is an EventEmitter that manages the SignalR connection lifecycle, subscription, parsing, and normalized event emission.

### Interfaces
- `connect(token: string): Promise<void>`
- `disconnect(): void`
- `subscribe(symbol: string): Promise<void>`
- `on('trade', (trade) => {})` — normalized trade
- `on('quote', (quote) => {})` — normalized quote
- `getStats(): {connected, tradesProcessed, parseErrors, uptime}`

### Data Models
- Normalized Trade:
  - `{ symbol, price, volume, side: 'BUY'|'SELL', timestamp (ms), tickIdx }`
- Normalized Quote:
  - `{ symbol, bid, ask, timestamp (ms) }`

Tick conversion helpers:
- `priceToTick(price, tickSize)` and `tickToPrice(tickIdx, tickSize)` — use integer tick index for aggregation.

### Error Handling & Resilience
- Handshake ACK check (frame `{}`) before subscriptions
- Ping (type 6) ignored
- Liveness watchdog: if no message in 20s, reset connection
- Exponential backoff on reconnect (2s → 1.5x → cap 60s)
- Raw buffer spike guard: if rawBuffer > 500 push flush or drop oldest

### Tests
- Unit: parse sample frames (trade/quote), tick conversion
- Integration: mock WS server to verify subscribe/parse/emit
- Load test: replay `raw_tns` files to measure latency and memory

### Effort Estimate
2–3 dev days (implementation + tests)
