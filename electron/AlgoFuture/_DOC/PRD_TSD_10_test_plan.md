# PRD & TSD — Test Plan (Unit / Integration / Replay)

## PRD

### Objective
Establish repeatable automated tests and a replay harness to validate parsers, aggregator, compliance, and executor logic.

### Success Metrics
- Unit tests cover core modules (parser, aggregator, compliance, executor) with >70% coverage initially
- Replay harness reproduces known outputs from `raw_tns` fixtures

---

## TSD

### Test Types
1. Unit Tests (Jest/Mocha)
   - Parser: trade/quote frame parsing
   - Tick conversion: price ↔ tick
   - POC/VA/VWAP calculators
   - Compliance rule edge cases
2. Integration Tests
   - TopstepSignalR (mock server) → Aggregator → Candle output
   - Strategy + Execution Engine using MockBrokerAdapter
3. Replay Tests
   - Replay raw frames from `QQQUANTA/workers/.../raw_tns` and compare candle JSON outputs

### Replay Runner
- CLI: `node tools/replay --input data/replay/ENQ/2025-12-24.json --speed 1` (1 = realtime, 10 = 10x)
- Replay feeds raw frames into `TopstepSignalR` emulated API

### Fixtures & CI
- Store small sample fixtures in repo `test/fixtures` (no heavy raw data)
- CI runs unit tests and a single short replay smoke test

### Metrics & Monitoring
- Parse error counts
- Candle finalization latency
- Order lifecycle events in mock integration

### Effort Estimate
3–5 dev days to reach stable baseline tests

---

## Example Commands
```bash
# Run unit tests
npm test

# Run replay (dev)
node tools/replay --input test/fixtures/enq_short.json --speed 5
```
