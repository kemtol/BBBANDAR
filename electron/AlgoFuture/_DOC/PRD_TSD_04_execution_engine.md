# PRD & TSD — Execution Engine (Executor + Mock Broker)

## PRD

### Objective
Translate strategy signals into orders, manage order lifecycle, and provide a mock broker for paper testing and future NinjaTrader integration.

### Success Metrics
- Order lifecycle events emitted reliably (submitted → accepted → filled)
- Mock fills configurable with latency and slippage
- Compliance pre-checks executed before submission

### Stakeholders
- Strategies, Compliance Engine, Dashboard

---

## TSD

### Overview
`ExecutionEngine` is an EventEmitter that exposes `placeBuy`, `placeSell`, `flattenAll` and relies on a `BrokerAdapter` (Mock or real) to submit orders.

### Interfaces
- `placeBuy({symbol, qty, price, type, stopPrice, takeProfit})` → Promise
- `placeSell(...)`
- `flattenAll()`
- Events: `order-submitted`, `order-accepted`, `order-filled`, `order-rejected`

### BrokerAdapter Interface
- `submitOrder(order)` → resolves `{ orderId }` or rejects
- `on('fill', callback)` for async fills

### Order State
- Local `orderId` maps to `brokerOrderId`
- States: `PENDING`, `ACCEPTED`, `FILLED`, `REJECTED`, `FAILED`

### Phantom Stops
- Managed locally by `PhantomRiskManager` listening to trade stream; triggers `executor.placeSell` when hit

### Error Handling
- Retries for transient errors with limited backoff
- Idempotency: local `submitid` per order to avoid duplicates

### Tests
- Unit: order building + state transitions
- Integration: MockBrokerAdapter simulates fills and rejects; verify compliance blocking

### Effort Estimate
3–4 dev days
