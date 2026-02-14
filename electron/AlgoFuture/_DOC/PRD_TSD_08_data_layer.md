# PRD & TSD — Data Layer & Persistence

## PRD

### Objective
Store footprints, positions, daily P&L history, and compliance logs locally with an abstraction that allows switching to R2/cloud storage later. Provide replayable exports for backtests.

### Success Metrics
- Reliable persistence with basic corruption protection
- Replay feature reproduces aggregator outputs

### Stakeholders
- Aggregator, Compliance, Backtester, Ops

---

## TSD

### Storage Backends
- `FileSystemStore` (default) — writes to `data/` JSON files
- `R2Store` (optional) — Cloudflare R2 adapter interface

### API
- `put(key, obj)`
- `get(key)`
- `list(prefix)`
- `delete(key)`

### File Layout (suggested)
```
data/
  master-futures.json
  footprints-cache.json
  positions.json
  pnl-history.json
  compliance-log.json
  replay/ (raw frames for replay)
```

### Durability
- Write atomic: write tmp file then rename
- Rotations: daily rotation for large logs

### Replay
- `replay/` holds raw frames (one-per-line) and a `replay-runner` feeds them into a mock `TopstepSignalR` at real-time or accelerated speed

### Tests
- Roundtrip save/load
- Replay reproduces aggregator candles

### Effort Estimate
1–2 dev days
