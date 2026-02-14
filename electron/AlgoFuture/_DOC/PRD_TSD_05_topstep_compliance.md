# PRD & TSD — Topstep Compliance Engine

## PRD

### Objective
Implement Topstep Step-1 rules enforcement (daily loss limit, trailing drawdown, max contracts, profit target, min trading days) and expose status to UI and executor.

### Success Metrics
- Correct blocking of orders when rules breached in replay tests
- Accurate daily P&L tracking and persistence

### Stakeholders
- Execution Engine, Dashboard, Strategies

---

## TSD

### Overview
`ComplianceEngine` maintains account-level state and evaluates rules on fills and balance updates.

### Interfaces
- `recordFill({symbol, qty, fillPrice, pnlDelta})`
- `canSubmitOrder({symbol, qty, side})` → `{ allowed: boolean, reason?: string }`
- `getStatus()` → status object
- `on('violation', details)`

### State & Persistence
- `startBalance`, `currentBalance`, `peakBalance`
- `dailyPnLHistory` keyed by date; persisted to `data/compliance-log.json`
- `violations[]`

### Rules
- Daily loss limit: `$1000` (hard), pause at 70% (`$700` soft)
- Trailing drawdown: `$2000` lock
- Max contracts per symbol: `5`
- Profit target: `$3000` to pass

### Integration
- Called by executor before submission (`canSubmitOrder`) and updated on fills via `recordFill`
- Expose IPC to Dashboard: `compliance-status` updates

### Tests
- Inject synthetic fills to simulate soft/hard stop triggers and assert expected `accountStatus`

### Effort Estimate
2 dev days
