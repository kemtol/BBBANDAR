# PRD & TSD — Strategies Framework (Scalper, Breakout)

## PRD

### Objective
Provide a pluggable strategy framework where strategies produce standardized signals for execution and can be tested in replay (paper) mode.

### Success Metrics
- Strategies are deterministic under replay
- Strategy API is simple and safe (stateless or explicit state)

### Stakeholders
- Strategy developers, Execution Engine, Backtester

---

## TSD

### Design Principles
- Strategy modules are pure functions or classes with well-defined inputs/outputs
- Deterministic: given same input sequence and seed, outputs equal
- Lightweight: per-tick evaluation should be fast (<1ms typical)

### Interface
- Strategy module exports:
  - `init(config)` → optional
  - `onTick(state, tick)` → returns array of signals `[{ action: 'BUY'|'SELL', qty, price, meta }]`
  - `onCandle(candle)` → optional

### Strategy Manager
- `register(name, module)`
- `evaluate(name, context)` routes incoming ticks to chosen strategy
- Parameter management via JSON config per strategy

### Example Strategies
- Scalper (5-tick): short holding time, small qty, phantom stops
- Breakout: entry on breakout above recent range with volume confirmation

### Tests
- Unit tests using curated tick sequences
- Replay integration to validate expected entries/exits

### Effort Estimate
2–4 dev days per strategy (including tests)
